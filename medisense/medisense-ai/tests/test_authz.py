"""Authorization rules: who may call which route on which record."""
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

import authz
import main

HOSP_A = "11111111-1111-1111-1111-111111111111"
HOSP_B = "22222222-2222-2222-2222-222222222222"
PAT_ME = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
PAT_OTHER = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

PATIENT = {"role": "patient", "staff_id": PAT_ME, "vela_id": "VLA-1234", "email": "me@example.com"}
DOCTOR_A = {"role": "doctor", "staff_id": "doc-a", "hospital_id": HOSP_A}
MANAGER_A = {"role": "hospital_manager", "hospital_id": HOSP_A}
RECEPTION_A = {"role": "receptionist", "staff_id": "rec-a", "hospital_id": HOSP_A}
NETWORK_LAB = {"role": "lab_controller", "network_lab_id": "lab-1"}
OWNER = {"role": "vela_owner"}


def allowed(session, method, template, path_params=None, fields=None):
    try:
        authz.check_access(session, method, template, path_params or {}, fields or {})
        return True
    except HTTPException as e:
        assert e.status_code == 403
        return False


@pytest.fixture
def fake_records(monkeypatch):
    """Resolvers backed by an in-memory table instead of the database."""
    records = {
        ("appointment", "apt-mine"): {"patient_id": PAT_ME, "hospital_id": HOSP_A},
        ("appointment", "apt-other"): {"patient_id": PAT_OTHER, "hospital_id": HOSP_A},
        ("appointment", "apt-b"): {"patient_id": PAT_OTHER, "hospital_id": HOSP_B},
        ("lab_order", "ord-mine"): {"patient_id": PAT_ME, "hospital_id": HOSP_A, "network_lab_id": None},
        ("lab_order", "ord-other"): {"patient_id": PAT_OTHER, "hospital_id": HOSP_A, "network_lab_id": None},
        ("lab_order", "ord-routed"): {"patient_id": PAT_OTHER, "hospital_id": None, "network_lab_id": "lab-1"},
        ("document", "doc-other"): {"patient_id": PAT_OTHER},
        ("staff", "staff-b"): {"hospital_id": HOSP_B},
        ("ward", "ward-b"): {"hospital_id": HOSP_B},
    }
    resolvers = {}
    for kind in {k for k, _ in records}:
        resolvers[kind] = (lambda kind: lambda v: records.get((kind, v)))(kind)
    monkeypatch.setattr(authz, "_RESOLVERS", resolvers)
    return records


# ── Policy coverage ──

def test_every_route_has_a_policy():
    skip = {"/openapi.json", "/docs", "/docs/oauth2-redirect", "/redoc"}
    routes = {
        (m, r.path)
        for r in main.fastapi_app.routes
        if getattr(r, "methods", None) and r.path not in skip
        for m in r.methods if m != "HEAD"
    }
    assert sorted(routes - set(authz.POLICY)) == []
    assert sorted(set(authz.POLICY) - routes) == []


def test_unknown_route_is_denied():
    assert not allowed(OWNER, "GET", "/api/not-in-policy")


# ── Roles ──

def test_patient_cannot_list_all_patients():
    assert not allowed(PATIENT, "GET", "/api/patients/list")


def test_patient_cannot_use_staff_tools():
    for method, path in [
        ("POST", "/api/lab/reports/submit"),
        ("POST", "/api/discharge/confirm"),
        ("POST", "/api/mem0/wipe-patient"),
        ("GET", "/api/audit-log"),
    ]:
        assert not allowed(PATIENT, method, path), path


def test_wipe_and_seed_are_owner_only():
    assert not allowed(DOCTOR_A, "POST", "/api/mem0/wipe-patient")
    assert allowed(OWNER, "POST", "/api/mem0/wipe-patient")


def test_manager_role_name_matches_tokens():
    # Tokens say "hospital_manager"; the old check compared to "manager".
    assert allowed(MANAGER_A, "GET", "/api/audit-log")


def test_only_owner_verifies_solo_doctors():
    assert not allowed(MANAGER_A, "PATCH", "/api/network/doctors/{doctor_id}/verify", {"doctor_id": "x"})
    assert allowed(OWNER, "PATCH", "/api/network/doctors/{doctor_id}/verify", {"doctor_id": "x"})


# ── Patient ownership ──

def test_patient_reads_only_own_record_by_path():
    assert allowed(PATIENT, "GET", "/api/appointments/patient/{patient_id}", {"patient_id": PAT_ME})
    assert not allowed(PATIENT, "GET", "/api/appointments/patient/{patient_id}", {"patient_id": PAT_OTHER})


def test_patient_body_patient_id_must_be_own():
    assert allowed(PATIENT, "POST", "/api/appointments/book", fields={"patient_id": PAT_ME})
    assert not allowed(PATIENT, "POST", "/api/appointments/book", fields={"patient_id": PAT_OTHER})


def test_patient_vela_id_and_email_must_be_own():
    assert allowed(PATIENT, "GET", "/api/receptionist/lookup/{vela_id}", {"vela_id": "vla-1234"})
    assert not allowed(PATIENT, "GET", "/api/receptionist/lookup/{vela_id}", {"vela_id": "VLA-9999"})
    assert not allowed(PATIENT, "GET", "/api/patient/by-email/{email}", {"email": "victim@example.com"})


def test_patient_records_by_id_must_be_own(fake_records):
    assert allowed(PATIENT, "GET", "/api/appointments/queue/{appointment_id}", {"appointment_id": "apt-mine"})
    assert not allowed(PATIENT, "GET", "/api/appointments/queue/{appointment_id}", {"appointment_id": "apt-other"})
    assert not allowed(PATIENT, "DELETE", "/api/upload/document/{doc_id}", {"doc_id": "doc-other"})


def test_patient_cannot_pay_someone_elses_orders(fake_records):
    assert allowed(PATIENT, "POST", "/api/lab/orders/pay", fields={"order_ids": ["ord-mine"]})
    assert not allowed(PATIENT, "POST", "/api/lab/orders/pay", fields={"order_ids": ["ord-mine", "ord-other"]})


# ── Hospital scoping ──

def test_staff_cannot_name_another_hospital():
    assert allowed(MANAGER_A, "GET", "/api/manager/command-center/{hospital_id}", {"hospital_id": HOSP_A})
    assert not allowed(MANAGER_A, "GET", "/api/manager/command-center/{hospital_id}", {"hospital_id": HOSP_B})
    assert not allowed(DOCTOR_A, "GET", "/api/patients/list", fields={"hospital_id": HOSP_B})


def test_placeholder_hospital_ids_are_left_to_the_handler():
    # "VLA-MAIN" is mapped to the session's own hospital by scoped_hospital_id().
    assert allowed(MANAGER_A, "GET", "/api/wards", fields={"hospital_id": "VLA-MAIN"})


def test_staff_cannot_touch_other_hospitals_records(fake_records):
    assert allowed(RECEPTION_A, "POST", "/api/appointments/{appointment_id}/accept", {"appointment_id": "apt-other"})
    assert not allowed(RECEPTION_A, "POST", "/api/appointments/{appointment_id}/accept", {"appointment_id": "apt-b"})
    assert not allowed(MANAGER_A, "DELETE", "/api/manager/staff/{staff_id}", {"staff_id": "staff-b"})
    assert not allowed(MANAGER_A, "DELETE", "/api/wards/{ward_id}", {"ward_id": "ward-b"})


def test_network_lab_sees_only_its_routed_orders(fake_records):
    assert allowed(NETWORK_LAB, "POST", "/api/lab/orders/{order_id}/accept", {"order_id": "ord-routed"})
    assert not allowed(NETWORK_LAB, "POST", "/api/lab/orders/{order_id}/accept", {"order_id": "ord-other"})


def test_doctor_manages_only_own_queue():
    assert allowed(DOCTOR_A, "POST", "/api/doctor/next-patient", fields={"doctor_id": "doc-a"})
    assert not allowed(DOCTOR_A, "POST", "/api/doctor/next-patient", fields={"doctor_id": "doc-b"})


def test_scoped_hospital_id_prefers_session():
    token = authz.current_session.set(MANAGER_A)
    try:
        assert authz.scoped_hospital_id(HOSP_B) == HOSP_A
        assert authz.scoped_hospital_id("VLA-MAIN") == HOSP_A
    finally:
        authz.current_session.reset(token)
    assert authz.scoped_hospital_id("VLA-MAIN") == "VLA-MAIN"


# ── End to end through the app ──

client = TestClient(main.fastapi_app)


def bearer(session_kwargs):
    return {"Authorization": f"Bearer {main.issue_session_token(**session_kwargs)}"}


def test_no_token_is_401():
    assert client.get("/api/patients/list").status_code == 401


def test_patient_token_cannot_list_patients():
    h = bearer({"role": "patient", "name": "Me", "staff_id": PAT_ME})
    r = client.get("/api/patients/list", headers=h)
    assert r.status_code == 403
    assert r.json()["status"] == "error"


def test_patient_token_cannot_open_another_patient():
    h = bearer({"role": "patient", "name": "Me", "staff_id": PAT_ME})
    assert client.get(f"/api/patients/{PAT_OTHER}", headers=h).status_code == 403
    assert client.get(f"/api/admissions/patient/{PAT_OTHER}", headers=h).status_code == 403


def test_manager_cannot_open_other_hospital_console():
    h = bearer({"role": "hospital_manager", "name": "M", "hospital_id": HOSP_A})
    assert client.get(f"/api/manager/command-center/{HOSP_B}", headers=h).status_code == 403
