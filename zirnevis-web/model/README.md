---
base_model: givia/whisper-large-v3-turbo-persian
library_name: transformers.js
license: cc-by-4.0
language:
  - fa
pipeline_tag: automatic-speech-recognition
tags:
  - whisper
  - persian
  - farsi
  - onnx
  - transformers.js
  - timestamped
---

# Whisper large-v3-turbo Persian — ONNX for the browser (word timestamps)

Browser-ready ONNX build of [`givia/whisper-large-v3-turbo-persian`](https://huggingface.co/givia/whisper-large-v3-turbo-persian)
(CC-BY-4.0), a Persian fine-tune of OpenAI's `whisper-large-v3-turbo`. All credit for the model goes to its authors;
this repository only changes the file format.

**What changed relative to the source model**

- Exported to ONNX with `output_attentions=True`, so the decoder exposes the `cross_attentions.*` outputs that
  Transformers.js needs for word-level timestamps.
- Quantized: `q4f16` (WebGPU with `shader-f16`), `q4` (WebGPU without f16) and `q8` (WebAssembly).
  Weights are otherwise unchanged.
- Tokenizer files come from `openai/whisper-large-v3-turbo` (same vocabulary; the source's files use a newer format).

Used by the [Zirnevis](https://huggingface.co/spaces/mehrshadjavid/zirnevis) Persian subtitle app.

```js
import { WhisperForConditionalGeneration } from "@huggingface/transformers";
const model = await WhisperForConditionalGeneration.from_pretrained(
  "mehrshadjavid/whisper-large-v3-turbo-persian-ONNX",
  { device: "webgpu", dtype: { encoder_model: "q4f16", decoder_model_merged: "q4f16" } },
);
```
