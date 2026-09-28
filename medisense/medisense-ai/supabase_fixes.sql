-- ═══════════════════════════════════════════════════════════════════════════
-- VELA — Supabase fixes (run ONCE in: Supabase Dashboard → SQL Editor → New query)
--
-- Safe to run more than once: every statement is CREATE ... IF NOT EXISTS or
-- ADD COLUMN IF NOT EXISTS. It only ADDS things; it never drops or changes data.
--
-- Why this exists: the older create_vela_tables.sql / create_network_tables.sql
-- failed part-way (they reference a table `hospital_staff` and a column
-- `appointments.hospital_id` that don't exist), so these were never created.
-- No foreign keys are used on purpose, so nothing here can fail on a missing table.
-- ═══════════════════════════════════════════════════════════════════════════

-- 1) Columns the admit / discharge flow and the ward map write to ─────────────
ALTER TABLE patients ADD COLUMN IF NOT EXISTS is_admitted BOOLEAN DEFAULT FALSE;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS current_admission_id TEXT;
ALTER TABLE patients ADD COLUMN IF NOT EXISTS last_visit_date TIMESTAMPTZ;

ALTER TABLE wards ADD COLUMN IF NOT EXISTS x DOUBLE PRECISION;
ALTER TABLE wards ADD COLUMN IF NOT EXISTS y DOUBLE PRECISION;

-- 2) Notifications (reception "new appointment" banners, bell icon) ───────────
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id UUID,
    role TEXT,                               -- 'receptionist', 'doctor', 'manager'
    message TEXT NOT NULL,
    type TEXT DEFAULT 'info',                -- 'info', 'warning', 'emergency', 'appointment'
    read BOOLEAN DEFAULT FALSE,
    action_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_notifications_hospital_role ON notifications(hospital_id, role);

-- 3) Admissions (the app also keeps a local copy; this lets Supabase-side reads work) ──
CREATE TABLE IF NOT EXISTS admissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID,
    hospital_id UUID,
    bed_id UUID,
    admitted_at TIMESTAMPTZ DEFAULT NOW(),
    discharged_at TIMESTAMPTZ,
    status TEXT DEFAULT 'active',            -- 'active', 'discharged'
    diagnosis TEXT,
    reason TEXT,
    recommended_by TEXT,
    room_type TEXT,
    admission_qr TEXT
);
CREATE INDEX IF NOT EXISTS idx_admissions_hospital ON admissions(hospital_id);
CREATE INDEX IF NOT EXISTS idx_admissions_patient ON admissions(patient_id);

-- 4) "Ask for reassessment" on a lab report ───────────────────────────────────
CREATE TABLE IF NOT EXISTS reassess_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id TEXT NOT NULL,
    test_order_id TEXT,
    lab_report_id TEXT,
    status TEXT DEFAULT 'pending',
    requested_at TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reassess_patient ON reassess_requests(patient_id, requested_at);

-- 5) Independent labs and solo doctors (VELA Owner → register lab / doctor) ───
CREATE TABLE IF NOT EXISTS network_labs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    place_id TEXT UNIQUE NOT NULL,
    lat FLOAT8,
    lng FLOAT8,
    departments TEXT[] DEFAULT '{}',         -- e.g. {pathology,radiology}
    contact_name TEXT NOT NULL,
    login_email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS network_doctors (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    specialization TEXT NOT NULL,
    address TEXT NOT NULL,
    place_id TEXT UNIQUE NOT NULL,
    lat FLOAT8,
    lng FLOAT8,
    consultation_fee REAL DEFAULT 0.0,
    license_number TEXT NOT NULL,
    verified BOOLEAN DEFAULT FALSE,
    login_email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS network_doctor_appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    doctor_id UUID REFERENCES network_doctors(id) ON DELETE CASCADE,
    patient_id TEXT NOT NULL,
    patient_name TEXT NOT NULL,
    vela_id TEXT,
    date DATE NOT NULL,
    time TIME NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'arrived', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_network_labs_place_id ON network_labs(place_id);
CREATE INDEX IF NOT EXISTS idx_network_labs_email ON network_labs(login_email);
CREATE INDEX IF NOT EXISTS idx_network_doctors_place_id ON network_doctors(place_id);
CREATE INDEX IF NOT EXISTS idx_network_doctors_email ON network_doctors(login_email);
CREATE INDEX IF NOT EXISTS idx_network_doctor_appointments_doctor ON network_doctor_appointments(doctor_id);

-- 6) Same access model as your existing tables ────────────────────────────────
-- The backend reads these with the anon key, exactly like patients/tickets/etc.
ALTER TABLE notifications               DISABLE ROW LEVEL SECURITY;
ALTER TABLE admissions                  DISABLE ROW LEVEL SECURITY;
ALTER TABLE reassess_requests           DISABLE ROW LEVEL SECURITY;
ALTER TABLE network_labs                DISABLE ROW LEVEL SECURITY;
ALTER TABLE network_doctors             DISABLE ROW LEVEL SECURITY;
ALTER TABLE network_doctor_appointments DISABLE ROW LEVEL SECURITY;

-- 7) Make the API see the new tables/columns immediately ──────────────────────
NOTIFY pgrst, 'reload schema';
