"""Clip in, cues out: audio → words → clean words → subtitle cues."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from .asr import Transcriber
from .audio import SAMPLE_RATE, load_audio
from .segment import Cue, Style, build_cues
from .text import clean_words


@dataclass
class Result:
    cues: list[Cue]
    duration: float


def make_cues(
    path: str,
    transcriber: Transcriber,
    style: Style | None = None,
    digits: str = "fa",
    progress: Callable[[float], None] | None = None,
) -> Result:
    audio = load_audio(path)
    leveled = load_audio(path, level=True)
    duration = len(audio) / SAMPLE_RATE
    words = clean_words(transcriber.words(audio, progress, vad_audio=leveled), digits=digits)
    return Result(build_cues(words, style or Style(), duration), duration)
