"""Kiosk triage and language rules (gnani_voice.py). No network: these are pure functions."""
import pytest

import gnani_voice as g


@pytest.mark.parametrize("text", [
    "मुझे सीने में दर्द हो रहा है और सांस नहीं आ रही है।",     # Devanagari, with the danda
    "मुझे सीने मे दर्द है",                                        # matra variant
    "मुझे साँस लेने में तकलीफ है",                                 # chandrabindu spelling
    "mujhe seene mein dard ho raha hai",                           # Roman Hindi
    "Mere pita behosh ho gaye",                                    # Roman, unconscious
    "पापा बेहोश हो गए हैं",                                          # Devanagari, unconscious
    "I have chest pain!",                                          # English, punctuation
    "He can't breathe",                                            # apostrophe stripped
    "मेरा blood pressure बहुत high है और chest pain भी है",         # code-mixed
    "saans nahi aa rahi",
    "There was an accident on the road",
])
def test_emergency_phrases(text):
    assert g.is_emergency(text)


@pytest.mark.parametrize("text", [
    "मुझे दो दिन से बुखार और खांसी है",
    "I have a bad headache since morning",
    "My stomach pain is getting worse, please give me a token",
    "मेरा blood pressure बहुत high है, मुझे doctor से appointment चाहिए",
    "mujhe appointment book karna hai",
    "my mother-in-law is waiting outside",      # सास (mother-in-law) must not trigger "saans"
    "मेरी सास बाहर बैठी हैं",
])
def test_routine_phrases(text):
    assert not g.is_emergency(text)


def test_keywords_only_match_at_word_start():
    assert not g.is_emergency("benefits of the scheme")      # "fits" inside a word
    assert g.is_emergency("she is having fits")


@pytest.mark.parametrize("text,lang", [
    ("मुझे बुखार है", "hi-IN"),
    ("मुझे doctor से मिलना है", "hi-en"),
    ("I have a headache", "en-IN"),
])
def test_reply_language(text, lang):
    assert g.reply_language(text) == lang


def test_normalize_strips_danda_and_punctuation():
    assert g.normalize("सांस नहीं आ रही है।") == "सांस नहीं आ रही है"
    assert g.normalize("Can't  breathe!!") == "cant breathe"


def test_every_language_has_every_canned_line():
    for table in (g.FILLERS, g.ACK, g.TOKEN, g.VOICES):
        assert set(table) == {"hi-IN", "hi-en", "en-IN"}
    for routine, emergency in g.TOKEN.values():
        assert "{n}" in routine and "{n}" in emergency
