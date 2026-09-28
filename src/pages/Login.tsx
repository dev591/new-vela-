import React, { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { gsap } from 'gsap'
import { ArrowRight, ArrowLeft, Check } from 'lucide-react'
import { networkReceptionistLogin, networkLabLogin, networkDoctorLogin } from '../utils/auth'
import { API_URL } from '../utils/config'

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
  demoPassword: string;
  route: string;
  features: string[];
}> = {
  doctor: {
    n: '01',
    label: 'Doctor',
    description: 'Clinical command centre — queue, records, imaging and Atlas',
    demoEmail: 'drhimanshu@aiims-road.vela.health',
    demoPassword: 'Vela@4236',
    route: '/dashboard',
    features: ['Live patient queue', 'Atlas voice interface', 'Imaging second read', 'Risk scoring & alerts'],
  },
  receptionist: {
    n: '02',
    label: 'Reception',
    description: 'Patient intake, registration and queue management',
    demoEmail: 'drdev@aiims-road.vela.health',
    demoPassword: 'Vela@3592',
    route: '/receptionist',
    features: ['Patient registration', 'Queue management', 'Appointment booking', 'Document upload'],
  },
  hospital_manager: {
    n: '03',
    label: 'Management',
    description: 'Facility oversight, occupancy and live analytics',
    demoEmail: 'manager@vela.ai',
    demoPassword: 'vela2025',
    route: '/hospital-manager',
    features: ['Live analytics', 'Ward and bed view', 'Staff management', 'Throughput reporting'],
  },
  lab_controller: {
    n: '04',
    label: 'Laboratory',
    description: 'Diagnostics, sample queue and report generation',
    demoEmail: 'lab.controller@aiims-road.vela.health',
    demoPassword: 'Vela@3485',
    route: '/lab-controller',
    features: ['Real-time test queue', 'Report generation', 'Payment verification', 'Department routing'],
  },
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

  const navigate = useNavigate()
  const pageRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (pageRef.current) {
      gsap.fromTo(pageRef.current, { opacity: 0 }, { opacity: 1, duration: 0.8, ease: 'power2.out' })
    }
  }, [])

  useEffect(() => {
    if (step === 'select' && listRef.current) {
      gsap.fromTo(listRef.current.children,
        { y: 20, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.7, stagger: 0.06, ease: 'power3.out' }
      )
    }
    if (step === 'form') {
      gsap.fromTo(leftRef.current, { opacity: 0 }, { opacity: 1, duration: 0.7, ease: 'power2.out' })
      gsap.fromTo(rightRef.current,
        { y: 24, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.7, ease: 'power3.out', delay: 0.08 }
      )
    }
  }, [step])

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    // Clear old staff/auth/user data to prevent state leaks between logins!
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

  return (
    <div ref={pageRef} className="min-h-screen antialiased" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      {step === 'select' ? (

        /* ── Workspace index ──────────────────────────────── */
        <div className="min-h-screen flex flex-col px-6 md:px-12">
          <header className="flex items-center justify-between h-[76px]">
            <button type="button" onClick={() => navigate('/')} className="display text-[24px] bg-transparent border-none p-0 cursor-pointer" style={{ color: 'var(--text)' }}>
              Vela
            </button>
            <span className="label-mono">Sign in</span>
          </header>

          <div className="flex-1 flex flex-col justify-center max-w-[1400px] w-full mx-auto py-16">
            <div className="grid grid-cols-1 lg:grid-cols-[0.32fr_0.68fr] gap-12 lg:gap-20">

              <div>
                <div className="label-mono mb-8">Workspaces</div>
                <h1 className="display text-[44px] md:text-[60px] leading-[1.02]" style={{ color: 'var(--text)' }}>
                  Choose your<br />
                  <span className="display-italic" style={{ color: 'var(--brand)' }}>workspace.</span>
                </h1>
                <p className="text-[15px] leading-[1.7] mt-8 max-w-sm" style={{ color: 'var(--text-secondary)' }}>
                  Every role sees the same patient record, scoped to what that role
                  needs. Sign in with the credentials assigned to you.
                </p>
              </div>

              <div ref={listRef}>
                {(Object.keys(roleDetails) as Role[]).map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => { setRole(r); setStep('form'); setError(''); }}
                    className="group w-full text-left grid grid-cols-[52px_1fr_28px] items-center gap-5 py-7 bg-transparent border-none cursor-pointer transition-all duration-300"
                    style={{ borderTop: '1px solid var(--border)' }}
                    onMouseEnter={e => (e.currentTarget.style.paddingLeft = '10px')}
                    onMouseLeave={e => (e.currentTarget.style.paddingLeft = '0px')}
                  >
                    <span className="label-mono">{roleDetails[r].n}</span>
                    <span>
                      <span className="display text-[30px] md:text-[36px] block leading-none mb-2" style={{ color: 'var(--text)' }}>
                        {roleDetails[r].label}
                      </span>
                      <span className="text-[14px]" style={{ color: 'var(--text-secondary)' }}>
                        {roleDetails[r].description}
                      </span>
                    </span>
                    <ArrowRight
                      size={20}
                      className="transition-transform duration-300 group-hover:translate-x-1.5"
                      style={{ color: 'var(--text-tertiary)' }}
                    />
                  </button>
                ))}

                {/* Patient — one-click demo entry */}
                <button
                  type="button"
                  onClick={enterAsPatient}
                  disabled={patientLoading}
                  className="group w-full text-left grid grid-cols-[52px_1fr_28px] items-center gap-5 py-7 bg-transparent border-none cursor-pointer transition-all duration-300 disabled:opacity-50"
                  style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}
                  onMouseEnter={e => (e.currentTarget.style.paddingLeft = '10px')}
                  onMouseLeave={e => (e.currentTarget.style.paddingLeft = '0px')}
                >
                  <span className="label-mono">05</span>
                  <span>
                    <span className="display text-[30px] md:text-[36px] block leading-none mb-2" style={{ color: 'var(--text)' }}>
                      Patient
                      <span className="label-mono ml-4" style={{ color: 'var(--brand)' }}>Demo</span>
                    </span>
                    <span className="text-[14px]" style={{ color: 'var(--text-secondary)' }}>
                      {patientLoading ? 'Signing in…' : 'Personal health record — enter as Rajesh Kumar'}
                    </span>
                  </span>
                  <ArrowRight
                    size={20}
                    className="transition-transform duration-300 group-hover:translate-x-1.5"
                    style={{ color: 'var(--text-tertiary)' }}
                  />
                </button>
              </div>
            </div>
          </div>

          <footer className="py-8 flex justify-between items-center" style={{ borderTop: '1px solid var(--border)' }}>
            <span className="label-mono">Encrypted · Role-scoped access</span>
            <span className="label-mono">© 2026 Vela</span>
          </footer>
        </div>

      ) : (

        /* ── Authenticate ─────────────────────────────────── */
        /* Two columns from 900px up. Below that the panel becomes a band above
           the form — it must never vanish, or the page reads as half-empty. */
        <div className="min-h-screen grid grid-cols-1 min-[900px]:grid-cols-[0.45fr_0.55fr]">

          {/* Context panel */}
          <div
            ref={leftRef}
            className="flex flex-col justify-between gap-10 px-8 py-12 md:px-12 lg:px-16 min-[900px]:py-16"
            style={{ background: '#101418' }}
          >
            <span className="display text-[24px]" style={{ color: '#fff' }}>Vela</span>

            <div>
              <div className="label-mono mb-6" style={{ color: 'rgba(255,255,255,0.35)' }}>
                Workspace {selected.n}
              </div>
              <h2 className="display text-[48px] md:text-[60px] lg:text-[72px] leading-[1.02] mb-6" style={{ color: '#fff' }}>
                {selected.label}
              </h2>
              <p className="text-[16px] leading-[1.7] mb-10 max-w-sm" style={{ color: 'rgba(255,255,255,0.5)' }}>
                {selected.description}.
              </p>

              <div className="max-w-sm">
                {selected.features.map((f) => (
                  <div key={f} className="flex items-center gap-4 py-3.5" style={{ borderTop: '1px solid rgba(255,255,255,0.1)' }}>
                    <Check size={14} style={{ color: 'var(--brand-light)' }} />
                    <span className="text-[14px]" style={{ color: 'rgba(255,255,255,0.7)' }}>{f}</span>
                  </div>
                ))}
              </div>
            </div>

            <span className="label-mono" style={{ color: 'rgba(255,255,255,0.3)' }}>
              Encrypted connection · Role-scoped access
            </span>
          </div>

          {/* Form panel */}
          <div ref={rightRef} className="flex flex-col justify-center items-center px-6 md:px-12 lg:px-20 py-20 relative" style={{ background: 'var(--bg)' }}>
            <button
              type="button"
              onClick={() => { setStep('select'); setError('') }}
              className="absolute top-10 left-6 md:left-12 lg:left-20 flex items-center gap-2.5 bg-transparent border-none p-0 cursor-pointer transition-colors duration-300"
              style={{ color: 'var(--text-tertiary)' }}
              onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
              onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-tertiary)')}
            >
              <ArrowLeft size={15} />
              <span className="label-mono" style={{ color: 'inherit' }}>All workspaces</span>
            </button>

            {/* mx-auto so the form is centred in its column rather than pinned
                left with dead space beside it at in-between widths. */}
            <div className="w-full max-w-md mx-auto">
              <h1 className="display text-[44px] leading-none mb-3" style={{ color: 'var(--text)' }}>
                Sign in
              </h1>
              <p className="text-[15px] mb-12" style={{ color: 'var(--text-secondary)' }}>
                {role === 'hospital_manager'
                  ? 'Enter the credentials provided by Vela.'
                  : `Access the ${selected.label.toLowerCase()} workspace.`}
              </p>

              <form onSubmit={handleLogin} className="flex flex-col gap-8">
                <div>
                  <label className="label-mono block mb-3">Email</label>
                  <input
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    type="email"
                    placeholder={role === 'hospital_manager' ? 'manager@hospital.vela.health' : (selected.demoEmail || 'you@vela.ai')}
                    className="w-full text-[15px] py-3 outline-none bg-transparent transition-colors duration-300"
                    style={{ borderBottom: '1px solid var(--border-strong)', color: 'var(--text)' }}
                    onFocus={e => (e.currentTarget.style.borderBottomColor = 'var(--brand)')}
                    onBlur={e => (e.currentTarget.style.borderBottomColor = 'var(--border-strong)')}
                  />
                </div>

                <div>
                  <label className="label-mono block mb-3">Password</label>
                  <div className="relative">
                    <input
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      type={showPassword ? 'text' : 'password'}
                      placeholder="••••••••"
                      className="w-full text-[15px] py-3 pr-16 outline-none bg-transparent transition-colors duration-300"
                      style={{ borderBottom: '1px solid var(--border-strong)', color: 'var(--text)' }}
                      onFocus={e => (e.currentTarget.style.borderBottomColor = 'var(--brand)')}
                      onBlur={e => (e.currentTarget.style.borderBottomColor = 'var(--border-strong)')}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(v => !v)}
                      className="absolute right-0 top-1/2 -translate-y-1/2 bg-transparent border-none cursor-pointer p-0"
                    >
                      <span className="label-mono">{showPassword ? 'Hide' : 'Show'}</span>
                    </button>
                  </div>
                </div>

                {error && (
                  <div className="text-[13px] py-3 px-4" style={{ background: 'var(--danger-light)', borderLeft: '2px solid var(--danger)', color: 'var(--danger)' }}>
                    {error}
                  </div>
                )}

                <button
                  type="submit"
                  disabled={loading}
                  className="group self-start inline-flex items-center gap-4 pb-3 mt-2 bg-transparent border-none p-0 cursor-pointer disabled:opacity-50"
                  style={{ borderBottom: '1px solid var(--text)', cursor: loading ? 'wait' : 'pointer' }}
                >
                  <span className="text-[16px] font-medium" style={{ color: 'var(--text)' }}>
                    {loading ? 'Signing in…' : 'Sign in'}
                  </span>
                  <ArrowRight size={17} className="transition-transform duration-300 group-hover:translate-x-1.5" style={{ color: 'var(--text)' }} />
                </button>
              </form>

              {role === 'hospital_manager' ? (
                <div className="mt-14 pt-8" style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="label-mono mb-4">No credentials yet</div>
                  <p className="text-[14px] leading-[1.7] mb-3" style={{ color: 'var(--text-secondary)' }}>
                    Your hospital needs to be onboarded on the Vela network first.
                  </p>
                  <a href="mailto:dev@vela.ai" className="text-[14px] font-medium" style={{ color: 'var(--brand)' }}>
                    Contact Vela → dev@vela.ai
                  </a>
                </div>
              ) : (
                <div className="mt-14 pt-8" style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="label-mono mb-5">Demo credentials</div>
                  {([
                    { label: 'Email', value: selected.demoEmail || '', type: 'email' as const },
                    { label: 'Password', value: selected.demoPassword, type: 'password' as const },
                  ]).map((item) => (
                    <div key={item.type} className="flex items-center justify-between gap-4 py-3" style={{ borderTop: '1px solid var(--border)' }}>
                      <span className="text-[13px] font-mono select-all truncate" style={{ color: 'var(--text-secondary)' }}>
                        {item.value}
                      </span>
                      <button
                        type="button"
                        onClick={() => copyValue(item.value, item.type)}
                        className="bg-transparent border-none cursor-pointer p-0 shrink-0"
                      >
                        <span className="label-mono" style={{ color: copiedField === item.type ? 'var(--success)' : 'var(--brand)' }}>
                          {copiedField === item.type ? 'Copied' : 'Copy'}
                        </span>
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
