'use strict';
/**
 * TubeWave backend — Node.js + Express around yt-dlp + ffmpeg.
 *
 * Drop-in replacement for app.py: same /api contract, serves ./static untouched.
 *
 *   GET  /api/download?url=…&format=mp3|wav&bitrate=192   ← NEW: direct download, streamed live
 *   POST /api/download   {url, format, bitrate}            ← same thing for API clients
 *   POST /api/info       {url}                             → preview data
 *   POST /api/convert    {url, format, bitrate, save_path} → {job_id}
 *   GET  /api/progress/:job_id                             → live status
 *   GET  /api/file/:job_id[?inline=1]                      → the finished file (Range supported)
 *   GET  /api/thumbnail/:video_id
 *   GET  /api/health      /api/health/youtube              → diagnostics
 *
 * Config (env): see BACKEND.md. Needs: node >= 20, yt-dlp, ffmpeg.
 */

const express = require('express');
const contentDisposition = require('content-disposition');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

// ───────────────────────────── config ─────────────────────────────
const env = process.env;
const APP_DIR = __dirname;
const STATIC_DIR = path.join(APP_DIR, 'static');
const PORT = parseInt(env.PORT || '8000', 10);
const HOST = env.HOST || '0.0.0.0';
const JOBS_ROOT = env.WAVEGRAB_JOBS || path.join(os.homedir(), '.wavegrab', 'jobs');
const YTDLP = env.YTDLP_BIN || 'yt-dlp';
const PROXY = env.YTDLP_PROXY || '';
const EXTRA_ARGS = (env.YTDLP_EXTRA_ARGS || '').split(/\s+/).filter(Boolean);
const MAX_DURATION = parseInt(env.MAX_DURATION_SEC || '7200', 10); // seconds, 0 = unlimited
const MAX_CONCURRENT = Math.max(1, parseInt(env.MAX_CONCURRENT || '3', 10));
const RATE_LIMIT = parseInt(env.RATE_LIMIT_PER_MIN || '30', 10); // per IP, 0 = off
// Server-side "copy to folder" writes anywhere the process can write: fine on your own
// machine, dangerous on a public server → off by default in production.
const ALLOW_SERVER_SAVE = env.ALLOW_SERVER_SAVE
  ? env.ALLOW_SERVER_SAVE === '1'
  : env.NODE_ENV !== 'production';

const JOB_TTL = 2 * 60 * 60 * 1000; // keep converted files 2 h
const INFO_TTL = 30 * 60 * 1000;
const THUMB_TTL = 60 * 60 * 1000;
const MAX_TITLE = 120;
const BITRATES = [128, 192, 256, 320];

// Same pattern the frontend uses (plus youtube-nocookie) — never rejects what the UI accepts.
const YT_URL_RE =
  /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([\w-]{11})/i;
const VIDEO_ID_RE = /^[\w-]{11}$/;

// ───────────────────────────── helpers ─────────────────────────────
class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const matchYoutube = (url) => {
  const m = YT_URL_RE.exec(String(url || '').trim());
  return m ? m[1] : null;
};
const watchUrl = (vid) => `https://www.youtube.com/watch?v=${vid}`;

function sanitizeFilename(name) {
  const s = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[ .]+|[ .]+$/g, '');
  return s.slice(0, MAX_TITLE).trim() || 'audio';
}

function fmtTime(sec) {
  if (sec == null || !isFinite(sec)) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}
const humanSpeed = (bps) => {
  if (!bps || !isFinite(bps)) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bps >= 1024 && i < u.length - 1) (bps /= 1024), i++;
  return `${i ? bps.toFixed(1) : Math.round(bps)} ${u[i]}/s`;
};

// ───────────────────────── external tools ─────────────────────────
function verifyFfmpeg(p) {
  try {
    if (p.includes(path.sep) || p.includes('/')) {
      if (!fs.statSync(p).isFile()) return false;
      try {
        fs.accessSync(p, fs.constants.X_OK);
      } catch {
        fs.chmodSync(p, 0o755); // snapshots can strip +x — self-heal
      }
    }
    return spawnSync(p, ['-version'], { timeout: 15000 }).status === 0;
  } catch {
    return false;
  }
}

function findFfmpeg() {
  const cands = [];
  for (const c of [env.FFMPEG_PATH, env.FFMPEG]) {
    if (!c) continue;
    try {
      cands.push(fs.statSync(c).isDirectory() ? path.join(c, 'ffmpeg') : c);
    } catch {
      cands.push(c);
    }
  }
  cands.push(path.join(APP_DIR, 'bin', 'ffmpeg'), 'ffmpeg');
  return cands.find(verifyFfmpeg) || null;
}

const FFMPEG = findFfmpeg();

const ytv = spawnSync(YTDLP, ['--version'], { encoding: 'utf8', timeout: 20000 });
const YTDLP_VERSION = ytv.status === 0 ? ytv.stdout.trim() : null;
// yt-dlp ≥ 2025.11 needs an external JS runtime to solve YouTube's signature challenges.
// We are already running on Node, so hand it ours (only deno is enabled by default).
const JS_RUNTIME_OK =
  !!YTDLP_VERSION &&
  (spawnSync(YTDLP, ['--help'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).stdout || '').includes('--js-runtimes');

// Cookies: yt-dlp rewrites its cookie file, so always work on a private writable copy.
let COOKIES_FILE = '';
try {
  let data = null;
  if (env.YTDLP_COOKIES_B64) data = Buffer.from(env.YTDLP_COOKIES_B64, 'base64');
  else if (env.YTDLP_COOKIES) data = fs.readFileSync(env.YTDLP_COOKIES);
  if (data) {
    COOKIES_FILE = path.join(os.tmpdir(), `tubewave-cookies-${process.pid}.txt`);
    fs.writeFileSync(COOKIES_FILE, data, { mode: 0o600 });
  }
} catch (e) {
  console.error(`[cookies] could not load cookies: ${e.message}`);
}

function ytdlpArgs() {
  const a = ['--ignore-config', '--no-warnings', '--no-playlist', '--socket-timeout', '30', '--retries', '3'];
  if (JS_RUNTIME_OK) a.push('--js-runtimes', `node:${process.execPath}`);
  if (COOKIES_FILE) a.push('--cookies', COOKIES_FILE);
  if (PROXY) a.push('--proxy', PROXY);
  a.push(...EXTRA_ARGS);
  return a;
}

function ffmpegArgs({ input, output, format, bitrate, title, artist, streaming }) {
  const a = ['-hide_banner', '-loglevel', 'error', '-y', '-i', input, '-vn', '-sn', '-map_metadata', '-1'];
  if (format === 'mp3') a.push('-codec:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-ar', '44100', '-ac', '2');
  else a.push('-codec:a', 'pcm_s16le', '-ar', '44100', '-ac', '2');
  // WAV tags are written *after* the audio, which a pipe can't do → only tag files / MP3 streams.
  if (!(streaming && format === 'wav')) {
    if (title) a.push('-metadata', `title=${title}`);
    if (artist) a.push('-metadata', `artist=${artist}`);
  }
  if (streaming) a.push(...(format === 'mp3' ? ['-write_xing', '0', '-f', 'mp3'] : ['-f', 'wav']));
  a.push(output);
  return a;
}

// ── child-process plumbing (process groups so yt-dlp's helpers die with it) ──
const CHILDREN = new Set();

function spawnTracked(cmd, args, stdio) {
  const child = spawn(cmd, args, { stdio, detached: true });
  CHILDREN.add(child);
  child.once('close', () => CHILDREN.delete(child));
  return child;
}
function killGroup(child, sig = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    process.kill(-child.pid, sig);
  } catch {
    try {
      child.kill(sig);
    } catch {
      /* already gone */
    }
  }
}
const exited = (child) =>
  new Promise((resolve) => {
    child.once('error', (e) => resolve(e.code === 'ENOENT' ? 'ENOENT' : -1));
    child.once('close', (code) => resolve(code == null ? -1 : code));
  });
function stderrTail(child, cap = 16000) {
  let s = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => (s = (s + d).slice(-cap)));
  return () => s;
}
function killAfter(child, ms) {
  const t = setTimeout(() => killGroup(child), ms);
  child.once('close', () => clearTimeout(t));
}

async function runCollect(cmd, args, timeoutMs) {
  const child = spawnTracked(cmd, args, ['ignore', 'pipe', 'pipe']);
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d) => (out += d));
  const err = stderrTail(child);
  if (timeoutMs) killAfter(child, timeoutMs);
  const code = await exited(child);
  return { code, stdout: out, stderr: err() };
}

// ── turn yt-dlp's stderr into a clean message + status (+ an operator hint in the log) ──
function lastErrorLine(raw) {
  const lines = String(raw || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const errs = lines.filter((l) => /^ERROR:/i.test(l));
  return (errs.pop() || lines.pop() || '')
    .replace(/^ERROR:\s*/i, '')
    .replace(/^\[[^\]]+\]\s*[\w-]{0,20}:\s*/, '')
    .slice(0, 220);
}
function classify(raw, code) {
  const text = String(raw || '');
  const msg = lastErrorLine(text);
  if (code === 'ENOENT')
    return { status: 500, message: 'The audio engine (yt-dlp) is not installed on the server.', hint: `Install yt-dlp or set YTDLP_BIN (tried "${YTDLP}").` };
  if (/not a bot/i.test(text))
    return {
      status: 503,
      message: "YouTube is asking this server to verify it isn't a bot. Please try again later.",
      hint: 'YouTube flagged this server IP. Provide cookies (YTDLP_COOKIES / YTDLP_COOKIES_B64) or a residential proxy (YTDLP_PROXY). See BACKEND.md.',
    };
  if (/HTTP Error 429|too many requests/i.test(text))
    return { status: 503, message: 'YouTube is rate-limiting this server. Please try again in a few minutes.', hint: 'Use a proxy / cookies, or lower traffic.' };
  if (/requested format is not available|no video formats|n challenge|nsig|javascript runtime|unable to extract/i.test(text))
    return { status: 502, message: "Couldn't get an audio stream for this video right now.", hint: 'Update yt-dlp (yt-dlp -U) and make sure a JS runtime (node >= 20) is available.' };
  if (/private video|members.only|confirm your age|age.restricted|unavailable|removed|copyright|not available in your country|blocked|premiere|this live event/i.test(text))
    return { status: 400, message: msg || 'This video is unavailable.' };
  return { status: 502, message: msg ? `YouTube fetch failed: ${msg}` : "Couldn't fetch this video. Please try again." };
}
function toApiError(raw, code, ctx) {
  const c = classify(raw, code);
  console.error(`[yt-dlp] ${ctx}: ${lastErrorLine(raw) || code}${c.hint ? `\n         ↳ ${c.hint}` : ''}`);
  return new ApiError(c.status, c.message);
}

// ───────────────────────────── video info ─────────────────────────────
const INFO_CACHE = new Map(); // vid → { meta, t }
const INFO_INFLIGHT = new Map();

async function fetchInfo(vid) {
  const args = [...ytdlpArgs(), '-f', 'bestaudio/best', '--skip-download', '--dump-single-json', watchUrl(vid)];
  const r = await runCollect(YTDLP, args, 90000);
  if (r.code !== 0) throw toApiError(r.stderr, r.code, `info ${vid}`);
  let j;
  try {
    j = JSON.parse(r.stdout);
  } catch {
    throw new ApiError(502, "Couldn't read video info from YouTube.");
  }
  return {
    id: vid,
    title: j.title || 'Untitled',
    channel: j.channel || j.uploader || '',
    artist: j.artist || j.uploader || j.channel || '',
    duration: j.duration ?? null,
    views: j.view_count ?? null,
    upload_date: j.upload_date ?? null,
    is_live: !!j.is_live,
  };
}

async function getInfo(vid) {
  const hit = INFO_CACHE.get(vid);
  if (hit && Date.now() - hit.t < INFO_TTL) return hit.meta;
  if (INFO_INFLIGHT.has(vid)) return INFO_INFLIGHT.get(vid);
  const p = fetchInfo(vid)
    .then((meta) => {
      INFO_CACHE.set(vid, { meta, t: Date.now() });
      if (INFO_CACHE.size > 500) INFO_CACHE.delete(INFO_CACHE.keys().next().value);
      return meta;
    })
    .finally(() => INFO_INFLIGHT.delete(vid));
  INFO_INFLIGHT.set(vid, p);
  return p;
}

function assertAllowed(meta) {
  if (meta.is_live) throw new ApiError(400, "Live streams aren't supported — wait until the stream ends.");
  if (MAX_DURATION && meta.duration && meta.duration > MAX_DURATION)
    throw new ApiError(400, `That video is longer than this server's ${Math.round(MAX_DURATION / 60)}-minute limit.`);
}

// ───────────────────────── concurrency + rate limit ─────────────────────────
let active = 0;
const waiters = [];
function makeRelease() {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    active--;
    const next = waiters.shift();
    if (next) next();
  };
}
const acquire = () =>
  new Promise((resolve) => {
    const go = () => (active++, resolve(makeRelease()));
    active < MAX_CONCURRENT ? go() : waiters.push(go);
  });
const tryAcquire = () => (active < MAX_CONCURRENT ? (active++, makeRelease()) : null);

const hits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of hits) if (now - h.t > 60000) hits.delete(ip);
}, 60000).unref();
function rateLimit(req, res, next) {
  if (!RATE_LIMIT) return next();
  const now = Date.now();
  let h = hits.get(req.ip);
  if (!h || now - h.t > 60000) hits.set(req.ip, (h = { t: now, n: 0 }));
  if (++h.n > RATE_LIMIT) {
    res.set('Retry-After', '30');
    return res.status(429).json({ detail: 'Too many requests — slow down a little.' });
  }
  next();
}

// ───────────────────────────── app ─────────────────────────────
const app = express();
app.disable('x-powered-by');
if (env.TRUST_PROXY) app.set('trust proxy', /^\d+$/.test(env.TRUST_PROXY) ? +env.TRUST_PROXY : env.TRUST_PROXY);
app.use(express.json({ limit: '16kb' }));
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

app.get('/api/health', (req, res) =>
  res.json({
    ok: true,
    ffmpeg: !!FFMPEG,
    ffmpeg_path: FFMPEG,
    ytdlp: YTDLP_VERSION,
    js_runtime: JS_RUNTIME_OK ? 'node' : null,
    cookies: !!COOKIES_FILE,
    active,
  })
);

// Live self-check: can THIS server really reach YouTube and read a video? (cached 60 s)
let ytHealth = { t: 0, v: null };
app.get('/api/health/youtube', rateLimit, wrap(async (req, res) => {
  if (ytHealth.v && Date.now() - ytHealth.t < 60000) return res.status(ytHealth.v.ok ? 200 : 503).json(ytHealth.v);
  const t0 = Date.now();
  let v;
  try {
    const m = await fetchInfo('jNQXAC9IVRw'); // "Me at the zoo" — the first YouTube video
    v = { ok: true, title: m.title, ms: Date.now() - t0 };
  } catch (e) {
    v = { ok: false, error: e.message, ms: Date.now() - t0 };
  }
  ytHealth = { t: Date.now(), v };
  res.status(v.ok ? 200 : 503).json(v);
}));

app.post('/api/info', rateLimit, wrap(async (req, res) => {
  const vid = matchYoutube(req.body && req.body.url);
  if (!vid) throw new ApiError(400, "That doesn't look like a YouTube video link.");
  const m = await getInfo(vid);
  assertAllowed(m);
  res.json({
    video_id: m.id,
    title: m.title,
    channel: m.channel,
    duration: m.duration,
    duration_string: fmtTime(m.duration),
    views: m.views,
    upload_date: m.upload_date,
    thumbnail: `/api/thumbnail/${vid}`,
  });
}));

// ─────────── DIRECT DOWNLOAD: yt-dlp ─stdout→ ffmpeg ─stdout→ HTTP response ───────────
// No temp file, no job, no expiry: the link itself is the download. Bytes start flowing as soon
// as the first audio frame is encoded, and a failure BEFORE that returns a JSON error instead of
// a "successful" empty file. A failure AFTER bytes were sent aborts the connection so the browser
// shows the download as failed rather than saving a silently truncated file.
const waitDrain = (res) =>
  new Promise((resolve) => {
    if (res.destroyed) return resolve(); // 'close' already fired — it will never fire again
    const done = () => (res.off('drain', done), res.off('close', done), resolve());
    res.once('drain', done);
    res.once('close', done);
  });

async function streamAudio(res, { vid, format, bitrate, meta, filename, inline }) {
  const yt = spawnTracked(
    YTDLP,
    // webm/opus first: it is the most pipe-friendly container for ffmpeg
    [...ytdlpArgs(), '-q', '--no-progress', '-f', 'bestaudio[ext=webm]/bestaudio/best', '-o', '-', watchUrl(vid)],
    ['ignore', 'pipe', 'pipe']
  );
  const ff = spawnTracked(
    FFMPEG,
    ffmpegArgs({ input: 'pipe:0', output: 'pipe:1', format, bitrate, title: meta.title, artist: meta.artist, streaming: true }),
    ['pipe', 'pipe', 'pipe']
  );
  const ytErr = stderrTail(yt);
  const ffErr = stderrTail(ff);
  const ytDone = exited(yt);
  const ffDone = exited(ff);

  yt.stdout.on('error', () => {});
  ff.stdin.on('error', () => {}); // EPIPE if ffmpeg dies first
  yt.stdout.pipe(ff.stdin);

  let aborted = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      aborted = true; // client went away → stop burning bandwidth/CPU
      killGroup(yt);
      killGroup(ff);
    }
  });

  let started = false;
  try {
    for await (const chunk of ff.stdout) {
      if (aborted || res.destroyed) break; // client left: stop immediately (also frees the slot)
      if (!started) {
        started = true;
        res.status(200);
        res.set({
          'Content-Type': format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
          'Content-Disposition': contentDisposition(filename, { type: inline ? 'inline' : 'attachment' }),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Accel-Buffering': 'no', // tell nginx not to buffer the stream
        });
      }
      if (!res.write(chunk)) await waitDrain(res);
    }
  } catch {
    /* stream torn down — handled below */
  }

  const [ytCode, ffCode] = await Promise.all([ytDone, ffDone]);
  if (aborted) return;
  if (started && ytCode === 0 && ffCode === 0) return void res.end();

  const raw = ytErr() || ffErr();
  if (!started) throw toApiError(raw || 'no audio was produced', ytCode !== 0 ? ytCode : ffCode, `download ${vid}`);
  console.error(`[download ${vid}] stream broke mid-way (yt-dlp=${ytCode}, ffmpeg=${ffCode}): ${lastErrorLine(raw)}`);
  res.destroy();
}

async function downloadHandler(req, res) {
  const src = req.method === 'POST' ? req.body || {} : req.query;
  const vid = matchYoutube(src.url);
  if (!vid) throw new ApiError(400, "That doesn't look like a YouTube video link.");
  const format = String(src.format || 'mp3').toLowerCase();
  if (format !== 'mp3' && format !== 'wav') throw new ApiError(400, 'format must be mp3 or wav.');
  const bitrate = parseInt(src.bitrate || '192', 10);
  if (!BITRATES.includes(bitrate)) throw new ApiError(400, 'Unsupported bitrate.');
  if (!FFMPEG) throw new ApiError(500, 'ffmpeg was not found on the server. Install ffmpeg and restart.');

  const meta = await getInfo(vid);
  assertAllowed(meta);
  const filename = `${sanitizeFilename(meta.title)}.${format}`;
  const inline = String(src.inline || '') === '1';

  if (req.method === 'HEAD') {
    res.set({
      'Content-Type': format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
      'Content-Disposition': contentDisposition(filename, { type: inline ? 'inline' : 'attachment' }),
      'Cache-Control': 'no-store',
    });
    return void res.end();
  }

  const release = tryAcquire();
  if (!release) {
    res.set('Retry-After', '5');
    throw new ApiError(503, 'The server is busy converting other files. Please try again in a few seconds.');
  }
  try {
    await streamAudio(res, { vid, format, bitrate, meta, filename, inline });
  } finally {
    release();
  }
}
app.route('/api/download').all(rateLimit).get(wrap(downloadHandler)).post(wrap(downloadHandler));

// ─────────── JOB FLOW (what the existing frontend uses): convert → poll → file ───────────
const JOBS = new Map();
const DL_TEMPLATE =
  'download:WG|%(progress.status)s|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s';

const publicJob = (j) => ({
  id: j.id,
  status: j.status,
  stage: j.stage,
  percent: j.percent,
  speed: j.speed,
  eta: j.eta,
  title: j.title,
  filename: j.filename,
  size: j.size,
  saved_to: j.saved_to,
  error: j.error,
  format: j.format,
});

app.post('/api/convert', rateLimit, wrap(async (req, res) => {
  const b = req.body || {};
  const vid = matchYoutube(b.url);
  if (!vid) throw new ApiError(400, "That doesn't look like a YouTube video link.");
  const format = String(b.format || 'mp3').toLowerCase();
  if (format !== 'mp3' && format !== 'wav') throw new ApiError(400, 'format must be mp3 or wav.');
  const bitrate = parseInt(b.bitrate ?? 192, 10);
  if (!BITRATES.includes(bitrate)) throw new ApiError(400, 'Unsupported bitrate.');
  if (!FFMPEG) throw new ApiError(500, 'ffmpeg was not found on the server. Install ffmpeg and restart.');

  const id = crypto.randomBytes(6).toString('hex');
  const dir = path.join(JOBS_ROOT, id);
  await fsp.mkdir(dir, { recursive: true });
  const job = {
    id, video_id: vid, url: watchUrl(vid), format, bitrate,
    status: 'queued', stage: 'Queued', percent: 0, speed: '', eta: '',
    title: '', filename: `audio.${format}`, size: 0, saved_to: '', error: '',
    created: Date.now(), dir,
  };
  JOBS.set(id, job);
  runJob(job, typeof b.save_path === 'string' ? b.save_path.trim() : '').catch((e) => console.error('[job]', e));
  res.json({ job_id: id });
}));

app.get('/api/progress/:id', (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ detail: 'Unknown job.' });
  res.json(publicJob(job));
});

app.get('/api/file/:id', (req, res, next) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ detail: 'Unknown job.' });
  if (job.status !== 'done') return res.status(409).json({ detail: "File isn't ready yet." });
  if (!fs.existsSync(path.join(job.dir, job.filename))) return res.status(410).json({ detail: 'File expired.' });
  const inline = req.query.inline === '1';
  res.set({
    'Content-Type': job.format === 'mp3' ? 'audio/mpeg' : 'audio/wav',
    'Content-Disposition': contentDisposition(job.filename, { type: inline ? 'inline' : 'attachment' }),
    'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff',
  });
  // sendFile gives us Range/206 (seekable <audio>), ETag and conditional requests for free.
  res.sendFile(job.filename, { root: job.dir, dotfiles: 'allow', acceptRanges: true, cacheControl: false }, (err) => {
    if (err && err.code !== 'ECONNABORTED' && !res.headersSent) next(err);
  });
});

async function runJob(job, savePath) {
  const release = await acquire(); // queue behind MAX_CONCURRENT
  const dir = job.dir;
  try {
    job.status = 'downloading';
    job.stage = 'Downloading audio';

    // 1) download the source audio (real progress from yt-dlp)
    const filter = `!is_live${MAX_DURATION ? ` & duration<=?${MAX_DURATION}` : ''}`;
    const yt = spawnTracked(
      YTDLP,
      [
        ...ytdlpArgs(), '-f', 'bestaudio/best', '-q', '--progress', '--newline',
        '--progress-template', DL_TEMPLATE, '--write-info-json', '--match-filter', filter,
        '--concurrent-fragments', '4', '-o', path.join(dir, 'audio_src.%(ext)s'), job.url,
      ],
      ['ignore', 'pipe', 'pipe']
    );
    const ytErr = stderrTail(yt);
    killAfter(yt, 60 * 60 * 1000);
    readline.createInterface({ input: yt.stdout }).on('line', (line) => {
      if (!line.startsWith('WG|')) return;
      const [, st, done, total, est, speed, eta] = line.split('|');
      if (st === 'downloading') {
        job.status = 'downloading';
        job.stage = 'Downloading audio';
        const tot = Number(total) || Number(est);
        if (tot) job.percent = Math.max(1, Math.min(99, Math.floor((Number(done) * 100) / tot)));
        job.speed = humanSpeed(Number(speed));
        job.eta = isFinite(Number(eta)) && eta !== 'NA' ? fmtTime(Number(eta)) : '';
      } else if (st === 'finished') {
        job.status = 'converting';
        job.stage = `Converting to ${job.format.toUpperCase()}`;
        job.percent = 99;
        job.speed = job.eta = '';
      }
    });
    const ytCode = await exited(yt);
    if (ytCode !== 0) throw toApiError(ytErr(), ytCode, `job ${job.id}`);

    let src = null;
    let srcSize = -1;
    for (const f of await fsp.readdir(dir)) {
      if (!f.startsWith('audio_src.') || /\.(info\.json|part|ytdl)$/.test(f)) continue;
      const sz = (await fsp.stat(path.join(dir, f))).size;
      if (sz > srcSize) (src = path.join(dir, f)), (srcSize = sz);
    }
    if (!src) throw new Error("No audio was downloaded — the video may be live or longer than this server's limit.");

    let info = {};
    try {
      info = JSON.parse(await fsp.readFile(path.join(dir, 'audio_src.info.json'), 'utf8'));
    } catch {
      /* tags are optional */
    }
    const title = info.title || path.parse(src).name;
    const artist = info.artist || info.uploader || info.channel || '';

    // 2) convert
    job.status = 'converting';
    job.stage = `Converting to ${job.format.toUpperCase()}`;
    job.percent = 99;
    const finalName = `${sanitizeFilename(title)}.${job.format}`;
    const final = path.join(dir, finalName);
    const ff = spawnTracked(
      FFMPEG,
      ffmpegArgs({ input: src, output: final, format: job.format, bitrate: job.bitrate, title, artist }),
      ['ignore', 'ignore', 'pipe']
    );
    const ffErr = stderrTail(ff);
    killAfter(ff, 15 * 60 * 1000);
    const ffCode = await exited(ff);
    if (ffCode !== 0 || !fs.existsSync(final))
      throw new Error(`ffmpeg conversion failed: ${lastErrorLine(ffErr()) || 'no output'}`);

    for (const f of await fsp.readdir(dir)) if (f !== finalName) await fsp.rm(path.join(dir, f), { force: true });

    job.title = title;
    job.filename = finalName;
    job.size = (await fsp.stat(final)).size;

    // optional copy to a folder on the machine running the server
    if (savePath) {
      if (!ALLOW_SERVER_SAVE) {
        job.error = 'Server-side folder copy is turned off on this server (your download is ready below).';
      } else {
        try {
          const destDir = savePath.replace(/^~(?=$|[\\/])/, os.homedir());
          await fsp.mkdir(destDir, { recursive: true });
          const dest = path.join(destDir, finalName);
          await fsp.copyFile(final, dest);
          job.saved_to = dest;
        } catch (e) {
          job.error = `Downloaded OK, but couldn't copy to that folder: ${e.message}`;
        }
      }
    }

    job.percent = 100;
    job.status = 'done';
    job.stage = 'Ready';
    job.speed = job.eta = '';
    // survive restarts: the /api/file/:id link keeps working until the TTL
    await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ ...publicJob(job), created: job.created, video_id: job.video_id, bitrate: job.bitrate }));
  } catch (e) {
    job.status = 'error';
    job.stage = 'Error';
    job.error = String(e.message || 'Conversion failed.').replace(/^ERROR:\s*/i, '');
    fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); // no orphaned half-files
  } finally {
    release();
  }
}

// restore finished jobs after a restart / deploy; sweep expired ones
async function loadJobsFromDisk() {
  let dirs = [];
  try {
    dirs = await fsp.readdir(JOBS_ROOT);
  } catch {
    return;
  }
  for (const id of dirs) {
    if (!/^[a-f0-9]{12}$/.test(id)) continue;
    try {
      const dir = path.join(JOBS_ROOT, id);
      const m = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8'));
      if (m.status === 'done' && Date.now() - m.created < JOB_TTL && fs.existsSync(path.join(dir, m.filename)))
        JOBS.set(id, { ...m, dir });
    } catch {
      /* not a restorable job */
    }
  }
}
async function cleanupOld() {
  const now = Date.now();
  for (const [id, j] of JOBS) if (now - j.created > JOB_TTL) JOBS.delete(id);
  let dirs = [];
  try {
    dirs = await fsp.readdir(JOBS_ROOT);
  } catch {
    return;
  }
  for (const d of dirs) {
    try {
      const p = path.join(JOBS_ROOT, d);
      const st = await fsp.stat(p);
      if (st.isDirectory() && now - st.mtimeMs > JOB_TTL) await fsp.rm(p, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ─────────── thumbnails ───────────
const THUMBS = new Map();
app.get('/api/thumbnail/:id', wrap(async (req, res) => {
  const id = req.params.id;
  if (!VIDEO_ID_RE.test(id)) throw new ApiError(400, 'Bad video id.');
  const hit = THUMBS.get(id);
  if (hit && Date.now() - hit.t < THUMB_TTL) return res.type('image/jpeg').send(hit.buf);
  let buf;
  try {
    const r = await fetch(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) throw new Error(String(r.status));
    buf = Buffer.from(await r.arrayBuffer());
  } catch {
    throw new ApiError(502, 'Thumbnail unavailable.');
  }
  THUMBS.set(id, { buf, t: Date.now() });
  if (THUMBS.size > 300) THUMBS.delete(THUMBS.keys().next().value);
  res.set('Cache-Control', 'public, max-age=3600').type('image/jpeg').send(buf);
}));

// ─────────── static frontend (served exactly as-is) ───────────
app.use('/static', express.static(STATIC_DIR));
app.get('/', (req, res) => res.sendFile('index.html', { root: STATIC_DIR, dotfiles: 'allow' }));

app.use('/api', (req, res) => res.status(404).json({ detail: 'Not found.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (res.headersSent) return res.destroy();
  if (err instanceof ApiError) return res.status(err.status).json({ detail: err.message });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ detail: 'Invalid JSON.' });
  console.error(err);
  res.status(500).json({ detail: 'Server error.' });
});

// ───────────────────────────── boot ─────────────────────────────
async function selfUpdate() {
  // YouTube changes constantly; a stale yt-dlp is the #1 cause of "it stopped working".
  const r = await runCollect(YTDLP, ['-U'], 120000);
  console.log(`[yt-dlp] self-update: ${(r.stdout + r.stderr).trim().split('\n').pop() || r.code}`);
}

async function main() {
  await fsp.mkdir(JOBS_ROOT, { recursive: true });
  await loadJobsFromDisk();
  await cleanupOld();
  setInterval(() => cleanupOld().catch(() => {}), 10 * 60 * 1000).unref();
  if (env.YTDLP_AUTO_UPDATE === '1' && YTDLP_VERSION) {
    selfUpdate().catch(() => {});
    setInterval(() => selfUpdate().catch(() => {}), 24 * 60 * 60 * 1000).unref();
  }

  const server = app.listen(PORT, HOST, () => {
    console.log(`TubeWave backend → http://localhost:${PORT}`);
    console.log(`  yt-dlp : ${YTDLP_VERSION || 'NOT FOUND'}${JS_RUNTIME_OK ? ' (JS runtime: node)' : ''}`);
    console.log(`  ffmpeg : ${FFMPEG || 'NOT FOUND'}`);
    console.log(`  cookies: ${COOKIES_FILE ? 'loaded' : 'none'}   proxy: ${PROXY ? 'set' : 'none'}   jobs: ${JOBS_ROOT}`);
    if (!YTDLP_VERSION) console.error('WARNING: yt-dlp not found — every fetch will fail until it is installed.');
    if (!FFMPEG) console.error('WARNING: ffmpeg not found — conversions will fail until it is installed.');
  });
  server.requestTimeout = 0; // long streams must not be cut by Node's request timeout

  const shutdown = () => {
    for (const c of CHILDREN) killGroup(c);
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

process.on('exit', () => {
  for (const c of CHILDREN) killGroup(c);
  if (COOKIES_FILE) {
    try {
      fs.unlinkSync(COOKIES_FILE);
    } catch {
      /* ignore */
    }
  }
});
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));

main();
