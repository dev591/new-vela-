import { API_URL } from "../utils/config";
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import DoctorSidebar from '../components/DoctorSidebar'
import { ArrowRight } from 'lucide-react'

type Patient = {
  id: string
  name: string
  vela_id: string
  age: number
  gender: string
  ward: string
  room: string
  risk_score: number
  status: string
  updated_at: string
}

/**
 * All patients — editorial register.
 *
 * A clinical list is scanned, not browsed: the doctor is looking for one name
 * or for whoever is sickest. So the name is set large, risk is a single number
 * with a colour-coded rule beneath it, and everything else recedes to mono
 * metadata. Hairlines instead of cards keeps 30 rows readable on one screen.
 */
export default function PatientsList() {
  const [sidebarExpanded, setSidebarExpanded] = useState(false)
  const [patients, setPatients] = useState<Patient[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)
  const [sortMode, setSortMode] = useState<'risk_desc' | 'name' | 'recent'>('risk_desc')
  const navigate = useNavigate()

  useEffect(() => {
    const fetchPatients = async () => {
      try {
        const hospitalId = localStorage.getItem("vela_hospital_id")
        const url = hospitalId
          ? `${API_URL}/api/patients/list?hospital_id=${hospitalId}`
          : `${API_URL}/api/patients/list`
        const res = await fetch(url)
        const data = await res.json()
        if (res.ok && data.status === 'success') setPatients(data.patients || [])
      } catch {
        // ignore
      } finally {
        setLoading(false)
      }
    }
    fetchPatients()
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    // The field is advertised as "name or ID" — it previously matched on name
    // only, so searching a VELA ID silently returned nothing. Ward and room are
    // included too, since "who is in ICU" is the other way doctors search.
    let arr = patients.filter((p) => {
      if (!q) return true
      return [p.name, p.vela_id, p.ward, p.room]
        .some((field) => (field || '').toString().toLowerCase().includes(q))
    })
    if (sortMode === 'risk_desc') arr = [...arr].sort((a, b) => b.risk_score - a.risk_score)
    if (sortMode === 'name') arr = [...arr].sort((a, b) => a.name.localeCompare(b.name))
    if (sortMode === 'recent') arr = [...arr].sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())
    return arr
  }, [patients, search, sortMode])

  const riskColor = (score: number) =>
    score <= 40 ? 'var(--success)' : score <= 70 ? 'var(--warning)' : 'var(--danger)'

  const criticalCount = patients.filter(p => p.risk_score > 70).length

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <DoctorSidebar onExpandChange={setSidebarExpanded} />

      <main
        className="flex-1 transition-all duration-500 px-6 md:px-12 py-12"
        style={{ marginLeft: sidebarExpanded ? '260px' : '72px' }}
      >
        {/* ── Header ───────────────────────────────────────── */}
        <header className="pb-10" style={{ borderBottom: '1px solid var(--text)' }}>
          <div className="flex flex-wrap items-end justify-between gap-8">
            <div>
              <div className="label-mono mb-5">Register</div>
              <h1 className="display text-[48px] md:text-[64px] leading-none m-0" style={{ color: 'var(--text)' }}>
                All patients
              </h1>
            </div>

            <div className="flex items-end gap-12">
              <div>
                <div className="display text-[40px] leading-none" style={{ color: 'var(--text)' }}>
                  {String(filtered.length).padStart(2, '0')}
                </div>
                <div className="label-mono mt-1.5">Listed</div>
              </div>
              <div>
                <div
                  className="display text-[40px] leading-none"
                  style={{ color: criticalCount > 0 ? 'var(--danger)' : 'var(--text-tertiary)' }}
                >
                  {String(criticalCount).padStart(2, '0')}
                </div>
                <div className="label-mono mt-1.5">Critical</div>
              </div>
            </div>
          </div>
        </header>

        {/* ── Controls ─────────────────────────────────────── */}
        <div className="flex flex-wrap items-center justify-between gap-8 py-8">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, VELA ID, ward or room…"
            className="w-full sm:w-96 bg-transparent text-[15px] py-2.5 outline-none transition-colors duration-300"
            style={{ borderBottom: '1px solid var(--border-strong)', color: 'var(--text)' }}
            onFocus={e => (e.currentTarget.style.borderBottomColor = 'var(--brand)')}
            onBlur={e => (e.currentTarget.style.borderBottomColor = 'var(--border-strong)')}
          />

          <div className="flex items-center gap-8">
            {([
              { key: 'risk_desc', label: 'Highest risk' },
              { key: 'recent', label: 'Recent' },
              { key: 'name', label: 'A–Z' },
            ] as const).map((mode) => (
              <button
                key={mode.key}
                type="button"
                onClick={() => setSortMode(mode.key)}
                className="bg-transparent border-none p-0 cursor-pointer transition-opacity duration-300"
                style={{ opacity: sortMode === mode.key ? 1 : 0.4 }}
              >
                <span
                  className="label-mono"
                  style={{ color: sortMode === mode.key ? 'var(--brand)' : 'var(--text-tertiary)' }}
                >
                  {mode.label}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* ── Column key ───────────────────────────────────── */}
        <div
          className="hidden md:grid grid-cols-[1.7fr_0.8fr_0.9fr_0.7fr_auto] gap-6 pb-3"
          style={{ borderBottom: '1px solid var(--border)' }}
        >
          {['Patient', 'Status', 'Location', 'Updated', 'Risk'].map((h) => (
            <div key={h} className="label-mono" style={{ textAlign: h === 'Risk' ? 'right' : 'left' }}>{h}</div>
          ))}
        </div>

        {/* ── Rows ─────────────────────────────────────────── */}
        {loading ? (
          <div className="py-28 text-center">
            <div className="label-mono">Loading register…</div>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-28 text-center">
            <div className="display text-[28px] mb-3" style={{ color: 'var(--text-tertiary)' }}>
              No patients found
            </div>
            <div className="label-mono">
              {search ? 'Try a different search term' : 'No patients registered yet'}
            </div>
          </div>
        ) : (
          <div className="pb-20">
            {filtered.map((patient) => (
              <div
                key={patient.id}
                onClick={() => navigate(`/patients/${patient.id}`)}
                className="group grid grid-cols-2 md:grid-cols-[1.7fr_0.8fr_0.9fr_0.7fr_auto] gap-x-6 gap-y-2 items-center py-6 cursor-pointer transition-all duration-300"
                style={{ borderBottom: '1px solid var(--border)' }}
                onMouseEnter={e => (e.currentTarget.style.paddingLeft = '8px')}
                onMouseLeave={e => (e.currentTarget.style.paddingLeft = '0px')}
              >
                {/* Patient */}
                <div className="min-w-0 col-span-2 md:col-span-1">
                  <div className="display text-[26px] leading-none mb-1.5 truncate" style={{ color: 'var(--text)' }}>
                    {patient.name}
                  </div>
                  <div className="label-mono">
                    {patient.vela_id} · {patient.age}
                    {patient.gender ? ` · ${patient.gender}` : ''}
                  </div>
                </div>

                {/* Status */}
                <div>
                  <span
                    className="label-mono"
                    style={{
                      color:
                        patient.status === 'critical' ? 'var(--danger)'
                        : patient.status === 'admitted' ? 'var(--success)'
                        : 'var(--text-secondary)',
                    }}
                  >
                    {patient.status ? patient.status.charAt(0).toUpperCase() + patient.status.slice(1) : '—'}
                  </span>
                </div>

                {/* Location */}
                <div className="min-w-0">
                  <div className="text-[14px] truncate" style={{ color: 'var(--text)' }}>{patient.ward || '—'}</div>
                  {patient.room && <div className="label-mono">Room {patient.room}</div>}
                </div>

                {/* Updated */}
                <div className="label-mono">
                  {patient.updated_at
                    ? new Date(patient.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
                    : '—'}
                </div>

                {/* Risk + affordance */}
                <div className="flex items-center justify-end gap-5">
                  <div className="text-right">
                    <div className="display text-[30px] leading-none" style={{ color: riskColor(patient.risk_score) }}>
                      {patient.risk_score}
                    </div>
                    <div
                      className="mt-1.5 ml-auto"
                      style={{
                        height: 2,
                        width: 40,
                        background: 'var(--border)',
                        position: 'relative',
                      }}
                    >
                      <span
                        style={{
                          position: 'absolute', inset: 0,
                          width: `${Math.max(0, Math.min(100, patient.risk_score))}%`,
                          background: riskColor(patient.risk_score),
                        }}
                      />
                    </div>
                  </div>
                  <ArrowRight
                    size={16}
                    className="transition-transform duration-300 group-hover:translate-x-1 shrink-0"
                    style={{ color: 'var(--text-tertiary)' }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </div>
  )
}
