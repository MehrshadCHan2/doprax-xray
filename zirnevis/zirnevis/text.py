"""Persian text cleanup that keeps word timings intact.

Everything here works word by word, so every word keeps its own start/end time.
Joining two words (e.g. «می» + «خواهم») merges their timings as well.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

ZWNJ = "‌"  # نیم‌فاصله

FA_DIGITS = "۰۱۲۳۴۵۶۷۸۹"
EN_DIGITS = "0123456789"
AR_DIGITS = "٠١٢٣٤٥٦٧٨٩"

_CHAR_MAP = str.maketrans(
    {
        "ي": "ی",
        "ى": "ی",
        "ك": "ک",
        "ـ": "",  # tatweel
        "‏": "",  # stray direction marks from the model
        "‎": "",
        "﻿": "",
        **{a: f for a, f in zip(AR_DIGITS, FA_DIGITS)},
    }
)
_DIACRITICS = re.compile("[ً-ْٰ]")
_PERSIAN = re.compile("[؀-ۿ]")

# Punctuation that belongs to the word before it (attached to its end).
CLOSING_PUNCT = set(".،,؛;:!?؟»)]…")
SENTENCE_END = set(".!?؟…")
CLAUSE_END = set("،,؛;:")
OPENING_PUNCT = set("«([")

# A new cue/line reads best when it starts with one of these.
CONJUNCTIONS = {
    "و", "که", "اما", "ولی", "تا", "اگر", "اگه", "چون", "چرا", "یا", "بلکه",
    "وقتی", "پس", "سپس", "بعد", "ولیکن", "زیرا", "مگر", "درحالیکه",
}

# Prefixes that are glued to the next word with a ZWNJ: «می خوام» → «می‌خوام».
_PREFIXES = {"می", "نمی"}
# Suffixes always glued to the previous word: «کتاب ها» → «کتاب‌ها».
_SUFFIXES = {
    "ها", "های", "هایی", "هایم", "هایت", "هایش", "هایمان", "هایتان", "هایشان",
    "هام", "هات", "هاش", "هامون", "هاتون", "هاشون", "تر", "ترین",
}
# Suffixes glued only after a word ending in «ه»: «رفته اند» → «رفته‌اند».
_HEH_SUFFIXES = {"ام", "ای", "ایم", "اید", "اند", "اش"}

# Lines the model sometimes invents in silence or music.
_JUNK_EXACT = {
    "موسیقی", "[موسیقی]", "(موسیقی)", "♪", "♪♪", "...", "…", "زیرنویس", "تشویق",
}
_JUNK_HINTS = ("زیرنویس", "amara", "subtitle", "سابسکرایب", "subscribe", "ترجمه و")


@dataclass
class Word:
    start: float
    end: float
    text: str
    prob: float = 1.0


def normalize_chars(text: str, digits: str = "fa") -> str:
    """Fix letter variants, diacritics, punctuation shapes and digits in one word."""
    text = _DIACRITICS.sub("", text.translate(_CHAR_MAP)).strip()
    if digits == "fa":
        text = text.translate(str.maketrans(EN_DIGITS, FA_DIGITS))
    elif digits == "en":
        text = text.translate(str.maketrans(FA_DIGITS, EN_DIGITS))
    return _persian_punct(text) if _PERSIAN.search(text) else text


def _persian_punct(text: str) -> str:
    """Latin punctuation next to Persian text → Persian shapes."""
    text = re.sub(r",(?!\d)", "،", text)
    return text.replace("?", "؟").replace(";", "؛")


def _is_punct_only(text: str) -> bool:
    return bool(text) and all(c in CLOSING_PUNCT or c in OPENING_PUNCT for c in text)


def _core(text: str) -> str:
    """The word without punctuation around it."""
    return text.strip("".join(CLOSING_PUNCT | OPENING_PUNCT))


def _join(a: Word, b: Word, sep: str) -> Word:
    return Word(a.start, max(a.end, b.end), a.text + sep + b.text, min(a.prob, b.prob))


def clean_words(words: list[Word], digits: str = "fa") -> list[Word]:
    """Normalize every word and fix spacing (ZWNJ) between words, keeping timings."""
    out: list[Word] = []
    pending_open = ""
    for w in words:
        text = normalize_chars(w.text, digits)
        if not text:
            continue
        if all(c in OPENING_PUNCT for c in text):
            pending_open += text
            continue
        if pending_open:
            text, pending_open = pending_open + text, ""
        w = Word(w.start, w.end, text, w.prob)
        if out and _is_punct_only(text):
            if _PERSIAN.search(out[-1].text):
                w.text = _persian_punct(w.text)
            out[-1] = _join(out[-1], w, "")
            continue
        if out:
            prev = out[-1]
            prev_core, core = _core(prev.text), _core(text)
            prev_has_closing = prev.text[-1:] in CLOSING_PUNCT
            if not prev_has_closing and prev_core in _PREFIXES and _PERSIAN.match(core or " "):
                out[-1] = _join(prev, w, ZWNJ)
                continue
            if not prev_has_closing and core and text[0] not in OPENING_PUNCT and (
                core in _SUFFIXES or (core in _HEH_SUFFIXES and prev_core.endswith("ه"))
            ) and _PERSIAN.search(prev_core):
                out[-1] = _join(prev, w, ZWNJ)
                continue
        out.append(w)
    return out


def tidy_line(text: str) -> str:
    """Final per-line cleanup: spaces around punctuation, double spaces."""
    text = re.sub(r"\s+", " ", text).strip()
    text = re.sub(r"\s+([.،,؛;:!?؟»)\]…])", r"\1", text)
    text = re.sub(r"([«(\[])\s+", r"\1", text)
    return text


_STUTTER = re.compile(r"(\S{1,4}?)\1{3,}")  # «میدیدیدیدید»


def is_junk(text: str) -> bool:
    """True for lines that are almost certainly invented (music tags, loops)."""
    t = _core(normalize_chars(text, digits="keep")).strip().lower()
    return not t or t in _JUNK_EXACT or text.strip() in _JUNK_EXACT


def is_stutter(word: str) -> bool:
    return bool(_STUTTER.search(word))


def looks_like_credit(text: str) -> bool:
    t = text.lower()
    return any(h in t for h in _JUNK_HINTS)
