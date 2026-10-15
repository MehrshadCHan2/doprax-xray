from zirnevis.segment import Cue
from zirnevis.subtitles import RLM, format_ts, parse_ts, to_srt, to_vtt, write


def test_srt_format():
    srt = to_srt([Cue(1.5, 3.25, ["سلام،", "خوبی؟"]), Cue(3661.0, 3662.0, ["خداحافظ."])])
    assert srt == (
        f"1\n00:00:01,500 --> 00:00:03,250\n{RLM}سلام،{RLM}\n{RLM}خوبی؟{RLM}\n\n"
        f"2\n01:01:01,000 --> 01:01:02,000\n{RLM}خداحافظ.{RLM}\n"
    )


def test_srt_without_marks():
    assert RLM not in to_srt([Cue(0, 1, ["سلام"])], rtl_marks=False)


def test_vtt_format():
    vtt = to_vtt([Cue(0, 1.2, ["سلام"])], rtl_marks=False)
    assert vtt.startswith("WEBVTT\n\n00:00:00.000 --> 00:00:01.200\nسلام\n")


def test_timestamp_round_trip():
    for s in (0, 0.001, 1.5, 59.999, 3725.25):
        assert abs(parse_ts(format_ts(s)) - s) < 0.001
    assert parse_ts("۰۰:۰۱:۰۲,۵") == 62.5
    assert parse_ts("1:02.5") == 62.5
    assert parse_ts("62.5") == 62.5


def test_bom(tmp_path):
    p = write(str(tmp_path / "a.srt"), "x", bom=True)
    assert open(p, "rb").read().startswith(b"\xef\xbb\xbf")
    p = write(str(tmp_path / "b.srt"), "x")
    assert open(p, "rb").read() == b"x"
