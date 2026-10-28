import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { AnimatePresence, animate, motion } from 'framer-motion'
import {
  ArrowRight, ArrowLeft, Check, Eye, EyeOff, FlaskConical, HeartPulse, LayoutDashboard,
  Loader2, Lock, Stethoscope, ClipboardList, type LucideIcon,
} from 'lucide-react'
import ParticleField from '../components/cinematic/ParticleField'
import CinematicCursor from '../components/cinematic/CinematicCursor'
import { networkReceptionistLogin, networkLabLogin, networkDoctorLogin } from '../utils/auth'
import { API_URL } from '../utils/config'
import { resetSocket } from '../hooks/useSocket'

type Role = 'doctor' | 'receptionist' | 'hospital_manager' | 'lab_controller'

/**
 * Sign-in — editorial clinical.
 *
 * Two steps: pick a workspace, then authenticate. The workspace list is a
 * numbered editorial index rather than a card grid, and the form sits against a
 * dark panel that names the role in display type — so you always know which
 * door you are walking through.
 */

const roleDetails: Record<Role, {
  n: string;
  label: string;
  description: string;
  demoEmail?: string;
  // Only set from a local .env (VITE_DEMO_*_PASSWORD) on a demo machine, so
  // no password is ever committed or shipped in a production bundle.
  demoPassword: string;
  route: string;
  features: string[];
}> = {
  doctor: {
    n: '01',
    label: 'Doctor',
    description: 'Clinical command centre — queue, records, imaging and Atlas',
    demoEmail: 'drhimanshu@aiims-road.vela.health',
    demoPassword: import.meta.env.VITE_DEMO_DOCTOR_PASSWORD || '',
    route: '/dashboard',
    features: ['Live patient queue', 'Atlas voice interface', 'Imaging second read', 'Risk scoring & alerts'],
  },
  receptionist: {
    n: '02',
    label: 'Reception',
    description: 'Patient intake, registration and queue management',
    demoEmail: 'drdev@aiims-road.vela.health',
    demoPassword: import.meta.env.VITE_DEMO_RECEPTION_PASSWORD || '',
    route: '/receptionist',
    features: ['Patient registration', 'Queue management', 'Appointment booking', 'Document upload'],
  },
  hospital_manager: {
    n: '03',
    label: 'Management',
    description: 'Facility oversight, occupancy and live analytics',
    demoEmail: 'manager@vela.ai',
    demoPassword: import.meta.env.VITE_DEMO_MANAGER_PASSWORD || '',
    route: '/hospital-manager',
    features: ['Live analytics', 'Ward and bed view', 'Staff management', 'Throughput reporting'],
  },
  lab_controller: {
    n: '04',
    label: 'Laboratory',
    description: 'Diagnostics, sample queue and report generation',
    demoEmail: 'lab.controller@aiims-road.vela.health',
    demoPassword: import.meta.env.VITE_DEMO_LAB_PASSWORD || '',
    route: '/lab-controller',
    features: ['Real-time test queue', 'Report generation', 'Payment verification', 'Department routing'],
  },
}

const ROLE_ICONS: Record<Role, LucideIcon> = {
  doctor: Stethoscope,
  receptionist: ClipboardList,
  hospital_manager: LayoutDashboard,
  lab_controller: FlaskConical,
}

export default function Login() {
  const [step, setStep] = useState<'select' | 'form'>('select')
  const [role, setRole] = useState<Role>('doctor')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [patientLoading, setPatientLoading] = useState(false)
  const [copiedField, setCopiedField] = useState<'email' | 'password' | null>(null)

  const [hoverRole, setHoverRole] = useState<Role | null>(null)

  const navigate = useNavigate()
  // Scattered points gather into the record ring as the page opens.
  const ringProgress = useRef(0)

  useEffect(() => {
    const controls = animate(0, 1, {
      duration: 2.4, delay: 0.3, ease: [0.32, 0.72, 0, 1],
      onUpdate: v => { ringProgress.current = v },
    })
    return () => controls.stop()
  }, [])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    // Clear old staff/auth/user data to prevent state leaks between logins!
    resetSocket()
    localStorage.removeItem('vela_staff_id')
    localStorage.removeItem('vela_staff_name')
    localStorage.removeItem('vela_hospital_id')
    localStorage.removeItem('vela_hospital_name')
    localStorage.removeItem('vela_specialization')
    localStorage.removeItem('vela_role')
    localStorage.removeItem('vela_user')
    localStorage.removeItem('vela_auth')
    localStorage.removeItem('vela_network_lab_id')
    localStorage.removeItem('vela_network_doctor_id')
    localStorage.removeItem('vela_session_started')

    if (!email.trim()) return setError('Email is required')
    if (!password.trim()) return setError('Password is required')

    setLoading(true)
    // Network receptionist emails are async — handle separately
    if (role === 'receptionist' && /^reception\..+@vela\.health$/.test(email.trim())) {
      networkReceptionistLogin(email.trim(), password).then(success => {
        if (success) {
          navigate(roleDetails[role].route)
        } else {
          setError('Invalid credentials for ' + roleDetails[role].label)
          setLoading(false)
        }
      })
      return
    }
    // Independent lab — not part of any hospital, see plan Phase 3.
    if (role === 'lab_controller' && /^lab\..+@vela\.health$/.test(email.trim())) {
      networkLabLogin(email.trim(), password).then(success => {
        if (success) {
          navigate(roleDetails[role].route)
        } else {
          setError('Invalid credentials for ' + roleDetails[role].label)
          setLoading(false)
        }
      })
      return
    }
    // Solo doctor — not part of any hospital, see plan Phase 3/5.
    if (role === 'doctor' && /^doctor\..+@vela\.health$/.test(email.trim())) {
      networkDoctorLogin(email.trim(), password).then(({ success, message }) => {
        if (success) {
          navigate(roleDetails[role].route)
        } else {
          setError(message || 'Invalid credentials for ' + roleDetails[role].label)
          setLoading(false)
        }
      })
      return
    }
    if (role === 'hospital_manager') {
      fetch(`${API_URL}/api/manager/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), password }),
        signal: AbortSignal.timeout(20000)
      }).then(r => r.json()).then(mData => {
        if (mData.status === 'success') {
          localStorage.setItem('vela_token', mData.token || '')
          localStorage.setItem('vela_auth', 'true')
          localStorage.setItem('vela_role', 'hospital_manager')
          localStorage.setItem('vela_hospital_id', mData.hospital_id || '')
          localStorage.setItem('vela_hospital_name', mData.hospital_name || '')
          localStorage.setItem('vela_user', JSON.stringify({ name: mData.manager_name, role: 'Hospital Manager' }))
          if (!mData.walkthrough_done) {
            localStorage.setItem('vela_walkthrough_done', 'false')
            navigate('/walkthrough')
          } else {
            navigate('/hospital-manager')
          }
        } else {
          setError('Invalid credentials. Contact Vela to get your hospital onboarded.')
          setLoading(false)
        }
      }).catch((err) => {
        const isTimeout = err?.name === 'AbortError' || err?.name === 'TimeoutError'
        setError(isTimeout ? 'Server took too long to respond. Please try again.' : 'Backend not reachable. Is the server running?')
        setLoading(false)
      })
      return
    }

    // Doctor / receptionist / lab controller all authenticate against the
    // vela_staff table.
    fetch(`${API_URL}/api/staff/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email.trim(), password }),
      signal: AbortSignal.timeout(20000)
    }).then(r => r.json()).then(data => {
      if (data.status === 'success') {
        localStorage.setItem('vela_token', data.token || '')
        localStorage.setItem('vela_auth', 'true')
        localStorage.setItem('vela_role', data.role)
        localStorage.setItem('vela_hospital_id', data.hospital_id || '')
        localStorage.setItem('vela_hospital_name', data.hospital_name || '')
        localStorage.setItem('vela_staff_id', data.staff_id || '')
        localStorage.setItem('vela_staff_name', data.name || '')
        localStorage.setItem('vela_user', JSON.stringify({ name: data.name, role: data.role, specialization: data.specialization }))
        localStorage.setItem('vela_specialization', data.specialization || '')
        const dest = data.role === 'doctor' ? '/dashboard' : data.role === 'receptionist' ? '/receptionist' : '/lab-controller'
        navigate(dest)
      } else {
        setError('Invalid credentials for ' + roleDetails[role].label)
        setLoading(false)
      }
    }).catch((err) => {
      // AbortError = server timeout; show a clear error instead of spinning forever
      const isTimeout = err?.name === 'AbortError' || err?.name === 'TimeoutError'
      setError(isTimeout ? 'Server took too long to respond. Please try again.' : 'Backend not reachable. Is the server running?')
      setLoading(false)
    })
  }

  /**
   * Patient demo entry. Uses /api/demo/login-patient, which seeds Rajesh Kumar
   * if missing and returns a real session token. The previous implementation
   * called /api/patient/by-email directly, which the auth middleware rejects
   * with a 401 because no session exists yet at that point.
   */
  const enterAsPatient = async () => {
    setPatientLoading(true)
    setError('')
    // The demo patient is a fixed seed account: never fall through to "create account".
    // Retry a couple of times (cold database / first request), then show a clear message.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(`${API_URL}/api/demo/login-patient`, { method: 'POST', signal: AbortSignal.timeout(15000) })
        const data = await res.json()
        if (data?.status === 'success' && data.patient) {
          localStorage.setItem('vela_token', data.token || '')
          localStorage.setItem('vela_auth', 'true')
          localStorage.setItem('vela_role', 'patient')
          localStorage.setItem('vela_vela_id', data.vela_id || '')
          localStorage.setItem('vela_patient', JSON.stringify(data.patient))
          localStorage.setItem('vela_email', data.patient.email || '')
          setPatientLoading(false)
          navigate('/patient-dashboard')
          return
        }
      } catch {
        /* retry below */
      }
      await new Promise(r => setTimeout(r, 600 * (attempt + 1)))
    }
    setError("Couldn't open the demo patient. Please check the server is running and tap again.")
    setPatientLoading(false)
  }

  const copyValue = (value: string, type: 'email' | 'password') => {
    navigator.clipboard.writeText(value)
    setCopiedField(type)
    window.setTimeout(() => setCopiedField(null), 1500)
  }

  const selected = roleDetails[role]
  const previewRole: Role = hoverRole ?? role
  const preview = roleDetails[previewRole]
  const ease = [0.32, 0.72, 0, 1] as const

  const fillDemo = () => {
    if (selected.demoEmail) setEmail(selected.demoEmail)
    if (selected.demoPassword) setPassword(selected.demoPassword)
  }

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-[0.48fr_0.52fr] bg-[#F5F5F7] text-[#1D1D1F]">
      <CinematicCursor />

      {/* The landing leaves on a black iris; this page opens out of it. */}
      <motion.div
        className="fixed inset-0 z-[200] bg-black pointer-events-none"
        initial={{ opacity: 1 }} animate={{ opacity: 0 }} transition={{ duration: 0.9, ease }}
        aria-hidden="true"
      />

      {/* ── Theatre panel: the record ring, previewing the workspace ── */}
      <aside className="theatre film-grain relative overflow-hidden min-h-[46vh] lg:min-h-screen flex flex-col justify-between p-8 md:p-12">
        <ParticleField progress={ringProgress} shape="ring" count={1800} className="absolute inset-0" />
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(40% 40% at 50% 50%, rgba(0,113,227,0.22), transparent 70%)' }} />

        <button type="button" onClick={() => navigate('/')} data-cursor="Home"
          className="relative z-10 self-start text-[22px] font-semibold tracking-[-0.04em] text-white">
          Vela
        </button>

        <div className="relative z-10 text-center">
          <AnimatePresence mode="wait">
            <motion.div key={step === 'select' && !hoverRole ? 'welcome' : previewRole}
              initial={{ opacity: 0, y: 18, filter: 'blur(10px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -18, filter: 'blur(10px)' }}
              transition={{ duration: 0.45, ease }}>
              {step === 'select' && !hoverRole ? (
                <>
                  <div className="text-[13px] font-semibold text-[#2997FF] mb-4">Welcome back</div>
                  <h2 className="text-[clamp(2.4rem,4.6vw,4.4rem)] font-semibold tracking-[-0.05em] leading-[0.98]">
                    One record.<br /><span className="text-gradient-blue">Every role.</span>
                  </h2>
                </>
              ) : (
                <>
                  <div className="text-[13px] font-semibold text-[#2997FF] mb-4">Workspace {preview.n}</div>
                  <h2 className="text-[clamp(2.6rem,5vw,4.8rem)] font-semibold tracking-[-0.05em] leading-[0.98]">{preview.label}</h2>
                  <p className="t-2 mt-4 text-[16px] max-w-sm mx-auto leading-relaxed">{preview.description}.</p>
                  <div className="mt-8 flex flex-wrap justify-center gap-2 max-w-md mx-auto">
                    {preview.features.map((f, i) => (
                      <motion.span key={f} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.12 + i * 0.05, duration: 0.35, ease }}
                        className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/[0.06] px-3.5 py-1.5 text-[13px] text-white/80">
                        <Check size={13} className="text-[#2997FF]" /> {f}
                      </motion.span>
                    ))}
                  </div>
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="relative z-10 flex items-center justify-between text-[12px] t-3">
          <span className="flex items-center gap-2"><Lock size={13} /> Encrypted · Role-scoped access</span>
          <span>© 2026 Vela</span>
        </div>
      </aside>

      {/* ── Light panel: choose, then authenticate ── */}
      <main className="relative flex items-center justify-center px-6 md:px-12 lg:px-16 py-14">
        <AnimatePresence mode="wait">
          {step === 'select' ? (
            <motion.div key="select" className="w-full max-w-[520px]"
              initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -40 }} transition={{ duration: 0.5, ease }}>
              <div className="text-[13px] font-semibold text-[#0071E3] mb-3">Sign in</div>
              <h1 className="text-[clamp(2.2rem,3.6vw,3.2rem)] font-semibold tracking-[-0.045em] leading-[1.02] mb-3">Choose your workspace.</h1>
              <p className="text-[16px] text-[#515154] mb-9">Every role sees the same patient record, scoped to what that role needs.</p>

              <div className="flex flex-col gap-2.5" onMouseLeave={() => setHoverRole(null)}>
                {(Object.keys(roleDetails) as Role[]).map((r, i) => {
                  const Icon = ROLE_ICONS[r]
                  return (
                    <motion.button key={r} type="button"
                      initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.08 + i * 0.06, duration: 0.45, ease }}
                      onMouseEnter={() => setHoverRole(r)} onFocus={() => setHoverRole(r)}
                      onClick={() => { setRole(r); setStep('form'); setError(''); setHoverRole(null) }}
                      className="group w-full text-left flex items-center gap-4 rounded-2xl bg-white px-5 py-4 border border-black/[0.06] shadow-[0_1px_2px_rgba(0,0,0,0.04)] hover:shadow-[0_18px_40px_-18px_rgba(0,0,0,0.25)] hover:-translate-y-0.5">
                      <span className="w-11 h-11 rounded-xl grid place-items-center bg-[#E8F2FD] text-[#0071E3] group-hover:bg-[#0071E3] group-hover:text-white transition-colors"><Icon size={20} /></span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-[17px] font-semibold tracking-[-0.02em]">{roleDetails[r].label}</span>
                        <span className="block text-[14px] text-[#6E6E73] truncate">{roleDetails[r].description}</span>
                      </span>
                      <ArrowRight size={18} className="text-[#6E6E73] transition-transform group-hover:translate-x-1 group-hover:text-[#0071E3]" />
                    </motion.button>
                  )
                })}

                <motion.button type="button" onClick={enterAsPatient} disabled={patientLoading}
                  initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.36, duration: 0.45, ease }}
                  className="group mt-3 w-full text-left flex items-center gap-4 rounded-2xl bg-[#1D1D1F] text-white px-5 py-4 disabled:opacity-60">
                  <span className="w-11 h-11 rounded-xl grid place-items-center bg-white/10 text-[#2997FF]"><HeartPulse size={20} /></span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-[17px] font-semibold tracking-[-0.02em]">Patient <span className="ml-2 text-[12px] font-semibold text-[#2997FF]">Demo</span></span>
                    <span className="block text-[14px] text-white/60 truncate">{patientLoading ? 'Opening your record…' : 'Personal health record — enter as Rajesh Kumar'}</span>
                  </span>
                  {patientLoading ? <Loader2 size={18} className="animate-spin" /> : <ArrowRight size={18} className="text-white/60 transition-transform group-hover:translate-x-1" />}
                </motion.button>
              </div>

              {error && <p className="mt-5 text-[14px] text-[#D70015]">{error}</p>}
            </motion.div>
          ) : (
            <motion.div key="form" className="w-full max-w-[440px]"
              initial={{ opacity: 0, x: 40 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -40 }} transition={{ duration: 0.5, ease }}>
              <button type="button" onClick={() => { setStep('select'); setError('') }}
                className="inline-flex items-center gap-2 h-10 -ml-3 px-3 rounded-full text-[14px] text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-black/5 mb-8">
                <ArrowLeft size={16} /> All workspaces
              </button>

              <h1 className="text-[clamp(2.2rem,3.6vw,3rem)] font-semibold tracking-[-0.045em] leading-none mb-3">Sign in</h1>
              <p className="text-[16px] text-[#515154] mb-9">
                {role === 'hospital_manager' ? 'Enter the credentials provided by Vela.' : `Access the ${selected.label.toLowerCase()} workspace.`}
              </p>

              <form onSubmit={handleLogin} className="flex flex-col gap-4">
                <label className="block rounded-2xl bg-white border border-black/[0.08] px-4 pt-3 pb-2.5 focus-within:border-[#0071E3] focus-within:ring-4 focus-within:ring-[#0071E3]/15 transition">
                  <span className="block text-[12px] font-semibold text-[#6E6E73]">Email</span>
                  <input value={email} onChange={e => setEmail(e.target.value)} type="email" autoComplete="username"
                    placeholder={role === 'hospital_manager' ? 'manager@hospital.vela.health' : (selected.demoEmail || 'you@vela.health')}
                    className="w-full bg-transparent outline-none text-[16px] py-1" />
                </label>

                <label className="block rounded-2xl bg-white border border-black/[0.08] px-4 pt-3 pb-2.5 focus-within:border-[#0071E3] focus-within:ring-4 focus-within:ring-[#0071E3]/15 transition">
                  <span className="block text-[12px] font-semibold text-[#6E6E73]">Password</span>
                  <span className="flex items-center gap-2">
                    <input value={password} onChange={e => setPassword(e.target.value)} type={showPassword ? 'text' : 'password'} autoComplete="current-password"
                      placeholder="••••••••" className="flex-1 min-w-0 bg-transparent outline-none text-[16px] py-1" />
                    <button type="button" onClick={() => setShowPassword(v => !v)} aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="p-1.5 rounded-lg text-[#6E6E73] hover:text-[#1D1D1F] hover:bg-black/5">
                      {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </span>
                </label>

                <AnimatePresence>
                  {error && (
                    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                      className="rounded-xl bg-[#FFEBEE] text-[#D70015] text-[14px] px-4 py-3">{error}</motion.div>
                  )}
                </AnimatePresence>

                <button type="submit" disabled={loading} data-magnetic
                  className="mt-3 h-14 rounded-full bg-[#0071E3] hover:bg-[#0058B0] text-white text-[17px] font-semibold inline-flex items-center justify-center gap-2 disabled:opacity-70">
                  {loading ? <><Loader2 size={18} className="animate-spin" /> Signing in…</> : <>Sign in <ArrowRight size={18} /></>}
                </button>
              </form>

              {role === 'hospital_manager' ? (
                <div className="mt-10 rounded-2xl bg-white border border-black/[0.06] p-5">
                  <div className="text-[14px] font-semibold mb-1">No credentials yet?</div>
                  <p className="text-[14px] text-[#515154] mb-3">Your hospital needs to be onboarded on the Vela network first.</p>
                  <a href="mailto:dev@vela.ai" className="text-[14px] font-semibold text-[#0071E3]">Contact Vela → dev@vela.ai</a>
                </div>
              ) : selected.demoPassword ? (
                <div className="mt-10 rounded-2xl bg-white border border-black/[0.06] p-5">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-[14px] font-semibold">Demo credentials</span>
                    <button type="button" onClick={fillDemo} className="text-[14px] font-semibold text-[#0071E3] hover:underline">Fill for me</button>
                  </div>
                  {([
                    { value: selected.demoEmail || '', type: 'email' as const },
                    { value: selected.demoPassword, type: 'password' as const },
                  ]).map((item) => (
                    <div key={item.type} className="flex items-center justify-between gap-4 py-2.5 border-t border-black/5">
                      <span className="text-[13px] text-[#515154] select-all truncate tabular-nums">{item.value}</span>
                      <button type="button" onClick={() => copyValue(item.value, item.type)}
                        className={`shrink-0 text-[13px] font-semibold ${copiedField === item.type ? 'text-[#248A3D]' : 'text-[#0071E3]'}`}>
                        {copiedField === item.type ? 'Copied' : 'Copy'}
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
            </motion.div>
          )}
        </AnimatePresence>
      </main>
    </div>
  )
}
