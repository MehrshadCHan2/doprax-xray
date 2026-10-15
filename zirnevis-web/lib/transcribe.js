// Audio → timed words with a loaded Whisper model. Shared by the browser
// worker and the Node.js test harness, so both run the same code.
import { SAMPLE_RATE, dropPiece, fixWords, levelAudio, planPieces, regionsFromProbs, speechProbs } from "./speech.js";

const FIRST_SPECIAL = 50257; // <|endoftext|>; every id from here on is a control token
const MAX_NEW_TOKENS = 400;  // Whisper's limit is 448 including the start tokens

const startsWordCache = new Map();
function startsWord(tokenizer, id) {
  if (!startsWordCache.has(id)) startsWordCache.set(id, tokenizer.decode([id]).startsWith(" "));
  return startsWordCache.get(id);
}

/** Group BPE tokens into words; a token that starts with a space starts a word. */
export function tokensToWords(tokenizer, ids, times, offset = 0) {
  const words = [];
  let cur = null;
  const flush = (endTime) => {
    if (!cur) return;
    const text = tokenizer.decode(cur.ids, { skip_special_tokens: true }).trim();
    if (text) words.push({ start: cur.start + offset, end: endTime + offset, text });
    cur = null;
  };
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    if (id >= FIRST_SPECIAL) { flush(times[i]); continue; }
    if (!cur || startsWord(tokenizer, id)) {
      flush(times[i]);
      cur = { ids: [], start: times[i] };
    }
    cur.ids.push(id);
  }
  flush(times.at(-1) ?? 0);
  return words;
}

/** Words for one piece of speech (≤ 30 s), times relative to `offset`. */
export async function transcribePiece({ model, processor, tokenizer }, audio, offset = 0) {
  const inputs = await processor(audio);
  const out = await model.generate({
    ...inputs,
    language: "fa",
    task: "transcribe",
    // The Persian fine-tune works best decoding plain text; word times come
    // from the attention alignment instead of timestamp tokens.
    return_timestamps: false,
    return_token_timestamps: true,
    num_frames: Math.floor(audio.length / 160),
    max_new_tokens: MAX_NEW_TOKENS,
  });
  const seq = out.sequences.tolist()[0].map(Number);
  const times = Array.from(out.token_timestamps.tolist()[0], Number);
  let first = 0; // skip <|startoftranscript|><|fa|><|transcribe|><|notimestamps|>
  while (first < seq.length && seq[first] >= FIRST_SPECIAL) first++;
  const words = tokensToWords(tokenizer, seq.slice(first), times.slice(first), offset);
  const text = words.map((w) => w.text).join(" ");
  return dropPiece(text, audio.length / SAMPLE_RATE) ? [] : fixWords(words);
}

/**
 * A Silero VAD window runner (`Float32Array(512) → speech probability`) for a
 * model loaded with Transformers.js. Each runner keeps its own recurrent state.
 */
export function sileroRunner(model, Tensor) {
  let state = new Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  const sr = new Tensor("int64", [16000n], []);
  let context = new Float32Array(64); // Silero v5 expects the previous 64 samples in front
  return async (window) => {
    const input = new Float32Array(64 + window.length);
    input.set(context);
    input.set(window, 64);
    context = window.slice(-64);
    const out = await model({ input: new Tensor("float32", input, [1, input.length]), sr, state });
    state = out.stateN;
    return out.output.data[0];
  };
}

/** Where people speak: Silero VAD (`parts.makeVad()`) on a volume-levelled copy, else loudness. */
export async function findSpeech(parts, audio) {
  if (!parts.makeVad) return planPieces(audio);
  const probs = await speechProbs(levelAudio(audio), parts.makeVad());
  return planPieces(audio, undefined, undefined, regionsFromProbs(probs, audio.length));
}

/** Words for a whole recording; `onPiece(words, fractionDone)` after each piece. */
export async function transcribe(parts, audio, onPiece = () => {}) {
  const pieces = await findSpeech(parts, audio);
  const total = pieces.reduce((s, [a, b]) => s + b - a, 0) || 1;
  let done = 0;
  const all = [];
  for (const [a, b] of pieces) {
    const words = await transcribePiece(parts, audio.subarray(a, b), a / SAMPLE_RATE);
    done += b - a;
    all.push(...words);
    await onPiece(words, done / total);
  }
  return all;
}
