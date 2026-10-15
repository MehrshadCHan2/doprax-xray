// Finding speech in the audio and cleaning the model's raw word timings.
import { isJunk, isStutter, looksLikeCredit } from "./text.js";

export const SAMPLE_RATE = 16000;
export const MAX_PIECE = 24; // seconds decoded at once (the model card suggests ≤ 26)
const FRAME = 480; // 30 ms

/** Loudness of each 30 ms frame in dB. */
function frameDb(audio) {
  const n = Math.floor(audio.length / FRAME);
  const db = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += audio[i] * audio[i];
    db[f] = 10 * Math.log10(sum / FRAME + 1e-10);
  }
  return db;
}

function percentile(values, p) {
  const sorted = Float32Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? -100;
}

/**
 * Speech regions as [startSample, endSample]. The threshold follows the
 * recording's own noise floor, so quiet speech in a quiet file is still found.
 */
export function speechRegions(audio, { minSilence = 0.5, pad = 0.3, minSpeech = 0.15 } = {}) {
  const db = frameDb(audio);
  if (!db.length) return [];
  const floor = percentile(db, 0.1);
  const loud = percentile(db, 0.95);
  // Halfway-ish between noise and speech, never below a sane absolute level.
  const threshold = Math.max(floor + Math.min(12, (loud - floor) * 0.35), -65);
  const fps = SAMPLE_RATE / FRAME;
  const regions = [];
  let start = -1, silent = 0;
  for (let f = 0; f <= db.length; f++) {
    const speech = f < db.length && db[f] > threshold;
    if (speech) {
      if (start < 0) start = f;
      silent = 0;
    } else if (start >= 0) {
      silent++;
      if (silent >= minSilence * fps || f === db.length) {
        const end = f - silent + 1;
        if ((end - start) / fps >= minSpeech) regions.push([start, end]);
        start = -1; silent = 0;
      }
    }
  }
  const padF = Math.round(pad * fps);
  return regions.map(([a, b]) => [Math.max(0, (a - padF) * FRAME), Math.min(audio.length, (b + padF) * FRAME)]);
}

/** Cut a region that is too long at its quietest moment. */
function splitLong(audio, [a, b], maxLen) {
  const max = maxLen * SAMPLE_RATE;
  if (b - a <= max) return [[a, b]];
  const db = frameDb(audio.subarray(a, b));
  const lo = Math.floor((0.5 * max) / FRAME), hi = Math.min(db.length - 1, Math.floor(max / FRAME));
  let best = hi, bestDb = Infinity;
  for (let f = lo; f <= hi; f++) {
    const win = (db[f - 1] ?? db[f]) + db[f] + (db[f + 1] ?? db[f]); // 90 ms window
    if (win < bestDb) { bestDb = win; best = f; }
  }
  const cut = a + best * FRAME;
  return [[a, cut], ...splitLong(audio, [cut, b], maxLen)];
}

/** Speech grouped into pieces of at most `maxLen` seconds, cut at pauses. */
export function planPieces(audio, maxLen = MAX_PIECE, maxGap = 2.0) {
  const regions = speechRegions(audio).flatMap((r) => splitLong(audio, r, maxLen));
  const pieces = [];
  for (const [a, b] of regions) {
    const prev = pieces.at(-1);
    if (prev && (b - prev[0]) / SAMPLE_RATE <= maxLen && (a - prev[1]) / SAMPLE_RATE <= maxGap) prev[1] = b;
    else pieces.push([a, b]);
  }
  return pieces;
}

export const maxWordSeconds = (text) => Math.max(1.0, 0.1 * text.length + 0.5);

/** Remove noise fragments and repair words stretched over silence. */
export function fixWords(words) {
  const out = [];
  for (let w of words) {
    if (!w.text || isStutter(w.text)) continue;
    if ((w.prob ?? 1) < 0.05 && w.text.length <= 2) continue;
    const limit = maxWordSeconds(w.text);
    if (w.end - w.start > limit) {
      // The alignment stretches a word over the pause next to it. After a
      // pause (or at the start) the start is wrong; otherwise the end is.
      const afterPause = !out.length || w.start - out.at(-1).end > 0.3;
      w = afterPause ? { ...w, start: w.end - limit } : { ...w, end: w.start + limit };
    }
    out.push(w);
  }
  return out;
}

/** Skip a piece's text when it is invented (music tag, decoding loop, credits). */
export function dropPiece(text, seconds) {
  text = text.trim();
  if (isJunk(text)) return true;
  if (text.length >= 10 && text.length / Math.max(seconds, 0.01) > 30) return true;
  return looksLikeCredit(text) && seconds < 4;
}
