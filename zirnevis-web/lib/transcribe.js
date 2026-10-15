// Audio → timed words with a loaded Whisper model. Shared by the browser
// worker and the Node.js test harness, so both run the same code.
import { SAMPLE_RATE, dropPiece, fixWords, planPieces } from "./speech.js";

const FIRST_SPECIAL = 50257; // <|endoftext|>; every id from here on is a control token
const MAX_NEW_TOKENS = 400;  // Whisper's limit is 448 including the start tokens

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
    const piece = tokenizer.model.vocab[id] ?? "";
    if (!cur || piece.startsWith("Ġ")) {
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

/** Words for a whole recording; `onPiece(words, fractionDone)` after each piece. */
export async function transcribe(parts, audio, onPiece = () => {}) {
  const pieces = planPieces(audio);
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
