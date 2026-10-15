---
title: Zirnevis - Persian Subtitles
emoji: 🎬
colorFrom: green
colorTo: blue
sdk: docker
app_port: 7860
pinned: false
license: mit
short_description: Drop a clip, get clean Persian SRT subtitles. Free, CPU only.
---

# زیرنویس فارسی خودکار (Zirnevis) — نسخه سرور

ویدیو یا صدا را بفرستید، زیرنویس فارسی دقیق و تمیز (SRT) بگیرید. بدون کارت گرافیک.

> **نکته:** Hugging Face در حال حاضر اجرای Spaceهای Docker/Gradio را حتی روی CPU رایگان فقط برای حساب PRO
> ($9 در ماه) مجاز می‌داند. نسخه رایگان و بدون سرور این برنامه در پوشه [`zirnevis-web`](../zirnevis-web) است
> (مدل داخل مرورگر کاربر اجرا می‌شود). این نسخه سرور برای اجرا روی کامپیوتر خودتان، یک سرور، یا Space با PRO است.

## کاربر چه می‌بیند

1. فایل را روی صفحه رها می‌کند.
2. دکمه «ساخت زیرنویس» را می‌زند (یک دقیقه ویدیو حدود یک دقیقه طول می‌کشد).
3. ویدیو را با زیرنویس روی صفحه می‌بیند و اگر کلمه‌ای اشتباه است همان‌جا درستش می‌کند.
4. فایل `srt` را دانلود می‌کند (برای VLC، پریمیر، کپ‌کات، یوتیوب و …).

## راه‌اندازی رایگان روی Hugging Face (بدون برنامه‌نویسی)

1. در [huggingface.co](https://huggingface.co/join) حساب رایگان بسازید.
2. بالای سایت: **New → Space**.
   - نام: مثلا `zirnevis`
   - **Space SDK: Docker** و قالب **Blank**
   - سخت‌افزار: **CPU basic (رایگان)**
   - **Create Space** را بزنید.
3. در صفحه Space به **Files → Add file → Upload files** بروید و **همه فایل‌ها و پوشه‌های داخل پوشه `zirnevis`** را رها کنید
   (`app.py`، `Dockerfile`، `README.md`، `requirements.txt`، `.dockerignore` و پوشه‌های `zirnevis` و `scripts`).
   سپس **Commit changes** را بزنید.
4. Hugging Face خودش برنامه را می‌سازد (بار اول حدود ۱۰ تا ۱۵ دقیقه). وقتی وضعیت **Running** شد، سایت شما آماده است:
   `https://huggingface.co/spaces/<نام-کاربری>/zirnevis`

نکته‌ها:
- اگر چند روز کسی از سایت استفاده نکند، می‌خوابد. اولین بازدیدکننده بعدی حدود یک دقیقه صبر می‌کند تا بیدار شود.
- در هر لحظه یک فایل پردازش می‌شود و بقیه در صف می‌مانند.
- حداکثر طول فایل ۲۰ دقیقه است. برای تغییرش در **Settings → Variables** متغیر `ZIRNEVIS_MAX_MINUTES` را بسازید.

---

## How it works (technical)

```
clip ─ffmpeg→ 16 kHz mono ─Silero VAD (on volume-levelled copy)→ speech pieces ≤ 24 s
     ─faster-whisper (Persian fine-tune, int8 CPU)→ timed words
     ─Persian cleanup (ي/ك→ی/ک, digits, «می‌», «‌ها», punctuation, junk/loop filter)
     ─subtitle rules (≤42 chars × 2 lines, ≤6 s, breaks at punctuation/conjunctions/pauses)
     ─SRT/VTT with RLM marks so punctuation sits on the correct side in every player
```

- **Model:** [`givia/whisper-large-v3-turbo-persian`](https://huggingface.co/givia/whisper-large-v3-turbo-persian) (CC-BY-4.0),
  converted to CTranslate2 int8 when the image is built. On our Persian test set it made about half the errors of the stock
  `whisper-large-v3-turbo` (FLEURS WER 10% vs 23%; Common Voice 20% vs 38%) at the same speed.
- **Speed:** about real time on the free 2-vCPU Space (a 1-minute clip takes ~1 minute).
- The fine-tune works best on one piece of speech at a time without timestamp tokens, so the app cuts audio at pauses
  and decodes each piece exactly once; word times come from Whisper's alignment step.

### Run locally

```bash
pip install -r requirements.txt
pip install torch --index-url https://download.pytorch.org/whl/cpu transformers
python scripts/convert_model.py givia/whisper-large-v3-turbo-persian ./models/whisper-fa
ZIRNEVIS_MODEL=./models/whisper-fa python app.py      # http://localhost:7860
```

Or with Docker: `docker build -t zirnevis . && docker run -p 7860:7860 zirnevis`

### Tests

```bash
pip install pytest && python -m pytest tests
```

### Settings (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `ZIRNEVIS_MODEL` | `/models/whisper-fa` | Path or Hugging Face id of a CTranslate2 Whisper model |
| `ZIRNEVIS_MAX_MINUTES` | `20` | Longest clip accepted |
| `PORT` | `7860` | Web server port |
