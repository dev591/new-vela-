"""Audit-log tamper evidence, socket room routing, upload validation."""
import asyncio
import io
import sqlite3

import pytest
from starlette.datastructures import Headers, UploadFile

import authz
import main

HOSP_A = "11111111-1111-1111-1111-111111111111"


# ── Audit log ──

def test_audit_chain_detects_tampering():
    for i in range(3):
        main._write_audit({"role": "doctor", "name": "Dr", "hospital_id": HOSP_A},
                          "GET", f"/api/patients/{i}", 200, "127.0.0.1", "")
    assert main.verify_audit_log()["status"] == "intact"

    conn = sqlite3.connect(main.LOCAL_DB_PATH)
    row_id = conn.execute("SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET 1").fetchone()[0]
    conn.execute("UPDATE audit_log SET path = '/api/patients/edited' WHERE id = ?", (row_id,))
    conn.commit()
    conn.close()
    result = main.verify_audit_log()
    assert result["status"] == "broken"
    assert result["row_id"] == row_id


def test_break_glass_reason_is_recorded():
    main._write_audit({"role": "doctor"}, "GET", "/api/patients/x", 200, "", "ER: unconscious, no ID")
    conn = sqlite3.connect(main.LOCAL_DB_PATH)
    reason = conn.execute("SELECT reason FROM audit_log ORDER BY id DESC LIMIT 1").fetchone()[0]
    conn.close()
    assert reason == "ER: unconscious, no ID"


# ── Socket rooms ──

def test_emit_without_room_goes_to_hospital_and_patient_not_everyone():
    token = authz.current_session.set({"role": "receptionist", "hospital_id": HOSP_A})
    try:
        rooms = main._rooms_for_payload("patient_registered", {"patient_id": "p-1"})
    finally:
        authz.current_session.reset(token)
    assert rooms == [f"hospital:{HOSP_A}", "patient:p-1"]


def test_payload_hospital_wins_and_unscoped_goes_to_staff_only():
    assert main._rooms_for_payload("x", {"hospital_id": HOSP_A}) == [f"hospital:{HOSP_A}"]
    assert main._rooms_for_payload("x", {"message": "hi"}) == ["staff"]


def test_legacy_room_names_are_normalised():
    assert main._normalize_room(f"hospital_{HOSP_A}") == f"hospital:{HOSP_A}"
    assert main._normalize_room(HOSP_A) == f"hospital:{HOSP_A}"


def test_session_rooms():
    assert main._rooms_for_session({"role": "patient", "staff_id": "p-1"}) == ["patient:p-1", "patients"]
    assert main._rooms_for_session({"role": "doctor", "hospital_id": HOSP_A}) == ["staff", f"hospital:{HOSP_A}"]


def test_socket_connect_requires_token():
    import socketio
    with pytest.raises(socketio.exceptions.ConnectionRefusedError):
        asyncio.run(main.connect("sid-1", {}, {"token": "not-a-real-token"}))


# ── Uploads ──

def _upload(name, data):
    return UploadFile(file=io.BytesIO(data), filename=name, headers=Headers({}))


def test_upload_accepts_real_pdf():
    data = b"%PDF-1.4\n" + b"0" * 100
    assert asyncio.run(main.read_upload(_upload("r.pdf", data))) == data


@pytest.mark.parametrize("name,data", [
    ("r.exe", b"MZ..."),                 # wrong extension
    ("r.pdf", b"MZ\x90\x00not a pdf"),   # renamed binary
    ("r.png", b""),                      # empty
])
def test_upload_rejects_bad_files(name, data):
    with pytest.raises(main.UploadRejected):
        asyncio.run(main.read_upload(_upload(name, data)))


def test_upload_rejects_oversized(monkeypatch):
    monkeypatch.setattr(main, "MAX_UPLOAD_BYTES", 1024)
    with pytest.raises(main.UploadRejected):
        asyncio.run(main.read_upload(_upload("r.pdf", b"%PDF-" + b"0" * 4096)))
