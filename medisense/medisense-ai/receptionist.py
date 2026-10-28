from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timedelta, timezone
import random
from main import (
    supabase, supabase_admin, sio, mem0_client, openai_client,
    set_active_consult, clear_active_consult, is_valid_uuid, spawn, scoped_hospital_id, error_ref,
)

router = APIRouter()

import asyncio
from typing import Dict, Any

# Global zero-dependency in-memory cache and per-doctor lock registry
AtlasClinicalCache: Dict[str, Any] = {}
_precache_inflight: set = set()
doctor_locks: Dict[str, asyncio.Lock] = {}
locks_global_lock = asyncio.Lock()  # Protects the registry of locks itself

async def get_doctor_lock(doctor_id: str) -> asyncio.Lock:
    """Gets a granular, per-doctor asyncio.Lock to prevent Doctor A blocking Doctor B.
    The global registry lock is acquired with a 2s timeout to prevent deadlocks."""
    try:
        async with asyncio.timeout(2.0):
            async with locks_global_lock:
                if doctor_id not in doctor_locks:
                    doctor_locks[doctor_id] = asyncio.Lock()
                return doctor_locks[doctor_id]
    except asyncio.TimeoutError:
        print(f"⚠️ Warning: Timed out acquiring global lock registry for doctor {doctor_id}. Creating orphan lock.")
        return asyncio.Lock()  # Return a fresh unlocked lock — safe graceful fallback

async def invalidate_and_recache(doctor_id: str):
    """
    Invalidates the lookahead cache for a specific doctor and triggers a fresh pre-cache run.
    Ensures that modifications, cancellations, or waitlist shifts refresh the lookahead cache.
    Lock acquisition is timeout-guarded (2s) to prevent deadlock propagation.
    """
    if not doctor_id:
        return
    try:
        lock = await get_doctor_lock(doctor_id)
        try:
            async with asyncio.timeout(2.0):
                async with lock:
                    AtlasClinicalCache.pop(doctor_id, None)
                    print(f"🔄 Invalidated lookahead cache for doctor {doctor_id} due to queue shift.")
        except asyncio.TimeoutError:
            # Still pop the cache even if lock times out — best-effort invalidation
            AtlasClinicalCache.pop(doctor_id, None)
            print(f"⚠️ Warning: Lock timeout during invalidation for doctor {doctor_id}. Cache force-popped.")
        # Trigger fresh pre-cache in a background task regardless
        spawn(pre_cache_next_patient(doctor_id))
    except Exception as e:
        print(f"⚠️ Warning: Failed to invalidate and recache for doctor {doctor_id}: {e}")

async def pre_cache_next_patient(doctor_id: str):
    """
    Asynchronously identifies the NEXT patient in that specific doctor's queue,
    pre-generates their Atlas summary and full payload details, and caches it under doctor_id.
    Lock acquisition is timeout-guarded (2s). The lock is ALWAYS released via try/finally.
    """
    if not doctor_id:
        return

    lock = await get_doctor_lock(doctor_id)
    acquired = False
    try:
        # Attempt to acquire the per-doctor lock with a 2s deadline
        try:
            async with asyncio.timeout(2.0):
                await lock.acquire()
                acquired = True
        except asyncio.TimeoutError:
            print(f"⚠️ Warning: Could not acquire lock for pre-caching doctor {doctor_id} within 2s. Skipping.")
            return

        print(f"🕵️ Lookahead pre-cache started for doctor {doctor_id}...")

        # 1. First, search for tickets assigned specifically to this doctor
        query = supabase_admin.table("tickets").select("*").eq("status", "waiting").eq("doctor_id", doctor_id)
        waiting = (await asyncio.to_thread(query.order("queue_position", desc=False).limit(1).execute)).data

        # 2. If no tickets are specifically assigned, check the doctor's specialization department
        if not waiting:
            staff_res = await asyncio.to_thread(supabase_admin.table("vela_staff").select("specialization").eq("id", doctor_id).execute)
            resolved_department = None
            if staff_res.data and staff_res.data[0].get("specialization"):
                resolved_department = staff_res.data[0]["specialization"]

            gen_query = supabase_admin.table("tickets").select("*").eq("status", "waiting").is_("doctor_id", "null")
            if resolved_department:
                gen_query = gen_query.eq("department", resolved_department)

            waiting = (await asyncio.to_thread(gen_query.order("queue_position", desc=False).limit(1).execute)).data

        if not waiting:
            # No patients waiting, clear cache for this doctor
            AtlasClinicalCache.pop(doctor_id, None)
            print(f"ℹ️ Pre-cache cleared for doctor {doctor_id} (No waiting patients).")
            return

        ticket = waiting[0]
        p_id = ticket["patient_id"]

        # Fetch complete details in parallel using non-blocking threads
        p_res, docs_res, meds_res, notes_res = await asyncio.gather(
            asyncio.to_thread(supabase.table("patients").select("*").eq("id", p_id).execute),
            asyncio.to_thread(supabase.table("documents").select("*").eq("patient_id", p_id).execute),
            asyncio.to_thread(supabase.table("medications").select("*").eq("patient_id", p_id).execute),
            asyncio.to_thread(supabase.table("notes").select("*").eq("patient_id", p_id).execute)
        )
        p_data = p_res.data[0] if p_res.data else None
        docs = docs_res.data or []
        meds = meds_res.data or []

        if not p_data:
            return

        all_flags = []
        for d in docs:
            if d.get("critical_flags"):
                all_flags.extend(d["critical_flags"])

        prompt = f"""
        You are Atlas, a medical AI assistant.
        A doctor just called the next patient.
        Summarize this patient clearly and concisely
        for the doctor in 3-4 sentences spoken out loud.
        Include: name, age, reason for visit, allergies,
        existing conditions, and any critical flags
        from recent reports if available.
        Be clinical. Be brief. Be useful.

        Patient data:
        Name: {p_data.get('name')}
        Age: {p_data.get('age')}
        Gender: {p_data.get('gender')}
        Allergies: {p_data.get('allergies', 'None')}
        Existing conditions: {p_data.get('existing_conditions', 'None')}
        Recent diagnosis: {p_data.get('diagnosis', 'None')}
        Ticket notes: {ticket.get('notes', 'None')}
        Recent report flags: {', '.join([str(flag) for flag in all_flags]) if all_flags else 'None'}
        """

        # OpenAI API Call wrapped in asyncio.wait_for to prevent background hangs/timeouts
        try:
            res = await asyncio.wait_for(
                asyncio.to_thread(
                    openai_client.chat.completions.create,
                    model="gpt-4o-mini",
                    messages=[{"role": "user", "content": prompt}]
                ),
                timeout=10.0
            )
            atlas_summary = res.choices[0].message.content.strip()
        except Exception as llm_err:
            print(f"⚠️ Pre-cache LLM call timed out or failed: {llm_err}")
            atlas_summary = (
                f"Welcome back, Dr. {doctor_id[:6]}. The electronic health record (EHR) for "
                f"{p_data['name']} is fully active. Live pre-cached AI summarization bypassed "
                f"due to a temporary upstream LLM network latency, but all documents, lab "
                f"history, and active medications have been loaded and are displayed below."
            )

        payload = {
            "patient_id": p_id,
            "patient_name": p_data["name"],
            "vela_id": p_data["vela_id"],
            "ticket_number": ticket["ticket_number"],
            "atlas_summary": atlas_summary,
            "patient": p_data,
            "documents": docs,
            "medications": meds,
            "ticket_id": ticket["id"]
        }

        # Save to memory cache
        AtlasClinicalCache[doctor_id] = payload
        print(f"⚡ Successfully pre-cached patient {p_data['name']} for doctor {doctor_id}!")

    except Exception as e:
        print(f"⚠️ Warning: Pre-caching lookahead failed for doctor {doctor_id}: {e}")
    finally:
        # CRITICAL: Always release the lock, even on any exception path
        if acquired:
            lock.release()



async def notify_subsequent_patient(doctor_id: str):
    """Notifies the next-in-queue patient that they are now next in line."""
    try:
        if not doctor_id:
            return
        next_waiting_query = supabase_admin.table("tickets").select("*").eq("status", "waiting").eq("doctor_id", doctor_id)
        subsequent_waiting = next_waiting_query.order("queue_position", desc=False).limit(1).execute().data
        if subsequent_waiting:
            sub_ticket = subsequent_waiting[0]
            sub_p_id = sub_ticket["patient_id"]
            sub_p_data = supabase_admin.table("patients").select("name").eq("id", sub_p_id).execute().data
            if sub_p_data:
                sub_p_name = sub_p_data[0]["name"]
                await sio.emit("upcoming_patient_notification", {
                    "patient_id": sub_p_id,
                    "patient_name": sub_p_name,
                    "ticket_number": sub_ticket["ticket_number"],
                    "message": "You are next in line! Please make your way toward the consultation room."
                })
    except Exception as sub_err:
        print(f"Skipping subsequent patient waiting room notification: {sub_err}")

def ensure_doctor_mirrored(doctor_id: str):
    """Mirror a vela_staff doctor into the doctors table if not present.
    This satisfies the FK constraint appointments.doctor_id -> doctors.id."""
    try:
        doc_exists = supabase_admin.table("doctors").select("id").eq("id", doctor_id).execute()
        if not doc_exists.data:
            staff_res = supabase_admin.table("vela_staff").select("*").eq("id", doctor_id).execute()
            if staff_res.data:
                staff_doc = staff_res.data[0]
                h_name = "Vela Hospital"
                if staff_doc.get("hospital_id"):
                    h_res = supabase_admin.table("vela_hospitals").select("name").eq("id", staff_doc["hospital_id"]).execute()
                    if h_res.data:
                        h_name = h_res.data[0]["name"]
                supabase_admin.table("doctors").insert({
                    "id": doctor_id,
                    "name": staff_doc.get("name", "Doctor"),
                    "specialization": staff_doc.get("specialization") or "General Physician",
                    "hospital": h_name,
                    "available": True
                }).execute()
    except Exception as e:
        print(f"⚠️ Warning: doctor mirror failed: {e}")

def generate_vela_id() -> str:
    for _ in range(10):
        number = random.randint(1000, 9999)
        vela_id = f"VLA-{number}"
        existing = supabase.table("patients").select("id").eq("vela_id", vela_id).execute()
        if not existing.data:
            return vela_id
    raise Exception("Could not generate unique VELA ID")

# Models
class RegisterPatientRequest(BaseModel):
    name: str
    age: str
    gender: str
    blood_group: str = ""
    height: str = ""
    weight: str = ""
    allergies: str = ""
    existing_conditions: str = ""
    emergency_contact: str = ""
    email: str = ""
    phone: str = ""
    date_of_birth: str = ""
    emergency_contact_name: str = ""
    emergency_contact_phone: str = ""
    emergency_contact_relation: str = ""
    insurance_id: str = ""
    insurance_provider: str = ""
    language: str = "English"
    ward: str = "General"
    room: str = ""
    doctor: str = ""
    diagnosis: str = ""
    registered_by: str = "receptionist"
    hospital_id: Optional[str] = None

class TicketCreateRequest(BaseModel):
    vela_id: str
    department: str = "General"
    doctor_id: Optional[str] = None
    notes: str = ""
    triage_level: str = "Routine"
    hospital_id: Optional[str] = None

class NextPatientRequest(BaseModel):
    doctor_id: Optional[str] = None
    department: Optional[str] = None
    hospital_id: Optional[str] = None

class CompletePatientRequest(BaseModel):
    ticket_id: str
    doctor_notes: str = ""
    medications_prescribed: List[str] = []
    tests_ordered: List[str] = []

class BookAppointmentRequest(BaseModel):
    patient_id: str
    doctor_id: str
    date: str
    time: str
    triage_level: str = "Routine"
    reason: str = ""


# 1. Register new patient
@router.post("/api/receptionist/register")
async def register_patient(data: RegisterPatientRequest):
    if not data.name or not data.age or not data.gender:
        return {"status": "error", "message": "Name, age, and gender are required"}
    
    try:
        vela_id = generate_vela_id()
    except Exception as e:
        return {"status": "error", "message": f"Something went wrong (ref {error_ref(e)})"}

    # Insert into patients (hospital_id is NOT a column on the patients table)
    result = supabase.table("patients").insert({
        "name": data.name,
        "age": data.age,
        "gender": data.gender,
        "blood_group": data.blood_group,
        "height": data.height,
        "weight": data.weight,
        "allergies": data.allergies,
        "existing_conditions": data.existing_conditions,
        "emergency_contact": data.emergency_contact,
        "email": data.email,
        "phone": data.phone,
        "date_of_birth": data.date_of_birth,
        "emergency_contact_name": data.emergency_contact_name,
        "emergency_contact_phone": data.emergency_contact_phone,
        "emergency_contact_relation": data.emergency_contact_relation,
        "insurance_id": data.insurance_id,
        "insurance_provider": data.insurance_provider,
        "language": data.language,
        "ward": data.ward,
        "room": data.room,
        "doctor": data.doctor,
        "diagnosis": data.diagnosis,
        "registered_by": data.registered_by,
        "status": "waiting",
        "risk_score": 0,
        "vela_id": vela_id,
        "atlas_analysis": "",
        "atlas_confidence": "LOW",
        "atlas_analysis_updated_at": None
        # admitted_at is defaulted to now in DB schema
    }).execute()

    patient = result.data[0]
    
    # Store in Mem0
    if mem0_client:
        try:
            mem_msg = f"Patient {data.name} registered. Age: {data.age}. Gender: {data.gender}. Blood group: {data.blood_group}. Allergies: {data.allergies}. Existing conditions: {data.existing_conditions}."
            mem0_client.add(
                messages=[{"role": "user", "content": mem_msg}],
                user_id=patient["id"]
            )
        except Exception as mem_err:
            print(f"⚠️ Warning: Failed to add patient registration to mem0 client: {mem_err}")

    # Emit socket event
    await sio.emit("patient_registered", {
        "patient_id": patient["id"],
        "vela_id": vela_id,
        "name": data.name,
        "ward": data.ward
    })

    return {
        "status": "success",
        "patient": patient,
        "vela_id": vela_id,
        "message": "Patient registered successfully"
    }


# 1b. Patient self-registration (public — a patient signing up has no session yet)
@router.post("/api/patient/self-register")
async def self_register_patient(data: RegisterPatientRequest):
    # This route is unauthenticated by necessity, so the caller is not trusted
    # to set clinical or placement fields: pin the provenance flag and reset
    # ward/room/doctor/diagnosis to their defaults. Only staff, going through
    # the authenticated /api/receptionist/register above, may set those.
    data.registered_by = "patient_self"
    data.ward = "General"
    data.room = ""
    data.doctor = ""
    data.diagnosis = ""
    data.hospital_id = None
    data.email = (data.email or "").strip()
    if data.email:
        # Signing up must never hand out a session for someone else's record.
        existing = await asyncio.to_thread(
            lambda: supabase_admin.table("patients").select("id").ilike("email", data.email).limit(1).execute()
        )
        if existing.data:
            return {"status": "error", "code": "email_exists",
                    "message": "You already have a VELA record with this email. Please sign in instead."}
    result = await register_patient(data)
    if result.get("status") != "success":
        return result
    # The new patient is signed in straight away, so booking right after
    # signing up works (portal principle: booking without a separate account).
    from main import patient_session_payload
    return {**result, **patient_session_payload(result["patient"])}


# 2. Lookup patient by VELA ID
@router.get("/api/receptionist/lookup/{vela_id}")
def lookup_patient(vela_id: str):
    patients = supabase.table("patients").select("*").eq("vela_id", vela_id).execute()
    if not patients.data:
        return {"status": "error", "message": f"No patient found with VELA ID {vela_id}"}
    
    patient = patients.data[0]
    p_id = patient["id"]

    docs = supabase.table("documents").select("*").eq("patient_id", p_id).execute().data
    meds = supabase.table("medications").select("*").eq("patient_id", p_id).execute().data
    notes = supabase.table("notes").select("*").eq("patient_id", p_id).execute().data
    rems = supabase.table("reminders").select("*").eq("patient_id", p_id).execute().data
    tickets = supabase.table("tickets").select("*").eq("patient_id", p_id).execute().data
    blood_tests = supabase.table("blood_tests").select("*").eq("patient_id", p_id).execute().data

    # Visit counts
    completed_tickets = [t for t in tickets if t["status"] == "completed"]
    completed_tickets.sort(key=lambda t: t.get("completed_at") or "", reverse=True)
    last_visit = completed_tickets[0]["completed_at"] if completed_tickets else None

    return {
        "status": "success",
        "patient": patient,
        "documents": docs,
        "medications": meds,
        "notes": notes,
        "reminders": rems,
        "tickets": tickets,
        "blood_tests": blood_tests,
        "visit_count": len(completed_tickets),
        "last_visit": last_visit
    }


# 3. Create ticket for patient
@router.post("/api/receptionist/ticket/create")
async def create_ticket(data: TicketCreateRequest):
    patients = supabase.table("patients").select("*").eq("vela_id", data.vela_id).execute()
    if not patients.data:
        return {"status": "error", "message": f"No patient found with VELA ID {data.vela_id}"}
    patient = patients.data[0]
    h_id = data.hospital_id if data.hospital_id else patient.get("hospital_id")

    # Generate ticket number TKT-YYYYMMDD-XXXX
    today_str = datetime.now().strftime("%Y%m%d")
    today_query = supabase.table("tickets").select("*").like("ticket_number", f"TKT-{today_str}-%")
    today_tickets = today_query.execute().data
    count_today = len(today_tickets) + 1
    ticket_number = f"TKT-{today_str}-{count_today:04d}"

    # Get queue position.
    #
    # Emergencies must be seen first. Previously every ticket was appended with
    # len(waiting) + 1 regardless of triage_level, and get_queue/next_patient
    # both order purely on queue_position — so an emergency walk-in was placed
    # BEHIND everyone already waiting. Emergencies now take a position below the
    # current minimum (going 0, -1, -2 …), which sorts them to the front of
    # every existing ascending query without a schema change. get_queue
    # renumbers to 1..n for display, so the negatives never reach the UI.
    waiting_query = supabase.table("tickets").select("*").eq("status", "waiting").eq("department", data.department)
    waiting = waiting_query.execute().data

    is_emergency = str(data.triage_level or "").strip().lower() in (
        "emergency", "urgent", "critical", "immediate"
    )
    if is_emergency:
        existing_positions = [t.get("queue_position") or 0 for t in waiting]
        q_pos = (min(existing_positions) - 1) if existing_positions else 0
    else:
        q_pos = len(waiting) + 1

    ticket_data = {
        "ticket_number": ticket_number,
        "patient_id": patient["id"],
        "vela_id": data.vela_id,
        "department": data.department,
        "doctor_id": data.doctor_id,
        "status": "waiting",
        "queue_position": q_pos,
        "notes": data.notes,
        "triage_level": data.triage_level
    }
    result = supabase.table("tickets").insert(ticket_data).execute()
    inserted_ticket = result.data[0]

    await sio.emit("queue_updated", {
        "department": data.department,
        "queue_position": q_pos,
        "ticket_number": ticket_number,
        "patient_name": patient["name"],
        "vela_id": data.vela_id,
        "triage_level": data.triage_level,
        "is_emergency": is_emergency,
        "hospital_id": h_id,
    })

    # Separate, unmissable signal for emergencies so clinical screens can alert
    # rather than quietly re-sorting a list nobody is watching.
    if is_emergency:
        await sio.emit("emergency_intake", {
            "patient_name": patient["name"],
            "patient_id": patient["id"],
            "vela_id": data.vela_id,
            "department": data.department,
            "ticket_number": ticket_number,
            "notes": data.notes,
            "hospital_id": h_id,
        })

    if data.doctor_id:
        spawn(invalidate_and_recache(data.doctor_id))

    return {
        "status": "success",
        "ticket": inserted_ticket,
        "ticket_number": ticket_number,
        "queue_position": q_pos,
        "patient_name": patient["name"],
        "estimated_wait": f"~{q_pos * 15} minutes" # Rough estimate
    }


# 4. Get current queue
@router.get("/api/receptionist/queue")
async def get_queue(department: Optional[str] = None, doctor_id: Optional[str] = None, hospital_id: Optional[str] = None, include_active: bool = False):
    hospital_id = scoped_hospital_id(hospital_id)
    query = supabase.table("tickets").select("*, patients(name)")
    # The doctor dashboard also needs the patient currently in the room (in-progress);
    # every other caller (reception) wants the waiting line only.
    query = query.in_("status", ["waiting", "in-progress"]) if include_active else query.eq("status", "waiting")
    if department:
        query = query.eq("department", department)
    if doctor_id:
        # Specific doctor requested — no need to cross-filter by hospital staff list
        query = query.eq("doctor_id", doctor_id)
    elif hospital_id:
        # No specific doctor — scope to all doctors in this hospital
        from main import get_valid_hospital_id
        hospital_id = get_valid_hospital_id(hospital_id)
        try:
            staff_res = await asyncio.to_thread(supabase.table("vela_staff").select("id").eq("hospital_id", hospital_id).execute)
            staff_ids = [s["id"] for s in staff_res.data] if staff_res.data else []
            if staff_ids:
                query = query.in_("doctor_id", staff_ids)
            else:
                return {"status": "success", "queue": [], "total_waiting": 0}
        except Exception:
            pass

    tickets_res = (await asyncio.to_thread(query.order("queue_position", desc=False).execute)).data

    # Keep the "next patient" ready before the doctor asks: the dashboard polls this endpoint,
    # so a cold cache (server restart, first login) is warmed within one poll cycle.
    if doctor_id and doctor_id not in AtlasClinicalCache and doctor_id not in _precache_inflight and any(t.get("status") == "waiting" for t in tickets_res):
        _precache_inflight.add(doctor_id)
        async def _warm(did=doctor_id):
            try:
                await pre_cache_next_patient(did)
            finally:
                _precache_inflight.discard(did)
        spawn(_warm())

    if include_active:
        # A doctor sees one patient at a time. Old sessions that never got "completed" must not
        # pile up as phantom in-progress patients: keep only the most recent one, and only if recent.
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        def _ts(t):
            try:
                return datetime.fromisoformat(t["created_at"].replace("Z", "+00:00"))
            except Exception:
                return datetime.min.replace(tzinfo=timezone.utc)
        active = sorted((t for t in tickets_res if t.get("status") == "in-progress" and _ts(t) >= cutoff), key=_ts, reverse=True)[:1]
        tickets_res = active + [t for t in tickets_res if t.get("status") != "in-progress"]

    queue_list = []
    for display_pos, t in enumerate(tickets_res, start=1):
        wait_mins = 0
        if t.get("created_at"):
            try:
                dt_str = t["created_at"].replace("Z", "+00:00")
                created_dt = datetime.fromisoformat(dt_str)
                now_dt = datetime.now(created_dt.tzinfo)
                wait_mins = int((now_dt - created_dt).total_seconds() / 60)
            except:
                pass

        queue_list.append({
            "id": t.get("id"),
            "status": t.get("status", "waiting"),
            "ticket_number": t["ticket_number"],
            # Renumbered 1..n from the sorted order. The stored position can be
            # 0 or negative for emergencies (see create_ticket) — correct for
            # sorting, meaningless to a receptionist reading a queue.
            "queue_position": display_pos,
            "stored_position": t["queue_position"],
            "patient_name": t["patients"]["name"] if t.get("patients") else "Unknown",
            "vela_id": t["vela_id"],
            "patient_id": t["patient_id"],
            "department": t["department"],
            "notes": t["notes"],
            "triage_level": t.get("triage_level", "Routine"),
            "doctor_id": t.get("doctor_id"),
            "waiting_since": t["created_at"],
            "wait_minutes": wait_mins
        })

    return {
        "status": "success",
        "queue": queue_list,
        "total_waiting": len([q for q in queue_list if q["status"] == "waiting"])
    }



# 5. Doctor calls next patient
@router.post("/api/doctor/next-patient")
async def next_patient(data: NextPatientRequest):
    data.hospital_id = scoped_hospital_id(data.hospital_id)
    # Determine the doctor's hospital and specialization to scope waitlist correctly
    resolved_hospital_id = data.hospital_id
    resolved_department = data.department
    
    if data.doctor_id:
        try:
            staff_res = supabase_admin.table("vela_staff").select("hospital_id, specialization").eq("id", data.doctor_id).execute()
            if staff_res.data:
                staff_info = staff_res.data[0]
                if not resolved_hospital_id and staff_info.get("hospital_id"):
                    resolved_hospital_id = staff_info["hospital_id"]
                if (not resolved_department or resolved_department == "General") and staff_info.get("specialization"):
                    resolved_department = staff_info["specialization"]
        except Exception:
            pass

    # --- 1. ZERO-LATENCY CACHE LOOKUP ---
    cached_payload = None
    if data.doctor_id:
        try:
            lock = await get_doctor_lock(data.doctor_id)
            async with asyncio.timeout(2.0):
                async with lock:
                    cached_payload = AtlasClinicalCache.pop(data.doctor_id, None)
        except asyncio.TimeoutError:
            print(f"⚠️ Warning: Cache lock timeout for doctor {data.doctor_id}. Proceeding to fallback.")
            cached_payload = None

    if cached_payload:
        print(f"🎯 Zero-Latency Cache HIT for doctor {data.doctor_id}!")
        ticket_id = cached_payload.pop("ticket_id", None)
        
        # Update ticket details in Supabase asynchronously
        if ticket_id:
            try:
                update_payload = {
                    "status": "in-progress",
                    "called_at": datetime.utcnow().isoformat()
                }
                if data.doctor_id:
                    update_payload["doctor_id"] = data.doctor_id
                await asyncio.to_thread(
                    supabase_admin.table("tickets").update(update_payload).eq("id", ticket_id).execute
                )
            except Exception as e:
                print(f"⚠️ Warning: Failed to update ticket status on cache hit: {e}")
                
        # This doctor is now consulting this patient — Atlas resolves "him/her"
        # from here, so no one has to say the name again.
        set_active_consult(
            data.doctor_id,
            cached_payload.get("patient_id") or (cached_payload.get("patient") or {}).get("id"),
            cached_payload.get("patient_name") or (cached_payload.get("patient") or {}).get("name"),
            ticket_id=ticket_id,
        )

        # Emit next_patient to Socket.IO room
        await sio.emit("next_patient", cached_payload)
        
        # Trigger background updates and new next lookahead pre-cache asynchronously
        if data.doctor_id:
            spawn(notify_subsequent_patient(data.doctor_id))
            spawn(pre_cache_next_patient(data.doctor_id))
            
            # Broadcast queue shift to hospital room in real time!
            if resolved_hospital_id:
                try:
                    wait_count = supabase.table("tickets").select("id", count="exact").eq("status", "waiting").execute().count or 0
                    await sio.emit("queue_position_update", {"doctor_id": data.doctor_id, "next_waiting": wait_count}, room=resolved_hospital_id)
                except Exception:
                    pass
            
        return {
            "status": "success",
            "message": "Patient called from zero-latency lookahead cache",
            "patient": cached_payload["patient"],
            "atlas_summary": cached_payload["atlas_summary"],
            "documents": cached_payload["documents"],
            "medications": cached_payload["medications"]
        }

    # --- 2. GRACEFUL CACHE-MISS FALLBACK ---
    print(f"⚠️ Cache MISS for doctor {data.doctor_id}! Falling back to synchronous LLM generation.")
    
    # First, search for tickets assigned specifically to this doctor
    query = supabase_admin.table("tickets").select("*").eq("status", "waiting")
    if data.doctor_id:
        query = query.eq("doctor_id", data.doctor_id)
        
    waiting = query.order("queue_position", desc=False).limit(1).execute().data
    
    # If no tickets specifically assigned, check the general waitlist
    if not waiting and data.doctor_id:
        gen_query = supabase_admin.table("tickets").select("*").eq("status", "waiting").is_("doctor_id", "null")
        if resolved_department:
            gen_query = gen_query.eq("department", resolved_department)
            
        waiting = gen_query.order("queue_position", desc=False).limit(1).execute().data
    
    if not waiting:
        return {"status": "success", "message": "No patients waiting", "patient": None}
    
    ticket = waiting[0]
    
    # Update ticket details & assign doctor_id
    update_payload = {
        "status": "in-progress",
        "called_at": datetime.utcnow().isoformat()
    }
    if not ticket.get("doctor_id") and data.doctor_id:
        update_payload["doctor_id"] = data.doctor_id

    updated = supabase_admin.table("tickets").update(update_payload).eq("id", ticket["id"]).execute().data[0]

    # Fetch complete details in parallel
    p_id = ticket["patient_id"]
    p_res, docs_res, meds_res, notes_res = await asyncio.gather(
        asyncio.to_thread(supabase.table("patients").select("*").eq("id", p_id).execute),
        asyncio.to_thread(supabase.table("documents").select("*").eq("patient_id", p_id).execute),
        asyncio.to_thread(supabase.table("medications").select("*").eq("patient_id", p_id).execute),
        asyncio.to_thread(supabase.table("notes").select("*").eq("patient_id", p_id).execute)
    )
    p_data = p_res.data[0] if p_res.data else None
    docs = docs_res.data or []
    meds = meds_res.data or []
    notes = notes_res.data or []

    if not p_data:
        return {"status": "error", "message": "Patient not found"}

    # Gather critical flags
    all_flags = []
    for d in docs:
        if d.get("critical_flags"):
            all_flags.extend(d["critical_flags"])
    
    prompt = f"""
    You are Atlas, a medical AI assistant.
    A doctor just called the next patient.
    Summarize this patient clearly and concisely
    for the doctor in 3-4 sentences spoken out loud.
    Include: name, age, reason for visit, allergies,
    existing conditions, and any critical flags
    from recent reports if available.
    Be clinical. Be brief. Be useful.

    Patient data:
    Name: {p_data.get('name')}
    Age: {p_data.get('age')}
    Gender: {p_data.get('gender')}
    Allergies: {p_data.get('allergies', 'None')}
    Existing conditions: {p_data.get('existing_conditions', 'None')}
    Recent diagnosis: {p_data.get('diagnosis', 'None')}
    Ticket notes: {ticket.get('notes', 'None')}
    Recent report flags: {', '.join([str(flag) for flag in all_flags]) if all_flags else 'None'}
    """

    # OpenAI API Call wrapped in asyncio.wait_for to prevent background hangs/timeouts
    try:
        res = await asyncio.wait_for(
            asyncio.to_thread(
                openai_client.chat.completions.create,
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}]
            ),
            timeout=8.0
        )
        atlas_summary = res.choices[0].message.content.strip()
    except Exception as llm_err:
        print(f"⚠️ Cache-miss fallback LLM call timed out or failed: {llm_err}")
        atlas_summary = (
            f"Welcome. The patient {p_data.get('name')} is ready for their consult. "
            f"Due to an upstream LLM latency, the live verbal summary was bypassed, "
            f"but their clinical history, documents, and medications are fully loaded below."
        )

    payload = {
        "patient_id": p_id,
        "patient_name": p_data["name"],
        "vela_id": p_data["vela_id"],
        "ticket_number": ticket["ticket_number"],
        "atlas_summary": atlas_summary,
        "patient": p_data,
        "documents": docs,
        "medications": meds
    }

    set_active_consult(data.doctor_id, p_id, p_data.get("name"), ticket_id=ticket["id"])

    await sio.emit("next_patient", payload)

    # Fire subsequent patient waiting room notification and lookahead cache task
    if data.doctor_id:
        spawn(notify_subsequent_patient(data.doctor_id))
        spawn(pre_cache_next_patient(data.doctor_id))
        
        # Broadcast queue shift to hospital room
        if resolved_hospital_id:
            try:
                wait_count = supabase.table("tickets").select("id", count="exact").eq("status", "waiting").execute().count or 0
                await sio.emit("queue_position_update", {"doctor_id": data.doctor_id, "next_waiting": wait_count}, room=resolved_hospital_id)
            except Exception:
                pass

    return {
        "status": "success",
        "patient": p_data,
        "ticket": updated,
        "atlas_summary": atlas_summary,
        "documents": docs,
        "medications": meds
    }


# 6. Complete current patient
@router.post("/api/doctor/complete-patient")
async def complete_patient(data: CompletePatientRequest):
    # Complete the ticket
    ticket_res = supabase.table("tickets").update({
        "status": "completed",
        "completed_at": "NOW()"
    }).eq("id", data.ticket_id).execute().data

    if not ticket_res:
         return {"status": "error", "message": "Ticket not found"}
    ticket = ticket_res[0]

    patient = supabase.table("patients").select("name").eq("id", ticket["patient_id"]).execute().data[0]

    if data.doctor_notes:
        supabase.table("notes").insert({
            "patient_id": ticket["patient_id"],
            "content": data.doctor_notes,
            "created_by": "Doctor"
        }).execute()

    if data.tests_ordered:
        for t in data.tests_ordered:
            supabase.table("blood_tests").insert({
                "patient_id": ticket["patient_id"],
                "ordered_by": ticket.get("doctor_id"),
                "test_name": t,
                "status": "pending"
            }).execute()

    # Find next waiting count
    wait_count = supabase.table("tickets").select("id", count="exact").eq("status", "waiting").execute().count or 0

    await sio.emit("patient_completed", {
        "ticket_id": data.ticket_id,
        "patient_name": patient["name"],
        "next_queue_count": wait_count
    })

    if ticket.get("doctor_id"):
        clear_active_consult(ticket["doctor_id"])
        spawn(invalidate_and_recache(ticket["doctor_id"]))

    return {
        "status": "success",
        "message": "Patient consultation completed",
        "tests_ordered": data.tests_ordered,
        "next_waiting": wait_count
    }


# 7. Get doctors status for a hospital
@router.get("/api/receptionist/doctors-status")
def get_doctors_status(hospital_id: str):
    from main import get_valid_hospital_id
    hospital_id = get_valid_hospital_id(hospital_id)

    # Fetch all doctors for this hospital
    docs_res = supabase_admin.table("vela_staff").select("*") \
                   .eq("hospital_id", hospital_id).eq("role", "doctor").eq("active", True).execute()
    doctors = docs_res.data or []
    doctor_ids = [d["id"] for d in doctors]

    # Scope ticket queries ONLY to today's date and ONLY to this hospital's doctors
    # to prevent cross-day and cross-hospital phantom counts.
    today_str = datetime.now().strftime("%Y-%m-%d")   # e.g. "2026-05-28"

    doctor_stats = []
    for d in doctors:
        doc_id = d["id"]
        try:
            wait_res = (
                supabase.table("tickets").select("id", count="exact")
                .eq("status", "waiting")
                .eq("doctor_id", doc_id)
                .gte("created_at", f"{today_str}T00:00:00")
                .execute()
            )
            consult_res = (
                supabase.table("tickets").select("id", count="exact")
                .eq("status", "in-progress")
                .eq("doctor_id", doc_id)
                .gte("created_at", f"{today_str}T00:00:00")
                .execute()
            )
            waiting_count   = wait_res.count   or 0
            consulting_count = consult_res.count or 0
        except Exception:
            waiting_count   = 0
            consulting_count = 0

        doctor_stats.append({
            "id":              doc_id,
            "name":            d["name"],
            "specialization":  d.get("specialization", "General"),
            "online":          d.get("online", False),
            "waiting_count":   waiting_count,
            "consulting_count": consulting_count,
        })

    return {
        "status":  "success",
        "doctors": doctor_stats,
    }

# 8. Assign doctor to a patient/appointment
@router.put("/api/receptionist/assign-doctor")
async def assign_doctor(data: dict):
    apt_id = data.get("appointment_id")
    doctor_id = data.get("doctor_id")
    triage_level = data.get("triage_level", "Routine")
    
    if not apt_id or not doctor_id:
        return {"status": "error", "message": "Missing required fields"}
    
    # Ensure doctor exists in doctors table (FK requirement before updating appointment)
    ensure_doctor_mirrored(doctor_id)
        
    # 1. Update appointment
    supabase_admin.table("appointments").update({
        "status": "arrived",
        "doctor_id": doctor_id,
        "triage_level": triage_level
    }).eq("id", apt_id).execute()
    
    # 2. Extract patient info for ticket
    apt = supabase_admin.table("appointments").select("*, patients(name, vela_id)").eq("id", apt_id).execute().data[0]
    patient = apt["patients"]
    
    # Generate ticket
    today_str = datetime.now().strftime("%Y%m%d")
    today_tickets = supabase.table("tickets").select("*").like("ticket_number", f"TKT-{today_str}-%").execute().data
    count_today = len(today_tickets) + 1
    ticket_number = f"TKT-{today_str}-{count_today:04d}"
    
    # Position in DOCTOR'S queue
    waiting_for_doc = supabase.table("tickets").select("*").eq("status", "waiting").eq("doctor_id", doctor_id).execute().data
    q_pos = len(waiting_for_doc) + 1
    
    ticket_data = {
        "ticket_number": ticket_number,
        "patient_id": apt["patient_id"],
        "vela_id": patient["vela_id"],
        "department": "General",
        "doctor_id": doctor_id,
        "status": "waiting",
        "queue_position": q_pos,
        "triage_level": triage_level,
        "notes": f"Appointment Arrival: {apt.get('reason', '')}"
    }
    
    res = supabase.table("tickets").insert(ticket_data).execute()
    
    await sio.emit("queue_updated", {
        "doctor_id": doctor_id,
        "patient_name": patient["name"],
        "ticket_number": ticket_number
    })
    
    if doctor_id:
        spawn(invalidate_and_recache(doctor_id))
        
    return {
        "status": "success",
        "ticket": res.data[0],
        "queue_position": q_pos
    }


# 7. Get all doctors
@router.get("/api/doctors/list")
def list_doctors():
    docs = supabase.table("doctors").select("*").execute().data
    return {
        "status": "success",
        "doctors": docs
    }


# 7.5. Mark Patient Arrived
@router.post("/api/receptionist/appointment/{appointment_id}/arrive")
async def mark_patient_arrived(appointment_id: str):
    """
    1. Finds the exact appointment row.
    2. Updates status to 'arrived' to prevent double-clicking/duplication.
    3. Safely inserts a fresh tracking row into the live `tickets` table.
    """
    try:
        # Step 1: Fetch and verify appointment exists
        appointment_res = supabase.table("appointments").select("*").eq("id", appointment_id).execute()
        if not appointment_res.data:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No appointments found with this ID")
        
        appointment = appointment_res.data[0]
        if appointment.get("status") == "arrived":
            return {"status": "success", "message": "Patient already checked in"}

        # Step 2: Mutate status column cleanly
        supabase.table("appointments").update({"status": "arrived"}).eq("id", appointment_id).execute()

        # Step 3: Fetch patient and generate ticket details
        patient_id = appointment["patient_id"]
        patient_res = supabase.table("patients").select("*").eq("id", patient_id).execute()
        patient_data = patient_res.data[0] if patient_res.data else {}

        # Generate ticket number TKT-YYYYMMDD-XXXX
        today_str = datetime.now().strftime("%Y%m%d")
        today_tickets = supabase.table("tickets").select("*").like("ticket_number", f"TKT-{today_str}-%").execute().data
        count_today = len(today_tickets) + 1 if today_tickets else 1
        ticket_number = f"TKT-{today_str}-{count_today:04d}"

        # Get queue position
        waiting = supabase.table("tickets").select("*").eq("status", "waiting").execute().data
        q_pos = len(waiting) + 1 if waiting else 1

        # Spin up the live queue ticket row
        ticket_payload = {
            "ticket_number": ticket_number,
            "patient_id": patient_id,
            "vela_id": patient_data.get("vela_id"),
            "department": "General",
            "status": "waiting",
            "queue_position": q_pos,
            "doctor_id": appointment.get("doctor_id"),
            "notes": f"Appointment Arrival: {appointment.get('appointment_time') or appointment.get('time') or ''}"
        }
        new_ticket = supabase.table("tickets").insert(ticket_payload).execute()
        
        # Step 4: Synchronize all open UI windows across the clinic
        if appointment.get("doctor_id"):
            await invalidate_and_recache(appointment["doctor_id"])
        
        await sio.emit("queue_updated", {"type": "arrival", "patient_name": patient_data.get("name")})
        await sio.emit("queue_position_update", {
            "clinic_id": appointment.get("clinic_id") or appointment.get("hospital_id"),
            "doctor_id": appointment.get("doctor_id")
        })

        return {
            "status": "success", 
            "ticket": new_ticket.data[0] if new_ticket.data else None,
            "ticket_number": ticket_number,
            "queue_position": q_pos
        }
        
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=f"Internal Database Failure (ref {error_ref(e)})")



# 7.6. Live per-doctor queue stats (kills the phantom counter bug)
@router.get("/api/doctor/{doctor_id}/queue-stats")
def get_doctor_queue_stats(doctor_id: str):
    """
    Returns real-time WAIT and CONSULT counts scoped EXCLUSIVELY to
    the specified doctor_id, preventing the global-count desync.
    """
    try:
        wait_res   = supabase.table("tickets").select("id", count="exact") \
                        .eq("status", "waiting").eq("doctor_id", doctor_id).execute()
        consult_res = supabase.table("tickets").select("id", count="exact") \
                        .eq("status", "in-progress").eq("doctor_id", doctor_id).execute()
        return {
            "status": "success",
            "doctor_id": doctor_id,
            "waiting_count":   wait_res.count   or 0,
            "consulting_count": consult_res.count or 0,
        }
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Queue-stats failure (ref {error_ref(e)})"
        )


# 7.7. Per-doctor next patient (locked, chronological, race-condition-safe)
@router.post("/api/doctor/{doctor_id}/next-patient")
async def next_patient_for_doctor(doctor_id: str, data: NextPatientRequest):
    """
    Thread-safe, per-doctor next-patient endpoint.
    1. Acquires the doctor's individual asyncio.Lock so concurrent calls
       from the same doctor cannot pull the same patient twice.
    2. Looks for the OLDEST waiting ticket specifically assigned to this doctor.
    3. Falls back to the oldest unassigned (pooled) ticket in the doctor's department.
    4. Immediately marks it in-progress under the lock, assigns doctor_id,
       fetches the patient payload, and returns it.
    """
    data.hospital_id = scoped_hospital_id(data.hospital_id)
    # Merge any request-body context with the URL path param
    data.doctor_id = doctor_id

    resolved_department = data.department
    resolved_hospital_id = data.hospital_id

    # Resolve specialization / hospital from vela_staff table
    try:
        staff_res = supabase_admin.table("vela_staff") \
                        .select("hospital_id, specialization") \
                        .eq("id", doctor_id).execute()
        if staff_res.data:
            info = staff_res.data[0]
            if not resolved_hospital_id:
                resolved_hospital_id = info.get("hospital_id")
            if (not resolved_department or resolved_department == "General") and info.get("specialization"):
                resolved_department = info["specialization"]
    except Exception:
        pass

    lock = await get_doctor_lock(doctor_id)
    try:
        async with asyncio.timeout(5.0):
            async with lock:
                # 1. Try assigned queue first
                waiting = (
                    supabase_admin.table("tickets").select("*")
                    .eq("status", "waiting")
                    .eq("doctor_id", doctor_id)
                    .order("queue_position", desc=False)
                    .limit(1)
                    .execute()
                    .data
                )

                # 2. Fall back to open pool in the same department
                if not waiting:
                    pool_q = (
                        supabase_admin.table("tickets").select("*")
                        .eq("status", "waiting")
                        .is_("doctor_id", "null")
                    )
                    if resolved_department:
                        pool_q = pool_q.eq("department", resolved_department)
                    waiting = pool_q.order("queue_position", desc=False).limit(1).execute().data

                if not waiting:
                    return {"status": "success", "message": "No patients waiting", "patient": None}

                ticket = waiting[0]

                # 3. Atomically promote ticket to in-progress
                update_payload = {"status": "in-progress", "called_at": datetime.utcnow().isoformat()}
                if not ticket.get("doctor_id"):
                    update_payload["doctor_id"] = doctor_id

                updated = (
                    supabase_admin.table("tickets")
                    .update(update_payload)
                    .eq("id", ticket["id"])
                    .execute()
                    .data[0]
                )

    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Queue lock acquisition timed out — please try again"
        )

    # 4. Fetch rich patient context
    p_id = ticket["patient_id"]
    p_res, docs_res, meds_res, notes_res = await asyncio.gather(
        asyncio.to_thread(supabase.table("patients").select("*").eq("id", p_id).execute),
        asyncio.to_thread(supabase.table("documents").select("*").eq("patient_id", p_id).execute),
        asyncio.to_thread(supabase.table("medications").select("*").eq("patient_id", p_id).execute),
        asyncio.to_thread(supabase.table("notes").select("*").eq("patient_id", p_id).execute),
    )
    p_data = p_res.data[0] if p_res.data else None
    docs   = docs_res.data  or []
    meds   = meds_res.data  or []

    if not p_data:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Patient record not found")

    # 5. Gather critical flags for Atlas summary
    all_flags = []
    for d in docs:
        if d.get("critical_flags"):
            all_flags.extend(d["critical_flags"])

    prompt = f"""
    You are Atlas, a medical AI assistant.
    A doctor just called the next patient.
    Summarize this patient clearly and concisely for the doctor in 3-4 sentences.
    Include: name, age, reason for visit, allergies, existing conditions, and any
    critical flags from recent reports if available. Be clinical. Be brief. Be useful.

    Patient data:
    Name: {p_data.get('name')}
    Age: {p_data.get('age')}
    Gender: {p_data.get('gender')}
    Allergies: {p_data.get('allergies', 'None')}
    Existing conditions: {p_data.get('existing_conditions', 'None')}
    Recent diagnosis: {p_data.get('diagnosis', 'None')}
    Ticket notes: {ticket.get('notes', 'None')}
    Recent report flags: {', '.join([str(f) for f in all_flags]) if all_flags else 'None'}
    """

    try:
        llm_res = await asyncio.wait_for(
            asyncio.to_thread(
                openai_client.chat.completions.create,
                model="gpt-4o-mini",
                messages=[{"role": "user", "content": prompt}]
            ),
            timeout=8.0
        )
        atlas_summary = llm_res.choices[0].message.content.strip()
    except Exception:
        atlas_summary = (
            f"Patient {p_data.get('name')} is ready for consultation. "
            "Atlas AI summary temporarily unavailable — full clinical record is loaded below."
        )

    payload = {
        "patient_id":    p_id,
        "patient_name":  p_data["name"],
        "vela_id":       p_data.get("vela_id"),
        "ticket_number": ticket["ticket_number"],
        "atlas_summary": atlas_summary,
        "patient":       p_data,
        "documents":     docs,
        "medications":   meds,
    }

    await sio.emit("next_patient", payload)

    # Fire lookahead pre-cache and queue-shift broadcast
    spawn(notify_subsequent_patient(doctor_id))
    spawn(pre_cache_next_patient(doctor_id))
    if resolved_hospital_id:
        try:
            wait_count = (
                supabase.table("tickets").select("id", count="exact")
                .eq("status", "waiting").execute().count or 0
            )
            await sio.emit("queue_position_update",
                           {"doctor_id": doctor_id, "next_waiting": wait_count},
                           room=resolved_hospital_id)
        except Exception:
            pass

    return {
        "status":        "success",
        "patient":       p_data,
        "ticket":        updated,
        "atlas_summary": atlas_summary,
        "documents":     docs,
        "medications":   meds,
    }


# 8. Book appointment (Commented out: duplicates and clashes with main.py's full implementation)
# @router.post("/api/appointments/book")
# async def book_appointment(data: BookAppointmentRequest):
#     doc_res = supabase.table("doctors").select("id").eq("id", data.doctor_id).execute().data
#     if not doc_res:
#         return {"status": "error", "message": "Doctor not found"}
# 
#     conflict = supabase.table("appointments").select("id").eq("doctor_id", data.doctor_id).eq("date", data.date).eq("time", data.time).execute().data
#     if conflict:
#         return {"status": "error", "message": "Conflict: the doctor already has an appointment at this time"}
# 
#     apt_data = {
#         "patient_id": data.patient_id,
#         "doctor_id": data.doctor_id,
#         "date": data.date,
#         "time": data.time,
#         "reason": data.reason,
#         "status": "pending"
#     }
#     
#     res = supabase.table("appointments").insert(apt_data).execute().data[0]
#     
#     await sio.emit("appointment_booked", apt_data)
# 
#     return {
#         "status": "success",
#         "appointment": res
#     }


# 9. Get appointments for patient (Commented out: duplicates and clashes with main.py's full implementation)
# @router.get("/api/appointments/patient/{patient_id}")
# async def patient_appointments(patient_id: str):
#     apts = supabase.table("appointments").select("*, doctors(name, specialization)").eq("patient_id", patient_id).execute().data
#     return {
#         "status": "success",
#         "appointments": apts
#     }

