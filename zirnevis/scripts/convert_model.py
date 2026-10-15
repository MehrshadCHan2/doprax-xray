"""Convert a Hugging Face Whisper model to the fast CPU (CTranslate2 int8) format.

    python scripts/convert_model.py givia/whisper-large-v3-turbo-persian /models/whisper-fa

Needs `torch` and `transformers` only while converting; the app itself does not.
"""

import os
import sys

from ctranslate2.converters import TransformersConverter


def main(repo: str, out: str) -> None:
    from huggingface_hub import snapshot_download

    src = snapshot_download(repo, allow_patterns=["*.json", "*.safetensors", "*.txt"])
    # tokenizer.json and preprocessor_config.json travel with the model, so
    # faster-whisper never has to fetch a tokenizer from the internet at run time.
    wanted = ["tokenizer.json", "preprocessor_config.json"]
    copy = [f for f in wanted if os.path.exists(os.path.join(src, f))]
    TransformersConverter(src, copy_files=copy, low_cpu_mem_usage=True).convert(
        out, quantization="int8", force=True
    )
    print("converted", repo, "->", out, "with", copy)


if __name__ == "__main__":
    main(*sys.argv[1:3])
