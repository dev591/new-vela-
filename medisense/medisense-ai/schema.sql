-- =====================================================================
-- VELA — complete Supabase schema (one file, run once on a new project)
--
-- Generated 2026-10-28 from the LIVE database's table definitions and
-- cross-checked against every table/column the backend reads or writes
-- (main.py, receptionist.py, rag.py, vela_documents.py, imaging.py).
--
-- Run it in the Supabase SQL editor of the new project. It is safe to
-- re-run: every statement is IF NOT EXISTS / idempotent.
--
-- NOT in Supabase (on purpose): lab orders, lab reports/templates,
-- admissions, discharges, visit reports, imaging studies, sessions and
-- the audit log live in the backend's local SQLite file (vela_local.db),
-- which the backend creates itself on start.
--
-- Seed data the app creates on its own: the four "VELA …" flagship
-- hospitals (startup) and the demo patient VLA-8888 (first demo login).
-- =====================================================================

create extension if not exists pgcrypto;   -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- Hospitals, wards, beds, staff
-- ---------------------------------------------------------------------
create table if not exists vela_hospitals (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  address          text not null,
  phone            text default '',
  email            text default '',
  city             text default '',
  state            text default '',
  specializations  text[],
  total_beds       integer default 0,
  latitude         double precision,
  longitude        double precision,
  mapbox_place_id  text default '',
  verified         boolean default false,
  active           boolean default true,
  plan             text default 'pilot',
  health_score     integer default 100,
  onboarded_at     timestamptz default now(),
  manager_email    text default '',
  manager_password text default '',      -- bcrypt hash (legacy rows upgrade on login)
  manager_name     text default '',
  hospital_slug    text default ''
);

create table if not exists vela_walkthrough (
  id           uuid primary key default gen_random_uuid(),
  hospital_id  uuid references vela_hospitals(id),
  completed    boolean default false,
  completed_at timestamptz,
  step_reached integer default 1
);

-- wards/beds keep hospital_id as text (the code still passes "VLA-MAIN"-style placeholders)
create table if not exists wards (
  id           uuid primary key default gen_random_uuid(),
  hospital_id  text not null default 'default_hospital',
  name         text not null,
  type         text not null default 'General',
  color        text default '#0F766E',
  floor_number integer default 1,
  position_x   double precision default 0,
  position_y   double precision default 0,
  created_at   timestamptz default now(),
  x            double precision,
  y            double precision
);

create table if not exists vela_staff (
  id             uuid primary key default gen_random_uuid(),
  hospital_id    uuid references vela_hospitals(id),
  name           text not null,
  role           text not null,           -- doctor | receptionist | lab_controller | nurse
  specialization text default '',         -- for lab accounts: the department scope
  email          text not null,
  password       text not null,           -- bcrypt hash
  active         boolean default true,
  online         boolean default false,
  last_active    timestamptz,
  created_at     timestamptz default now(),
  ward_id        uuid references wards(id)
);

-- every hospital doctor is mirrored here (appointments/tickets reference it)
create table if not exists doctors (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  specialization   text not null,
  hospital         text default '',
  qualification    text default '',
  experience_years integer default 0,
  available        boolean default true,
  photo_url        text default '',
  created_at       timestamptz default now()
);

-- ---------------------------------------------------------------------
-- Patients and their record
-- ---------------------------------------------------------------------
create table if not exists patients (
  id                         uuid primary key default gen_random_uuid(),
  vela_id                    text,
  name                       text not null,
  age                        integer,
  gender                     text,
  blood_group                text,
  ward                       text,
  room                       text,
  doctor                     text,
  status                     text default 'stable',
  risk_score                 integer default 0,
  created_at                 timestamp default now(),
  updated_at                 timestamp default now(),
  height                     text default '',
  weight                     text default '',
  allergies                  text default '',
  existing_conditions        text default '',
  emergency_contact          text default '',
  language                   text default 'English',
  admitted_at                timestamptz default now(),
  diagnosis                  text default '',
  registered_by              text default 'self',
  email                      text default '',
  phone                      text default '',
  password_hash              text default '',
  date_of_birth              text default '',
  emergency_contact_name     text default '',
  emergency_contact_phone    text default '',
  emergency_contact_relation text default '',
  insurance_id               text default '',
  insurance_provider         text default '',
  atlas_analysis             text default '',
  atlas_analysis_updated_at  timestamptz,
  atlas_confidence           text default 'LOW',
  is_admitted                boolean default false,
  current_admission_id       text,
  last_visit_date            timestamptz,
  -- NEW (not in the old DB): the code already reads/writes it as the
  -- hospital that last treated the patient; it silently failed before.
  hospital_id                uuid
);

create table if not exists documents (
  id                uuid primary key default gen_random_uuid(),
  patient_id        uuid references patients(id),
  filename          text,
  file_url          text,
  report_date       text,
  risk_score        integer default 0,
  summary           text,               -- 'processing' while the pipeline runs
  values            jsonb,
  critical_flags    jsonb,
  uploaded_at       timestamp default now(),
  atlas_summary     text default '',
  atlas_analyzed_at timestamptz
);

create table if not exists medications (
  id            uuid primary key default gen_random_uuid(),
  patient_id    uuid references patients(id),
  name          text not null,
  dosage        text,
  frequency     text,
  prescribed_by text,
  start_date    text,
  notes         text,
  created_at    timestamp default now()
);

create table if not exists notes (
  id         uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id),
  content    text,
  created_by text,
  created_at timestamp default now()
);

create table if not exists reminders (
  id         uuid primary key default gen_random_uuid(),
  patient_id uuid references patients(id),
  message    text,
  due_time   timestamp,
  is_done    boolean default false,
  created_at timestamp default now()
);

create table if not exists blood_tests (
  id               uuid primary key default gen_random_uuid(),
  patient_id       uuid references patients(id),
  ordered_by       uuid references doctors(id),
  test_name        text not null,
  ordered_at       timestamptz default now(),
  document_id      uuid references documents(id),
  status           text default 'pending',
  results_uploaded boolean default false
);

create table if not exists voice_queries (
  id         uuid primary key default gen_random_uuid(),
  patient_id uuid,
  query      text,
  answer     text,
  intent     text,
  created_at timestamp default now()
);

create table if not exists beds (
  id              uuid primary key default gen_random_uuid(),
  ward_id         uuid references wards(id),
  hospital_id     text not null default 'default_hospital',
  bed_number      text not null,
  status          text default 'empty',
  patient_id      uuid references patients(id),
  assigned_doctor text default '',
  admitted_at     timestamptz,
  created_at      timestamptz default now()
);

-- ---------------------------------------------------------------------
-- Queue, appointments, notifications
-- ---------------------------------------------------------------------
create table if not exists appointments (
  id                uuid primary key default gen_random_uuid(),
  patient_id        uuid references patients(id),
  doctor_id         uuid references doctors(id),
  date              date not null,
  time              text not null,
  reason            text default '',     -- JSON string: checklist, notes, doctor
  status            text default 'pending',
  created_at        timestamptz default now(),
  hospital_name     text default '',
  hospital_address  text default '',
  hospital_place_id text default '',     -- the VELA hospital id (or a map place id)
  triage_level      text default 'Routine',
  -- NEW (not in the old DB): written on arrival; the code tolerated its absence.
  queue_position    integer
);

-- tickets have no hospital column: a ticket belongs to its doctor's hospital
create table if not exists tickets (
  id             uuid primary key default gen_random_uuid(),
  ticket_number  text not null,          -- TKT-YYYYMMDD-NNNN
  patient_id     uuid references patients(id),
  vela_id        text not null,
  department     text default 'General',
  doctor_id      uuid references doctors(id),
  status         text default 'waiting', -- waiting | in-progress | completed
  queue_position integer default 0,      -- emergencies go negative (front)
  notes          text default '',
  created_at     timestamptz default now(),
  called_at      timestamptz,
  completed_at   timestamptz,
  triage_level   text default 'Routine'
);

create table if not exists notifications (
  id          uuid primary key default gen_random_uuid(),
  hospital_id uuid,
  role        text,
  message     text not null,
  type        text default 'info',
  read        boolean default false,
  action_url  text,
  created_at  timestamptz default now()
);

create table if not exists reassess_requests (
  id            uuid primary key default gen_random_uuid(),
  patient_id    text not null,
  test_order_id text,
  lab_report_id text,
  status        text default 'pending',
  requested_at  timestamptz default now()
);

-- ---------------------------------------------------------------------
-- Independent network (hospitals, labs, solo doctors)
-- ---------------------------------------------------------------------
create table if not exists network_hospitals (
  id                         uuid primary key default gen_random_uuid(),
  name                       text not null,
  address                    text not null,
  place_id                   text not null,
  lat                        double precision,
  lng                        double precision,
  specializations            text[],
  receptionist_email         text not null,
  receptionist_password_hash text not null,
  receptionist_name          text not null,
  created_at                 timestamptz default now()
);

create table if not exists network_appointments (
  id           uuid primary key default gen_random_uuid(),
  hospital_id  uuid references network_hospitals(id) on delete cascade,
  patient_id   text not null,
  patient_name text not null,
  vela_id      text,
  date         date not null,
  time         time not null,
  status       text default 'pending',
  created_at   timestamptz default now()
);

create table if not exists network_labs (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  address       text not null,
  place_id      text not null,
  lat           double precision,
  lng           double precision,
  departments   text[],
  contact_name  text not null,
  login_email   text not null,
  password_hash text not null,
  created_at    timestamptz default now()
);

create table if not exists network_doctors (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  specialization   text not null,
  address          text not null,
  place_id         text not null,
  lat              double precision,
  lng              double precision,
  consultation_fee real default 0.0,
  license_number   text not null,
  verified         boolean default false,
  login_email      text not null,
  password_hash    text not null,
  created_at       timestamptz default now()
);

create table if not exists network_doctor_appointments (
  id           uuid primary key default gen_random_uuid(),
  doctor_id    uuid references network_doctors(id) on delete cascade,
  patient_id   text not null,
  patient_name text not null,
  vela_id      text,
  date         date not null,
  time         time not null,
  status       text default 'pending',
  created_at   timestamptz default now()
);

-- ---------------------------------------------------------------------
-- Uniqueness the app relies on (partial where blank values are common)
-- ---------------------------------------------------------------------
create unique index if not exists uq_patients_vela_id      on patients (vela_id) where vela_id is not null and vela_id <> '';
create unique index if not exists uq_vela_staff_email      on vela_staff (lower(email));
create unique index if not exists uq_hospitals_manager     on vela_hospitals (lower(manager_email)) where manager_email <> '';
create unique index if not exists uq_hospitals_slug        on vela_hospitals (hospital_slug) where hospital_slug <> '';
create unique index if not exists uq_net_hosp_email        on network_hospitals (lower(receptionist_email));
create unique index if not exists uq_net_hosp_place        on network_hospitals (place_id);
create unique index if not exists uq_net_labs_email        on network_labs (lower(login_email));
create unique index if not exists uq_net_labs_place        on network_labs (place_id);
create unique index if not exists uq_net_docs_email        on network_doctors (lower(login_email));
create unique index if not exists uq_net_docs_place        on network_doctors (place_id);

-- ---------------------------------------------------------------------
-- Indexes for the queries the backend actually runs
-- ---------------------------------------------------------------------
create index if not exists ix_patients_email          on patients (lower(email));
create index if not exists ix_patients_risk           on patients (risk_score desc);
create index if not exists ix_documents_patient       on documents (patient_id, uploaded_at desc);
create index if not exists ix_medications_patient     on medications (patient_id);
create index if not exists ix_notes_patient           on notes (patient_id, created_at desc);
create index if not exists ix_reminders_patient       on reminders (patient_id, due_time);
create index if not exists ix_blood_tests_patient     on blood_tests (patient_id);
create index if not exists ix_tickets_status_doctor   on tickets (status, doctor_id, queue_position);
create index if not exists ix_tickets_status_dept     on tickets (status, department, queue_position);
create index if not exists ix_tickets_patient         on tickets (patient_id, created_at desc);
create index if not exists ix_tickets_number          on tickets (ticket_number);
create index if not exists ix_appointments_patient    on appointments (patient_id);
create index if not exists ix_appointments_hospital   on appointments (hospital_place_id, date);
create index if not exists ix_notifications_scope     on notifications (hospital_id, role, created_at desc);
create index if not exists ix_vela_staff_hospital     on vela_staff (hospital_id, role);
create index if not exists ix_wards_hospital          on wards (hospital_id);
create index if not exists ix_beds_hospital           on beds (hospital_id);
create index if not exists ix_beds_ward               on beds (ward_id);
create index if not exists ix_walkthrough_hospital    on vela_walkthrough (hospital_id);
create index if not exists ix_voice_queries_created   on voice_queries (created_at);
create index if not exists ix_reassess_patient        on reassess_requests (patient_id, requested_at);
create index if not exists ix_net_appts_hospital      on network_appointments (hospital_id);
create index if not exists ix_net_doc_appts_doctor    on network_doctor_appointments (doctor_id);

-- ---------------------------------------------------------------------
-- Lock it down: only the backend (service-role key) touches tables.
-- RLS on everywhere, no anon/authenticated policies, privileges revoked.
-- Browsers keep the anon key for Supabase Auth (patient sign-up) only.
-- ---------------------------------------------------------------------
do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
    execute format('alter table public.%I force row level security', t.tablename);
  end loop;
end $$;

revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables    from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;

notify pgrst, 'reload schema';
