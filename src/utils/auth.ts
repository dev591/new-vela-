import axios from 'axios'
import { API_URL } from './config'

export function getUser() {
  const u = localStorage.getItem("vela_user")
  return u ? JSON.parse(u) : null
}

export function getToken(): string | null {
  return localStorage.getItem("vela_token")
}

export function logout() {
  const token = getToken()
  if (token) {
    // Revokes the token server-side (and marks staff offline), so a copied
    // token stops working the moment the user signs out.
    fetch(`${API_URL}/api/auth/logout`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}` },
      keepalive: true,
    }).catch(() => {})
  }
  localStorage.clear()
  try { sessionStorage.clear() } catch { /* ignore */ }
  window.location.href = "/login"
}

export function isAuthenticated(): boolean {
  return localStorage.getItem("vela_auth") === "true"
}

export function getPatientVelaId(): string | null {
  return localStorage.getItem("vela_patient_id")
}

export async function networkReceptionistLogin(email: string, password: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/network/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    const data = await res.json()
    if (data.status === 'success') {
      if (data.token) localStorage.setItem('vela_token', data.token)
      localStorage.setItem('vela_user', JSON.stringify({ name: data.receptionist_name, role: 'Receptionist', hospital_name: data.hospital_name }))
      localStorage.setItem('vela_auth', 'true')
      localStorage.setItem('vela_role', 'receptionist')
      localStorage.setItem('vela_hospital_id', data.hospital_id)
      return true
    }
    return false
  } catch {
    return false
  }
}

// Independent (non-hospital) lab — see plan Phase 3/4. Stores vela_network_lab_id
// instead of vela_hospital_id so LabController.tsx can tell the two apart.
export async function networkLabLogin(email: string, password: string): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/api/network/labs/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    const data = await res.json()
    if (data.status === 'success') {
      if (data.token) localStorage.setItem('vela_token', data.token)
      localStorage.setItem('vela_user', JSON.stringify({ name: data.lab_name, role: 'Lab Controller' }))
      localStorage.setItem('vela_auth', 'true')
      localStorage.setItem('vela_role', 'lab_controller')
      localStorage.setItem('vela_network_lab_id', data.lab_id)
      return true
    }
    return false
  } catch {
    return false
  }
}

// Solo/independent doctor — see plan Phase 3/5. Login fails until a Vela
// admin has verified the license (main.py: /api/network/doctors/{id}/verify).
export async function networkDoctorLogin(email: string, password: string): Promise<{ success: boolean; message?: string }> {
  try {
    const res = await fetch(`${API_URL}/api/network/doctors/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    const data = await res.json()
    if (data.status === 'success') {
      if (data.token) localStorage.setItem('vela_token', data.token)
      localStorage.setItem('vela_user', JSON.stringify({ name: data.doctor_name, role: 'Doctor' }))
      localStorage.setItem('vela_auth', 'true')
      localStorage.setItem('vela_role', 'doctor')
      localStorage.setItem('vela_network_doctor_id', data.doctor_id)
      return { success: true }
    }
    return { success: false, message: data.message }
  } catch {
    return { success: false }
  }
}

// Cached records (vela_patient, the dashboard's saved lists) must not outlive
// the session on a shared device. Mirrors the server's token lifetimes:
// patients stay signed in for 30 days, staff for 12 hours. Run at startup.
const LOCAL_SESSION_TTL_MS = { patient: 30 * 24 * 3600 * 1000, staff: 12 * 3600 * 1000 }

export function enforceLocalSessionExpiry() {
  try {
    if (!isAuthenticated()) return
    const started = Number(localStorage.getItem('vela_session_started') || 0)
    if (!started) {
      localStorage.setItem('vela_session_started', String(Date.now()))
      return
    }
    const ttl = localStorage.getItem('vela_role') === 'patient' ? LOCAL_SESSION_TTL_MS.patient : LOCAL_SESSION_TTL_MS.staff
    if (Date.now() - started > ttl) localStorage.clear()
  } catch { /* storage blocked: nothing cached to expire */ }
}

// Attach the session token to every backend request without touching each
// call site: wrap window.fetch once at startup. Requests to other hosts are
// untouched, so the token never leaks to third parties. A 401 on a protected
// page means the session expired server-side → clear it and return to login.
export function installAuthFetch() {
  const originalFetch = window.fetch.bind(window)
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const isApiCall = url.startsWith(API_URL)
    if (isApiCall) {
      const token = getToken()
      if (token) {
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
        headers.set('Authorization', `Bearer ${token}`)
        init = { ...init, headers }
      }
    }
    const response = await originalFetch(input, init)
    if (isApiCall && response.status === 401 && isAuthenticated() && !window.location.pathname.startsWith('/login')) {
      localStorage.clear()
      window.location.href = '/login'
    }
    return response
  }
}

// axios talks to XMLHttpRequest, not window.fetch, so installAuthFetch above
// never sees its requests — the pages built on axios need their own hook to
// get the same token and the same 401 handling.
export function installAuthAxios() {
  axios.interceptors.request.use((config) => {
    if ((config.url ?? '').startsWith(API_URL)) {
      const token = getToken()
      if (token) config.headers.set('Authorization', `Bearer ${token}`)
    }
    return config
  })
  axios.interceptors.response.use(
    (response) => response,
    (error) => {
      const isApiCall = (error.config?.url ?? '').startsWith(API_URL)
      if (isApiCall && error.response?.status === 401 && isAuthenticated()
        && !window.location.pathname.startsWith('/login')) {
        localStorage.clear()
        window.location.href = '/login'
      }
      return Promise.reject(error)
    }
  )
}
