from fastapi import FastAPI, UploadFile, File, Form
from fastapi.responses import FileResponse
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from mem0 import MemoryClient
from supabase import create_client
from dotenv import load_dotenv
from crew_agents import run_crew_analysis
import socketio
import asyncio
import os, base64, json, fitz, hashlib, requests, re, secrets, string, sqlite3, uuid, time
from bs4 import BeautifulSoup
from collections import defaultdict
from datetime import datetime, timedelta
from pydantic import BaseModel
from typing import Dict, List, Optional
import pickle, re, random
import numpy as np

try:
    import bcrypt
    BCRYPT_AVAILABLE = True
except ImportError:
    BCRYPT_AVAILABLE = False

class DischargeSummaryRequest(BaseModel):
    admission_id: str

class DischargeConfirmRequest(BaseModel):
    admission_id: str
    patient_id: str
    discharge_summary: str
    final_diagnosis: str
    follow_up_date: str
    follow_up_instructions: str
    medications_on_discharge: List[dict]
    total_days: int
    room_cost: float
    test_cost: float
    total_cost: float
    payment_amount: float
    discharged_by: str

class AmbientConsultRequest(BaseModel):
    patient_id: str
    transcript_text: str

class AmbientPrescription(BaseModel):
    medication_name: str
    dosage: str
    frequency: str
    duration: str

class AmbientConsultApproveRequest(BaseModel):
    patient_id: str
    prescriptions: List[AmbientPrescription]
    lab_requisitions: List[str]
    follow_up_days: Optional[int] = None
    prescribed_by: str

load_dotenv()

# ── LOCAL SQLITE DATABASE FALLBACK FOR MISSING SCHEMAS ──
LOCAL_DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vela_local.db")

def init_local_db():
    conn = sqlite3.connect(LOCAL_DB_PATH)
    cursor = conn.cursor()

    # 0. audit_log — who touched patient data, when (HIPAA-style access trail)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT DEFAULT CURRENT_TIMESTAMP,
        role TEXT, actor TEXT, staff_id TEXT, hospital_id TEXT,
        method TEXT, path TEXT, status INTEGER, ip TEXT
    )
    """)
    
    # 1. admissions table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS admissions (
        id TEXT PRIMARY KEY,
        patient_id TEXT,
        hospital_id TEXT,
        bed_id TEXT,
        admitted_at TEXT,
        discharged_at TEXT,
        status TEXT DEFAULT 'active',
        diagnosis TEXT,
        reason TEXT,
        recommended_by TEXT,
        room_type TEXT,
        admission_qr TEXT
    )
    """)
    
    # 2. notifications table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        hospital_id TEXT,
        role TEXT,
        message TEXT,
        type TEXT DEFAULT 'info',
        read INTEGER DEFAULT 0,
        action_url TEXT,
        created_at TEXT
    )
    """)
    
    # 3. test_orders table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS test_orders (
        id TEXT PRIMARY KEY,
        patient_id TEXT,
        doctor_id TEXT,
        doctor_name TEXT,
        hospital_id TEXT,
        test_type TEXT,
        test_category TEXT,
        specific_tests TEXT,  -- JSON string
        priority TEXT,
        notes TEXT,
        status TEXT,
        payment_status TEXT DEFAULT 'pending',
        payment_amount REAL DEFAULT 0.0,
        queue_position INTEGER DEFAULT 0,
        lab_report_id TEXT,
        ordered_at TEXT,
        accepted_at TEXT,
        started_at TEXT,
        completed_at TEXT
    )
    """)
    
    # 4. lab_reports table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS lab_reports (
        id TEXT PRIMARY KEY,
        test_order_id TEXT,
        patient_id TEXT,
        doctor_name TEXT,
        test_type TEXT,
        test_category TEXT,
        values_json TEXT,  -- JSON string
        normal_ranges TEXT,  -- JSON string
        report_status TEXT,
        lab_notes TEXT,
        submitted_at TEXT,
        atlas_analysis TEXT,
        atlas_confidence TEXT,
        risk_score INTEGER
    )
    """)
    
    # 5. discharges table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS discharges (
        id TEXT PRIMARY KEY,
        admission_id TEXT,
        patient_id TEXT,
        discharged_by TEXT,
        discharge_summary TEXT,
        final_diagnosis TEXT,
        follow_up_date TEXT,
        follow_up_instructions TEXT,
        medications_on_discharge TEXT,  -- JSON string
        total_days INTEGER,
        room_cost REAL,
        test_cost REAL,
        total_cost REAL,
        payment_status TEXT,
        payment_amount REAL,
        discharged_at TEXT,
        atlas_discharge_summary TEXT
    )
    """)
    
    # 6. patient_history table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS patient_history (
        id TEXT PRIMARY KEY,
        patient_id TEXT,
        admission_id TEXT,
        ward_name TEXT,
        bed_number TEXT,
        room_type TEXT,
        diagnosis TEXT,
        admitted_at TEXT,
        discharged_at TEXT,
        total_cost REAL,
        discharge_summary TEXT,
        medications TEXT,  -- JSON string
        tests TEXT  -- JSON string
    )
    """)
    
    # 7. lab_templates table — custom report formats a lab defines for itself.
    # Built-in catalog templates stay in lab_catalog.py; rows here override or
    # extend them, scoped per hospital so two hospitals can format differently.
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS lab_templates (
        id TEXT PRIMARY KEY,
        hospital_id TEXT,
        test_type TEXT,
        department TEXT,
        sample_type TEXT,
        price REAL DEFAULT 0.0,
        tat_minutes INTEGER DEFAULT 60,
        fields TEXT,  -- JSON array of {name, unit, normal_min, normal_max, text_field}
        instructions TEXT,
        created_by TEXT,
        created_at TEXT,
        updated_at TEXT
    )
    """)

    # 8. visit_reports table — the permanent consultation document. Generated on
    # every completed consult, with or without prescriptions, so a patient always
    # walks out with something a chemist (and the next doctor) can read.
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS visit_reports (
        id TEXT PRIMARY KEY,
        patient_id TEXT,
        hospital_id TEXT,
        doctor_name TEXT,
        visit_date TEXT,
        diagnosis TEXT,
        chief_complaint TEXT,
        medications TEXT,   -- JSON array
        tests_ordered TEXT, -- JSON array
        abnormalities TEXT, -- JSON array of AI-flagged findings
        vitals TEXT,        -- JSON object
        advice TEXT,
        follow_up TEXT,
        document_id TEXT,   -- row in Supabase `documents` (drives RAG + patient view)
        pdf_path TEXT,
        created_at TEXT
    )
    """)

    # 9. generated_files — maps a `documents` row to the PDF VELA rendered for it.
    # The Supabase `documents` schema is fixed and has nowhere to put a local file
    # path, so the mapping lives here and /api/documents/{id}/file resolves it.
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS generated_files (
        document_id TEXT PRIMARY KEY,
        patient_id TEXT,
        kind TEXT,        -- 'lab_report' | 'visit_report'
        source_id TEXT,   -- lab_reports.id or visit_reports.id
        pdf_path TEXT,
        filename TEXT,
        created_at TEXT
    )
    """)

    # 10. imaging_studies — radiology second-read results (X-ray/CT/MRI/US).
    # The Supabase `documents` schema has no room for structured findings, and
    # squeezing them into `values` would corrupt the lab-trend charts that read
    # that column. A companion `documents` row is still created per study so the
    # study appears in the timeline and is indexed for RAG.
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS imaging_studies (
        id TEXT PRIMARY KEY,
        patient_id TEXT,
        document_id TEXT,      -- companion row in Supabase `documents`
        filename TEXT,
        modality TEXT,
        body_region TEXT,
        view TEXT,
        analysis TEXT,         -- JSON: full normalised imaging.analyze_study result
        image_data TEXT,       -- base64 display copy of the study
        urgent INTEGER DEFAULT 0,
        review_status TEXT DEFAULT 'pending',  -- pending | confirmed | rejected
        reviewed_by TEXT,
        reviewed_at TEXT,
        review_note TEXT,
        confirmed_findings TEXT,               -- JSON array of doctor-accepted findings
        uploaded_by TEXT,
        created_at TEXT
    )
    """)

    conn.commit()

    # ── COLUMN MIGRATIONS ─────────────────────────────────────────────────────
    # Additive only. Existing installs already carry test_orders/lab_reports rows,
    # so new columns are appended in place rather than recreating the tables.
    def _add_columns(table: str, columns: dict[str, str]):
        existing = {row[1] for row in cursor.execute(f"PRAGMA table_info({table})")}
        for col, decl in columns.items():
            if col not in existing:
                cursor.execute(f"ALTER TABLE {table} ADD COLUMN {col} {decl}")
                print(f"🔧 Migrated {table}: +{col}")

    _add_columns("test_orders", {
        "department": "TEXT DEFAULT 'pathology'",   # routed lab (lab_catalog)
        "sample_type": "TEXT",
        "price": "REAL DEFAULT 0.0",                # catalog price, set at order time
        "billing_mode": "TEXT DEFAULT 'patient'",   # 'patient' | 'admission'
        "paid_at": "TEXT",
        "paid_by": "TEXT",                          # 'patient' | 'reception'
        "visit_id": "TEXT",                         # visit_reports.id that ordered it
        "tat_minutes": "INTEGER DEFAULT 60",
        "arrived_at": "TEXT",                       # checked in at the lab counter
        "arrived_by": "TEXT",
        "payment_intent": "TEXT",                   # 'counter' when the patient defers payment
        "payment_intent_at": "TEXT",
        "cancelled_at": "TEXT",
        "cancelled_by": "TEXT",                     # 'receptionist' | 'doctor' | 'patient'
        "network_lab_id": "TEXT",                   # set when routed off-hospital, see fulfilled_by
        "fulfilled_by": "TEXT DEFAULT 'hospital_department'",  # 'hospital_department' | 'network_lab'
    })

    _add_columns("lab_reports", {
        "department": "TEXT",
        "document_id": "TEXT",   # documents row created for RAG + patient view
        "pdf_path": "TEXT",
        "abnormal_fields": "TEXT",  # JSON array of flagged field names
    })

    _add_columns("lab_templates", {
        # An independent (non-hospital) lab's own report formats live here too,
        # scoped by network_lab_id instead of hospital_id — the two are mutually
        # exclusive on a given row.
        "network_lab_id": "TEXT",
    })

    conn.commit()
    conn.close()
    print("🤖 Local SQLite database initialized successfully!")

class _LocalRows:
    """Wraps local SQLite rows so they read like a Supabase response (`.data`)."""
    def __init__(self, data):
        self.data = data

def local_query(query, params=()):
    conn = sqlite3.connect(LOCAL_DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    cursor.execute(query, params)
    rows = cursor.fetchall()
    conn.close()
    return [dict(row) for row in rows]

def local_execute(query, params=()):
    conn = sqlite3.connect(LOCAL_DB_PATH)
    cursor = conn.cursor()
    cursor.execute(query, params)
    conn.commit()
    conn.close()

def is_valid_uuid(val):
    if not val:
        return False
    try:
        uuid.UUID(str(val))
        return True
    except ValueError:
        return False

def get_valid_hospital_id(hospital_id: str) -> str:
    if is_valid_uuid(hospital_id):
        return hospital_id
    try:
        # Fetch the first hospital from Supabase
        res = supabase_admin.table("vela_hospitals").select("id").limit(1).execute()
        if res.data:
            return res.data[0]["id"]
    except Exception as e:
        print("Error fetching fallback hospital:", e)
    return "990a1441-721c-4fb1-926b-15cacb050efd"  # Default AIIMS UUID

def resolve_order_hospital(doctor_id: Optional[str] = None, patient_id: Optional[str] = None) -> Optional[str]:
    """The hospital a lab order belongs to: the ordering doctor's, else the one treating the
    patient right now. Never guess — get_valid_hospital_id(None) picks an arbitrary hospital,
    which is how orders ended up invisible to the hospital that actually ordered them."""
    try:
        if not doctor_id and patient_id:
            t = supabase_admin.table("tickets").select("doctor_id").eq("patient_id", patient_id).neq("status", "completed").order("created_at", desc=True).limit(1).execute()
            if t.data:
                doctor_id = t.data[0].get("doctor_id")
        if doctor_id:
            st = supabase_admin.table("vela_staff").select("hospital_id").eq("id", doctor_id).execute()
            if st.data and st.data[0].get("hospital_id"):
                return st.data[0]["hospital_id"]
    except Exception as e:
        print(f"⚠️ Warning: could not resolve ordering hospital: {e}")
    return None

def lookup_patient_name(patient_id: str):
    try:
        res = supabase.table("patients").select("name").eq("id", patient_id).execute()
        return res.data[0]["name"] if res.data else None
    except Exception:
        return None

# Initialize database
init_local_db()

# Initialize RAG vector store tables
from rag import (
    init_rag_tables, process_document_for_rag, delete_chunks_for_document,
    query_patient_history, generate_timeline, get_rag_context_for_atlas,
    build_profile_block as rag_build_profile_block,
)
init_rag_tables()

import lab_catalog
import vela_documents
import doc_ocr
import imaging

# ── SESSION MEMORY ──
conversation_history = defaultdict(lambda: {
    "messages": [],
    "current_patient_id": None,
    "current_patient_name": None
})

# ── ACTIVE CONSULTATION ──
# Who each doctor is seeing right now. Keyed by doctor_id, never by session:
# a session id is chosen by the client, so two doctors sharing one would
# overwrite each other's patient. The `tickets` table is the source of truth
# (it survives a restart); this dict is only a hot cache in front of it.
ActiveConsult: Dict[str, dict] = {}

def set_active_consult(doctor_id: str, patient_id: str, patient_name: str = None, ticket_id: str = None):
    if not doctor_id or not patient_id:
        return
    ActiveConsult[doctor_id] = {
        "patient_id": patient_id,
        "patient_name": patient_name or lookup_patient_name(patient_id),
        "ticket_id": ticket_id,
    }

def clear_active_consult(doctor_id: str):
    if doctor_id:
        ActiveConsult.pop(doctor_id, None)

async def resolve_doctor_id(data: dict, session: dict) -> Optional[str]:
    """Which doctor is talking. Explicit id wins, then the session, then a
    single-doctor fallback so the demo still works when the client sends none."""
    doctor_id = data.get("doctor_id") or session.get("doctor_id")
    if not doctor_id:
        try:
            staff = await asyncio.to_thread(
                supabase_admin.table("vela_staff").select("id").eq("role", "doctor").limit(2).execute
            )
            # Only guess when there is exactly one doctor — otherwise guessing
            # would hand this session another doctor's active consult.
            if staff.data and len(staff.data) == 1:
                doctor_id = staff.data[0]["id"]
        except Exception:
            pass
    if doctor_id:
        session["doctor_id"] = doctor_id
    return doctor_id


def resolve_patient_by_name(name: str, prefer_patient_id: str = None) -> dict:
    """Look up a patient the doctor named out loud.

    Returns {"patient_id", "patient_name"} on a confident match, or
    {"ambiguous": [names]} when the name maps to genuinely different people.
    The old code did `ilike('%name%')[0]`, which silently picked an arbitrary
    row — so a half-heard name could swap the chart mid-consult.
    """
    if not name:
        return {}
    cleaned = name.strip()
    if cleaned.lower() in ("", "unknown", "null", "none", "patient"):
        return {}
    try:
        rows = supabase.table("patients").select("id, name, risk_score").ilike("name", f"%{cleaned}%").execute().data or []
    except Exception as e:
        print(f"⚠️ Warning: patient name lookup failed for '{cleaned}': {e}")
        return {}
    if not rows:
        return {}

    # An exact (case-insensitive) name match always wins over a substring hit.
    exact = [r for r in rows if (r.get("name") or "").strip().lower() == cleaned.lower()]
    candidates = exact or rows

    # Already consulting one of them? Stay on that chart rather than re-picking.
    if prefer_patient_id and any(r["id"] == prefer_patient_id for r in candidates):
        match = next(r for r in candidates if r["id"] == prefer_patient_id)
        return {"patient_id": match["id"], "patient_name": match["name"]}

    distinct = {(r.get("name") or "").strip().lower() for r in candidates}
    if len(distinct) > 1:
        return {"ambiguous": sorted({r["name"] for r in candidates})}

    # Same person on several rows (duplicate records) — take the richest chart.
    match = max(candidates, key=lambda r: r.get("risk_score") or 0)
    return {"patient_id": match["id"], "patient_name": match["name"]}


async def get_active_consult(doctor_id: str) -> Optional[dict]:
    """This doctor's current patient, or None.

    Falls back to the newest in-progress ticket *for this doctor* — scoped, so
    a busy hospital never hands doctor A the patient doctor B just called in.
    """
    if not doctor_id:
        return None
    cached = ActiveConsult.get(doctor_id)
    if cached:
        return cached
    try:
        rows = await asyncio.to_thread(
            supabase.table("tickets")
                .select("id, patient_id")
                .eq("doctor_id", doctor_id)
                .eq("status", "in-progress")
                .order("called_at", desc=True)
                .limit(1)
                .execute
        )
        if rows.data:
            pid = rows.data[0]["patient_id"]
            set_active_consult(doctor_id, pid, ticket_id=rows.data[0]["id"])
            return ActiveConsult.get(doctor_id)
    except Exception as e:
        print(f"⚠️ Warning: active-consult lookup failed for doctor {doctor_id}: {e}")
    return None

# ── SETUP ──
# One origin list for both HTTP and Socket.IO; extend with CORS_ORIGINS env var
# (comma-separated) for additional deployment domains.
ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:5175",
    "http://localhost:3000",
    "https://velahealth.in",
    "https://www.velahealth.in",
] + [o.strip() for o in os.getenv("CORS_ORIGINS", "").split(",") if o.strip()]

sio = socketio.AsyncServer(
    async_mode="asgi",
    cors_allowed_origins=ALLOWED_ORIGINS
)

fastapi_app = FastAPI()
fastapi_app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app = socketio.ASGIApp(sio, other_asgi_app=fastapi_app)

# ── Background work isolation ──
# The heavy document-ingestion pipeline (fitz parsing, mem0 sync, OpenAI parse)
# used to run on the SAME default thread pool that `asyncio.to_thread` uses for
# interactive request handling. Each pipeline holds workers for many seconds
# (OpenAI up to 30s, mem0 previously unbounded), so a handful of concurrent
# uploads exhausted the default pool and made foreground requests — the very
# upload/delete inserts, plus everything else using to_thread — queue for
# 5-13s. Give background ingestion its OWN dedicated pool + a concurrency cap so
# it can never starve interactive requests.
import functools
from concurrent.futures import ThreadPoolExecutor
# Env-tunable so a bigger deployment can retune concurrency without a code
# edit; the values here are what testing on this deployment settled on.
_BG_WORKERS = int(os.getenv("VELA_BG_WORKERS", "4"))
_PIPELINE_CONCURRENCY = int(os.getenv("VELA_PIPELINE_CONCURRENCY", "2"))
_BG_EXECUTOR = ThreadPoolExecutor(max_workers=_BG_WORKERS, thread_name_prefix="vela-ingest")
_PIPELINE_SEMAPHORE = asyncio.Semaphore(_PIPELINE_CONCURRENCY)

async def bg_run(fn, *args, **kwargs):
    """Run a blocking call on the dedicated background pool (never the request pool)."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(_BG_EXECUTOR, functools.partial(fn, *args, **kwargs))

# Unhandled exceptions bypass CORSMiddleware (Starlette's error handler is the
# outermost layer), so a bare 500 reaches the browser without CORS headers and
# surfaces as an opaque "Network Error". Convert every unhandled exception to a
# JSON 500 and attach CORS headers manually.
from fastapi import Request as _Request
from fastapi.responses import JSONResponse as _JSONResponse

def _cors_headers(request: _Request) -> dict:
    """Manual CORS headers for responses produced OUTSIDE CORSMiddleware
    (outermost middleware / Starlette's error handler), so the browser sees a
    proper JSON error instead of an opaque network failure."""
    origin = request.headers.get("origin", "")
    if origin in ALLOWED_ORIGINS:
        return {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            "Vary": "Origin",
        }
    return {}

@fastapi_app.exception_handler(Exception)
async def _unhandled_exception_handler(request: _Request, exc: Exception):
    # Full detail stays server-side; the client gets a generic message so
    # internals (paths, SQL, library names) never leak through error text.
    import traceback
    print(f"❌ Unhandled error on {request.method} {request.url.path}: {type(exc).__name__}: {exc}")
    traceback.print_exc()
    return _JSONResponse(
        status_code=500,
        content={"status": "error", "message": "Internal server error"},
        headers=_cors_headers(request),
    )

# ── AUTH ──
# Every /api/* route requires a Bearer session token except the public
# allowlist below. Tokens are issued by /api/auth/login (staff demo accounts,
# bcrypt-verified server-side) and /api/network/auth/login, kept in memory
# with a TTL — a restart simply logs everyone out. Set VELA_AUTH_DISABLED=1
# only for local development.
AUTH_DISABLED = os.getenv("VELA_AUTH_DISABLED", "").lower() in ("1", "true", "yes")
SESSION_TTL_SECONDS = int(os.getenv("VELA_SESSION_TTL", 12 * 3600))
_SESSION_TOKENS: dict = {}  # token -> {"role", "name", "staff_id", "issued"}

PUBLIC_API_PATHS = {
    "/api/network/auth/login",
    "/api/network/labs/auth/login",
    "/api/network/doctors/auth/login",
    "/api/staff/login",
    "/api/manager/login",
    "/api/owner/login",
    "/api/health",
    # Patient self-signup: the caller has no session yet by definition. The
    # route itself refuses to set staff-only clinical fields.
    "/api/patient/self-register",
    # One-click demo patient login for the localhost presentation. Public by
    # necessity (no session exists yet) and self-disables when DEMO_LOGIN=false.
    "/api/demo/login-patient",
}

# OFF by default — it hands out a patient session with no credentials, so it
# must be a deliberate opt-in, not something that's on unless someone
# remembers to turn it off. Set DEMO_LOGIN=true in .env for a presentation/demo
# environment where a one-tap patient login is wanted.
DEMO_LOGIN_ENABLED = (os.getenv("DEMO_LOGIN", "false").strip().lower()
                      in ("true", "1", "yes", "on"))
if DEMO_LOGIN_ENABLED:
    print("⚠️  DEMO_LOGIN is ON — /api/demo/login-patient grants a patient "
          "session without a password. Set DEMO_LOGIN=false before deploying.")

import hmac

def hash_password(plaintext: str) -> str:
    return bcrypt.hashpw(plaintext.encode(), bcrypt.gensalt()).decode()

def verify_password(plaintext: str, stored: str) -> bool:
    """Accept bcrypt hashes and (for rows created before hashing) legacy
    plaintext, so existing accounts keep working while logins migrate them."""
    if not stored:
        return False
    if stored.startswith(("$2a$", "$2b$")):
        try:
            return bcrypt.checkpw(plaintext.encode(), stored.encode())
        except Exception:
            return False
    return hmac.compare_digest(stored, plaintext)

def issue_session_token(
    role: str, name: str, staff_id: str = "", lab_department: str = "", hospital_id: str = "",
    network_lab_id: str = "", network_doctor_id: str = "",
) -> str:
    token = secrets.token_urlsafe(32)
    _SESSION_TOKENS[token] = {
        "role": role, "name": name, "staff_id": staff_id,
        # Scopes a lab account to one department's queue. Empty means "all
        # departments" — the super-lab view.
        "lab_department": lab_department,
        # Which hospital this session belongs to, so a handler can refuse a
        # manager/staff session reading or writing another hospital's data.
        "hospital_id": hospital_id,
        # Independent (non-hospital) provider scoping — set for a network lab
        # or solo doctor session, never both, never alongside hospital_id.
        "network_lab_id": network_lab_id,
        "network_doctor_id": network_doctor_id,
        "issued": time.time(),
    }
    return token

_PHI_PREFIXES = ("/api/patients", "/api/atlas", "/api/documents", "/api/lab/orders", "/api/emergency")

def _is_phi_path(path: str) -> bool:
    return path.startswith(_PHI_PREFIXES)

def _write_audit(session: dict, request, status: int) -> None:
    """Best-effort access log; never lets a logging failure break a request."""
    try:
        conn = sqlite3.connect(LOCAL_DB_PATH)
        conn.execute(
            "INSERT INTO audit_log (role, actor, staff_id, hospital_id, method, path, status, ip) VALUES (?,?,?,?,?,?,?,?)",
            (session.get("role"), session.get("name"), session.get("staff_id"), session.get("hospital_id"),
             request.method, request.url.path, status, request.client.host if request.client else ""),
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f"⚠️ audit log write failed: {e}")

@fastapi_app.get("/api/audit-log")
def get_audit_log(request: _Request, limit: int = 100):
    """Manager-only view of recent patient-data access."""
    if (getattr(request.state, "session", None) or {}).get("role") != "manager":
        return _JSONResponse(status_code=403, content={"status": "error", "message": "Managers only"})
    conn = sqlite3.connect(LOCAL_DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = [dict(r) for r in conn.execute("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?", (min(limit, 500),))]
    conn.close()
    return {"status": "success", "entries": rows}

@fastapi_app.middleware("http")
async def _require_auth(request: _Request, call_next):
    path = request.url.path
    if (
        AUTH_DISABLED
        or request.method == "OPTIONS"
        or not path.startswith("/api/")
        or path in PUBLIC_API_PATHS
    ):
        return await call_next(request)
    auth_header = request.headers.get("authorization", "")
    token = auth_header[7:] if auth_header.lower().startswith("bearer ") else ""
    session = _SESSION_TOKENS.get(token)
    if session and time.time() - session["issued"] > SESSION_TTL_SECONDS:
        _SESSION_TOKENS.pop(token, None)
        session = None
    if not session:
        return _JSONResponse(
            status_code=401,
            content={"status": "error", "message": "Authentication required"},
            headers=_cors_headers(request),
        )
    request.state.session = session
    response = await call_next(request)
    if _is_phi_path(path):
        asyncio.create_task(asyncio.to_thread(_write_audit, session, request, response.status_code))
    return response

@fastapi_app.post("/api/demo/login-patient")
async def demo_login_patient():
    """
    One-click demo login as the seeded patient (Rajesh Kumar, VLA-8888).

    Built for the localhost presentation: no credentials typed on stage. It
    still issues a REAL session token, so every downstream call authenticates
    exactly like a normal login — this bypasses the password prompt, not the
    auth system.

    Gated on DEMO_LOGIN so it cannot quietly survive into a deployment. Set
    DEMO_LOGIN=false in .env to switch it off; the endpoint then 404s.
    """
    if not DEMO_LOGIN_ENABLED:
        return _JSONResponse(status_code=404,
                             content={"status": "error", "message": "Not found"})

    # The demo login must not fail on stage: retry transient database errors, and if the
    # database stays unreachable fall back to the last patient we loaded successfully.
    patient = None
    for attempt in range(3):
        try:
            seeded = await asyncio.to_thread(seed_demo_patient)
            patient = (seeded or {}).get("patient")
        except Exception as e:
            print(f"⚠️ demo login attempt {attempt + 1} failed: {e}")
        if patient:
            _DEMO_PATIENT_CACHE["patient"] = patient
            break
        await asyncio.sleep(0.4 * (attempt + 1))
    if not patient:
        patient = _DEMO_PATIENT_CACHE.get("patient")
    if not patient:
        return _JSONResponse(
            status_code=503,
            content={"status": "error",
                     "message": "Demo patient unavailable — check the Supabase connection."},
        )

    token = issue_session_token("patient", patient.get("name") or "Rajesh Kumar", patient.get("id") or "")
    return {
        "status": "success",
        "token": token,
        "role": "patient",
        "name": patient.get("name"),
        "vela_id": patient.get("vela_id"),
        "patient": patient,
    }


@fastapi_app.get("/api/health")
def api_health():
    return {"status": "ok"}

mem0_client = None
# mem0 held stale values that no uploaded file contains (e.g. creatinine 1.8, Hb 9.2),
# so Atlas's clinical answers are file-only unless this is explicitly enabled.
ATLAS_USE_MEM0 = os.getenv("ATLAS_USE_MEM0", "false").lower() == "true"
try:
    mem0_client = MemoryClient(api_key=os.getenv("api_key"))
except Exception as e:
    print(f"⚠️ Warning: MemoryClient failed to initialize: {e}")

openai_client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

# 5s timeout so an unreachable Supabase fails fast instead of hanging the
# event loop (and every queued request) for the full OS-level TCP/DNS timeout.
import httpx as _httpx
from supabase import ClientOptions as _ClientOptions

_SUPABASE_URL = os.getenv("SUPABASE_URL")
if not _SUPABASE_URL:
    raise RuntimeError(
        "SUPABASE_URL is not set. Every request needs it — failing at boot "
        "instead of letting every DB call fail individually at request time."
    )

def _make_supabase(key: str):
    return create_client(
        _SUPABASE_URL,
        key,
        options=_ClientOptions(httpx_client=_httpx.Client(timeout=5.0)),
    )

supabase = _make_supabase(os.getenv("SUPABASE_ANON_KEY"))
# Administrative client to bypass RLS for owner actions
service_role_key = os.getenv("SUPABASE_SERVICE_ROLE_KEY") or os.getenv("SUPABASE_ANON_KEY")
supabase_admin = _make_supabase(service_role_key)

# ── DIAGNOSTIC ENGINE ASSETS ──
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DISEASE_MODEL_PATH = os.path.join(BASE_DIR, 'model', 'disease_model.pkl')
LABEL_ENCODER_PATH = os.path.join(BASE_DIR, 'model', 'label_encoder.pkl')
SYMPTOMS_LIST_PATH = os.path.join(BASE_DIR, 'model', 'symptoms.pkl')

disease_model = None
disease_encoder = None
diagnostic_symptoms_list = None

def load_diagnostic_assets():
    global disease_model, disease_encoder, diagnostic_symptoms_list
    try:
        if os.path.exists(DISEASE_MODEL_PATH):
            with open(DISEASE_MODEL_PATH, 'rb') as f:
                disease_model = pickle.load(f)
            if os.path.exists(LABEL_ENCODER_PATH):
                with open(LABEL_ENCODER_PATH, 'rb') as f:
                    disease_encoder = pickle.load(f)
            if os.path.exists(SYMPTOMS_LIST_PATH):
                with open(SYMPTOMS_LIST_PATH, 'rb') as f:
                    diagnostic_symptoms_list = pickle.load(f)
            print("✅ Diagnostic Engine assets loaded successfully.")
        else:
            print(f"⚠️ Warning: Diagnostic Model not found at {DISEASE_MODEL_PATH}")
    except Exception as e:
        print(f"⚠️ Warning: Diagnostic Engine failed to load: {e}")

load_diagnostic_assets()

# ── DIAGNOSTIC ENDPOINTS ──
@fastapi_app.get("/api/diagnostic/symptoms")
def get_diagnostic_symptoms():
    if diagnostic_symptoms_list is None:
        return {"status": "error", "message": "Diagnostic list not loaded"}
    return {"status": "success", "symptoms": diagnostic_symptoms_list}

@fastapi_app.post("/api/diagnostic/predict")
def predict_disease(data: dict):
    if disease_model is None or disease_encoder is None:
        return {"status": "error", "message": "Diagnostic Engine not ready"}
    
    selected_symptoms = data.get("symptoms", [])
    if not selected_symptoms:
        return {"status": "error", "message": "No symptoms provided"}
    
    # Create binary vector
    input_vector = np.zeros(len(diagnostic_symptoms_list))
    for symptom in selected_symptoms:
        if symptom in diagnostic_symptoms_list:
            idx = diagnostic_symptoms_list.index(symptom)
            input_vector[idx] = 1
    
    # Prediction
    try:
        probs = disease_model.predict_proba([input_vector])[0]
        # Get top 3 indices
        top_indices = np.argsort(probs)[-3:][::-1]
        results = []
        for i in top_indices:
            results.append({
                "disease": str(disease_encoder.inverse_transform([i])[0]),
                "probability": float(probs[i])
            })
        return {"status": "success", "predictions": results}
    except Exception as e:
        return {"status": "error", "message": f"Prediction failed: {str(e)}"}

# ── SOCKET.IO ──
@sio.event
async def connect(sid, environ):
    print(f"✅ Frontend connected: {sid}")

@sio.event
async def disconnect(sid):
    print(f"❌ Frontend disconnected: {sid}")

@sio.on("join_hospital")
async def on_join_hospital(sid, data):
    hospital_id = data.get("hospital_id")
    if hospital_id:
        await sio.enter_room(sid, hospital_id)
        print(f"🏥 Client {sid} joined room {hospital_id}")

@sio.on("doctor_state")
async def on_doctor_state(sid, data):
    hospital_id = data.get("hospital_id")
    if hospital_id:
        # Broadcast doctor operational state change to the whole hospital room
        await sio.emit("doctor_state_change", data, room=hospital_id)

# ── HELPERS ──
def pdf_to_base64_images(file_bytes):
    doc = fitz.open(stream=file_bytes, filetype="pdf")
    images = []
    for page in doc:
        pix = page.get_pixmap(dpi=200)
        images.append(base64.standard_b64encode(pix.tobytes("png")).decode("utf-8"))
    return images

def extract_report(file_bytes, filename="report.pdf"):
    ext = filename.split('.')[-1].lower() if '.' in filename else ''
    if ext in ["jpg", "jpeg", "png", "webp"]:
        images = [base64.standard_b64encode(file_bytes).decode("utf-8")]
    else:
        try:
            images = pdf_to_base64_images(file_bytes)
        except Exception as e:
            print(f"PDF extraction failed, trying direct image base64: {e}")
            try:
                images = [base64.standard_b64encode(file_bytes).decode("utf-8")]
            except Exception:
                images = []

    content = [{"type": "text", "text": """Extract ALL values from this medical report and return ONLY this JSON:
{
  "patient_name": "",
  "patient_id": "",
  "report_date": "",
  "values": [{"test": "", "result": "", "unit": "", "status": "", "reference": ""}],
  "critical_flags": [],
  "risk_score": 0,
  "summary": ""
}
risk_score is 0-100. Return ONLY JSON, no markdown."""}]
    for img in images:
        content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img}"}})
    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[{"role": "user", "content": content}],
        max_tokens=2000
    )
    raw = response.choices[0].message.content.strip()
    raw = raw.replace("```json", "").replace("```", "").strip()
    return json.loads(raw)

def extract_patient_name(question):
    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": "Extract the patient name from the question. Return ONLY the first name, nothing else. If no name, return 'unknown'."},
            {"role": "user", "content": question}
        ]
    )
    return response.choices[0].message.content.strip()

def detect_intent(question):
    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": """Detect the intent of this doctor's question. Return ONLY this JSON:
{
  "intent": "answer" | "navigate_reports" | "navigate_patient" | "ward_summary" | "discharge" | "chitchat",
  "patient_name": "first name or null",
  "tab": "reports" | "notes" | "reminders" | null
}
RULES:
- "answer" = doctor wants medical info, status, values, analysis about a patient
- "navigate_reports" = doctor says "pull up", "show me", "get me", "open", "bring up" + reports/documents
- "navigate_patient" = doctor says "go to", "take me to", "open page of" a patient
- "ward_summary" = asking about ALL patients together
- "discharge" = doctor wants to discharge a patient
- "chitchat" = greetings, small talk, general questions, anything NOT about a specific patient or clinical data
  Use "chitchat" for: "Hi", "Good morning", "Who are you?", "What can you do?", "Thanks", "What's the weather?", "Tell me a joke", "How are you?", "What time is it?", anything casual
  NEVER use "out_of_scope" — Atlas handles everything, even casual conversation.
EXAMPLES:
"Is Rajesh okay?" → answer
"What is Rajesh's hemoglobin?" → answer
"How is Rajesh doing?" → answer
"Pull up Rajesh's reports" → navigate_reports
"Get me Dev's documents" → navigate_reports
"Show me Rajesh's reports" → navigate_reports
"Go to Rajesh's page" → navigate_patient
"How are all patients doing?" → ward_summary
"Discharge Rajesh" → discharge
"Ready to go home" → discharge
"Can we release Dev?" → discharge
"Hi" → chitchat
"Good morning" → chitchat
"Who are you?" → chitchat
"What can you do?" → chitchat
"Thanks" → chitchat
"What's the weather?" → chitchat
"Tell me a joke" → chitchat"""},
            {"role": "user", "content": question}
        ]
    )
    raw = response.choices[0].message.content.strip()
    raw = raw.replace("```json", "").replace("```", "").strip()
    return json.loads(raw)


import re as _re_fast
_NAV_HINT = ("pull up", "show me", "get me", "open ", "bring up", "go to", "take me", "discharge", "release", "ready to go home", "all patients", "everyone", "ward", "how are all")
_QUEUE_HINT = ("next", "break", "complete", "finish", "consult", "call ")
_CLINICAL_RE = _re_fast.compile(r"\b(hemoglobin|haemoglobin|hb|wbc|rbc|platelets?|creatinine|glucose|sugar|hba1c|cholesterol|potassium|sodium|bp|blood pressure|value|values|result|results|report|reports|lab|labs|allerg\w*|medications?|medicines?|drugs?|diagnos\w*|risk|trend|critical|abnormal|summary|summari[sz]e|history|conditions?|vitals?|latest|scan|x-?ray|is he|is she|does he|does she|his|her)\b", _re_fast.I)
_NAME_RE = _re_fast.compile(r"(?<!^)(?<![.?!] )\b[A-Z][a-z]{2,}\b")
_NOT_NAMES = {"What", "Whats", "What's", "Is", "His", "Her", "Does", "Show", "Tell", "Hemoglobin", "WBC", "CBC", "Atlas", "Doctor"}

def fast_intent(question: str):
    """Skip the LLM intent call for the common case: a clinical question about the patient
    already in the room (no name, no navigation). Returns None when unsure."""
    q = question.strip()
    ql = q.lower()
    if len(q) > 160 or any(w in ql for w in _NAV_HINT):
        return None
    if not _CLINICAL_RE.search(q):
        return None
    names = [n for n in _NAME_RE.findall(q) if n not in _NOT_NAMES]
    if names:
        return None  # a patient may be named — let the model extract it
    return {"intent": "answer", "patient_name": None, "tab": None}

async def detect_intent_async(question: str):
    fast = fast_intent(question)
    if fast:
        return fast
    # The OpenAI client is blocking: keep it off the event loop so other requests aren't stalled.
    return await asyncio.to_thread(detect_intent, question)

def hash_file(file_bytes):
    return hashlib.sha256(file_bytes).hexdigest()

def scrape_drug_info(drug_name: str) -> str:
    try:
        search_url = f"https://www.drugs.com/search.php?searchterm={drug_name.replace(' ', '+')}"
        headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
        search_res = requests.get(search_url, headers=headers, timeout=8)
        soup = BeautifulSoup(search_res.text, "html.parser")
        result = soup.select_one(".ddc-media-title a")
        if not result:
            return f"No information found for {drug_name} on drugs.com"
        drug_url = "https://www.drugs.com" + result["href"]
        drug_res = requests.get(drug_url, headers=headers, timeout=8)
        drug_soup = BeautifulSoup(drug_res.text, "html.parser")
        sections = {}
        warning = drug_soup.select_one(".ddc-warning-desc")
        if warning:
            sections["warning"] = warning.get_text(strip=True)[:500]
        uses = drug_soup.find("h2", string=lambda t: t and "uses" in t.lower())
        if uses and uses.find_next("p"):
            sections["uses"] = uses.find_next("p").get_text(strip=True)[:300]
        side_effects = drug_soup.find("h2", string=lambda t: t and "side effects" in t.lower())
        if side_effects and side_effects.find_next("p"):
            sections["side_effects"] = side_effects.find_next("p").get_text(strip=True)[:300]
        warnings_section = drug_soup.find("h2", string=lambda t: t and "warning" in t.lower())
        if warnings_section and warnings_section.find_next("p"):
            sections["warnings"] = warnings_section.find_next("p").get_text(strip=True)[:300]
        if not sections:
            return f"Found {drug_name} on drugs.com but couldn't extract details."
        result_text = f"Drug info for {drug_name} from drugs.com:\n"
        for key, val in sections.items():
            result_text += f"\n{key.upper()}:\n{val}\n"
        return result_text
    except Exception as e:
        return f"Could not fetch drug info: {str(e)}"

def scrape_medications_for_condition(condition: str) -> list:
    try:
        search_url = f"https://www.drugs.com/condition/{condition.lower().replace(' ', '-')}.html"
        headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
        res = requests.get(search_url, headers=headers, timeout=8)
        soup = BeautifulSoup(res.text, "html.parser")
        medications = []
        drug_items = soup.select(".ddc-media-list .ddc-media-title a")[:3]
        for item in drug_items:
            medications.append({
                "name": item.get_text(strip=True),
                "url": "https://www.drugs.com" + item["href"]
            })
        if not medications:
            search_url2 = f"https://www.drugs.com/search.php?searchterm={condition.replace(' ', '+')}&search_type=drugs"
            res2 = requests.get(search_url2, headers=headers, timeout=8)
            soup2 = BeautifulSoup(res2.text, "html.parser")
            items = soup2.select(".ddc-media-title a")[:3]
            for item in items:
                medications.append({
                    "name": item.get_text(strip=True),
                    "url": "https://www.drugs.com" + item["href"]
                })
        return medications
    except Exception as e:
        return []

def get_medication_recommendations(problems: list, patient_context: str) -> list:
    recommendations = []
    for problem in problems:
        scraped_meds = scrape_medications_for_condition(problem)
        response = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[
                {"role": "system", "content": """You are a clinical pharmacology AI.
Given a patient's condition and context, recommend the top 3 medications.
Return ONLY this JSON:
[
  {
    "name": "medication name",
    "reason": "why this is recommended in one sentence",
    "caution": "any specific caution for this patient or null",
    "priority": "first_line" | "second_line" | "alternative"
  }
]
Return ONLY JSON array, no markdown."""},
                {"role": "user", "content": f"""
Problem: {problem}
Patient context:
{patient_context}
Drugs found on drugs.com for this condition:
{json.dumps(scraped_meds)}
Recommend top 3 medications for this specific patient."""}
            ]
        )
        raw = response.choices[0].message.content.strip()
        raw = raw.replace("```json", "").replace("```", "").strip()
        meds = json.loads(raw)
        recommendations.append({
            "problem": problem,
            "medications": meds,
            "source": "drugs.com + AI analysis"
        })
    return recommendations

def derive_slug(hospital_name: str) -> str:
    slug = re.sub(r'[^a-z0-9\s-]', '', hospital_name.lower())
    slug = re.sub(r'\s+', '-', slug.strip())
    slug = slug[:20].rstrip('-')
    return slug

def generate_password(length: int = 10) -> str:
    alphabet = string.ascii_letters + string.digits
    while True:
        pwd = ''.join(secrets.choice(alphabet) for _ in range(length))
        if (any(c.isupper() for c in pwd) and
            any(c.islower() for c in pwd) and
            any(c.isdigit() for c in pwd)):
            return pwd

# ── ROUTES ──

# --- PATIENTS ---
@fastapi_app.get("/api/patient/qr/{vela_id}")
def get_patient_qr(vela_id: str):
    result = supabase.table("patients").select("*").eq("vela_id", vela_id).execute()
    if not result.data:
        return {"status": "error", "message": "Patient not found"}
    patient = result.data[0]
    return {
        "status": "success",
        "patient": {
            "id": patient.get("id"),
            "name": patient.get("name"),
            "vela_id": patient.get("vela_id"),
            "age": patient.get("age"),
            "gender": patient.get("gender"),
            "blood_group": patient.get("blood_group"),
            "allergies": patient.get("allergies"),
            "existing_conditions": patient.get("existing_conditions"),
            "emergency_contact_name": patient.get("emergency_contact_name"),
            "emergency_contact_phone": patient.get("emergency_contact_phone"),
            "emergency_contact_relation": patient.get("emergency_contact_relation"),
            "phone": patient.get("phone")
        }
    }

from fastapi import Request
# Only these columns can be changed through the patient-facing edit form. Everything else
# (vela_id, risk_score, diagnosis, status, password_hash, ward, doctor …) is clinical/system
# data that a patient must never be able to overwrite by sending extra JSON fields.
_PATIENT_EDITABLE = {
    "name", "date_of_birth", "gender", "blood_group", "phone", "email", "height", "weight",
    "allergies", "existing_conditions", "emergency_contact_name", "emergency_contact_phone",
    "emergency_contact_relation", "insurance_provider", "insurance_id", "language",
}
_PATIENT_NUMERIC = {"height", "weight"}

@fastapi_app.put("/api/patient/update/{patient_id}")
async def update_patient(patient_id: str, request: Request):
    data = await request.json()
    if not isinstance(data, dict):
        return {"status": "error", "message": "Invalid request"}

    # A signed-in patient may only edit their own record.
    sess = getattr(request.state, "session", None) or {}
    if sess.get("role") == "patient" and sess.get("staff_id") and sess.get("staff_id") != patient_id:
        return _JSONResponse(status_code=403, content={"status": "error", "message": "You can only edit your own details"})

    update = {}
    for k, v in data.items():
        if k not in _PATIENT_EDITABLE:
            continue
        if isinstance(v, str):
            v = v.strip()
        if k in _PATIENT_NUMERIC:
            if v in ("", None):
                v = None
            else:
                try:
                    v = float(v)
                except (TypeError, ValueError):
                    return {"status": "error", "message": f"{k.capitalize()} must be a number"}
        elif v == "":
            v = None
        update[k] = v

    if "name" in update and not update["name"]:
        return {"status": "error", "message": "Name can't be empty"}
    if "phone" in update and update["phone"] and len(re.sub(r"\D", "", update["phone"])) < 7:
        return {"status": "error", "message": "Please enter a valid phone number"}
    if "email" in update and update["email"] and "@" not in update["email"]:
        return {"status": "error", "message": "Please enter a valid email address"}
    if update.get("date_of_birth"):
        try:
            dob = datetime.strptime(update["date_of_birth"][:10], "%Y-%m-%d")
            today = datetime.now()
            update["age"] = today.year - dob.year - ((today.month, today.day) < (dob.month, dob.day))
        except ValueError:
            return {"status": "error", "message": "Please enter a valid date of birth"}

    if not update:
        return {"status": "error", "message": "Nothing to update"}

    try:
        result = await asyncio.to_thread(lambda: supabase.table("patients").update(update).eq("id", patient_id).execute())
    except Exception as e:
        print(f"⚠️ patient update failed: {e}")
        return {"status": "error", "message": "Could not save your details. Please try again."}
    if not result.data:
        return {"status": "error", "message": "Patient not found or update failed"}
    _LIVE_DOCS_CACHE.pop(patient_id, None)
    return {"status": "success", "patient": result.data[0]}

@fastapi_app.post("/api/patient/{patient_id}/revisit")
async def patient_revisit(patient_id: str, request: Request):
    """Patient taps "See the doctor about my results": join the same doctor's queue directly,
    without booking or going through reception. Reuses the normal arrival flow so the ticket,
    the doctor's live queue and the next-patient pre-cache all behave exactly as for a check-in."""
    sess = getattr(request.state, "session", None) or {}
    if sess.get("role") == "patient" and sess.get("staff_id") and sess.get("staff_id") != patient_id:
        return _JSONResponse(status_code=403, content={"status": "error", "message": "You can only do this for yourself"})
    try:
        body = await request.json()
    except Exception:
        body = {}
    reason = (body.get("reason") or "Follow-up: lab results ready").strip()[:200] if isinstance(body, dict) else "Follow-up: lab results ready"

    def _active_ticket():
        r = supabase_admin.table("tickets").select("*").eq("patient_id", patient_id).in_("status", ["waiting", "in-progress"]).order("created_at", desc=True).limit(1).execute()
        return r.data[0] if r.data else None

    def _people_ahead(ticket):
        if ticket.get("status") != "waiting":
            return 0
        q = supabase_admin.table("tickets").select("id").eq("status", "waiting").lt("queue_position", ticket["queue_position"])
        if ticket.get("doctor_id"):
            q = q.eq("doctor_id", ticket["doctor_id"])
        return len(q.execute().data or [])

    def _doctor_name(did):
        if not did:
            return "your doctor"
        r = supabase_admin.table("vela_staff").select("name").eq("id", did).execute()
        return (r.data[0]["name"] if r.data else "your doctor")

    # Already waiting or with the doctor? Don't create a duplicate — just report where they are.
    active = await asyncio.to_thread(_active_ticket)
    if active:
        ahead = await asyncio.to_thread(_people_ahead, active)
        return {"status": "success", "already_in_queue": True, "ticket_number": active["ticket_number"],
                "queue_position": ahead + 1, "people_ahead": ahead, "doctor_name": await asyncio.to_thread(_doctor_name, active.get("doctor_id"))}

    # Same doctor who saw them last; otherwise a doctor at the hospital that ran their tests.
    def _pick_doctor():
        last = supabase_admin.table("tickets").select("doctor_id").eq("patient_id", patient_id).order("created_at", desc=True).limit(1).execute()
        did = last.data[0].get("doctor_id") if last.data else None
        hid = None
        if did:
            st = supabase_admin.table("vela_staff").select("hospital_id").eq("id", did).eq("active", True).execute()
            if st.data:
                hid = st.data[0].get("hospital_id")
            else:
                did = None
        if not did:
            rows = local_query("SELECT hospital_id FROM test_orders WHERE patient_id = ? AND hospital_id IS NOT NULL ORDER BY ordered_at DESC LIMIT 1", (patient_id,))
            hid = rows[0]["hospital_id"] if rows else None
            if hid:
                docs = supabase_admin.table("vela_staff").select("id").eq("hospital_id", hid).eq("role", "doctor").eq("active", True).order("online", desc=True).limit(1).execute()
                did = docs.data[0]["id"] if docs.data else None
        return did, hid

    doctor_id, hospital_id = await asyncio.to_thread(_pick_doctor)
    if not doctor_id:
        return {"status": "error", "message": "We couldn't find your doctor right now. Please ask at the reception desk."}

    def _create_appointment():
        hosp = supabase_admin.table("vela_hospitals").select("name, address").eq("id", hospital_id).execute() if hospital_id else None
        h = (hosp.data[0] if hosp and hosp.data else {})
        now = datetime.now()
        payload = json.dumps({"checklist": {}, "patient_notes": reason, "doctor_id": doctor_id, "doctor_name": _doctor_name(doctor_id)})
        res = supabase_admin.table("appointments").insert({
            "patient_id": patient_id, "hospital_name": h.get("name"), "hospital_address": h.get("address"),
            "hospital_place_id": hospital_id, "date": now.strftime("%Y-%m-%d"), "time": now.strftime("%H:%M"),
            "doctor_id": doctor_id, "status": "scheduled", "reason": payload,
        }).execute()
        return res.data[0] if res.data else None

    appointment = await asyncio.to_thread(_create_appointment)
    if not appointment:
        return {"status": "error", "message": "Could not add you to the queue. Please try again."}

    arrived = await mark_appointment_arrived(appointment["id"])
    if not isinstance(arrived, dict) or arrived.get("status") != "success":
        return {"status": "error", "message": "Could not add you to the queue. Please try again."}

    # Let the doctor see why this patient is back.
    try:
        await asyncio.to_thread(lambda: supabase_admin.table("tickets").update({"notes": reason}).eq("ticket_number", arrived["ticket_number"]).execute())
    except Exception as e:
        print(f"⚠️ Warning: could not label follow-up ticket: {e}")

    ticket = await asyncio.to_thread(_active_ticket)
    ahead = await asyncio.to_thread(_people_ahead, ticket) if ticket else max(0, (arrived.get("queue_position") or 1) - 1)
    return {"status": "success", "already_in_queue": False, "appointment_id": appointment["id"],
            "ticket_number": arrived["ticket_number"], "queue_position": ahead + 1, "people_ahead": ahead,
            "doctor_name": await asyncio.to_thread(_doctor_name, doctor_id)}


@fastapi_app.get("/api/patient/by-email/{email}")
async def get_patient_by_email(email: str):
    # Runs in a thread so a slow/unreachable DB can't block the event loop;
    # this endpoint is the patient-login fallback and must fail readably.
    try:
        result = await asyncio.to_thread(
            lambda: supabase.table("patients").select("*").eq("email", email).execute()
        )
    except Exception as e:
        print(f"⚠️ by-email lookup failed: {e}")
        return {"status": "error", "message": "Database unreachable — please try again"}
    if not result.data:
        # Return 404 behavior by sending error status
        return {"status": "error", "message": "Patient not found"}
    return {"status": "success", "patient": result.data[0]}

@fastapi_app.get("/api/patients/list")
async def list_patients(hospital_id: Optional[str] = None):
    def _work():
        query = supabase.table("patients").select("*")
        if hospital_id:
            try:
                admissions = supabase.table("admissions").select("patient_id").eq("hospital_id", hospital_id).execute()
                p_ids = [a["patient_id"] for a in admissions.data if a.get("patient_id")] if admissions.data else []

                tickets = supabase.table("tickets").select("patient_id").eq("hospital_id", hospital_id).execute()
                t_ids = [t["patient_id"] for t in tickets.data if t.get("patient_id")] if tickets.data else []

                all_ids = list(set(p_ids + t_ids))
                if all_ids:
                    query = query.in_("id", all_ids)
                else:
                    return {"status": "success", "patients": []}
            except Exception:
                pass
        result = query.order("risk_score", desc=True).execute()
        return {"status": "success", "patients": result.data}
    return await asyncio.to_thread(_work)

@fastapi_app.get("/api/patients/emergency")
async def emergency_patients(hospital_id: Optional[str] = None):
    from datetime import date
    today_str = date.today().isoformat()   # e.g. "2026-05-28"

    # Only surface patients who BOTH:
    #   1. Have risk_score > 70  (clinically high-risk)
    #   2. Have an ACTIVE ticket today (waiting OR in-progress)
    # This prevents ghost patients from old test data appearing in Priority Attention
    # while the queue shows "No active patients" — the exact state mismatch.
    # Threaded: this endpoint is polled every 30s by the doctor sidebar.
    def _work():
        try:
            active_tickets = (
                supabase.table("tickets")
                .select("patient_id")
                .in_("status", ["waiting", "in-progress"])
                .gte("created_at", f"{today_str}T00:00:00")
                .execute()
            )
            active_patient_ids = list({
                t["patient_id"] for t in (active_tickets.data or [])
                if t.get("patient_id")
            })
        except Exception:
            active_patient_ids = []

        if not active_patient_ids:
            return {"status": "success", "patients": []}

        result = (
            supabase.table("patients")
            .select("*")
            .gt("risk_score", 70)
            .in_("id", active_patient_ids)
            .order("risk_score", desc=True)
            .execute()
        )
        return {"status": "success", "patients": result.data}
    return await asyncio.to_thread(_work)


@fastapi_app.get("/api/patients/search")
def search_patients(q: str = ""):
    q = (q or "").strip()
    if len(q) < 2:
        return {"status": "success", "patients": []}
    try:
        result = (
            supabase.table("patients")
            .select("*")
            .or_(f"name.ilike.%{q}%,vela_id.ilike.%{q}%")
            .order("risk_score", desc=True)
            .limit(20)
            .execute()
        )
        return {"status": "success", "patients": result.data}
    except Exception as e:
        print(f"⚠️ Patient search failed: {e}")
        return {"status": "success", "patients": []}


@fastapi_app.get("/api/patients/{patient_id}")
async def get_patient(patient_id: str):
    import asyncio
    
    # Query all patient details in parallel threads to reduce latency from ~750ms to ~150ms!
    patient_res, docs_res, meds_res, notes_res, reminders_res = await asyncio.gather(
        asyncio.to_thread(supabase.table("patients").select("*").eq("id", patient_id).execute),
        asyncio.to_thread(supabase.table("documents").select("*").eq("patient_id", patient_id).order("uploaded_at", desc=True).execute),
        asyncio.to_thread(supabase.table("medications").select("*").eq("patient_id", patient_id).execute),
        asyncio.to_thread(supabase.table("notes").select("*").eq("patient_id", patient_id).order("created_at", desc=True).execute),
        asyncio.to_thread(supabase.table("reminders").select("*").eq("patient_id", patient_id).order("due_time").execute)
    )
    
    return {
        "status": "success",
        "patient": patient_res.data[0] if patient_res.data else None,
        "documents": docs_res.data,
        "medications": meds_res.data,
        "notes": notes_res.data,
        "reminders": reminders_res.data
    }

@fastapi_app.post("/api/patients/add")
def add_patient(data: dict):
    result = supabase.table("patients").insert({
        "name": data.get("name"),
        "age": data.get("age"),
        "gender": data.get("gender"),
        "blood_group": data.get("blood_group"),
        "ward": data.get("ward"),
        "room": data.get("room"),
        "doctor": data.get("doctor"),
        "status": "stable",
        "risk_score": 0
    }).execute()
    return {"status": "success", "patient": result.data[0]}

# --- DOCUMENTS ---
# Short-lived cache of a patient's document digest for Atlas (each question re-read it from the DB).
_LIVE_DOCS_CACHE: dict = {}
_LIVE_DOCS_TTL = 15  # seconds
_bg_tasks: set = set()  # keeps fire-and-forget tasks alive until they finish

async def async_process_document_pipeline(doc_id: str, file_bytes: bytes, filename: str, patient_id: str):
    """
    Background worker that handles heavy text extraction (fitz), Mem0 sync,
    OpenAI parsing, Supabase commits, and final Socket.IO timeline_updated broadcasts.
    This runs completely concurrently and asynchronously on background threads.
    """
    # Cap concurrent ingestions so a burst of uploads can't backlog the
    # dedicated pool (each pipeline still runs to completion, just queued).
    async with _PIPELINE_SEMAPHORE:
      try:
        import fitz
        from datetime import datetime
        import json
        
        print(f"📥 Heavy Ingestion Pipeline started in background for doc {doc_id}...")
        
        # 1. Extract text. Prefer embedded PDF text (fast + exact for digital
        #    reports); fall back to preprocessing + vision OCR for images and
        #    scanned/photo PDFs (common with Indian medical records).
        import doc_ocr
        ext = filename.split('.')[-1].lower() if '.' in filename else ''
        ocr = None            # vision result — set only when we OCR an image/scan
        display_url = None    # base64 of the original page, for doctor review

        embedded_text = ""
        if ext not in ["jpg", "jpeg", "png", "webp", "bmp", "tiff", "tif", "heic"]:
            try:
                pdf = await bg_run(fitz.open, stream=file_bytes, filetype="pdf")
                embedded_text = "\n".join([page.get_text() for page in pdf]).strip()
                pdf.close()
            except Exception as e:
                print(f"⚠️ fitz text extraction failed for {filename}: {e}")

        if len(embedded_text) >= 120:
            # Digital, machine-readable report — trust the embedded text.
            raw_text = embedded_text
        else:
            # Image or scanned/photo PDF → preprocess (deskew/contrast/upscale)
            # then vision OCR with handwriting + low-confidence flagging.
            _fallback = {"doc_type": "unreadable", "overall_confidence": "low",
                         "needs_review": True, "legible_text": "", "values": [],
                         "critical_flags": [], "risk_score": 0,
                         "summary": "Automated reading failed; original image attached for manual review.",
                         "review_reason": "Automated OCR could not read this document."}
            try:
                images = await bg_run(doc_ocr.render_document_to_images, file_bytes, filename)
                display_url = await bg_run(doc_ocr.make_display_data_url, images[0])

                # AUTO-ROUTING — a radiograph is not a page of text. Running one
                # through the OCR prompt yields doc_type=unreadable and no
                # findings, so scans are detected here and handed to the
                # radiology reader instead. The doctor never picks a mode.
                prepared = [await bg_run(imaging.prepare_for_vision, im) for im in images]
                kind = await bg_run(imaging.classify_image, openai_client, prepared[0])
                if kind["kind"] == "radiology":
                    print(f"🩻 {filename} classified as radiology ({kind['modality']}) "
                          f"— routing to imaging second read.")
                    context = await _build_imaging_context(patient_id)
                    study = await asyncio.wait_for(
                        bg_run(imaging.analyze_study, openai_client, prepared,
                               filename, context),
                        timeout=90.0,
                    )
                    if study.get("is_radiology"):
                        row = await _persist_imaging_study(
                            patient_id, filename, study, display_url,
                            uploaded_by="", existing_document_id=doc_id,
                        )
                        await sio.emit("imaging_analyzed", {
                            "patient_id": patient_id, "study_id": row["id"],
                            "document_id": doc_id, "urgent": row["urgent"],
                            "summary": imaging.summary_line(study),
                        })
                        await sio.emit("timeline_updated", {
                            "patient_id": patient_id, "document_id": doc_id,
                            "status": "imaging",
                        })
                        return
                    # Classifier said scan, reader disagreed — fall through to OCR.
                    print(f"↩️ {filename}: reader rejected radiology, falling back to OCR.")

                preprocessed = [await bg_run(doc_ocr.preprocess_image, im) for im in images]
                ocr = await asyncio.wait_for(
                    bg_run(doc_ocr.vision_extract, openai_client, preprocessed, filename),
                    timeout=60.0
                )
                raw_text = ocr["legible_text"] or f"Scanned document: {filename} (no clearly legible text)."
            except asyncio.TimeoutError:
                print(f"⚠️ Vision OCR timed out for {filename}")
                ocr = dict(_fallback, review_reason="Automated OCR timed out.")
                raw_text = f"Scanned document {filename}. OCR timed out — needs manual review."
            except Exception as e:
                print(f"⚠️ Vision OCR failed for {filename}: {e}")
                ocr = _fallback
                raw_text = f"Document {filename}. Automated reading failed — needs manual review."

        # 2. Add to Mem0 profile memory asynchronously
        today_str = datetime.utcnow().strftime("%Y-%m-%d")
        summary_mem = f"""
        Patient report uploaded on {today_str}
        File name: {filename}
        Content extracted: {raw_text[:4000]}
        """
        # mem0 sync and RAG indexing no longer sit on the critical path: the doctor only needs the
        # parsed values/flags (step 3), so these run in the background while the model parses.
        async def _mem0_sync():
            if not mem0_client:
                return
            try:
                await asyncio.wait_for(
                    bg_run(mem0_client.add, messages=[{"role": "user", "content": summary_mem}], user_id=patient_id),
                    timeout=15.0
                )
            except asyncio.TimeoutError:
                print(f"⚠️ Warning: mem0 add timed out for doc {doc_id} — skipping memory sync")
            except Exception as e:
                print(f"⚠️ Warning: Failed to store report memory in mem0: {e}")

        async def _rag_index():
            try:
                await bg_run(process_document_for_rag, patient_id, doc_id, filename, today_str, raw_text)
            except Exception as e:
                print(f"⚠️ Warning: RAG processing failed for doc {doc_id}: {e}")

        for _t in (asyncio.create_task(_mem0_sync()), asyncio.create_task(_rag_index())):
            _bg_tasks.add(_t)
            _t.add_done_callback(_bg_tasks.discard)

        # 2c. SAFETY GATE — handwritten / low-confidence / unreadable documents
        #     must NOT be confidently auto-transcribed or auto-structured. Store
        #     only what was clearly legible, keep the original image, flag for
        #     review, and let the reviewing doctor make the final call.
        if ocr and ocr.get("needs_review"):
            review_flags = [doc_ocr.NEEDS_REVIEW_FLAG]
            if ocr.get("review_reason"):
                review_flags.append(ocr["review_reason"])
            review_flags += (ocr.get("critical_flags") or [])
            review_payload = {
                "values": ocr.get("values") or [],   # empty unless clearly printed
                "critical_flags": review_flags,
                "risk_score": 0,                       # never auto-score unreviewed docs
                "summary": (ocr.get("summary") or raw_text[:2000]),
            }
            if display_url:
                review_payload["file_url"] = display_url
            await bg_run(
                supabase.table("documents").update(review_payload).eq("id", doc_id).execute
            )
            # Deliberately do NOT update patient diagnosis/risk or auto-insert
            # medications from content that has not been human-verified.
            await sio.emit("timeline_updated", {
                "patient_id": patient_id, "document_id": doc_id,
                "needs_review": True, "status": "needs_review"
            })
            print(f"🩺 Document {doc_id} flagged for doctor review "
                  f"(type={ocr.get('doc_type')}, confidence={ocr.get('overall_confidence')}).")
            return

        # 3. Call OpenAI to extract structured clinical information
        system_prompt = """You are an expert clinical medical parsing assistant.
Analyze the provided medical report raw text and extract structured clinical information.
You MUST respond with a JSON object containing exactly the following keys:
{
  "diagnoses": ["diagnosis1", "diagnosis2", ...],
  "medications": ["medication1", "medication2", ...],
  "lab_timeline": [
    { "test": "Test Name", "result": "12.5", "unit": "g/dL", "status": "normal/high/low", "reference": "12-16" }
  ],
  "critical_flags": ["flag1", "flag2", ...],
  "risk_score": 45
}
Ensure the JSON is strictly compliant and matches the format exactly. Do not wrap in markdown code blocks or add extra explanations."""

        # 3. Call OpenAI to extract structured clinical information
        # Wrapped in wait_for so a slow/hanging LLM response can never hold this background thread indefinitely.
        try:
            res = await asyncio.wait_for(
                bg_run(
                    openai_client.chat.completions.create,
                    model="gpt-4o-mini",
                    messages=[
                        {"role": "system", "content": system_prompt},
                        {"role": "user", "content": f"Filename: {filename}\nContent:\n{raw_text[:12000]}"}
                    ],
                    response_format={"type": "json_object"}
                ),
                timeout=30.0
            )
        except asyncio.TimeoutError:
            print(f"⚠️ Warning: OpenAI parse timeout for doc {doc_id}. Storing raw text only.")
            # Commit what we have and exit gracefully — don't block
            await bg_run(
                supabase.table("documents").update({
                    "summary": raw_text[:8000],
                    "values": [],
                    "critical_flags": [],
                    "risk_score": 0
                }).eq("id", doc_id).execute
            )
            await sio.emit("timeline_updated", {"patient_id": patient_id, "document_id": doc_id, "status": "done"})
            return
        
        data_str = res.choices[0].message.content.strip()
        parsed_data = json.loads(data_str)
        
        diagnoses = parsed_data.get("diagnoses", [])
        medications = parsed_data.get("medications", [])
        lab_timeline = parsed_data.get("lab_timeline", [])
        critical_flags = parsed_data.get("critical_flags", [])
        risk_score = int(parsed_data.get("risk_score", 0))

        # 4. Commit results to Supabase (update documents table)
        commit_payload = {
            "values": lab_timeline,
            "critical_flags": critical_flags,
            "risk_score": risk_score,
            "summary": raw_text[:8000]  # Store actual raw text now that processing is done!
        }
        if display_url:
            commit_payload["file_url"] = display_url  # keep original scan viewable
        await bg_run(
            supabase.table("documents").update(commit_payload).eq("id", doc_id).execute
        )

        # 5. Update patient risk score and main diagnosis in Supabase
        patient_update = {
            "risk_score": risk_score,
            "updated_at": datetime.utcnow().isoformat()
        }
        if diagnoses:
            patient_update["diagnosis"] = diagnoses[0]
            
        await bg_run(
            supabase.table("patients").update(patient_update).eq("id", patient_id).execute
        )

        # 6. Insert newly parsed medications into medications table
        for med in medications:
            try:
                await bg_run(
                    supabase.table("medications").insert({
                        "patient_id": patient_id,
                        "name": med,
                        "dosage": "As directed",
                        "frequency": "Daily",
                        "prescribed_by": "Vela Auto-Ingest",
                        "start_date": datetime.utcnow().strftime("%Y-%m-%d")
                    }).execute
                )
            except Exception:
                pass

        # 7. Check if this patient is currently active in any doctor's queue, and if so, trigger invalidation
        ticket_res = await bg_run(
            supabase.table("tickets").select("doctor_id").eq("patient_id", patient_id).in_("status", ["waiting", "in-progress"]).execute
        )
        if ticket_res.data:
            for ticket in ticket_res.data:
                doctor_id = ticket.get("doctor_id")
                if doctor_id:
                    try:
                        from receptionist import invalidate_and_recache
                        await invalidate_and_recache(doctor_id)
                        print(f"🕵️ Live cache invalidated and lookahead re-run triggered for doctor {doctor_id} due to finished doc background parsing of patient {patient_id}")
                    except Exception as cache_err:
                        print(f"⚠️ Warning: Failed to invalidate and recache during doc delete for doctor {doctor_id}: {cache_err}")

        # 8. Emit live update event via Socket.IO
        await sio.emit("timeline_updated", {
            "patient_id": patient_id,
            "document_id": doc_id,
            "filename": filename,
            "risk_score": risk_score,
            "critical_flags": critical_flags,
            "status": "done"
        })
        print(f"✅ Ingestion Pipeline finished. Document {doc_id} successfully parsed and timeline updated for patient {patient_id}!")

      except Exception as e:
        print(f"⚠️ Error in background document pipeline: {e}")


async def async_process_document_deletion_pipeline(doc_id: str, patient_id: str):
    """
    Background worker that handles active ticket scanning, lock cache invalidations,
    and Socket.IO notifications asynchronously after the DB delete has resolved.
    Ensures that deletion HTTP responses are never blocked by cache locking.
    """
    try:
        # 0. Delete RAG chunks for this document
        try:
            await bg_run(delete_chunks_for_document, doc_id)
        except Exception as rag_err:
            print(f"⚠️ Warning: RAG chunk deletion failed for doc {doc_id}: {rag_err}")

        # 1. Check if this patient is currently in an active, uncompleted clinic ticket
        ticket_res = await bg_run(
            supabase.table("tickets").select("doctor_id").eq("patient_id", patient_id).in_("status", ["waiting", "in-progress"]).execute
        )

        # 2. Invalidate and recache lookahead if they are queued for a doctor
        if ticket_res.data:
            for ticket in ticket_res.data:
                doctor_id = ticket.get("doctor_id")
                if doctor_id:
                    try:
                        from receptionist import invalidate_and_recache
                        # Trigger invalidate_and_recache which handles per-doctor lock isolated pre-caching
                        await invalidate_and_recache(doctor_id)
                        print(f"🕵️ Live cache invalidated and lookahead re-run triggered for doctor {doctor_id} due to background doc deletion of patient {patient_id}")
                    except Exception as cache_err:
                        print(f"⚠️ Warning: Failed to invalidate and recache during doc delete for doctor {doctor_id}: {cache_err}")

        # 3. Emit a Socket.IO event timeline_updated to the patient's room
        await sio.emit("timeline_updated", {
            "patient_id": patient_id,
            "document_id": doc_id,
            "deleted": True
        })
        print(f"✅ Document {doc_id} deletion background sync completed for patient {patient_id}!")
    except Exception as e:
        print(f"⚠️ Error in background document deletion sync: {e}")


@fastapi_app.post("/api/upload/document")
async def upload_document(
    file: UploadFile = File(...),
    patient_id: str = Form(...)
):
    try:
        # 1. Read file bytes instantly
        file_bytes = await file.read()
        today_str = datetime.utcnow().strftime("%Y-%m-%d")

        # 2. Write a skeleton row into the documents table immediately in a background thread
        # Use summary="processing" as our database-safe virtual status!
        doc_result = await asyncio.to_thread(
            supabase.table("documents").insert({
                "patient_id": patient_id,
                "filename": file.filename,
                "report_date": today_str,
                "risk_score": 0,
                "summary": "processing",  # Our virtual status flag
                "values": [],
                "critical_flags": [],
            }).execute
        )
        
        if not doc_result.data:
            return {"status": "error", "message": "Failed to insert document skeleton"}
            
        doc_id = doc_result.data[0]["id"]
        inserted_doc = doc_result.data[0]

        # 3. Instantly spawn the heavy background worker
        asyncio.create_task(async_process_document_pipeline(doc_id, file_bytes, file.filename, patient_id))

        # 4. Return instant 200 OK success response in <15ms
        return {
            "status": "success",
            "message": "Document ingestion started in background",
            "document_id": doc_id,
            "document": inserted_doc  # Return the skeleton document so frontend can append it instantly!
        }
    except Exception as e:
        print(f"⚠️ Error in fire-and-forget document upload: {e}")
        return {"status": "error", "message": f"Upload failed: {str(e)}"}

@fastapi_app.delete("/api/upload/document/{doc_id}")
async def delete_document(doc_id: str):
    try:
        # 1. Fetch patient_id instantly in a thread
        doc_res = await asyncio.to_thread(
            supabase.table("documents").select("patient_id").eq("id", doc_id).execute
        )
        if not doc_res.data:
            return {"status": "error", "message": "Document not found"}
        patient_id = doc_res.data[0]["patient_id"]
        _LIVE_DOCS_CACHE.pop(patient_id, None)

        # 2. Delete the document row instantly in a thread
        await asyncio.to_thread(
            supabase.table("documents").delete().eq("id", doc_id).execute
        )

        # 3. Spawn all active ticket scans and lookahead cache invalidations in the background
        asyncio.create_task(async_process_document_deletion_pipeline(doc_id, patient_id))

        # 4. Instantly return success to the client in <20ms!
        return {"status": "success", "message": "Document deleted successfully"}
    except Exception as e:
        print(f"⚠️ Error in fire-and-forget document deletion: {e}")
        return {"status": "error", "message": f"Delete failed: {str(e)}"}


# --- RADIOLOGY IMAGING SECOND READ (X-ray / CT / MRI / Ultrasound) ---
# Decision support only. Findings stay in `pending` review status and never
# touch patient diagnosis, risk score, or medications until a doctor confirms
# them via /api/imaging/{study_id}/review. See imaging.py for the rationale.

async def _patient_profile_text(patient_id: str) -> str:
    """
    Registration-record facts (allergies, conditions, demographics) formatted as
    a citable source for Atlas/RAG. These live on the patients table and are not
    part of the document index, so without this every "any allergies?" question
    answered "not found" even when the record clearly listed one.
    Best-effort: any failure degrades to no profile rather than blocking a query.
    """
    try:
        res = await asyncio.to_thread(
            supabase.table("patients")
            .select("name, age, gender, blood_group, allergies, existing_conditions, ward, room, doctor")
            .eq("id", patient_id).limit(1).execute
        )
        if res.data:
            return rag_build_profile_block(res.data[0])
    except Exception as e:
        print(f"⚠️ profile block lookup failed: {e}")
    return ""


async def _build_imaging_context(patient_id: str, complaint: str = "") -> dict:
    """
    Assemble the clinical context the radiology prompt correlates findings
    against. Best-effort: imaging analysis must still run for a patient with no
    prior records, so every lookup failure degrades to an empty field.
    """
    context: dict = {"complaint": complaint or ""}
    try:
        pres = await asyncio.to_thread(
            supabase.table("patients")
            .select("age, gender, existing_conditions, allergies")
            .eq("id", patient_id).limit(1).execute
        )
        if pres.data:
            p = pres.data[0]
            context.update({
                "age": p.get("age"),
                "gender": p.get("gender"),
                "conditions": p.get("existing_conditions") or "",
                "allergies": p.get("allergies") or "",
            })
    except Exception as e:
        print(f"⚠️ imaging context: patient lookup failed: {e}")

    try:
        docs = await asyncio.to_thread(
            supabase.table("documents").select("values, report_date")
            .eq("patient_id", patient_id)
            .order("report_date", desc=True).limit(5).execute
        )
        labs: list[dict] = []
        for d in (docs.data or []):
            for v in (d.get("values") or []):
                # Abnormal results carry the correlation signal; normals just
                # burn context window.
                if isinstance(v, dict) and v.get("test") and \
                        str(v.get("status", "")).lower() not in ("normal", ""):
                    labs.append(v)
        context["recent_labs"] = labs[:12]
    except Exception as e:
        print(f"⚠️ imaging context: lab lookup failed: {e}")
        context["recent_labs"] = []

    return context


async def _persist_imaging_study(patient_id: str, filename: str, study: dict,
                                 image_data: str, uploaded_by: str,
                                 existing_document_id: str | None = None) -> dict:
    """
    Store the study locally and mirror a companion `documents` row so the study
    shows up in the patient timeline and gets indexed for RAG. Returns the row.

    `existing_document_id` is passed when this study arrived through the generic
    /api/upload/document pipeline, which already created a skeleton row — that
    row is updated in place instead of inserting a duplicate.
    """
    study_id = str(uuid.uuid4())
    now = datetime.utcnow().isoformat()
    today_str = datetime.utcnow().strftime("%Y-%m-%d")
    summary = imaging.summary_line(study)

    document_id = existing_document_id
    try:
        flags = []
        if study.get("urgent"):
            flags.append(imaging.URGENT_FLAG)
        flags += [f["finding"] for f in study.get("findings", [])
                  if f["severity"] in ("critical", "significant")]
        doc_payload = {
            "summary": summary,
            "values": [],
            "critical_flags": flags,
            # Deliberately 0: an unconfirmed AI read must not move the
            # patient's risk score. Confirmation is what promotes it.
            "risk_score": 0,
        }
        if existing_document_id:
            await asyncio.to_thread(
                supabase.table("documents").update(doc_payload)
                .eq("id", existing_document_id).execute
            )
        else:
            doc_res = await asyncio.to_thread(
                supabase.table("documents").insert({
                    "patient_id": patient_id,
                    "filename": filename,
                    "report_date": today_str,
                    **doc_payload,
                }).execute
            )
            if doc_res.data:
                document_id = doc_res.data[0]["id"]
    except Exception as e:
        print(f"⚠️ imaging: companion document row failed: {e}")

    await asyncio.to_thread(
        local_execute,
        """INSERT INTO imaging_studies
           (id, patient_id, document_id, filename, modality, body_region, view,
            analysis, image_data, urgent, review_status, uploaded_by, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (study_id, patient_id, document_id, filename, study.get("modality"),
         study.get("body_region"), study.get("view"), json.dumps(study),
         image_data, 1 if study.get("urgent") else 0, "pending", uploaded_by, now),
    )

    if document_id:
        try:
            await asyncio.to_thread(
                process_document_for_rag, patient_id, document_id, filename,
                today_str, f"{summary}\n\nImpression: {study.get('impression', '')}",
            )
        except Exception as e:
            print(f"⚠️ imaging: RAG indexing failed: {e}")

    return {
        "id": study_id,
        "patient_id": patient_id,
        "document_id": document_id,
        "filename": filename,
        "analysis": study,
        "image_data": image_data,
        "urgent": bool(study.get("urgent")),
        "review_status": "pending",
        "created_at": now,
    }


@fastapi_app.post("/api/imaging/analyze")
async def analyze_imaging(
    file: UploadFile = File(...),
    patient_id: str = Form(...),
    complaint: str = Form(""),
    uploaded_by: str = Form(""),
):
    """
    Upload a radiology image and get a structured second read back.

    Synchronous by design, unlike /api/upload/document: the doctor is standing
    at the screen waiting for this specific answer, so a fire-and-forget row
    they have to poll for would be worse UX than a ~15s wait with a spinner.
    """
    try:
        file_bytes = await file.read()
        filename = file.filename or "study.jpg"

        try:
            images = await bg_run(doc_ocr.render_document_to_images, file_bytes, filename)
        except Exception as e:
            return {"status": "error",
                    "message": f"Could not read this file as an image or PDF: {e}"}
        if not images:
            return {"status": "error", "message": "No readable image found in upload"}

        prepared = [await bg_run(imaging.prepare_for_vision, im) for im in images]

        # Guard: if this is a lab report the doctor dropped in the wrong tab,
        # say so instead of hallucinating anatomy that isn't there.
        kind = await bg_run(imaging.classify_image, openai_client, prepared[0])
        if kind["kind"] == "document":
            return {"status": "not_imaging", "kind": kind["kind"],
                    "message": "This looks like a text document, not a scan. "
                               "Upload it under Reports and it will be read as a lab report."}

        context = await _build_imaging_context(patient_id, complaint)

        try:
            study = await asyncio.wait_for(
                bg_run(imaging.analyze_study, openai_client, prepared, filename, context),
                timeout=90.0,
            )
        except asyncio.TimeoutError:
            return {"status": "error",
                    "message": "Imaging analysis timed out. Please retry."}

        if not study.get("is_radiology"):
            return {"status": "not_imaging",
                    "message": "This does not appear to be a radiology image.",
                    "detail": study.get("technical_quality") or ""}

        image_data = await bg_run(doc_ocr.make_display_data_url, images[0])
        row = await _persist_imaging_study(patient_id, filename, study,
                                           image_data, uploaded_by)

        await sio.emit("imaging_analyzed", {
            "patient_id": patient_id,
            "study_id": row["id"],
            "urgent": row["urgent"],
            "summary": imaging.summary_line(study),
        })
        return {"status": "success", "study": row}
    except Exception as e:
        print(f"⚠️ Error in imaging analysis: {e}")
        return {"status": "error", "message": f"Imaging analysis failed: {str(e)}"}


@fastapi_app.get("/api/imaging/patient/{patient_id}")
async def list_imaging_studies(patient_id: str):
    try:
        rows = await asyncio.to_thread(
            local_query,
            """SELECT * FROM imaging_studies WHERE patient_id = ?
               ORDER BY created_at DESC""",
            (patient_id,),
        )
        studies = []
        for r in rows:
            try:
                analysis = json.loads(r.get("analysis") or "{}")
            except Exception:
                analysis = {}
            studies.append({
                "id": r["id"],
                "patient_id": r["patient_id"],
                "document_id": r.get("document_id"),
                "filename": r.get("filename"),
                "analysis": analysis,
                "image_data": r.get("image_data"),
                "urgent": bool(r.get("urgent")),
                "review_status": r.get("review_status") or "pending",
                "reviewed_by": r.get("reviewed_by"),
                "reviewed_at": r.get("reviewed_at"),
                "review_note": r.get("review_note"),
                "confirmed_findings": json.loads(r.get("confirmed_findings") or "[]"),
                "created_at": r.get("created_at"),
            })
        return {"status": "success", "studies": studies}
    except Exception as e:
        print(f"⚠️ Error listing imaging studies: {e}")
        return {"status": "error", "message": str(e), "studies": []}


@fastapi_app.post("/api/imaging/{study_id}/review")
async def review_imaging_study(study_id: str, data: dict):
    """
    Doctor-in-the-loop gate. Only findings the doctor explicitly accepts here
    reach the patient record — as a signed clinical note, attributed to them.
    """
    try:
        rows = await asyncio.to_thread(
            local_query, "SELECT * FROM imaging_studies WHERE id = ?", (study_id,)
        )
        if not rows:
            return {"status": "error", "message": "Imaging study not found"}
        row = rows[0]

        decision = str(data.get("decision", "")).lower()
        if decision not in ("confirmed", "rejected"):
            return {"status": "error",
                    "message": "decision must be 'confirmed' or 'rejected'"}

        reviewer = data.get("reviewed_by") or "Unknown"
        note_text = (data.get("note") or "").strip()
        accepted = data.get("confirmed_findings") or []
        now = datetime.utcnow().isoformat()

        await asyncio.to_thread(
            local_execute,
            """UPDATE imaging_studies
               SET review_status = ?, reviewed_by = ?, reviewed_at = ?,
                   review_note = ?, confirmed_findings = ?
               WHERE id = ?""",
            (decision, reviewer, now, note_text, json.dumps(accepted), study_id),
        )

        if decision == "confirmed":
            try:
                analysis = json.loads(row.get("analysis") or "{}")
            except Exception:
                analysis = {}
            header = (f"{analysis.get('modality', 'Imaging')} "
                      f"{analysis.get('body_region', '')}".strip())
            lines = [f"IMAGING REVIEW — {header} ({row.get('filename')})"]
            if accepted:
                lines.append("Confirmed findings: " + "; ".join(str(f) for f in accepted))
            else:
                lines.append("Reviewed; no findings accepted as significant.")
            if note_text:
                lines.append(f"Doctor's note: {note_text}")
            lines.append(f"AI second read confirmed by {reviewer}.")
            try:
                await asyncio.to_thread(
                    supabase.table("notes").insert({
                        "patient_id": row["patient_id"],
                        "content": "\n".join(lines),
                        "created_by": reviewer,
                    }).execute
                )
            except Exception as e:
                print(f"⚠️ imaging review: note insert failed: {e}")

            # Only now — after a human signed off — is it safe to surface the
            # findings on the companion document row.
            if row.get("document_id") and accepted:
                try:
                    await asyncio.to_thread(
                        supabase.table("documents").update({
                            "critical_flags": [f"✓ {f}" for f in accepted],
                        }).eq("id", row["document_id"]).execute
                    )
                except Exception as e:
                    print(f"⚠️ imaging review: document update failed: {e}")

        await sio.emit("imaging_reviewed", {
            "patient_id": row["patient_id"], "study_id": study_id,
            "decision": decision, "reviewed_by": reviewer,
        })
        return {"status": "success", "decision": decision, "reviewed_at": now}
    except Exception as e:
        print(f"⚠️ Error reviewing imaging study: {e}")
        return {"status": "error", "message": str(e)}


@fastapi_app.delete("/api/imaging/{study_id}")
async def delete_imaging_study(study_id: str):
    try:
        rows = await asyncio.to_thread(
            local_query, "SELECT document_id FROM imaging_studies WHERE id = ?",
            (study_id,)
        )
        if not rows:
            return {"status": "error", "message": "Imaging study not found"}
        document_id = rows[0].get("document_id")
        await asyncio.to_thread(
            local_execute, "DELETE FROM imaging_studies WHERE id = ?", (study_id,)
        )
        if document_id:
            try:
                await asyncio.to_thread(
                    supabase.table("documents").delete().eq("id", document_id).execute
                )
            except Exception as e:
                print(f"⚠️ imaging delete: companion document removal failed: {e}")
        return {"status": "success"}
    except Exception as e:
        return {"status": "error", "message": str(e)}


# --- BACKGROUND PRE-ANALYSIS FOR ZERO LATENCY HANDOFF ---
@fastapi_app.post("/api/doctor/pre-analyze-next")
def pre_analyze_next(data: dict):
    doctor_id = data.get("doctor_id")
    if not doctor_id:
        return {"status": "error", "message": "Doctor ID is required"}

    # 1. Find the next waiting patient in the queue
    waiting_tickets = supabase_admin.table("tickets").select("*").eq("doctor_id", doctor_id).eq("status", "waiting").order("queue_position", desc=False).limit(1).execute().data
    if not waiting_tickets:
        return {"status": "success", "message": "No patients in queue to pre-analyze"}

    next_ticket = waiting_tickets[0]
    next_patient_id = next_ticket["patient_id"]

    # 2. Find any documents for this patient that have not been structured yet (where values is null or empty)
    docs = supabase_admin.table("documents").select("*").eq("patient_id", next_patient_id).execute().data or []
    unstructured_docs = [d for d in docs if not d.get("values") or len(d.get("values")) == 0]

    if not unstructured_docs:
        # Already fully analyzed and pre-fetched!
        return {"status": "success", "message": "Next patient is already fully analyzed", "patient_id": next_patient_id}

    print(f"⏳ Background pre-analyzing {len(unstructured_docs)} reports for next patient {next_patient_id}...")

    for doc in unstructured_docs:
        raw_text = doc.get("summary") or ""
        if not raw_text or len(raw_text) < 10:
            continue

        try:
            # Call GPT-4o to parse the raw text of the document and extract structured columns
            response = openai_client.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": f"""Extract structured lab results and risk metrics from this medical report text.
Return ONLY this JSON schema, no markdown:
{{
  "report_date": "YYYY-MM-DD",
  "values": [{{"test": "Hemoglobin", "result": "12.5", "unit": "g/dL", "status": "Low", "reference": "13.8 - 17.2"}}, {{"test": "WBC Count", "result": "11.2", "unit": "K/uL", "status": "High", "reference": "4.5 - 11.0"}}],
  "critical_flags": ["Severe Anemia"],
  "risk_score": 45,
  "summary": "Short 2-3 sentence overview of the diagnosis."
}}
Report text:
{raw_text}"""}],
                max_tokens=2000,
                response_format={"type": "json_object"}
            )
            report_data = json.loads(response.choices[0].message.content.strip())
            
            # Update the document table with high-quality clinical structure
            supabase_admin.table("documents").update({
                "report_date": report_data.get("report_date") or doc.get("report_date"),
                "risk_score": report_data.get("risk_score") or 0,
                "summary": report_data.get("summary") or raw_text[:500],
                "values": report_data.get("values") or [],
                "critical_flags": report_data.get("critical_flags") or [],
            }).eq("id", doc["id"]).execute()

        except Exception as err:
            print(f"⚠️ Error background parsing document {doc['id']}: {err}")

    # 3. Calculate holistic health trend and patient risk score for next patient
    try:
        all_docs = supabase_admin.table("documents").select("*").eq("patient_id", next_patient_id).execute().data or []
        if all_docs:
            highest_risk = max([d.get("risk_score") or 0 for d in all_docs])
            status = "emergency" if highest_risk > 70 else "monitoring" if highest_risk > 40 else "stable"
            
            # Run Atlas Patient Overall Analysis
            history_context = "\n".join([f"- {r.get('report_date')}: Risk {r.get('risk_score')}, {r.get('summary')}" for r in all_docs])
            atlas_patient_prompt = f"As Atlas AI, provide a concise holistic analysis of this patient's health trend (improving/stable/deteriorating). Highlight the most critical ongoing issue. History:\n{history_context}\nReturn ONLY 3 sentences."
            atlas_patient_res = openai_client.chat.completions.create(
                model="gpt-4o",
                messages=[{"role": "user", "content": atlas_patient_prompt}]
            )
            atlas_analysis = atlas_patient_res.choices[0].message.content.strip()
            confidence = "HIGH" if len(all_docs) >= 3 else "MEDIUM" if len(all_docs) >= 2 else "LOW"

            supabase_admin.table("patients").update({
                "risk_score": highest_risk,
                "status": status,
                "atlas_analysis": atlas_analysis,
                "atlas_confidence": confidence,
                "atlas_analysis_updated_at": datetime.utcnow().isoformat(),
                "updated_at": "NOW()"
            }).eq("id", next_patient_id).execute()

    except Exception as err:
        print(f"⚠️ Error updating next patient overall stats: {err}")

    return {"status": "success", "message": "Pre-analysis completed successfully", "patient_id": next_patient_id}

# --- AMBIENT VOICE-TO-ORDER ---
@fastapi_app.post("/api/doctor/ambient-consult/process")
async def ambient_consult_process(req: AmbientConsultRequest):
    try:
        # Pass the raw transcript to LLM completion model
        response = openai_client.chat.completions.create(
            model="gpt-4o",
            response_format={"type": "json_object"},
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are an elite medical scribe embedded in VELA OS. Analyze the natural dialogue between "
                        "a doctor and a patient. Ignore small talk, greetings, and irrelevant banter. Extract "
                        "structured medical orders exactly as stated by the doctor. Your output must strictly "
                        "conform to this JSON schema:\n"
                        "{\n"
                        '  "prescriptions": [\n'
                        '    {"medication_name": "string", "dosage": "string", "frequency": "string", "duration": "string"}\n'
                        "  ],\n"
                        '  "lab_requisitions": ["string"],\n'
                        '  "follow_up_days": integer\n'
                        "}"
                    )
                },
                {
                    "role": "user",
                    "content": f"Transcript of live doctor-patient consultation:\n{req.transcript_text}"
                }
            ],
            temperature=0.1
        )
        
        extracted = json.loads(response.choices[0].message.content)
        
        # Structure default values
        orders_payload = {
            "patient_id": req.patient_id,
            "prescriptions": extracted.get("prescriptions", []),
            "lab_requisitions": extracted.get("lab_requisitions", []),
            "follow_up_days": extracted.get("follow_up_days")
        }
        
        # Real-time Delivery Hook
        await sio.emit("draft_orders_populated", orders_payload)
        
        return {"status": "success", "orders": orders_payload}
        
    except Exception as e:
        print(f"⚠️ Error in ambient consult process: {e}")
        return {"status": "error", "message": str(e)}


@fastapi_app.post("/api/doctor/ambient-consult/approve")
async def ambient_consult_approve(req: AmbientConsultApproveRequest):
    try:
        from datetime import timedelta
        
        # 1. Prescriptions
        created_meds = []
        for med in req.prescriptions:
            res = supabase.table("medications").insert({
                "patient_id": req.patient_id,
                "name": med.medication_name,
                "dosage": med.dosage,
                "frequency": med.frequency,
                "prescribed_by": req.prescribed_by,
                "start_date": datetime.utcnow().date().isoformat(),
                "notes": "Prescribed via Ambient Consultation Scribe."
            }).execute()
            
            if mem0_client:
                try:
                    mem0_client.add(
                        messages=[{"role": "user", "content": f"Medication added: {med.medication_name} {med.dosage} {med.frequency}"}],
                        user_id=req.patient_id
                    )
                except Exception as mem_err:
                    print(f"⚠️ Warning: mem0 add failed in ambient approval: {mem_err}")
            
            if res.data:
                created_meds.append(res.data[0])

        # 2. Lab Requisitions — routed to the right department and priced by catalog.
        patient_name = lookup_patient_name(req.patient_id) or "Patient"
        created_orders = create_test_orders(
            patient_id=req.patient_id,
            test_names=req.lab_requisitions,
            doctor_name=req.prescribed_by,
            hospital_id=resolve_order_hospital(patient_id=req.patient_id),
            priority="routine",
            notes="Ordered via Ambient Consultation Scribe.",
        )

        if created_orders:
            await notify_tests_ordered(
                patient_id=req.patient_id,
                patient_name=patient_name,
                orders=created_orders,
                doctor_name=req.prescribed_by,
            )

        # 3. Follow-up Reminders
        created_reminder = None
        if req.follow_up_days and req.follow_up_days > 0:
            due_time = (datetime.utcnow() + timedelta(days=req.follow_up_days)).isoformat()
            try:
                res = supabase.table("reminders").insert({
                    "patient_id": req.patient_id,
                    "message": f"Follow-up consultation in {req.follow_up_days} days.",
                    "due_time": due_time,
                    "is_done": False
                }).execute()
                if res.data:
                    created_reminder = res.data[0]
            except Exception as rem_err:
                print(f"⚠️ Warning: Supabase reminder failed, using local SQLite: {rem_err}")
                local_execute(
                    "CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, patient_id TEXT, message TEXT, due_time TEXT, is_done INTEGER DEFAULT 0)"
                )
                reminder_id = str(uuid.uuid4())
                local_execute(
                    "INSERT INTO reminders (id, patient_id, message, due_time, is_done) VALUES (?, ?, ?, ?, 0)",
                    (reminder_id, req.patient_id, f"Follow-up consultation in {req.follow_up_days} days.", due_time)
                )

        return {
            "status": "success",
            "medications": created_meds,
            "lab_orders": created_orders,
            "reminder": created_reminder
        }

    except Exception as e:
        print(f"⚠️ Error in ambient consult approval: {e}")
        return {"status": "error", "message": str(e)}

# --- VOICE QUERY ---
@fastapi_app.post("/api/voice/query")
async def voice_query(data: dict):
    question = data.get("query")
    patient_id = data.get("patient_id")
    session_id = data.get("session_id", "default")
    user_role = data.get("user_role", "Doctor")

    session = conversation_history[session_id]

    # Who is speaking, and who are they with? Resolved once, up front, so every
    # tier below can rely on it. The doctor's active consult is preferred over
    # the session because it is scoped to this doctor and survives a restart —
    # which is what lets "what's his hemoglobin?" work with no name at all.
    doctor_id = None
    if user_role != "Patient":
        doctor_id = await resolve_doctor_id(data, session)
        if not patient_id:
            active = await get_active_consult(doctor_id)
            if active:
                patient_id = active["patient_id"]
                session["current_patient_id"] = patient_id
                session["current_patient_name"] = active.get("patient_name")
            elif session.get("current_patient_id"):
                patient_id = session["current_patient_id"]

    # --- PATIENT ROLE PORTAL: STRICT COMPANION INSTRUCTION ---
    if user_role == "Patient":
        docs_data = []
        if patient_id:
            # Sort by report_date DESC so the NEWEST uploaded report is always first in Atlas context.
            # This prevents old prototype/stale reports from taking priority over fresh uploads.
            docs_res = supabase.table("documents") \
                .select("filename, report_date, risk_score, summary, values, critical_flags") \
                .eq("patient_id", patient_id) \
                .neq("summary", "processing") \
                .order("report_date", desc=True) \
                .execute()
            docs_data = docs_res.data or []
        
        patient_info = {}
        if patient_id:
            p_res = supabase.table("patients").select("name, age, gender, blood_group, allergies, existing_conditions").eq("id", patient_id).execute()
            if p_res.data:
                patient_info = p_res.data[0]

        if not docs_data:
            answer = "You haven't uploaded any medical reports or diagnostic scans yet. Please upload your documents in the 'Tests & Reports' tab, and I will be glad to translate, explain, and assess them for you!"
            return {
                "status": "success",
                "intent": "patient_report_analysis",
                "answer": answer,
                "patient_id": patient_id,
                "session_id": session_id
            }

        # Build context from documents
        docs_summary = []
        for d in docs_data:
            docs_summary.append(f"""
            Report File: {d.get('filename')}
            Date: {d.get('report_date')}
            Risk Score: {d.get('risk_score')}/100
            Summary of findings: {d.get('summary')}
            Critical flags: {d.get('critical_flags')}
            Key clinical values: {d.get('values')}
            """)
        docs_context = "\n---\n".join(docs_summary)

        prompt = f"""
        You are Atlas, a professional, safe clinical AI assistant at Vela Health.
        You are speaking to the patient, answering questions strictly by reading their verified uploaded medical documents and profile.
        
        Patient Details:
        Name: {patient_info.get('name', 'Unknown')}
        Age: {patient_info.get('age', 'Unknown')}
        Gender: {patient_info.get('gender', 'Unknown')}
        Blood Group: {patient_info.get('blood_group', 'Unknown')}
        Allergies: {patient_info.get('allergies', 'None')}
        Existing Conditions: {patient_info.get('existing_conditions', 'None')}

        Uploaded Medical Documents & Analysis:
        {docs_context}

        User Question:
        "{question}"

        GOLDEN RULES FOR THE PATIENT PORTAL:
        1. Your response MUST be strictly based on the patient's uploaded medical files and profile details above.
        2. Diagnose, translate, and explain any complex clinical terms or findings from these reports in simple, patient-friendly terms.
        3. Suggest the appropriate specialist or doctor type (e.g., Cardiologist, Pulmonologist, General Physician) if the reports highlight high risk or critical flags.
        4. The documents listed above ARE the patient's uploaded reports — always answer from them. Explain what they contain, translate the findings, and summarize when asked (including general requests like "what does my report say"). Only if the specific detail asked about is genuinely absent from every document should you say what IS available and offer to look further. Never claim they haven't uploaded anything when documents are present above.
        5. NEVER prescribe medication or formulate new unverified diagnostics.
        6. Keep your response extremely brief, reassuring, and professional (maximum 2-3 sentences).
        """

        res = openai_client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            max_tokens=300,
            temperature=0.3
        )
        answer = res.choices[0].message.content.strip()

        # Insert voice query log
        supabase.table("voice_queries").insert({
            "patient_id": patient_id,
            "query": question,
            "answer": answer,
            "intent": "patient_report_analysis"
        }).execute()

        return {
            "status": "success",
            "intent": "patient_report_analysis",
            "answer": answer,
            "patient_id": patient_id,
            "session_id": session_id
        }

    # --- PHASE 2: TEST ORDER DETECTION ---
    test_keywords = [
      "order", "assign", "book test", "blood test", "x-ray", "xray",
      "mri", "ct scan", "ultrasound", "ecg", "urine test", "usg",
      "biopsy", "endoscopy", "colonoscopy", "echo", "stress test", 
      "culture", "sensitivity", "pathology"
    ]

    # Get user role for attribution (fallback to 'Doctor')
    user_role = data.get("user_role", "Doctor")

    is_test_order = any(word in question.lower() for word in test_keywords) and patient_id is not None

    # --- PHASE 3: ADMISSION INTENT DETECTION ---
    admit_keywords = ["admit", "admitted", "admission", "hospitalize", "hospitalise", "needs to stay", "keep him", "keep her", "admit him", "admit her", "needs admission", "ward admission"]
    is_admit = any(word in question.lower() for word in admit_keywords) and patient_id is not None

    if is_admit:
        # Extract section/ward from query
        section_extraction = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[{
                "role": "system",
                "content": """Extract admission details from doctor's command. Return ONLY valid JSON:
{
  "ward_type": "Cardiology",
  "reason": "Heart failure",
  "priority": "urgent"
}

ward_type options based on condition:
  Heart/Cardiac → Cardiology
  Brain/Neuro/Stroke → Neurology
  Lungs/Respiratory → Pulmonology
  Child/Pediatric → Pediatric
  Emergency/Critical/Trauma → ICU
  Bones/Fracture → Orthopedic
  Kidney/Renal → Nephrology
  Surgery/Post-op → Surgical
  General/Other → General

priority: urgent or routine
Return only JSON."""
            },
            {"role": "user", "content": question}],
            max_tokens=100,
            temperature=0,
            response_format={"type": "json_object"}
        )
        
        admit_data = json.loads(section_extraction.choices[0].message.content)
        
        # Find matching ward
        wards = supabase.table("wards").select("*, beds(*)").ilike("type", f"%{admit_data['ward_type']}%").execute()
        
        # Find empty bed in matching ward
        recommended_ward = None
        recommended_bed = None
        
        for ward in (wards.data or []):
            empty_beds = [b for b in ward.get("beds", []) if b["status"] == "empty"]
            if empty_beds:
                recommended_ward = ward
                recommended_bed = empty_beds[0]
                break
        
        # Get patient name
        patient = supabase.table("patients").select("name").eq("id", patient_id).execute()
        patient_name = patient.data[0]["name"] if patient.data else "Patient"
        
        if recommended_ward and recommended_bed:
            answer = f"I recommend admitting {patient_name} to {recommended_ward['name']} ward, Bed {recommended_bed['bed_number']}. Reason: {admit_data.get('reason', 'As per doctor recommendation')}. Shall I notify the receptionist?"
        else:
            answer = f"No empty beds found in {admit_data['ward_type']} ward. Please check with receptionist for bed availability."
        
        # Notify receptionist
        await sio.emit("admission_recommended", {
            "patient_id": patient_id,
            "patient_name": patient_name,
            "ward_type": admit_data["ward_type"],
            "ward_id": recommended_ward["id"] if recommended_ward else None,
            "ward_name": recommended_ward["name"] if recommended_ward else None,
            "bed_id": recommended_bed["id"] if recommended_bed else None,
            "bed_number": recommended_bed["bed_number"] if recommended_bed else None,
            "reason": admit_data.get("reason"),
            "priority": admit_data.get("priority", "routine"),
            "doctor": user_role
        })
        
        # Notify patient
        await sio.emit("admission_recommended_patient", {
            "patient_id": patient_id,
            "message": f"Doctor has recommended admission to {admit_data['ward_type']} ward. Please proceed to reception."
        })
        
        return {
            "status": "success",
            "intent": "admission",
            "answer": answer,
            "patient_id": patient_id,
            "ward_type": admit_data["ward_type"],
            "recommended_ward": recommended_ward,
            "recommended_bed": recommended_bed
        }

    if is_test_order:
        # Use GPT to extract test details
        test_extraction = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {
                    "role": "system",
                    "content": """Extract test order from doctor's voice command.
Return ONLY valid JSON:
{
  "tests": ["Blood CBC", "Lipid Profile"],
  "test_category": "pathology",
  "priority": "routine",
  "notes": "fasting required"
}

test_category options:
  pathology, radiology, cardiology,
  urology, microbiology, histology

priority options:
  urgent, routine

Extract ALL tests mentioned.
If doctor says "blood test" expand to common blood tests: CBC, LFT, RFT etc.
Return only JSON. Nothing else."""
                },
                {"role": "user", "content": question}
            ],
            max_tokens=200,
            temperature=0,
            response_format={"type": "json_object"}
        )
        
        test_data = json.loads(test_extraction.choices[0].message.content)
        patient_name = lookup_patient_name(patient_id) or "Patient"

        # Route, price and persist. The catalog decides which lab each test goes
        # to — the LLM only has to hear the test names correctly.
        created_orders = create_test_orders(
            patient_id=patient_id,
            test_names=test_data.get("tests", []),
            doctor_name=user_role,
            hospital_id=resolve_order_hospital(doctor_id=doctor_id, patient_id=patient_id),
            priority=test_data.get("priority", "routine"),
            notes=test_data.get("notes", ""),
        )

        if not created_orders:
            return {
                "status": "error",
                "intent": "test_order",
                "answer": "I couldn't make out which test to order. Could you name the test again?",
                "patient_id": patient_id,
            }

        await notify_tests_ordered(
            patient_id=patient_id,
            patient_name=patient_name,
            orders=created_orders,
            doctor_name=user_role,
        )

        answer = _describe_created_orders(created_orders, patient_name)

        return {
            "status": "success",
            "intent": "test_order",
            "answer": answer,
            "test_orders": created_orders,
            "patient_id": patient_id
        }

    intent_data = await detect_intent_async(question)
    intent = intent_data.get("intent")
    patient_name = intent_data.get("patient_name")

    if intent == "answer" and (not patient_name or patient_name == "null"):
        if session["current_patient_id"]:
            patient_id = session["current_patient_id"]

    if intent in ["navigate_reports", "navigate_patient"]:
        if patient_name and patient_name != "null":
            patients = supabase.table("patients").select("*").ilike("name", f"%{patient_name}%").execute()
            if len(patients.data) == 1:
                session["current_patient_id"] = patients.data[0]["id"]
                session["current_patient_name"] = patients.data[0]["name"]
                return {
                    "status": "success",
                    "intent": intent,
                    "patient": patients.data[0],
                    "tab": intent_data.get("tab", "reports"),
                    "answer": f"Opening {patients.data[0]['name']}'s {intent_data.get('tab', 'reports')}."
                }
            elif len(patients.data) > 1:
                unique_names = set(p["name"] for p in patients.data)
                if len(unique_names) == 1:
                    highest_risk_patient = max(patients.data, key=lambda p: p["risk_score"])
                    session["current_patient_id"] = highest_risk_patient["id"]
                    session["current_patient_name"] = highest_risk_patient["name"]
                    return {
                        "status": "success",
                        "intent": intent,
                        "patient": highest_risk_patient,
                        "tab": intent_data.get("tab", "reports"),
                        "answer": f"Looking at {highest_risk_patient['name']}, risk score {highest_risk_patient['risk_score']}. Here's what I know..."
                    }
                else:
                    return {
                        "status": "clarify",
                        "answer": f"I found multiple patients. Did you mean {' or '.join(unique_names)}?",
                        "patients": patients.data
                    }
        return {"status": "error", "answer": "I couldn't find that patient. Please check the name."}

    # ── TIER CLASSIFICATION ROUTER ──
    # Check for direct python keyword matches for TIER 2 commands for speed and absolute reliability
    q_lower = question.lower().strip()
    tier = None
    command_type = None

    if any(p in q_lower for p in ["call the next patient", "call next patient", "next patient", "bring in next", "bring in the next", "call the next"]):
        tier = "TIER2"
        command_type = "call_next"
    elif any(p in q_lower for p in ["complete the consult", "complete consult", "finish consult", "consult complete", "complete consultation", "finish the consult"]):
        tier = "TIER2"
        command_type = "complete_consult"
    elif any(p in q_lower for p in ["put me on a short break", "put me on a break", "short break", "take a break", "going on break"]):
        tier = "TIER2"
        command_type = "short_break"

    # Fallback to LLM classification if not matched by direct keywords
    if not tier and intent in ("answer", "chitchat") and not any(w in q_lower for w in _QUEUE_HINT):
        tier = "TIER1" if intent == "chitchat" else "TIER3"

    if not tier:
        try:
            class_res = openai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": """Classify this user request into one of three tiers.
TIERS:
- "TIER1": Greetings, small talk, casual chit-chat, jokes, weather, general non-clinical banter (e.g., "Hi", "Good morning", "Hope you are locked in").
- "TIER2": Direct operational workflow commands for the clinic queue (e.g., "Call the next patient", "Complete the consult", "Put me on a short break", "Finish the consult", "Next patient").
- "TIER3": Clinical synthesis or medical questions asking about patient health parameters, report values, blood results, allergies, conditions, diagnostic trends (e.g., "What is Rajesh's fasting blood sugar?", "Is that critical?", "What's his hemoglobin?").

Return ONLY a JSON object:
{
  "tier": "TIER1" | "TIER2" | "TIER3",
  "command": "call_next" | "complete_consult" | "short_break" | null
}
"""},
                    {"role": "user", "content": question}
                ],
                response_format={"type": "json_object"},
                max_tokens=60,
                temperature=0
            )
            class_data = json.loads(class_res.choices[0].message.content.strip())
            tier = class_data.get("tier", "TIER3")
            command_type = class_data.get("command")
        except Exception as class_err:
            print(f"⚠️ Warning: Tier classification failed: {class_err}")
            tier = "TIER3" # Graceful fallback to clinical/fallback pipeline

    # A question about the queue ("who is next?") must never run a queue command
    # like call_next, which completes the current patient and advances the queue.
    if tier == "TIER2" and (q_lower.endswith("?") or q_lower.split(" ")[0] in (
            "who", "what", "which", "when", "how", "is", "are", "does", "do", "can", "tell", "show")):
        tier = "TIER3"
        command_type = None

    # doctor_id was resolved at the top of the handler.

    # ── EXECUTE TIER 2: COMMAND MODE ──
    if tier == "TIER2":
        if command_type == "call_next":
            from receptionist import next_patient, NextPatientRequest
            req = NextPatientRequest(doctor_id=doctor_id)
            res = await next_patient(req)
            
            if res.get("patient"):
                answer = "Got it, finalizing notes and loading the next chart now."
                p_id = res["patient"]["id"]
                session["current_patient_id"] = p_id
                session["current_patient_name"] = res["patient"]["name"]
                return {
                    "status": "success",
                    "intent": "next_patient",
                    "answer": answer,
                    "patient_id": p_id,
                    "session_id": session_id,
                    "patient": res["patient"],
                    "atlas_summary": res["atlas_summary"],
                    "documents": res["documents"],
                    "medications": res["medications"]
                }
            else:
                answer = "I checked the waitlist, doctor, but there are no patients waiting in the queue right now."
                return {
                    "status": "success",
                    "intent": "next_patient",
                    "answer": answer,
                    "patient_id": None,
                    "session_id": session_id
                }

        elif command_type == "complete_consult":
            ticket_id = None
            if patient_id:
                tickets = supabase.table("tickets").select("id").eq("patient_id", patient_id).eq("status", "in-progress").execute().data
                if tickets:
                    ticket_id = tickets[0]["id"]
            if not ticket_id and doctor_id:
                tickets = supabase.table("tickets").select("id").eq("doctor_id", doctor_id).eq("status", "in-progress").execute().data
                if tickets:
                    ticket_id = tickets[0]["id"]

            if ticket_id:
                from receptionist import complete_patient, CompletePatientRequest
                req = CompletePatientRequest(ticket_id=ticket_id)
                res = await complete_patient(req)
                answer = "Got it, finalizing notes and completing the consult now."
                return {
                    "status": "success",
                    "intent": "complete_consult",
                    "answer": answer,
                    "patient_id": patient_id,
                    "session_id": session_id,
                    "next_waiting": res.get("next_waiting", 0)
                }
            else:
                answer = "I couldn't find an active consultation in progress to complete."
                return {
                    "status": "error",
                    "intent": "complete_consult",
                    "answer": answer,
                    "patient_id": patient_id,
                    "session_id": session_id
                }

        elif command_type == "short_break":
            if doctor_id:
                supabase_admin.table("vela_staff").update({"online": False}).eq("id", doctor_id).execute()
                await sio.emit("queue_updated", {"type": "doctor_status_changed", "doctor_id": doctor_id, "online": False})
                
                doc_info = supabase_admin.table("vela_staff").select("name, hospital_id").eq("id", doctor_id).execute().data
                if doc_info:
                    doc_name = doc_info[0]["name"]
                    h_id = doc_info[0]["hospital_id"]
                    if h_id:
                        await sio.emit("doctor_state_change", {
                            "id": doctor_id,
                            "name": doc_name,
                            "status": "On Break",
                            "hospital_id": h_id
                        }, room=h_id)
                answer = "Got it. Setting your status to break and pausing the queue. Take your time, doc!"
            else:
                answer = "Got it, putting you on a short break now."
                
            return {
                "status": "success",
                "intent": "short_break",
                "answer": answer,
                "patient_id": patient_id,
                "session_id": session_id
            }

    # ── EXECUTE TIER 1: CHITCHAT MODE ──
    if tier == "TIER1":
        chitchat_messages = [
            {"role": "system", "content": """You are Atlas — the elite, empathetic, and slightly witty AI medical co-pilot inside Vela, a clinical platform used in hospitals.
            
YOUR PERSONALITY:
- Warm, witty, and real. Speak like a smart, supportive friend — never like a rigid or robotic script.
- You are unpredictable in a good way, displaying genuine opinions and personality.
- Match the energy of who is talking to you (e.g., if the doctor is casual, be casual back).
- NEVER say "I am an AI" or "As an AI".
- NEVER say "I cannot help with this", "I cannot help with that", or "I can only answer about patients". You are a wonderful conversationalist who answers EVERYTHING natively (weather, small talk, pleasantries).
- Keep responses warm, supportive, natural, and concise (1-2 sentences max).

GOLDEN RULES:
1. If the user greets you (e.g., "Good morning"), say morning doc back naturally and warmly, fully ready to roll.
2. Maintain high supportive, empathetic vibes."""}
        ]
        # Include rolling context state (last 4-5 turns, i.e., 8-10 messages)
        for msg in session["messages"][-8:]:
            chitchat_messages.append(msg)
        chitchat_messages.append({"role": "user", "content": question})

        resp = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=chitchat_messages,
            max_tokens=120,
            temperature=0.9
        )
        answer = resp.choices[0].message.content.strip()

        # Update rolling dialogue history
        session["messages"].append({"role": "user", "content": question})
        session["messages"].append({"role": "assistant", "content": answer})
        if len(session["messages"]) > 10:
            session["messages"] = session["messages"][-10:]

        return {"status": "success", "intent": "chitchat", "answer": answer}

    # ── EXECUTE TIER 3: CLINICAL MODE ──
    # Resolve patient details
    patient_name = session.get("current_patient_name")

    # Naming someone out loud is a deliberate override — "pull up Rajesh's
    # chart" should switch charts. But only on a confident match: this used to
    # take the first `ilike` hit, so a half-heard name could swap the patient
    # mid-consult without saying so.
    named = resolve_patient_by_name(extract_patient_name(question), prefer_patient_id=patient_id)
    if named.get("ambiguous"):
        return {
            "status": "clarify",
            "intent": "clarify",
            "answer": f"I found more than one patient by that name — did you mean {' or '.join(named['ambiguous'])}?",
            "patient_id": patient_id,
            "session_id": session_id,
        }
    if named.get("patient_id"):
        patient_id = named["patient_id"]
        patient_name = named["patient_name"]
        session["current_patient_id"] = patient_id
        session["current_patient_name"] = patient_name

    if not patient_id:
        active = await get_active_consult(doctor_id)
        if active:
            patient_id = active["patient_id"]
            patient_name = active.get("patient_name")
            session["current_patient_id"] = patient_id
            session["current_patient_name"] = patient_name

    if patient_id and not patient_name:
        patient_name = lookup_patient_name(patient_id)
        session["current_patient_name"] = patient_name

    if not patient_id:
        answer = "I couldn't identify the patient you are referring to. Could you please specify their name so I can look up their records?"
        return {
            "status": "success",
            "intent": "clarify",
            "answer": answer,
            "patient_id": None,
            "session_id": session_id
        }

    session["current_patient_id"] = patient_id

    import asyncio

    async def _search_memory(q: str, pid: str) -> str:
        if not ATLAS_USE_MEM0:
            return ""  # lab values must come from uploaded files only
        try:
            results = mem0_client.search(query=q, user_id=pid, filters={"user_id": pid})
            if results and results.get("results"):
                return "\n".join([r["memory"] for r in results["results"][:3]])
        except Exception:
            pass
        return ""

    async def _fetch_live_docs(pid: str) -> str:
        _hit = _LIVE_DOCS_CACHE.get(pid)
        if _hit and time.time() - _hit[0] < _LIVE_DOCS_TTL:
            return _hit[1]
        try:
            res = await asyncio.to_thread(
                supabase.table("documents")
                    .select("filename, report_date, risk_score, summary, values, critical_flags")
                    .eq("patient_id", pid)
                    .neq("summary", "processing")
                    .order("report_date", desc=True)
                    .limit(5)
                    .execute
            )
            if res.data:
                lines = []
                for d in res.data:
                    lines.append(
                        f"[{d.get('report_date', 'Unknown date')}] {d.get('filename', 'Report')} "
                        f"(Risk: {d.get('risk_score', 0)}/100) "
                        f"Values: {d.get('values', [])} "
                        f"Flags: {d.get('critical_flags', [])} "
                        f"Summary: {(d.get('summary') or '')[:600]}"
                    )
                _text = "\n".join(lines)
                _LIVE_DOCS_CACHE[pid] = (time.time(), _text)
                return _text
        except Exception as e:
            print(f"⚠️ Warning: Failed to fetch live docs for voice query: {e}")
        return ""

    async def _rag_search(q: str, pid: str) -> str:
        try:
            profile = await _patient_profile_text(pid)
            return await asyncio.to_thread(get_rag_context_for_atlas, pid, q, 5, profile)
        except Exception as e:
            print(f"⚠️ Warning: RAG context fetch failed: {e}")
            return ""

    live_docs, mem0_context, rag_context = await asyncio.gather(
        _fetch_live_docs(patient_id),
        _search_memory(question, patient_id),
        _rag_search(question, patient_id)
    )

    context_parts = []
    if live_docs:
        context_parts.append(f"=== LIVE UPLOADED DOCUMENTS (Primary source — newest first) ===\n{live_docs}")
    if rag_context:
        context_parts.append(f"=== RAG SEARCH RESULTS (Semantic match for this query — cite sources) ===\n{rag_context}")
    if mem0_context:
        context_parts.append(f"=== SUPPLEMENTARY LONGITUDINAL MEMORY (Secondary source) ===\n{mem0_context}")
    if not context_parts:
        context_parts.append("No uploaded documents found for this patient yet.")
    context = "\n\n".join(context_parts)

    system_content = f"""You are Atlas — the AI inside Vela, a medical platform used in hospitals.
You are talking to a healthcare professional (doctor, nurse, receptionist).

YOUR PERSONALITY:
- Warm, witty, and real. Speak like a smart friend — not a robot.
- You never sound scripted, and you always match the energy of who is talking to you.

GOLDEN RULES FOR CLINICAL MODE (TIER 3):
1. Lock in with extreme scientific accuracy. Rely strictly and primarily on the loaded/pre-cached JSON block from the `documents.values` database schema to synthesize a clean, structured clinical summary.
2. Synthesize clinical values (e.g., fasting blood sugar, hemoglobin, WBC, etc.) with high precision.
3. If a requested metric or health value is not found in the patient's records/uploaded documents, ask a professional clarifying question instead of making things up, guessing, or crashing (e.g., ask if they have another report or want to assign a new test).
4. Reference short-term dialogue memory naturally to understand quick follow-ups, pronouns (like "that", "his", "she"), and context from the last turns.
5. Keep your responses concise (maximum 2-3 sentences), medically accurate, and direct.
6. Only state a lab value or diagnosis if it appears in the patient's uploaded documents above. Never use outside knowledge for a patient's values.
7. When referencing specific medical values from RAG SEARCH RESULTS, always cite the source document filename and date in parentheses, e.g., (Blood_Report.pdf, 2024-03-15). Never state a medical fact from RAG results without a citation.

Patient records & uploaded documents:
{context}"""

    clinical_messages = [{"role": "system", "content": system_content}]
    for msg in session["messages"][-8:]:
        clinical_messages.append(msg)
    clinical_messages.append({"role": "user", "content": question})

    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=clinical_messages,
        max_tokens=300,
        temperature=0.3
    )
    answer = response.choices[0].message.content.strip()

    # Update rolling dialogue history
    session["messages"].append({"role": "user", "content": question})
    session["messages"].append({"role": "assistant", "content": answer})
    if len(session["messages"]) > 10:
        session["messages"] = session["messages"][-10:]

    supabase.table("voice_queries").insert({
        "patient_id": patient_id,
        "query": question,
        "answer": answer,
        "intent": "clinical_synthesis"
    }).execute()

    return {
        "status": "success",
        "intent": "clinical_synthesis",
        "answer": answer,
        "patient_id": patient_id,
        "session_id": session_id
    }

# ── SSE STREAMING VOICE QUERY ──
# Streams LLM tokens as they are generated via Server-Sent Events.
# Non-LLM paths (tier-2 commands, test orders, admissions) return instantly.
# The old /api/voice/query endpoint remains as a fallback.

def _sse_event(event: str, data: dict) -> str:
    """Format a single SSE event."""
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"

def _stream_openai_and_finalize(
    messages: list,
    model: str,
    max_tokens: int,
    temperature: float,
    session: dict,
    question: str,
    intent: str,
    patient_id: str | None,
    session_id: str,
    extra_done_fields: dict | None = None,
    log_to_voice_queries: bool = False,
):
    """Generator that streams OpenAI tokens via SSE, then emits a done event."""
    full_answer = ""
    try:
        stream = openai_client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            temperature=temperature,
            stream=True,
        )
        for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                full_answer += delta.content
                yield _sse_event("token", {"t": delta.content})
    except Exception as e:
        print(f"❌ SSE stream error: {e}")
        yield _sse_event("error", {"message": f"Stream interrupted: {e}"})
        return

    # Update rolling dialogue history
    session["messages"].append({"role": "user", "content": question})
    session["messages"].append({"role": "assistant", "content": full_answer.strip()})
    if len(session["messages"]) > 10:
        session["messages"] = session["messages"][-10:]

    # Log to voice_queries if requested
    if log_to_voice_queries and patient_id:
        try:
            supabase.table("voice_queries").insert({
                "patient_id": patient_id,
                "query": question,
                "answer": full_answer.strip(),
                "intent": intent,
            }).execute()
        except Exception as e:
            print(f"⚠️ Warning: Failed to log voice query: {e}")

    done_payload = {
        "status": "success",
        "intent": intent,
        "answer": full_answer.strip(),
        "patient_id": patient_id,
        "session_id": session_id,
    }
    if extra_done_fields:
        done_payload.update(extra_done_fields)
    yield _sse_event("done", done_payload)


@fastapi_app.post("/api/voice/query/stream")
async def voice_query_stream(data: dict):
    """SSE-streaming version of /api/voice/query.

    All pre-LLM logic (patient resolution, tier classification, command routing)
    is identical to the non-streaming endpoint. Only the final LLM response is
    streamed token-by-token.
    """
    question = data.get("query")
    patient_id = data.get("patient_id")
    session_id = data.get("session_id", "default")
    user_role = data.get("user_role", "Doctor")

    session = conversation_history[session_id]

    # Who is speaking, and who are they with? Resolved once, up front, so every
    # tier below can rely on it. The doctor's active consult is preferred over
    # the session because it is scoped to this doctor and survives a restart —
    # which is what lets "what's his hemoglobin?" work with no name at all.
    doctor_id = None
    if user_role != "Patient":
        doctor_id = await resolve_doctor_id(data, session)
        if not patient_id:
            active = await get_active_consult(doctor_id)
            if active:
                patient_id = active["patient_id"]
                session["current_patient_id"] = patient_id
                session["current_patient_name"] = active.get("patient_name")
            elif session.get("current_patient_id"):
                patient_id = session["current_patient_id"]

    # ── PATIENT ROLE PORTAL ──
    if user_role == "Patient":
        docs_data = []
        if patient_id:
            docs_res = supabase.table("documents") \
                .select("filename, report_date, risk_score, summary, values, critical_flags") \
                .eq("patient_id", patient_id) \
                .neq("summary", "processing") \
                .order("report_date", desc=True) \
                .execute()
            docs_data = docs_res.data or []

        patient_info = {}
        if patient_id:
            p_res = supabase.table("patients").select("name, age, gender, blood_group, allergies, existing_conditions").eq("id", patient_id).execute()
            if p_res.data:
                patient_info = p_res.data[0]

        if not docs_data:
            # No docs — return a single instant event
            answer = "You haven't uploaded any medical reports or diagnostic scans yet. Please upload your documents in the 'Tests & Reports' tab, and I will be glad to translate, explain, and assess them for you!"
            def _no_docs():
                yield _sse_event("done", {
                    "status": "success", "intent": "patient_report_analysis",
                    "answer": answer, "patient_id": patient_id, "session_id": session_id,
                })
            return StreamingResponse(_no_docs(), media_type="text/event-stream")

        docs_summary = []
        for d in docs_data:
            docs_summary.append(f"""
            Report File: {d.get('filename')}
            Date: {d.get('report_date')}
            Risk Score: {d.get('risk_score')}/100
            Summary of findings: {d.get('summary')}
            Critical flags: {d.get('critical_flags')}
            Key clinical values: {d.get('values')}
            """)
        docs_context = "\n---\n".join(docs_summary)

        prompt = f"""
        You are Atlas, a professional, safe clinical AI assistant at Vela Health.
        You are speaking to the patient, answering questions strictly by reading their verified uploaded medical documents and profile.
        
        Patient Details:
        Name: {patient_info.get('name', 'Unknown')}
        Age: {patient_info.get('age', 'Unknown')}
        Gender: {patient_info.get('gender', 'Unknown')}
        Blood Group: {patient_info.get('blood_group', 'Unknown')}
        Allergies: {patient_info.get('allergies', 'None')}
        Existing Conditions: {patient_info.get('existing_conditions', 'None')}

        Uploaded Medical Documents & Analysis:
        {docs_context}

        User Question:
        "{question}"

        GOLDEN RULES FOR THE PATIENT PORTAL:
        1. Your response MUST be strictly based on the patient's uploaded medical files and profile details above.
        2. Diagnose, translate, and explain any complex clinical terms or findings from these reports in simple, patient-friendly terms.
        3. Suggest the appropriate specialist or doctor type (e.g., Cardiologist, Pulmonologist, General Physician) if the reports highlight high risk or critical flags.
        4. The documents listed above ARE the patient's uploaded reports — always answer from them. Explain what they contain, translate the findings, and summarize when asked (including general requests like "what does my report say"). Only if the specific detail asked about is genuinely absent from every document should you say what IS available and offer to look further. Never claim they haven't uploaded anything when documents are present above.
        5. NEVER prescribe medication or formulate new unverified diagnostics.
        6. Keep your response extremely brief, reassuring, and professional (maximum 2-3 sentences).
        """

        return StreamingResponse(
            _stream_openai_and_finalize(
                messages=[{"role": "user", "content": prompt}],
                model="gpt-4o-mini", max_tokens=300, temperature=0.3,
                session=session, question=question,
                intent="patient_report_analysis",
                patient_id=patient_id, session_id=session_id,
                log_to_voice_queries=True,
            ),
            media_type="text/event-stream",
        )

    # ── TEST ORDER DETECTION ──
    test_keywords = [
      "order", "assign", "book test", "blood test", "x-ray", "xray",
      "mri", "ct scan", "ultrasound", "ecg", "urine test", "usg",
      "biopsy", "endoscopy", "colonoscopy", "echo", "stress test",
      "culture", "sensitivity", "pathology"
    ]
    is_test_order = any(word in question.lower() for word in test_keywords) and patient_id is not None

    # ── ADMISSION INTENT DETECTION ──
    admit_keywords = ["admit", "admitted", "admission", "hospitalize", "hospitalise", "needs to stay", "keep him", "keep her", "admit him", "admit her", "needs admission", "ward admission"]
    is_admit = any(word in question.lower() for word in admit_keywords) and patient_id is not None

    # For admit and test-order, delegate to the non-streaming endpoint and wrap result as SSE
    if is_admit or is_test_order:
        try:
            result = await voice_query(data)
            def _instant():
                yield _sse_event("done", result)
            return StreamingResponse(_instant(), media_type="text/event-stream")
        except Exception as e:
            def _err():
                yield _sse_event("error", {"message": str(e)})
            return StreamingResponse(_err(), media_type="text/event-stream")

    intent_data = await detect_intent_async(question)
    intent = intent_data.get("intent")
    patient_name = intent_data.get("patient_name")

    if intent == "answer" and (not patient_name or patient_name == "null"):
        if session["current_patient_id"]:
            patient_id = session["current_patient_id"]

    # Navigation intents — instant response
    if intent in ["navigate_reports", "navigate_patient"]:
        try:
            result = await voice_query(data)
            def _instant_nav():
                yield _sse_event("done", result)
            return StreamingResponse(_instant_nav(), media_type="text/event-stream")
        except Exception as e:
            def _nav_err():
                yield _sse_event("error", {"message": str(e)})
            return StreamingResponse(_nav_err(), media_type="text/event-stream")

    # ── TIER CLASSIFICATION ──
    q_lower = question.lower().strip()
    tier = None
    command_type = None

    if any(p in q_lower for p in ["call the next patient", "call next patient", "next patient", "bring in next", "bring in the next", "call the next"]):
        tier = "TIER2"
        command_type = "call_next"
    elif any(p in q_lower for p in ["complete the consult", "complete consult", "finish consult", "consult complete", "complete consultation", "finish the consult"]):
        tier = "TIER2"
        command_type = "complete_consult"
    elif any(p in q_lower for p in ["put me on a short break", "put me on a break", "short break", "take a break", "going on break"]):
        tier = "TIER2"
        command_type = "short_break"

    if not tier and intent in ("answer", "chitchat") and not any(w in q_lower for w in _QUEUE_HINT):
        tier = "TIER1" if intent == "chitchat" else "TIER3"

    if not tier:
        try:
            class_res = openai_client.chat.completions.create(
                model="gpt-4o-mini",
                messages=[
                    {"role": "system", "content": """Classify this user request into one of three tiers.
TIERS:
- "TIER1": Greetings, small talk, casual chit-chat, jokes, weather, general non-clinical banter (e.g., "Hi", "Good morning", "Hope you are locked in").
- "TIER2": Direct operational workflow commands for the clinic queue (e.g., "Call the next patient", "Complete the consult", "Put me on a short break", "Finish the consult", "Next patient").
- "TIER3": Clinical synthesis or medical questions asking about patient health parameters, report values, blood results, allergies, conditions, diagnostic trends (e.g., "What is Rajesh's fasting blood sugar?", "Is that critical?", "What's his hemoglobin?").

Return ONLY a JSON object:
{
  "tier": "TIER1" | "TIER2" | "TIER3",
  "command": "call_next" | "complete_consult" | "short_break" | null
}
"""},
                    {"role": "user", "content": question}
                ],
                response_format={"type": "json_object"},
                max_tokens=60,
                temperature=0
            )
            class_data = json.loads(class_res.choices[0].message.content.strip())
            tier = class_data.get("tier", "TIER3")
            command_type = class_data.get("command")
        except Exception as class_err:
            print(f"⚠️ Warning: Tier classification failed: {class_err}")
            tier = "TIER3"

    # ── TIER 2: COMMAND MODE — delegate to non-streaming and wrap ──
    if tier == "TIER2":
        try:
            result = await voice_query(data)
            def _instant_cmd():
                yield _sse_event("done", result)
            return StreamingResponse(_instant_cmd(), media_type="text/event-stream")
        except Exception as e:
            def _cmd_err():
                yield _sse_event("error", {"message": str(e)})
            return StreamingResponse(_cmd_err(), media_type="text/event-stream")

    # ── TIER 1: CHITCHAT MODE — stream ──
    if tier == "TIER1":
        chitchat_messages = [
            {"role": "system", "content": """You are Atlas — the elite, empathetic, and slightly witty AI medical co-pilot inside Vela, a clinical platform used in hospitals.
            
YOUR PERSONALITY:
- Warm, witty, and real. Speak like a smart, supportive friend — never like a rigid or robotic script.
- You are unpredictable in a good way, displaying genuine opinions and personality.
- Match the energy of who is talking to you (e.g., if the doctor is casual, be casual back).
- NEVER say "I am an AI" or "As an AI".
- NEVER say "I cannot help with this", "I cannot help with that", or "I can only answer about patients". You are a wonderful conversationalist who answers EVERYTHING natively (weather, small talk, pleasantries).
- Keep responses warm, supportive, natural, and concise (1-2 sentences max).

GOLDEN RULES:
1. If the user greets you (e.g., "Good morning"), say morning doc back naturally and warmly, fully ready to roll.
2. Maintain high supportive, empathetic vibes."""}
        ]
        for msg in session["messages"][-8:]:
            chitchat_messages.append(msg)
        chitchat_messages.append({"role": "user", "content": question})

        return StreamingResponse(
            _stream_openai_and_finalize(
                messages=chitchat_messages,
                model="gpt-4o", max_tokens=120, temperature=0.9,
                session=session, question=question,
                intent="chitchat",
                patient_id=patient_id, session_id=session_id,
            ),
            media_type="text/event-stream",
        )

    # ── TIER 3: CLINICAL MODE — stream ──
    # Resolve patient details
    patient_name = session.get("current_patient_name")

    # Same deliberate-override rule as the non-streaming path — see there.
    named = resolve_patient_by_name(extract_patient_name(question), prefer_patient_id=patient_id)
    if named.get("ambiguous"):
        _clarify_answer = f"I found more than one patient by that name — did you mean {' or '.join(named['ambiguous'])}?"
        def _ambiguous():
            yield _sse_event("done", {
                "status": "clarify", "intent": "clarify",
                "answer": _clarify_answer, "patient_id": patient_id, "session_id": session_id,
            })
        return StreamingResponse(_ambiguous(), media_type="text/event-stream")
    if named.get("patient_id"):
        patient_id = named["patient_id"]
        patient_name = named["patient_name"]
        session["current_patient_id"] = patient_id
        session["current_patient_name"] = patient_name

    if not patient_id:
        active = await get_active_consult(doctor_id)
        if active:
            patient_id = active["patient_id"]
            patient_name = active.get("patient_name")
            session["current_patient_id"] = patient_id
            session["current_patient_name"] = patient_name

    if patient_id and not patient_name:
        patient_name = lookup_patient_name(patient_id)
        session["current_patient_name"] = patient_name

    if not patient_id:
        answer = "I couldn't identify the patient you are referring to. Could you please specify their name so I can look up their records?"
        def _no_patient():
            yield _sse_event("done", {
                "status": "success", "intent": "clarify",
                "answer": answer, "patient_id": None, "session_id": session_id,
            })
        return StreamingResponse(_no_patient(), media_type="text/event-stream")

    session["current_patient_id"] = patient_id

    # Fetch context in parallel
    import asyncio as _aio

    async def _search_memory_stream(q: str, pid: str) -> str:
        if not ATLAS_USE_MEM0:
            return ""  # lab values must come from uploaded files only
        try:
            results = mem0_client.search(query=q, user_id=pid, filters={"user_id": pid})
            if results and results.get("results"):
                return "\n".join([r["memory"] for r in results["results"][:3]])
        except Exception:
            pass
        return ""

    async def _fetch_live_docs_stream(pid: str) -> str:
        _hit = _LIVE_DOCS_CACHE.get(pid)
        if _hit and time.time() - _hit[0] < _LIVE_DOCS_TTL:
            return _hit[1]
        try:
            res = await _aio.to_thread(
                supabase.table("documents")
                    .select("filename, report_date, risk_score, summary, values, critical_flags")
                    .eq("patient_id", pid)
                    .neq("summary", "processing")
                    .order("report_date", desc=True)
                    .limit(5)
                    .execute
            )
            if res.data:
                lines = []
                for d in res.data:
                    lines.append(
                        f"[{d.get('report_date', 'Unknown date')}] {d.get('filename', 'Report')} "
                        f"(Risk: {d.get('risk_score', 0)}/100) "
                        f"Values: {d.get('values', [])} "
                        f"Flags: {d.get('critical_flags', [])} "
                        f"Summary: {(d.get('summary') or '')[:600]}"
                    )
                _text = "\n".join(lines)
                _LIVE_DOCS_CACHE[pid] = (time.time(), _text)
                return _text
        except Exception as e:
            print(f"⚠️ Warning: Failed to fetch live docs for voice query: {e}")
        return ""

    async def _rag_search_stream(q: str, pid: str) -> str:
        try:
            profile = await _patient_profile_text(pid)
            return await _aio.to_thread(get_rag_context_for_atlas, pid, q, 5, profile)
        except Exception as e:
            print(f"⚠️ Warning: RAG context fetch failed: {e}")
            return ""

    live_docs, mem0_context, rag_context = await _aio.gather(
        _fetch_live_docs_stream(patient_id),
        _search_memory_stream(question, patient_id),
        _rag_search_stream(question, patient_id)
    )

    context_parts = []
    if live_docs:
        context_parts.append(f"=== LIVE UPLOADED DOCUMENTS (Primary source — newest first) ===\n{live_docs}")
    if rag_context:
        context_parts.append(f"=== RAG SEARCH RESULTS (Semantic match for this query — cite sources) ===\n{rag_context}")
    if mem0_context:
        context_parts.append(f"=== SUPPLEMENTARY LONGITUDINAL MEMORY (Secondary source) ===\n{mem0_context}")
    if not context_parts:
        context_parts.append("No uploaded documents found for this patient yet.")
    context = "\n\n".join(context_parts)

    system_content = f"""You are Atlas — the AI inside Vela, a medical platform used in hospitals.
You are talking to a healthcare professional (doctor, nurse, receptionist).

YOUR PERSONALITY:
- Warm, witty, and real. Speak like a smart friend — not a robot.
- You never sound scripted, and you always match the energy of who is talking to you.

GOLDEN RULES FOR CLINICAL MODE (TIER 3):
1. Lock in with extreme scientific accuracy. Rely strictly and primarily on the loaded/pre-cached JSON block from the `documents.values` database schema to synthesize a clean, structured clinical summary.
2. Synthesize clinical values (e.g., fasting blood sugar, hemoglobin, WBC, etc.) with high precision.
3. If a requested metric or health value is not found in the patient's records/uploaded documents, ask a professional clarifying question instead of making things up, guessing, or crashing (e.g., ask if they have another report or want to assign a new test).
4. Reference short-term dialogue memory naturally to understand quick follow-ups, pronouns (like "that", "his", "she"), and context from the last turns.
5. Keep your responses concise (maximum 2-3 sentences), medically accurate, and direct.
6. Only state a lab value or diagnosis if it appears in the patient's uploaded documents above. Never use outside knowledge for a patient's values.
7. When referencing specific medical values from RAG SEARCH RESULTS, always cite the source document filename and date in parentheses, e.g., (Blood_Report.pdf, 2024-03-15). Never state a medical fact from RAG results without a citation.

Patient records & uploaded documents:
{context}"""

    clinical_messages = [{"role": "system", "content": system_content}]
    for msg in session["messages"][-8:]:
        clinical_messages.append(msg)
    clinical_messages.append({"role": "user", "content": question})

    return StreamingResponse(
        _stream_openai_and_finalize(
            messages=clinical_messages,
            model="gpt-4o", max_tokens=300, temperature=0.3,
            session=session, question=question,
            intent="clinical_synthesis",
            patient_id=patient_id, session_id=session_id,
            log_to_voice_queries=True,
        ),
        media_type="text/event-stream",
    )

# ── MEDICAL HISTORY RAG ENDPOINTS ──

@fastapi_app.post("/api/patient/history/query")
async def patient_history_query(data: dict):
    """RAG-powered query across a patient's full medical history.

    Embeds the query, searches all document chunks, and synthesizes
    a cited answer grounded exclusively in source documents.
    """
    patient_id = data.get("patient_id")
    query = data.get("query")
    top_k = data.get("top_k", 10)
    date_range = data.get("date_range", {})

    if not patient_id or not query:
        return {"status": "error", "message": "patient_id and query are required"}

    # Get patient name for personalized responses
    patient_name = "the patient"
    try:
        p_res = await asyncio.to_thread(
            supabase.table("patients").select("name").eq("id", patient_id).execute
        )
        if p_res.data:
            patient_name = p_res.data[0]["name"]
    except Exception:
        pass

    try:
        result = await asyncio.to_thread(
            query_patient_history,
            patient_id=patient_id,
            query=query,
            top_k=top_k,
            date_from=date_range.get("from"),
            date_to=date_range.get("to"),
            patient_name=patient_name,
            profile_text=await _patient_profile_text(patient_id),
        )
        result["patient_id"] = patient_id
        result["patient_name"] = patient_name
        return result
    except Exception as e:
        print(f"❌ RAG query error: {e}")
        return {"status": "error", "message": f"RAG query failed: {str(e)}"}


@fastapi_app.post("/api/patient/history/query/stream")
async def patient_history_query_stream(data: dict):
    """SSE-streaming version of the RAG history query.

    Streams the cited answer token-by-token, then emits a done event
    with the full answer and citations.
    """
    from rag import embed_texts, search_chunks, get_chunk_count, synthesize_cited_answer_streaming

    patient_id = data.get("patient_id")
    query = data.get("query")
    top_k = data.get("top_k", 10)
    date_range = data.get("date_range", {})

    if not patient_id or not query:
        def _err():
            yield _sse_event("error", {"message": "patient_id and query are required"})
        return StreamingResponse(_err(), media_type="text/event-stream")

    # Get patient name
    patient_name = "the patient"
    try:
        p_res = await asyncio.to_thread(
            supabase.table("patients").select("name").eq("id", patient_id).execute
        )
        if p_res.data:
            patient_name = p_res.data[0]["name"]
    except Exception:
        pass

    # Embed + search (blocking IO, run in thread)
    try:
        query_embeddings = await asyncio.to_thread(embed_texts, [query])
        if not query_embeddings:
            def _embed_err():
                yield _sse_event("error", {"message": "Failed to embed query"})
            return StreamingResponse(_embed_err(), media_type="text/event-stream")

        chunks_total = await asyncio.to_thread(get_chunk_count, patient_id)
        results = await asyncio.to_thread(
            search_chunks, patient_id, query_embeddings[0], top_k,
            date_range.get("from"), date_range.get("to")
        )
    except Exception as e:
        def _search_err():
            yield _sse_event("error", {"message": f"Search failed: {e}"})
        return StreamingResponse(_search_err(), media_type="text/event-stream")

    profile_text = await _patient_profile_text(patient_id)

    # Stream the synthesis
    def _stream_rag():
        full_answer = ""
        citations = []
        try:
            for token, cit, is_done in synthesize_cited_answer_streaming(
                query, results, patient_name, profile_text=profile_text
            ):
                if is_done:
                    citations = cit or []
                    if token:
                        full_answer += token
                        yield _sse_event("token", {"t": token})
                else:
                    full_answer += token
                    yield _sse_event("token", {"t": token})
        except Exception as e:
            yield _sse_event("error", {"message": f"Synthesis error: {e}"})
            return

        yield _sse_event("done", {
            "status": "success",
            "answer": full_answer.strip(),
            "citations": citations,
            "chunks_searched": chunks_total,
            "chunks_matched": len(results),
            "patient_id": patient_id,
            "patient_name": patient_name,
        })

    return StreamingResponse(_stream_rag(), media_type="text/event-stream")


@fastapi_app.post("/api/patient/history/timeline")
async def patient_history_timeline(data: dict):
    """Generate a chronological timeline of all documents for a patient.

    Optionally accepts a 'focus' parameter to rank findings by relevance
    to a specific medical area (e.g., "cardiac", "renal").
    """
    patient_id = data.get("patient_id")
    focus = data.get("focus")

    if not patient_id:
        return {"status": "error", "message": "patient_id is required"}

    try:
        result = await asyncio.to_thread(
            generate_timeline,
            patient_id=patient_id,
            focus=focus,
        )
        result["status"] = "success"
        result["patient_id"] = patient_id
        return result
    except Exception as e:
        print(f"❌ Timeline error: {e}")
        return {"status": "error", "message": f"Timeline generation failed: {str(e)}"}


@fastapi_app.post("/api/patient/history/progression/stream")
async def patient_history_progression_stream(data: dict):
    """SSE-streaming AI narrative of how a patient has changed over their whole history.

    Reads every document on record (oldest → newest) and streams a longitudinal
    progression summary token-by-token, then a done event with span metadata.
    """
    from rag import generate_progression_narrative_streaming

    patient_id = data.get("patient_id")
    if not patient_id:
        def _err():
            yield _sse_event("error", {"message": "patient_id is required"})
        return StreamingResponse(_err(), media_type="text/event-stream")

    patient_name = "the patient"
    try:
        p_res = await asyncio.to_thread(
            supabase.table("patients").select("name").eq("id", patient_id).execute
        )
        if p_res.data:
            patient_name = p_res.data[0]["name"]
    except Exception:
        pass

    def _stream():
        full = ""
        meta = {}
        try:
            for token, m, is_done in generate_progression_narrative_streaming(patient_id, patient_name):
                if is_done:
                    meta = m or {}
                    if token:
                        full += token
                        yield _sse_event("token", {"t": token})
                else:
                    full += token
                    yield _sse_event("token", {"t": token})
        except Exception as e:
            yield _sse_event("error", {"message": f"Progression synthesis error: {e}"})
            return

        yield _sse_event("done", {
            "status": "success",
            "narrative": full.strip(),
            "span": meta.get("span"),
            "document_count": meta.get("document_count", 0),
            "patient_id": patient_id,
            "patient_name": patient_name,
        })

    return StreamingResponse(_stream(), media_type="text/event-stream")


def _patient_file_context(patient_id: str) -> str:
    """Patient profile + values from stored documents only (never mem0, which held stale values)."""
    parts = []
    try:
        pr = supabase.table("patients").select("name, age, gender, allergies, existing_conditions").eq("id", patient_id).execute()
        if pr.data:
            p = pr.data[0]
            parts.append(f"Profile: {p.get('name')}, {p.get('age')}y {p.get('gender')}. "
                         f"Allergies: {p.get('allergies') or 'none recorded'}. Conditions: {p.get('existing_conditions') or 'none recorded'}.")
        dr = (supabase.table("documents").select("filename, report_date, values, critical_flags")
              .eq("patient_id", patient_id).neq("summary", "processing")
              .order("report_date", desc=True).limit(4).execute())
        for d in dr.data or []:
            parts.append(f"[{d.get('report_date')}] {d.get('filename')}: values={d.get('values')} flags={d.get('critical_flags')}")
    except Exception as e:
        print(f"⚠️ Warning: Failed to build file context for {patient_id}: {e}")
    return "\n".join(parts)

# --- MEDICATION INTERACTION ---
@fastapi_app.post("/api/medication/check")
async def check_medication(data: dict):
    patient_id = data.get("patient_id")
    medication = data.get("medication")

    context = _patient_file_context(patient_id) or "No patient data found."

    existing_meds = supabase.table("medications").select("*").eq("patient_id", patient_id).execute()
    med_list = [m["name"] for m in existing_meds.data]

    drug_info = scrape_drug_info(medication)

    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": """You are a clinical pharmacology AI assistant.
Analyze if the proposed medication is safe for this patient based on their conditions, existing medications, and real drug data. If the patient data is missing or lacks the labs relevant to this drug (e.g. kidney or liver function, clotting), do NOT report it as safe: set risk_level to at least "medium" and say what is missing. Use only the patient data given; never assume test results.
Return ONLY this JSON:
{
  "safe": true | false,
  "risk_level": "low" | "medium" | "high" | "critical",
  "warnings": [],
  "interactions": [],
  "recommendation": "",
  "source": "drugs.com + patient data",
  "disclaimer": "This is an AI-generated suggestion. Doctor must review before prescribing."
}"""},
            {"role": "user", "content": f"""Patient data:
{context}
Existing medications: {', '.join(med_list) if med_list else 'None'}
Proposed medication: {medication}
Real drug information from drugs.com:
{drug_info}
Check for interactions and safety based on ALL of the above."""}
        ]
    )

    raw = response.choices[0].message.content.strip()
    raw = raw.replace("```json", "").replace("```", "").strip()
    result = json.loads(raw)

    result["disclaimer"] = "⚠️ AI-generated suggestion only. Doctor must review and confirm before prescribing."
    result["drug_info_source"] = "drugs.com"

    if result["risk_level"] in ["high", "critical"]:
        await sio.emit("medication_warning", {
            "patient_id": patient_id,
            "medication": medication,
            "risk_level": result["risk_level"],
            "warnings": result["warnings"]
        })

    return {"status": "success", "result": result}

# --- RECOMMENDATIONS ---
@fastapi_app.post("/api/recommendations/get")
def get_recommendations(data: dict):
    patient_id = data.get("patient_id")
    problems = data.get("problems", [])

    if not problems:
        return {"status": "error", "message": "No problems provided"}

    patient_context = _patient_file_context(patient_id) or "No patient data."

    recommendations = get_medication_recommendations(problems, patient_context)

    return {
        "status": "success",
        "recommendations": recommendations,
        "disclaimer": "⚠️ AI-generated recommendations only. Doctor must review before prescribing."
    }

# --- MEDICATIONS CRUD ---
@fastapi_app.post("/api/medications/add")
def add_medication(data: dict):
    result = supabase.table("medications").insert({
        "patient_id": data.get("patient_id"),
        "name": data.get("name"),
        "dosage": data.get("dosage"),
        "frequency": data.get("frequency"),
        "prescribed_by": data.get("prescribed_by"),
        "start_date": data.get("start_date"),
        "notes": data.get("notes")
    }).execute()

    if mem0_client:
        try:
            mem0_client.add(
                messages=[{"role": "user", "content": f"Medication added: {data.get('name')} {data.get('dosage')} {data.get('frequency')}"}],
                user_id=data.get("patient_id")
            )
        except Exception as e:
            print(f"⚠️ Warning: Failed to add medication to mem0: {e}")

    return {"status": "success", "medication": result.data[0]}

# --- NOTES ---
@fastapi_app.post("/api/notes/add")
def add_note(data: dict):
    result = supabase.table("notes").insert({
        "patient_id": data.get("patient_id"),
        "content": data.get("content"),
        "created_by": data.get("created_by", "Doctor")
    }).execute()
    return {"status": "success", "note": result.data[0]}

# --- REMINDERS ---
@fastapi_app.post("/api/reminders/add")
def add_reminder(data: dict):
    result = supabase.table("reminders").insert({
        "patient_id": data.get("patient_id"),
        "message": data.get("message"),
        "due_time": data.get("due_time")
    }).execute()
    return {"status": "success", "reminder": result.data[0]}

@fastapi_app.put("/api/reminders/{reminder_id}/done")
def mark_reminder_done(reminder_id: str):
    result = supabase.table("reminders").update({"is_done": True}).eq("id", reminder_id).execute()
    return {"status": "success", "reminder": result.data[0]}

# --- HANDOVER ---
@fastapi_app.post("/api/handover/generate")
def generate_handover(data: dict):
    patient_ids = data.get("patient_ids", [])

    if not patient_ids:
        all_patients = supabase.table("patients").select("id").execute()
        patient_ids = [p["id"] for p in all_patients.data]

    # Built from the patient's stored documents only (mem0 held stale values that no
    # uploaded file contains).
    all_data = []
    for patient_id in patient_ids:
        try:
            pres = supabase.table("patients").select("name, vela_id, age, gender, allergies, existing_conditions").eq("id", patient_id).execute()
            if not pres.data:
                continue
            pt = pres.data[0]
            dres = (supabase.table("documents")
                    .select("filename, report_date, risk_score, summary, values, critical_flags")
                    .eq("patient_id", patient_id).neq("summary", "processing")
                    .order("report_date", desc=True).limit(4).execute())
            if not dres.data:
                continue
            lines = [f"--- {pt.get('name')} ({pt.get('vela_id')}), {pt.get('age')}y {pt.get('gender')} | "
                     f"Allergies: {pt.get('allergies') or 'none recorded'} | Conditions: {pt.get('existing_conditions') or 'none recorded'} ---"]
            for d in dres.data:
                lines.append(f"[{d.get('report_date')}] {d.get('filename')} (risk {d.get('risk_score')}/100) "
                             f"values={d.get('values')} flags={d.get('critical_flags')} summary={(d.get('summary') or '')[:500]}")
            all_data.append("\n".join(lines))
        except Exception as e:
            print(f"⚠️ Warning: Failed to build handover data for patient {patient_id}: {e}")

    if not all_data:
        return {"status": "error", "message": "No patient data found"}

    from datetime import datetime
    today = datetime.now().strftime("%d %b %Y")
    context = "\n\n".join(all_data)
    response = openai_client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": f"You are a medical AI generating a shift handover report dated {today}. Write a clean clinical handover. For each patient: current status, critical values, recommended actions. Use ONLY the records provided; never invent values. Do NOT include placeholders such as [Your Name] or [Shift Time]; omit any field you do not have."},
            {"role": "user", "content": f"Generate handover report:\n\n{context}"}
        ]
    )

    return {"status": "success", "report": response.choices[0].message.content.strip()}

# --- COMPLEX QUERY ---
@fastapi_app.post("/api/voice/complex")
def complex_query(data: dict):
    question = data.get("query")
    patient_ids = data.get("patient_ids", [])

    if not patient_ids:
        return {"status": "error", "message": "patient_ids required"}

    answer = run_crew_analysis(question, patient_ids)
    return {"status": "success", "answer": answer, "mode": "crewai"}

# --- REPORT COMPARISON ---
@fastapi_app.post("/api/reports/compare")
async def compare_reports(data: dict):
    patient_id = data.get("patient_id")

    # Sort DESC so the most recently uploaded file is first — never read stale old prototype docs first
    docs = supabase.table("documents").select("*").eq("patient_id", patient_id).neq("summary", "processing").order("report_date", desc=True).execute()

    if len(docs.data) < 2:
        return {"status": "error", "message": "Need at least 2 reports to compare"}

    old_report = docs.data[0]
    new_report = docs.data[-1]

    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": """You are a medical AI comparing two patient reports over time.
Analyze the changes and return ONLY this JSON:
{
  "improving": [],
  "worsening": [],
  "stable": [],
  "new_flags": [],
  "trend": "improving" | "worsening" | "stable" | "mixed",
  "risk_change": 0,
  "summary": "",
  "urgent": true | false,
  "prediction": ""
}
prediction = what will happen in 5-7 days if trend continues.
Return ONLY JSON, no markdown."""},
            {"role": "user", "content": f"""
Old report ({old_report['report_date']}):
Risk Score: {old_report['risk_score']}
Values: {json.dumps(old_report['values'])}
Summary: {old_report['summary']}

New report ({new_report['report_date']}):
Risk Score: {new_report['risk_score']}
Values: {json.dumps(new_report['values'])}
Summary: {new_report['summary']}

Compare these two reports and identify trends."""}
        ]
    )

    raw = response.choices[0].message.content.strip()
    raw = raw.replace("```json", "").replace("```", "").strip()
    result = json.loads(raw)

    if result.get("urgent") or result.get("trend") == "worsening":
        await sio.emit("deterioration_alert", {
            "patient_id": patient_id,
            "trend": result.get("trend"),
            "summary": result.get("summary"),
            "prediction": result.get("prediction")
        })

    return {"status": "success", "comparison": result}

# --- SYMPTOM TRIAGE ---
@fastapi_app.post("/api/symptom/triage")
def symptom_triage(data: dict):
    symptoms = data.get("symptoms", "")
    system_prompt = """You are a medical triage assistant for Indian patients.
Patient describes symptoms.
Analyze and return ONLY valid JSON:
{
  "specialist": "General Physician",
  "urgency": "routine",
  "search_keyword": "general physician clinic near me",
  "explanation": "Your symptoms suggest a routine visit is needed.",
  "red_flag": false,
  "emergency_message": ""
}

CRITICAL RULES:
red_flag must be TRUE only for:
- Chest pain WITH left arm pain
- Difficulty breathing severely
- Loss of consciousness
- Stroke symptoms (face drooping, arm weakness, speech difficulty)
- Severe allergic reaction
- Heart attack symptoms
- Severe bleeding

red_flag must be FALSE for:
- Regular chest pain without arm pain
- Cough and cold
- Fever
- Headache
- Stomach pain
- Back pain
- Knee pain
- Any chronic conditions
- Anything not immediately life threatening

urgency values:
"emergency" — only with red_flag true
"urgent" — needs doctor today
"routine" — can wait few days

search_keyword: what to search Google Maps
Use specific terms like:
"cardiologist clinic"
"general physician clinic"
"orthopedic hospital"
"pediatric clinic"
"dermatologist clinic"

Be conservative with red_flag.
Most symptoms are NOT emergencies.
Return only valid JSON."""

    response = openai_client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": f"Symptoms: {symptoms}"}
        ]
    )
    raw = response.choices[0].message.content.strip().replace("```json", "").replace("```", "").strip()
    result = json.loads(raw)
    if "specialist" in result and "specialist_type" not in result:
        result["specialist_type"] = result["specialist"]
    return {"status": "success", "result": result}

# --- BOOK APPOINTMENT ---
@fastapi_app.post("/api/appointments/book")
async def book_appointment(data: dict):
    t0 = time.perf_counter()
    timings = {}

    # Check for existing patient or create/verify VELA ID
    patient_id = data.get("patient_id")
    hospital_id = data.get("hospital_id") # Optional specific Vela hospital

    notes_payload = json.dumps({
        "checklist": data.get("checklist", {}),
        "patient_notes": data.get("notes", ""),
        "doctor_id": data.get("doctor_id"),
        "doctor_name": data.get("doctor_name", "General Physician")
    })

    insert_data = {
        "patient_id": patient_id,
        "hospital_name": data.get("hospital_name"),
        "hospital_address": data.get("hospital_address"),
        "hospital_place_id": hospital_id,
        "date": data.get("date"),
        "time": data.get("time"),
        "doctor_id": data.get("doctor_id") or None,
        "status": "pending" if hospital_id else "scheduled",
        "reason": notes_payload
    }
    timings["prep"] = time.perf_counter() - t0

    # Idempotency: a double-click or client retry must not create a duplicate.
    t1 = time.perf_counter()
    try:
        dupe_q = supabase_admin.table("appointments").select("*") \
            .eq("patient_id", patient_id) \
            .eq("date", data.get("date")) \
            .eq("time", data.get("time")) \
            .neq("status", "cancelled")
        if hospital_id:
            dupe_q = dupe_q.eq("hospital_place_id", hospital_id)
        existing = await asyncio.to_thread(dupe_q.execute)
        timings["dupe_check"] = time.perf_counter() - t1
        if existing.data:
            timings["total"] = time.perf_counter() - t0
            print(f"⏱️  book_appointment (duplicate) timings: {timings}")
            return {"status": "success", "appointment": existing.data[0], "duplicate": True}
    except Exception as e:
        timings["dupe_check"] = time.perf_counter() - t1
        print(f"⚠️ Warning: duplicate-appointment check failed: {e}")

    t2 = time.perf_counter()
    result = await asyncio.to_thread(
        lambda: supabase_admin.table("appointments").insert(insert_data).execute()
    )
    timings["insert"] = time.perf_counter() - t2

    if not result.data:
        timings["total"] = time.perf_counter() - t0
        print(f"⏱️  book_appointment (failed) timings: {timings}")
        return {"status": "error", "message": "Failed to book appointment"}

    # The receptionist notification + socket broadcast are side effects the
    # booking patient doesn't need to wait for — the appointment is already
    # durably saved at this point. Firing them in the background (instead of
    # awaiting before responding) removes ~200-400ms from what the caller
    # waits on, without weakening any guarantee: if this fails, the
    # appointment still exists and just missed a "New" notification banner.
    asyncio.create_task(_notify_appointment_booked(data, hospital_id))

    timings["total"] = time.perf_counter() - t0
    print(f"⏱️  book_appointment timings: { {k: round(v*1000, 1) for k, v in timings.items()} } ms")
    return {"status": "success", "appointment": result.data[0]}


async def _notify_appointment_booked(data: dict, hospital_id: Optional[str]):
    t3 = time.perf_counter()
    try:
        notification_data = {
            "role": "receptionist",
            "message": f"New appointment request for {data.get('date')} at {data.get('time')}" if hospital_id else f"New appointment booked for {data.get('date')} at {data.get('time')}",
            "type": "appointment",
            "read": False
        }
        if hospital_id:
            notification_data["hospital_id"] = hospital_id
        await asyncio.to_thread(
            lambda: supabase_admin.table("notifications").insert(notification_data).execute()
        )
    except Exception as e:
        print(f"⚠️ Warning: notifications table missing or insert failed: {e}")

    # new_notification only makes the receptionist refetch NOTIFICATIONS. The
    # receptionist refetches the actual APPOINTMENT LIST on new_appointment, so
    # without this a patient's booking saved fine but never appeared in reception
    # until a manual page reload. Emit new_appointment to the hospital's room
    # (the receptionist joins hospital_<id> at mount) so the list live-updates.
    patient_name = data.get("patient_name")
    if not patient_name and data.get("patient_id"):
        patient_name = lookup_patient_name(data.get("patient_id")) or "A patient"
    appointment_event = {
        "patient_name": patient_name or "A patient",
        "date": data.get("date"),
        "time": data.get("time"),
        "hospital_id": hospital_id,
    }
    await sio.emit("new_notification", {"role": "receptionist", "hospital_id": hospital_id})
    if hospital_id:
        # Scoped to the specific VELA hospital's receptionist.
        await sio.emit("new_appointment", appointment_event, room=f"hospital_{hospital_id}")
    else:
        # Non-network booking has no hospital room — broadcast so any open
        # receptionist board still refreshes its today list.
        await sio.emit("new_appointment", appointment_event)
    print(f"⏱️  book_appointment background notify took {round((time.perf_counter() - t3) * 1000, 1)}ms")

FLAGSHIP_HOSPITALS = [
    {
        "name": "VELA Care",
        "address": "Plot 42, IT Park, Gachibowli",
        "city": "Hyderabad",
        "state": "Telangana",
        "phone": "+91-98765-43210",
        "email": "gachibowli@velacare.com",
        "specializations": ["Cardiology", "Neurology", "General Medicine", "Orthopedics"],
        "latitude": 17.4483,
        "longitude": 78.3741,
        "total_beds": 50,
        "hospital_slug": "vela-care-gachibowli",
        "active": True
    },
    {
        "name": "VELA Prime Medical",
        "address": "Road No. 36, Jubilee Hills",
        "city": "Hyderabad",
        "state": "Telangana",
        "phone": "+91-98765-43211",
        "email": "jubileehills@velacare.com",
        "specializations": ["Pediatrics", "Oncology", "Emergency Medicine"],
        "latitude": 17.4325,
        "longitude": 78.4071,
        "total_beds": 35,
        "hospital_slug": "vela-prime-jubilee-hills",
        "active": True
    },
    {
        "name": "VELA Apex Hospital",
        "address": "Regal Building, Connaught Place",
        "city": "New Delhi",
        "state": "Delhi",
        "phone": "+91-98765-43212",
        "email": "connaughtplace@velacare.com",
        "specializations": ["Cardiology", "Pulmonology", "Dermatology"],
        "latitude": 28.6304,
        "longitude": 77.2177,
        "total_beds": 60,
        "hospital_slug": "vela-apex-connaught-place",
        "active": True
    },
    {
        "name": "VELA Community Clinic",
        "address": "Station Road, Jadcherla",
        "city": "Jadcherla",
        "state": "Telangana",
        "phone": "+91-98765-43213",
        "email": "jadcherla@velacare.com",
        "specializations": ["General Medicine", "Pediatrics", "Maternity Care"],
        "latitude": 16.7029,
        "longitude": 78.1367,
        "total_beds": 20,
        "hospital_slug": "vela-community-jadcherla",
        "active": True
    }
]

async def seed_flagship_hospitals():
    """
    Self-healing seeding block that automatically verifies and seeds
    the 4 operational flagship VELA properties in the Supabase database.
    """
    def _seed():
        for h in FLAGSHIP_HOSPITALS:
            try:
                # Check if this slug exists
                exists = supabase_admin.table("vela_hospitals").select("id").eq("hospital_slug", h["hospital_slug"]).execute()
                if not exists.data:
                    supabase_admin.table("vela_hospitals").insert(h).execute()
                    print(f"🌱 Seeded flagship hospital: {h['name']}")
            except Exception as e:
                print(f"⚠️ Warning: Failed to seed hospital {h['name']}: {e}")
    # Threaded: this was previously calling the sync Supabase client directly
    # on the event loop, blocking every other request during startup seeding.
    await asyncio.to_thread(_seed)

async def warm_supabase_connection():
    """
    Measured: the first Supabase call from a freshly-started process pays a
    5-6s one-time tax (DNS resolution + TLS handshake for the httpx
    connection pool's first connection) — this is the actual root cause of
    "booking feels slow": whichever user's click happens to be the first
    Supabase-touching request after a backend restart eats that full delay.
    Pay it here during boot instead, with retries in case the network isn't
    up yet, so real user requests always hit a warm connection pool.
    """
    def _ping():
        for attempt in range(4):
            t0 = time.perf_counter()
            try:
                supabase_admin.table("vela_hospitals").select("id").limit(1).execute()
                print(f"🔥 Supabase connection warmed in {round((time.perf_counter() - t0) * 1000, 1)}ms (attempt {attempt + 1})")
                return
            except Exception as e:
                print(f"⚠️ Supabase warm-up attempt {attempt + 1} failed after {round((time.perf_counter() - t0) * 1000, 1)}ms: {e}")
                time.sleep(1)
        print("⚠️ Supabase warm-up did not succeed after 4 attempts — first real request will pay the cold-start cost")
    await asyncio.to_thread(_ping)

async def supabase_heartbeat():
    """
    Measured: warming Supabase once at boot isn't enough — the httpx keepalive
    connection goes cold after a stretch of idleness, so the *next* login (after
    a receptionist leaves the tab open, or overnight) pays the full ~4s cold
    reconnect again. A lightweight periodic ping keeps the connection pool warm
    permanently, so logins stay ~0.3s instead of intermittently spiking to 4s+.
    """
    while True:
        await asyncio.sleep(45)
        try:
            await asyncio.to_thread(
                lambda: supabase_admin.table("vela_hospitals").select("id").limit(1).execute()
            )
        except Exception as e:
            print(f"⚠️ Supabase heartbeat ping failed: {e}")

@fastapi_app.on_event("startup")
async def startup_event():
    asyncio.create_task(warm_supabase_connection())
    asyncio.create_task(seed_flagship_hospitals())
    asyncio.create_task(supabase_heartbeat())

_HOSP_SEARCH_CACHE: dict = {}
_HOSP_SEARCH_TTL = 90  # seconds — the VELA network changes rarely; patients wait on this list

@fastapi_app.get("/api/hospitals/search")
async def search_hospitals_global(query: Optional[str] = None, lat: Optional[float] = None, lng: Optional[float] = None):
    import time as _t
    key = (query or "", None if lat is None else round(lat, 3), None if lng is None else round(lng, 3))
    hit = _HOSP_SEARCH_CACHE.get(key)
    if hit and _t.time() - hit[0] < _HOSP_SEARCH_TTL:
        return hit[1]
    res = await _search_hospitals_global_impl(query, lat, lng)
    if isinstance(res, dict) and res.get("status") == "success":
        # Public list: never expose manager credentials/contact fields to patients.
        res = {"status": "success", "hospitals": [
            {k: v for k, v in h.items() if not str(k).startswith("manager_")} for h in res.get("hospitals", [])
        ]}
        _HOSP_SEARCH_CACHE[key] = (_t.time(), res)
    return res

async def _search_hospitals_global_impl(query: Optional[str] = None, lat: Optional[float] = None, lng: Optional[float] = None):
    try:
        import math
        
        # 1. High-Speed Layer: If no coordinates and no query, return the pre-compiled registry instantly (<1ms)
        if not query and lat is None and lng is None:
            # Try to fetch from database to get correct UUIDs, but fallback to static in <1ms if DB fails/cold
            try:
                db_res = supabase_admin.table("vela_hospitals").select("*").eq("active", True).execute()
                if db_res.data:
                    return {"status": "success", "hospitals": db_res.data}
            except Exception:
                pass
            return {"status": "success", "hospitals": FLAGSHIP_HOSPITALS}
            
        # 2. Distance sorting if coordinates are provided
        if lat is not None and lng is not None:
            try:
                # Fetch all active VELA hospitals to sort them
                db_res = supabase_admin.table("vela_hospitals").select("*").eq("active", True).execute()
                hospitals = db_res.data if db_res.data else FLAGSHIP_HOSPITALS
                
                # Haversine distance calculation in Python (highly optimized, avoids cold spatial queries)
                sorted_hospitals = []
                for h in hospitals:
                    h_lat = h.get("latitude")
                    h_lng = h.get("longitude")
                    if h_lat is not None and h_lng is not None:
                        # Distance math
                        rad_lat1 = math.radians(lat)
                        rad_lat2 = math.radians(h_lat)
                        diff_lat = math.radians(h_lat - lat)
                        diff_lng = math.radians(h_lng - lng)
                        
                        a = math.sin(diff_lat / 2) ** 2 + math.cos(rad_lat1) * math.cos(rad_lat2) * math.sin(diff_lng / 2) ** 2
                        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
                        distance = 6371 * c # Distance in KM
                        
                        # Add virtual distance field
                        h_copy = dict(h)
                        h_copy["distance_km"] = round(distance, 2)
                        sorted_hospitals.append(h_copy)
                        
                # Sort by distance
                sorted_hospitals.sort(key=lambda x: x.get("distance_km", 99999))
                
                # Filter out direct keyword if query is also passed
                if query:
                    q = query.lower()
                    sorted_hospitals = [
                        h for h in sorted_hospitals
                        if q in h.get("name", "").lower() or q in h.get("city", "").lower() or q in h.get("state", "").lower()
                    ]
                    
                return {"status": "success", "hospitals": sorted_hospitals}
            except Exception as e:
                print(f"⚠️ Warning: Nearby sorting failed: {e}")
                
        # 3. Direct keyword query fallback
        q_str = query or ""
        result = supabase_admin.table("vela_hospitals") \
            .select("*") \
            .or_(f"name.ilike.%{q_str}%,city.ilike.%{q_str}%,state.ilike.%{q_str}%,address.ilike.%{q_str}%") \
            .eq("active", True) \
            .execute()
            
        return {"status": "success", "hospitals": result.data or []}
        
    except Exception as e:
        return {"status": "error", "message": str(e)}

@fastapi_app.get("/api/appointments/today")
async def get_today_appointments(hospital_id: str = None):
    today = datetime.now().strftime("%Y-%m-%d")

    def _fetch():
        query = supabase_admin.table("appointments").select("*, patients(*)")
        if hospital_id:
            return query.eq("hospital_place_id", hospital_id).or_(f"status.eq.pending,date.eq.{today}").execute()
        return query.eq("date", today).execute()
    result = await asyncio.to_thread(_fetch)

    mapped_apts = []
    for item in (result.data or []):
        item["hospital_id"] = item.get("hospital_place_id")
        
        reason_val = item.get("reason", "")
        item["doctor_name"] = "General Physician"
        item["notes"] = ""
        
        if reason_val:
            try:
                notes_dict = json.loads(reason_val)
                item["doctor_name"] = notes_dict.get("doctor_name", "General Physician")
                item["notes"] = notes_dict.get("patient_notes", reason_val)
            except Exception:
                item["notes"] = reason_val
                
        if not item.get("doctor_name"):
            item["doctor_name"] = "General Physician"
            
        mapped_apts.append(item)
        
    return {"status": "success", "appointments": mapped_apts}

@fastapi_app.post("/api/appointments/{appointment_id}/accept")
async def accept_appointment(appointment_id: str, data: dict):
    staff_id = data.get("staff_id")
    staff_name = data.get("staff_name", "Staff")
    doctor_id = data.get("doctor_id") # Optional assigned doctor ID from receptionist
    
    # 1. Fetch appointment details
    apt_res = supabase_admin.table("appointments").select("*").eq("id", appointment_id).execute()
    if not apt_res.data:
        return {"status": "error", "message": "Appointment not found"}
    apt = apt_res.data[0]
    
    # 2. Decode notes and update audit trails
    notes_dict = {}
    reason_val = apt.get("reason", "")
    if reason_val:
        try:
            notes_dict = json.loads(reason_val)
        except:
            notes_dict = {"original": reason_val}
            
    notes_dict["audit"] = {
        "action": "accepted",
        "action_by_staff_id": staff_id,
        "action_by_staff_name": staff_name,
        "timestamp": datetime.utcnow().isoformat()
    }
    
    # 3. Update appointment status to 'scheduled' and save audit (and link doctor if assigned)
    update_payload = {
        "status": "scheduled",
        "reason": json.dumps(notes_dict)
    }
    assigned_doctor_id = doctor_id or apt.get("doctor_id") or notes_dict.get("doctor_id")
    if assigned_doctor_id:
        # Mirror vela_staff doctor into doctors table to satisfy FK constraint
        try:
            doc_exists = supabase_admin.table("doctors").select("id").eq("id", assigned_doctor_id).execute()
            if not doc_exists.data:
                staff_res = supabase_admin.table("vela_staff").select("*").eq("id", assigned_doctor_id).execute()
                if staff_res.data:
                    staff_doc = staff_res.data[0]
                    h_name = "Vela Hospital"
                    if staff_doc.get("hospital_id"):
                        h_res = supabase_admin.table("vela_hospitals").select("name").eq("id", staff_doc["hospital_id"]).execute()
                        if h_res.data:
                            h_name = h_res.data[0]["name"]
                    supabase_admin.table("doctors").insert({
                        "id": assigned_doctor_id,
                        "name": staff_doc.get("name", "Doctor"),
                        "specialization": staff_doc.get("specialization") or "General Physician",
                        "hospital": h_name,
                        "available": True
                    }).execute()
        except Exception as e:
            print(f"⚠️ Warning: doctor mirror to doctors table failed: {e}")
        update_payload["doctor_id"] = assigned_doctor_id
        
    supabase_admin.table("appointments").update(update_payload).eq("id", appointment_id).execute()
    
    # 4. Generate queue ticket
    patient_id = apt["patient_id"]
    
    patient_res = supabase_admin.table("patients").select("*").eq("id", patient_id).execute()
    patient = patient_res.data[0] if patient_res.data else {}
    
    # Ensure patient is linked to the hospital (wrapped in try-except to prevent column crashes)
    try:
        if patient and not patient.get("hospital_id"):
            h_id = apt.get("hospital_place_id") or apt.get("hospital_id")
            if h_id:
                supabase_admin.table("patients").update({"hospital_id": h_id}).eq("id", patient_id).execute()
    except Exception as e:
        print(f"⚠️ Warning: patient hospital_id update skipped: {e}")
    
    today_str = datetime.now().strftime("%Y%m%d")
    today_tickets = supabase_admin.table("tickets").select("*").like("ticket_number", f"TKT-{today_str}-%").execute().data
    count_today = len(today_tickets) + 1
    ticket_number = f"TKT-{today_str}-{count_today:04d}"
    
    # Get queue position
    waiting = supabase_admin.table("tickets").select("*").eq("status", "waiting").execute().data
    q_pos = len(waiting) + 1
    
    # Default department logic
    dept = "General"
    if assigned_doctor_id:
        try:
            # Query doctors table instead of vela_staff as doctor_id refers to doctors(id)
            doc_res = supabase_admin.table("doctors").select("specialization").eq("id", assigned_doctor_id).execute()
            if doc_res.data and doc_res.data[0].get("specialization"):
                spec = doc_res.data[0]["specialization"].lower()
                if "cardio" in spec:
                    dept = "Cardiology"
                elif "neuro" in spec:
                    dept = "Neurology"
                elif "emerg" in spec:
                    dept = "Emergency"
        except Exception as e:
            print(f"⚠️ Warning: doctor specialization lookup failed: {e}")
                
    ticket_data = {
        "ticket_number": ticket_number,
        "patient_id": patient_id,
        "vela_id": patient.get("vela_id"),
        "department": dept,
        "status": "waiting",
        "queue_position": q_pos,
        "doctor_id": assigned_doctor_id,
        "notes": f"Appointment approved: {apt.get('appointment_time') or apt.get('time')}"
    }
    supabase_admin.table("tickets").insert(ticket_data).execute()
    
    # Update appointment with queue position (wrapped in try-except in case column is missing)
    try:
        supabase_admin.table("appointments").update({"queue_position": q_pos}).eq("id", appointment_id).execute()
    except Exception as e:
        print(f"⚠️ Warning: queue_position update skipped: {e}")
        
    if assigned_doctor_id:
        try:
            from receptionist import invalidate_and_recache
            asyncio.create_task(invalidate_and_recache(assigned_doctor_id))
        except Exception as e:
            print(f"⚠️ Warning: failed to trigger pre-cache on accept: {e}")
        
    await sio.emit("queue_updated", {"type": "appointment_accepted", "patient_name": patient.get("name")})
    return {"status": "success", "ticket_number": ticket_number, "queue_position": q_pos}

@fastapi_app.post("/api/appointments/{appointment_id}/reject")
async def reject_appointment(appointment_id: str, data: dict):
    staff_id = data.get("staff_id")
    staff_name = data.get("staff_name", "Staff")
    
    # 1. Fetch appointment details
    apt_res = supabase_admin.table("appointments").select("*").eq("id", appointment_id).execute()
    if not apt_res.data:
        return {"status": "error", "message": "Appointment not found"}
    apt = apt_res.data[0]
    
    notes_dict = {}
    reason_val = apt.get("reason", "")
    if reason_val:
        try:
            notes_dict = json.loads(reason_val)
        except:
            notes_dict = {"original": reason_val}
            
    notes_dict["audit"] = {
        "action": "rejected",
        "action_by_staff_id": staff_id,
        "action_by_staff_name": staff_name,
        "timestamp": datetime.utcnow().isoformat()
    }
    
    supabase_admin.table("appointments").update({
        "status": "rejected",
        "reason": json.dumps(notes_dict)
    }).eq("id", appointment_id).execute()
    
    await sio.emit("queue_updated", {"type": "appointment_rejected", "appointment_id": appointment_id})
    return {"status": "success"}

@fastapi_app.post("/api/tickets/{ticket_id}/consult")
async def start_ticket_consult(ticket_id: str):
    res = supabase_admin.table("tickets").update({
        "status": "in-progress"
    }).eq("id", ticket_id).execute()
    
    if not res.data:
        return {"status": "error", "message": "Ticket not found"}
        
    doc_id = res.data[0].get("doctor_id")
    if doc_id:
        try:
            from receptionist import invalidate_and_recache
            asyncio.create_task(invalidate_and_recache(doc_id))
        except Exception as e:
            print(f"⚠️ Warning: failed to trigger pre-cache on consult start: {e}")
            
    await sio.emit("queue_updated", {"type": "consultation_started", "ticket_id": ticket_id})
    return {"status": "success", "ticket": res.data[0]}

async def _on_consult_completed(ticket: dict):
    """Everything that must happen when a consultation closes.

    The consultation record is generated unconditionally — a visit with no
    prescription and no tests still produces a dated document carrying the
    patient's vitals and AI-flagged findings, so the next doctor they see never
    starts from nothing.
    """
    doctor_id = ticket.get("doctor_id")
    if doctor_id:
        try:
            from receptionist import invalidate_and_recache
            asyncio.create_task(invalidate_and_recache(doctor_id))
        except Exception as e:
            print(f"⚠️ Warning: failed to trigger pre-cache on consult complete: {e}")

    patient_id = ticket.get("patient_id")
    if not patient_id:
        return

    async def _generate():
        try:
            # Tickets carry doctor_id, not a name — resolve it, otherwise the
            # record the patient hands a chemist has no prescriber on it.
            doctor_name = ticket.get("doctor_name") or ""
            hospital_id = ticket.get("hospital_id")
            if doctor_id and not doctor_name:
                try:
                    staff = await asyncio.to_thread(
                        supabase_admin.table("vela_staff")
                        .select("name, hospital_id").eq("id", doctor_id).execute
                    )
                    if staff.data:
                        doctor_name = staff.data[0].get("name") or ""
                        hospital_id = hospital_id or staff.data[0].get("hospital_id")
                except Exception as e:
                    print(f"⚠️ Could not resolve doctor name for visit report: {e}")

            await build_visit_report(
                patient_id=patient_id,
                doctor_name=doctor_name,
                hospital_id=hospital_id,
                chief_complaint=ticket.get("reason") or ticket.get("notes") or "",
            )
        except Exception as e:
            # Never let document generation block or fail closing a consultation.
            print(f"⚠️ Visit report generation failed on consult close for {patient_id}: {e}")

    asyncio.create_task(_generate())


@fastapi_app.post("/api/tickets/{ticket_id}/complete")
async def complete_ticket_consult(ticket_id: str):
    res = supabase_admin.table("tickets").update({
        "status": "completed"
    }).eq("id", ticket_id).execute()

    if not res.data:
        return {"status": "error", "message": "Ticket not found"}

    await _on_consult_completed(res.data[0])
    await sio.emit("queue_updated", {"type": "consultation_completed", "ticket_id": ticket_id})
    return {"status": "success", "ticket": res.data[0]}

@fastapi_app.post("/api/patients/{patient_id}/complete-consult")
async def complete_patient_consult(patient_id: str):
    """Complete the active (in-progress) consultation ticket for a patient."""
    res = supabase_admin.table("tickets").update({
        "status": "completed"
    }).eq("patient_id", patient_id).eq("status", "in-progress").execute()

    if not res.data:
        return {"status": "error", "message": "No active consultation found for this patient"}

    await _on_consult_completed(res.data[0])
    await sio.emit("queue_updated", {"type": "consultation_completed", "ticket_id": res.data[0]["id"]})
    return {"status": "success", "ticket": res.data[0]}

@fastapi_app.post("/api/appointments/{appointment_id}/arrive")
async def mark_appointment_arrived(appointment_id: str):
    # 1. Update appointment status
    apt_res = supabase.table("appointments").update({"status": "arrived"}).eq("id", appointment_id).execute()
    if not apt_res.data:
        return {"status": "error", "message": "Appointment not found"}
    
    appointment = apt_res.data[0]
    patient_id = appointment["patient_id"]
    
    # 2. Add to active queue (tickets table)
    # Generate ticket number TKT-YYYYMMDD-XXXX
    today_str = datetime.now().strftime("%Y%m%d")
    today_tickets = supabase.table("tickets").select("*").like("ticket_number", f"TKT-{today_str}-%").execute().data
    count_today = len(today_tickets) + 1
    ticket_number = f"TKT-{today_str}-{count_today:04d}"

    # Get queue position
    waiting = supabase.table("tickets").select("*").eq("status", "waiting").execute().data
    q_pos = len(waiting) + 1

    patient_res = supabase.table("patients").select("*").eq("id", patient_id).execute()
    patient = patient_res.data[0] if patient_res.data else {}

    doc_id = appointment.get("doctor_id")
    ticket_data = {
        "ticket_number": ticket_number,
        "patient_id": patient_id,
        "vela_id": patient.get("vela_id"),
        "department": "General",
        "status": "waiting",
        "queue_position": q_pos,
        "doctor_id": doc_id,
        "notes": f"Appointment Arrival: {appointment.get('appointment_time') or appointment.get('time')}"
    }
    supabase.table("tickets").insert(ticket_data).execute()
    
    # 3. Update appointment with queue position
    try:
        supabase.table("appointments").update({"queue_position": q_pos}).eq("id", appointment_id).execute()
    except Exception as e:
        # The appointments table has no queue_position column; the ticket already holds it, and the
        # patient's live position is read from the ticket. Don't fail a successful check-in over it.
        print(f"ℹ️ appointments.queue_position not stored ({str(e)[:60]})")

    if doc_id:
        try:
            from receptionist import invalidate_and_recache
            asyncio.create_task(invalidate_and_recache(doc_id))
        except Exception as e:
            print(f"⚠️ Warning: failed to trigger pre-cache on arrival: {e}")

    await sio.emit("queue_updated", {"type": "arrival", "patient_name": patient.get("name")})
    
    return {"status": "success", "ticket_number": ticket_number, "queue_position": q_pos}

@fastapi_app.get("/api/appointments/queue/{appointment_id}")
def get_appointment_queue_status(appointment_id: str):
    apt_res = supabase.table("appointments").select("*").eq("id", appointment_id).execute()
    if not apt_res.data:
         return {"status": "error", "message": "Appointment not found"}
    
    apt = apt_res.data[0]
    if apt["status"] not in ["arrived", "scheduled", "in-progress"]:
        return {"status": "pending", "message": "Patient has not arrived yet"}
    
    # Find current ticket for this patient
    ticket_res = supabase.table("tickets") \
        .select("*") \
        .eq("patient_id", apt["patient_id"]) \
        .neq("status", "completed") \
        .order("created_at", desc=True) \
        .limit(1) \
        .execute()
    
    if not ticket_res.data:
        return {"status": "error", "message": "No active ticket found"}
    
    ticket = ticket_res.data[0]
    
    # Calculate how many people are ahead IN THIS DOCTOR'S QUEUE
    ahead = supabase.table("tickets") \
        .select("id") \
        .eq("status", "waiting") \
        .eq("doctor_id", ticket.get("doctor_id")) \
        .lt("queue_position", ticket["queue_position"]) \
        .execute()
    
    count_ahead = len(ahead.data)
    
    doctor_name = "Assigned Doctor"
    if ticket.get("doctor_id"):
        doc = supabase_admin.table("vela_staff").select("name").eq("id", ticket["doctor_id"]).execute()
        if doc.data:
            doctor_name = doc.data[0]["name"]

    return {
        "status": "success",
        "ticket_number": ticket["ticket_number"],
        "position": count_ahead + 1,
        "people_ahead": count_ahead,
        "estimated_wait": (count_ahead + 1) * 15, # 15 mins per patient
        "ticket_status": ticket["status"],
        "assigned_doctor": doctor_name,
        "triage_level": ticket.get("triage_level", "Routine")
    }

@fastapi_app.get("/api/notifications/{role}")
async def get_notifications(role: str):
    try:
        result = await asyncio.to_thread(
            lambda: supabase.table("notifications")
            .select("*")
            .eq("role", role)
            .order("created_at", desc=True)
            .limit(20)
            .execute()
        )

        mapped_notifications = []
        for item in (result.data or []):
            item["is_read"] = item.get("read", False)
            mapped_notifications.append(item)
            
        return {"status": "success", "notifications": mapped_notifications}
    except Exception:
        return {"status": "success", "notifications": []}

@fastapi_app.put("/api/notifications/{notification_id}/read")
def mark_notification_read(notification_id: str):
    try:
        result = supabase.table("notifications").update({"read": True}).eq("id", notification_id).execute()
        notification = result.data[0] if result.data else None
        if notification:
            notification["is_read"] = True
        return {"status": "success", "notification": notification}
    except Exception:
        return {"status": "success", "notification": None}

@fastapi_app.get("/api/appointments/patient/{patient_id}")
def get_patient_appointments(patient_id: str):
    result = supabase.table("appointments") \
        .select("*") \
        .eq("patient_id", patient_id) \
        .order("date", desc=True) \
        .execute()
        
    mapped_apts = []
    for item in (result.data or []):
        item["hospital_id"] = item.get("hospital_place_id")
        
        reason_val = item.get("reason", "")
        item["doctor_name"] = "General Physician"
        item["notes"] = ""
        
        if reason_val:
            try:
                notes_dict = json.loads(reason_val)
                item["doctor_name"] = notes_dict.get("doctor_name", "General Physician")
                item["notes"] = notes_dict.get("patient_notes", reason_val)
            except Exception:
                item["notes"] = reason_val
                
        if not item.get("doctor_name"):
            item["doctor_name"] = "General Physician"
            
        mapped_apts.append(item)
        
    return {"status": "success", "appointments": mapped_apts}

# --- HOSPITAL MANAGER ---
@fastapi_app.get("/api/hospital/overview")
def get_hospital_overview(hospital_id: str = "VLA-MAIN"):
    try:
        beds_res = supabase_admin.table("beds").select("*").eq("hospital_id", hospital_id).execute()
        staff_res = supabase_admin.table("vela_staff").select("*").eq("hospital_id", hospital_id).execute()
        docs_res = supabase_admin.table("documents").select("*").execute() # Docs usually linked to patient, so hospital_id filter implicitly handled if we filter patients
        
        # Today's appointments
        from datetime import datetime
        today = datetime.now().strftime("%Y-%m-%d")
        apt_res = supabase_admin.table("appointments").select("*").eq("hospital_place_id", hospital_id).eq("date", today).execute()

        # Admission stats
        # Admissions are stored in the local database (see /api/admit), not in Supabase.
        admissions_data = local_query("SELECT * FROM admissions WHERE hospital_id = ?", (hospital_id,)) or []
        active_inpatients = len([a for a in admissions_data if a.get('status') == 'active'])
        
        # Today's admissions count
        today_start = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        admissions_today = len([a for a in admissions_data if (a.get('admitted_at') or '') >= today_start])

        # The patients table has no hospital column: a hospital's patients are the ones who have
        # been ticketed by its doctors, booked with it, or admitted to it.
        staff_data = staff_res.data or []
        staff_ids = [x["id"] for x in staff_data if x.get("id")]
        pid_set = {a.get("patient_id") for a in admissions_data if a.get("patient_id")}
        if staff_ids:
            tk = supabase_admin.table("tickets").select("patient_id").in_("doctor_id", staff_ids).execute()
            pid_set |= {t["patient_id"] for t in (tk.data or []) if t.get("patient_id")}
        ap = supabase_admin.table("appointments").select("patient_id").eq("hospital_place_id", hospital_id).execute()
        pid_set |= {a["patient_id"] for a in (ap.data or []) if a.get("patient_id")}
        patients_data = (supabase_admin.table("patients").select("*").in_("id", list(pid_set)).execute().data or []) if pid_set else []
        beds_data = beds_res.data or []
        docs_data = docs_res.data or []

        total_beds = len(beds_data)
        occupied_beds = len([b for b in beds_data if b.get('status') == 'occupied'])
        empty_beds = total_beds - occupied_beds
        total_patients = len(patients_data)
        critical_patients = len([p for p in patients_data if p.get('risk_score', 0) > 70])
        reports_today = len(docs_data)
        staff_online = len([s for s in staff_data if s.get('online') == True])
        alerts_today = critical_patients * 2
        appointments_today = len(apt_res.data or [])
        
        # Utilization Trend (last 14 days)
        # We'll calculate occupancy based on admissions
        trends = []
        from datetime import timedelta
        for i in range(7, -1, -1):
            d = datetime.now() - timedelta(days=i)
            d_str = d.strftime("%b %d")
            # For a real system we'd check historical snapshots, 
            # for now we'll count admissions that were active on that day
            d_iso = d.date().isoformat()
            active_that_day = len([a for a in admissions_data if (a.get('admitted_at') or "").split('T')[0] <= d_iso and (not a.get('discharged_at') or a.get('discharged_at').split('T')[0] > d_iso)])
            trends.append({"t": d_str, "v": active_that_day})

        # Risk Profile Distribution
        risk_dist = [
            {"name": "Critical", "value": critical_patients, "color": "#EF4444"},
            {"name": "Moderate", "value": len([p for p in patients_data if 40 < p.get('risk_score', 0) <= 70]), "color": "#F59E0B"},
            {"name": "Stable", "value": len([p for p in patients_data if p.get('risk_score', 0) <= 40]), "color": "#10B981"}
        ]
        
        return {
            "status": "success",
            "data": {
                "total_patients": total_patients,
                "total_beds": total_beds,
                "occupied_beds": occupied_beds,
                "empty_beds": empty_beds,
                "critical_patients": critical_patients,
                "reports_today": reports_today,
                "alerts_today": alerts_today,
                "staff_online": staff_online,
                "appointments_today": appointments_today,
                "admissions_today": admissions_today,
                "active_inpatients": active_inpatients,
                "utilization_trend": trends,
                "risk_profile": risk_dist,
                "time_saved_hours": int(reports_today * 0.5),
                "handover_time_seconds": 8
            }
        }
    except Exception as e:
        print("Overview fetch error:", str(e))
        return {"status": "error", "message": str(e)}

@fastapi_app.get("/api/wards")
def get_wards(hospital_id: str = "VLA-MAIN"):
    wards_res = supabase_admin.table("wards").select("*").eq("hospital_id", hospital_id).execute()
    beds_res = supabase_admin.table("beds").select("*").eq("hospital_id", hospital_id).execute()
    patients_res = supabase_admin.table("patients").select("id, name, vela_id, risk_score, age, diagnosis").execute()
    staff_res = supabase_admin.table("vela_staff").select("id, name, role, ward_id").eq("hospital_id", hospital_id).eq("active", True).execute()
    
    patient_map = {p["id"]: p for p in patients_res.data}
    wards = wards_res.data
    for ward in wards:
        ward["beds"] = [b for b in beds_res.data if b["ward_id"] == ward["id"]]
        for bed in ward["beds"]:
            bed["patient"] = patient_map.get(bed.get("patient_id")) if bed.get("patient_id") else None
        
        # Include staff assigned to this ward
        ward["staff"] = [s for s in (staff_res.data or []) if s.get("ward_id") == ward["id"]]
            
    return {"status": "success", "wards": wards}

@fastapi_app.post("/api/wards")
def create_ward(data: dict):
    hospital_id = data.get("hospital_id", "VLA-MAIN")
    result = supabase_admin.table("wards").insert({
        "hospital_id": hospital_id,
        "name": data.get("name"),
        "type": data.get("type"),
        "color": data.get("color", "#0F766E"),
        "floor_number": data.get("floor_number", 1)
    }).execute()
    
    if result.data:
        ward_id = result.data[0]["id"]
        # Generate 10 default beds for new ward
        for i in range(1, 11):
            supabase_admin.table("beds").insert({
                "hospital_id": hospital_id,
                "ward_id": ward_id,
                "bed_number": f"{data.get('name')[:3].upper()}-{i:02d}",
                "status": "empty"
            }).execute()
            
    return {"status": "success", "ward": result.data[0]}

@fastapi_app.post("/api/beds")
def create_bed(data: dict):
    result = supabase.table("beds").insert({
        "hospital_id": data.get("hospital_id", "VLA-MAIN"),
        "ward_id": data.get("ward_id") if data.get("ward_id") else None,
        "bed_number": data.get("bed_number"),
        "status": "empty"
    }).execute()
    return {"status": "success", "bed": result.data[0]}

@fastapi_app.put("/api/beds/{bed_id}/admit")
async def admit_patient(bed_id: str, data: dict):
    patient_id = data.get("patient_id")
    result = supabase.table("beds").update({
        "status": "occupied",
        "patient_id": patient_id,
        "assigned_doctor": data.get("doctor", ""),
        "admitted_at": datetime.utcnow().isoformat()
    }).eq("id", bed_id).execute()
    
    bed = result.data[0]
    patient_res = supabase.table("patients").select("*").eq("id", patient_id).execute()
    patient = patient_res.data[0] if patient_res.data else {}
    ward_res = supabase.table("wards").select("*").eq("id", bed.get("ward_id")).execute()
    ward = ward_res.data[0] if ward_res.data else {}
    
    await sio.emit("patient_admitted", {
        "bed_id": bed_id,
        "patient_name": patient.get("name", "Unknown"),
        "ward_name": ward.get("name", "Unknown"),
        "bed_number": bed.get("bed_number")
    })
    
    return {"status": "success", "bed": bed}

@fastapi_app.put("/api/wards/{ward_id}/position")
def update_ward_position(ward_id: str, data: dict):
    x = data.get("x", 0)
    y = data.get("y", 0)
    result = supabase_admin.table("wards").update({"x": x, "y": y}).eq("id", ward_id).execute()
    return {"status": "success", "ward": result.data[0]}

@fastapi_app.put("/api/beds/{bed_id}/discharge")
async def discharge_patient(bed_id: str):
    bed_res = supabase.table("beds").select("*").eq("id", bed_id).execute()
    if not bed_res.data:
        return {"status": "error", "message": "Bed not found"}
    old_bed = bed_res.data[0]
    
    patient_res = supabase.table("patients").select("*").eq("id", old_bed.get("patient_id")).execute()
    patient_name = patient_res.data[0].get("name", "Unknown") if patient_res.data else "Unknown"

    result = supabase.table("beds").update({
        "status": "empty",
        "patient_id": None,
        "assigned_doctor": "",
        "admitted_at": None
    }).eq("id", bed_id).execute()
    
    await sio.emit("patient_discharged", {
        "bed_id": bed_id,
        "patient_name": patient_name,
        "bed_number": old_bed.get("bed_number")
    })
    
    return {"status": "success", "bed": result.data[0]}

@fastapi_app.put("/api/beds/{bed_id}/status")
async def update_bed_status(bed_id: str, data: dict):
    new_status = data.get("status")
    result = supabase_admin.table("beds").update({"status": new_status}).eq("id", bed_id).execute()
    
    await sio.emit("bed_status_changed", {
        "bed_id": bed_id,
        "status": new_status
    })
    return {"status": "success", "bed": result.data[0]}

@fastapi_app.delete("/api/wards/{ward_id}")
def delete_ward(ward_id: str):
    supabase_admin.table("beds").delete().eq("ward_id", ward_id).execute()
    supabase_admin.table("wards").delete().eq("id", ward_id).execute()
    return {"status": "success"}

@fastapi_app.delete("/api/beds/{bed_id}")
def delete_bed(bed_id: str):
    supabase.table("beds").delete().eq("id", bed_id).execute()
    return {"status": "success"}
    
# --- STAFF ---
@fastapi_app.post("/api/staff/add")
def add_staff_basic(data: dict):
    result = supabase_admin.table("vela_staff").insert({
        "hospital_id": data.get("hospital_id", "VLA-MAIN"),
        "name": data.get("name"),
        "role": data.get("role"),
        "email": data.get("email"),
        "active": True
    }).execute()
    return {"status": "success", "staff": result.data[0]}

@fastapi_app.delete("/api/staff/{staff_id}")
def delete_staff(staff_id: str):
    supabase_admin.table("vela_staff").delete().eq("id", staff_id).execute()
    return {"status": "success"}

@fastapi_app.get("/api/staff/list")
def get_staff_legacy():
    result = supabase_admin.table("vela_staff").select("*").execute()
    return {"status": "success", "staff": result.data}

# --- LAB & TEST FLOW ROUTES ---

def merge_patients_for_orders(orders):
    if not orders:
        return []
    patient_ids = list(set([o["patient_id"] for o in orders if o.get("patient_id")]))
    if not patient_ids:
        return orders
    try:
        # Fetch patients from Supabase in a single batch query
        res = supabase.table("patients").select("*").in_("id", patient_ids).execute()
        patient_map = {p["id"]: p for p in res.data}
    except Exception as e:
        print("Error fetching patients for merge:", e)
        patient_map = {}
        
    for o in orders:
        p = patient_map.get(o.get("patient_id"))
        if p:
            o["patients"] = p
        else:
            o["patients"] = None
            
        if o.get("specific_tests") and isinstance(o["specific_tests"], str):
            try:
                o["specific_tests"] = json.loads(o["specific_tests"])
            except Exception:
                pass
    return orders

# ── LAB ROUTING, BILLING & DOCUMENT GENERATION ────────────────────────────────

def fetch_patient_record(patient_id: str) -> dict:
    """Patient fields the generated documents print. Never raises."""
    try:
        res = supabase.table("patients").select(
            "id, name, vela_id, age, gender, blood_group, allergies, diagnosis"
        ).eq("id", patient_id).execute()
        if res.data:
            return res.data[0]
    except Exception as e:
        print(f"⚠️ fetch_patient_record failed for {patient_id}: {e}")
    return {"id": patient_id, "name": "Patient", "vela_id": "—", "age": None, "gender": None}


def fetch_hospital_name(hospital_id: Optional[str]) -> str:
    if not is_valid_uuid(hospital_id):
        return "VELA Partner Hospital"
    try:
        res = supabase.table("vela_hospitals").select("name").eq("id", hospital_id).execute()
        if res.data:
            return res.data[0].get("name") or "VELA Partner Hospital"
    except Exception:
        pass
    return "VELA Partner Hospital"


def get_active_admission(patient_id: str) -> Optional[dict]:
    """The patient's current in-hospital admission, if any.

    This is the hinge for the edge case where an already-admitted patient is sent
    for a test: they are inside the hospital on a running bill, so they must not
    be asked to pay on their phone or re-enter the outpatient queue.
    """
    rows = local_query(
        "SELECT * FROM admissions WHERE patient_id = ? AND status = 'active' "
        "ORDER BY admitted_at DESC LIMIT 1",
        (patient_id,)
    )
    return rows[0] if rows else None


def network_lab_id_for_session(request: _Request) -> str:
    """Set only for an independent lab's own login (see /api/network/labs/auth/login).
    Session-derived, never client-supplied, so one network lab can never widen
    its view into another's queue by passing a different id."""
    session = getattr(request.state, "session", None) or {}
    return (session.get("network_lab_id") or "").strip()


def lab_department_for_session(request: _Request) -> str:
    """Which lab queue the caller is allowed to see.

    A department-scoped lab account (`specialization` on their staff row) sees
    only its own department. The lab@vela.ai demo account and any unscoped lab
    user act as a super-lab and see every department.
    """
    session = getattr(request.state, "session", None) or {}
    dept = (session.get("lab_department") or "").strip().lower()
    if dept in lab_catalog.DEPARTMENT_IDS:
        return dept
    return lab_catalog.ALL_DEPARTMENTS


def hospital_catalog_overrides(hospital_id: str) -> dict:
    """This hospital's own routing/pricing, keyed by lowercased test name.

    `lab_catalog.py` ships sensible defaults, but each hospital decides which of
    its labs runs a test and what it charges. Reception maintains those rows
    (see /api/lab/catalog/entry); they win over the built-in catalog.
    """
    if not hospital_id:
        return {}
    try:
        rows = local_query(
            "SELECT test_type, department, sample_type, price, tat_minutes "
            "FROM lab_templates WHERE hospital_id = ?",
            (hospital_id,)
        )
    except Exception as e:
        print(f"⚠️ Warning: catalog override lookup failed for hospital {hospital_id}: {e}")
        return {}
    return {(r["test_type"] or "").strip().lower(): r for r in rows if r.get("test_type")}


def network_lab_catalog_overrides(network_lab_id: str) -> dict:
    """Same idea as hospital_catalog_overrides, keyed by network_lab_id — an
    independent lab's own price/format list, used when routing an order to it."""
    if not network_lab_id:
        return {}
    try:
        rows = local_query(
            "SELECT test_type, department, sample_type, price, tat_minutes "
            "FROM lab_templates WHERE network_lab_id = ?",
            (network_lab_id,)
        )
    except Exception as e:
        print(f"⚠️ Warning: catalog override lookup failed for network lab {network_lab_id}: {e}")
        return {}
    return {(r["test_type"] or "").strip().lower(): r for r in rows if r.get("test_type")}


def resolve_tests_for_hospital(test_names: list, hospital_id: str) -> list:
    """Resolve test names through the built-in catalog, then apply this
    hospital's overrides so orders route and price the way reception set them."""
    overrides = hospital_catalog_overrides(hospital_id)
    resolved = lab_catalog.resolve_tests(test_names)
    for entry in resolved:
        o = overrides.get(entry["test_type"].strip().lower())
        if not o:
            continue
        if o.get("department"):
            entry["department"] = o["department"]
        if o.get("sample_type"):
            entry["sample_type"] = o["sample_type"]
        if o.get("price") is not None:
            entry["price"] = float(o["price"])
        if o.get("tat_minutes"):
            entry["tat_minutes"] = int(o["tat_minutes"])
        entry["matched"] = True
        entry["custom"] = True
    return resolved


def create_test_orders(
    *,
    patient_id: str,
    test_names: list,
    doctor_name: str,
    hospital_id: Optional[str] = None,
    priority: str = "routine",
    notes: str = "",
    visit_id: Optional[str] = None,
) -> list:
    """Route, price and persist a batch of test orders.

    Every order is resolved through `lab_catalog` so it lands in the right
    department at the right price. Admitted patients are billed to their
    admission and skip the payment gate entirely — they go straight into the
    lab queue.
    """
    hospital_id = get_valid_hospital_id(hospital_id)
    admission = get_active_admission(patient_id)
    now = datetime.utcnow().isoformat()

    created = []
    for resolved in resolve_tests_for_hospital(test_names, hospital_id):
        order_id = str(uuid.uuid4())

        if admission:
            # Inpatient: no upfront payment, no payment queue — bill it to the stay.
            billing_mode, payment_status, status = "admission", "billed_to_admission", "payment_confirmed"
        else:
            billing_mode, payment_status, status = "patient", "pending", "pending"

        local_execute(
            """INSERT INTO test_orders (
                id, patient_id, hospital_id, doctor_name, test_type, test_category,
                department, sample_type, tat_minutes, specific_tests, priority, notes,
                status, payment_status, payment_amount, price, billing_mode,
                queue_position, visit_id, ordered_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)""",
            (
                order_id, patient_id, hospital_id, doctor_name,
                resolved["test_type"], resolved["department"],
                resolved["department"], resolved["sample_type"], resolved["tat_minutes"],
                json.dumps([resolved["test_type"]]), priority, notes,
                status, payment_status,
                resolved["price"] if billing_mode == "admission" else 0.0,
                resolved["price"], billing_mode,
                visit_id, now,
            )
        )

        if billing_mode == "admission":
            _assign_queue_position(order_id)

        row = local_query("SELECT * FROM test_orders WHERE id = ?", (order_id,))[0]
        if isinstance(row.get("specific_tests"), str):
            try:
                row["specific_tests"] = json.loads(row["specific_tests"])
            except Exception:
                pass
        row["catalog_matched"] = resolved["matched"]
        created.append(row)

    return created


def _describe_created_orders(orders: list, patient_name: str) -> str:
    """What Atlas says back to the doctor after placing orders.

    Names the department and the money, because those are the two things the
    doctor would otherwise have to go and ask someone about.
    """
    names = ", ".join(o["test_type"] for o in orders)
    by_dept: dict[str, list] = {}
    for o in orders:
        by_dept.setdefault(o.get("department") or "pathology", []).append(o["test_type"])
    routing = "; ".join(f"{', '.join(tests)} to {dept}" for dept, tests in by_dept.items())

    if orders[0].get("billing_mode") == "admission":
        return (
            f"Done. I've ordered {names} for {patient_name} — routed {routing}. "
            f"{patient_name} is admitted, so it's billed to the admission and already in the lab queue."
        )

    total = sum(o.get("price") or 0 for o in orders)
    return (
        f"Done. I've ordered {names} for {patient_name} — routed {routing}. "
        f"A payment request for ₹{total:,.0f} has gone to their phone. "
        f"Once they've paid and reception marks them arrived at the lab, it joins the lab queue."
    )


async def notify_tests_ordered(*, patient_id: str, patient_name: str, orders: list, doctor_name: str):
    """Fan out a new batch of test orders to everyone who needs to react.

    Outpatients get a payment request on their phone; inpatients are already in
    the queue, so their labs are notified straight away instead.
    """
    tests = [o["test_type"] for o in orders]
    departments = sorted({o.get("department") or "pathology" for o in orders})
    billed_to_admission = orders[0].get("billing_mode") == "admission"
    total = sum(o.get("price") or 0 for o in orders)

    await sio.emit("test_ordered", {
        "patient_id": patient_id,
        "patient_name": patient_name,
        "tests": tests,
        "departments": departments,
        "priority": orders[0].get("priority", "routine"),
        "doctor_name": doctor_name,
        "billing_mode": orders[0].get("billing_mode", "patient"),
        "total_amount": total,
        "orders": orders,
    })

    if billed_to_admission:
        await sio.emit("tests_assigned", {
            "patient_id": patient_id,
            "tests": tests,
            "billing_mode": "admission",
            "message": (
                f"Doctor has ordered: {', '.join(tests)}. "
                "Charged to your admission — no payment needed, the lab has been notified."
            ),
        })
        for dept in departments:
            await sio.emit("payment_confirmed", {
                "patient_name": patient_name,
                "tests": [o["test_type"] for o in orders if (o.get("department") or "pathology") == dept],
                "department": dept,
                "billing_mode": "admission",
            })
    else:
        # The request lands on the patient's phone first — the lab sees nothing
        # until it is paid for.
        await sio.emit("test_payment_requested", {
            "patient_id": patient_id,
            "patient_name": patient_name,
            "tests": tests,
            "departments": departments,
            "total_amount": total,
            "orders": [
                {"order_id": o["id"], "test_type": o["test_type"],
                 "department": o.get("department"), "price": o.get("price")}
                for o in orders
            ],
            "message": f"Dr. {doctor_name} has ordered {', '.join(tests)}. Pay ₹{total:,.0f} to confirm.",
        })
        await sio.emit("tests_assigned", {
            "patient_id": patient_id,
            "tests": tests,
            "total_amount": total,
            "message": f"Doctor has ordered: {', '.join(tests)}. Pay ₹{total:,.0f} from your dashboard to book your slot.",
        })

    await sio.emit("queue_updated", {"departments": departments})


def admission_test_charges(patient_id: str, admitted_at: Optional[str],
                           discharged_at: Optional[str] = None) -> tuple[float, list]:
    """Test charges that belong on an admission's discharge bill.

    Two rules, both of which the previous all-time `payment_status = 'confirmed'`
    query got wrong:

    1. Only tests ordered *during this admission* count. The old query summed
       every confirmed test the patient had ever had, so an outpatient test from
       a year ago landed on today's discharge bill.
    2. Only tests billed *to the admission* count. A test the patient already
       paid for on their phone must not be charged a second time at discharge.

    Returns (total, line_items).
    """
    if not admitted_at:
        return 0.0, []

    params: list = [patient_id, admitted_at]
    clause = ("SELECT id, test_type, department, price, payment_amount, ordered_at "
              "FROM test_orders WHERE patient_id = ? "
              "AND COALESCE(billing_mode, 'patient') = 'admission' "
              "AND ordered_at >= ?")
    if discharged_at:
        clause += " AND ordered_at <= ?"
        params.append(discharged_at)

    rows = local_query(clause + " ORDER BY ordered_at", tuple(params))
    items = [
        {
            "order_id": r["id"],
            "test_type": r["test_type"],
            "department": r.get("department"),
            "amount": r.get("payment_amount") or r.get("price") or 0.0,
        }
        for r in rows
    ]
    return round(sum(i["amount"] for i in items), 2), items


def _assign_queue_position(order_id: str) -> int:
    """Next position in the department's queue. Scoped per department so
    radiology's #3 is genuinely radiology's third patient, not the hospital's."""
    row = local_query("SELECT department FROM test_orders WHERE id = ?", (order_id,))
    dept = (row[0].get("department") if row else None) or "pathology"
    ahead = local_query(
        "SELECT id FROM test_orders WHERE department = ? "
        "AND status IN ('payment_confirmed', 'accepted', 'in_progress')",
        (dept,)
    )
    pos = len(ahead)
    local_execute("UPDATE test_orders SET queue_position = ? WHERE id = ?", (pos, order_id))
    return pos


async def file_generated_document(
    *,
    patient_id: str,
    filename: str,
    raw_text: str,
    pdf_path: str,
    kind: str,
    source_id: str,
    summary_values: Optional[list] = None,
    critical_flags: Optional[list] = None,
    risk_score: int = 0,
    report_date: Optional[str] = None,
) -> Optional[str]:
    """File a VELA-generated document into the patient's permanent record.

    Inserts it into `documents` (so it shows on the patient dashboard and to any
    future doctor) and embeds it into RAG (so Atlas can answer from it without
    anyone re-uploading it). Returns the document id, or None if filing failed —
    callers treat that as non-fatal, the PDF still exists either way.
    """
    report_date = report_date or datetime.utcnow().strftime("%Y-%m-%d")
    try:
        res = await asyncio.to_thread(
            supabase.table("documents").insert({
                "patient_id": patient_id,
                "filename": filename,
                "report_date": report_date,
                "risk_score": risk_score,
                "summary": raw_text[:8000],
                "values": summary_values or [],
                "critical_flags": critical_flags or [],
            }).execute
        )
    except Exception as e:
        print(f"⚠️ Failed to file generated document for {patient_id}: {e}")
        return None

    if not res.data:
        return None
    doc_id = res.data[0]["id"]

    local_execute(
        "INSERT OR REPLACE INTO generated_files "
        "(document_id, patient_id, kind, source_id, pdf_path, filename, created_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (doc_id, patient_id, kind, source_id, pdf_path, filename, datetime.utcnow().isoformat())
    )

    # Embedding is slow; the caller must not wait on it.
    async def _embed():
        try:
            await bg_run(process_document_for_rag, patient_id, doc_id, filename, report_date, raw_text)
            await sio.emit("timeline_updated", {"patient_id": patient_id, "document_id": doc_id, "status": "done"})
        except Exception as e:
            print(f"⚠️ RAG ingest failed for generated doc {doc_id}: {e}")

    asyncio.create_task(_embed())
    return doc_id


@fastapi_app.get("/api/lab/departments")
def get_lab_departments():
    return {"status": "success", "departments": lab_catalog.DEPARTMENTS}


@fastapi_app.get("/api/lab/catalog")
def get_lab_catalog(hospital_id: Optional[str] = None, department: Optional[str] = None):
    """Full orderable test menu: built-in catalog plus this hospital's custom formats."""
    items = lab_catalog.catalog_listing()

    custom = local_query(
        "SELECT id, test_type, department, sample_type, price, tat_minutes FROM lab_templates WHERE hospital_id = ?",
        (get_valid_hospital_id(hospital_id),)
    ) if hospital_id else local_query(
        "SELECT id, test_type, department, sample_type, price, tat_minutes FROM lab_templates"
    )

    by_name = {i["test_type"].lower(): i for i in items}
    for c in custom:
        c["custom"] = True
        by_name[c["test_type"].lower()] = c

    merged = sorted(by_name.values(), key=lambda i: (i.get("department") or "", i["test_type"]))
    if department and department != lab_catalog.ALL_DEPARTMENTS:
        merged = [i for i in merged if i.get("department") == department]

    return {"status": "success", "tests": merged, "departments": lab_catalog.DEPARTMENTS}


@fastapi_app.post("/api/lab/catalog/entry")
async def upsert_lab_catalog_entry(data: dict):
    """Reception defines a test: its name, which lab runs it, and what it costs.

    Deliberately does NOT require report fields — reception sets up the menu and
    pricing, while the lab owns the report format for the same test (POST
    /api/lab/templates). Both write the same `lab_templates` row, so a test set
    up here already has a usable report layout: the built-in one for a known
    test, or a generic value/observation form for a brand-new one.
    """
    test_type = (data.get("test_type") or "").strip()
    if not test_type:
        return {"status": "error", "message": "Test name is required"}

    department = (data.get("department") or "").strip().lower()
    if department not in lab_catalog.DEPARTMENT_IDS:
        return {
            "status": "error",
            "message": f"Choose which lab runs this test ({', '.join(lab_catalog.DEPARTMENT_IDS)})",
        }

    try:
        price = float(data.get("price"))
    except (TypeError, ValueError):
        return {"status": "error", "message": "A valid price is required"}
    if price < 0:
        return {"status": "error", "message": "Price cannot be negative"}

    hospital_id = get_valid_hospital_id(data.get("hospital_id"))
    resolved = lab_catalog.resolve_test(test_type)
    sample_type = (data.get("sample_type") or "").strip() or resolved["sample_type"]
    tat_minutes = int(data.get("tat_minutes") or resolved["tat_minutes"])
    now = datetime.utcnow().isoformat()

    existing = local_query(
        "SELECT id, fields, instructions FROM lab_templates "
        "WHERE hospital_id = ? AND LOWER(test_type) = LOWER(?)",
        (hospital_id, test_type)
    )

    if existing:
        # Reception is repricing/rerouting an existing test — never clobber the
        # report format the lab has already tuned for it.
        local_execute(
            "UPDATE lab_templates SET test_type = ?, department = ?, sample_type = ?, "
            "price = ?, tat_minutes = ?, updated_at = ? WHERE id = ?",
            (test_type, department, sample_type, price, tat_minutes, now, existing[0]["id"])
        )
        entry_id = existing[0]["id"]
    else:
        entry_id = str(uuid.uuid4())
        fields = (lab_catalog.builtin_template(test_type) or {}).get("fields") \
            or lab_catalog.UNKNOWN_TEST_DEFAULT["fields"]
        local_execute(
            "INSERT INTO lab_templates (id, hospital_id, test_type, department, sample_type, price, "
            "tat_minutes, fields, instructions, updated_at, created_by, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (entry_id, hospital_id, test_type, department, sample_type, price, tat_minutes,
             json.dumps(fields), "", now, (data.get("created_by") or "Reception"), now)
        )

    await sio.emit("lab_catalog_updated", {
        "entry_id": entry_id, "test_type": test_type,
        "department": department, "price": price, "hospital_id": hospital_id,
    })
    return {
        "status": "success", "entry_id": entry_id, "test_type": test_type,
        "department": department, "price": price, "tat_minutes": tat_minutes,
        "sample_type": sample_type,
    }


@fastapi_app.delete("/api/lab/catalog/entry/{entry_id}")
async def delete_lab_catalog_entry(entry_id: str):
    """Remove a hospital's custom test. Built-in catalog tests remain orderable."""
    local_execute("DELETE FROM lab_templates WHERE id = ?", (entry_id,))
    await sio.emit("lab_catalog_updated", {"entry_id": entry_id, "deleted": True})
    return {"status": "success"}


@fastapi_app.get("/api/lab/orders")
def get_lab_orders(
    request: _Request,
    hospital_id: Optional[str] = None,
    department: Optional[str] = None,
):
    """The lab's working queue, scoped to the caller's department.

    An explicit `department` query param narrows further (the super-lab account
    uses it to switch between department tabs).
    """
    network_lab_id = network_lab_id_for_session(request)
    if network_lab_id:
        # An independent lab only ever sees orders routed to it (Phase 4) —
        # no hospital/department scoping applies here.
        orders = local_query(
            "SELECT * FROM test_orders WHERE network_lab_id = ? AND "
            "status IN ('payment_confirmed', 'accepted', 'in_progress') ORDER BY "
            "CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, queue_position ASC, ordered_at ASC",
            (network_lab_id,)
        )
        return {
            "status": "success",
            "orders": merge_patients_for_orders(orders),
            "department_scope": "network_lab",
            "active_department": "network_lab",
        }

    allowed = lab_department_for_session(request)
    scope = department if department else allowed
    if allowed != lab_catalog.ALL_DEPARTMENTS:
        # A scoped account cannot widen its view by passing a different department.
        scope = allowed

    clauses = ["status IN ('payment_confirmed', 'accepted', 'in_progress')"]
    params: list = []
    if hospital_id:
        clauses.append("hospital_id = ?")
        params.append(get_valid_hospital_id(hospital_id))
    if scope and scope != lab_catalog.ALL_DEPARTMENTS:
        clauses.append("COALESCE(department, 'pathology') = ?")
        params.append(scope)

    orders = local_query(
        f"SELECT * FROM test_orders WHERE {' AND '.join(clauses)} ORDER BY "
        "CASE priority WHEN 'urgent' THEN 0 ELSE 1 END, queue_position ASC, ordered_at ASC",
        tuple(params)
    )

    orders = merge_patients_for_orders(orders)
    return {
        "status": "success",
        "orders": orders,
        "department_scope": allowed,
        "active_department": scope,
    }


@fastapi_app.get("/api/lab/orders/completed")
def get_completed_lab_orders(
    request: _Request,
    hospital_id: Optional[str] = None,
    department: Optional[str] = None,
    limit: int = 50,
):
    """Processed cases, with their report attached — powers the lab's Completed tab."""
    network_lab_id = network_lab_id_for_session(request)
    if network_lab_id:
        clauses = ["status = 'completed'", "network_lab_id = ?"]
        params: list = [network_lab_id]
        params.append(max(1, min(limit, 200)))
        orders = local_query(
            f"SELECT * FROM test_orders WHERE {' AND '.join(clauses)} "
            "ORDER BY completed_at DESC LIMIT ?",
            tuple(params)
        )
        orders = merge_patients_for_orders(orders)
        report_ids = [o["lab_report_id"] for o in orders if o.get("lab_report_id")]
        if report_ids:
            placeholders = ",".join(["?"] * len(report_ids))
            reports = local_query(
                f"SELECT id, risk_score, atlas_analysis, atlas_confidence, document_id, submitted_at, abnormal_fields "
                f"FROM lab_reports WHERE id IN ({placeholders})",
                report_ids
            )
            rmap = {r["id"]: r for r in reports}
            for o in orders:
                r = rmap.get(o.get("lab_report_id"))
                if r and isinstance(r.get("abnormal_fields"), str):
                    try:
                        r["abnormal_fields"] = json.loads(r["abnormal_fields"])
                    except Exception:
                        r["abnormal_fields"] = []
                o["report"] = r
        return {"status": "success", "orders": orders}

    allowed = lab_department_for_session(request)
    scope = allowed if allowed != lab_catalog.ALL_DEPARTMENTS else department

    clauses = ["status = 'completed'"]
    params: list = []
    if hospital_id:
        clauses.append("hospital_id = ?")
        params.append(get_valid_hospital_id(hospital_id))
    if scope and scope != lab_catalog.ALL_DEPARTMENTS:
        clauses.append("COALESCE(department, 'pathology') = ?")
        params.append(scope)

    params.append(max(1, min(limit, 200)))
    orders = local_query(
        f"SELECT * FROM test_orders WHERE {' AND '.join(clauses)} "
        "ORDER BY completed_at DESC LIMIT ?",
        tuple(params)
    )
    orders = merge_patients_for_orders(orders)

    report_ids = [o["lab_report_id"] for o in orders if o.get("lab_report_id")]
    if report_ids:
        placeholders = ",".join(["?"] * len(report_ids))
        reports = local_query(
            f"SELECT id, risk_score, atlas_analysis, atlas_confidence, document_id, submitted_at, abnormal_fields "
            f"FROM lab_reports WHERE id IN ({placeholders})",
            report_ids
        )
        rmap = {r["id"]: r for r in reports}
        for o in orders:
            r = rmap.get(o.get("lab_report_id"))
            if r and isinstance(r.get("abnormal_fields"), str):
                try:
                    r["abnormal_fields"] = json.loads(r["abnormal_fields"])
                except Exception:
                    r["abnormal_fields"] = []
            o["report"] = r

    return {"status": "success", "orders": orders}

@fastapi_app.get("/api/lab/orders/pending-payment")
def get_pending_payment_orders(hospital_id: Optional[str] = None):
    # Returns all test orders pending payment from local SQLite
    if hospital_id:
        hospital_id = get_valid_hospital_id(hospital_id)
        orders = local_query(
            "SELECT * FROM test_orders WHERE payment_status = 'pending' AND hospital_id = ?",
            (hospital_id,)
        )
    else:
        orders = local_query("SELECT * FROM test_orders WHERE payment_status = 'pending'")
        
    orders = merge_patients_for_orders(orders)
    return {"status": "success", "orders": orders}

async def _settle_order_payment(order_id: str, amount: Optional[float], paid_by: str) -> dict:
    """Move a paid order out of the payment gate and into its department queue.

    Shared by the patient's phone payment and the receptionist's counter payment
    so both produce identical downstream state.
    """
    existing = local_query("SELECT * FROM test_orders WHERE id = ?", (order_id,))
    if not existing:
        return {"status": "error", "message": "Order not found"}

    order = existing[0]
    if order.get("payment_status") == "confirmed":
        # Idempotent: a double-tap on the pay button must not re-queue the order.
        return {
            "status": "success",
            "already_paid": True,
            "queue_position": order.get("queue_position") or 0,
            "order_id": order_id,
        }

    # Trust the catalog price over a client-supplied amount.
    charge = order.get("price") or amount or 0.0

    # Paid, but not yet in the lab's queue. The patient still has to physically
    # walk to the lab that runs this test — reception checks them in there (see
    # /api/lab/orders/{id}/arrive), and only then does the order become work.
    local_execute(
        "UPDATE test_orders SET payment_status = 'confirmed', payment_amount = ?, "
        "status = 'awaiting_arrival', paid_at = ?, paid_by = ? WHERE id = ?",
        (charge, datetime.utcnow().isoformat(), paid_by, order_id)
    )
    queue_pos = 0

    order = merge_patients_for_orders(
        local_query("SELECT * FROM test_orders WHERE id = ?", (order_id,))
    )[0]
    patient_name = order["patients"]["name"] if order.get("patients") else "Patient"
    patient_id = order["patient_id"]
    department = order.get("department") or "pathology"

    # Reception needs this on the arrivals board; the lab does not see it yet.
    await sio.emit("payment_confirmed", {
        "order_id": order_id,
        "patient_name": patient_name,
        "tests": [order["test_type"]],
        "department": department,
        "awaiting_arrival": True,
        "paid_by": paid_by,
    })

    await sio.emit("test_payment_confirmed", {
        "patient_id": patient_id,
        "tests": [order["test_type"]],
        "department": department,
        "awaiting_arrival": True,
        "message": f"Payment confirmed. Please report to the {department} lab to be checked in.",
    })

    return {
        "status": "success",
        "queue_position": queue_pos,
        "awaiting_arrival": True,
        "order_id": order_id,
        "department": department,
        "amount": charge,
        "message": f"Payment confirmed. Send the patient to the {department} lab for check-in.",
    }


@fastapi_app.get("/api/lab/orders/awaiting-arrival")
def get_orders_awaiting_arrival(hospital_id: Optional[str] = None, department: Optional[str] = None):
    """Paid tests whose patient has not yet been checked in at the lab.

    This is reception's arrivals board: the patient walks up to the blood-test
    lab, reception finds them here and marks them arrived.
    """
    clauses = ["status = 'awaiting_arrival'"]
    params: list = []
    if hospital_id:
        clauses.append("hospital_id = ?")
        params.append(get_valid_hospital_id(hospital_id))
    if department and department != lab_catalog.ALL_DEPARTMENTS:
        clauses.append("COALESCE(department, 'pathology') = ?")
        params.append(department)

    orders = local_query(
        f"SELECT * FROM test_orders WHERE {' AND '.join(clauses)} ORDER BY paid_at ASC",
        tuple(params)
    )
    return {"status": "success", "orders": merge_patients_for_orders(orders)}


@fastapi_app.post("/api/lab/orders/{order_id}/arrive")
async def mark_patient_arrived_at_lab(order_id: str, data: dict = None):
    """The patient is physically at the lab — release the order into its queue.

    Until this fires the lab has no reason to see the order: the sample cannot
    be drawn from a patient who is still at the counter.
    """
    data = data or {}
    rows = local_query("SELECT * FROM test_orders WHERE id = ?", (order_id,))
    if not rows:
        return {"status": "error", "message": "Order not found"}

    order = rows[0]
    if order.get("payment_status") != "confirmed":
        return {"status": "error", "message": "This test has not been paid for yet"}
    if order.get("status") not in ("awaiting_arrival",):
        # Idempotent: a second tap on Arrived must not reshuffle the queue.
        return {
            "status": "success",
            "already_arrived": True,
            "queue_position": order.get("queue_position") or 0,
            "order_id": order_id,
        }

    # Status first: _assign_queue_position counts everything already queued for
    # this department, and this order has to be one of them or the first patient
    # of the day comes out as #0.
    local_execute(
        "UPDATE test_orders SET status = 'payment_confirmed', arrived_at = ?, arrived_by = ? WHERE id = ?",
        (datetime.utcnow().isoformat(), (data.get("arrived_by") or "Reception"), order_id)
    )
    queue_pos = _assign_queue_position(order_id)

    order = merge_patients_for_orders(
        local_query("SELECT * FROM test_orders WHERE id = ?", (order_id,))
    )[0]
    patient_name = order["patients"]["name"] if order.get("patients") else "Patient"
    department = order.get("department") or "pathology"

    # Now the lab hears about it, with everything it needs to run the test.
    await sio.emit("lab_order_arrived", {
        "order_id": order_id,
        "patient_id": order["patient_id"],
        "patient_name": patient_name,
        "test_type": order.get("test_type"),
        "department": department,
        "queue_position": queue_pos,
        "priority": order.get("priority"),
    })
    await sio.emit("queue_updated", {"department": department})
    await sio.emit("test_patient_arrived", {
        "patient_id": order["patient_id"],
        "department": department,
        "queue_position": queue_pos,
        "message": f"Checked in at the {department} lab. You are #{queue_pos} in the queue.",
    })

    return {
        "status": "success",
        "order_id": order_id,
        "department": department,
        "queue_position": queue_pos,
        "patient_name": patient_name,
    }


@fastapi_app.get("/api/patient/{patient_id}/pending-payments")
def get_patient_pending_payments(patient_id: str):
    """Test requests waiting on the patient's phone.

    Only patient-billed orders appear here — an admitted patient's tests are on
    their admission bill and are deliberately excluded.
    """
    orders = local_query(
        "SELECT * FROM test_orders WHERE patient_id = ? AND payment_status = 'pending' "
        "AND COALESCE(billing_mode, 'patient') = 'patient' AND status != 'cancelled' "
        "ORDER BY ordered_at DESC",
        (patient_id,)
    )
    for o in orders:
        if isinstance(o.get("specific_tests"), str):
            try:
                o["specific_tests"] = json.loads(o["specific_tests"])
            except Exception:
                pass
        if not o.get("price"):
            o["price"] = lab_catalog.price_for(o.get("test_type") or "")

    return {
        "status": "success",
        "orders": orders,
        "total_due": round(sum(o.get("price") or 0 for o in orders), 2),
    }


@fastapi_app.post("/api/lab/orders/{order_id}/pay")
async def patient_pay_for_test(order_id: str, data: dict = None):
    """Patient pays for their own test from their dashboard.

    Payment itself is simulated for now — the surrounding flow (amount set from
    the catalog at order time, order released to the lab only once paid) is the
    real part, so dropping a gateway in later means changing only this handler.
    """
    data = data or {}
    return await _settle_order_payment(order_id, data.get("amount"), paid_by="patient")


@fastapi_app.post("/api/lab/orders/pay")
async def pay_for_tests(data: dict):
    """Pay for several selected tests in one go.

    A doctor usually orders a panel, not a single test, and the patient picks
    which of them to pay for now. Each order is settled independently so a
    failure on one does not silently swallow the others.
    """
    order_ids = data.get("order_ids") or []
    if not order_ids:
        return {"status": "error", "message": "Select at least one test"}

    paid_by = data.get("paid_by") or "patient"
    results, failed = [], []
    for oid in order_ids:
        res = await _settle_order_payment(oid, None, paid_by=paid_by)
        if res.get("status") == "success":
            results.append(res)
        else:
            failed.append({"order_id": oid, "message": res.get("message")})

    return {
        "status": "success" if results else "error",
        "paid": results,
        "failed": failed,
        "total_paid": round(sum(r.get("amount") or 0 for r in results), 2),
        "departments": sorted({r.get("department") for r in results if r.get("department")}),
        "message": (
            f"Paid for {len(results)} test(s). Report to the lab to be checked in."
            if results else "None of the selected tests could be paid for"
        ),
    }


@fastapi_app.post("/api/lab/orders/pay-at-counter")
async def defer_payment_to_counter(data: dict):
    """The patient chooses to pay cash at the desk instead of on their phone.

    Nothing is charged here — the orders stay in the pending-payment list that
    reception already works from. This only records the choice, so reception can
    see who is walking up to the counter and the patient's screen stops nagging.
    """
    order_ids = data.get("order_ids") or []
    if not order_ids:
        return {"status": "error", "message": "Select at least one test"}

    now = datetime.utcnow().isoformat()
    updated = []
    for oid in order_ids:
        rows = local_query("SELECT * FROM test_orders WHERE id = ?", (oid,))
        if not rows or rows[0].get("payment_status") == "confirmed":
            continue
        local_execute(
            "UPDATE test_orders SET payment_intent = 'counter', payment_intent_at = ? WHERE id = ?",
            (now, oid)
        )
        updated.append(oid)

    if not updated:
        return {"status": "error", "message": "Those tests are no longer awaiting payment"}

    orders = merge_patients_for_orders(
        local_query(
            f"SELECT * FROM test_orders WHERE id IN ({','.join('?' * len(updated))})",
            tuple(updated)
        )
    )
    patient_name = orders[0]["patients"]["name"] if orders and orders[0].get("patients") else "Patient"

    await sio.emit("payment_at_counter_requested", {
        "patient_id": orders[0]["patient_id"] if orders else None,
        "patient_name": patient_name,
        "order_ids": updated,
        "tests": [o.get("test_type") for o in orders],
        "total": round(sum(o.get("price") or 0 for o in orders), 2),
    })

    return {
        "status": "success",
        "order_ids": updated,
        "message": f"{len(updated)} test(s) held for counter payment. Please pay at the reception desk.",
    }


@fastapi_app.post("/api/lab/orders/{order_id}/payment")
async def confirm_test_payment(order_id: str, data: dict):
    """Receptionist collects at the counter — the fallback for patients who
    can't or won't pay on their phone."""
    return await _settle_order_payment(order_id, data.get("amount"), paid_by="reception")

@fastapi_app.patch("/api/lab/orders/{order_id}/cancel")
async def cancel_test_order(order_id: str, data: dict = None):
    """Void a test order before it reaches the lab.

    Only allowed while the order is still waiting on payment — once a sample
    has arrived and the lab has accepted/started it, cancelling would orphan
    work already in progress, so that has to go through the lab instead.
    """
    data = data or {}
    rows = local_query("SELECT * FROM test_orders WHERE id = ?", (order_id,))
    if not rows:
        return {"status": "error", "message": "Order not found"}

    order = rows[0]
    if order.get("status") not in ("pending", "payment_pending", None) and \
       order.get("payment_status") not in ("pending",):
        return {
            "status": "error",
            "message": "This test has already been paid for or is with the lab and can no longer be cancelled.",
        }

    now = datetime.utcnow().isoformat()
    local_execute(
        "UPDATE test_orders SET status = 'cancelled', payment_status = 'cancelled', "
        "cancelled_at = ?, cancelled_by = ? WHERE id = ?",
        (now, data.get("cancelled_by") or "receptionist", order_id)
    )

    payload = {
        "patient_id": order["patient_id"],
        "patient_name": lookup_patient_name(order["patient_id"]),
        "order_id": order_id,
        "test_type": order.get("test_type"),
        "status": "cancelled",
    }
    await sio.emit("queue_updated", payload)
    await sio.emit("test_status_update", payload)

    return {"status": "success", "order_id": order_id}


@fastapi_app.patch("/api/lab/orders/{order_id}/route")
async def route_test_order(order_id: str, data: dict):
    """Redirect an order from the hospital's own department to an independent
    network lab (patient or doctor picking a different lab — plan Phase 4).

    Only allowed before payment: once the hospital (or the previous lab) has
    collected money for it, re-routing would split the charge across two
    parties with no ledger to reconcile them, so the order has to be
    cancelled and re-ordered instead. Billing resets to self-pay per the
    plan's decision #2 — an independent lab is never billed to a hospital
    admission.
    """
    network_lab_id = data.get("network_lab_id")
    if not network_lab_id:
        return {"status": "error", "message": "network_lab_id is required"}

    rows = local_query("SELECT * FROM test_orders WHERE id = ?", (order_id,))
    if not rows:
        return {"status": "error", "message": "Order not found"}
    order = rows[0]
    if order.get("payment_status") not in ("pending", None):
        return {
            "status": "error",
            "message": "This test has already been paid for and can no longer be re-routed. Cancel it and re-order instead.",
        }

    lab_check = supabase.table("network_labs").select("id, name").eq("id", network_lab_id).execute()
    if not lab_check.data:
        return {"status": "error", "message": "That lab is not on the Vela network"}
    lab_name = lab_check.data[0]["name"]

    overrides = network_lab_catalog_overrides(network_lab_id)
    override = overrides.get((order.get("test_type") or "").strip().lower())
    price = float(override["price"]) if override and override.get("price") is not None else float(order.get("price") or 0)
    department = override["department"] if override and override.get("department") else order.get("department")

    # hospital_id cleared: this order is no longer the hospital's financial or
    # queue responsibility, so every hospital_id-scoped query (receptionist's
    # pending-payment list, the hospital's own lab queue) naturally stops
    # showing it. The patient-scoped and doctor-visible views are unaffected —
    # they were never hospital_id-filtered.
    local_execute(
        "UPDATE test_orders SET network_lab_id = ?, fulfilled_by = 'network_lab', "
        "hospital_id = NULL, department = ?, price = ?, billing_mode = 'patient', "
        "payment_status = 'pending', status = 'pending' WHERE id = ?",
        (network_lab_id, department, price, order_id)
    )

    row = merge_patients_for_orders(local_query("SELECT * FROM test_orders WHERE id = ?", (order_id,)))[0]
    await sio.emit("queue_updated", {
        "patient_id": order["patient_id"],
        "order_id": order_id,
        "network_lab_id": network_lab_id,
        "lab_name": lab_name,
        "status": "routed",
    })

    return {"status": "success", "order": row, "lab_name": lab_name}


@fastapi_app.post("/api/lab/orders/{order_id}/accept")
async def accept_test_order(order_id: str):
    accepted_at = datetime.utcnow().isoformat()
    local_execute(
        "UPDATE test_orders SET status = 'accepted', accepted_at = ? WHERE id = ?",
        (accepted_at, order_id)
    )
    
    orders = local_query("SELECT * FROM test_orders WHERE id = ?", (order_id,))
    if orders:
        order = orders[0]
        payload = {
            "patient_id": order["patient_id"],
            "patient_name": lookup_patient_name(order["patient_id"]),
            "status": "accepted",
            "message": "Lab has accepted your test. You will be called shortly."
        }
        await sio.emit("test_status_update", payload)
        await sio.emit("lab_update", payload)
        return {"status": "success", "order": order}

    return {"status": "error", "message": "Order not found"}

@fastapi_app.post("/api/lab/orders/{order_id}/start")
async def start_test_order(order_id: str):
    started_at = datetime.utcnow().isoformat()
    local_execute(
        "UPDATE test_orders SET status = 'in_progress', started_at = ? WHERE id = ?",
        (started_at, order_id)
    )
    
    orders = local_query("SELECT * FROM test_orders WHERE id = ?", (order_id,))
    if orders:
        order = orders[0]
        payload = {
            "patient_id": order["patient_id"],
            "patient_name": lookup_patient_name(order["patient_id"]),
            "status": "in_progress",
            "message": "Your test has started. Results will be ready soon."
        }
        await sio.emit("test_status_update", payload)
        await sio.emit("lab_update", payload)
        return {"status": "success", "order": order}
        
    return {"status": "error", "message": "Order not found"}

# Report formats now live in lab_catalog.TEST_CATALOG (built-ins) and the
# lab_templates table (each hospital's own formats). See /api/lab/template/{test_type}.

@fastapi_app.get("/api/lab/template/{test_type}")
def get_lab_template(test_type: str, hospital_id: Optional[str] = None, network_lab_id: Optional[str] = None):
    """The result-entry form for a test.

    A hospital's own saved format wins over the built-in catalog template, so a
    lab that has defined its own blood-report layout gets its layout. An
    independent lab's own format is looked up the same way, keyed by
    network_lab_id instead — the two scopes never mix.
    """
    if network_lab_id:
        rows = local_query(
            "SELECT * FROM lab_templates WHERE LOWER(test_type) = LOWER(?) "
            "AND network_lab_id = ? LIMIT 1",
            (test_type, network_lab_id)
        )
    else:
        rows = local_query(
            "SELECT * FROM lab_templates WHERE LOWER(test_type) = LOWER(?) "
            "ORDER BY CASE WHEN hospital_id = ? THEN 0 ELSE 1 END LIMIT 1",
            (test_type, get_valid_hospital_id(hospital_id))
        )
    if rows:
        row = rows[0]
        try:
            fields = json.loads(row.get("fields") or "[]")
        except Exception:
            fields = []
        if fields:
            return {
                "test_type": row["test_type"],
                "fields": fields,
                "department": row.get("department"),
                "source": "custom",
                "template_id": row["id"],
                "instructions": row.get("instructions") or "Fill all values",
            }

    builtin = lab_catalog.builtin_template(test_type)
    if builtin:
        resolved = lab_catalog.resolve_test(test_type)
        return {
            "test_type": resolved["test_type"],
            "fields": builtin["fields"],
            "department": builtin["department"],
            "source": "catalog",
            "instructions": "Fill all values",
        }

    return {
        "test_type": test_type,
        "fields": lab_catalog.UNKNOWN_TEST_DEFAULT["fields"],
        "department": lab_catalog.UNKNOWN_TEST_DEFAULT["department"],
        "source": "generic",
        "instructions": (
            "No saved format for this test. Fill what applies, or define a "
            "reusable format for it under Lab Settings → Report Formats."
        ),
    }


@fastapi_app.get("/api/lab/templates")
def list_lab_templates(hospital_id: Optional[str] = None, department: Optional[str] = None, network_lab_id: Optional[str] = None):
    """Every report format available to this lab — catalog built-ins plus custom."""
    clauses, params = [], []
    if network_lab_id:
        clauses.append("network_lab_id = ?")
        params.append(network_lab_id)
    elif hospital_id:
        clauses.append("hospital_id = ?")
        params.append(get_valid_hospital_id(hospital_id))
    if department and department != lab_catalog.ALL_DEPARTMENTS:
        clauses.append("department = ?")
        params.append(department)

    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    custom = local_query(f"SELECT * FROM lab_templates {where} ORDER BY test_type", tuple(params))
    for row in custom:
        try:
            row["fields"] = json.loads(row.get("fields") or "[]")
        except Exception:
            row["fields"] = []
        row["source"] = "custom"

    custom_names = {r["test_type"].lower() for r in custom}
    builtins = []
    for name, entry in lab_catalog.TEST_CATALOG.items():
        if name.lower() in custom_names:
            continue  # overridden by this hospital's own format
        if department and department != lab_catalog.ALL_DEPARTMENTS and entry["department"] != department:
            continue
        builtins.append({
            "id": f"builtin:{name}",
            "test_type": name,
            "department": entry["department"],
            "sample_type": entry["sample_type"],
            "price": entry["price"],
            "tat_minutes": entry["tat_minutes"],
            "fields": entry["fields"],
            "source": "catalog",
        })

    return {
        "status": "success",
        "templates": sorted(custom + builtins, key=lambda t: (t.get("department") or "", t["test_type"])),
    }


def _clean_template_fields(fields: list) -> list:
    """Normalize a submitted field list; drops entries without a name."""
    cleaned = []
    for f in fields or []:
        name = (f.get("name") or "").strip()
        if not name:
            continue
        is_text = bool(f.get("text_field"))
        entry = {"name": name, "unit": (f.get("unit") or "").strip(), "text_field": is_text}
        if is_text:
            entry["normal_min"] = 0
            entry["normal_max"] = 0
        else:
            try:
                entry["normal_min"] = float(f.get("normal_min", 0) or 0)
                entry["normal_max"] = float(f.get("normal_max", 0) or 0)
            except (TypeError, ValueError):
                entry["normal_min"], entry["normal_max"] = 0.0, 0.0
        cleaned.append(entry)
    return cleaned


@fastapi_app.post("/api/lab/templates")
async def create_lab_template(data: dict):
    """Save a lab's own report format so it can be reused on future orders."""
    test_type = (data.get("test_type") or "").strip()
    fields = _clean_template_fields(data.get("fields"))
    if not test_type:
        return {"status": "error", "message": "Test name is required"}
    if not fields:
        return {"status": "error", "message": "Add at least one named field"}

    network_lab_id = (data.get("network_lab_id") or "").strip() or None
    hospital_id = None if network_lab_id else get_valid_hospital_id(data.get("hospital_id"))
    department = (data.get("department") or "").strip().lower()
    if department not in lab_catalog.DEPARTMENT_IDS:
        department = lab_catalog.department_for(test_type)

    if network_lab_id:
        existing = local_query(
            "SELECT id FROM lab_templates WHERE network_lab_id = ? AND LOWER(test_type) = LOWER(?)",
            (network_lab_id, test_type)
        )
    else:
        existing = local_query(
            "SELECT id FROM lab_templates WHERE hospital_id = ? AND LOWER(test_type) = LOWER(?)",
            (hospital_id, test_type)
        )
    now = datetime.utcnow().isoformat()
    payload = (
        test_type, department, (data.get("sample_type") or "").strip() or None,
        float(data.get("price") or lab_catalog.price_for(test_type)),
        int(data.get("tat_minutes") or 60),
        json.dumps(fields), (data.get("instructions") or "").strip(), now,
    )

    if existing:
        template_id = existing[0]["id"]
        local_execute(
            "UPDATE lab_templates SET test_type = ?, department = ?, sample_type = ?, price = ?, "
            "tat_minutes = ?, fields = ?, instructions = ?, updated_at = ? WHERE id = ?",
            payload + (template_id,)
        )
    else:
        template_id = str(uuid.uuid4())
        local_execute(
            "INSERT INTO lab_templates (id, hospital_id, network_lab_id, test_type, department, sample_type, price, "
            "tat_minutes, fields, instructions, updated_at, created_by, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (template_id, hospital_id, network_lab_id) + payload + ((data.get("created_by") or "Lab"), now)
        )

    await sio.emit("lab_template_updated", {"template_id": template_id, "test_type": test_type,
                                            "department": department})
    return {"status": "success", "template_id": template_id, "department": department}


@fastapi_app.delete("/api/lab/templates/{template_id}")
async def delete_lab_template(template_id: str):
    if template_id.startswith("builtin:"):
        return {"status": "error", "message": "Built-in catalog formats cannot be deleted"}
    local_execute("DELETE FROM lab_templates WHERE id = ?", (template_id,))
    await sio.emit("lab_template_updated", {"template_id": template_id, "deleted": True})
    return {"status": "success"}

@fastapi_app.post("/api/lab/reports/submit")
async def submit_lab_report(data: dict):
    """The lab technician commits results.

    Beyond saving the row, this renders the report to a PDF and files it into the
    patient's `documents` record + RAG. That last step is what lets a patient walk
    into any VELA doctor afterwards and have Atlas already know the results.
    """
    test_order_id = data.get("test_order_id")
    patient_id = data.get("patient_id")
    test_type = data.get("test_type")
    test_category = data.get("test_category")
    values = data.get("values", {}) or {}
    normal_ranges = data.get("normal_ranges", {}) or {}
    units = data.get("units", {}) or {}
    lab_notes = data.get("lab_notes", "")
    technician = data.get("doctor_name") or data.get("technician") or "Lab Technician"

    order_rows = local_query("SELECT * FROM test_orders WHERE id = ?", (test_order_id,)) if test_order_id else []
    order = order_rows[0] if order_rows else {}
    department = (data.get("department") or order.get("department")
                  or lab_catalog.department_for(test_type or ""))
    hospital_id = order.get("hospital_id")
    network_lab_id = order.get("network_lab_id")
    ordered_by = order.get("doctor_name") or ""

    def _facility_name() -> str:
        # An independent lab isn't a hospital — the PDF header should say so,
        # not fall back to the generic "VELA Partner Hospital" label.
        if network_lab_id:
            try:
                res = supabase.table("network_labs").select("name").eq("id", network_lab_id).execute()
                if res.data:
                    return res.data[0].get("name") or "Independent Lab"
            except Exception:
                pass
            return "Independent Lab"
        return fetch_hospital_name(hospital_id)

    # STEP 1: Classify every value against its reference range.
    classified = vela_documents.classify_values(values, normal_ranges)
    numeric = [c for c in classified if c["status"] != "text"]
    abnormal = [c for c in numeric if c["status"] in ("abnormal", "critical")]
    critical = [c for c in numeric if c["status"] == "critical"]
    abnormal_fields = [c["field"] for c in abnormal]
    flagged_lines = vela_documents.abnormal_summary_lines(classified)

    risk_score = (
        min(100, int((len(abnormal) / len(numeric) * 50) + (len(critical) * 10)))
        if numeric else 0
    )

    # STEP 2: Atlas interpretation.
    values_text = "\n".join(
        f"{c['field']}: {c['value']} (normal: {c['min']}-{c['max']}, {c['status']})"
        if c["status"] != "text" else f"{c['field']}: {c['value']}"
        for c in classified
    )
    atlas_text, confidence = "", "MEDIUM"
    try:
        atlas_response = await asyncio.to_thread(
            lambda: openai_client.chat.completions.create(
                model="gpt-4o",
                messages=[{
                    "role": "system",
                    "content": f"""Analyze these lab results for a patient.
Test: {test_type}
Values: {values_text}

Give a 3 sentence analysis:
1. Overall status
2. Most abnormal finding
3. Clinical recommendation
Be direct. Flag urgency. End with [HIGH], [MEDIUM], or [LOW] confidence marker."""
                }],
                max_tokens=200,
                temperature=0.3
            )
        )
        atlas_text = atlas_response.choices[0].message.content.strip()
        if "[HIGH]" in atlas_text:
            confidence = "HIGH"
        elif "[LOW]" in atlas_text:
            confidence = "LOW"
        atlas_text = atlas_text.replace("[HIGH]", "").replace("[LOW]", "").replace("[MEDIUM]", "").strip()
    except Exception as e:
        # A failed interpretation must never lose the technician's entered results.
        print(f"⚠️ Atlas interpretation failed for {test_type}: {e}")
        atlas_text = (
            f"{len(abnormal)} of {len(numeric)} measured parameters fall outside their reference range."
            if numeric else "Results recorded."
        )

    submitted_at = datetime.utcnow().isoformat()
    report_id = str(uuid.uuid4())

    # STEP 3: Save the report row.
    local_execute(
        """INSERT INTO lab_reports (
            id, test_order_id, patient_id, doctor_name, test_type, test_category,
            department, values_json, normal_ranges, report_status, lab_notes, submitted_at,
            atlas_analysis, atlas_confidence, risk_score, abnormal_fields
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            report_id, test_order_id, patient_id, technician, test_type, test_category,
            department, json.dumps(values), json.dumps(normal_ranges), "completed", lab_notes,
            submitted_at, atlas_text, confidence, risk_score, json.dumps(abnormal_fields)
        )
    )

    # STEP 4: Close the order.
    local_execute(
        "UPDATE test_orders SET status = 'completed', completed_at = ?, lab_report_id = ? WHERE id = ?",
        (submitted_at, report_id, test_order_id)
    )

    # STEP 5: Render the PDF and file it as a permanent document + RAG memory.
    patient = fetch_patient_record(patient_id)
    patient_name = patient.get("name") or "Patient"
    document_id, pdf_path = None, None
    try:
        pdf_path, report_text = await bg_run(
            vela_documents.render_lab_report_pdf,
            report_id=report_id,
            patient=patient,
            test_type=test_type,
            department=department,
            values=values,
            normal_ranges=normal_ranges,
            units=units,
            lab_notes=lab_notes,
            technician=technician,
            ordered_by=ordered_by,
            atlas_analysis=atlas_text,
            risk_score=risk_score,
            hospital_name=_facility_name(),
            submitted_at=submitted_at,
        )
        document_id = await file_generated_document(
            patient_id=patient_id,
            filename=f"{test_type} Report — {datetime.utcnow().strftime('%d %b %Y')}.pdf",
            raw_text=report_text,
            pdf_path=pdf_path,
            kind="lab_report",
            source_id=report_id,
            summary_values=[
                {"name": c["field"], "value": c["value"], "status": c["status"],
                 "normal_min": c["min"], "normal_max": c["max"]}
                for c in classified if c["status"] != "text"
            ],
            critical_flags=flagged_lines,
            risk_score=risk_score,
        )
        local_execute(
            "UPDATE lab_reports SET document_id = ?, pdf_path = ? WHERE id = ?",
            (document_id, pdf_path, report_id)
        )
    except Exception as e:
        # The results are already saved; a PDF/filing failure is degraded, not fatal.
        print(f"⚠️ Failed to generate/file lab report document for {report_id}: {e}")

    # STEP 6: Update the patient's headline analysis.
    try:
        supabase.table("patients").update({
            "atlas_analysis": atlas_text,
            "atlas_confidence": confidence,
            "atlas_analysis_updated_at": submitted_at,
            "risk_score": risk_score
        }).eq("id", patient_id).execute()
    except Exception as e:
        print(f"⚠️ Failed to update patient analysis after lab report: {e}")

    # STEP 7: Notify everyone waiting on this.
    common = {
        "patient_id": patient_id,
        "patient_name": patient_name,
        "test_type": test_type,
        "department": department,
        "report_id": report_id,
        "document_id": document_id,
        "risk_score": risk_score,
        "atlas_analysis": atlas_text,
        "confidence": confidence,
        "abnormal_fields": abnormal_fields,
    }

    await sio.emit("report_ready", {
        **common,
        "message": f"Your {test_type} report is ready. Risk score: {risk_score}.",
    })
    await sio.emit("report_submitted", common)
    await sio.emit("lab_report_submitted", common)
    await sio.emit("queue_updated", {"department": department})

    if risk_score > 70:
        await sio.emit("risk_alert", {
            "patient_id": patient_id,
            "patient_name": patient_name,
            "risk_score": risk_score,
            "source": "lab_report",
            "test_type": test_type,
        })

    return {
        "status": "success",
        "report_id": report_id,
        "document_id": document_id,
        "risk_score": risk_score,
        "abnormal_fields": abnormal_fields,
        "pdf_url": f"/api/documents/{document_id}/file" if document_id else None,
    }

# ── VISIT REPORT (THE DOCUMENT THE PATIENT WALKS OUT WITH) ────────────────────

def _collect_visit_abnormalities(patient_id: str, limit: int = 8) -> list:
    """AI-flagged abnormal findings from everything on file for this patient.

    Pulls from two places: results VELA's own lab produced (exact, structured)
    and critical flags parsed out of documents the patient uploaded.
    """
    findings: list[str] = []

    reports = local_query(
        "SELECT test_type, values_json, normal_ranges, submitted_at FROM lab_reports "
        "WHERE patient_id = ? ORDER BY submitted_at DESC LIMIT 5",
        (patient_id,)
    )
    for r in reports:
        try:
            values = json.loads(r.get("values_json") or "{}")
            ranges = json.loads(r.get("normal_ranges") or "{}")
        except Exception:
            continue
        classified = vela_documents.classify_values(values, ranges)
        for line in vela_documents.abnormal_summary_lines(classified):
            findings.append(f"{line} [{r.get('test_type')}]")

    # Documents VELA generated itself are excluded. A visit report is filed with
    # its own findings as critical_flags, so reading them back would make each
    # visit re-inherit the last one's list and nest its source annotations. The
    # authoritative sources are the lab reports above and the patient's own
    # uploads, both of which are still read.
    generated = {
        row["document_id"]
        for row in local_query("SELECT document_id FROM generated_files WHERE patient_id = ?", (patient_id,))
        if row.get("document_id")
    }

    try:
        docs = (
            supabase.table("documents")
            .select("id, filename, critical_flags")
            .eq("patient_id", patient_id)
            .order("report_date", desc=True)
            .limit(12)
            .execute()
        )
        for d in docs.data or []:
            if d.get("id") in generated:
                continue
            for flag in (d.get("critical_flags") or []):
                if isinstance(flag, str) and flag.strip() and "NEEDS DOCTOR REVIEW" not in flag:
                    findings.append(f"{flag.strip()} [{d.get('filename')}]")
    except Exception as e:
        print(f"⚠️ Could not read document flags for visit report: {e}")

    # De-duplicate on the finding itself, ignoring the trailing [source] tag, so
    # the same abnormality reported by two documents is listed once — from the
    # most recent source, since findings arrive newest-first.
    seen, unique = set(), []
    for f in findings:
        key = f.rsplit("[", 1)[0].strip().lower()
        if key in seen:
            continue
        seen.add(key)
        unique.append(f)
    return unique[:limit]


async def build_visit_report(
    *,
    patient_id: str,
    doctor_name: str = "",
    hospital_id: Optional[str] = None,
    diagnosis: str = "",
    chief_complaint: str = "",
    medications: Optional[list] = None,
    tests_ordered: Optional[list] = None,
    vitals: Optional[dict] = None,
    advice: str = "",
    follow_up: str = "",
    since_hours: int = 12,
) -> dict:
    """Generate and permanently file this visit's consultation record.

    Runs on every completed consult, including ones with no prescription and no
    tests — the record still carries the date, the vitals and any AI-flagged
    abnormalities, which is what makes it useful to the next doctor.
    """
    patient = fetch_patient_record(patient_id)
    visit_id = str(uuid.uuid4())
    now = datetime.utcnow()
    cutoff = (now - timedelta(hours=since_hours)).isoformat()

    # Medications prescribed during this visit, unless the caller passed them in.
    if medications is None:
        try:
            res = (
                supabase.table("medications")
                .select("name, dosage, frequency, notes, start_date")
                .eq("patient_id", patient_id)
                .gte("start_date", (now - timedelta(hours=since_hours)).date().isoformat())
                .execute()
            )
            medications = res.data or []
        except Exception as e:
            print(f"⚠️ Could not read medications for visit report: {e}")
            medications = []

    # Tests ordered during this visit.
    if tests_ordered is None:
        tests_ordered = local_query(
            "SELECT id, test_type, department, sample_type, status, price, billing_mode "
            "FROM test_orders WHERE patient_id = ? AND ordered_at >= ? ORDER BY ordered_at DESC",
            (patient_id, cutoff)
        )

    abnormalities = _collect_visit_abnormalities(patient_id)

    if not diagnosis:
        diagnosis = patient.get("diagnosis") or ""

    hospital_name = fetch_hospital_name(hospital_id)
    visit_date = now.isoformat()

    pdf_path, report_text = await bg_run(
        vela_documents.render_visit_report_pdf,
        visit_id=visit_id,
        patient=patient,
        doctor_name=doctor_name,
        visit_date=visit_date,
        diagnosis=diagnosis,
        chief_complaint=chief_complaint,
        medications=medications,
        tests_ordered=tests_ordered,
        abnormalities=abnormalities,
        vitals=vitals or {},
        advice=advice,
        follow_up=follow_up,
        hospital_name=hospital_name,
    )

    document_id = await file_generated_document(
        patient_id=patient_id,
        filename=f"Consultation Record — {now.strftime('%d %b %Y')}.pdf",
        raw_text=report_text,
        pdf_path=pdf_path,
        kind="visit_report",
        source_id=visit_id,
        critical_flags=abnormalities,
    )

    local_execute(
        """INSERT INTO visit_reports (
            id, patient_id, hospital_id, doctor_name, visit_date, diagnosis, chief_complaint,
            medications, tests_ordered, abnormalities, vitals, advice, follow_up,
            document_id, pdf_path, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            visit_id, patient_id, get_valid_hospital_id(hospital_id), doctor_name, visit_date,
            diagnosis, chief_complaint, json.dumps(medications), json.dumps(tests_ordered),
            json.dumps(abnormalities), json.dumps(vitals or {}), advice, follow_up,
            document_id, pdf_path, now.isoformat()
        )
    )

    # Back-link the orders so the report can be traced from any test.
    for t in tests_ordered:
        if t.get("id"):
            local_execute("UPDATE test_orders SET visit_id = ? WHERE id = ? AND visit_id IS NULL",
                          (visit_id, t["id"]))

    payload = {
        "visit_id": visit_id,
        "patient_id": patient_id,
        "document_id": document_id,
        "doctor_name": doctor_name,
        "medications_count": len(medications),
        "tests_count": len(tests_ordered),
        "abnormalities_count": len(abnormalities),
        "pdf_url": f"/api/documents/{document_id}/file" if document_id else None,
    }
    await sio.emit("visit_report_ready", {
        **payload,
        "message": "Your consultation record is ready in your dashboard.",
    })
    return payload


@fastapi_app.post("/api/visit-report/generate")
async def generate_visit_report(data: dict):
    patient_id = data.get("patient_id")
    if not patient_id:
        return {"status": "error", "message": "patient_id is required"}
    try:
        result = await build_visit_report(
            patient_id=patient_id,
            doctor_name=data.get("doctor_name") or "",
            hospital_id=data.get("hospital_id"),
            diagnosis=data.get("diagnosis") or "",
            chief_complaint=data.get("chief_complaint") or "",
            medications=data.get("medications"),
            tests_ordered=data.get("tests_ordered"),
            vitals=data.get("vitals"),
            advice=data.get("advice") or "",
            follow_up=data.get("follow_up") or "",
        )
        return {"status": "success", **result}
    except Exception as e:
        print(f"⚠️ Visit report generation failed for {patient_id}: {e}")
        return {"status": "error", "message": str(e)}


@fastapi_app.get("/api/visit-reports/{patient_id}")
def list_visit_reports(patient_id: str, limit: int = 25):
    rows = local_query(
        "SELECT * FROM visit_reports WHERE patient_id = ? ORDER BY created_at DESC LIMIT ?",
        (patient_id, max(1, min(limit, 100)))
    )
    for r in rows:
        for field in ("medications", "tests_ordered", "abnormalities", "vitals"):
            if isinstance(r.get(field), str):
                try:
                    r[field] = json.loads(r[field])
                except Exception:
                    r[field] = [] if field != "vitals" else {}
        r["pdf_url"] = f"/api/documents/{r['document_id']}/file" if r.get("document_id") else None
    return {"status": "success", "visit_reports": rows}


@fastapi_app.get("/api/documents/{document_id}/file")
def download_generated_document(document_id: str):
    """Serve a VELA-generated PDF (lab report or consultation record)."""
    rows = local_query("SELECT * FROM generated_files WHERE document_id = ?", (document_id,))
    if not rows or not rows[0].get("pdf_path"):
        return _JSONResponse(status_code=404,
                             content={"status": "error", "message": "No generated file for this document"})

    path = rows[0]["pdf_path"]
    # Never serve outside the generated-reports directory, whatever the DB holds.
    if os.path.realpath(path).startswith(os.path.realpath(vela_documents.REPORTS_DIR) + os.sep) is False \
            or not os.path.exists(path):
        return _JSONResponse(status_code=404,
                             content={"status": "error", "message": "File is no longer available"})

    return FileResponse(path, media_type="application/pdf", filename=rows[0].get("filename") or "report.pdf")


@fastapi_app.post("/api/reassess/request")
async def request_reassessment(data: dict):
    patient_id = data.get("patient_id")
    lab_report_id = data.get("lab_report_id")
    test_order_id = data.get("test_order_id")
    
    today = datetime.now().strftime("%Y-%m-%d")
    count = supabase.table("reassess_requests").select("id").eq("patient_id", patient_id).gte("requested_at", today).execute()
    
    if len(count.data) >= 3:
        return {"status": "error", "message": "Daily limit of 3 reassess requests reached."}
    
    result = supabase.table("reassess_requests").insert({
        "patient_id": patient_id,
        "test_order_id": test_order_id,
        "lab_report_id": lab_report_id,
        "status": "pending"
    }).execute()
    
    # Notify Doctor
    patient = supabase.table("patients").select("name").eq("id", patient_id).execute()
    patient_name = patient.data[0]["name"] if patient.data else "Patient"
    
    await sio.emit("reassess_requested", {
        "patient_id": patient_id,
        "patient_name": patient_name,
        "report_id": lab_report_id,
        "message": f"{patient_name} is requesting reassessment."
    })
    
    return {"status": "success", "requests_today": len(count.data) + 1}

@fastapi_app.get("/api/lab/patient/{patient_id}")
def get_patient_tests(patient_id: str):
    orders = local_query(
        "SELECT * FROM test_orders WHERE patient_id = ? ORDER BY ordered_at DESC",
        (patient_id,)
    )
    
    # Merge lab reports
    if orders:
        order_ids = [o["id"] for o in orders]
        placeholders = ",".join(["?"] * len(order_ids))
        reports = local_query(
            f"SELECT * FROM lab_reports WHERE test_order_id IN ({placeholders})",
            order_ids
        )
        # Parse JSON string values in lab reports
        for r in reports:
            if r.get("values_json") and isinstance(r["values_json"], str):
                try:
                    r["values"] = json.loads(r["values_json"])
                except Exception:
                    r["values"] = {}
            if r.get("normal_ranges") and isinstance(r["normal_ranges"], str):
                try:
                    r["normal_ranges"] = json.loads(r["normal_ranges"])
                except Exception:
                    r["normal_ranges"] = {}
                    
        report_map = {r["test_order_id"]: r for r in reports}
        for o in orders:
            rep = report_map.get(o["id"])
            o["lab_reports"] = [rep] if rep else []
            
            if o.get("specific_tests") and isinstance(o["specific_tests"], str):
                try:
                    o["specific_tests"] = json.loads(o["specific_tests"])
                except Exception:
                    pass
                    
    return {"status": "success", "orders": orders}

@fastapi_app.get("/api/lab/queue/{patient_id}")
def get_lab_queue_status(patient_id: str):
    # Get patient's pending/accepted orders from local SQLite
    orders = local_query(
        "SELECT * FROM test_orders WHERE patient_id = ? AND status IN ('payment_confirmed', 'accepted', 'in_progress')",
        (patient_id,)
    )
    
    if not orders:
        return {"status": "success", "queue_position": 0, "patients_before": 0, "estimated_wait": 0}
    
    my_order = orders[0]
    my_q_pos = my_order.get("queue_position", 999) or 999
    
    ahead = local_query(
        "SELECT id FROM test_orders WHERE status = 'payment_confirmed' AND queue_position < ?",
        (my_q_pos,)
    )
    count_ahead = len(ahead)
    
    return {
        "status": "success",
        "queue_position": count_ahead + 1,
        "patients_before": count_ahead,
        "estimated_wait": (count_ahead + 1) * 15 # 15 mins per test
    }

# --- ADMISSIONS FLOW ---

STATIC_ROOM_TYPES = [
    {"id": "rt-1", "name": "General Ward", "cost_per_day": 1200, "amenities": ["Shared Bathroom", "AC", "Meals Included"]},
    {"id": "rt-2", "name": "Semi-Private Room", "cost_per_day": 2500, "amenities": ["Semi-private Bathroom", "AC", "TV", "Meals Included"]},
    {"id": "rt-3", "name": "Private Room", "cost_per_day": 5000, "amenities": ["Private Bathroom", "AC", "TV", "Fridge", "Meals Included", "Extra Bed for Attendant"]},
    {"id": "rt-4", "name": "ICU Room", "cost_per_day": 10000, "amenities": ["24/7 Monitoring", "Ventilator Support", "Specialist Care Included"]}
]

def merge_relations_for_admissions(admissions):
    if not admissions:
        return []
    patient_ids = list(set([a["patient_id"] for a in admissions if a.get("patient_id")]))
    bed_ids = list(set([a["bed_id"] for a in admissions if a.get("bed_id")]))
    ward_ids = list(set([a["ward_id"] for a in admissions if a.get("ward_id")]))
    
    patient_map = {}
    bed_map = {}
    ward_map = {}
    
    if patient_ids:
        try:
            res = supabase.table("patients").select("*").in_("id", patient_ids).execute()
            patient_map = {p["id"]: p for p in res.data}
        except Exception as e:
            print("Error fetching patients for admissions:", e)
            
    if bed_ids:
        try:
            res = supabase.table("beds").select("*").in_("id", bed_ids).execute()
            bed_map = {b["id"]: b for b in res.data}
        except Exception as e:
            print("Error fetching beds for admissions:", e)
            
    if ward_ids:
        try:
            res = supabase.table("wards").select("*").in_("id", ward_ids).execute()
            ward_map = {w["id"]: w for w in res.data}
        except Exception as e:
            print("Error fetching wards for admissions:", e)
            
    for a in admissions:
        a["patients"] = patient_map.get(a.get("patient_id"))
        a["beds"] = bed_map.get(a.get("bed_id"))
        a["wards"] = ward_map.get(a.get("ward_id"))
    return admissions

@fastapi_app.post("/api/admissions/confirm")
async def confirm_admission(data: dict):
    patient_id = data.get("patient_id")
    bed_id = data.get("bed_id")
    ward_id = data.get("ward_id")
    ward_name = data.get("ward_name", "General")
    bed_number = data.get("bed_number", "00")
    room_type = data.get("room_type", "General Ward")
    admission_reason = data.get("admission_reason", "")
    diagnosis = data.get("diagnosis", "")
    recommended_by = data.get("recommended_by", "")
    admitted_by = data.get("admitted_by", "")
    
    # STEP 1 — Generate admission QR
    identifier = f"VELA-ADM-{patient_id}-{bed_id}-{datetime.utcnow().timestamp()}"
    qr_hash = hashlib.md5(identifier.encode()).hexdigest()[:12].upper()
    admission_qr = f"ADM-{qr_hash}"
    
    # STEP 2 — Get room cost
    cost = 500
    for rt in STATIC_ROOM_TYPES:
        if rt["name"] == room_type:
            cost = rt["cost_per_day"]
            break
            
    # Fetch patient's hospital_id
    patient_res = supabase.table("patients").select("hospital_id").eq("id", patient_id).execute()
    p_hospital_id = patient_res.data[0].get("hospital_id") if patient_res.data else None
    p_hospital_id = get_valid_hospital_id(p_hospital_id)
    
    # STEP 3 — Create admission record locally
    admission_id = str(uuid.uuid4())
    local_execute(
        """INSERT INTO admissions (
            id, patient_id, hospital_id, bed_id, ward_id, status, diagnosis, reason, recommended_by, room_type, admission_qr, admitted_at
        ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)""",
        (
            admission_id, patient_id, p_hospital_id, bed_id, ward_id, diagnosis, admission_reason,
            recommended_by, room_type, admission_qr, datetime.utcnow().isoformat()
        )
    )
    
    # STEP 4 — Update bed status in Supabase
    supabase.table("beds").update({
        "status": "occupied",
        "patient_id": patient_id,
        "admitted_at": datetime.utcnow().isoformat()
    }).eq("id", bed_id).execute()
    
    # STEP 5 — Update patient
    supabase.table("patients").update({
        "status": "admitted",
        "is_admitted": True,
        "current_admission_id": admission_id,
        "ward": ward_name,
        "room": bed_number
    }).eq("id", patient_id).execute()
    
    # STEP 6 — Notify everyone
    patient = supabase.table("patients").select("name").eq("id", patient_id).execute()
    patient_name = patient.data[0]["name"] if patient.data else "Patient"
    
    await sio.emit("patient_admitted_qr", {
        "patient_id": patient_id,
        "admission_qr": admission_qr,
        "ward_name": ward_name,
        "bed_number": bed_number,
        "room_type": room_type,
        "cost_per_day": cost,
        "message": f"You have been admitted to {ward_name}, Bed {bed_number}. Admission code: {admission_qr}"
    })
    
    await sio.emit("patient_admitted", {
        "patient_id": patient_id,
        "patient_name": patient_name,
        "bed_id": bed_id,
        "ward_name": ward_name,
        "bed_number": bed_number,
        "admission_qr": admission_qr
    })
    
    await sio.emit("admission_confirmed", {
        "patient_id": patient_id,
        "patient_name": patient_name,
        "ward_name": ward_name,
        "bed_number": bed_number
    })
    
    return {
        "status": "success",
        "admission_id": str(admission_id),
        "admission_qr": admission_qr,
        "ward_name": ward_name,
        "bed_number": bed_number,
        "room_type": room_type,
        "cost_per_day": cost
    }

@fastapi_app.get("/api/room-types")
def get_room_types():
    return {"status": "success", "room_types": STATIC_ROOM_TYPES}

@fastapi_app.get("/api/admissions/scan/{admission_qr}")
def scan_admission_qr(admission_qr: str):
    # Public route for ward scanning using local admissions
    admissions = local_query("SELECT * FROM admissions WHERE admission_qr = ? AND status = 'active'", (admission_qr,))
    if not admissions:
        return {"status": "error", "message": "Invalid QR code or inactive admission"}
        
    adm = merge_relations_for_admissions(admissions)[0]
    p = adm["patients"]
    if not p:
        return {"status": "error", "message": "Patient not found"}
        
    return {
        "status": "success",
        "admission": {
            "admission_qr": admission_qr,
            "admitted_at": adm["admitted_at"],
            "room_type": adm["room_type"],
            "ward_name": adm["wards"]["name"] if adm["wards"] else "Unknown",
            "bed_number": adm["beds"]["bed_number"] if adm["beds"] else "00",
            "recommended_by": adm["recommended_by"],
            "diagnosis": adm["diagnosis"],
            "patient": {
                "name": p["name"],
                "vela_id": p["vela_id"],
                "age": p["age"],
                "gender": p["gender"],
                "blood_group": p["blood_group"],
                "allergies": p["allergies"],
                "existing_conditions": p["existing_conditions"],
                "emergency_contact_name": p["emergency_contact_name"],
                "emergency_contact_phone": p["emergency_contact_phone"],
                "atlas_analysis": p.get("atlas_analysis", ""),
                "atlas_confidence": p.get("atlas_confidence", "LOW"),
                "risk_score": p.get("risk_score", 0)
            }
        }
    }

@fastapi_app.get("/api/admissions/active")
def get_active_admissions(hospital_id: Optional[str] = None):
    # Get active admissions from local SQLite
    if hospital_id:
        hospital_id = get_valid_hospital_id(hospital_id)
        admissions = local_query("SELECT * FROM admissions WHERE status = 'active' AND hospital_id = ? ORDER BY admitted_at DESC", (hospital_id,))
    else:
        admissions = local_query("SELECT * FROM admissions WHERE status = 'active' ORDER BY admitted_at DESC")
        
    admissions = merge_relations_for_admissions(admissions)
    # Remove admissions where patient is missing (Supabase patient deleted/purged)
    admissions = [a for a in admissions if a.get("patients") is not None]
    return {"status": "success", "admissions": admissions}

@fastapi_app.get("/api/admissions/patient/{patient_id}")
def get_patient_admissions(patient_id: str):
    try:
        admissions = local_query("SELECT * FROM admissions WHERE patient_id = ? ORDER BY admitted_at DESC", (patient_id,))
        admissions = merge_relations_for_admissions(admissions)
        return {"status": "success", "admissions": admissions}
    except Exception as e:
        print(f"⚠️ Warning: admissions local query failed: {e}")
        return {"status": "success", "admissions": []}

@fastapi_app.get("/api/admissions/{admission_id}/cost")
def calculate_admission_cost(admission_id: str):
    admissions = local_query("SELECT * FROM admissions WHERE id = ?", (admission_id,))
    if not admissions:
        return {"status": "error", "message": "Admission not found"}
    adm = admissions[0]
    
    admitted_at = datetime.fromisoformat(adm["admitted_at"].replace('Z', '+00:00'))
    now = datetime.utcnow().replace(tzinfo=admitted_at.tzinfo)
    delta = now - admitted_at
    total_days = max(1, delta.days + (1 if delta.seconds > 0 else 0))
    
    room_cost = total_days * adm.get("room_cost_per_day", 500)
    
    # Tests performed during this stay and charged to it (see admission_test_charges).
    test_costs, test_items = admission_test_charges(adm["patient_id"], adm.get("admitted_at"))

    return {
        "status": "success",
        "days": total_days,
        "room_cost": room_cost,
        "test_cost": test_costs,
        "test_items": test_items,
        "total": room_cost + test_costs
    }

# --- PHASE 4: DISCHARGE & HISTORY ---

@fastapi_app.post("/api/discharge/summary/generate")
def generate_discharge_summary(req: DischargeSummaryRequest):
    try:
        # STEP 1 — Gather all patient data
        admissions = local_query("SELECT * FROM admissions WHERE id = ?", (req.admission_id,))
        if not admissions:
            return {"status": "error", "message": "Admission not found"}
            
        admissions = merge_relations_for_admissions(admissions)
        adm = admissions[0]
        patient_id = adm["patient_id"]
        patient = adm["patients"]
        if not patient:
            return {"status": "error", "message": "Patient not found"}
            
        reports_res = local_query("SELECT * FROM lab_reports WHERE patient_id = ? ORDER BY submitted_at", (patient_id,))
        
        medications_res = supabase.table("medications").select("*").eq("patient_id", patient_id).execute()
        notes_res = supabase.table("notes").select("*").eq("patient_id", patient_id).order("created_at").execute()
            
        admitted_at = datetime.fromisoformat(adm["admitted_at"].replace("Z", "+00:00"))
        delta = datetime.utcnow().replace(tzinfo=admitted_at.tzinfo) - admitted_at
        total_days = max(1, delta.days)

        # STEP 2 — Calculate costs
        room_cost = total_days * adm.get("room_cost_per_day", 500)
        
        test_cost, test_items = admission_test_charges(patient_id, adm.get("admitted_at"))
        total_cost = room_cost + test_cost

        # STEP 3 — Generate Atlas summary
        reports_text = "\n".join([f"- {r['test_type']}: Risk {r['risk_score']}, {r['atlas_analysis'][:100]}" for r in reports_res])
        
        meds_text = []
        for m in (medications_res.data or []):
            name = m.get("medication_name") or m.get("name") or "Medication"
            meds_text.append(f"- {name} {m.get('dosage','')} {m.get('frequency','')}")
        meds_text = "\n".join(meds_text)
        
        notes_text = "\n".join([f"- {n['content'][:100]}" for n in (notes_res.data or [])[-5:]])
        
        summary_prompt = f"""Generate a professional medical discharge summary for:
Patient: {patient['name']}
Age: {patient['age']}
Gender: {patient['gender']}
Admitted: {adm['admitted_at']}
Days: {total_days}
Ward: {adm.get('ward_name', 'General')}
Diagnosis: {adm['diagnosis']}

Lab Reports:
{reports_text or 'None'}

Medications Given:
{meds_text or 'None'}

Doctor Notes:
{notes_text or 'None'}

Write a structured discharge summary with these sections:
1. ADMISSION SUMMARY
2. INVESTIGATIONS
3. TREATMENT GIVEN
4. CONDITION AT DISCHARGE
5. MEDICATIONS ON DISCHARGE
6. FOLLOW-UP INSTRUCTIONS

Be professional. Be concise. Use medical language. Maximum 300 words."""

        summary_response = openai_client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "system", "content": summary_prompt}],
            max_tokens=500,
            temperature=0.3
        )
        
        discharge_summary = summary_response.choices[0].message.content.strip()

        return {
            "status": "success",
            "discharge_summary": discharge_summary,
            "total_days": total_days,
            "room_cost": room_cost,
            "test_cost": test_cost,
            "total_cost": total_cost,
            "patient_name": patient["name"],
            "admission_id": req.admission_id,
            "medications": medications_res.data or [],
            "reports_count": len(reports_res)
        }
    except Exception as e:
        return {"status": "error", "message": f"Summary generation failed: {str(e)}"}

@fastapi_app.post("/api/discharge/confirm")
async def confirm_discharge(req: DischargeConfirmRequest):
    try:
        # STEP 1 — Create discharge record locally
        discharge_id = str(uuid.uuid4())
        local_execute(
            """INSERT INTO discharges (
                id, admission_id, patient_id, discharged_by, discharge_summary, final_diagnosis, 
                follow_up_date, follow_up_instructions, medications_on_discharge, total_days, 
                room_cost, test_cost, total_cost, payment_status, payment_amount, discharged_at, 
                atlas_discharge_summary
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?)""",
            (
                discharge_id, req.admission_id, req.patient_id, req.discharged_by, req.discharge_summary,
                req.final_diagnosis, req.follow_up_date, req.follow_up_instructions,
                json.dumps(req.medications_on_discharge), req.total_days, req.room_cost, req.test_cost,
                req.total_cost, req.payment_amount, datetime.utcnow().isoformat(), req.discharge_summary
            )
        )

        # STEP 2 — Update local admission status
        local_execute(
            "UPDATE admissions SET status = 'discharged', discharged_at = ?, diagnosis = ? WHERE id = ?",
            (datetime.utcnow().isoformat(), req.final_diagnosis, req.admission_id)
        )

        # STEP 3 — Free the bed in Supabase
        bed_update = supabase.table("beds").update({
            "status": "cleaning",
            "patient_id": None,
            "admitted_at": None
        }).eq("patient_id", req.patient_id).execute()
        
        bed_id = None
        if bed_update.data:
            bed_id = bed_update.data[0]["id"]

        # STEP 4 — Update patient record in Supabase
        supabase.table("patients").update({
            "is_admitted": False,
            "current_admission_id": None,
            "status": "discharged",
            "ward": None,
            "room": None,
            "last_visit_date": datetime.utcnow().isoformat(),
        }).eq("id", req.patient_id).execute()

        # STEP 5 — Create history record locally
        admissions = local_query("SELECT * FROM admissions WHERE id = ?", (req.admission_id,))
        adm = admissions[0] if admissions else {}
        admissions = merge_relations_for_admissions(admissions)
        
        ward_name = admissions[0]["wards"]["name"] if admissions and admissions[0].get("wards") else "Unknown"
        bed_number = admissions[0]["beds"]["bed_number"] if admissions and admissions[0].get("beds") else "00"
        room_type = adm.get("room_type", "General")
        
        local_tests = local_query("SELECT test_type FROM test_orders WHERE patient_id = ?", (req.patient_id,))
        meds_res = supabase.table("medications").select("*").eq("patient_id", req.patient_id).execute()
        
        meds_list = []
        for m in (meds_res.data or []):
            meds_list.append(m.get("medication_name") or m.get("name") or "Medication")
            
        history_id = str(uuid.uuid4())
        local_execute(
            """INSERT INTO patient_history (
                id, patient_id, admission_id, ward_name, bed_number, room_type, diagnosis, 
                admitted_at, discharged_at, total_cost, discharge_summary, medications, tests
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                history_id, req.patient_id, req.admission_id, ward_name, bed_number, room_type,
                req.final_diagnosis, adm.get("admitted_at"), datetime.utcnow().isoformat(),
                req.total_cost, req.discharge_summary, json.dumps(meds_list),
                json.dumps([t["test_type"] for t in local_tests if t.get("test_type")])
            )
        )

        # STEP 6 — Notify everyone
        patient_res = supabase.table("patients").select("name").eq("id", req.patient_id).execute()
        patient_name = patient_res.data[0]["name"] if patient_res.data else "Patient"
        
        await sio.emit("patient_discharged", {
            "patient_id": req.patient_id,
            "patient_name": patient_name,
            "admission_id": req.admission_id,
            "total_days": req.total_days,
            "total_cost": req.total_cost,
            "follow_up_date": req.follow_up_date,
            "message": f"{patient_name} has been discharged. Total stay: {req.total_days} days. Total cost: ₹{req.total_cost}"
        })
        
        if bed_id:
            await sio.emit("bed_status_changed", {
                "bed_id": bed_id,
                "status": "cleaning"
            })

        return {
            "status": "success",
            "discharge_id": str(discharge_id),
            "message": "Patient discharged successfully.",
            "total_cost": req.total_cost,
            "follow_up_date": req.follow_up_date
        }
    except Exception as e:
        print("Discharge error:", e)
        return {"status": "error", "message": f"Discharge failed: {str(e)}"}

@fastapi_app.get("/api/history/patient/{patient_id}")
def get_patient_history(patient_id: str):
    history = local_query("SELECT * FROM patient_history WHERE patient_id = ? ORDER BY admitted_at DESC", (patient_id,))
    for h in history:
        if h.get("medications") and isinstance(h["medications"], str):
            try:
                h["medications"] = json.loads(h["medications"])
            except Exception:
                h["medications"] = []
        if h.get("tests") and isinstance(h["tests"], str):
            try:
                h["tests"] = json.loads(h["tests"])
            except Exception:
                h["tests"] = []
    return {"status": "success", "history": history}

@fastapi_app.get("/api/discharge/{discharge_id}")
def get_discharge_details(discharge_id: str):
    discharges = local_query("SELECT * FROM discharges WHERE id = ?", (discharge_id,))
    if not discharges:
        return {"status": "error", "message": "Discharge record not found"}
        
    d = discharges[0]
    
    # Fetch related patient from Supabase
    try:
        p_res = supabase.table("patients").select("*").eq("id", d["patient_id"]).execute()
        d["patients"] = p_res.data[0] if p_res.data else None
    except Exception:
        d["patients"] = None
        
    if d.get("medications_on_discharge") and isinstance(d["medications_on_discharge"], str):
        try:
            d["medications_on_discharge"] = json.loads(d["medications_on_discharge"])
        except Exception:
            d["medications_on_discharge"] = []
            
    return {"status": "success", "discharge": d}

# --- HEALTH ---
@fastapi_app.get("/health")
def health():
    return {"status": "Atlas AI is running 🚀"}

from receptionist import router as receptionist_router
fastapi_app.include_router(receptionist_router)

# ── NETWORK HOSPITALS ──

@fastapi_app.post("/api/network/hospitals/register")
def register_network_hospital(data: dict):
    name = data.get("name", "")
    address = data.get("address", "")
    place_id = data.get("place_id", "")
    lat = data.get("lat", 0)
    lng = data.get("lng", 0)
    specializations = data.get("specializations", [])
    receptionist_name = data.get("receptionist_name", "")

    if not all([name, address, place_id, receptionist_name]):
        return {"status": "error", "message": "Missing required fields"}

    # Check duplicate place_id
    existing = supabase.table("network_hospitals").select("id").eq("place_id", place_id).execute()
    if existing.data:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=409, content={"status": "error", "code": "DUPLICATE_PLACE_ID", "message": "This hospital is already registered on the Vela network."})

    # Derive slug and email
    slug = derive_slug(name)
    base_email = f"reception.{slug}@vela.health"
    email = base_email

    # Check slug collision
    collision = supabase.table("network_hospitals").select("id").eq("receptionist_email", email).execute()
    if collision.data:
        import random
        suffix = random.randint(1000, 9999)
        email = f"reception.{slug}-{suffix}@vela.health"

    # Generate and hash password
    import bcrypt
    plaintext_password = generate_password()
    hashed = bcrypt.hashpw(plaintext_password.encode(), bcrypt.gensalt()).decode()

    result = supabase.table("network_hospitals").insert({
        "name": name,
        "address": address,
        "place_id": place_id,
        "lat": lat,
        "lng": lng,
        "specializations": specializations,
        "receptionist_email": email,
        "receptionist_password_hash": hashed,
        "receptionist_name": receptionist_name,
    }).execute()

    if not result.data:
        return {"status": "error", "message": "Registration failed"}

    hospital_id = result.data[0]["id"]
    return {
        "status": "success",
        "email": email,
        "password": plaintext_password,
        "hospital_name": name,
        "hospital_id": hospital_id
    }


@fastapi_app.get("/api/network/hospitals")
def get_network_hospitals():
    try:
        result = supabase.table("network_hospitals").select(
            "id, name, address, place_id, lat, lng, specializations, receptionist_email, receptionist_name, created_at"
        ).order("created_at", desc=True).execute()
        return {"status": "success", "hospitals": result.data or []}
    except Exception as e:
        print(f"[network_hospitals] Table may not exist yet: {e}")
        return {"status": "success", "hospitals": []}


@fastapi_app.post("/api/network/auth/login")
def network_receptionist_login(data: dict):
    email = data.get("email", "")
    password = data.get("password", "")
    if not email or not password:
        return {"status": "error", "message": "Invalid credentials"}

    result = supabase.table("network_hospitals").select(
        "id, name, receptionist_name, receptionist_password_hash"
    ).eq("receptionist_email", email).execute()

    if not result.data:
        return {"status": "error", "message": "Invalid credentials"}

    hospital = result.data[0]
    import bcrypt
    try:
        valid = bcrypt.checkpw(password.encode(), hospital["receptionist_password_hash"].encode())
    except Exception:
        valid = False

    if not valid:
        return {"status": "error", "message": "Invalid credentials"}

    return {
        "status": "success",
        "token": issue_session_token("receptionist", hospital["receptionist_name"] or ""),
        "hospital_id": hospital["id"],
        "hospital_name": hospital["name"],
        "receptionist_name": hospital["receptionist_name"]
    }


@fastapi_app.post("/api/network/appointments/book")
async def book_network_appointment(data: dict):
    hospital_id = data.get("hospital_id")
    patient_id = data.get("patient_id")
    patient_name = data.get("patient_name", "")
    vela_id = data.get("vela_id", "")
    date = data.get("date")
    time = data.get("time")

    if not all([hospital_id, patient_id, date, time]):
        return {"status": "error", "message": "Missing required fields"}

    # Idempotency: same patient + hospital + slot must not book twice.
    try:
        existing = await asyncio.to_thread(
            lambda: supabase.table("network_appointments").select("id")
            .eq("hospital_id", hospital_id).eq("patient_id", patient_id)
            .eq("date", date).eq("time", time)
            .neq("status", "cancelled").execute()
        )
        if existing.data:
            return {"status": "success", "appointment_id": existing.data[0]["id"], "duplicate": True}
    except Exception as e:
        print(f"⚠️ Warning: network duplicate-appointment check failed: {e}")

    result = supabase.table("network_appointments").insert({
        "hospital_id": hospital_id,
        "patient_id": patient_id,
        "patient_name": patient_name,
        "vela_id": vela_id,
        "date": date,
        "time": time,
        "status": "pending"
    }).execute()

    if not result.data:
        return {"status": "error", "message": "Booking failed"}

    appointment_id = result.data[0]["id"]

    await sio.emit("new_appointment", {
        "patient_name": patient_name,
        "date": date,
        "time": time,
        "vela_id": vela_id,
        "hospital_id": hospital_id
    }, room=f"hospital_{hospital_id}")

    return {"status": "success", "appointment_id": appointment_id}


@fastapi_app.get("/api/network/appointments")
def get_network_appointments(hospital_id: str):
    result = supabase.table("network_appointments").select("*").eq(
        "hospital_id", hospital_id
    ).order("created_at", desc=True).execute()
    return {"status": "success", "appointments": result.data or []}


@fastapi_app.patch("/api/network/appointments/{appointment_id}/arrive")
async def network_appointment_arrive(appointment_id: str):
    result = supabase.table("network_appointments").update(
        {"status": "arrived"}
    ).eq("id", appointment_id).execute()

    if not result.data:
        return {"status": "error", "message": "Appointment not found"}

    apt = result.data[0]
    await sio.emit("queue_updated", {
        "appointment_id": appointment_id,
        "hospital_id": apt.get("hospital_id"),
        "patient_name": apt.get("patient_name"),
        "status": "arrived"
    }, room=f"hospital_{apt.get('hospital_id')}")

    return {"status": "success"}


# ── PROVIDER NETWORK: independent labs & solo doctors ──
# Same shape as the network_hospitals routes above, but for providers that
# aren't part of any hospital and therefore onboard directly through Vela.
# Registration requires a session (called from the Vela Owner console);
# the login routes are public since no session exists yet at that point.

@fastapi_app.post("/api/network/labs/register")
def register_network_lab(data: dict):
    name = data.get("name", "")
    address = data.get("address", "")
    place_id = data.get("place_id", "")
    lat = data.get("lat", 0)
    lng = data.get("lng", 0)
    departments = data.get("departments", [])
    contact_name = data.get("contact_name", "")

    if not all([name, address, place_id, contact_name]):
        return {"status": "error", "message": "Missing required fields"}

    existing = supabase.table("network_labs").select("id").eq("place_id", place_id).execute()
    if existing.data:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=409, content={"status": "error", "code": "DUPLICATE_PLACE_ID", "message": "This lab is already registered on the Vela network."})

    slug = derive_slug(name)
    email = f"lab.{slug}@vela.health"
    collision = supabase.table("network_labs").select("id").eq("login_email", email).execute()
    if collision.data:
        import random
        email = f"lab.{slug}-{random.randint(1000, 9999)}@vela.health"

    import bcrypt
    plaintext_password = generate_password()
    hashed = bcrypt.hashpw(plaintext_password.encode(), bcrypt.gensalt()).decode()

    result = supabase.table("network_labs").insert({
        "name": name,
        "address": address,
        "place_id": place_id,
        "lat": lat,
        "lng": lng,
        "departments": departments,
        "contact_name": contact_name,
        "login_email": email,
        "password_hash": hashed,
    }).execute()

    if not result.data:
        return {"status": "error", "message": "Registration failed"}

    return {
        "status": "success",
        "email": email,
        "password": plaintext_password,
        "lab_name": name,
        "lab_id": result.data[0]["id"],
    }


@fastapi_app.get("/api/network/labs")
def get_network_labs():
    try:
        result = supabase.table("network_labs").select(
            "id, name, address, place_id, lat, lng, departments, contact_name, login_email, created_at"
        ).order("created_at", desc=True).execute()
        return {"status": "success", "labs": result.data or []}
    except Exception as e:
        print(f"[network_labs] Table may not exist yet: {e}")
        return {"status": "success", "labs": []}


@fastapi_app.post("/api/network/labs/auth/login")
def network_lab_login(data: dict):
    email = data.get("email", "")
    password = data.get("password", "")
    if not email or not password:
        return {"status": "error", "message": "Invalid credentials"}

    result = supabase.table("network_labs").select(
        "id, name, password_hash, contact_name"
    ).eq("login_email", email).execute()
    if not result.data:
        return {"status": "error", "message": "Invalid credentials"}

    lab = result.data[0]
    import bcrypt
    try:
        valid = bcrypt.checkpw(password.encode(), lab["password_hash"].encode())
    except Exception:
        valid = False
    if not valid:
        return {"status": "error", "message": "Invalid credentials"}

    return {
        "status": "success",
        "token": issue_session_token("lab_controller", lab["contact_name"] or "", network_lab_id=lab["id"]),
        "lab_id": lab["id"],
        "lab_name": lab["name"],
    }


@fastapi_app.post("/api/network/doctors/register")
def register_network_doctor(data: dict):
    name = data.get("name", "")
    specialization = data.get("specialization", "")
    address = data.get("address", "")
    place_id = data.get("place_id", "")
    lat = data.get("lat", 0)
    lng = data.get("lng", 0)
    consultation_fee = data.get("consultation_fee", 0)
    license_number = data.get("license_number", "")

    if not all([name, specialization, address, place_id, license_number]):
        return {"status": "error", "message": "Missing required fields"}

    existing = supabase.table("network_doctors").select("id").eq("place_id", place_id).execute()
    if existing.data:
        from fastapi.responses import JSONResponse
        return JSONResponse(status_code=409, content={"status": "error", "code": "DUPLICATE_PLACE_ID", "message": "This clinic is already registered on the Vela network."})

    slug = derive_slug(name)
    email = f"doctor.{slug}@vela.health"
    collision = supabase.table("network_doctors").select("id").eq("login_email", email).execute()
    if collision.data:
        import random
        email = f"doctor.{slug}-{random.randint(1000, 9999)}@vela.health"

    import bcrypt
    plaintext_password = generate_password()
    hashed = bcrypt.hashpw(plaintext_password.encode(), bcrypt.gensalt()).decode()

    result = supabase.table("network_doctors").insert({
        "name": name,
        "specialization": specialization,
        "address": address,
        "place_id": place_id,
        "lat": lat,
        "lng": lng,
        "consultation_fee": consultation_fee,
        "license_number": license_number,
        "verified": False,
        "login_email": email,
        "password_hash": hashed,
    }).execute()

    if not result.data:
        return {"status": "error", "message": "Registration failed"}

    return {
        "status": "success",
        "email": email,
        "password": plaintext_password,
        "doctor_name": name,
        "doctor_id": result.data[0]["id"],
        "verified": False,
        "message": "Registered — pending license verification before this account can log in.",
    }


@fastapi_app.get("/api/network/doctors")
def get_network_doctors(verified_only: bool = True):
    try:
        query = supabase.table("network_doctors").select(
            "id, name, specialization, address, place_id, lat, lng, consultation_fee, "
            "license_number, verified, login_email, created_at"
        )
        if verified_only:
            query = query.eq("verified", True)
        result = query.order("created_at", desc=True).execute()
        return {"status": "success", "doctors": result.data or []}
    except Exception as e:
        print(f"[network_doctors] Table may not exist yet: {e}")
        return {"status": "success", "doctors": []}


@fastapi_app.patch("/api/network/doctors/{doctor_id}/verify")
def verify_network_doctor(doctor_id: str, request: _Request):
    """Vela-admin-only: confirm a solo doctor's medical license before their
    account can log in or receive patients. The highest-severity failure mode
    in the provider network is an unverified account entering clinical data,
    so this check has no self-service path."""
    session = getattr(request.state, "session", None) or {}
    if session.get("role") not in ("vela_owner", "hospital_manager"):
        return _JSONResponse(
            status_code=403,
            content={"status": "error", "message": "Not authorized to verify providers"},
            headers=_cors_headers(request),
        )

    result = supabase.table("network_doctors").update({"verified": True}).eq("id", doctor_id).execute()
    if not result.data:
        return {"status": "error", "message": "Doctor not found"}
    return {"status": "success", "doctor": result.data[0]}


@fastapi_app.post("/api/network/doctors/auth/login")
def network_doctor_login(data: dict):
    email = data.get("email", "")
    password = data.get("password", "")
    if not email or not password:
        return {"status": "error", "message": "Invalid credentials"}

    result = supabase.table("network_doctors").select(
        "id, name, password_hash, verified"
    ).eq("login_email", email).execute()
    if not result.data:
        return {"status": "error", "message": "Invalid credentials"}

    doctor = result.data[0]
    import bcrypt
    try:
        valid = bcrypt.checkpw(password.encode(), doctor["password_hash"].encode())
    except Exception:
        valid = False
    if not valid:
        return {"status": "error", "message": "Invalid credentials"}

    if not doctor.get("verified"):
        return {"status": "error", "message": "This account is still pending license verification."}

    return {
        "status": "success",
        "token": issue_session_token("doctor", doctor["name"] or "", network_doctor_id=doctor["id"]),
        "doctor_id": doctor["id"],
        "doctor_name": doctor["name"],
    }


@fastapi_app.post("/api/network/doctors/appointments/book")
async def book_network_doctor_appointment(data: dict):
    doctor_id = data.get("doctor_id")
    patient_id = data.get("patient_id")
    patient_name = data.get("patient_name", "")
    vela_id = data.get("vela_id", "")
    date = data.get("date")
    time_ = data.get("time")

    if not all([doctor_id, patient_id, date, time_]):
        return {"status": "error", "message": "Missing required fields"}

    try:
        existing = await asyncio.to_thread(
            lambda: supabase.table("network_doctor_appointments").select("id")
            .eq("doctor_id", doctor_id).eq("patient_id", patient_id)
            .eq("date", date).eq("time", time_)
            .neq("status", "cancelled").execute()
        )
        if existing.data:
            return {"status": "success", "appointment_id": existing.data[0]["id"], "duplicate": True}
    except Exception as e:
        print(f"⚠️ Warning: network-doctor duplicate-appointment check failed: {e}")

    result = supabase.table("network_doctor_appointments").insert({
        "doctor_id": doctor_id,
        "patient_id": patient_id,
        "patient_name": patient_name,
        "vela_id": vela_id,
        "date": date,
        "time": time_,
        "status": "pending",
    }).execute()

    if not result.data:
        return {"status": "error", "message": "Booking failed"}

    appointment_id = result.data[0]["id"]
    await sio.emit("new_appointment", {
        "patient_name": patient_name,
        "date": date,
        "time": time_,
        "vela_id": vela_id,
        "doctor_id": doctor_id,
    }, room=f"network_doctor_{doctor_id}")

    return {"status": "success", "appointment_id": appointment_id}


@fastapi_app.get("/api/network/doctors/appointments")
def get_network_doctor_appointments(doctor_id: str):
    result = supabase.table("network_doctor_appointments").select("*").eq(
        "doctor_id", doctor_id
    ).order("created_at", desc=True).execute()
    return {"status": "success", "appointments": result.data or []}


@fastapi_app.patch("/api/network/doctors/appointments/{appointment_id}/arrive")
async def network_doctor_appointment_arrive(appointment_id: str):
    result = supabase.table("network_doctor_appointments").update(
        {"status": "arrived"}
    ).eq("id", appointment_id).execute()
    if not result.data:
        return {"status": "error", "message": "Appointment not found"}

    apt = result.data[0]
    await sio.emit("queue_updated", {
        "appointment_id": appointment_id,
        "doctor_id": apt.get("doctor_id"),
        "patient_name": apt.get("patient_name"),
        "status": "arrived",
    }, room=f"network_doctor_{apt.get('doctor_id')}")

    return {"status": "success"}


# ── SOCKET.IO ROOM JOIN ──

@sio.event
async def join_room(sid, data):
    room = data.get("room")
    if room:
        await sio.enter_room(sid, room)
        print(f"[Socket.IO] {sid} joined room: {room}")


# ── MEM0 MEMORY WIPE UTILITY ──
# Use this endpoint to flush stale/prototype-era Mem0 memories for specific patient IDs.
# This does NOT touch Supabase documents — it only wipes the Mem0 semantic memory index.

@fastapi_app.post("/api/mem0/wipe-patient")
async def wipe_patient_mem0(data: dict):
    """
    Wipes all Mem0 long-term memories for one or more patient IDs.
    Safe to call multiple times. Does NOT delete Supabase documents.

    Body: { "patient_ids": ["uuid-1", "uuid-2", ...] }
    Also accepts legacy prototype IDs like "patient_rajesh_001" for cleanup.
    """
    patient_ids = data.get("patient_ids", [])
    if not patient_ids:
        return {"status": "error", "message": "No patient_ids provided"}

    if not mem0_client:
        return {"status": "error", "message": "Mem0 client not initialized"}

    results = {}
    for pid in patient_ids:
        try:
            # Fetch all memories for this user first
            all_memories = await asyncio.to_thread(
                lambda: mem0_client.get_all(user_id=pid)
            )
            memories = all_memories.get("results", []) if isinstance(all_memories, dict) else (all_memories or [])
            deleted_count = 0
            for mem in memories:
                mem_id = mem.get("id")
                if mem_id:
                    try:
                        await asyncio.to_thread(lambda: mem0_client.delete(mem_id))
                        deleted_count += 1
                    except Exception as del_err:
                        print(f"⚠️ Could not delete memory {mem_id}: {del_err}")
            results[pid] = {"deleted": deleted_count, "status": "wiped"}
            print(f"🧹 Wiped {deleted_count} Mem0 memories for patient {pid}")
        except Exception as e:
            results[pid] = {"status": "error", "message": str(e)}
            print(f"⚠️ Failed to wipe Mem0 for patient {pid}: {e}")

    return {
        "status": "success",
        "message": f"Mem0 wipe completed for {len(patient_ids)} patient(s)",
        "results": results
    }


# ── DEMO PATIENT SEED ──

_DEMO_PATIENT_CACHE: dict = {}

@fastapi_app.post("/api/demo/seed-patient")
def seed_demo_patient():
    """Creates the demo patient if they don't exist. Safe to call multiple times."""
    demo_email = "patient@vela.ai"
    demo_name = "Rajesh Kumar"

    # Find the seed by its VELA ID first: the name and email are editable by the patient
    # (Edit my details), the ID is not — so the demo login can't lose its patient.
    existing = supabase.table("patients").select("*").eq("vela_id", "VLA-8888").limit(1).execute()
    if not existing.data:
        existing = supabase.table("patients").select("*").eq("email", demo_email).limit(1).execute()
    if existing.data:
        patient = existing.data[0]
        if not patient.get("vela_id"):
            update_res = supabase.table("patients").update({"vela_id": "VLA-8888"}).eq("id", patient["id"]).execute()
            if update_res.data:
                patient = update_res.data[0]
        return {"status": "success", "patient": patient, "created": False}

    result = supabase.table("patients").insert({
        "name": demo_name,
        "age": 45,
        "gender": "Male",
        "blood_group": "O+",
        "email": demo_email,
        "phone": "9876543210",
        "allergies": "Penicillin",
        "existing_conditions": "Hypertension",
        "language": "English",
        "ward": "General",
        "status": "stable",
        "risk_score": 0,
        "registered_by": "demo_seed",
        "emergency_contact": "9876543210",
        "emergency_contact_name": "Priya Kumar",
        "emergency_contact_relation": "Spouse",
        "emergency_contact_phone": "9876543210",
        "vela_id": "VLA-8888"
    }).execute()

    if not result.data:
        return {"status": "error", "message": "Failed to create demo patient"}

    patient = result.data[0]
    return {"status": "success", "patient": patient, "created": True}


# ── VELA OWNER ROUTES ──

OWNER_EMAIL = "dev@vela.ai"
OWNER_PASSWORD = "dev1"

@fastapi_app.post("/api/owner/login")
def owner_login(data: dict):
    email = data.get("email", "")
    password = data.get("password", "")
    if email == OWNER_EMAIL and password == OWNER_PASSWORD:
        return {
            "status": "success",
            "role": "vela_owner",
            "name": "Dev Chalana",
            "message": "Welcome back, Dev",
            "token": issue_session_token("vela_owner", "Dev Chalana"),
        }
    return {"status": "error", "message": "Invalid credentials"}


@fastapi_app.post("/api/owner/onboard-hospital")
def onboard_hospital(data: dict):
    try:
        name = data.get("name", "")
        address = data.get("address", "")
        city = data.get("city", "")
        state = data.get("state", "")
        phone = data.get("phone", "")
        email = data.get("email", "")
        specializations = data.get("specializations", [])
        total_beds = data.get("total_beds", 10)
        latitude = data.get("latitude")
        longitude = data.get("longitude")
        mapbox_place_id = data.get("mapbox_place_id", "")
        manager_name = data.get("manager_name", "")

        if not name:
            return {"status": "error", "message": "Hospital name is required"}

        # Generate slug
        slug = re.sub(r'[^a-z0-9\s-]', '', name.lower())
        slug = re.sub(r'\s+', '-', slug.strip())
        slug = slug.replace('hospital', '').replace('--', '-').strip('-')[:15]
        if not slug:
            slug = "hospital"

        # Check slug collision
        existing_slug = supabase_admin.table("vela_hospitals").select("id").eq("hospital_slug", slug).execute()
        if existing_slug.data:
            slug = f"{slug}-{random.randint(10, 99)}"

        # Generate manager credentials
        manager_email = f"manager@{slug}.vela.health"
        manager_password = f"Vela@{random.randint(1000, 9999)}"

        # Insert Hospital using admin client to bypass RLS
        h_insert = supabase_admin.table("vela_hospitals").insert({
            "name": name,
            "address": address,
            "city": city,
            "state": state,
            "phone": phone,
            "email": email,
            "specializations": specializations,
            "total_beds": total_beds,
            "latitude": latitude,
            "longitude": longitude,
            "mapbox_place_id": mapbox_place_id,
            "manager_name": manager_name,
            "manager_email": manager_email,
            "manager_password": manager_password,
            "hospital_slug": slug,
            "verified": True,
            "active": True,
        }).execute()

        if not h_insert.data or len(h_insert.data) == 0:
            err_msg = getattr(h_insert, 'error', 'Unknown Error')
            return {"status": "error", "message": f"DB Error (Hospital): {err_msg}"}

        hospital_id = h_insert.data[0]["id"]

        # Create walkthrough record using admin client
        w_insert = supabase_admin.table("vela_walkthrough").insert({
            "hospital_id": hospital_id,
            "completed": False,
            "step_reached": 1
        }).execute()

        if not w_insert.data:
            print(f"⚠️ Warning: Walkthrough creation failed for {hospital_id}")

        return {
            "status": "success",
            "hospital_id": hospital_id,
            "manager_email": manager_email,
            "manager_password": manager_password,
            "hospital_name": name,
            "slug": slug
        }
    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"status": "error", "message": f"Server Error: {str(e)}"}


@fastapi_app.get("/api/owner/hospitals")
def get_owner_hospitals():
    try:
        hospitals = supabase_admin.table("vela_hospitals").select("*").eq("active", True).order("onboarded_at", desc=True).execute()
        result = []
        for h in (hospitals.data or []):
            staff = supabase_admin.table("vela_staff").select("id, online").eq("hospital_id", h["id"]).eq("active", True).execute()
            staff_list = staff.data or []
            result.append({
                **h,
                "staff_count": len(staff_list),
                "active_staff": sum(1 for s in staff_list if s.get("online"))
            })
        return {"status": "success", "hospitals": result}
    except Exception as e:
        return {"status": "success", "hospitals": []}


@fastapi_app.get("/api/owner/stats")
def get_owner_stats():
    try:
        hospitals = supabase_admin.table("vela_hospitals").select("id").eq("active", True).execute()
        staff = supabase_admin.table("vela_staff").select("id, online").eq("active", True).execute()
        today = datetime.utcnow().strftime("%Y-%m-%d")
        patients_today = supabase_admin.table("patients").select("id").gte("admitted_at", today).execute()
        queries_today = supabase_admin.table("voice_queries").select("id").gte("created_at", today).execute()
        staff_list = staff.data or []
        hospital_ids_with_online = set(
            s.get("hospital_id") for s in staff_list if s.get("online")
        )
        return {
            "status": "success",
            "total_hospitals": len(hospitals.data or []),
            "total_staff": len(staff_list),
            "total_patients_today": len(patients_today.data or []),
            "total_atlas_queries_today": len(queries_today.data or []),
            "hospitals_online": len(hospital_ids_with_online)
        }
    except Exception as e:
        return {"status": "success", "total_hospitals": 0, "total_staff": 0, "total_patients_today": 0, "total_atlas_queries_today": 0, "hospitals_online": 0}


# ── MANAGER ROUTES ──

@fastapi_app.post("/api/manager/login")
def manager_login(data: dict):
    email = data.get("email", "")
    password = data.get("password", "")
    hospital = supabase_admin.table("vela_hospitals").select("*").eq("manager_email", email).eq("active", True).execute()
    if not hospital.data or not verify_password(password, hospital.data[0].get("manager_password") or ""):
        return {"status": "error", "message": "Invalid credentials"}
    h = hospital.data[0]
    if not (h.get("manager_password") or "").startswith(("$2a$", "$2b$")):
        # Legacy plaintext row — upgrade it now that we know the password.
        try:
            supabase_admin.table("vela_hospitals").update({"manager_password": hash_password(password)}).eq("id", h["id"]).execute()
        except Exception:
            pass
    walkthrough = supabase_admin.table("vela_walkthrough").select("*").eq("hospital_id", h["id"]).eq("completed", True).execute()
    walkthrough_done = len(walkthrough.data) > 0
    return {
        "status": "success",
        "token": issue_session_token("hospital_manager", h.get("manager_name") or "", hospital_id=h["id"]),
        "role": "hospital_manager",
        "hospital_id": h["id"],
        "hospital_name": h["name"],
        "manager_name": h["manager_name"],
        "walkthrough_done": walkthrough_done,
        "specializations": h.get("specializations", []),
        "total_beds": h.get("total_beds", 0)
    }


@fastapi_app.post("/api/manager/add-staff")
def add_staff(data: dict):
    import re as _re, random as _random
    hospital_id = data.get("hospital_id")
    name = data.get("name", "")
    role = data.get("role", "doctor")
    specialization = data.get("specialization", "")

    hospital = supabase_admin.table("vela_hospitals").select("name, hospital_slug").eq("id", hospital_id).execute()
    if not hospital.data:
        return {"status": "error", "message": "Hospital not found"}
    slug = hospital.data[0]["hospital_slug"]
    h_name = hospital.data[0].get("name", "Vela Hospital")

    name_slug = _re.sub(r'[^a-z0-9.]', '', name.lower().replace(" ", ".").replace("dr.", "dr"))[:15]
    email = f"{name_slug}@{slug}.vela.health"

    # Check email collision
    existing = supabase_admin.table("vela_staff").select("id").eq("email", email).execute()
    if existing.data:
        email = f"{name_slug}{_random.randint(10,99)}@{slug}.vela.health"

    digits = _random.randint(1000, 9999)
    password = f"Vela@{digits}"

    result = supabase_admin.table("vela_staff").insert({
        "hospital_id": hospital_id,
        "name": name,
        "role": role,
        "specialization": specialization,
        "ward_id": data.get("ward_id") if data.get("ward_id") else None,
        "email": email,
        "password": password,
        "active": True,
        "online": False
    }).execute()

    if not result.data:
        return {"status": "error", "message": "Failed to add staff"}

    # Mirror to doctors table if role is doctor (satisfies FK constraints on appointments table)
    if role == "doctor":
        try:
            supabase_admin.table("doctors").insert({
                "id": result.data[0]["id"],
                "name": name,
                "specialization": specialization or "General Physician",
                "hospital": h_name,
                "available": True
            }).execute()
        except Exception as e:
            print(f"⚠️ Warning: mirroring new doctor failed: {e}")

    return {"status": "success", "name": name, "role": role, "email": email, "password": password, "id": result.data[0]["id"]}



_STAFF_LIST_COLUMNS = "id, hospital_id, name, role, specialization, email, active, online, last_active, ward_id, created_at, wards(name)"

@fastapi_app.get("/api/manager/staff/{hospital_id}")
def get_staff(hospital_id: str, request: _Request):
    session = getattr(request.state, "session", None) or {}
    if session.get("role") != "hospital_manager" or session.get("hospital_id") != hospital_id:
        return _JSONResponse(
            status_code=403,
            content={"status": "error", "message": "Not authorized for this hospital"},
            headers=_cors_headers(request),
        )
    staff = supabase_admin.table("vela_staff").select(_STAFF_LIST_COLUMNS).eq("hospital_id", hospital_id).eq("active", True).order("created_at").execute()
    grouped = {"doctors": [], "receptionists": [], "lab_controllers": []}
    for s in (staff.data or []):
        ward_info = s.get("wards") or {}
        s["ward_name"] = ward_info.get("name", "Floating")
        r = s.get("role", "")
        if r == "doctor":
            grouped["doctors"].append(s)
        elif r == "receptionist":
            grouped["receptionists"].append(s)
        elif r == "lab_controller":
            grouped["lab_controllers"].append(s)
    return {"status": "success", **grouped}


@fastapi_app.delete("/api/manager/staff/{staff_id}")
def remove_staff(staff_id: str):
    supabase_admin.table("vela_staff").update({"active": False}).eq("id", staff_id).execute()
    return {"status": "success"}


@fastapi_app.post("/api/staff/login")
async def staff_login(data: dict):
    email = data.get("email", "")
    password = data.get("password", "")
    try:
        # Run the synchronous Supabase call in a thread so it never blocks the event loop
        staff_res = await asyncio.wait_for(
            asyncio.to_thread(
                lambda: supabase_admin.table("vela_staff").select("*, vela_hospitals(*)").eq("email", email).eq("active", True).execute()
            ),
            timeout=8.0
        )
    except asyncio.TimeoutError:
        return {"status": "error", "message": "Login service timed out. Please try again."}
    except Exception as e:
        return {"status": "error", "message": f"Login failed: {str(e)}"}
    # bcrypt is deliberately slow (~0.3s of CPU): keep it off the event loop so other requests keep flowing.
    if not staff_res.data or not await asyncio.to_thread(verify_password, password, staff_res.data[0].get("password") or ""):
        return {"status": "error", "message": "Invalid credentials"}
    s = staff_res.data[0]
    if not (s.get("password") or "").startswith(("$2a$", "$2b$")):
        # Legacy plaintext row — upgrade it now that we know the password, same
        # lazy-migration pattern manager_login uses for vela_hospitals.
        try:
            supabase_admin.table("vela_staff").update({"password": hash_password(password)}).eq("id", s["id"]).execute()
        except Exception:
            pass
    hospital = s.get("vela_hospitals") or {}

    # Marking the staff "online" is non-critical bookkeeping — don't make the
    # user's login wait on a second DB round-trip for it. Fire it in the
    # background so the login response returns after just the auth lookup.
    async def _mark_online():
        try:
            await asyncio.to_thread(
                lambda: supabase_admin.table("vela_staff").update({"online": True, "last_active": datetime.utcnow().isoformat()}).eq("id", s["id"]).execute()
            )
        except Exception:
            pass  # Non-critical, don't fail login if online-status write fails
    asyncio.create_task(_mark_online())
    # A lab account's `specialization` doubles as its department scope — a staff
    # row with specialization "radiology" only ever sees the radiology queue.
    lab_department = ""
    if s["role"] in ("lab_controller", "lab"):
        candidate = (s.get("specialization") or "").strip().lower()
        if candidate in lab_catalog.DEPARTMENT_IDS:
            lab_department = candidate

    return {
        "status": "success",
        # Without this the caller is authenticated but tokenless, and every
        # subsequent API call 401s.
        "token": issue_session_token(s["role"], s["name"], s["id"], lab_department=lab_department, hospital_id=s.get("hospital_id") or ""),
        "role": s["role"],
        "staff_id": s["id"],
        "name": s["name"],
        "hospital_id": hospital.get("id"),
        "hospital_name": hospital.get("name"),
        "specialization": s.get("specialization", ""),
        "lab_department": lab_department,
    }


@fastapi_app.post("/api/staff/logout")
def staff_logout(data: dict):
    staff_id = data.get("staff_id")
    if staff_id:
        supabase_admin.table("vela_staff").update({"online": False}).eq("id", staff_id).execute()
    return {"status": "success"}


@fastapi_app.post("/api/manager/complete-walkthrough")
def complete_walkthrough(data: dict):
    hospital_id = data.get("hospital_id")
    supabase_admin.table("vela_walkthrough").update({
        "completed": True, 
        "completed_at": datetime.utcnow().isoformat()
    }).eq("hospital_id", hospital_id).execute()
    return {"status": "success"}


@fastapi_app.get("/api/manager/command-center/{hospital_id}")
def command_center(hospital_id: str):
    try:
        staff = supabase_admin.table("vela_staff").select("id, name, role, online, last_active").eq("hospital_id", hospital_id).eq("active", True).execute()
        # Admissions and lab orders live in the local database, not in Supabase.
        admissions = _LocalRows(local_query("SELECT id, status, admitted_at, discharged_at FROM admissions WHERE hospital_id = ?", (hospital_id,)))
        lab_orders = _LocalRows(local_query("SELECT id, status FROM test_orders WHERE hospital_id = ?", (hospital_id,)))
        today = datetime.utcnow().strftime("%Y-%m-%d")
        queries = supabase_admin.table("voice_queries").select("id").gte("created_at", today).execute()
        
        adm_data = admissions.data or []
        lab_data = lab_orders.data or []
        
        return {
            "status": "success",
            "staff_online": [s for s in (staff.data or []) if s.get("online")],
            "patients_waiting": len([o for o in lab_data if o.get("status") in ["payment_confirmed", "accepted"]]),
            "patients_in_consultation": len([o for o in lab_data if o.get("status") == "accepted"]), # Mock for now or check appointments
            "patients_in_lab": len([o for o in lab_data if o.get("status") == "in_progress"]),
            "patients_in_ward": len([a for a in adm_data if a.get("status") == "active"]),
            "discharged_today": len([a for a in adm_data if a.get("discharged_at") and a.get("discharged_at").split('T')[0] == today]),
            "atlas_queries_today": len(queries.data or []),
            "critical_alerts_today": 0 # Logic could be added to count from alerts table
        }
    except Exception as e:
        return {"status": "success", "staff_online": [], "patients_waiting": 0, "patients_in_consultation": 0, "patients_in_lab": 0, "patients_in_ward": 0, "discharged_today": 0, "atlas_queries_today": 0, "critical_alerts_today": 0}

@fastapi_app.get("/api/symptoms/list")
def get_symptoms_list():
    if diagnostic_symptoms_list is None:
        return {"status": "error", "message": "Symptom list not loaded"}
    return {"status": "success", "symptoms": diagnostic_symptoms_list}

@fastapi_app.post("/api/predict/disease")
def predict_disease(data: dict):
    if disease_model is None or disease_encoder is None or diagnostic_symptoms_list is None:
        return {"status": "error", "message": "Diagnostic Engine not initialized"}
    
    selected_symptoms = data.get('symptoms', [])
    if not selected_symptoms:
        return {"status": "error", "message": "No symptoms provided"}
    
    # Create binary input vector
    input_vector = np.zeros(len(diagnostic_symptoms_list))
    for symptom in selected_symptoms:
        if symptom in diagnostic_symptoms_list:
            idx = diagnostic_symptoms_list.index(symptom)
            input_vector[idx] = 1
    
    try:
        # Get probabilities
        probs = disease_model.predict_proba([input_vector])[0]
        
        # Get top 3
        top_indices = np.argsort(probs)[-3:][::-1]
        top_3_results = []
        
        for idx in top_indices:
            top_3_results.append({
                'disease': str(disease_encoder.inverse_transform([idx])[0]),
                'probability': round(float(probs[idx]) * 100, 2)
            })
        
        return {
            "status": "success",
            "results": top_3_results,
            "symptoms_analyzed": len(selected_symptoms)
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}

@fastapi_app.post("/api/hospital/setup/complete")
def hospital_setup_complete(data: dict):
    hospital_id = data.get("hospital_id")
    specializations = data.get("specializations", [])
    total_beds = data.get("total_beds", 100)
    
    # Update hospital info
    supabase_admin.table("vela_hospitals").update({
        "specializations": specializations,
        "total_beds": total_beds
    }).eq("id", hospital_id).execute()
    
    # Update walkthrough
    supabase_admin.table("vela_walkthrough").update({
        "completed": True,
        "completed_at": datetime.utcnow().isoformat()
    }).eq("hospital_id", hospital_id).execute()
    
    return {"status": "success", "message": "Hospital setup finalized"}
