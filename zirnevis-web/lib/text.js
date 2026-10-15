// Persian text cleanup that keeps word timings intact.
// Everything works word by word, so every word keeps its own start/end time.
// Joining two words (e.g. «می» + «خواهم») merges their timings as well.

export const ZWNJ = "‌"; // نیم‌فاصله

const FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹";
const EN_DIGITS = "0123456789";
const AR_DIGITS = "٠١٢٣٤٥٦٧٨٩";

const CHAR_MAP = new Map([
  ["ي", "ی"], ["ى", "ی"], ["ك", "ک"],
  ["ـ", ""], ["‏", ""], ["‎", ""], ["﻿", ""],
  ...[...AR_DIGITS].map((a, i) => [a, FA_DIGITS[i]]),
]);
const DIACRITICS = /[ً-ْٰ]/g;
const PERSIAN = /[؀-ۿ]/;

export const CLOSING_PUNCT = new Set([...".،,؛;:!?؟»)]…"]);
export const SENTENCE_END = new Set([...".!?؟…"]);
export const CLAUSE_END = new Set([..."،,؛;:"]);
export const OPENING_PUNCT = new Set([..."«(["]);

// A new cue/line reads best when it starts with one of these.
export const CONJUNCTIONS = new Set([
  "و", "که", "اما", "ولی", "تا", "اگر", "اگه", "چون", "چرا", "یا", "بلکه",
  "وقتی", "پس", "سپس", "بعد", "ولیکن", "زیرا", "مگر", "درحالیکه",
]);

const PREFIXES = new Set(["می", "نمی"]);
const SUFFIXES = new Set([
  "ها", "های", "هایی", "هایم", "هایت", "هایش", "هایمان", "هایتان", "هایشان",
  "هام", "هات", "هاش", "هامون", "هاتون", "هاشون", "تر", "ترین",
]);
const HEH_SUFFIXES = new Set(["ام", "ای", "ایم", "اید", "اند", "اش"]);

const JUNK_EXACT = new Set(["موسیقی", "[موسیقی]", "(موسیقی)", "♪", "♪♪", "...", "…", "زیرنویس", "تشویق"]);
const JUNK_HINTS = ["زیرنویس", "amara", "subtitle", "سابسکرایب", "subscribe", "ترجمه و"];
const STUTTER = /(\S{1,4}?)\1{3,}/u; // «میدیدیدیدید»

const last = (s) => s.slice(-1);

/** @typedef {{start: number, end: number, text: string, prob?: number}} Word */

function persianPunct(text) {
  return text.replace(/,(?![0-9۰-۹])/g, "،").replaceAll("?", "؟").replaceAll(";", "؛");
}

/** Fix letter variants, diacritics, punctuation shapes and digits in one word. */
export function normalizeChars(text, digits = "fa") {
  let out = "";
  for (const ch of text) out += CHAR_MAP.has(ch) ? CHAR_MAP.get(ch) : ch;
  out = out.replace(DIACRITICS, "").trim();
  if (digits === "fa") out = out.replace(/[0-9]/g, (d) => FA_DIGITS[+d]);
  else if (digits === "en") out = out.replace(/[۰-۹]/g, (d) => EN_DIGITS[FA_DIGITS.indexOf(d)]);
  return PERSIAN.test(out) ? persianPunct(out) : out;
}

const isPunctOnly = (t) => t.length > 0 && [...t].every((c) => CLOSING_PUNCT.has(c) || OPENING_PUNCT.has(c));
const isOpeningOnly = (t) => [...t].every((c) => OPENING_PUNCT.has(c));

/** The word without punctuation around it. */
export function core(text) {
  const chars = [...text];
  let a = 0, b = chars.length;
  const p = (c) => CLOSING_PUNCT.has(c) || OPENING_PUNCT.has(c);
  while (a < b && p(chars[a])) a++;
  while (b > a && p(chars[b - 1])) b--;
  return chars.slice(a, b).join("");
}

const join = (a, b, sep) => ({
  start: a.start, end: Math.max(a.end, b.end), text: a.text + sep + b.text,
  prob: Math.min(a.prob ?? 1, b.prob ?? 1),
});

/** Normalize every word and fix spacing (ZWNJ) between words, keeping timings. */
export function cleanWords(words, digits = "fa") {
  const out = [];
  let pendingOpen = "";
  for (const w0 of words) {
    let text = normalizeChars(w0.text, digits);
    if (!text) continue;
    if (isOpeningOnly(text)) { pendingOpen += text; continue; }
    if (pendingOpen) { text = pendingOpen + text; pendingOpen = ""; }
    let w = { ...w0, text };
    if (out.length && isPunctOnly(text)) {
      if (PERSIAN.test(out.at(-1).text)) w.text = persianPunct(w.text);
      out[out.length - 1] = join(out.at(-1), w, "");
      continue;
    }
    if (out.length) {
      const prev = out.at(-1);
      const prevCore = core(prev.text), c = core(text);
      const prevClosed = CLOSING_PUNCT.has(last(prev.text));
      if (!prevClosed && PREFIXES.has(prevCore) && PERSIAN.test(c[0] ?? "")) {
        out[out.length - 1] = join(prev, w, ZWNJ);
        continue;
      }
      if (!prevClosed && c && !OPENING_PUNCT.has(text[0]) &&
          (SUFFIXES.has(c) || (HEH_SUFFIXES.has(c) && prevCore.endsWith("ه"))) && PERSIAN.test(prevCore)) {
        out[out.length - 1] = join(prev, w, ZWNJ);
        continue;
      }
    }
    out.push(w);
  }
  return out;
}

/** Final per-line cleanup: spaces around punctuation, double spaces. */
export function tidyLine(text) {
  return text.replace(/\s+/g, " ").trim()
    .replace(/\s+([.،,؛;:!?؟»)\]…])/g, "$1")
    .replace(/([«(\[])\s+/g, "$1");
}

/** True for lines that are almost certainly invented (music tags). */
export function isJunk(text) {
  const t = core(normalizeChars(text, "keep")).trim().toLowerCase();
  return !t || JUNK_EXACT.has(t) || JUNK_EXACT.has(text.trim());
}

export const isStutter = (word) => STUTTER.test(word);

export function looksLikeCredit(text) {
  const t = text.toLowerCase();
  return JUNK_HINTS.some((h) => t.includes(h));
}

export const faNum = (v) => String(v).replace(/[0-9]/g, (d) => FA_DIGITS[+d]).replace(".", "٫");
