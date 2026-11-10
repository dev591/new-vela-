// Demo mode: the guided path a judge follows (Patient -> Reception -> Doctor) and the one hospital
// everything is booked at. Everything here is synthetic demo data.
//
// The demo passwords come from VITE_DEMO_* variables at build time, so none is committed to git.
// Anything in a VITE_* variable ends up in the public bundle: only ever use throwaway demo accounts.

export const DEMO_MODE = import.meta.env.VITE_DEMO_MODE !== 'false'

// The only hospital a demo patient can book at (default: the seeded "VELA Care" hospital).
export const DEMO_HOSPITAL_ID: string =
  import.meta.env.VITE_DEMO_HOSPITAL_ID || 'aab8d6e2-69d2-43da-88e9-56cdfc8daa4e'

export type DemoRole = 'patient' | 'receptionist' | 'doctor'

export interface DemoAccount { email: string; password: string }

export const DEMO_ACCOUNTS: Record<DemoRole, DemoAccount> = {
  patient: {
    email: import.meta.env.VITE_DEMO_PATIENT_EMAIL || 'patient@vela.ai',
    password: import.meta.env.VITE_DEMO_PATIENT_PASSWORD || '',
  },
  receptionist: {
    email: 'meera.shah@vela-care-gachibowli.vela.health',
    password: import.meta.env.VITE_DEMO_RECEPTION_PASSWORD || '',
  },
  doctor: {
    email: 'drarjun.rao@vela-care-gachibowli.vela.health',
    password: import.meta.env.VITE_DEMO_DOCTOR_PASSWORD || '',
  },
}

// One entry per step of the path, in order. `todo` is what to do once signed in.
export const DEMO_STEPS: { role: DemoRole; n: number; who: string; name: string; todo: string[] }[] = [
  { role: 'patient', n: 1, who: 'Patient', name: 'Rajesh Kumar', todo: [
    'Open the “Book a visit” tab.',
    'Pick VELA Care (the only hospital in the demo).',
    'Choose Dr. Arjun Rao, a day and a time, then press “Confirm Appointment”.',
  ] },
  { role: 'receptionist', n: 2, who: 'Reception', name: 'Meera Shah', todo: [
    'Open the “Appointments” tab on the left.',
    'Find Rajesh Kumar’s request and press “Accept Request”.',
    'Keep Dr. Arjun Rao as the doctor and press “Confirm & Accept”. He joins the queue.',
  ] },
  { role: 'doctor', n: 3, who: 'Doctor', name: 'Dr. Arjun Rao', todo: [
    'Rajesh Kumar is now in your queue. Open his record.',
    'Press Space and say: “Order a CBC test for him.” Atlas orders one Blood CBC (pathology, ₹350). Say it again and it tells you it is already ordered.',
    'Say: “Admit him, he is critical.” Atlas recommends an ICU bed and asks to notify reception. If he is already in a bed it says so instead.',
    'Optional: open “Virtual consult” and type VLA-9002 for the spoken report.',
  ] },
]

export function demoStepForRole(role: DemoRole) {
  return DEMO_STEPS.find(s => s.role === role)!
}

/** Keep only the demo hospital in a hospital list (never returns an empty list if the id is missing). */
export function onlyDemoHospital<T extends { id?: string }>(list: T[]): T[] {
  if (!DEMO_MODE) return list
  const hit = list.filter(h => String(h.id) === DEMO_HOSPITAL_ID)
  return hit.length ? hit : list.slice(0, 1)
}
