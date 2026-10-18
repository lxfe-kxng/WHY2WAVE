/* TubeWave frontend — vanilla JS. Downloads fixed, animated, no dependencies. */
"use strict";

/* ---------------- elements ---------------- */
const $ = (id) => document.getElementById(id);
const urlInput = $("url");
const inputRow = $("inputRow");
const pasteBtn = $("pasteBtn");
const urlError = $("urlError");
const preview = $("preview");
const thumb = $("thumb");
const titleEl = $("title");
const channelEl = $("channel");
const durationEl = $("duration");
const viewsEl = $("views");
const formatSeg = $("formatSeg");
const formatHint = $("formatHint");
const qualityOpt = $("qualityOpt");
const qualitySel = $("quality");
const folderBtn = $("folderBtn");
const folderChip = $("folderChip");
const folderName = $("folderName");
const folderClear = $("folderClear");
const folderHint = $("folderHint");
const serverPath = $("serverPath");
const convertBtn = $("convertBtn");
const convertLabel = $("convertLabel");
const progressWrap = $("progressWrap");
const equalizer = $("equalizer");
const stageText = $("stageText");
const pctText = $("pctText");
const barFill = $("barFill");
const subText = $("subText");
const resultWrap = $("resultWrap");
const resultName = $("resultName");
const resultMeta = $("resultMeta");
const player = $("player");
const dlLink = $("dlLink");
const saveFolderBtn = $("saveFolderBtn");
const newBtn = $("newBtn");
const historyWrap = $("historyWrap");
const historyList = $("historyList");
const toasts = $("toasts");
const mainCard = $("mainCard");
const embedBanner = $("embedBanner");
const openTabBtn = $("openTabBtn");
const confettiCanvas = $("confetti");

const isEmbedded = window.self !== window.top;
const supportsDirPicker = typeof window.showDirectoryPicker === "function" && window.isSecureContext;
const supportsSavePicker = typeof window.showSaveFilePicker === "function" && window.isSecureContext;

/* ---------------- state ---------------- */
const state = {
  video: null,
  format: "mp3",
  dirHandle: null,
  job: null,
  fileUrl: null,
  pollTimer: null,
  busy: false,
  history: [],
};

const YT_RE =
  /^https?:\/\/(?:www\.|m\.|music\.)?(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([\w-]{11})/i;

/* ---------------- toasts ---------------- */
function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = msg;
  toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

/* ---------------- embed banner ---------------- */
if (isEmbedded) {
  embedBanner.classList.remove("hidden");
}
openTabBtn.addEventListener("click", async () => {
  const win = window.open(window.location.href, "_blank");
  if (!win) {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast("Popup blocked — app URL copied. Paste it in a new tab.", "ok");
    } catch {
      toast(`Open this page in a new tab: ${window.location.href}`, "");
    }
  }
});

/* ---------------- ripple + magnetic + glow ---------------- */
document.addEventListener("click", (e) => {
  const btn = e.target.closest(".btn, .banner-btn, .seg, .chip-x");
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const d = Math.max(r.width, r.height) * 0.9;
  const ripple = document.createElement("span");
  ripple.className = "ripple";
  ripple.style.width = ripple.style.height = `${d}px`;
  ripple.style.left = `${e.clientX - r.left - d / 2}px`;
  ripple.style.top = `${e.clientY - r.top - d / 2}px`;
  btn.appendChild(ripple);
  setTimeout(() => ripple.remove(), 560);
});

const finePointer = window.matchMedia("(pointer: fine)").matches;
if (finePointer) {
  mainCard.addEventListener("mousemove", (e) => {
    const r = mainCard.getBoundingClientRect();
    mainCard.style.setProperty("--mx", `${e.clientX - r.left}px`);
    mainCard.style.setProperty("--my", `${e.clientY - r.top}px`);

    const b = convertBtn.getBoundingClientRect();
    const cx = b.left + b.width / 2;
    const cy = b.top + b.height / 2;
    const dx = e.clientX - cx;
    const dy = e.clientY - cy;
    if (Math.hypot(dx, dy) < 170 && !convertBtn.disabled) {
      convertBtn.style.transform = `translate(${dx * 0.07}px, ${dy * 0.07}px)`;
    } else {
      convertBtn.style.transform = "";
    }
  });
  mainCard.addEventListener("mouseleave", () => {
    convertBtn.style.transform = "";
    mainCard.style.setProperty("--mx", "50%");
    mainCard.style.setProperty("--my", "0%");
  });
}

function shakeInput() {
  inputRow.classList.remove("shake");
  void inputRow.offsetWidth; // restart animation
  inputRow.classList.add("shake");
  setTimeout(() => inputRow.classList.remove("shake"), 500);
}

/* ---------------- confetti ---------------- */
const ctx = confettiCanvas.getContext("2d");
let particles = [];
let confettiRaf = 0;

function sizeCanvas() {
  confettiCanvas.width = window.innerWidth;
  confettiCanvas.height = window.innerHeight;
}
sizeCanvas();
window.addEventListener("resize", sizeCanvas);

function burstConfetti(x, y, count = 64) {
  const colors = ["#ff2d46", "#ff7a2e", "#ffd166", "#22d3ee", "#ffffff", "#7c5cff"];
  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = 2.5 + Math.random() * 7;
    particles.push({
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3.5,
      size: 4 + Math.random() * 7,
      color: colors[i % colors.length],
      life: 1,
      decay: 0.008 + Math.random() * 0.014,
      rot: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      rect: Math.random() > 0.45,
    });
  }
  if (!confettiRaf) confettiRaf = requestAnimationFrame(tickConfetti);
}

function tickConfetti() {
  ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
  particles = particles.filter((p) => p.life > 0);
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += 0.12; // gravity
    p.vx *= 0.985;
    p.rot += p.vr;
    p.life -= p.decay;
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.globalAlpha = Math.max(p.life, 0);
    ctx.fillStyle = p.color;
    if (p.rect) ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    else ctx.beginPath(), ctx.arc(0, 0, p.size / 2.2, 0, Math.PI * 2), ctx.fill();
    ctx.restore();
  }
  if (particles.length) confettiRaf = requestAnimationFrame(tickConfetti);
  else { confettiRaf = 0; ctx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height); }
}

/* ---------------- percent ticker ---------------- */
let pctShown = 0;
let pctTarget = 0;
let pctRaf = 0;

function animatePercent() {
  pctShown += (pctTarget - pctShown) * 0.16;
  if (Math.abs(pctTarget - pctShown) < 0.4) pctShown = pctTarget;
  pctText.textContent = `${Math.round(pctShown)}%`;
  if (pctShown !== pctTarget) pctRaf = requestAnimationFrame(animatePercent);
  else pctRaf = 0;
}

function setPercent(p) {
  pctTarget = Math.max(0, Math.min(100, p));
  if (!pctRaf) pctRaf = requestAnimationFrame(animatePercent);
}

/* ---------------- URL / info ---------------- */
function extractId(url) {
  const m = (url || "").trim().match(YT_RE);
  return m ? m[1] : null;
}

let infoTimer = null;
function scheduleInfoFetch() {
  clearTimeout(infoTimer);
  const id = extractId(urlInput.value);
  if (!id) {
    if (urlInput.value.trim()) {
      showUrlError("That doesn't look like a YouTube video link.");
    } else clearAll();
    return;
  }
  hideUrlError();
  infoTimer = setTimeout(fetchInfo, 350);
}

async function fetchInfo() {
  const url = urlInput.value.trim();
  setPreviewLoading();
  try {
    const res = await fetch("/api/info", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Couldn't fetch video info.");
    state.video = data;
    renderPreview(data);
    convertBtn.disabled = false;
  } catch (err) {
    state.video = null;
    preview.classList.add("hidden");
    convertBtn.disabled = true;
    showUrlError(err.message);
  }
}

function setPreviewLoading() {
  preview.classList.remove("hidden");
  thumb.removeAttribute("src");
  titleEl.textContent = "Fetching video info…";
  channelEl.textContent = "";
  durationEl.textContent = "";
  viewsEl.textContent = "";
  convertBtn.disabled = true;
}

function renderPreview(v) {
  preview.classList.remove("hidden");
  thumb.src = v.thumbnail;
  thumb.alt = v.title;
  titleEl.textContent = v.title;
  channelEl.textContent = v.channel || "";
  durationEl.textContent = v.duration_string || "";
  viewsEl.textContent = v.views ? `${Number(v.views).toLocaleString()} views` : "";
}

function showUrlError(msg) {
  urlError.textContent = msg;
  shakeInput();
}
function hideUrlError() {
  urlError.textContent = "";
}

function clearAll() {
  state.video = null;
  preview.classList.add("hidden");
  progressWrap.classList.add("hidden");
  resultWrap.classList.add("hidden");
  convertBtn.disabled = true;
  hideUrlError();
}

/* ---------------- format (glider) ---------------- */
formatSeg.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg");
  if (!btn) return;
  formatSeg.querySelectorAll(".seg").forEach((b) => {
    b.classList.toggle("active", b === btn);
    b.setAttribute("aria-checked", b === btn ? "true" : "false");
  });
  state.format = btn.dataset.fmt;
  const isMp3 = state.format === "mp3";
  formatSeg.classList.toggle("wav", !isMp3);
  qualityOpt.classList.toggle("hidden", !isMp3);
  formatHint.textContent = isMp3
    ? "Compressed & portable — great for music, podcasts, phone."
    : "Lossless PCM — studio-clean, bigger files. Best for editing.";
});

/* ---------------- folder picker ---------------- */
if (!supportsDirPicker && !supportsSavePicker) {
  folderBtn.title =
    "Folder picker needs Chrome/Edge in a full tab. Regular download still works.";
}

async function pickFolder() {
  if (!supportsDirPicker) {
    if (isEmbedded) {
      toast("This preview is embedded — open the app in a full tab to pick folders.", "err");
    } else {
      toast("Folder picker needs Chrome/Edge. Use Download instead.", "err");
    }
    return;
  }
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite" });
    const perm = await handle.requestPermission({ mode: "readwrite" });
    if (perm !== "granted") {
      toast("Write permission for that folder was denied.", "err");
      return;
    }
    state.dirHandle = handle;
    folderChip.classList.remove("hidden");
    folderName.textContent = handle.name;
    folderHint.innerHTML = `Every conversion saves straight into <strong>${escapeHtml(handle.name)}</strong>.`;
    toast(`Save folder set to “${handle.name}”`, "ok");
  } catch (err) {
    if (err && err.name !== "AbortError") toast("Couldn't open the folder picker.", "err");
  }
}

function clearFolder() {
  state.dirHandle = null;
  folderChip.classList.add("hidden");
  folderHint.textContent =
    "No folder picked — downloads use your browser's Downloads folder.";
}

folderBtn.addEventListener("click", pickFolder);
folderClear.addEventListener("click", clearFolder);

async function writeToFolder(blob, name) {
  const fh = await state.dirHandle.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(blob);
  await w.close();
}

/* ---------------- downloads (fixed: direct URLs, no double-fetch) ---------------- */
function directDownload(href, name) {
  const a = document.createElement("a");
  a.href = href;
  a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function fetchBlob(fileUrl) {
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error("Couldn't fetch the file.");
  return res.blob();
}

/** Save a finished file: picked folder → native save dialog → plain download. */
async function saveFinished() {
  const job = state.job;
  if (!job || !state.fileUrl) return;
  const name = job.filename;

  // 1. folder already picked → write straight into it
  if (state.dirHandle) {
    try {
      const blob = await fetchBlob(state.fileUrl);
      await writeToFolder(blob, name);
      toast(`Saved to ${state.dirHandle.name}/${name}`, "ok");
      return;
    } catch {
      toast("Couldn't write to the picked folder.", "err");
    }
  }

  // 2. native save dialog (user chooses the folder in the dialog)
  if (supportsSavePicker) {
    try {
      const blob = await fetchBlob(state.fileUrl);
      const handle = await window.showSaveFilePicker({ suggestedName: name });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      toast(`Saved as ${handle.name}`, "ok");
      return;
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }

  // 3. folder picker then write
  if (supportsDirPicker && !state.dirHandle) {
    await pickFolder();
    if (state.dirHandle) {
      try {
        const blob = await fetchBlob(state.fileUrl);
        await writeToFolder(blob, name);
        toast(`Saved to ${state.dirHandle.name}/${name}`, "ok");
        return;
      } catch {
        /* fall through */
      }
    }
  }

  // 4. plain browser download
  directDownload(state.fileUrl, name);
  toast("Download started — check your Downloads folder.", "ok");
}

/* ---------------- convert ---------------- */
async function convert() {
  if (state.busy) return;
  const url = urlInput.value.trim();
  if (!extractId(url)) {
    showUrlError("That doesn't look like a YouTube video link.");
    return;
  }

  state.busy = true;
  convertBtn.disabled = true;
  convertLabel.textContent = "Working…";
  resultWrap.classList.add("hidden");
  progressWrap.classList.remove("hidden");
  equalizer.classList.remove("paused");
  setProgress(2, "Contacting YouTube…", "");

  try {
    const res = await fetch("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        format: state.format,
        bitrate: parseInt(qualitySel.value, 10) || 192,
        save_path: serverPath.value.trim() || null,
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Conversion failed.");
    pollJob(data.job_id);
  } catch (err) {
    finishWithError(err.message);
  }
}

function setProgress(pct, stage, sub) {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  barFill.style.width = `${p}%`;
  barFill.classList.toggle("active", p < 100);
  setPercent(p);
  stageText.textContent = stage;
  subText.textContent = sub || "";
}

function pollJob(jobId) {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/api/progress/${jobId}`);
      const job = await res.json();
      if (!res.ok) throw new Error(job.detail || "Lost track of the job.");
      state.job = job;

      if (job.status === "queued") {
        setProgress(3, "Queued…", "");
      } else if (job.status === "downloading") {
        const bits = [job.speed, job.eta ? `ETA ${job.eta}` : ""].filter(Boolean).join("  ·  ");
        setProgress(job.percent || 5, "Downloading audio", bits);
      } else if (job.status === "converting") {
        setProgress(99, job.stage || `Converting to ${job.format.toUpperCase()}`, "");
      } else if (job.status === "done") {
        clearInterval(state.pollTimer);
        finishWithSuccess(job, jobId);
      } else if (job.status === "error") {
        clearInterval(state.pollTimer);
        finishWithError(job.error || "Conversion failed.");
      }
    } catch (err) {
      clearInterval(state.pollTimer);
      finishWithError(err.message);
    }
  }, 600);
}

function finishWithError(msg) {
  state.busy = false;
  convertBtn.disabled = !state.video;
  convertLabel.textContent = "Convert & Download";
  equalizer.classList.add("paused");
  barFill.classList.remove("active");
  barFill.style.width = "100%";
  barFill.style.background = "var(--err)";
  stageText.textContent = "Something went wrong";
  pctText.textContent = "—";
  subText.textContent = msg;
  shakeInput();
  toast(msg, "err");
  setTimeout(() => {
    barFill.style.background = "";
    progressWrap.classList.add("hidden");
    if (state.video) convertBtn.disabled = false;
  }, 4500);
}

function finishWithSuccess(job, jobId) {
  setProgress(100, "Ready", "");
  equalizer.classList.add("paused");

  // Direct, single-transfer file URL (no eager 30MB+ blob fetch).
  const fileUrl = `/api/file/${jobId}`;
  state.fileUrl = fileUrl;

  // Result card
  resultWrap.classList.remove("hidden");
  resultName.textContent = job.filename;
  const sizeStr = formatBytes(job.size);
  const extra = job.saved_to ? ` · saved to ${job.saved_to}` : "";
  resultMeta.textContent = `${job.format.toUpperCase()} · ${sizeStr}${extra}`;
  dlLink.href = fileUrl;
  dlLink.setAttribute("download", job.filename);
  player.src = `${fileUrl}?inline=1`; // streams with seeking, no download needed

  // Deliver immediately: folder → write; otherwise trigger a real download.
  if (state.dirHandle) {
    fetchBlob(fileUrl)
      .then((blob) => writeToFolder(blob, job.filename))
      .then(() => toast(`Saved to ${state.dirHandle.name}/${job.filename}`, "ok"))
      .catch(() => {
        directDownload(fileUrl, job.filename);
        toast("Folder write failed — started a browser download instead.", "err");
      });
  } else {
    directDownload(fileUrl, job.filename);
  }

  // Non-fatal warnings (e.g. server-side folder copy failed)
  if (job.error) toast(job.error, "err");

  // 🎉
  const r = resultWrap.getBoundingClientRect();
  burstConfetti(r.left + r.width / 2, r.top + 40);
  setTimeout(() => burstConfetti(window.innerWidth * 0.25, window.innerHeight * 0.3, 36), 180);
  setTimeout(() => burstConfetti(window.innerWidth * 0.75, window.innerHeight * 0.3, 36), 320);

  // History
  state.history.unshift({
    id: jobId,
    name: job.filename,
    url: fileUrl,
    meta: `${job.format.toUpperCase()} · ${sizeStr}`,
  });
  renderHistory();

  state.busy = false;
  convertLabel.textContent = "Convert & Download";
  convertBtn.disabled = !state.video;
  setTimeout(() => progressWrap.classList.add("hidden"), 500);
}

/* ---------------- result actions ---------------- */
dlLink.addEventListener("click", (e) => {
  e.preventDefault();
  if (state.fileUrl) {
    directDownload(state.fileUrl, state.job ? state.job.filename : "audio");
    toast("Download started — check your Downloads folder.", "ok");
  }
});

saveFolderBtn.addEventListener("click", saveFinished);

newBtn.addEventListener("click", () => {
  resultWrap.classList.add("hidden");
  urlInput.value = "";
  urlInput.focus();
  clearAll();
});

/* ---------------- history + swipe-to-delete ---------------- */
function renderHistory() {
  historyWrap.classList.toggle("hidden", state.history.length === 0);
  historyList.innerHTML = "";
  for (const item of state.history.slice(0, 8)) {
    const li = document.createElement("li");

    const back = document.createElement("div");
    back.className = "h-remove";
    back.textContent = "Remove";

    const row = document.createElement("div");
    row.className = "h-row";
    row.innerHTML = `
      <span class="h-name"></span>
      <span class="h-meta"></span>
      <button class="btn ghost" type="button">Download</button>
      <button class="btn ghost" type="button">Play</button>`;
    row.querySelector(".h-name").textContent = item.name;
    row.querySelector(".h-meta").textContent = item.meta;
    const [dlBtn, playBtn] = row.querySelectorAll("button");

    dlBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      directDownload(item.url, item.name);
      toast("Download started.", "ok");
    });

    playBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      player.src = `${item.url}?inline=1`;
      player.play().catch(() => {});
      resultWrap.classList.remove("hidden");
      resultName.textContent = item.name;
      resultMeta.textContent = item.meta;
      dlLink.href = item.url;
      dlLink.setAttribute("download", item.name);
      state.fileUrl = item.url;
      state.job = { ...state.job, filename: item.name };
    });

    // swipe left to remove
    let startX = 0;
    let dx = 0;
    let dragging = false;

    row.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      startX = e.clientX;
      dx = 0;
      row.classList.add("dragging");
      row.setPointerCapture(e.pointerId);
    });

    row.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      dx = Math.min(0, e.clientX - startX);
      if (dx < -6) e.preventDefault();
      row.style.transform = `translateX(${Math.max(dx, -140)}px)`;
    });

    const endDrag = () => {
      if (!dragging) return;
      dragging = false;
      row.classList.remove("dragging");
      if (dx < -90) {
        li.classList.add("removing");
        setTimeout(() => {
          state.history = state.history.filter((h) => h !== item);
          renderHistory();
        }, 320);
      } else {
        row.style.transform = "";
      }
    };

    row.addEventListener("pointerup", endDrag);
    row.addEventListener("pointercancel", endDrag);
    back.addEventListener("click", () => {
      li.classList.add("removing");
      setTimeout(() => {
        state.history = state.history.filter((h) => h !== item);
        renderHistory();
      }, 320);
    });

    li.appendChild(back);
    li.appendChild(row);
    historyList.appendChild(li);
  }
}

/* ---------------- input events ---------------- */
urlInput.addEventListener("input", scheduleInfoFetch);
urlInput.addEventListener("paste", () => setTimeout(scheduleInfoFetch, 30));
urlInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    clearTimeout(infoTimer);
    if (extractId(urlInput.value)) fetchInfo();
    else showUrlError("That doesn't look like a YouTube video link.");
  }
});

pasteBtn.addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    urlInput.value = text.trim();
    scheduleInfoFetch();
  } catch {
    toast("Clipboard access blocked — paste with Ctrl/Cmd + V.", "err");
    urlInput.focus();
  }
});

convertBtn.addEventListener("click", convert);

/* ---------------- utils ---------------- */
function formatBytes(n) {
  if (!n) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toLocaleString(undefined, { maximumFractionDigits: 1 })} ${units[i]}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

/* ---------------- boot ---------------- */
urlInput.focus();
