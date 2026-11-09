# VELA

Hospital operations platform: reception and queueing, doctor workspace with the
Atlas voice assistant, lab orders and reports, admissions and discharge, a
hospital manager console, and a patient portal.

**Voice is built on Gnani AI:** Prisma (speech-to-text) and Timbre (text-to-speech).
See "Voice (Gnani)" below and `docs/SUBMISSION.md` for the full write-up.

- **Frontend:** React 19 + TypeScript + Vite (`src/`)
- **Backend:** FastAPI + Socket.IO (`medisense/medisense-ai/`)
- **Data:** Supabase (Postgres + Auth) plus a local SQLite file for sessions,
  the audit log, lab orders and admissions (`vela_local.db`)

## Run it

```bash
# Backend
cd medisense/medisense-ai
cp .env.example .env            # fill in Supabase, OpenAI, Gnani, owner login, kiosk ids
python -m venv .venv && .venv/bin/python -m pip install -r requirements.txt
.venv/bin/uvicorn main:app --port 8000

# Frontend (repo root)
cp .env.example .env            # VITE_* values only — they ship to the browser
npm install
npm run dev
```

Before the first real deployment, run `medisense/medisense-ai/rls_lockdown.sql`
in the Supabase SQL editor (see "Security model").

## Voice (Gnani)

| What | Where |
|---|---|
| Prisma + Timbre client, kiosk check-in, triage, usage stats | `medisense/medisense-ai/gnani_voice.py` |
| Browser recorder (Web Audio, 16 kHz mono WAV) | `src/utils/voiceRecorder.ts`, `src/hooks/useVoiceInput.ts` |
| Public voice kiosk (Hindi / Hinglish / English) | `/frontdesk` (`src/pages/FrontDesk.tsx`) |
| Atlas always-on mic (Space mutes / unmutes) | `src/components/Atlas/AtlasCore.ts` |

Backend env: `GNANI_API_KEY`, `KIOSK_HOSPITAL_ID` (the hospital kiosk tickets go to),
`KIOSK_DEMO_VELA_ID` (the one synthetic demo patient the kiosk checks in),
optional `HINGLISH_VOICE` (`Poorvi` default, or `Nalini`).

Emergency triage is a plain keyword list (Devanagari and Roman spellings), never the
model alone. The kiosk only checks people in and alerts staff; it gives no medical advice.
Gnani allows one active request at a time per account, so every Prisma and Timbre call
shares one lock. `GET /api/voice/stats` (manager) shows calls, errors, characters and
average latency since the server started.

## Other features

- **Ward board** (reception: Wards tab; manager: Beds & Patients): every bed with the
  patient's name, a detail panel, admit, transfer, discharge, out-of-service.
- **Virtual consultation** (doctor sidebar): a doctor opens a patient's reports by VELA ID,
  with a plain-language reading, trends, spoken explanation (Hindi / Hinglish / English),
  and PDF / original-scan download. *College-presentation build: the VELA ID alone opens
  the records; the patient's one-time-code (OTP) approval will be added later.*
- **Demo data:** `medisense/medisense-ai/seed_demo_patients.py` adds three synthetic
  patients (VLA-9001..9003) with several reports each.

## Tests

```bash
cd medisense/medisense-ai
.venv/bin/python -m pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests
```

`tests/test_authz.py` fails if any route is missing from the access policy.

## Security model

- **Sessions.** Every login returns a bearer token. Tokens are stored as SHA-256
  hashes in `vela_local.db`, survive restarts, and are revoked on logout
  (`POST /api/auth/logout`). Staff sessions last 12 hours, patient sessions 30
  days (`VELA_SESSION_TTL`, `VELA_PATIENT_SESSION_TTL`).
- **Authorization.** `authz.py` runs on every route. Each route lists the roles
  that may call it. Patients can only reach their own records, and
  hospital-bound staff can only reach their own hospital's records. Routes not
  in the policy are refused.
- **Database.** The backend uses only the Supabase service-role key. RLS is on
  for every table with no anon policies, so the anon key in the browser (used
  for Supabase Auth only) can't read or write any table.
- **Realtime.** Socket.IO connections must present a session token. Events go
  only to the hospital's room or the patient's own room, never to everyone.
- **Secrets.** Nothing secret goes in a `VITE_*` variable. The Gnani key stays on
  the server: Timbre is proxied through `POST /api/tts` and Prisma through
  `POST /api/stt`. The owner login is a bcrypt hash in the backend `.env`.
- **Audit.** Access to patient data is written to a hash-chained `audit_log`.
  `GET /api/audit-log/verify` reports the first row that was altered. A
  break-glass reason can be sent in the `X-Access-Reason` header.
- **Limits.** Login and sign-up routes are rate-limited per IP. Uploads are
  capped at `VELA_MAX_UPLOAD_MB` (default 20 MB) and checked by file
  signature.

See `docs/AUDIT-2026-10-28.md` for the audit these controls came from, and
for what is still open.

## Landing and sign-in motion

`src/pages/LandingPage.tsx` is a scroll-scrubbed product film (GSAP ScrollTrigger and SplitText, Lenis smooth
scroll, a three.js particle field in `src/components/cinematic/`). `Login.tsx` continues it with Framer
Motion. Everything respects `prefers-reduced-motion`: the DOM is written in its final state, and the
animations run only when motion is allowed.

The patterns are inspired by components browsed on [21st.dev](https://21st.dev): Aceternity UI's
"Container Scroll Animation" (MIT), scroll-expansion heroes, split-screen sign-ins and follower cursors.
They were rebuilt from scratch rather than installed, so no third-party component code is vendored.
