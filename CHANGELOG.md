# VELA — Audit & Fix Changelog

Full-stack audit pass (2026-07-02). Every entry: **what was broken → file/line → what changed → why**.

## Session 6 — Atlas knows who's in the chair, and the lab flow end-to-end (2026-07-31)

### 15. Atlas needed the patient's name in every question
- **Symptom:** After clicking "Next Patient", the doctor had to say the patient's name on *every* follow-up ("what's Rajesh's hemoglobin", then "what's Rajesh's CBC"). "What's his hemoglobin?" fell through to "I couldn't identify the patient."
- **Five compounding causes (all found by reading the resolution chain, not guessed):**
  1. **Two Atlas instances rendered on `/doctor`** — App's global one (`App.tsx:50`) *plus* a duplicate in `Doctor.tsx`. Both mounted `AtlasCore`, both bound the spacebar, and each sent its own `patient_id`. They also stacked at the same `position: fixed` coordinates, so it looked like one orb.
  2. **`AtlasCore.ts` hardcoded `session_id: "doctor_session_1"`** — every doctor on the deployment shared one server-side session and overwrote each other's current patient.
  3. **Clicking the Next Patient *button* never told the backend.** Only the voice `call_next` path set `session["current_patient_id"]`; the button route relied on the frontend passing a `currentPatientId` derived from a `queue.find(...)` that was stale until the next `fetchQueue()`.
  4. **The in-progress-ticket fallback wasn't scoped to the doctor** — `.eq("status","in-progress")` picked the newest ticket *hospital-wide*, so in a multi-doctor hospital Atlas could answer about someone else's patient.
  5. **Name extraction overrode an explicitly-passed `patient_id`** via `ilike("%name%")[0]` — an arbitrary row. A half-heard name could silently swap the chart mid-consult.
- **Where / change — `main.py`:** new **`ActiveConsult`** layer (~line 346): `set_active_consult` / `clear_active_consult` / `get_active_consult`, keyed by **`doctor_id`, never by session**. The `tickets` table stays the source of truth (so it survives a restart); the dict is only a hot cache in front of it, and the fallback query is scoped `.eq("doctor_id", …)`. Added `resolve_doctor_id()` (only guesses a doctor when the hospital has exactly one — guessing otherwise would hand a session someone else's consult) and `resolve_patient_by_name()`, which prefers an exact name match, keeps the current chart when the spoken name *is* the current patient, and returns `{"ambiguous": [...]}` → a clarify response instead of picking `[0]`.
- **Where / change — both `/api/voice/query` and `/api/voice/query/stream`:** patient resolution moved to the top of the handler and unified to **explicit `patient_id` → this doctor's active consult → name as a deliberate override**. The duplicate `── RESOLVE DOCTOR ID ──` block was deleted.
- **Where / change — `receptionist.py`:** `next_patient` sets the active consult in **both** branches (zero-latency cache hit *and* cache-miss fallback), and `complete_patient` clears it.
- **Where / change — frontend:** deleted the duplicate `<Atlas>` from `Doctor.tsx`; the remaining global instance is pointed at the active patient via `setAtlasPatient` in a new effect (sending `undefined` when unknown is deliberate — better than a stale id, which would override the backend's correct answer). `AtlasCore` now derives `session_id` from the logged-in `staff_id` (`staff_${id}`) and sends `doctor_id`.
- **Verified:** backend imports clean; `set/get/clear_active_consult` and `resolve_patient_by_name` exercised in-process; `npm run build` passes. The full voice round-trip (call next → ask with no name) needs a live queue and is best confirmed in the running app.

### 16. Lab flow: catalog → payment choice → arrival → report
Built the pipeline the demo actually needs, on top of the existing `lab_catalog.py` routing.
- **Reception owns the menu (`POST /api/lab/catalog/entry`, `DELETE …/{id}`)** — test name → which laboratory runs it → price. Deliberately does *not* require report fields: reception sets pricing/routing, the lab owns the report format for the same test, and both write the same `lab_templates` row. Editing an existing test never clobbers the format the lab tuned. New tests get the built-in layout, or a generic value/observation form.
- **Overrides actually drive ordering** — new `hospital_catalog_overrides()` / `resolve_tests_for_hospital()` in `main.py`; `create_test_orders` now routes and prices through them, so a hospital that moves CBC to microbiology at ₹999 gets exactly that.
- **Patient picks and pays (`POST /api/lab/orders/pay`, `…/pay-at-counter`)** — a doctor orders a panel, so the portal lists every test with its price, pre-selects all, and lets the patient untick. "Pay Now" settles the selected orders (each independently, so one failure can't swallow the rest); "Pay at Counter" charges nothing and just records the choice, so reception sees a "Coming to counter" badge on the list they already work from.
- **Arrival gate (new `awaiting_arrival` status, `GET /api/lab/orders/awaiting-arrival`, `POST /api/lab/orders/{id}/arrive`)** — paying no longer drops the order into the lab queue. The patient walks to the lab that runs their test, reception finds them on an arrivals board (with its own search) and marks them **Arrived**; only then does the order become work, with a real queue position. Idempotent on double-tap; refuses check-in for unpaid orders. Inpatients (`billed_to_admission`) still skip straight to the queue — their samples are drawn at the bedside.
- **Reception search + honest prices (`Receptionist.tsx`)** — added a search bar over the pending-payment list (name / VELA ID / test / lab / doctor) and **deleted the hardcoded `TEST_PRICES` map**, which had been showing ₹200 for a CBC the backend was charging ₹350 for. Prices now come from the order row, which is what the patient is actually billed.
- **Lab side (`LabController.tsx`)** — `payment_confirmed` is now a heads-up toast ("paid, on their way") rather than a queue refresh; the new `lab_order_arrived` event is what pulls the patient into the queue.
- **Verified end-to-end against the running backend** (`e2e_lab.py`, authenticated as reception / lab / patient) — 20/20 checks: override wins over the built-in catalog while un-overridden tests keep their defaults; negative price and unknown-lab rejected; both tests reach the patient's phone with the right total; pay-at-counter records intent without charging; multi-select pay charges ₹999; **the lab cannot see a paid-but-absent patient**; check-in assigns queue #1 and routes to microbiology; double check-in idempotent; the other lab never sees it; an unpaid test cannot be checked in.
- **One real bug caught by that test:** check-in returned queue position **0** for the first patient of the day — `_assign_queue_position` counts everything already queued for the department, so the order has to be marked `payment_confirmed` *before* the count, not after. Fixed by swapping the two statements; re-verified as #1.

**Note:** the "plaintext `vela_staff` passwords" risk listed at the bottom of this file is stale — auth is now bcrypt-hashed with TTL session tokens (`main.py:562-636`), and the lab/patient/reception endpoints used above all require a bearer token.

## Session 5 addendum — Atlas never answered from uploaded reports (RAG returned nothing)

### 14. RAG relevance threshold was set higher than the embedding model can score, so every chunk was rejected
- **Symptom (the presentation crash):** After uploading a report, Atlas/RAG always replied *"No relevant medical records were found… Please upload the relevant reports"* — even though the report **was** ingested and its chunks were in the store.
- **Measurement (proved, not guessed):** Live-queried `/api/patient/history/query` for a patient with 11 stored chunks → `chunks_searched: 11, chunks_matched: 0`. Then computed raw cosine similarity of each query against the stored chunk embeddings:
  - `"CA 15-3 tumor marker result"` (a term that appears verbatim in the report) → best chunk **0.558**
  - `"complete blood count results"` → best **0.459**
  - `"summarize this report"` → best **0.357**
  - Every score sat **below** the `RELEVANCE_THRESHOLD = 0.60` cutoff, so `search_chunks` filtered out all of them and the synthesizer fell through to its canned "no records" answer.
- **Root cause:** `text-embedding-3-small` produces genuine relevant-match cosine scores in the **~0.30–0.55** band (only near-duplicate text reaches ~0.6+). The 0.60 floor was simply miscalibrated for the model — it rejected *everything*, so the RAG path could never surface an uploaded report regardless of its filename or content.
- **Where / change — `rag.py` line 36:** `RELEVANCE_THRESHOLD` `0.60 → 0.30`. Retrieval is already scoped per-patient and capped at `top_k`, so a lower floor safely admits real matches without pulling in other patients' data.
- **Impact:** Fixes all three retrieval paths that call `search_chunks`: `/api/patient/history/query` (+ `/stream`, the `PatientHistoryRag` panel) and `get_rag_context_for_atlas` (Atlas doctor voice, TIER 3).
- **Verified (post-fix, same patient/queries):**
  - `/api/patient/history/query` "CA 15-3 tumor marker" → `chunks_matched: 10/11`, cited answer with actual values (23.5 U/mL, downward trend).
  - `/api/patient/history/query/stream` "abnormal values" → cited answer (hemoglobin 11.4 g/dL below range), 10 citations.
  - `/api/voice/query/stream` (Doctor, TIER 3) "CA 15-3 value and trend" → cited answer (35.9 U/mL vs <30 reference). Retrieval is by **embedding content**, not filename — a report downloaded under any name works identically.

---

## Session 4 addendum — file upload/delete taking 5-13s

### 13. Background document ingestion starved foreground upload/delete requests
- **Measurement (proved, not guessed):** Instrumented `upload_document` with per-phase timing and ran bursts of uploads. A single upload after a fresh restart is **0.4s** (`read=0ms insert=232ms`), but by the 4th-6th rapid upload it climbed to **4.5s → 9.6s** — and the slow part was the single `documents` skeleton **insert** (`insert=9660ms`), even though a raw isolated insert measured 352ms. So the DB wasn't slow; the request-path insert was *queuing*.
- **Root cause:** The heavy background ingestion pipeline (`async_process_document_pipeline`: fitz parse, mem0 sync, OpenAI parse, RAG embeddings, several Supabase writes) ran via `asyncio.to_thread` — the *same* default thread pool the request handlers use — and fired many concurrent Supabase writes against the shared project/anon-key. A burst of uploads spawned several pipelines that saturated both the thread pool and (mainly) Supabase's concurrent-request capacity, so the next foreground insert queued behind all of it. Confirmed by bisecting the concurrency limit: with pipelines serialized, 6 rapid uploads all stayed **0.19-0.39s**; at 3-concurrent they degraded to 9s+; **2-concurrent** stayed clean (0.16-0.32s).
- **Where / change — `main.py`:**
  - After `app = socketio.ASGIApp(...)` (~line 291): added a dedicated `_BG_EXECUTOR = ThreadPoolExecutor(max_workers=4)`, a `_PIPELINE_SEMAPHORE = asyncio.Semaphore(2)`, and a `bg_run(fn, *args, **kwargs)` helper that runs blocking work on that dedicated pool via `run_in_executor` (so background ingestion never uses the request pool).
  - `async_process_document_pipeline` (~line 833): wrapped the whole body in `async with _PIPELINE_SEMAPHORE:` (caps concurrent ingestions at 2), and replaced every `asyncio.to_thread(...)` inside it with `bg_run(...)`.
  - `async_process_document_deletion_pipeline`: same `asyncio.to_thread → bg_run` swap.
  - The `mem0_client.add` call (previously unbounded) is now wrapped in `asyncio.wait_for(..., timeout=15)` so a hanging memory-sync can't pin a background worker indefinitely.
- **Verified:** 6 rapid uploads → 0.15-0.32s each (was 9-13s). Single clean delete → 0.37s. (A delete measured at 16s during testing was an artifact of an artificial 35-document backlog I'd created by stress-testing — not the normal path; after a restart cleared the backlog, delete returned to 0.37s.)
- **Note:** `_PIPELINE_SEMAPHORE = 2` trades a little background throughput (documents now finish processing at most 2-at-a-time) for guaranteed foreground responsiveness. Background processing is already fire-and-forget with a visible "processing" state, so users never wait on it. If a busier deployment needs more ingestion throughput, the real next step is moving ingestion to a proper out-of-process job queue (Celery/RQ) rather than in-process background tasks.

---

## Session 3 addendum — login latency + appointments not reaching reception

### 11. Login intermittently slow (~4s), and the boot warm-up wasn't enough
- **Measurement:** `curl` timing of `POST /api/staff/login` — in isolation, warm calls were ~0.3s, but the *first* call after the backend had been idle for a while was consistently ~4s (matching the same cold-connection tax found in fix #9). The boot-time `warm_supabase_connection()` only fires once, so any login after a period of inactivity (tab left open, overnight) paid the cold reconnect again.
- **Where / change (a) — `main.py` ~line 2577:** Added a `supabase_heartbeat()` background task that pings Supabase every 45s (silent unless it errors) to keep the httpx connection pool permanently warm. Verified: after a 55s idle, login was still 0.41s (previously would spike to ~4s).
- **Where / change (b) — `staff_login` ~line 4800:** The "mark staff online / last_active" DB write was `await`ed before returning the login response even though its own comment calls it non-critical — an extra ~250ms round-trip on every login. Moved it to a fire-and-forget `asyncio.create_task`, so login returns after just the auth lookup. Verified: logins now 0.18-0.39s.
- **Why:** Login is the first thing every user does; a 4s spike (or worse under event-loop contention — one warm-but-contended call was measured at 11s) reads as "the app is broken."

### 12. Patient's booked appointments never appeared in the receptionist view
- **Broken (real-time refresh gap, the primary bug):** `src/pages/Receptionist.tsx` refetches the **appointment list** only on a `new_appointment` socket event, and that handler was registered *only when a `hospitalId` was present*. But `POST /api/appointments/book` (the endpoint the patient dashboard actually calls) emitted only `new_notification` — which makes reception refetch *notifications*, not appointments. Net effect: the appointment saved correctly to the DB, but the receptionist's list stayed stale until a manual full-page reload. Confirmed by curl: booking at the reception's hospital saved fine and `GET /api/appointments/today?hospital_id=<id>` returned it — the data was never the problem, the live refresh was.
- **Where / change (a) — `main.py` `_notify_appointment_booked` ~line 2435:** After saving, the booking now also emits `new_appointment` (with `patient_name`/`date`/`time`, looking the name up via `lookup_patient_name` when the client didn't send it) — scoped to room `hospital_<hospital_id>` for a VELA-partner booking, or broadcast when there's no hospital room — in addition to the existing `new_notification`.
- **Where / change (b) — `src/pages/Receptionist.tsx` socket effect ~line 673:** Registered the `new_appointment` → `fetchAppointments()` handler **unconditionally** (was gated behind `if (hospitalId)`), and also made the `new_notification` handler refetch the appointment list as a safety net. Cleanup updated to always `socket.off('new_appointment', ...)`.
- **Why:** A booking a patient just made must show up on the front desk in real time; requiring a manual reload made it look like bookings were being lost.
- **Note on scoping (verified, not a bug):** Appointments are correctly scoped by `hospital_place_id`, so a patient who books at VELA hospital A does *not* appear for a receptionist at hospital B — that's intended multi-tenant behavior. For the demo, book at "Aiims Hospital Road" (`990a1441-…`, the demo receptionist's hospital) to see it flow through. A non-VELA (OpenStreetMap) hospital booking has no `hospital_place_id` and no owning receptionist by design.

---


## Methodology (measure first, then fix)

- `curl -i -X OPTIONS` / `curl -D -` with `Origin: http://localhost:5173` against key endpoints → CORS headers **were already present on 2xx responses** (`CORSMiddleware` was installed and working). The reported "backend isn't sending Access-Control-Allow-Origin" was *not* reproducible on healthy responses.
- `curl http://localhost:8000/api/patients/not-a-uuid` → **HTTP 500 with NO `Access-Control-Allow-Origin` header**. This is the real "CORS" bug: unhandled Python exceptions bypass `CORSMiddleware` (Starlette's `ServerErrorMiddleware` sits *outside* it), so the browser hides the response and axios reports "Network Error" on any endpoint that throws. This exactly matches the errors captured in the Vite console log (`AxiosError: Network Error` at `PatientPortal.tsx handleLogin`).
- 4 parallel `GET /api/patients/list` → completed at **0.17s / 0.34s / 0.52s / 0.69s — perfectly serialized**. Every route is `async def` but calls the *synchronous* Supabase client, blocking the event loop. One slow/hanging Supabase round-trip queues every other request behind it → the observed 5-6s clicks. The backend startup log showed Supabase DNS failures (`[Errno 8] nodename nor servname provided`) during the affected session — each such call can hang for the full OS network timeout, freezing the entire API.
- `POST /api/demo/seed-patient` → 200 in 0.38s, `patient@vela.ai` exists (`created: false`). Seeding itself was working whenever the backend could reach Supabase; the login cascade broke when Supabase was unreachable **and** the fallback endpoint 500'd without CORS (fixes #1 and #3).

### After-fix measurements
- `GET /api/patients/not-a-uuid` → 500 **with** `access-control-allow-origin: http://localhost:5173` and a JSON body containing the real error message.
- 4 parallel `GET /api/patients/list` → **0.26s / 0.26s / 0.26s / 0.28s — fully overlapping** (no serialization).
- `GET /api/patient/by-email/patient@vela.ai` → 200, returns the demo patient (login fallback works).
- `POST /api/doctor/next-patient` → 200, correct `"No patients waiting"` for an empty queue.

---

## Backend — `medisense/medisense-ai/main.py`

### 1. 500 responses had no CORS headers → browser "Network Error"
- **Broken:** Any endpoint that raised an unhandled exception returned Starlette's plain-text 500 *without* `Access-Control-Allow-Origin`. Browsers hide the body and axios reports "Network Error", which looks exactly like "backend has no CORS". Reproduced with `GET /api/patients/not-a-uuid`.
- **Where:** `main.py` — new global handler just after `app = socketio.ASGIApp(...)` (~line 300).
- **Change:** Added `@fastapi_app.exception_handler(Exception)` returning a JSON 500 that **manually attaches CORS headers** (echoing the request `Origin` when it's in `ALLOWED_ORIGINS`). Manual attachment is required because Starlette's top-level error handler runs outside `CORSMiddleware`.
- **Why:** The frontend now always receives a readable JSON error with CORS headers; failures surface as real messages in toasts instead of opaque network errors.

### 2. Sync Supabase calls blocked the async event loop (the measured 5-6s latency)
- **Broken:** Routes are `async def` but call `supabase.table(...).execute()` synchronously — the event loop stalls for each DB round-trip and concurrent requests serialize (measured above). With Supabase unreachable, DNS/TCP timeouts froze the whole API for tens of seconds.
- **Where / change (a):** `main.py` ~line 280 — both Supabase clients now use an explicit **5-second httpx timeout** (`ClientOptions(httpx_client=httpx.Client(timeout=5.0))`), replacing the default long OS timeouts. Also removes the two deprecation warnings from the old `timeout`/`verify` kwargs path.
- **Where / change (b):** Converted the hottest read endpoints to run DB work in a worker thread via `asyncio.to_thread`, unblocking the loop:
  - `GET /api/patients/list` (~line 646)
  - `GET /api/patients/emergency` (~line 680 — polled every 30s by the doctor sidebar)
  - `GET /api/patient/by-email/{email}` (~line 630 — the patient-login fallback)
  - `GET /api/appointments/today` (~line 2562)
  - `GET /api/notifications/{role}` (~line 2921)
- **Why:** These are the endpoints hit on page load and on polling timers — the ones implicated in the measured serialization. (`GET /api/patients/{id}` already used `asyncio.gather` + `to_thread`.) Converting the remaining ~100 routes is the long-term direction; this set removes the head-of-line blocking for the main dashboards.

### 3. `/api/patient/by-email` (patient-login fallback) crashed when Supabase was down
- **Broken:** The raw `execute()` raised → 500 without CORS (bug #1) → the PatientPortal login fallback saw "Network Error" → patient login completely dead even though the flow has a fallback chain. This was the reported "auth cascade".
- **Where:** `main.py` ~line 630.
- **Change:** Wrapped in try/except; on DB failure returns structured `{"status": "error", "message": "Database unreachable — please try again"}` instead of raising.
- **Why:** The login chain (Supabase Auth → backend lookup) now completes or fails with a readable toast, never an opaque network error.

### 4. Appointment booking had no idempotency → duplicate appointments
- **Broken:** `POST /api/appointments/book` (~line 2362) and `POST /api/network/appointments/book` (~line 4305) inserted unconditionally; double-clicks created duplicate rows.
- **Change:** Both endpoints now check for an existing non-cancelled appointment with the same `patient_id + date + time` (+ `hospital_id` where applicable) before inserting, and return the existing appointment with `"duplicate": true` instead of creating another.
- **Why:** Server-side idempotency guarantees no duplicates even if a client retries, double-submits, or a network hiccup causes a re-send. (Note: `/api/receptionist/appointment/{id}/arrive` already had a double-check-in guard — verified, not changed.)

### 9. Booking "feels slow" — measured, not guessed (5-6s → ~0.5s)
- **Measurement:** Added `time.perf_counter()` timing around every phase of `book_appointment` (~line 2362: prep / dupe_check / insert / notification / socket_emit / total), logged as `⏱️ book_appointment timings: {...} ms`. Fired real booking requests against the running backend:
  - **First request after a fresh backend start:** `dupe_check` alone took **5927.9ms** of a 6401.2ms total — everything else (`insert` 276ms, `notification` 196ms) was normal. Direct `curl` to the Supabase REST endpoint confirmed DNS resolves in 26ms and a *warm* connection completes in 250ms — so the 5.9s was a **one-time cold-connection tax** (DNS + TLS handshake for the sync Supabase client's first httpx connection), not a slow query.
  - Root cause located: `main.py` already had a `seed_flagship_hospitals()` startup task intended to touch Supabase early, but (a) it called the *sync* client directly on the event loop instead of via `asyncio.to_thread` (blocking every other request during startup), and (b) per this session's earlier backend log it can fail outright on cold DNS (`[Errno 8] nodename nor servname provided`) — so it never reliably left a warm connection behind. Whichever user's click happened to be the first real Supabase-touching request after a restart ate the full 5-6s.
  - **Steady-state** (connection already warm): 3 sequential network calls per booking — `dupe_check` (~200-550ms), `insert` (~200-550ms), and an inline-awaited `notification` insert + `socket_emit` (~170-230ms) the response didn't need to wait on. Total ~570-650ms.
- **Where / change (a) — `main.py` ~line 2510:** Fixed `seed_flagship_hospitals()` to run its Supabase calls via `asyncio.to_thread` instead of blocking the loop. Added a new `warm_supabase_connection()` startup task (~line 2525) that pings Supabase with up to 4 retries (1s apart) in a background thread before any user ever hits the API, logging `🔥 Supabase connection warmed in {ms}ms`. This moves the 5-6s DNS/TLS tax from "the first doctor's click" to "invisible, during server boot."
- **Where / change (b) — `book_appointment` ~line 2416:** The receptionist-notification insert and `sio.emit` are no longer awaited before responding — they run in a background `asyncio.create_task(_notify_appointment_booked(...))` after the appointment row is already durably saved. The booking response no longer waits on them.
- **Verified after fix:** Fresh backend restart → first real booking request: **1.1s** (was 6.4s). Steady-state after that: **0.49-0.60s total**, with `notification`/`socket_emit` now logged separately as `background notify took ~170-270ms` (confirmed off the response path). Remaining ~0.5s is the honest floor of 2 sequential round-trips to a remote Postgres from this network — see frontend fix #10 for how the UI hides even that.
- **Indexes:** `create_vela_tables.sql` already defines `idx_appointments_patient`, `idx_appointments_hospital`, `idx_appointments_date` — sufficient for the duplicate-check query pattern (`patient_id` is the leading, most selective filter). No missing-index bottleneck found; the measured cost was connection establishment, not query planning. (Note: the live Supabase table's actual columns — `hospital_place_id`, `reason` — don't match this DDL file's `hospital_id`/`notes` naming, meaning the DDL is stale relative to the deployed schema; flagged for follow-up, out of scope for a latency fix.)

---

## Frontend — `src/`

### 5. Patient "Book Appointment" button had no submitting state
- **Broken:** `src/pages/PatientDashboard.tsx` — `bookAppointment()` (~line 591) had no in-flight guard and its button (~line 1361) no `disabled`, so slow requests invited repeat clicks → duplicate appointments (paired with backend fix #4).
- **Change:** Added `bookingSubmitting` state; the function early-returns while in flight and resets in `finally`; the button is `disabled` with a dimmed/wait cursor while submitting.
- **Why:** First line of defense against double-submit; the backend check (#4) is the guarantee.
- **Audited, already correct (no change needed):** Doctor "Call Next" (`nextLoading`), Receptionist register (`registering`), check-in (`ticketCreating`), upload (`uploading`), discharge (`processLoading`), admission (`confirmingAdmission`), assign-doctor (`assigning`), PatientPortal login/register (`loading`).

### 10. Optimistic UI for "Confirm Appointment" — instant confirmation, background save
- **Goal:** Even at the fixed ~0.5-0.6s steady-state latency (fix #9), a doctor/patient clicking "Confirm Appointment" still waits half a second staring at a spinner. Hide that wait entirely by confirming instantly and reconciling with the server in the background.
- **Where:** `src/pages/PatientDashboard.tsx` — `bookAppointment()` (~line 592) and its button (~line 1458).
- **Change:**
  - Split the old function into `bookAppointmentBlocking()` (the original await-then-toast flow, unchanged) kept as an explicit **fallback** for the one case optimism can't safely cover — `!bookingHospital || !patient?.id` — and a new `bookAppointment()` that runs optimistically whenever that data is present.
  - On click: the button instantly flips to a green **"✓ Booked"** state (disabled, no spinner) and a success toast fires immediately — before any network call. A placeholder appointment (`status: "confirming"`, temp id `optimistic-<timestamp>`) is pushed into the `appointments` list so the "My Appointments" view reflects it right away too. The booking modal auto-closes ~700ms later so the confirmation is visible before it disappears.
  - The real `POST /api/appointments/book` call runs after that, off the UI's critical path. On success, the placeholder is swapped for the server's real appointment row (by matching the temp id). **On failure**, the placeholder is removed, an error toast explains the save failed, and the form (hospital, date, time, notes, doctor) is restored from a snapshot taken before the optimistic update — the modal reopens with everything the patient typed still in place, so nothing is lost on retry.
  - The `"confirming"` status was deliberately chosen over reusing `"scheduled"`/`"pending"`: the appointments list already conditionally mounts `<QueueTracker appointmentId={apt.id}>` for `scheduled`/`arrived`/`in-progress` rows, which fetches live queue data by id — mounting that against a fake temp id would 404. `"confirming"` gets its own badge (pulsing emerald, labeled "saving…") and is excluded from that condition.
  - The original `bookingSubmitting` disabled/loading state is preserved untouched as the fallback path's UI — per the requirement, it's what renders when the optimistic path can't apply.
- **Why:** The button now *feels* instant regardless of network latency, while the server-side idempotency check (fix #4) guarantees that if the user double-clicks during the 700ms window, no duplicate is created — the button is disabled the entire time (`bookingOptimistic || bookingSubmitting`).

### 6. Handover page fabricated clinical data
- **Broken:** `src/pages/Handover.tsx` — if the patients API failed it silently showed **five fictional patients** (Sarah Connor, Roy Batty, …) with invented risk scores (~line 47), and if report generation failed it fabricated a full handover report with **invented vitals ("BP 120/80, HR 72, SpO2 98%") signed by a fictional doctor** (~line 114). In a medical app, silently fabricated clinical content is a safety hazard, not a fallback.
- **Change:** Removed both mock paths. Patients now come only from `GET /api/patients/list` (with an honest error toast + empty state on failure); reports come only from the real `POST /api/handover/generate` endpoint (GPT + mem0 — verified it exists at `main.py:2184`), with an error toast on failure. Also removed a **fake 1.5s `setTimeout` "generation delay for effect"**.
- **Why:** Never show invented clinical data; and don't add artificial latency to an app being audited for slowness.

### 7. Login had two artificial 800ms delays
- **Broken:** `src/pages/Login.tsx` — both credential-fallback paths wrapped their logic in `window.setTimeout(..., 800)` purely for effect, adding ~0.8s to every hardcoded-credential login on top of real backend time.
- **Change:** Delays reduced to 0 (structure preserved).
- **Why:** Directly contributes to the perceived slowness being audited.

---

### 8. Atlas voice input dead (typed input worked)
- **Broken:** `src/components/Atlas/AtlasCore.ts` — two compounding bugs:
  1. `setupSpacebar()` (~line 52) added `keydown`/`keyup` listeners on `window` that `destroy()` never removed. The app runs in React `<StrictMode>` (`main.tsx`), which mounts → unmounts → remounts `useAtlas`, so a **zombie AtlasCore instance kept its spacebar listeners**. Every Space press started `SpeechRecognition` on two instances; Chrome permits only one active recognition, so they aborted each other (or the dead instance swallowed the transcript and "replied" into unmounted state). Typed queries worked because `ask()` runs only on the live instance — exactly the reported symptom.
  2. `stopListening()` (~line 139) set state to `"processing"` before `recognition.stop()`, but `onend` only reset from `"listening"` — if recognition ended with no transcript, Atlas hung in "processing" forever with no reply and no error.
- **Change:** Handlers are now class fields removed in `destroy()`; `startListening()` aborts any prior recognition before starting a new one; a `gotResult` flag makes `onend` recover from the stuck "processing" state with a spoken-feedback error toast ("I didn't catch that — hold Space and speak clearly"); added a distinct message for Chrome's `no-speech` error.
- **Why:** Voice is Atlas's primary interface for doctors; it must fail loudly (a toast) rather than silently when recognition catches nothing.

## Verified end-to-end (after all fixes, via curl against the running stack)

| Flow | Result |
|---|---|
| CORS preflight (`OPTIONS`) | 200 + correct `access-control-*` headers |
| CORS on **error** responses | 500 now includes `access-control-allow-origin` + JSON message |
| `POST /api/demo/seed-patient` | 200, idempotent (`created: false` on repeat) |
| Patient login fallback (`GET /api/patient/by-email/patient@vela.ai`) | 200 + demo patient |
| Doctor next-patient (`POST /api/doctor/next-patient`) | 200, correct empty-queue response |
| Parallel request latency | serialized 0.17→0.69s **before**; overlapping ~0.26s each **after** |
| `npm run build` (tsc + vite) | passes |

## Known intentional demo affordances (documented, NOT removed)

These are by-design demo shortcuts the app's own flows rely on; they must be removed before a real production deployment:
- Hardcoded demo credentials in `src/utils/auth.ts` and the `DEMO BYPASS` blocks in `PatientPortal.tsx` (`patient@vela.health`/`demo123`), `HospitalManager.tsx` and `VelaOwner.tsx` (`admin@vela.health`/`demo123`) — each falls through to real backend auth for non-demo credentials.
- `POST /api/owner/login` compares against constants (`dev@vela.ai`).
- Decorative marketing numbers on the Login role cards and the landing-page vitals ticker (presentation copy, not presented as live data).

## Known remaining risks (out of scope for this pass, flagged for follow-up)

- `vela_staff` passwords are compared in plaintext in `POST /api/staff/login` — needs hashing (bcrypt) + real sessions/JWT.
- The ElevenLabs API key ships in the frontend bundle (`VITE_ELEVENLABS_API_KEY`) — should be proxied through the backend.
- ~100 remaining `async def` routes still call the sync Supabase client; with the 5s client timeout the worst-case stall is now bounded, but the long-term fix is converting them to `asyncio.to_thread` or the async client.
