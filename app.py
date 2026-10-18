"""
TubeWave — YouTube → MP3 / WAV audio converter.

Run locally:
    pip install -r requirements.txt
    python app.py            # then open http://localhost:8000

Deploy: see README.md (Dockerfile included).
Requires ffmpeg (auto-detected from PATH, ./bin/ffmpeg, FFMPEG_PATH,
or the imageio-ffmpeg fallback bundled in requirements.txt).
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from pathlib import Path
from typing import Any
from urllib.request import Request, urlopen

import yt_dlp
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

APP_DIR = Path(__file__).resolve().parent
STATIC_DIR = APP_DIR / "static"
JOBS_ROOT = Path(os.environ.get("WAVEGRAB_JOBS") or (Path.home() / ".wavegrab" / "jobs"))

JOB_TTL = 2 * 60 * 60  # keep converted files for 2 hours
INFO_TTL = 30 * 60     # cache video info for 30 minutes
THUMB_TTL = 3600
MAX_TITLE = 120

app = FastAPI(title="TubeWave", docs_url=None, redoc_url=None)

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _verify_ffmpeg(path: Path) -> bool:
    """A binary must exist AND actually run (snapshots can strip the +x bit)."""
    try:
        if not path.is_file():
            return False
        if not os.access(path, os.X_OK):
            path.chmod(path.stat().st_mode | 0o111)  # self-heal
        r = subprocess.run([str(path), "-version"], capture_output=True, timeout=15)
        return r.returncode == 0
    except Exception:
        return False


def find_ffmpeg() -> str | None:
    candidates: list[Path] = []
    for cand in (os.environ.get("FFMPEG_PATH"), os.environ.get("FFMPEG")):
        if cand:
            p = Path(cand)
            # accept either the binary itself or a directory containing it
            candidates.append(p if p.is_file() else p / "ffmpeg")
    candidates.append(APP_DIR / "bin" / "ffmpeg")
    which = shutil.which("ffmpeg")
    if which:
        candidates.append(Path(which))
    for p in candidates:
        if _verify_ffmpeg(p):
            return str(p)
    try:
        import imageio_ffmpeg  # optional fallback

        p = Path(imageio_ffmpeg.get_ffmpeg_exe())
        if _verify_ffmpeg(p):
            return str(p)
    except Exception:
        pass
    return None


FFMPEG = find_ffmpeg()

YT_URL_RE = re.compile(
    r"^https?://(?:www\.|m\.|music\.)?(?:"
    r"youtube\.com/(?:watch\?(?:.*&)?v=|shorts/|live/|embed/|v/)|youtu\.be/"
    r")([\w-]{11})",
    re.IGNORECASE,
)
VIDEO_ID_RE = re.compile(r"^[\w-]{11}$")

JOBS: dict[str, dict[str, Any]] = {}
JOBS_LOCK = threading.Lock()
THUMB_CACHE: dict[str, tuple[bytes, float]] = {}
INFO_CACHE: dict[str, tuple[dict[str, Any], float]] = {}


def sanitize_filename(name: str, max_len: int = MAX_TITLE) -> str:
    name = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "", name or "")
    name = re.sub(r"\s+", " ", name).strip(" .")
    return (name[:max_len].strip() or "audio")


def match_youtube_url(url: str) -> str | None:
    m = YT_URL_RE.match((url or "").strip())
    return m.group(1) if m else None


def human_size(n: int | float | None) -> str:
    if not n:
        return ""
    n = float(n)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} GB"


def human_speed(bps: float | None) -> str:
    return (human_size(bps) + "/s") if bps else ""


def human_eta(sec: int | None) -> str:
    if sec is None:
        return ""
    sec = int(sec)
    m, s = divmod(sec, 60)
    h, m = divmod(m, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def human_duration(sec: int | None) -> str:
    return human_eta(sec) if sec is not None else ""


def cleanup_old_jobs() -> None:
    now = time.time()
    with JOBS_LOCK:
        stale = [jid for jid, j in JOBS.items() if now - j["created"] > JOB_TTL]
        for jid in stale:
            JOBS.pop(jid, None)
    if not JOBS_ROOT.exists():
        return
    for d in JOBS_ROOT.iterdir():
        try:
            if d.is_dir() and now - d.stat().st_mtime > JOB_TTL:
                shutil.rmtree(d, ignore_errors=True)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# request models
# ---------------------------------------------------------------------------

class InfoReq(BaseModel):
    url: str


class ConvertReq(BaseModel):
    url: str
    format: str = Field(default="mp3", pattern="^(mp3|wav)$")
    bitrate: int = 192
    save_path: str | None = None


# ---------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------

@app.get("/api/health")
def health() -> dict[str, Any]:
    ok = bool(FFMPEG) and _verify_ffmpeg(Path(FFMPEG))
    return {"ok": True, "ffmpeg": ok, "ffmpeg_path": FFMPEG}


@app.post("/api/info")
def api_info(req: InfoReq) -> dict[str, Any]:
    vid = match_youtube_url(req.url)
    if not vid:
        raise HTTPException(400, "That doesn't look like a YouTube video link.")

    # serve from cache first (makes repeat pastes / edits instant)
    cached = INFO_CACHE.get(vid)
    if cached and time.time() - cached[1] < INFO_TTL:
        return cached[0]

    ydl_opts = {
        "quiet": True,
        "no_warnings": True,
        "noplaylist": True,
        "skip_download": True,
        "socket_timeout": 15,
        "extractor_args": {"youtube": {"skip": ["dash", "hls"]}},
    }
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
    except yt_dlp.utils.DownloadError as e:
        msg = re.sub(r"^ERROR:\s*", "", str(e)).strip()
        raise HTTPException(400, msg or "Couldn't fetch video info.")
    except Exception:
        raise HTTPException(502, "Couldn't reach YouTube. Try again.")

    if info.get("is_live"):
        raise HTTPException(400, "Live streams aren't supported — wait until the stream ends.")

    data = {
        "video_id": info.get("id") or vid,
        "title": info.get("title") or "Untitled",
        "channel": info.get("channel") or info.get("uploader") or "",
        "duration": info.get("duration"),
        "duration_string": human_duration(info.get("duration")),
        "views": info.get("view_count"),
        "upload_date": info.get("upload_date"),
        "thumbnail": f"/api/thumbnail/{vid}",
    }
    INFO_CACHE[vid] = (data, time.time())
    return data


@app.post("/api/convert")
def api_convert(req: ConvertReq) -> dict[str, Any]:
    if not FFMPEG:
        raise HTTPException(500, "ffmpeg was not found on the server. Install ffmpeg and restart.")
    vid = match_youtube_url(req.url)
    if not vid:
        raise HTTPException(400, "That doesn't look like a YouTube video link.")
    if req.bitrate not in (128, 192, 256, 320):
        raise HTTPException(400, "Unsupported bitrate.")

    cleanup_old_jobs()

    job_id = uuid.uuid4().hex[:12]
    job_dir = JOBS_ROOT / job_id
    job_dir.mkdir(parents=True, exist_ok=True)

    job: dict[str, Any] = {
        "id": job_id,
        "video_id": vid,
        "url": f"https://www.youtube.com/watch?v={vid}",
        "format": req.format,
        "bitrate": req.bitrate,
        "status": "queued",
        "stage": "Queued",
        "percent": 0,
        "speed": "",
        "eta": "",
        "title": "",
        "filename": f"audio.{req.format}",
        "size": 0,
        "saved_to": "",
        "error": "",
        "created": time.time(),
        "dir": str(job_dir),
    }
    with JOBS_LOCK:
        JOBS[job_id] = job

    t = threading.Thread(target=_run_job, args=(job, req.save_path), daemon=True)
    t.start()
    return {"job_id": job_id}


@app.get("/api/progress/{job_id}")
def api_progress(job_id: str) -> dict[str, Any]:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "Unknown job.")
        return {
            "id": job["id"],
            "status": job["status"],
            "stage": job["stage"],
            "percent": job["percent"],
            "speed": job["speed"],
            "eta": job["eta"],
            "title": job["title"],
            "filename": job["filename"],
            "size": job["size"],
            "saved_to": job["saved_to"],
            "error": job["error"],
            "format": job["format"],
        }


@app.get("/api/file/{job_id}")
def api_file(job_id: str, inline: bool = Query(default=False)) -> FileResponse:
    with JOBS_LOCK:
        job = JOBS.get(job_id)
        if not job:
            raise HTTPException(404, "Unknown job.")
        if job["status"] != "done":
            raise HTTPException(409, "File isn't ready yet.")
        path = Path(job["dir"]) / job["filename"]
        if not path.exists():
            raise HTTPException(410, "File expired.")
        name = job["filename"]
        ctype = "audio/mpeg" if job["format"] == "mp3" else "audio/wav"
    # ?inline=1 → playable/streamable in <audio>/<video> (attachment for downloads)
    return FileResponse(
        path,
        media_type=ctype,
        filename=name,
        content_disposition_type="inline" if inline else "attachment",
        headers={"Accept-Ranges": "bytes", "Cache-Control": "private, max-age=3600"},
    )


@app.get("/api/thumbnail/{video_id}")
def api_thumbnail(video_id: str) -> Response:
    if not VIDEO_ID_RE.match(video_id):
        raise HTTPException(400, "Bad video id.")
    now = time.time()
    cached = THUMB_CACHE.get(video_id)
    if cached and now - cached[1] < THUMB_TTL:
        return Response(cached[0], media_type="image/jpeg")

    url = f"https://i.ytimg.com/vi/{video_id}/hqdefault.jpg"
    try:
        req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
        with urlopen(req, timeout=15) as r:
            data = r.read()
    except Exception:
        raise HTTPException(502, "Thumbnail unavailable.")

    THUMB_CACHE[video_id] = (data, now)
    return Response(
        data,
        media_type="image/jpeg",
        headers={"Cache-Control": "public, max-age=3600"},
    )


# ---------------------------------------------------------------------------
# background job
# ---------------------------------------------------------------------------

def _convert_with_ffmpeg(src: Path, dst: Path, fmt: str, bitrate: int, title: str, artist: str) -> None:
    """Convert with a plain ffmpeg call — no ffprobe needed."""
    cmd = [FFMPEG, "-y", "-i", str(src), "-vn", "-sn", "-map_metadata", "-1"]
    if fmt == "mp3":
        cmd += ["-codec:a", "libmp3lame", "-b:a", f"{bitrate}k", "-ar", "44100", "-ac", "2"]
    else:  # wav
        cmd += ["-codec:a", "pcm_s16le", "-ar", "44100", "-ac", "2"]
    if title:
        cmd += ["-metadata", f"title={title}"]
    if artist:
        cmd += ["-metadata", f"artist={artist}"]
    cmd.append(str(dst))
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=900)
    if r.returncode != 0 or not dst.exists():
        tail = (r.stderr or "").strip().splitlines()[-1] if (r.stderr or "").strip() else "no output"
        raise RuntimeError(f"ffmpeg conversion failed: {tail}")


def _run_job(job: dict[str, Any], save_path: str | None) -> None:
    job_dir = Path(job["dir"])
    out_ext = job["format"]

    def hook(d: dict[str, Any]) -> None:
        if d.get("status") == "downloading":
            job["status"] = "downloading"
            job["stage"] = "Downloading audio"
            total = d.get("total_bytes") or d.get("total_bytes_estimate")
            done = d.get("downloaded_bytes") or 0
            if total:
                job["percent"] = max(1, min(99, int(done * 100 / total)))
            job["speed"] = human_speed(d.get("speed"))
            job["eta"] = human_eta(d.get("eta"))
        elif d.get("status") == "finished":
            job["status"] = "converting"
            job["stage"] = f"Converting to {out_ext.upper()}"
            job["percent"] = 99
            job["speed"] = ""
            job["eta"] = ""

    opts: dict[str, Any] = {
        "format": "bestaudio/best",
        "noplaylist": True,
        "outtmpl": str(job_dir / "audio_src.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "socket_timeout": 30,
        "retries": 3,
        "concurrent_fragment_downloads": 4,
        "progress_hooks": [hook],
    }

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(job["url"], download=True)
        if info.get("is_live"):
            raise RuntimeError("Live streams aren't supported.")

        # locate the downloaded source audio
        try:
            src = Path(ydl.prepare_filename(info))
        except Exception:
            src = None
        if not src or not src.exists():
            srcs = [p for p in job_dir.iterdir() if p.is_file()]
            if not srcs:
                raise RuntimeError("Download produced no audio file.")
            src = max(srcs, key=lambda p: p.stat().st_size)

        job["status"] = "converting"
        job["stage"] = f"Converting to {out_ext.upper()}"
        job["percent"] = 99

        title = info.get("title") or src.stem
        artist = info.get("artist") or info.get("uploader") or info.get("channel") or ""
        safe = sanitize_filename(title)
        final = job_dir / f"{safe}.{out_ext}"

        _convert_with_ffmpeg(src, final, out_ext, job["bitrate"], title, artist)

        # drop the source to save disk space
        try:
            if src != final:
                src.unlink()
        except OSError:
            pass

        job["title"] = title
        job["filename"] = final.name
        job["size"] = final.stat().st_size

        # optional copy to a folder on the machine running the server
        if save_path:
            try:
                dest_dir = Path(save_path).expanduser()
                dest_dir.mkdir(parents=True, exist_ok=True)
                dest = dest_dir / final.name
                shutil.copy2(final, dest)
                job["saved_to"] = str(dest)
            except Exception as e:  # non-fatal
                job["saved_to"] = ""
                job["error"] = f"Downloaded OK, but couldn't copy to that folder: {e}"

        job["percent"] = 100
        job["status"] = "done"
        job["stage"] = "Ready"
        job["speed"] = ""
        job["eta"] = ""
    except Exception as e:
        msg = re.sub(r"^ERROR:\s*", "", str(e)).strip() or "Conversion failed."
        job["status"] = "error"
        job["stage"] = "Error"
        job["error"] = msg
    finally:
        if job["status"] == "done":
            keep = job["filename"]
            for p in job_dir.iterdir():
                if p.name != keep:
                    try:
                        p.unlink()
                    except OSError:
                        pass


# ---------------------------------------------------------------------------
# static frontend
# ---------------------------------------------------------------------------

@app.get("/")
def index() -> FileResponse:
    return FileResponse(STATIC_DIR / "index.html")


app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


if __name__ == "__main__":
    import uvicorn

    if not FFMPEG:
        print("WARNING: ffmpeg not found — conversions will fail until it is installed.")
    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run(app, host="0.0.0.0", port=port)
