-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/ddxlybmnbfyesgwattax/sql

-- Network Hospitals table
CREATE TABLE IF NOT EXISTS network_hospitals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    place_id TEXT UNIQUE NOT NULL,
    lat FLOAT8,
    lng FLOAT8,
    specializations TEXT[] DEFAULT '{}',
    receptionist_email TEXT UNIQUE NOT NULL,
    receptionist_password_hash TEXT NOT NULL,
    receptionist_name TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Network Appointments table
CREATE TABLE IF NOT EXISTS network_appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id UUID REFERENCES network_hospitals(id) ON DELETE CASCADE,
    patient_id TEXT NOT NULL,
    patient_name TEXT NOT NULL,
    vela_id TEXT,
    date DATE NOT NULL,
    time TIME NOT NULL,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'arrived', 'cancelled')),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_network_appointments_hospital ON network_appointments(hospital_id);
CREATE INDEX IF NOT EXISTS idx_network_hospitals_place_id ON network_hospitals(place_id);
CREATE INDEX IF NOT EXISTS idx_network_hospitals_email ON network_hospitals(receptionist_email);

-- ─────────────────────────────────────────────────────────────────────────
-- Provider Network extension — independent labs and solo doctors.
--
-- A hospital-affiliated lab or doctor never touches these tables: they stay
-- scoped to their hospital's own hospital_id, exactly as today (lab_catalog /
-- lab_templates for labs, vela_staff for doctors). These tables only exist
-- for providers that are NOT part of any hospital and therefore onboard
-- directly through Vela ("through us"), mirroring network_hospitals above.
-- ─────────────────────────────────────────────────────────────────────────

-- Network Labs table — an independently-run diagnostic lab.
CREATE TABLE IF NOT EXISTS network_labs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    address TEXT NOT NULL,
    place_id TEXT UNIQUE NOT NULL,
    lat FLOAT8,
    lng FLOAT8,
    departments TEXT[] DEFAULT '{}',        -- e.g. {pathology, radiology}
    contact_name TEXT NOT NULL,
    login_email TEXT UNIQUE NOT NULL,       -- lab.<slug>@vela.health
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Network Doctors table — a solo/independent practitioner (small clinic, no
-- hospital affiliation). `verified` gates login until a Vela admin confirms
-- the license_number by hand (see Phase 3 onboarding UI) — an unverified
-- account can be registered but cannot log in or receive patients yet.
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
    login_email TEXT UNIQUE NOT NULL,       -- doctor.<slug>@vela.health
    password_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Network Doctor Appointments table — booking a solo doctor, same shape as
-- network_appointments so the frontend can treat both the same way.
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
