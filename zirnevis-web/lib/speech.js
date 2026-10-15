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

/**
 * Even out loud and quiet parts (like ffmpeg's dynaudnorm) so a speech
 * detector also hears soft speech. Only used for detection, never for the
 * recognizer itself.
 */
export function levelAudio(audio, { frame = 0.15, maxGain = 10, radius = 7 } = {}) {
  const n = Math.max(1, Math.round(frame * SAMPLE_RATE));
  const frames = Math.ceil(audio.length / n);
  const gains = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let peak = 0;
    for (let i = f * n; i < Math.min(audio.length, (f + 1) * n); i++) peak = Math.max(peak, Math.abs(audio[i]));
    gains[f] = Math.min(maxGain, 0.95 / Math.max(peak, 1e-6));
  }
  // Minimum filter (never over-amplify next to a loud frame), then Gaussian smoothing.
  const minF = gains.map((_, f) => {
    let m = Infinity;
    for (let k = Math.max(0, f - radius); k <= Math.min(frames - 1, f + radius); k++) m = Math.min(m, gains[k]);
    return m;
  });
  const sigma = radius / 2;
  const smooth = minF.map((_, f) => {
    let sum = 0, wsum = 0;
    for (let k = Math.max(0, f - radius); k <= Math.min(frames - 1, f + radius); k++) {
      const w = Math.exp(-((k - f) ** 2) / (2 * sigma * sigma));
      sum += w * minF[k]; wsum += w;
    }
    return sum / wsum;
  });
  const out = new Float32Array(audio.length);
  for (let i = 0; i < audio.length; i++) {
    const pos = i / n - 0.5, f = Math.max(0, Math.floor(pos)), t = Math.min(1, Math.max(0, pos - f));
    const g = smooth[f] * (1 - t) + smooth[Math.min(frames - 1, f + 1)] * t;
    out[i] = Math.max(-1, Math.min(1, audio[i] * g));
  }
  return out;
}

export const SILERO_WINDOW = 512;

/** Speech probability for every 32 ms window, from a Silero VAD `runWindow(Float32Array) → p`. */
export async function speechProbs(audio, runWindow) {
  const probs = [];
  for (let i = 0; i < audio.length; i += SILERO_WINDOW) {
    const w = new Float32Array(SILERO_WINDOW);
    w.set(audio.subarray(i, i + SILERO_WINDOW));
    probs.push(await runWindow(w));
  }
  return probs;
}

/** Silero probabilities → speech regions, with the same rules as faster-whisper. */
export function regionsFromProbs(probs, length, {
  threshold = 0.5, minSilence = 0.5, pad = 0.4, minSpeech = 0.25,
} = {}) {
  const W = SILERO_WINDOW, neg = threshold - 0.15;
  const minSilenceS = minSilence * SAMPLE_RATE, minSpeechS = minSpeech * SAMPLE_RATE, padS = pad * SAMPLE_RATE;
  const speeches = [];
  let start = -1, tempEnd = 0;
  probs.forEach((p, i) => {
    if (p >= threshold && tempEnd) tempEnd = 0;
    if (p >= threshold && start < 0) { start = W * i; return; }
    if (p < neg && start >= 0) {
      if (!tempEnd) tempEnd = W * i;
      if (W * i - tempEnd < minSilenceS) return;
      if (tempEnd - start > minSpeechS) speeches.push([start, tempEnd]);
      start = -1; tempEnd = 0;
    }
  });
  if (start >= 0 && length - start > minSpeechS) speeches.push([start, length]);
  speeches.forEach((s, i) => {
    if (i === 0) s[0] = Math.max(0, s[0] - padS);
    const next = speeches[i + 1];
    if (next) {
      const gap = next[0] - s[1];
      if (gap < 2 * padS) { s[1] += Math.floor(gap / 2); next[0] = Math.max(0, next[0] - Math.floor(gap / 2)); }
      else { s[1] = Math.min(length, s[1] + padS); next[0] = Math.max(0, next[0] - padS); }
    } else s[1] = Math.min(length, s[1] + padS);
  });
  return speeches;
}

/**
 * Speech grouped into pieces of at most `maxLen` seconds, cut at pauses.
 * `regions` come from Silero when available; otherwise a loudness detector is used.
 */
export function planPieces(audio, maxLen = MAX_PIECE, maxGap = 2.0, regions = null) {
  regions = (regions ?? speechRegions(audio)).flatMap((r) => splitLong(audio, r, maxLen));
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
