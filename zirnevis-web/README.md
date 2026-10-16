---
title: Jcutpersiansub - Persian Subtitles
emoji: 🎬
colorFrom: red
colorTo: red
sdk: static
pinned: false
license: mit
short_description: Clean Persian SRT subtitles for any clip, in-browser
custom_headers:
  cross-origin-embedder-policy: require-corp
  cross-origin-opener-policy: same-origin
  cross-origin-resource-policy: cross-origin
---

# Jcutpersiansub — زیرنویس فارسی رایگان

ساخته‌ی مهرشاد جاوید · [اینستاگرام @jcutgroup](https://instagram.com/jcutgroup) · [تلگرام @mehrshadcreates](https://t.me/mehrshadcreates)

ویدیو یا صدا را بدهید، زیرنویس فارسی دقیق و تمیز (SRT) بگیرید. رایگان و بدون سرور:
مدل تشخیص گفتار داخل مرورگر خود کاربر اجرا می‌شود و فایل از دستگاه او خارج نمی‌شود.

- بار اول حدود ۶۰۰ مگابایت مدل دانلود و در مرورگر ذخیره می‌شود؛ دفعه‌های بعد فوری است.
- بهترین سرعت: Chrome یا Edge جدید روی کامپیوتر (WebGPU). بدون WebGPU هم کار می‌کند اما کندتر.

## How it works

```
clip ─WebAudio→ 16 kHz mono ─energy VAD (adaptive noise floor)→ speech pieces ≤ 24 s
     ─Whisper turbo Persian fine-tune (ONNX, WebGPU q4f16 / WASM q8, Transformers.js)
       plain-text decoding + cross-attention word alignment → timed words
     ─Persian cleanup (ی/ک, digits, «می‌», «‌ها», punctuation, junk/loop filter)
     ─subtitle rules (≤42 chars × 2 lines, ≤6 s, breaks at punctuation/conjunctions/pauses)
     ─SRT/VTT with RLM marks so punctuation sits on the correct side in every player
```

- Accuracy (this exact code run in Node.js, q8): word error rate 9.7% on a 5-minute Persian recording,
  14% on FLEURS sentences, 24% on noisy Common Voice clips. Long cues stay ≤ 42 chars per line and ≤ 6 s.
- Speech detection: Silero VAD (`onnx-community/silero-vad`, 2 MB) on a volume-levelled copy of the audio.
- Model: [`givia/whisper-large-v3-turbo-persian`](https://huggingface.co/givia/whisper-large-v3-turbo-persian) (CC-BY-4.0),
  converted for the browser to [`mehrshadjavid/whisper-large-v3-turbo-persian-ONNX`](https://huggingface.co/mehrshadjavid/whisper-large-v3-turbo-persian-ONNX).
- Source: `zirnevis-web/` in [MehrshadCHan2/doprax-xray](https://github.com/MehrshadCHan2/doprax-xray). Tests: `node --test tests/*.test.mjs`.
