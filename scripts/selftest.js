#!/usr/bin/env node
'use strict';
/**
 * End-to-end check of a RUNNING TubeWave backend against real YouTube.
 *
 *   node scripts/selftest.js                                   # http://localhost:8000
 *   node scripts/selftest.js https://yourdomain.com            # your live site
 *   node scripts/selftest.js https://yourdomain.com https://youtu.be/<id>
 *
 * Default video: "Me at the zoo" (19 s). Exit code 1 if anything fails.
 */
const base = (process.argv[2] || 'http://localhost:8000').replace(/\/$/, '');
const yt = process.argv[3] || 'https://youtu.be/jNQXAC9IVRw';
const q = encodeURIComponent(yt);
let failed = 0;

const ok = (name, cond, extra = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '  PASS' : '  FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`);
  return cond;
};
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

async function download(format) {
  const r = await fetch(`${base}/api/download?url=${q}&format=${format}&bitrate=192`);
  const type = r.headers.get('content-type') || '';
  const disp = r.headers.get('content-disposition') || '';
  if (!r.ok) {
    ok(`/api/download ${format}`, false, `HTTP ${r.status} ${await r.text()}`);
    return;
  }
  const buf = Buffer.from(await r.arrayBuffer());
  const magic = format === 'mp3'
    ? buf.subarray(0, 3).toString() === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)
    : buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WAVE';
  ok(`/api/download ${format}: HTTP 200 + correct type`, type.startsWith(format === 'mp3' ? 'audio/mpeg' : 'audio/wav'), type);
  ok(`/api/download ${format}: forces a download with a filename`, /^attachment;.*filename/i.test(disp), disp);
  ok(`/api/download ${format}: real ${format.toUpperCase()} data`, magic && buf.length > 50 * 1024, kb(buf.length));
}

(async () => {
  console.log(`Testing ${base}\nVideo: ${yt}\n`);

  const h = await fetch(`${base}/api/health`).then((r) => r.json()).catch(() => null);
  ok('server reachable', !!h);
  if (!h) process.exit(1);
  ok('ffmpeg available', h.ffmpeg);
  ok('yt-dlp available', !!h.ytdlp, h.ytdlp || '');

  const info = await fetch(`${base}/api/info`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: yt }),
  });
  const ij = await info.json();
  ok('/api/info reads the video from YouTube', info.ok && !!ij.title, info.ok ? ij.title : ij.detail);

  await download('mp3');
  await download('wav');

  // job flow used by the web UI: convert → poll → file
  const c = await fetch(`${base}/api/convert`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: yt, format: 'mp3', bitrate: 192 }),
  }).then((r) => r.json());
  let job = null;
  for (let i = 0; i < 300 && c.job_id; i++) {
    job = await fetch(`${base}/api/progress/${c.job_id}`).then((r) => r.json());
    if (job.status === 'done' || job.status === 'error') break;
    await new Promise((r) => setTimeout(r, 600));
  }
  ok('/api/convert job finishes', job && job.status === 'done', job ? (job.error || `${job.filename}, ${kb(job.size)}`) : c.detail);
  if (job && job.status === 'done') {
    const f = await fetch(`${base}/api/file/${c.job_id}`);
    const buf = Buffer.from(await f.arrayBuffer());
    ok('/api/file is a direct attachment download', f.ok && /^attachment/i.test(f.headers.get('content-disposition') || ''));
    ok('/api/file size matches what the job reported', buf.length === job.size, `${buf.length} bytes`);
    const rg = await fetch(`${base}/api/file/${c.job_id}?inline=1`, { headers: { Range: 'bytes=0-99' } });
    ok('/api/file supports Range (seekable player)', rg.status === 206, `HTTP ${rg.status}`);
  }

  console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed ✔');
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
