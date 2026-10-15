from zirnevis.segment import Cue, Style, build_cues, rewrap, wrap
from zirnevis.text import Word


def timed(text, start=0.0, step=0.35, gap_after=None):
    """Words spoken evenly; gap_after={index: seconds} inserts pauses."""
    gap_after = gap_after or {}
    out, t = [], start
    for i, w in enumerate(text.split()):
        out.append(Word(t, t + step - 0.05, w))
        t += step + gap_after.get(i, 0)
    return out


def test_every_cue_respects_limits():
    style = Style()
    text = " ".join(["این یک جمله نسبتا بلند است که باید شکسته شود"] * 6)
    cues = build_cues(timed(text), style)
    for c in cues:
        assert len(c.lines) <= style.max_lines
        assert all(len(line) <= style.max_line_chars for line in c.lines)
        assert c.end - c.start <= style.max_duration + style.linger + 0.01


def test_no_words_lost_or_reordered():
    text = "من خیلی بهتون علاقه دارم و ازتون میخوام که اگه شما هم منو میپسندین و بهم علاقه دارین بیشتر آشنا بشیم"
    cues = build_cues(timed(text))
    assert " ".join(c.text for c in cues) == text


def test_long_pause_starts_new_cue():
    cues = build_cues(timed("سلام خوبی چه خبر", gap_after={1: 1.5}))
    assert [c.text for c in cues] == ["سلام خوبی", "چه خبر"]


def test_sentence_end_closes_cue():
    cues = build_cues(timed("امروز هوا خیلی خوب بود. فردا میریم کوه"))
    assert cues[0].text == "امروز هوا خیلی خوب بود."


def test_prefers_break_before_conjunction():
    text = "من خیلی بهتون علاقه دارم و ازتون میخوام که اگه شما هم منو میپسندین و بهم علاقه دارین بیشتر آشنا بشیم"
    cues = build_cues(timed(text))
    assert any(c.text.startswith(("که", "و")) for c in cues[1:])


def test_timing_no_overlap_and_min_duration():
    style = Style()
    words = [Word(0.0, 0.2, "بله."), Word(0.5, 0.7, "نه."), Word(3.0, 3.3, "شاید.")]
    cues = build_cues(words, style, duration=4.0)
    for a, b in zip(cues, cues[1:]):
        assert a.end <= b.start - style.min_gap + 1e-9
    assert cues[-1].end - cues[-1].start >= style.min_duration - 1e-9
    assert cues[-1].end <= 4.0


def test_overlapping_word_times_are_repaired():
    words = [Word(0.0, 2.0, "این جمله اول است."), Word(1.5, 3.0, "این جمله دوم است.")]
    cues = build_cues(words)
    assert cues[0].end < cues[1].start


def test_wrap_balances_lines():
    lines = wrap("حال مدیرعامل فوت هولز، جان مکی و هیئت مدیره نمیخواستند خود را به آمازون بفروشند.", Style())
    assert len(lines) == 2
    assert all(len(l) <= 42 for l in lines)


def test_short_text_single_line():
    assert wrap("سلام خوبی؟", Style()) == ["سلام خوبی؟"]


def test_rewrap_after_edit():
    cues = rewrap([Cue(0, 2, ["متن ویرایش شده که خیلی خیلی بلند است و باید دو خط شود حتما"]), Cue(2, 3, [" "])])
    assert len(cues) == 1 and len(cues[0].lines) == 2
