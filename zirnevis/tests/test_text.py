from zirnevis.text import ZWNJ, Word, clean_words, is_junk, is_stutter, normalize_chars, tidy_line


def words(*texts, step=0.5):
    return [Word(i * step, i * step + 0.4, t) for i, t in enumerate(texts)]


def test_arabic_letters_and_digits():
    assert normalize_chars("كتاب يك 12") == "کتاب یک ۱۲"
    assert normalize_chars("۱۲ ٣", digits="en") == "12 3"
    assert normalize_chars("سلام?") == "سلام؟"
    assert normalize_chars("1,000") == "۱,۰۰۰"


def test_diacritics_removed():
    assert normalize_chars("کِتابٌ") == "کتاب"


def test_mi_prefix_joined_with_zwnj_and_timing_kept():
    out = clean_words(words("من", "می", "خوام", "برم"))
    assert [w.text for w in out] == ["من", f"می{ZWNJ}خوام", "برم"]
    assert out[1].start == 0.5 and out[1].end == 1.4


def test_plural_and_heh_suffixes():
    out = clean_words(words("کتاب", "ها", "را", "خوانده", "اند"))
    assert [w.text for w in out] == [f"کتاب{ZWNJ}ها", "را", f"خوانده{ZWNJ}اند"]


def test_heh_suffix_only_after_heh():
    out = clean_words(words("ای", "خدا", "و", "ای", "کاش"))
    assert [w.text for w in out] == ["ای", "خدا", "و", "ای", "کاش"]


def test_no_join_across_sentence_end():
    out = clean_words(words("رفتم.", "ها", "چی؟"))
    assert out[0].text == "رفتم." and out[1].text == "ها"


def test_lone_punctuation_attaches_to_previous_word():
    out = clean_words(words("سلام", "،", "خوبی", "?"))
    assert [w.text for w in out] == ["سلام،", "خوبی؟"]


def test_opening_quote_attaches_to_next_word():
    out = clean_words(words("گفت", "«", "نه", "»"))
    assert [w.text for w in out] == ["گفت", "«نه»"]


def test_tidy_line():
    assert tidy_line("سلام ،  خوبی ؟") == "سلام، خوبی؟"
    assert tidy_line("« نه »") == "«نه»"


def test_junk_and_stutter():
    assert is_junk("موسیقی")
    assert is_junk("[موسیقی]")
    assert not is_junk("موسیقی خوبی بود")
    assert is_stutter("میدیدیدیدید")
    assert not is_stutter("دیدید")
    assert not is_stutter("می‌خواهم")
