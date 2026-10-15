"""Turn timed words into readable subtitle cues (Netflix-style rules)."""

from __future__ import annotations

from dataclasses import dataclass, field

from .text import CLAUSE_END, CONJUNCTIONS, SENTENCE_END, Word, _core, tidy_line


@dataclass
class Style:
    max_line_chars: int = 42      # characters per line
    max_lines: int = 2            # lines per cue
    max_duration: float = 6.0     # seconds a cue may stay on screen
    min_duration: float = 1.0     # shortest time a cue is shown
    pause_split: float = 0.6      # a silence this long always starts a new cue
    min_gap: float = 0.08         # space between two cues (≈2 frames)
    linger: float = 0.25          # keep text up a little after the last word
    sentence_min_chars: int = 12  # end a cue at a sentence end once it has this much text

    @property
    def max_chars(self) -> int:
        return self.max_line_chars * self.max_lines


@dataclass
class Cue:
    start: float
    end: float
    lines: list[str] = field(default_factory=list)

    @property
    def text(self) -> str:
        return " ".join(self.lines)


def _length(words: list[Word]) -> int:
    return len(" ".join(w.text for w in words))


def _break_score(words: list[Word], k: int) -> float:
    """How good it is to end a cue after words[k-1] (and start the next at words[k])."""
    last = words[k - 1].text
    score = 0.0
    if last[-1:] in SENTENCE_END:
        score += 3
    elif last[-1:] in CLAUSE_END:
        score += 2
    if k < len(words):
        if _core(words[k].text) in CONJUNCTIONS:
            score += 1.5
        gap = words[k].start - words[k - 1].end
        score += min(max(gap, 0) / 0.2, 2.0)
    return score


def _best_break(words: list[Word], style: Style) -> int:
    """Index k so that words[:k] becomes a cue. words[:k] always fits the limits."""
    total = _length(words)
    best_k, best = len(words), -1.0
    for k in range(1, len(words) + 1):
        head = words[:k]
        if _length(head) > style.max_chars or head[-1].end - head[0].start > style.max_duration:
            break
        if k < len(words) and _length(head) < 0.35 * total:
            continue  # avoid a tiny orphan cue
        # Slight preference for later breaks so cues are well filled.
        score = _break_score(words, k) + k / (10 * len(words))
        if score >= best:
            best, best_k = score, k
    return max(best_k, 1)


def group_words(words: list[Word], style: Style) -> list[list[Word]]:
    groups: list[list[Word]] = []
    cur: list[Word] = []
    for w in words:
        if cur:
            gap = w.start - cur[-1].end
            too_long = _length(cur + [w]) > style.max_chars
            too_slow = w.end - cur[0].start > style.max_duration
            if gap >= style.pause_split:
                groups.append(cur)
                cur = []
            elif too_long or too_slow:
                k = _best_break(cur + [w], style)
                if k >= len(cur):
                    groups.append(cur)
                    cur = []
                else:
                    groups.append(cur[:k])
                    cur = cur[k:]
        cur.append(w)
        if w.text[-1:] in SENTENCE_END and _length(cur) >= style.sentence_min_chars:
            groups.append(cur)
            cur = []
    if cur:
        groups.append(cur)
    return groups


def wrap(text: str, style: Style) -> list[str]:
    """Split a cue's text into at most `max_lines` balanced lines."""
    text = tidy_line(text)
    if len(text) <= style.max_line_chars or style.max_lines < 2:
        return [text]
    words = text.split(" ")
    best, best_cost = [text], float("inf")
    for k in range(1, len(words)):
        a, b = " ".join(words[:k]), " ".join(words[k:])
        cost = abs(len(a) - len(b))
        if len(a) > style.max_line_chars or len(b) > style.max_line_chars:
            cost += 1000 + 10 * max(len(a), len(b))
        if len(a) > len(b):
            cost += 2  # bottom-heavy reads more naturally
        if words[k - 1][-1:] in SENTENCE_END | CLAUSE_END:
            cost -= 8
        elif _core(words[k]) in CONJUNCTIONS:
            cost -= 4
        if cost < best_cost:
            best, best_cost = [a, b], cost
    return best


def fix_timing(cues: list[Cue], style: Style, duration: float | None = None) -> list[Cue]:
    """Give every cue enough screen time without overlapping its neighbours."""
    for i, cue in enumerate(cues):
        nxt = cues[i + 1].start - style.min_gap if i + 1 < len(cues) else (duration or float("inf"))
        want = max(cue.end + style.linger, cue.start + style.min_duration)
        cue.end = max(cue.end, min(want, nxt))
        if cue.end > nxt:  # words overlapped the next cue: trim, but never below 0.3s
            cue.end = max(nxt, cue.start + 0.3)
            if i + 1 < len(cues) and cues[i + 1].start < cue.end + style.min_gap:
                cues[i + 1].start = cue.end + style.min_gap
        if duration:
            cue.end = min(cue.end, duration)
        cue.start = max(cue.start, 0.0)
        cue.end = max(cue.end, cue.start + 0.1)
    return cues


def build_cues(words: list[Word], style: Style | None = None, duration: float | None = None) -> list[Cue]:
    style = style or Style()
    cues = [
        Cue(g[0].start, g[-1].end, wrap(" ".join(w.text for w in g), style))
        for g in group_words(words, style)
    ]
    return fix_timing(cues, style, duration)


def rewrap(cues: list[Cue], style: Style | None = None) -> list[Cue]:
    style = style or Style()
    return [Cue(c.start, c.end, wrap(c.text, style)) for c in cues if c.text.strip()]
