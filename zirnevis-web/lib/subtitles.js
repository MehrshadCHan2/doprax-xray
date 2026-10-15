// SRT / WebVTT that display Persian correctly in real players.
import { cueText } from "./segment.js";

export const RLM = "‏"; // right-to-left mark

function ts(seconds, sep) {
  let ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000); ms -= h * 3_600_000;
  const m = Math.floor(ms / 60_000); ms -= m * 60_000;
  const s = Math.floor(ms / 1000); ms -= s * 1000;
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(h)}:${p(m)}:${p(s)}${sep}${p(ms, 3)}`;
}

// An RLM on both ends keeps «.» «؟» «!» on the correct (left) side in
// players that would otherwise lay the line out left-to-right.
const rtl = (line) => `${RLM}${line}${RLM}`;

export function toSrt(cues, rtlMarks = true) {
  return cues.map((c, i) =>
    `${i + 1}\n${ts(c.start, ",")} --> ${ts(c.end, ",")}\n` + c.lines.map((l) => (rtlMarks ? rtl(l) : l)).join("\n"),
  ).join("\n\n") + "\n";
}

export function toVtt(cues, rtlMarks = true) {
  const out = ["WEBVTT", ""];
  for (const c of cues) out.push(`${ts(c.start, ".")} --> ${ts(c.end, ".")}`, ...c.lines.map((l) => (rtlMarks ? rtl(l) : l)), "");
  return out.join("\n");
}

export const toText = (cues) => cues.map(cueText).join("\n") + "\n";
export const formatTs = (seconds) => ts(seconds, ",");

/** '00:01:02,500', '1:02.5' or '62.5' → seconds. NaN when unreadable. */
export function parseTs(value) {
  const v = String(value).trim().replace(/[۰-۹]/g, (d) => "۰۱۲۳۴۵۶۷۸۹".indexOf(d));
  const m = v.match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!m) return v && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN;
  const [, h, mn, s, frac] = m;
  return Number(h ?? 0) * 3600 + Number(mn) * 60 + Number(s) + Number((frac ?? "0").padEnd(3, "0")) / 1000;
}
