# TubeWave — Node.js backend (Express + yt-dlp + ffmpeg)

Drop-in replacement for `app.py`. Same `/api` contract, serves `./static` **unchanged**.

```bash
npm install
node server.js            # needs: node >= 20, yt-dlp, ffmpeg (./bin/ffmpeg is auto-detected)
node scripts/selftest.js https://yourdomain.com     # real end-to-end check against YouTube
```

## Direct download endpoint (the new part)

```
GET  /api/download?url=<youtube url>&format=mp3|wav&bitrate=128|192|256|320[&inline=1]
POST /api/download   {"url": "...", "format": "mp3", "bitrate": 192}
```
`yt-dlp -o -` → `ffmpeg` → HTTP response. No temp file, no job, nothing to expire: the link **is** the download
(`Content-Disposition: attachment`, correct filename, works in `<a href>`, curl, wget, download managers; HEAD supported).
Errors before the first byte are JSON `{detail}` with a real status code; a failure after bytes were sent aborts the
connection, so a truncated file is never saved as if complete. WAV streams use a streaming header (size unknown up
front) — fine for players/editors; the job flow (`/api/convert`) produces a perfect-header WAV.

Also unchanged for the UI: `POST /api/info`, `POST /api/convert`, `GET /api/progress/:id`, `GET /api/file/:id` (Range OK,
survives restarts for 2 h), `GET /api/thumbnail/:id`. Diagnostics: `GET /api/health`, `GET /api/health/youtube`.

## What you must connect to make it work LIVE

1. **A host that can run a long-lived process with binaries + disk** — VPS (Hetzner/DO/Lightsail) or a Docker PaaS
   (Railway/Render/Fly). Not Vercel/Netlify/Cloudflare Workers.
2. **Domain + HTTPS** (Caddy/certbot/Cloudflare) — required for the folder picker.
3. **Serve the frontend from this same server** (it already does) — the UI calls relative `/api/...`.
4. **yt-dlp (kept current) + ffmpeg + Node ≥ 20.** The Dockerfile does all of it; `YTDLP_AUTO_UPDATE=1` self-updates daily.
   Node is handed to yt-dlp as its JS runtime automatically (needed for YouTube since late 2025).
5. **A way past YouTube's datacenter-IP blocking** — the #1 reason this works locally but fails live
   ("Sign in to confirm you're not a bot"). Pick one:
   - `YTDLP_COOKIES=/path/cookies.txt` or `YTDLP_COOKIES_B64=<base64>` — cookies.txt exported from a **throwaway** Google account;
   - `YTDLP_PROXY=http://user:pass@host:port` — residential/ISP proxy;
   - run it on a home PC behind a Cloudflare Tunnel (residential IP).
6. **Reverse proxy** (if nginx): `proxy_buffering off; proxy_read_timeout 600s;` for `/api/`, and set `TRUST_PROXY=1`.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `PORT` / `HOST` | 8000 / 0.0.0.0 | Listen address |
| `YTDLP_BIN` | `yt-dlp` | Path to yt-dlp |
| `FFMPEG_PATH` | auto | ffmpeg binary or its folder (`./bin/ffmpeg`, then PATH) |
| `YTDLP_COOKIES` / `YTDLP_COOKIES_B64` | – | cookies.txt path / base64 content |
| `YTDLP_PROXY` | – | proxy URL |
| `YTDLP_EXTRA_ARGS` | – | extra yt-dlp flags |
| `YTDLP_AUTO_UPDATE` | 0 | `1` = `yt-dlp -U` at start + every 24 h |
| `MAX_DURATION_SEC` | 7200 | longest video allowed (0 = no limit) |
| `MAX_CONCURRENT` | 3 | simultaneous conversions/streams (extra downloads get 503, jobs queue) |
| `RATE_LIMIT_PER_MIN` | 30 | per-IP limit on info/convert/download (0 = off) |
| `ALLOW_SERVER_SAVE` | on unless `NODE_ENV=production` | allow the UI's "save to server folder" field |
| `WAVEGRAB_JOBS` | `~/.wavegrab/jobs` | where finished files live (2 h TTL) |
| `TRUST_PROXY` | – | `1` when behind nginx/Cloudflare (correct client IPs) |

## Troubleshooting
- `/api/health/youtube` is the fastest check: `ok:true` means this server can really reach YouTube.
- Server log prints the real yt-dlp error plus a fix hint (bot check → cookies/proxy; format/n-challenge → update yt-dlp).
- Still blocked with cookies/proxy → add a PO-token provider plugin for yt-dlp (e.g. bgutil-ytdlp-pot-provider).
