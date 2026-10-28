# VELA

Hospital operations platform: reception and queueing, doctor workspace with the
Atlas voice assistant, lab orders and reports, admissions and discharge, a
hospital manager console, and a patient portal.

- **Frontend:** React 19 + TypeScript + Vite (`src/`)
- **Backend:** FastAPI + Socket.IO (`medisense/medisense-ai/`)
- **Data:** Supabase (Postgres + Auth) plus a local SQLite file for sessions,
  the audit log, lab orders and admissions (`vela_local.db`)

## Run it

```bash
# Backend
cd medisense/medisense-ai
cp .env.example .env            # fill in Supabase, OpenAI, ElevenLabs, owner login
python -m venv .venv && .venv/bin/python -m pip install -r requirements.txt
.venv/bin/uvicorn main:app --port 8000

# Frontend (repo root)
cp .env.example .env            # VITE_* values only — they ship to the browser
npm install
npm run dev
```

Before the first real deployment, run `medisense/medisense-ai/rls_lockdown.sql`
in the Supabase SQL editor (see "Security model").

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
- **Secrets.** Nothing secret goes in a `VITE_*` variable. ElevenLabs is
  proxied through `POST /api/tts`, and the owner login is a bcrypt hash in the
  backend `.env`.
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
