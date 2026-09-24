-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/ddxlybmnbfyesgwattax/sql

-- VELA Core Hospitals Table
CREATE TABLE IF NOT EXISTS vela_hospitals (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    address TEXT,
    city TEXT,
    state TEXT,
    phone TEXT,
    email TEXT,
    specializations TEXT[] DEFAULT '{}',
    total_beds INTEGER DEFAULT 10,
    latitude FLOAT8,
    longitude FLOAT8,
    mapbox_place_id TEXT,
    manager_name TEXT,
    manager_email TEXT UNIQUE,
    manager_password TEXT,
    hospital_slug TEXT UNIQUE,
    verified BOOLEAN DEFAULT FALSE,
    active BOOLEAN DEFAULT TRUE,
    health_score INTEGER DEFAULT 85,
    staff_count INTEGER DEFAULT 0,
    active_staff INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Wards and Beds
CREATE TABLE IF NOT EXISTS wards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id UUID REFERENCES vela_hospitals(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    type TEXT, -- 'general', 'icu', 'emergency', etc.
    floor_number INTEGER DEFAULT 1,
    color TEXT DEFAULT '#0F766E',
    x INTEGER DEFAULT 0,
    y INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS beds (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ward_id UUID REFERENCES wards(id) ON DELETE CASCADE,
    hospital_id UUID REFERENCES vela_hospitals(id) ON DELETE CASCADE,
    bed_number TEXT NOT NULL,
    status TEXT DEFAULT 'available', -- 'available', 'occupied', 'maintenance'
    patient_id UUID, -- References patients(id)
    assigned_doctor UUID, -- References vela_staff(id)
    admitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Staff Management
CREATE TABLE IF NOT EXISTS vela_staff (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id UUID REFERENCES vela_hospitals(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    role TEXT NOT NULL, -- 'doctor', 'nurse', 'receptionist', 'admin'
    email TEXT UNIQUE,
    phone TEXT,
    specialization TEXT,
    status TEXT DEFAULT 'active', -- 'active', 'on_leave', 'offline'
    ward_id UUID REFERENCES wards(id),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Patients and Admissions
CREATE TABLE IF NOT EXISTS patients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    vela_id TEXT UNIQUE, -- Format VELA-XXXX
    name TEXT NOT NULL,
    age INTEGER,
    gender TEXT,
    phone TEXT,
    email TEXT,
    address TEXT,
    risk_score INTEGER DEFAULT 0,
    diagnosis TEXT,
    blood_group TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS admissions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
    hospital_id UUID REFERENCES vela_hospitals(id) ON DELETE CASCADE,
    bed_id UUID REFERENCES beds(id),
    admitted_at TIMESTAMPTZ DEFAULT NOW(),
    discharged_at TIMESTAMPTZ,
    status TEXT DEFAULT 'active', -- 'active', 'discharged'
    diagnosis TEXT,
    treating_doctor UUID REFERENCES hospital_staff(id)
);

-- Medical Documents
CREATE TABLE IF NOT EXISTS documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID REFERENCES patients(id) ON DELETE CASCADE,
    uploader_id UUID, -- Could be staff_id or patient_id
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL, -- Supabase Storage path
    file_type TEXT,
    summary TEXT,
    risk_score INTEGER,
    values JSONB, -- Extracted medical values
    report_date DATE DEFAULT CURRENT_DATE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- VELA Appointments & Notifications
CREATE TABLE IF NOT EXISTS appointments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patient_id UUID NOT NULL,
    hospital_id UUID REFERENCES vela_hospitals(id), -- Nullable for non-network hospitals
    hospital_name TEXT,
    hospital_address TEXT,
    date DATE NOT NULL,
    time TIME NOT NULL,
    doctor_name TEXT DEFAULT 'General Physician',
    status TEXT DEFAULT 'scheduled',
    notes JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id UUID REFERENCES vela_hospitals(id),
    role TEXT, -- 'receptionist', 'doctor', 'manager'
    message TEXT NOT NULL,
    type TEXT DEFAULT 'info', -- 'info', 'warning', 'emergency', 'appointment'
    read BOOLEAN DEFAULT FALSE,
    action_url TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_vela_hospitals_slug ON vela_hospitals(hospital_slug);
CREATE INDEX IF NOT EXISTS idx_vela_staff_email ON vela_staff(email);
CREATE INDEX IF NOT EXISTS idx_appointments_patient ON appointments(patient_id);
CREATE INDEX IF NOT EXISTS idx_appointments_hospital ON appointments(hospital_id);
CREATE INDEX IF NOT EXISTS idx_appointments_date ON appointments(date);
CREATE INDEX IF NOT EXISTS idx_notifications_hospital_role ON notifications(hospital_id, role);

-- Walkthrough Tracking
CREATE TABLE IF NOT EXISTS vela_walkthrough (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    hospital_id UUID REFERENCES vela_hospitals(id),
    completed BOOLEAN DEFAULT FALSE,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);
