# 🎧 TubeWave — YouTube → MP3 / WAV

Paste a YouTube link, get clean audio — **MP3** (up to 320 kbps) or **WAV** (lossless) — with live progress, an in-browser player, confetti 🎉, and a **select-a-folder** save.

> ⚖️ **Use responsibly.** Only download audio you own or have the right to use. Respect YouTube's Terms of Service and copyright law. **TubeWave is not affiliated with YouTube or Google LLC.**

---

## ✨ Features

- **Real fetch** — `yt-dlp` + `ffmpeg`, no fake demos
- **MP3** 128/192/256/320 kbps · **WAV** lossless PCM · metadata tags embedded
- **Paste → instant preview** (thumbnail, title, channel, duration, views — cached, fast)
- **Select folder to save** — native folder picker (Chrome/Edge), file lands in your folder
- **Direct download** — one click, correct filename, streams from the server (no double transfer)
- **Live progress** — %, speed, ETA + animated equalizer
- **Player** — listen before/while saving (seekable, streams)
- **Session history** — swipe-left to remove, re-download anytime
- **Animations** — button ripples, magnetic CTA, format-slider, confetti, cursor glow, checkmark draw

---

## 🧱 Why there is a backend (and why that's still "just a website")

Browsers **cannot** fetch YouTube audio directly — YouTube doesn't allow cross-origin media access (CORS), and audio streams require signed URLs that expire. So the site needs a small server doing the fetching/convert. **Your visitors just open yourwebsite.com** — that's the whole experience. No installs, no ports in the user's mind.

---

## 🌍 Put it on a REAL website (not localhost:8000)

> `python app.py` binds `0.0.0.0:$PORT` (default **8000** — set `PORT=8080` etc. if you want). That's only for local dev. For a real site, deploy the same app behind a domain with HTTPS.

### Option A — Cheap VPS (recommended, most control) · Hetzner / DigitalOcean / Linode / AWS Lightsail

```bash
# on a fresh Ubuntu VPS ($4–6/mo)
sudo apt update && sudo apt install -y python3-pip python3-venv nginx git ffmpeg
git clone <your-repo> /opt/tubewave && cd /opt/tubewave

python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt

# run it as a service
sudo tee /etc/systemd/system/tubewave.service > /dev/null <<'EOF'
[Unit]
Description=TubeWave
After=network.target
[Service]
WorkingDirectory=/opt/tubewave
ExecStart=/opt/tubewave/.venv/bin/python app.py
Environment=PORT=8000
Restart=always
User=www-data
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now tubewave
```

Nginx reverse-proxy + free HTTPS:

```nginx
# /etc/nginx/sites-available/tubewave
server {
    listen 80;
    server_name yourdomain.com;
    client_max_body_size 50m;
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 600s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/tubewave /etc/nginx/sites-enabled/
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d yourdomain.com      # free HTTPS — required for the folder picker
sudo systemctl reload nginx
```

✅ Live at **https://yourdomain.com** — downloads and “Select folder” work fully.

### Option B — PaaS with Docker (fastest)

The repo includes a **`Dockerfile`** (Python + ffmpeg). Deploy to **Railway**, **Render**, **Fly.io**, or **Google Cloud Run**:

```bash
# example: fly.io
fly launch --no-deploy      # detect Dockerfile
fly deploy

# or locally, to verify the container
docker build -t tubewave .
docker run -p 8080:8000 tubewave
```

> Heads-up: some PaaS ToS discourage YouTube downloading — a small VPS is the safer long-term home.

### Option C — Home PC + free public URL (Cloudflare Tunnel)

```bash
python app.py                      # runs on :8000
cloudflared tunnel --url http://localhost:8000
# → gives you https://random-words.trycloudflare.com instantly
```

Great for sharing with friends; for production use a named tunnel + your domain.

### 🔒 Why HTTPS matters

The **“Select folder…”** picker uses the File System Access API, which browsers allow only in **secure contexts** (`https://` or `localhost`). On your real domain with certbot HTTPS it just works.

---

## 🧪 Quick start (local dev)

```bash
pip install -r requirements.txt
sudo apt install ffmpeg        # or: brew install ffmpeg / drop binary in ./bin/
python app.py                  # → http://localhost:8000  (PORT=8080 python app.py works too)
```

## 🗂 Folder saving — how it behaves

| Where | What happens |
|---|---|
| Chrome/Edge on your https site | **Select folder…** → grant once → all conversions written straight into that folder |
| "Save to folder…" button | Native save dialog (pick any folder + rename), or the picked folder |
| Other browsers | Normal download to the Downloads folder |
| Advanced field `~/Music` | Server also writes a copy to that path (VPS/local use) |

## 🔌 API

```bash
curl -X POST /api/info     -H 'Content-Type: application/json' -d '{"url":"https://youtu.be/jNQXAC9IVRw"}'
curl -X POST /api/convert  -H 'Content-Type: application/json' -d '{"url":"https://youtu.be/jNQXAC9IVRw","format":"wav"}'
# GET /api/progress/{job_id}   → live status
# GET /api/file/{job_id}       → the audio (add ?inline=1 to stream in a player)
# GET /api/thumbnail/{video_id}
```

## 📁 Project layout

```
yt-audio-converter/
├── app.py           # FastAPI backend — fetch, convert, progress, serve
├── Dockerfile       # one-command deploy anywhere
├── requirements.txt
├── README.md
├── bin/             # optional static ffmpeg
└── static/
    ├── index.html   # UI
    ├── style.css    # theme + animations
    └── app.js       # interactivity (folder picker, downloads, confetti, swipe…)
```

## 🩹 Troubleshooting

- **Download button does nothing** → you're probably inside an embedded preview iframe. Click **“Open in new tab”** (top banner), or right-click the button → *“Save link as…”*
- **“ffmpeg was not found”** → `apt install ffmpeg` or set `FFMPEG_PATH=/path/to/ffmpeg`
- **Fetch is slow** → first load of a video's info takes 1–3 s (YouTube handshake); it's cached for 30 min after that. Conversion speed is mostly your server's bandwidth.
- **“Video unavailable”** → private, age-restricted, region-blocked, or removed video
- **WAV is huge** → that's lossless (≈10 MB per minute). Use MP3 192–320 for everyday listening

## ⚙️ Config

| Env var | Default | Meaning |
|---|---|---|
| `PORT` | `8000` | HTTP port (`PORT=8080 python app.py`) |
| `FFMPEG_PATH` | auto | Path to the ffmpeg binary |
| `WAVEGRAB_JOBS` | `~/.wavegrab/jobs` | Where converted files are kept (2 h TTL) |

## Stack

`Python · FastAPI · yt-dlp · ffmpeg · vanilla HTML/CSS/JS` — zero frontend build step, zero trackers, zero CDN assets.
