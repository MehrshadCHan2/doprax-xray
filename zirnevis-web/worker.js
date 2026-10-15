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

// Smallest files that keep accuracy: 4-bit weights on the GPU, 8-bit on the CPU.
const DTYPES = {
  webgpu: { encoder_model: "q4f16", decoder_model_merged: "q4f16" },
  wasm: { encoder_model: "q8", decoder_model_merged: "q8" },
};

env.allowLocalModels = false;

let parts, device;

async function pickDevice() {
  try {
    if (await navigator.gpu?.requestAdapter()) return "webgpu";
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
  const progress_callback = (p) => postMessage({ type: "download", ...p });
  const [tokenizer, processor, model, vad] = await Promise.all([
    AutoTokenizer.from_pretrained(id, { progress_callback }),
    AutoProcessor.from_pretrained(id, { progress_callback }),
    WhisperForConditionalGeneration.from_pretrained(id, { dtype: DTYPES[device], device, progress_callback }),
    // Tiny and called thousands of times: always on the CPU.
    AutoModel.from_pretrained(localModel ? "silero-vad" : VAD_ID, {
      config: { model_type: "custom" }, dtype: "fp32", device: "wasm", progress_callback,
    }),
  ]);
  parts = { model, processor, tokenizer, makeVad: () => sileroRunner(vad, Tensor) };
  postMessage({ type: "ready", device });
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
