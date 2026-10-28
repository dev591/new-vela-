"""Per-route authorization.

The auth middleware in main.py only answers "is there a valid session?". This
module answers "may THIS session call THIS route on THIS record?" and runs as
an app-wide FastAPI dependency, so it sees the matched route template, path
params, query string and (already-parsed) body of every request.

Three checks, in order:

1. Role — every route must appear in POLICY. A route that is missing is
   refused (fail closed), and tests/test_authz.py fails the build for it.
2. Patient ownership — a patient session may only name its own patient_id /
   vela_id / email, and may only touch records (appointments, lab orders,
   documents …) that belong to it.
3. Tenant scoping — a session bound to a hospital may not name another
   hospital's id or touch another hospital's records. Independent labs and
   doctors are held to their own network_lab_id / network_doctor_id.

Record lookups are done by resolvers that main.py registers at import time
(register_resolver), so this module stays free of database code.
"""

from __future__ import annotations

import asyncio
import contextvars
import json
import uuid
from dataclasses import dataclass
from typing import Callable, Dict, Iterable, Optional

from fastapi import HTTPException, Request

# ── Roles ──
DOCTOR = frozenset({"doctor"})
NURSE = frozenset({"nurse"})
RECEPTION = frozenset({"receptionist"})
LAB = frozenset({"lab_controller", "lab"})
MANAGER = frozenset({"hospital_manager", "manager", "admin"})
OWNER = frozenset({"vela_owner"})
PATIENT = frozenset({"patient"})

CLINICIAN = DOCTOR | NURSE
FRONT = CLINICIAN | RECEPTION            # anyone running the patient flow
HOSPITAL_STAFF = FRONT | LAB | MANAGER   # anyone employed by a hospital
ANY_SESSION = HOSPITAL_STAFF | OWNER | PATIENT

# Sentinel: route needs no session at all (login, signup, health).
PUBLIC = frozenset({"__public__"})


@dataclass(frozen=True)
class Rule:
    roles: frozenset
    # Resource kind to resolve each path param against, when it differs from
    # the default in PARAM_RESOURCES (e.g. network appointment ids).
    resources: Optional[Dict[str, str]] = None
    # A hospital doctor calling this route may only name themselves as
    # doctor_id (their own queue, their own patient-completion).
    doctor_self: bool = False


def r(*groups: Iterable[str], resources: Optional[Dict[str, str]] = None, doctor_self: bool = False) -> Rule:
    roles: set = set()
    for g in groups:
        roles |= set(g)
    return Rule(frozenset(roles), resources, doctor_self)


_PUB = Rule(PUBLIC)

# (METHOD, route template) -> Rule. Keep grouped the way main.py is.
POLICY: Dict[tuple, Rule] = {
    # Public: no session exists yet, or nothing sensitive.
    ("GET", "/health"): _PUB,
    ("GET", "/api/health"): _PUB,
    ("POST", "/api/staff/login"): _PUB,
    ("POST", "/api/manager/login"): _PUB,
    ("POST", "/api/owner/login"): _PUB,
    ("POST", "/api/network/auth/login"): _PUB,
    ("POST", "/api/network/labs/auth/login"): _PUB,
    ("POST", "/api/network/doctors/auth/login"): _PUB,
    ("POST", "/api/patient/login"): _PUB,
    ("POST", "/api/patient/self-register"): _PUB,
    ("POST", "/api/demo/login-patient"): _PUB,

    # Session housekeeping
    ("POST", "/api/auth/logout"): r(ANY_SESSION),
    ("POST", "/api/staff/logout"): r(ANY_SESSION),
    ("GET", "/api/audit-log"): r(MANAGER, OWNER),
    ("GET", "/api/audit-log/verify"): r(MANAGER, OWNER),

    # Diagnostic demo model / symptom tools
    ("GET", "/api/diagnostic/symptoms"): r(HOSPITAL_STAFF),
    ("POST", "/api/diagnostic/predict"): r(CLINICIAN),
    ("POST", "/api/symptom/triage"): r(FRONT, PATIENT),

    # Patients
    ("GET", "/api/patient/qr/{vela_id}"): r(FRONT, PATIENT),
    ("PUT", "/api/patient/update/{patient_id}"): r(FRONT, PATIENT),
    ("POST", "/api/patient/{patient_id}/revisit"): r(PATIENT, RECEPTION),
    ("GET", "/api/patient/by-email/{email}"): r(RECEPTION, PATIENT),
    ("GET", "/api/patients/list"): r(CLINICIAN, MANAGER),
    ("GET", "/api/patients/emergency"): r(CLINICIAN, RECEPTION),
    ("GET", "/api/patients/search"): r(FRONT, MANAGER),
    ("GET", "/api/patients/{patient_id}"): r(FRONT, LAB),
    ("POST", "/api/patients/add"): r(FRONT),
    ("POST", "/api/receptionist/register"): r(FRONT),
    ("GET", "/api/receptionist/lookup/{vela_id}"): r(FRONT, LAB, PATIENT),

    # Documents / imaging
    ("POST", "/api/upload/document"): r(FRONT, LAB, PATIENT),
    ("DELETE", "/api/upload/document/{doc_id}"): r(FRONT, PATIENT),
    ("GET", "/api/documents/{document_id}/file"): r(FRONT, LAB, PATIENT),
    ("POST", "/api/imaging/analyze"): r(CLINICIAN, LAB),
    ("GET", "/api/imaging/patient/{patient_id}"): r(CLINICIAN, LAB),
    ("POST", "/api/imaging/{study_id}/review"): r(DOCTOR),
    ("DELETE", "/api/imaging/{study_id}"): r(DOCTOR),

    # Doctor workflow / Atlas
    ("POST", "/api/doctor/pre-analyze-next"): r(DOCTOR, doctor_self=True),
    ("POST", "/api/doctor/ambient-consult/process"): r(DOCTOR),
    ("POST", "/api/doctor/ambient-consult/approve"): r(DOCTOR),
    ("POST", "/api/voice/query"): r(HOSPITAL_STAFF, PATIENT),
    ("POST", "/api/voice/query/stream"): r(HOSPITAL_STAFF, PATIENT),
    ("POST", "/api/voice/complex"): r(CLINICIAN),
    ("POST", "/api/tts"): r(HOSPITAL_STAFF, PATIENT),
    ("POST", "/api/patient/history/query"): r(CLINICIAN),
    ("POST", "/api/patient/history/query/stream"): r(CLINICIAN),
    ("POST", "/api/patient/history/timeline"): r(CLINICIAN),
    ("POST", "/api/patient/history/progression/stream"): r(CLINICIAN),
    ("POST", "/api/medication/check"): r(CLINICIAN),
    ("POST", "/api/recommendations/get"): r(CLINICIAN),
    ("POST", "/api/medications/add"): r(CLINICIAN),
    ("POST", "/api/notes/add"): r(CLINICIAN),
    ("POST", "/api/reminders/add"): r(CLINICIAN),
    ("PUT", "/api/reminders/{reminder_id}/done"): r(CLINICIAN),
    ("POST", "/api/handover/generate"): r(CLINICIAN),
    ("POST", "/api/reports/compare"): r(CLINICIAN),
    ("POST", "/api/visit-report/generate"): r(DOCTOR),
    ("GET", "/api/visit-reports/{patient_id}"): r(FRONT, PATIENT),
    ("POST", "/api/reassess/request"): r(PATIENT, FRONT),
    ("POST", "/api/mem0/wipe-patient"): r(OWNER),
    ("POST", "/api/demo/seed-patient"): r(OWNER),

    # Appointments / queue
    ("POST", "/api/appointments/book"): r(PATIENT, RECEPTION),
    ("GET", "/api/hospitals/search"): r(ANY_SESSION),
    ("GET", "/api/appointments/today"): r(FRONT, MANAGER),
    ("POST", "/api/appointments/{appointment_id}/accept"): r(RECEPTION),
    ("POST", "/api/appointments/{appointment_id}/reject"): r(RECEPTION),
    ("POST", "/api/appointments/{appointment_id}/arrive"): r(RECEPTION),
    ("GET", "/api/appointments/queue/{appointment_id}"): r(FRONT, PATIENT),
    ("GET", "/api/appointments/patient/{patient_id}"): r(FRONT, PATIENT),
    ("POST", "/api/tickets/{ticket_id}/consult"): r(FRONT),
    ("POST", "/api/tickets/{ticket_id}/complete"): r(FRONT),
    ("POST", "/api/patients/{patient_id}/complete-consult"): r(CLINICIAN),
    ("GET", "/api/notifications/{role}"): r(HOSPITAL_STAFF),
    ("PUT", "/api/notifications/{notification_id}/read"): r(HOSPITAL_STAFF),
    ("POST", "/api/receptionist/ticket/create"): r(FRONT, PATIENT),
    ("GET", "/api/receptionist/queue"): r(FRONT, MANAGER),
    ("POST", "/api/doctor/next-patient"): r(DOCTOR, doctor_self=True),
    ("POST", "/api/doctor/complete-patient"): r(DOCTOR),
    ("GET", "/api/receptionist/doctors-status"): r(HOSPITAL_STAFF, PATIENT),
    ("PUT", "/api/receptionist/assign-doctor"): r(RECEPTION),
    ("GET", "/api/doctors/list"): r(HOSPITAL_STAFF),
    ("POST", "/api/receptionist/appointment/{appointment_id}/arrive"): r(RECEPTION),
    ("GET", "/api/doctor/{doctor_id}/queue-stats"): r(FRONT, MANAGER),
    ("POST", "/api/doctor/{doctor_id}/next-patient"): r(DOCTOR, doctor_self=True),

    # Hospital / wards / staff (management)
    ("GET", "/api/hospital/overview"): r(MANAGER),
    ("GET", "/api/wards"): r(HOSPITAL_STAFF),
    ("POST", "/api/wards"): r(MANAGER),
    ("POST", "/api/beds"): r(MANAGER),
    ("PUT", "/api/beds/{bed_id}/admit"): r(FRONT, MANAGER),
    ("PUT", "/api/wards/{ward_id}/position"): r(MANAGER),
    ("PUT", "/api/beds/{bed_id}/discharge"): r(FRONT, MANAGER),
    ("PUT", "/api/beds/{bed_id}/status"): r(FRONT, MANAGER),
    ("DELETE", "/api/wards/{ward_id}"): r(MANAGER),
    ("DELETE", "/api/beds/{bed_id}"): r(MANAGER),
    ("GET", "/api/staff/list"): r(MANAGER),
    ("POST", "/api/manager/add-staff"): r(MANAGER),
    ("GET", "/api/manager/staff/{hospital_id}"): r(MANAGER),
    ("DELETE", "/api/manager/staff/{staff_id}"): r(MANAGER),
    ("POST", "/api/manager/complete-walkthrough"): r(MANAGER),
    ("GET", "/api/manager/command-center/{hospital_id}"): r(MANAGER),
    ("POST", "/api/hospital/setup/complete"): r(MANAGER, OWNER),

    # Lab
    ("GET", "/api/lab/departments"): r(HOSPITAL_STAFF),
    ("GET", "/api/lab/catalog"): r(HOSPITAL_STAFF),
    ("POST", "/api/lab/catalog/entry"): r(RECEPTION, LAB, MANAGER),
    ("DELETE", "/api/lab/catalog/entry/{entry_id}"): r(RECEPTION, LAB, MANAGER),
    ("GET", "/api/lab/orders"): r(LAB),
    ("GET", "/api/lab/orders/completed"): r(LAB),
    ("GET", "/api/lab/orders/pending-payment"): r(RECEPTION, LAB),
    ("GET", "/api/lab/orders/awaiting-arrival"): r(RECEPTION, LAB),
    ("POST", "/api/lab/orders/{order_id}/arrive"): r(RECEPTION, LAB),
    ("GET", "/api/patient/{patient_id}/pending-payments"): r(PATIENT, RECEPTION),
    ("POST", "/api/lab/orders/{order_id}/pay"): r(PATIENT, RECEPTION),
    ("POST", "/api/lab/orders/pay"): r(PATIENT, RECEPTION),
    ("POST", "/api/lab/orders/pay-at-counter"): r(PATIENT),
    ("POST", "/api/lab/orders/{order_id}/payment"): r(RECEPTION, LAB),
    ("PATCH", "/api/lab/orders/{order_id}/cancel"): r(CLINICIAN, RECEPTION),
    ("PATCH", "/api/lab/orders/{order_id}/route"): r(CLINICIAN, PATIENT),
    ("POST", "/api/lab/orders/{order_id}/accept"): r(LAB),
    ("POST", "/api/lab/orders/{order_id}/start"): r(LAB),
    ("GET", "/api/lab/template/{test_type}"): r(LAB),
    ("GET", "/api/lab/templates"): r(LAB),
    ("POST", "/api/lab/templates"): r(LAB),
    ("DELETE", "/api/lab/templates/{template_id}"): r(LAB),
    ("POST", "/api/lab/reports/submit"): r(LAB),
    ("GET", "/api/lab/patient/{patient_id}"): r(FRONT, LAB, PATIENT),
    ("GET", "/api/lab/queue/{patient_id}"): r(FRONT, LAB, PATIENT),

    # Admissions / discharge
    ("POST", "/api/admissions/confirm"): r(RECEPTION),
    ("GET", "/api/room-types"): r(HOSPITAL_STAFF),
    ("GET", "/api/admissions/scan/{admission_qr}"): r(HOSPITAL_STAFF),
    ("GET", "/api/admissions/active"): r(FRONT, MANAGER),
    ("GET", "/api/admissions/patient/{patient_id}"): r(FRONT, PATIENT),
    ("GET", "/api/admissions/{admission_id}/cost"): r(RECEPTION, MANAGER),
    ("POST", "/api/discharge/summary/generate"): r(FRONT),
    ("POST", "/api/discharge/confirm"): r(RECEPTION),
    ("GET", "/api/history/patient/{patient_id}"): r(FRONT, PATIENT),
    ("GET", "/api/discharge/{discharge_id}"): r(FRONT, PATIENT),

    # Network (independent hospitals, labs, doctors)
    ("POST", "/api/network/hospitals/register"): r(OWNER),
    ("GET", "/api/network/hospitals"): r(ANY_SESSION),
    ("POST", "/api/network/appointments/book"): r(PATIENT, RECEPTION),
    ("GET", "/api/network/appointments"): r(RECEPTION),
    ("PATCH", "/api/network/appointments/{appointment_id}/arrive"): r(
        RECEPTION, resources={"appointment_id": "network_appointment"}),
    ("POST", "/api/network/labs/register"): r(OWNER),
    ("GET", "/api/network/labs"): r(ANY_SESSION),
    ("POST", "/api/network/doctors/register"): r(OWNER),
    ("GET", "/api/network/doctors"): r(ANY_SESSION),
    ("PATCH", "/api/network/doctors/{doctor_id}/verify"): r(
        OWNER, resources={"doctor_id": None}),
    ("POST", "/api/network/doctors/appointments/book"): r(PATIENT, RECEPTION),
    ("GET", "/api/network/doctors/appointments"): r(DOCTOR),
    ("PATCH", "/api/network/doctors/appointments/{appointment_id}/arrive"): r(
        DOCTOR, resources={"appointment_id": "network_doctor_appointment"}),

    # Owner console
    ("POST", "/api/owner/onboard-hospital"): r(OWNER),
    ("GET", "/api/owner/hospitals"): r(OWNER),
    ("GET", "/api/owner/stats"): r(OWNER),
}

# Path param -> resource kind its value names. Each kind has a resolver that
# returns {"patient_id", "hospital_id", "network_lab_id", "network_doctor_id"}
# (any subset) for the record, or None when the record doesn't exist.
PARAM_RESOURCES: Dict[str, str] = {
    "appointment_id": "appointment",
    "order_id": "lab_order",
    "doc_id": "document",
    "document_id": "generated_file",
    "admission_id": "admission",
    "admission_qr": "admission_qr",
    "discharge_id": "discharge",
    "ticket_id": "ticket",
    "bed_id": "bed",
    "ward_id": "ward",
    "study_id": "imaging_study",
    "reminder_id": "reminder",
    "notification_id": "notification",
    "template_id": "lab_template",
    "entry_id": "lab_catalog_entry",
    "staff_id": "staff",
    "doctor_id": "staff",
}

# Body fields that name a resource (lists of lab order ids when paying).
BODY_RESOURCE_LISTS: Dict[str, str] = {"order_ids": "lab_order"}

# Field names that name a patient / hospital, wherever they appear.
PATIENT_FIELDS = ("patient_id",)
PATIENT_LIST_FIELDS = ("patient_ids",)
HOSPITAL_FIELDS = ("hospital_id",)

_RESOLVERS: Dict[str, Callable[[str], Optional[dict]]] = {}


def register_resolver(kind: str, fn: Callable[[str], Optional[dict]]) -> None:
    _RESOLVERS[kind] = fn


# The current request's session, readable from handlers and from code those
# handlers spawn (contextvars are copied into asyncio tasks), so socket emits
# can be scoped without threading the session through every call.
current_session: contextvars.ContextVar[dict] = contextvars.ContextVar("vela_session", default={})


def session_hospital_id() -> str:
    return (current_session.get() or {}).get("hospital_id") or ""


def scoped_hospital_id(requested: Optional[str]) -> Optional[str]:
    """The hospital a handler should act on: always the caller's own when the
    session is bound to one, otherwise whatever the caller asked for."""
    return session_hospital_id() or requested


def _deny(message: str = "You don't have access to this") -> None:
    raise HTTPException(status_code=403, detail=message)


def _is_uuid(value) -> bool:
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, TypeError, AttributeError):
        return False


async def _request_fields(request: Request) -> dict:
    """Query params + JSON/form body as one flat dict (body wins on clash)."""
    fields: dict = dict(request.query_params)
    ctype = request.headers.get("content-type", "")
    try:
        if "application/json" in ctype:
            raw = await request.body()
            if raw:
                body = json.loads(raw)
                if isinstance(body, dict):
                    fields.update(body)
        elif "multipart/form-data" in ctype or "application/x-www-form-urlencoded" in ctype:
            form = await request.form()
            for k, v in form.items():
                if isinstance(v, str):
                    fields[k] = v
    except (ValueError, UnicodeDecodeError):
        pass  # malformed body: the handler's own validation reports it
    return fields


def _resolve(kind: Optional[str], value: str) -> Optional[dict]:
    if not kind or not value:
        return None
    fn = _RESOLVERS.get(kind)
    if fn is None:
        return None
    try:
        return fn(value)
    except Exception as e:  # a lookup failure must not open the door
        print(f"⚠️ authz resolver {kind} failed: {type(e).__name__}")
        _deny("Could not verify access to this record")


def check_access(session: dict, method: str, template: str, path_params: dict, fields: dict) -> None:
    """Raise HTTPException(403) unless `session` may make this call."""
    rule = POLICY.get((method, template))
    if rule is None:
        _deny("This route has no access policy")
    if rule.roles is PUBLIC:
        return
    role = (session or {}).get("role") or ""
    if role not in rule.roles:
        _deny()

    resources = dict(PARAM_RESOURCES)
    if rule.resources:
        resources.update(rule.resources)

    records = []
    for name, value in path_params.items():
        if name in resources:
            rec = _resolve(resources[name], value)
            if rec is not None:
                records.append(rec)
    for name, kind in BODY_RESOURCE_LISTS.items():
        values = fields.get(name)
        if isinstance(values, list):
            for v in values:
                rec = _resolve(kind, str(v))
                if rec is not None:
                    records.append(rec)

    values = {**fields, **path_params}

    if role in PATIENT:
        _check_patient(session, values, records)
        return

    if rule.doctor_self and role in DOCTOR and session.get("staff_id"):
        v = values.get("doctor_id")
        if v and str(v) != session["staff_id"]:
            _deny("You can only manage your own queue")

    own_hospital = session.get("hospital_id") or ""
    if own_hospital:
        for f in HOSPITAL_FIELDS:
            v = values.get(f)
            # Non-UUID placeholders ("VLA-MAIN") are mapped to the session's
            # hospital by scoped_hospital_id() in the handler, so only a real,
            # different hospital id is a cross-tenant request.
            if v and _is_uuid(v) and str(v) != own_hospital:
                _deny("That belongs to another hospital")
        for rec in records:
            h = rec.get("hospital_id")
            if h and _is_uuid(h) and str(h) != own_hospital:
                _deny("That belongs to another hospital")

    lab = session.get("network_lab_id") or ""
    if lab:
        v = values.get("network_lab_id")
        if v and str(v) != lab:
            _deny()
        for rec in records:
            owner = rec.get("network_lab_id")
            if "network_lab_id" in rec and owner != lab:
                _deny()

    doc = session.get("network_doctor_id") or ""
    if doc:
        v = values.get("doctor_id")
        if v and str(v) != doc:
            _deny()
        for rec in records:
            if "network_doctor_id" in rec and rec.get("network_doctor_id") != doc:
                _deny()


def _check_patient(session: dict, values: dict, records: list) -> None:
    me = session.get("staff_id") or ""
    if not me:
        _deny()
    for f in PATIENT_FIELDS:
        v = values.get(f)
        if v and str(v) != me:
            _deny("You can only access your own records")
    for f in PATIENT_LIST_FIELDS:
        v = values.get(f)
        if isinstance(v, list) and any(str(x) != me for x in v):
            _deny("You can only access your own records")
    vela_id = values.get("vela_id")
    if vela_id and str(vela_id).upper() != (session.get("vela_id") or "").upper():
        _deny("You can only access your own records")
    email = values.get("email")
    if email and str(email).strip().lower() != (session.get("email") or "").strip().lower():
        _deny("You can only access your own records")
    for rec in records:
        if str(rec.get("patient_id") or "") != me:
            _deny("You can only access your own records")


async def authorize(request: Request) -> None:
    """App-wide dependency: enforce POLICY for the matched route."""
    route = request.scope.get("route")
    template = getattr(route, "path", None)
    if template is None:
        return  # no route matched — FastAPI answers 404/405 itself
    session = getattr(request.state, "session", None) or {}
    current_session.set(session)
    rule = POLICY.get((request.method, template))
    if rule is not None and rule.roles is PUBLIC:
        return
    if getattr(request.app.state, "auth_disabled", False):
        return
    fields = await _request_fields(request)
    # Resolvers hit the database; keep them off the event loop.
    await asyncio.to_thread(check_access, session, request.method, template, dict(request.path_params), fields)
