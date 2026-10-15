// Same cases as the Python tests in zirnevis/tests, for the browser version.
// Run: node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";

import { ZWNJ, cleanWords, isJunk, isStutter, normalizeChars, tidyLine } from "../lib/text.js";
import { DEFAULT_STYLE, buildCues, cueText, rewrap, wrap } from "../lib/segment.js";
import { RLM, formatTs, parseTs, toSrt, toVtt } from "../lib/subtitles.js";
import { SAMPLE_RATE, dropPiece, fixWords, planPieces } from "../lib/speech.js";

const words = (...texts) => texts.map((t, i) => ({ start: i * 0.5, end: i * 0.5 + 0.4, text: t }));
const texts = (ws) => ws.map((w) => w.text);

function timed(text, { start = 0, step = 0.35, gapAfter = {} } = {}) {
  const out = [];
  let t = start;
  text.split(" ").forEach((w, i) => {
    out.push({ start: t, end: t + step - 0.05, text: w });
    t += step + (gapAfter[i] ?? 0);
  });
  return out;
}

// --- text ---
test("arabic letters, digits, punctuation", () => {
  assert.equal(normalizeChars("كتاب يك 12"), "کتاب یک ۱۲");
  assert.equal(normalizeChars("۱۲ ٣", "en"), "12 3");
  assert.equal(normalizeChars("سلام?"), "سلام؟");
  assert.equal(normalizeChars("1,000"), "۱,۰۰۰");
  assert.equal(normalizeChars("کِتابٌ"), "کتاب");
});

test("prefix/suffix joins keep timing", () => {
  const out = cleanWords(words("من", "می", "خوام", "برم"));
  assert.deepEqual(texts(out), ["من", `می${ZWNJ}خوام`, "برم"]);
  assert.equal(out[1].start, 0.5);
  assert.equal(out[1].end, 1.4);
  assert.deepEqual(texts(cleanWords(words("کتاب", "ها", "را", "خوانده", "اند"))), [`کتاب${ZWNJ}ها`, "را", `خوانده${ZWNJ}اند`]);
  assert.deepEqual(texts(cleanWords(words("ای", "خدا", "و", "ای", "کاش"))), ["ای", "خدا", "و", "ای", "کاش"]);
  assert.deepEqual(texts(cleanWords(words("رفتم.", "ها", "چی؟"))).slice(0, 2), ["رفتم.", "ها"]);
});

test("punctuation attaches to the right word", () => {
  assert.deepEqual(texts(cleanWords(words("سلام", "،", "خوبی", "?"))), ["سلام،", "خوبی؟"]);
  assert.deepEqual(texts(cleanWords(words("گفت", "«", "نه", "»"))), ["گفت", "«نه»"]);
  assert.equal(tidyLine("سلام ،  خوبی ؟"), "سلام، خوبی؟");
  assert.equal(tidyLine("« نه »"), "«نه»");
});

test("junk and stutter", () => {
  assert.ok(isJunk("موسیقی"));
  assert.ok(isJunk("[موسیقی]"));
  assert.ok(!isJunk("موسیقی خوبی بود"));
  assert.ok(isStutter("میدیدیدیدید"));
  assert.ok(!isStutter("دیدید"));
  assert.ok(!isStutter("می‌خواهم"));
});

// --- segment ---
const LONG = "من خیلی بهتون علاقه دارم و ازتون میخوام که اگه شما هم منو میپسندین و بهم علاقه دارین بیشتر آشنا بشیم";

test("every cue respects limits", () => {
  const cues = buildCues(timed(Array(6).fill("این یک جمله نسبتا بلند است که باید شکسته شود").join(" ")));
  for (const c of cues) {
    assert.ok(c.lines.length <= 2);
    assert.ok(c.lines.every((l) => l.length <= 42));
    assert.ok(c.end - c.start <= DEFAULT_STYLE.maxDuration + DEFAULT_STYLE.linger + 0.01);
  }
});

test("no words lost, breaks before a conjunction", () => {
  const cues = buildCues(timed(LONG));
  assert.equal(cues.map(cueText).join(" "), LONG);
  assert.ok(cues.slice(1).some((c) => /^(که|و) /.test(cueText(c))));
});

test("pauses and sentence ends split cues", () => {
  assert.deepEqual(buildCues(timed("سلام خوبی چه خبر", { gapAfter: { 1: 1.5 } })).map(cueText), ["سلام خوبی", "چه خبر"]);
  assert.equal(cueText(buildCues(timed("امروز هوا خیلی خوب بود. فردا میریم کوه"))[0]), "امروز هوا خیلی خوب بود.");
});

test("timing: no overlap, min duration, clamp", () => {
  const cues = buildCues([
    { start: 0, end: 0.2, text: "بله." }, { start: 0.5, end: 0.7, text: "نه." }, { start: 3, end: 3.3, text: "شاید." },
  ], {}, 4.0);
  for (let i = 0; i + 1 < cues.length; i++) assert.ok(cues[i].end <= cues[i + 1].start - DEFAULT_STYLE.minGap + 1e-9);
  assert.ok(cues.at(-1).end - cues.at(-1).start >= 1 - 1e-9);
  assert.ok(cues.at(-1).end <= 4.0);
  const fixed = buildCues([{ start: 0, end: 2, text: "این جمله اول است." }, { start: 1.5, end: 3, text: "این جمله دوم است." }]);
  assert.ok(fixed[0].end < fixed[1].start);
});

test("wrap and rewrap", () => {
  const lines = wrap("حال مدیرعامل فوت هولز، جان مکی و هیئت مدیره نمیخواستند خود را به آمازون بفروشند.");
  assert.equal(lines.length, 2);
  assert.ok(lines.every((l) => l.length <= 42));
  assert.deepEqual(wrap("سلام خوبی؟"), ["سلام خوبی؟"]);
  const re = rewrap([{ start: 0, end: 2, lines: ["متن ویرایش شده که خیلی خیلی بلند است و باید دو خط شود حتما"] }, { start: 2, end: 3, lines: [" "] }]);
  assert.equal(re.length, 1);
  assert.equal(re[0].lines.length, 2);
});

// --- subtitles ---
test("srt and vtt", () => {
  assert.equal(
    toSrt([{ start: 1.5, end: 3.25, lines: ["سلام،", "خوبی؟"] }, { start: 3661, end: 3662, lines: ["خداحافظ."] }]),
    `1\n00:00:01,500 --> 00:00:03,250\n${RLM}سلام،${RLM}\n${RLM}خوبی؟${RLM}\n\n2\n01:01:01,000 --> 01:01:02,000\n${RLM}خداحافظ.${RLM}\n`,
  );
  assert.ok(!toSrt([{ start: 0, end: 1, lines: ["سلام"] }], false).includes(RLM));
  assert.ok(toVtt([{ start: 0, end: 1.2, lines: ["سلام"] }], false).startsWith("WEBVTT\n\n00:00:00.000 --> 00:00:01.200\nسلام\n"));
});

test("timestamps round trip", () => {
  for (const s of [0, 0.001, 1.5, 59.999, 3725.25]) assert.ok(Math.abs(parseTs(formatTs(s)) - s) < 0.001);
  assert.equal(parseTs("۰۰:۰۱:۰۲,۵"), 62.5);
  assert.equal(parseTs("1:02.5"), 62.5);
  assert.equal(parseTs("62.5"), 62.5);
  assert.ok(Number.isNaN(parseTs("abc")));
});

// --- speech ---
test("fixWords trims stretched words and noise", () => {
  const out = fixWords([
    { start: 110.61, end: 110.77, text: "م", prob: 0 },
    { start: 110.77, end: 118.95, text: "آیین", prob: 0.7 },
    { start: 118.95, end: 119.47, text: "بودایی", prob: 0.99 },
    { start: 119.47, end: 125.0, text: "تبتی", prob: 0.9 },
  ]);
  assert.deepEqual(texts(out), ["آیین", "بودایی", "تبتی"]);
  assert.equal(out[0].end, 118.95);
  assert.ok(out[0].end - out[0].start <= 1.0 + 1e-9);
  assert.equal(out[2].start, 119.47);
});

test("dropPiece", () => {
  assert.ok(dropPiece("موسیقی", 2));
  assert.ok(dropPiece("میدیدیدید در نیزیادی درکه‌های درکه‌های درکه‌های", 0.3));
  assert.ok(!dropPiece("سلام خوبی چه خبر", 2));
});

test("planPieces finds speech, skips silence, respects max length", () => {
  const sr = SAMPLE_RATE;
  const audio = new Float32Array(sr * 70);
  const tone = (a, b, amp) => { for (let i = a * sr; i < b * sr; i++) audio[i] = amp * Math.sin(i / 7); };
  tone(1, 4, 0.3);      // loud speech
  tone(10, 13, 0.02);   // quiet speech
  tone(20, 60, 0.3);    // 40 s without pause → must be cut
  for (let i = 0; i < audio.length; i++) audio[i] += (Math.random() - 0.5) * 0.0005; // noise floor
  const pieces = planPieces(audio).map(([a, b]) => [a / sr, b / sr]);
  assert.ok(pieces.some(([a, b]) => a <= 1 && b >= 4), "loud speech found");
  assert.ok(pieces.some(([a, b]) => a <= 10.1 && b >= 12.9), "quiet speech found");
  assert.ok(pieces.every(([a, b]) => b - a <= 24 + 1e-6), "no piece longer than 24 s");
  assert.ok(!pieces.some(([a, b]) => a > 5 && b < 9), "silence skipped");
  const covered = pieces.filter(([a, b]) => b > 20 && a < 60).reduce((s, [a, b]) => s + Math.min(b, 60) - Math.max(a, 20), 0);
  assert.ok(covered > 39, "long speech fully covered");
});
