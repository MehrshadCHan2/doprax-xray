// Turn timed words into readable subtitle cues (Netflix-style rules).
import { CLAUSE_END, CONJUNCTIONS, SENTENCE_END, core, tidyLine } from "./text.js";

export const DEFAULT_STYLE = Object.freeze({
  maxLineChars: 42,   // characters per line
  maxLines: 2,        // lines per cue
  maxDuration: 6.0,   // seconds a cue may stay on screen
  minDuration: 1.0,   // shortest time a cue is shown
  pauseSplit: 0.6,    // a silence this long always starts a new cue
  minGap: 0.08,       // space between two cues (≈2 frames)
  linger: 0.25,       // keep text up a little after the last word
  sentenceMinChars: 12, // end a cue at a sentence end once it has this much text
});

const style = (s) => ({ ...DEFAULT_STYLE, ...s, maxChars: (s?.maxLineChars ?? 42) * (s?.maxLines ?? 2) });
const length = (words) => words.map((w) => w.text).join(" ").length;
const lastChar = (s) => s.slice(-1);

/** @typedef {{start: number, end: number, lines: string[]}} Cue */
export const cueText = (c) => c.lines.join(" ");

/** How good it is to end a cue after words[k-1] (and start the next at words[k]). */
function breakScore(words, k) {
  const lastText = words[k - 1].text;
  let score = 0;
  if (SENTENCE_END.has(lastChar(lastText))) score += 3;
  else if (CLAUSE_END.has(lastChar(lastText))) score += 2;
  if (k < words.length) {
    if (CONJUNCTIONS.has(core(words[k].text))) score += 1.5;
    const gap = words[k].start - words[k - 1].end;
    score += Math.min(Math.max(gap, 0) / 0.2, 2.0);
  }
  return score;
}

/** Index k so that words[:k] becomes a cue. words[:k] always fits the limits. */
function bestBreak(words, st) {
  const total = length(words);
  let bestK = words.length, best = -1;
  for (let k = 1; k <= words.length; k++) {
    const head = words.slice(0, k);
    if (length(head) > st.maxChars || head.at(-1).end - head[0].start > st.maxDuration) break;
    if (k < words.length && length(head) < 0.35 * total) continue; // avoid a tiny orphan cue
    const score = breakScore(words, k) + k / (10 * words.length);
    if (score >= best) { best = score; bestK = k; }
  }
  return Math.max(bestK, 1);
}

export function groupWords(words, s) {
  const st = style(s);
  const groups = [];
  let cur = [];
  for (const w of words) {
    if (cur.length) {
      const gap = w.start - cur.at(-1).end;
      const tooLong = length([...cur, w]) > st.maxChars;
      const tooSlow = w.end - cur[0].start > st.maxDuration;
      if (gap >= st.pauseSplit) {
        groups.push(cur); cur = [];
      } else if (tooLong || tooSlow) {
        const k = bestBreak([...cur, w], st);
        if (k >= cur.length) { groups.push(cur); cur = []; }
        else { groups.push(cur.slice(0, k)); cur = cur.slice(k); }
      }
    }
    cur.push(w);
    if (SENTENCE_END.has(lastChar(w.text)) && length(cur) >= st.sentenceMinChars) {
      groups.push(cur); cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** Split a cue's text into at most `maxLines` balanced lines. */
export function wrap(text, s) {
  const st = style(s);
  text = tidyLine(text);
  if (text.length <= st.maxLineChars || st.maxLines < 2) return [text];
  const words = text.split(" ");
  let best = [text], bestCost = Infinity;
  for (let k = 1; k < words.length; k++) {
    const a = words.slice(0, k).join(" "), b = words.slice(k).join(" ");
    let cost = Math.abs(a.length - b.length);
    if (a.length > st.maxLineChars || b.length > st.maxLineChars) cost += 1000 + 10 * Math.max(a.length, b.length);
    if (a.length > b.length) cost += 2; // bottom-heavy reads more naturally
    const end = lastChar(words[k - 1]);
    if (SENTENCE_END.has(end) || CLAUSE_END.has(end)) cost -= 8;
    else if (CONJUNCTIONS.has(core(words[k]))) cost -= 4;
    if (cost < bestCost) { best = [a, b]; bestCost = cost; }
  }
  return best;
}

/** Give every cue enough screen time without overlapping its neighbours. */
export function fixTiming(cues, s, duration = null) {
  const st = style(s);
  cues.forEach((cue, i) => {
    const nxt = i + 1 < cues.length ? cues[i + 1].start - st.minGap : (duration ?? Infinity);
    const want = Math.max(cue.end + st.linger, cue.start + st.minDuration);
    cue.end = Math.max(cue.end, Math.min(want, nxt));
    if (cue.end > nxt) {
      cue.end = Math.max(nxt, cue.start + 0.3);
      if (i + 1 < cues.length && cues[i + 1].start < cue.end + st.minGap) cues[i + 1].start = cue.end + st.minGap;
    }
    if (duration) cue.end = Math.min(cue.end, duration);
    cue.start = Math.max(cue.start, 0);
    cue.end = Math.max(cue.end, cue.start + 0.1);
  });
  return cues;
}

export function buildCues(words, s, duration = null) {
  const cues = groupWords(words, s).map((g) => ({
    start: g[0].start, end: g.at(-1).end, lines: wrap(g.map((w) => w.text).join(" "), s),
  }));
  return fixTiming(cues, s, duration);
}

export function rewrap(cues, s) {
  return cues.filter((c) => cueText(c).trim()).map((c) => ({ start: c.start, end: c.end, lines: wrap(cueText(c), s) }));
}
