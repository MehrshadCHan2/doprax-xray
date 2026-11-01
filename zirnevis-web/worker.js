// Runs the Persian speech model in the browser (WebGPU, or WebAssembly as a
// fallback) so the page never freezes. Audio never leaves the device.
import {
  AutoModel,
  AutoProcessor,
  AutoTokenizer,
  Tensor,
  WhisperForConditionalGeneration,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0";

import { sileroRunner, transcribe } from "./lib/transcribe.js";

const MODEL_ID = "mehrshadjavid/whisper-large-v3-turbo-persian-ONNX";
const VAD_ID = "onnx-community/silero-vad"; // 2 MB speech detector

// Smallest files that keep accuracy: 4-bit weights on the GPU (16-bit math
// where the GPU supports it), 8-bit on the CPU.
const DTYPES = {
  "webgpu-f16": { encoder_model: "q4f16", decoder_model_merged: "q4f16" },
  webgpu: { encoder_model: "q4", decoder_model_merged: "q4" },
  wasm: { encoder_model: "q8", decoder_model_merged: "q8" },
};

env.allowLocalModels = false;

let parts, device;

// Where the model is kept between visits.
// Transformers.js normally saves downloads in Cache Storage, but browsers refuse one entry as big as the 370 MB
// encoder (Chrome: "Failed to execute 'put' on 'Cache': Unexpected internal error"; some also cap a single
// stored file at ~250-400 MB), so that file was downloaded again on every visit. Files now go to the Origin Private
// File System (OPFS) in 64 MB parts plus a small index written last (so a half-saved file never counts). Reading
// joins the parts as one disk-backed Blob: no second copy in memory. Cache Storage stays as the fallback (copies
// saved by the old version, browsers without OPFS).
const STORE_DIR = "jcut-models";
const PART = 64 * 1024 * 1024;
const keyOf = (req) => (typeof req === "string" ? req : req.url);
async function fileName(url) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}
let dirPromise;
function storeDir() {
  dirPromise ??= (async () => {
    if (!navigator.storage?.getDirectory) return null;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(STORE_DIR, { create: true });
    // Writing needs createWritable (Chrome, Edge, Firefox; Safari 18+). Without it, use Cache Storage only.
    const probe = await dir.getFileHandle(".probe", { create: true });
    if (typeof probe.createWritable !== "function") return null;
    return dir;
  })().catch(() => null);
  return dirPromise;
}
async function readSaved(dir, name) {
  const index = JSON.parse(await (await (await dir.getFileHandle(`${name}.json`)).getFile()).text());
  const parts = [];
  for (let i = 0; i < index.parts; i++) parts.push(await (await dir.getFileHandle(`${name}.${i}`)).getFile());
  const blob = new Blob(parts);
  if (blob.size !== index.size) throw new Error("incomplete");
  return blob;
}
async function writeSaved(dir, name, body) {
  try { await dir.removeEntry(`${name}.json`); } catch {}
  const reader = body.getReader();
  let part = 0, inPart = 0, size = 0, writable = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let chunk = value;
    while (chunk.length) {
      if (!writable) writable = await (await dir.getFileHandle(`${name}.${part}`, { create: true })).createWritable();
      const take = Math.min(chunk.length, PART - inPart);
      await writable.write(chunk.subarray(0, take));
      inPart += take; size += take; chunk = chunk.subarray(take);
      if (inPart === PART) { await writable.close(); writable = null; part++; inPart = 0; }
    }
  }
  if (writable) { await writable.close(); part++; }
  const index = await (await dir.getFileHandle(`${name}.json`, { create: true })).createWritable();
  await index.write(JSON.stringify({ parts: part, size }));
  await index.close();
}
const modelStore = {
  async match(req) {
    const url = keyOf(req);
    const dir = await storeDir();
    if (dir) {
      try {
        const blob = await readSaved(dir, await fileName(url));
        return new Response(blob, { headers: { "content-length": String(blob.size) } });
      } catch {}
    }
    try {
      return (await (await caches.open(env.cacheKey)).match(url)) || undefined;
    } catch {
      return undefined;
    }
  },
  async put(req, response) {
    const url = keyOf(req);
    const dir = await storeDir();
    if (dir) {
      try {
        await writeSaved(dir, await fileName(url), response.clone().body);
        return;
      } catch (err) {
        console.warn("Saving to OPFS failed, trying Cache Storage:", err?.name || err);
      }
    }
    try {
      await (await caches.open(env.cacheKey)).put(url, response);
    } catch (err) {
      console.warn("Could not save", url, err?.name || err);
    }
  },
};
env.useCustomCache = true;
env.customCache = modelStore;

// Both model files for this device saved? Then this visit reads them from disk (a few seconds, no download).
const SUFFIX = { q4f16: "_q4f16", q4: "_q4", q8: "_quantized" };
async function modelSaved(id, dtypes) {
  for (const [name, dt] of Object.entries(dtypes)) {
    const url = `https://huggingface.co/${id}/resolve/main/onnx/${name}${SUFFIX[dt]}.onnx`;
    const r = await modelStore.match(url);
    if (!r) return false;
    r.body?.cancel?.();
  }
  return true;
}

async function pickDevice() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) return adapter.features.has("shader-f16") ? "webgpu-f16" : "webgpu";
  } catch {}
  return "wasm";
}

async function load(forced, localModel) {
  device = forced || (await pickDevice());
  let id = MODEL_ID;
  if (localModel) {
    // Testing only: ?localModel=<folder under ./models/> loads files served next to the page.
    env.allowLocalModels = true;
    env.allowRemoteModels = false;
    env.localModelPath = "/models/";
    id = localModel;
  }
  const saved = !localModel && (await modelSaved(id, DTYPES[device]));
  postMessage({ type: "cache", saved });
  const progress_callback = (p) => postMessage({ type: "download", ...p });
  const [tokenizer, processor, model, vad] = await Promise.all([
    AutoTokenizer.from_pretrained(id, { progress_callback }),
    AutoProcessor.from_pretrained(id, { progress_callback }),
    WhisperForConditionalGeneration.from_pretrained(id, {
      dtype: DTYPES[device], device: device.startsWith("webgpu") ? "webgpu" : "wasm", progress_callback,
    }),
    // Tiny and called thousands of times: always on the CPU.
    AutoModel.from_pretrained(localModel ? "silero-vad" : VAD_ID, {
      config: { model_type: "custom" }, dtype: "fp32", device: "wasm", progress_callback,
    }),
  ]);
  parts = { model, processor, tokenizer, makeVad: () => sileroRunner(vad, Tensor) };
  // After a first download: did the browser really keep it? (Private windows and full disks refuse.)
  const keptNow = saved || localModel ? true : await modelSaved(id, DTYPES[device]);
  postMessage({ type: "ready", device, saved, kept: keptNow });
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "load") await load(data.device, data.localModel);
    else if (data.type === "transcribe") {
      await transcribe(parts, data.audio, (words, progress) => postMessage({ type: "words", words, progress }));
      postMessage({ type: "done" });
    }
  } catch (err) {
    postMessage({ type: "error", message: String(err?.message || err), device });
  }
};
