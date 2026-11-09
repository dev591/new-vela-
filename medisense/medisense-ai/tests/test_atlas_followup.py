"""Atlas follow-ups: a spoken "okay" must answer Atlas's own question, not start a new conversation."""
import asyncio
import time

import pytest

import main


@pytest.mark.parametrize("text,expected", [
    ("okay", "yes"), ("Yes please do", "yes"), ("haan kar do", "yes"), ("हाँ", "yes"), ("ठीक है", "yes"),
    ("sure, go ahead", "yes"),
    ("no", "no"), ("no don't", "no"), ("nahi", "no"), ("नहीं", "no"), ("wait", "no"), ("cancel that", "no"),
    ("what is his hemoglobin", None),                               # a real question, not an answer
    ("okay so what about his kidney function and creatinine trend", None),   # too long to be a yes/no
    ("", None),
])
def test_yes_or_no(text, expected):
    assert main.yes_or_no(text) == expected


def _pending():
    return {"expires": time.time() + 60, "summary": "ICU ward, Bed ICU-01", "patient_message": "Please come to reception.",
            "payload": {"patient_id": "p1", "patient_name": "Rajesh Kumar", "ward_name": "ICU"}}


def _run(session, text, monkeypatch):
    sent = []

    async def fake_emit(event, data=None, **kw):
        sent.append(event)
    monkeypatch.setattr(main.sio, "emit", fake_emit)
    return asyncio.run(main.handle_pending(session, text)), sent


def test_yes_notifies_reception_and_patient_once(monkeypatch):
    session = {"messages": [], "pending": _pending()}
    reply, sent = _run(session, "okay", monkeypatch)
    assert sent == ["admission_recommended", "admission_recommended_patient"]
    assert "ICU ward, Bed ICU-01" in reply["answer"] and session["pending"] is None
    assert session["messages"][-1]["role"] == "assistant"            # remembered for later turns
    again, sent2 = _run(session, "okay", monkeypatch)                # nothing pending any more
    assert again is None and sent2 == []


def test_no_cancels_without_notifying(monkeypatch):
    session = {"messages": [], "pending": _pending()}
    reply, sent = _run(session, "no wait", monkeypatch)
    assert sent == [] and reply["intent"] == "admission_cancelled" and session["pending"] is None


def test_unrelated_question_is_not_swallowed(monkeypatch):
    session = {"messages": [], "pending": _pending()}
    reply, sent = _run(session, "what is his hemoglobin", monkeypatch)
    assert reply is None and sent == [] and session["pending"] is not None   # still waiting


def test_expired_question_is_dropped(monkeypatch):
    session = {"messages": [], "pending": {**_pending(), "expires": time.time() - 1}}
    reply, _ = _run(session, "okay", monkeypatch)
    assert reply is None and session["pending"] is None
