"""Read the sound out of any video/audio file with ffmpeg."""

from __future__ import annotations

import json
import subprocess

import numpy as np

SAMPLE_RATE = 16000


class MediaError(RuntimeError):
    pass


def probe(path: str) -> dict:
    """Duration and whether the file has audio / video."""
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_type",
             "-of", "json", path],
            capture_output=True, check=True, text=True, timeout=60,
        ).stdout
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as e:
        raise MediaError("این فایل قابل خواندن نیست. یک فایل ویدیو یا صدای سالم بفرستید.") from e
    info = json.loads(out or "{}")
    kinds = {s.get("codec_type") for s in info.get("streams", [])}
    return {
        "duration": float(info.get("format", {}).get("duration") or 0),
        "has_audio": "audio" in kinds,
        "has_video": "video" in kinds,
    }


def load_audio(path: str, level: bool = False) -> np.ndarray:
    """Mono 16 kHz float32 samples, the format Whisper expects.

    `level=True` evens out loud and quiet parts. That helps find soft speech,
    but the recognizer itself does better on the original sound.
    """
    leveling = ["-af", "dynaudnorm=f=150:g=15"] if level else []
    proc = subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-i", path, "-vn", "-map", "0:a:0",
         *leveling, "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0 or not proc.stdout:
        raise MediaError("صدای این فایل خوانده نشد. مطمئن شوید فایل صدا دارد.")
    return np.frombuffer(proc.stdout, np.int16).astype(np.float32) / 32768.0
