// Page logic: pick a file, run the model in a worker, show/edit/download cues.
import { cleanWords, faNum, normalizeChars } from "./lib/text.js";
import { buildCues, cueText, rewrap } from "./lib/segment.js";
import { formatTs, parseTs, toSrt, toText, toVtt } from "./lib/subtitles.js";
import { SAMPLE_RATE } from "./lib/speech.js";

const $ = (id) => document.getElementById(id);
const ui = {
  drop: $("drop"), file: $("file"), dropText: $("drop-text"), go: $("go"), status: $("status"),
  bar: $("bar"), warn: $("warn"), result: $("step-result"), player: $("player"),
  tbody: document.querySelector("#cues tbody"), chars: $("chars"), charsOut: $("chars-out"), bom: $("bom"),
  srt: $("dl-srt"), vtt: $("dl-vtt"), txt: $("dl-txt"),
};

const state = { file: null, words: [], cues: [], edited: false, worker: null, ready: false, busy: false, urls: [] };

const settings = () => ({
  digits: document.querySelector("input[name=digits]:checked").value,
  style: { maxLineChars: Number(ui.chars.value) },
  bom: ui.bom.checked,
});

function say(html, kind = "") {
  ui.status.className = "status" + (kind ? ` notice ${kind}` : "");
  ui.status.innerHTML = html;
}
function progress(fraction) {
  ui.bar.hidden = fraction == null;
  ui.bar.firstElementChild.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}
const mb = (bytes) => faNum(Math.round(bytes / 1e6));

// --- device check -----------------------------------------------------------
(async () => {
  let gpu = false;
  try { gpu = !!(await navigator.gpu?.requestAdapter()); } catch {}
  const phone = /Android|iPhone|iPad/i.test(navigator.userAgent);
  const notes = [];
  if (!gpu) notes.push("مرورگر شما از <b>WebGPU</b> پشتیبانی نمی‌کند، پس ساخت زیرنویس کند خواهد بود. برای سرعت خوب از <b>Chrome یا Edge جدید روی کامپیوتر</b> استفاده کنید.");
  if (phone) notes.push("بار اول حدود ۶۰۰ مگابایت مدل دانلود می‌شود؛ بهتر است با وای‌فای باشید.");
  if (notes.length) { ui.warn.innerHTML = notes.join("<br>"); ui.warn.hidden = false; }
})();

// --- choosing a file --------------------------------------------------------
function choose(file) {
  if (!file) return;
  if (!/^(audio|video)\//.test(file.type) && !/\.(mkv|m4a|opus|mp3|wav|ogg|flac|aac|mp4|mov|webm)$/i.test(file.name)) {
    say("این فایل ویدیو یا صدا نیست.", "error");
    return;
  }
  state.file = file;
  ui.drop.classList.add("has-file");
  ui.dropText.textContent = `${file.name} (${mb(file.size)} مگابایت)`;
  ui.go.disabled = state.busy;
  say("");
}
ui.file.addEventListener("change", () => choose(ui.file.files[0]));
ui.drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); ui.file.click(); } });
for (const ev of ["dragenter", "dragover"]) ui.drop.addEventListener(ev, (e) => { e.preventDefault(); ui.drop.classList.add("over"); });
for (const ev of ["dragleave", "drop"]) ui.drop.addEventListener(ev, () => ui.drop.classList.remove("over"));
ui.drop.addEventListener("drop", (e) => { e.preventDefault(); choose(e.dataTransfer.files[0]); });

// --- audio ------------------------------------------------------------------
async function decodeAudio(file) {
  const data = await file.arrayBuffer();
  const ctx = new OfflineAudioContext({ numberOfChannels: 1, length: 1, sampleRate: SAMPLE_RATE });
  let buf;
  try {
    buf = await ctx.decodeAudioData(data);
  } catch {
    throw new Error("مرورگر نتوانست صدای این فایل را بخواند. فایل را به MP4 یا MP3 تبدیل کنید و دوباره امتحان کنید.");
  }
  if (buf.numberOfChannels === 1) return buf.getChannelData(0);
  const mono = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / buf.numberOfChannels;
  }
  return mono;
}

// --- worker -----------------------------------------------------------------
function startWorker(device) {
  state.worker?.terminate();
  state.ready = false;
  state.worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
  const files = new Map();
  return new Promise((resolve, reject) => {
    state.worker.onmessage = ({ data }) => {
      if (data.type === "download" && data.status === "progress" && data.total) {
        files.set(data.file, data);
        const loaded = [...files.values()].reduce((s, f) => s + f.loaded, 0);
        const total = [...files.values()].reduce((s, f) => s + f.total, 0);
        say(`در حال دانلود مدل (فقط بار اول، بعد ذخیره می‌شود): ${mb(loaded)} از ${mb(total)} مگابایت…`);
        progress(loaded / total);
      } else if (data.type === "download" && data.status === "ready") {
        say("در حال آماده کردن مدل…");
      } else if (data.type === "ready") {
        state.ready = true;
        state.device = data.device;
        resolve();
      } else if (data.type === "error" && !state.ready) {
        reject(new Error(data.message));
      } else state.onMessage?.(data); // after loading, errors go to the running job
    };
    state.worker.onerror = (e) => {
      const err = new Error(e.message || "worker failed");
      if (!state.ready) reject(err);
      else state.onMessage?.({ type: "error", message: err.message });
    };
    const localModel = new URLSearchParams(location.search).get("localModel");
    state.worker.postMessage({ type: "load", device, localModel });
  });
}

async function ensureModel() {
  if (state.ready) return;
  // ?device=wasm forces the CPU path (for testing, or a GPU that misbehaves).
  const forced = new URLSearchParams(location.search).get("device");
  try {
    await startWorker(forced === "wasm" ? "wasm" : undefined);
  } catch (err) {
    // Some GPUs fail to run the model; the CPU path always works.
    console.warn("WebGPU failed, falling back to WebAssembly:", err);
    say("کارت گرافیک پاسخ نداد؛ با پردازنده ادامه می‌دهیم (کندتر)…");
    await startWorker("wasm");
  }
}

function runModel(audio) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const seconds = audio.length / SAMPLE_RATE;
    state.onMessage = (data) => {
      if (data.type === "words") {
        state.words.push(...data.words);
        refreshFromWords();
        const elapsed = (performance.now() - started) / 1000;
        const left = data.progress > 0.05 ? Math.round((elapsed / data.progress) * (1 - data.progress)) : null;
        say(`در حال شنیدن و نوشتن… ${faNum(Math.round(data.progress * 100))}٪` + (left != null ? ` (حدود ${faNum(left)} ثانیه مانده)` : ""));
        progress(data.progress);
      } else if (data.type === "done") {
        resolve((performance.now() - started) / 1000);
      } else if (data.type === "error") reject(new Error(data.message));
    };
    say(`در حال شنیدن و نوشتن… (${faNum(Math.round(seconds / 60 * 10) / 10)} دقیقه صدا)`);
    progress(0);
    state.worker.postMessage({ type: "transcribe", audio }, [audio.buffer]);
  });
}

ui.go.addEventListener("click", async () => {
  if (!state.file || state.busy) return;
  state.busy = true;
  ui.go.disabled = true;
  state.words = [];
  state.edited = false;
  try {
    say("در حال خواندن صدای فایل…");
    const audio = await decodeAudio(state.file);
    if (audio.length < SAMPLE_RATE / 2) throw new Error("این فایل صدای کافی ندارد.");
    showPlayer();
    await ensureModel();
    let took;
    try {
      took = await runModel(audio.slice());
    } catch (err) {
      if (!state.device?.startsWith("webgpu")) throw err;
      console.warn("WebGPU run failed, retrying on WebAssembly:", err);
      say("کارت گرافیک پاسخ نداد؛ با پردازنده ادامه می‌دهیم (کندتر)…");
      state.words = [];
      await startWorker("wasm");
      took = await runModel(audio);
    }
    progress(null);
    if (!state.cues.length) say("گفتار فارسی در این فایل پیدا نشد.", "warn");
    else say(`✅ آماده است: ${faNum(state.cues.length)} زیرنویس در ${faNum(Math.round(took))} ثانیه. حالا می‌توانید ببینید، اصلاح کنید و دانلود کنید.`);
  } catch (err) {
    progress(null);
    say(`⚠️ ${err.message}`, "error");
  } finally {
    state.busy = false;
    ui.go.disabled = !state.file;
  }
});

// --- results ----------------------------------------------------------------
function showPlayer() {
  state.urls.forEach(URL.revokeObjectURL);
  state.urls = [];
  const url = URL.createObjectURL(state.file);
  state.urls.push(url);
  ui.player.src = url;
  ui.result.hidden = false;
  state.cues = [];
  renderTable();
  refreshOutputs();
}

function refreshFromWords() {
  const { digits, style } = settings();
  const words = cleanWords(state.words, digits);
  state.cues = buildCues(words, style).map((c) => ({ start: c.start, end: c.end, text: cueText(c) }));
  renderTable();
  refreshOutputs();
}

function finalCues() {
  const { style } = settings();
  const valid = state.cues.filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start);
  return rewrap(valid.map((c) => ({ start: c.start, end: c.end, lines: [c.text] })).sort((a, b) => a.start - b.start), style);
}

function blobUrl(text, type, bom) {
  const url = URL.createObjectURL(new Blob([bom ? "﻿" : "", text], { type }));
  state.urls.push(url);
  return url;
}

let refreshTimer = null;
function refreshOutputs() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    const cues = finalCues();
    const { bom } = settings();
    const name = (state.file?.name ?? "subtitle").replace(/\.[^.]+$/, "");
    ui.srt.href = blobUrl(toSrt(cues), "application/x-subrip", bom);
    ui.srt.download = `${name}.fa.srt`;
    ui.vtt.href = blobUrl(toVtt(cues), "text/vtt", false);
    ui.vtt.download = `${name}.fa.vtt`;
    ui.txt.href = blobUrl(toText(cues), "text/plain", bom);
    ui.txt.download = `${name}.fa.txt`;
    for (const t of ui.player.querySelectorAll("track")) t.remove();
    const track = document.createElement("track");
    Object.assign(track, { kind: "subtitles", srclang: "fa", label: "فارسی", default: true, src: blobUrl(toVtt(cues), "text/vtt", false) });
    ui.player.append(track);
    track.track.mode = "showing";
  }, 150);
}

function renderTable() {
  ui.tbody.replaceChildren(...state.cues.map((cue, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td class="num">${faNum(i + 1)}</td>
      <td class="time"><input aria-label="شروع" value="${formatTs(cue.start)}"><input aria-label="پایان" value="${formatTs(cue.end)}"><button class="seek" type="button">▶ پخش</button></td>
      <td><textarea rows="1" aria-label="متن"></textarea></td>`;
    const [startIn, endIn] = tr.querySelectorAll("input");
    const text = tr.querySelector("textarea");
    text.value = cue.text;
    const onTime = (input, key) => {
      const v = parseTs(input.value);
      input.classList.toggle("bad", !Number.isFinite(v));
      if (Number.isFinite(v)) cue[key] = v;
      state.edited = true;
      refreshOutputs();
    };
    startIn.addEventListener("input", () => onTime(startIn, "start"));
    endIn.addEventListener("input", () => onTime(endIn, "end"));
    text.addEventListener("input", () => { cue.text = text.value; state.edited = true; refreshOutputs(); });
    tr.querySelector(".seek").addEventListener("click", () => { ui.player.currentTime = cue.start; ui.player.play(); });
    return tr;
  }));
}

ui.player.addEventListener("timeupdate", () => {
  const t = ui.player.currentTime;
  [...ui.tbody.children].forEach((tr, i) => {
    const c = state.cues[i];
    tr.classList.toggle("playing", !!c && t >= c.start && t <= c.end);
  });
});

// --- settings ---------------------------------------------------------------
ui.chars.addEventListener("input", () => { ui.charsOut.textContent = faNum(ui.chars.value); refreshOutputs(); });
ui.bom.addEventListener("change", refreshOutputs);
for (const r of document.querySelectorAll("input[name=digits]")) {
  r.addEventListener("change", () => {
    if (!state.edited && state.words.length) return refreshFromWords();
    const { digits } = settings();
    state.cues.forEach((c) => { c.text = normalizeChars(c.text, digits); });
    renderTable();
    refreshOutputs();
  });
}
