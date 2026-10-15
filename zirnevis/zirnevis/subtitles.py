"""Write SRT / WebVTT files that display Persian correctly in real players."""

from __future__ import annotations

import re

from .segment import Cue

RLM = "‏"  # right-to-left mark


def _ts(seconds: float, sep: str) -> str:
    ms = max(0, round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d}{sep}{ms:03d}"


def _rtl(line: str) -> str:
    # An RLM on both ends keeps «.» «؟» «!» on the correct (left) side in
    # players that would otherwise lay the line out left-to-right.
    return f"{RLM}{line}{RLM}"


def to_srt(cues: list[Cue], rtl_marks: bool = True) -> str:
    blocks = []
    for i, c in enumerate(cues, 1):
        lines = [_rtl(l) if rtl_marks else l for l in c.lines]
        blocks.append(f"{i}\n{_ts(c.start, ',')} --> {_ts(c.end, ',')}\n" + "\n".join(lines))
    return "\n\n".join(blocks) + "\n"


def to_vtt(cues: list[Cue], rtl_marks: bool = True) -> str:
    out = ["WEBVTT", ""]
    for c in cues:
        lines = [_rtl(l) if rtl_marks else l for l in c.lines]
        out += [f"{_ts(c.start, '.')} --> {_ts(c.end, '.')}", *lines, ""]
    return "\n".join(out)


def to_text(cues: list[Cue]) -> str:
    return "\n".join(c.text for c in cues) + "\n"


def write(path: str, content: str, bom: bool = False) -> str:
    with open(path, "w", encoding="utf-8-sig" if bom else "utf-8", newline="\n") as f:
        f.write(content)
    return path


_TS = re.compile(r"^\s*(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?\s*$")


def parse_ts(value: str) -> float:
    """'00:01:02,500', '1:02.5' or '62.5' → seconds."""
    value = str(value).strip().translate(str.maketrans("۰۱۲۳۴۵۶۷۸۹", "0123456789"))
    m = _TS.match(value)
    if not m:
        return float(value)
    h, mnt, s, frac = m.groups()
    return int(h or 0) * 3600 + int(mnt) * 60 + int(s) + int((frac or "0").ljust(3, "0")) / 1000


def format_ts(seconds: float) -> str:
    return _ts(seconds, ",")
