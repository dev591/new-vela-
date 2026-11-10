"""The optional demo patient sign-in: off by default, exact match only, never opens another patient."""
import asyncio

import main


def _login(email, password):
    return asyncio.run(main.patient_login({"email": email, "password": password}))


def test_demo_login_is_off_without_a_server_password(monkeypatch):
    monkeypatch.setattr(main, "DEMO_PATIENT_PASSWORD", "")
    monkeypatch.setattr(main, "_supabase_password_ok", lambda e, p: False)
    assert _login("patient@vela.ai", "anything")["status"] == "error"


def test_demo_login_needs_the_exact_password(monkeypatch):
    monkeypatch.setattr(main, "DEMO_PATIENT_PASSWORD", "right-one")
    monkeypatch.setattr(main, "_supabase_password_ok", lambda e, p: False)
    assert _login("patient@vela.ai", "wrong")["status"] == "error"


def test_demo_login_opens_only_the_seeded_patient(monkeypatch):
    monkeypatch.setattr(main, "DEMO_PATIENT_PASSWORD", "right-one")
    monkeypatch.setattr(main, "seed_demo_patient",
                        lambda: {"patient": {"id": "p1", "name": "Rajesh Kumar", "vela_id": "VLA-8888",
                                             "email": "patient@vela.ai"}})
    ok = _login("Patient@Vela.ai", "right-one")
    assert ok["status"] == "success" and ok["vela_id"] == "VLA-8888" and ok["token"]
    monkeypatch.setattr(main, "_supabase_password_ok", lambda e, p: False)
    assert _login("someone.else@example.com", "right-one")["status"] == "error"
