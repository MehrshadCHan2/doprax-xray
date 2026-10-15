"""زیرنویس — web app: drop a clip, get a clean Persian SRT."""

from __future__ import annotations

import os
import re
import shutil
import tempfile
import threading
import time

import gradio as gr

from zirnevis.asr import DEFAULT_MODEL, Transcriber
from zirnevis.audio import MediaError, probe
from zirnevis.pipeline import make_cues
from zirnevis.segment import Cue, Style, rewrap
from zirnevis.subtitles import format_ts, parse_ts, to_srt, to_text, to_vtt, write

MAX_MINUTES = float(os.environ.get("ZIRNEVIS_MAX_MINUTES", "20"))
PREVIEW_EXT = {".mp4", ".m4v", ".webm", ".mov"}
DIGITS = {"فارسی (۱۲۳)": "fa", "انگلیسی (123)": "en"}

_model: Transcriber | None = None
_model_lock = threading.Lock()


def get_model() -> Transcriber:
    global _model
    with _model_lock:
        if _model is None:
            _model = Transcriber(DEFAULT_MODEL)
    return _model


def fa_num(value) -> str:
    return str(value).translate(str.maketrans("0123456789.", "۰۱۲۳۴۵۶۷۸۹٫"))


KEEP_SECONDS = 3600  # uploads and results are deleted after an hour


def _cleanup_old_results() -> None:
    root = tempfile.gettempdir()
    for name in os.listdir(root):
        path = os.path.join(root, name)
        if name.startswith("zirnevis-") and time.time() - os.path.getmtime(path) > KEEP_SECONDS:
            shutil.rmtree(path, ignore_errors=True)


def _stem(path: str) -> str:
    name = os.path.splitext(os.path.basename(path))[0]
    return re.sub(r"[^\w\-]+", "_", name).strip("_") or "subtitle"


def _outputs(cues: list[Cue], state: dict, bom: bool):
    """Write the files and build everything the page shows."""
    folder = state["dir"]
    stem = state["stem"]
    srt = write(os.path.join(folder, f"{stem}.fa.srt"), to_srt(cues), bom=bom)
    vtt = write(os.path.join(folder, f"{stem}.fa.vtt"), to_vtt(cues))
    txt = write(os.path.join(folder, f"{stem}.fa.txt"), to_text(cues), bom=bom)
    rows = [[format_ts(c.start), format_ts(c.end), c.text] for c in cues]
    preview = gr.Video(value=state["path"], subtitles=vtt) if state["preview"] else gr.Video(value=None)
    return [srt, vtt, txt], rows, preview


def generate(file, digits_label, line_chars, bom, progress=gr.Progress()):
    if not file:
        raise gr.Error("اول یک ویدیو یا فایل صوتی انتخاب کنید.")
    path = file if isinstance(file, str) else file.name
    try:
        info = probe(path)
    except MediaError as e:
        raise gr.Error(str(e))
    if not info["has_audio"]:
        raise gr.Error("این فایل صدا ندارد.")
    if info["duration"] > MAX_MINUTES * 60:
        raise gr.Error(f"حداکثر طول فایل {MAX_MINUTES:g} دقیقه است. لطفا فایل کوتاه‌تری بفرستید.")

    _cleanup_old_results()
    progress(0, desc="در حال آماده شدن…")
    model = get_model()
    started = time.time()
    try:
        result = make_cues(
            path,
            model,
            Style(max_line_chars=int(line_chars)),
            digits=DIGITS.get(digits_label, "fa"),
            progress=lambda f: progress(f, desc="در حال شنیدن و نوشتن…"),
        )
    except MediaError as e:
        raise gr.Error(str(e))
    if not result.cues:
        raise gr.Error("گفتار فارسی در این فایل پیدا نشد.")

    state = {
        "path": path,
        "stem": _stem(path),
        "dir": tempfile.mkdtemp(prefix="zirnevis-"),
        "preview": info["has_video"] and os.path.splitext(path)[1].lower() in PREVIEW_EXT,
    }
    files, rows, preview = _outputs(result.cues, state, bom)
    took = time.time() - started
    status = (
        f"✅ آماده است: {fa_num(len(result.cues))} زیرنویس برای "
        f"{fa_num(f'{result.duration / 60:.1f}')} دقیقه صدا، در {fa_num(f'{took:.0f}')} ثانیه.\n\n"
        "اگر کلمه‌ای اشتباه است، در جدول پایین درستش کنید و «ذخیره تغییرات» را بزنید."
    )
    return status, files, rows, preview, state


def apply_edits(rows, state, line_chars, bom):
    if not state:
        raise gr.Error("اول زیرنویس بسازید.")
    cues = []
    for i, row in enumerate(rows or [], 1):
        if len(row) < 3 or not str(row[2] or "").strip():
            continue
        try:
            start, end = parse_ts(row[0]), parse_ts(row[1])
        except ValueError:
            raise gr.Error(f"زمان ردیف {i} درست نیست. شکل درست: 00:01:02,500")
        if end <= start:
            raise gr.Error(f"در ردیف {i} زمان پایان باید بعد از زمان شروع باشد.")
        cues.append(Cue(start, end, [str(row[2])]))
    cues = rewrap(sorted(cues, key=lambda c: c.start), Style(max_line_chars=int(line_chars)))
    files, rows, preview = _outputs(cues, state, bom)
    return "✅ تغییرات ذخیره شد. فایل‌های جدید آماده دانلود است.", files, rows, preview


CSS = """
.gradio-container { direction: rtl; font-family: Vazirmatn, Tahoma, sans-serif !important; max-width: 980px !important; margin: auto; }
.gradio-container * { font-family: Vazirmatn, Tahoma, sans-serif !important; letter-spacing: normal !important; }
#title { text-align: center; }
#title h1 { margin-bottom: 0.2em; }
#status { min-height: 1.5em; }
.ltr, .ltr * { direction: ltr; }
/* Each cell picks its own direction: timestamps left-to-right, Persian right-to-left. */
#subs span.text { display: block; width: 100%; white-space: normal; overflow-wrap: anywhere; }
#subs span.text, #subs textarea, #subs input { unicode-bidi: plaintext; text-align: start; }
"""
HEAD = (
    '<meta name="viewport" content="width=device-width, initial-scale=1">'
    '<link rel="preconnect" href="https://fonts.googleapis.com">'
    '<link href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;600;800&display=swap" rel="stylesheet">'
)

with gr.Blocks(title="زیرنویس فارسی خودکار", delete_cache=(KEEP_SECONDS, KEEP_SECONDS)) as demo:
    state = gr.State(None)
    gr.Markdown(
        "# زیرنویس فارسی خودکار\n"
        "ویدیو یا صدای خود را بفرستید و زیرنویس فارسی دقیق و تمیز تحویل بگیرید. رایگان.",
        elem_id="title",
        rtl=True,
    )
    with gr.Row():
        with gr.Column(scale=3):
            media = gr.File(
                label="۱. فایل ویدیو یا صدا را اینجا رها کنید",
                file_types=["video", "audio"],
                type="filepath",
            )
            with gr.Accordion("تنظیمات (اختیاری)", open=False):
                digits = gr.Radio(list(DIGITS), value="فارسی (۱۲۳)", label="شکل اعداد")
                line_chars = gr.Slider(30, 50, value=42, step=1, label="حداکثر حرف در هر خط")
                bom = gr.Checkbox(value=True, label="سازگاری با پخش‌کننده‌های قدیمی ویندوز (UTF-8 BOM)")
            go = gr.Button("۲. ساخت زیرنویس", variant="primary", size="lg")
            status = gr.Markdown(elem_id="status", rtl=True)
            files = gr.File(label="۳. دانلود فایل‌ها", file_count="multiple", interactive=False)
            gr.Markdown(
                "<small>فایل <b>srt</b> برای پخش‌کننده‌ها، یوتیوب و نرم‌افزارهای تدوین است. "
                "<b>vtt</b> برای سایت‌ها و <b>txt</b> متن ساده است.</small>",
                rtl=True,
            )
        with gr.Column(scale=4):
            preview = gr.Video(label="پیش‌نمایش با زیرنویس", interactive=False, elem_classes="ltr")
    table = gr.Dataframe(
        headers=["شروع", "پایان", "متن"],
        datatype=["str", "str", "str"],
        column_count=3,
        show_row_numbers=True,
        interactive=True,
        wrap=True,
        type="array",
        label="ویرایش زیرنویس‌ها (روی هر خانه بزنید و اصلاح کنید)",
        elem_id="subs",
    )
    save = gr.Button("ذخیره تغییرات")
    gr.Markdown(
        "<small>فایل شما فقط برای ساخت زیرنویس استفاده می‌شود و حداکثر یک ساعت بعد پاک می‌شود. "
        "مدل تشخیص گفتار: [whisper-large-v3-turbo-persian](https://huggingface.co/givia/whisper-large-v3-turbo-persian) "
        "(CC-BY-4.0) بر پایه Whisper از OpenAI.</small>",
        rtl=True,
    )

    go.click(generate, [media, digits, line_chars, bom], [status, files, table, preview, state])
    save.click(apply_edits, [table, state, line_chars, bom], [status, files, table, preview])

if __name__ == "__main__":
    # Load the model while the page is already reachable.
    threading.Thread(target=get_model, daemon=True).start()
    demo.queue(default_concurrency_limit=1, max_size=20).launch(
        server_name="0.0.0.0",
        server_port=int(os.environ.get("PORT", "7860")),
        max_file_size="1gb",
        css=CSS,
        head=HEAD,
        theme=gr.themes.Soft(primary_hue="teal"),
    )
