"""Speech recognition on the CPU with faster-whisper."""

from __future__ import annotations

import os
from typing import Callable

import numpy as np

from .audio import SAMPLE_RATE
from .text import Word, is_junk, is_stutter, looks_like_credit

DEFAULT_MODEL = os.environ.get("ZIRNEVIS_MODEL", "/models/whisper-fa")
MAX_CHUNK = 24.0  # seconds of audio decoded at once (the model card suggests ≤26)


def cpu_count() -> int:
    """CPUs this container may really use (cgroup quota), not the host's total."""
    try:
        quota, period = open("/sys/fs/cgroup/cpu.max").read().split()
        if quota != "max":
            return max(1, int(int(quota) / int(period)))
    except (OSError, ValueError):
        pass
    try:
        return max(1, len(os.sched_getaffinity(0)))
    except AttributeError:
        return os.cpu_count() or 1


class Transcriber:
    def __init__(self, model: str = DEFAULT_MODEL, threads: int | None = None):
        from faster_whisper import WhisperModel

        self.model = WhisperModel(
            model, device="cpu", compute_type="int8", cpu_threads=threads or cpu_count()
        )

    def words(
        self,
        audio: np.ndarray,
        progress: Callable[[float], None] | None = None,
        vad_audio: np.ndarray | None = None,
    ) -> list[Word]:
        """Timed words for the whole recording. `vad_audio` (same length, volume
        leveled) is only used to find where people speak."""
        chunks = plan_chunks(audio if vad_audio is None else vad_audio)
        total = sum(b - a for a, b in chunks) or 1
        done = 0
        words: list[Word] = []
        for a, b in chunks:
            offset = a / SAMPLE_RATE
            segments, _ = self.model.transcribe(
                audio[a:b],
                language="fa",
                task="transcribe",
                beam_size=5,
                # The Persian fine-tune is trained on whole pieces of speech without
                # timestamp tokens; word times come from the alignment step instead.
                without_timestamps=True,
                word_timestamps=True,
                vad_filter=False,
                condition_on_previous_text=False,
                temperature=(0.0, 0.2, 0.4, 0.6),
                prepend_punctuations="\"'“¿([{-«",
                append_punctuations="\"'.。,，!！?？:：”)]}、،؟؛»…",
            )
            # A piece is shorter than Whisper's 30 s window, so the first result
            # already holds all of its speech. Asking for more only makes the
            # model invent text for the silence after it.
            seg = next(iter(segments), None)
            if seg is not None and not _drop_segment(seg):
                for w in seg.words or []:
                    text = w.word.strip()
                    if text and not is_stutter(text):
                        words.append(Word(w.start + offset, w.end + offset, text, w.probability))
            done += b - a
            if progress:
                progress(done / total)
        return words


def plan_chunks(audio: np.ndarray, max_len: float = MAX_CHUNK, max_gap: float = 2.0) -> list[tuple[int, int]]:
    """Speech regions grouped into pieces of at most `max_len` seconds, cut at pauses."""
    from faster_whisper.vad import VadOptions, get_speech_timestamps

    regions = get_speech_timestamps(
        audio,
        VadOptions(
            threshold=0.5,
            min_silence_duration_ms=500,
            speech_pad_ms=400,
            max_speech_duration_s=max_len,
        ),
    )
    chunks: list[list[int]] = []
    for r in regions:
        if (
            chunks
            and (r["end"] - chunks[-1][0]) / SAMPLE_RATE <= max_len
            and (r["start"] - chunks[-1][1]) / SAMPLE_RATE <= max_gap
        ):
            chunks[-1][1] = r["end"]
        else:
            chunks.append([r["start"], r["end"]])
    return [(a, b) for a, b in chunks]


def _drop_segment(seg) -> bool:
    """Skip lines the model invented over silence or music."""
    text = seg.text.strip()
    if is_junk(text):
        return True
    # Nobody speaks 30+ characters a second: that is a decoding loop.
    if len(text) >= 10 and len(text) / max(seg.end - seg.start, 0.01) > 30:
        return True
    unsure = seg.no_speech_prob > 0.5 or seg.avg_logprob < -1.0
    return looks_like_credit(text) and (unsure or seg.end - seg.start < 4)
