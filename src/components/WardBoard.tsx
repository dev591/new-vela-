// Ward board: every ward as a card, every bed as a tile with the patient's name on it.
// Click a bed for the full story (who, when, why, cost) and to discharge, transfer or admit.
// Used by reception (can admit / transfer / discharge) and can be reused read-only for managers.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import toast from 'react-hot-toast'
import {
  BedDouble, X, LogOut, ArrowRightLeft, Search, Clock, UserRound, Siren, Wrench, Copy, CheckCircle2, ShieldAlert,
} from 'lucide-react'
import { API_URL } from '../utils/config'
import { socket } from '../hooks/useSocket'

// ── Shapes returned by GET /api/wards/board ──
interface Admission {
  id: string; patient_id: string; bed_id: string; ward_id: string; status: string; admitted_at: string; days: number
  room_type: string; cost_per_day: number; room_cost_so_far: number; reason?: string; admission_reason?: string
  diagnosis?: string; recommended_by?: string; admitted_by?: string; admission_qr?: string
  patients?: { id: string; name: string; vela_id: string; age?: number; gender?: string; blood_group?: string; allergies?: string
               existing_conditions?: string; risk_score?: number; phone?: string; emergency_contact?: string; diagnosis?: string }
  wards?: { name: string }; beds?: { bed_number: string }
}
interface Bed { id: string; ward_id: string; bed_number: string; status: string; admission: Admission | null }
interface Ward { id: string; name: string; type: string; color?: string; beds: Bed[]; staff: { id: string; name: string; role: string }[] }
interface Rec {
  rec_id: string; patient_id: string; patient_name: string; ward_type: string; ward_id: string; ward_name: string
  bed_id: string; bed_number: string; reason?: string; priority?: string; doctor?: string; created_at?: string; bed_still_free: boolean
}
interface Board {
  wards: Ward[]; recommendations: Rec[]; room_types: { name: string; cost_per_day: number }[]
  summary: { total: number; occupied: number; empty: number; unavailable: number; occupancy: number }
}

interface Props {
  hospitalId?: string
  canAdmit?: boolean                          // reception: admit, transfer, switch beds off
  onDischarge?: (admission: Admission) => void // reception hands over to its own discharge flow
  refreshKey?: number                          // bump to force a reload
}

const money = (n: number) => '₹' + Math.round(n).toLocaleString('en-IN')
const when = (iso?: string) => iso ? new Date(iso.endsWith('Z') || iso.includes('+') ? iso : iso + 'Z').toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—'
const riskTone = (r?: number) => (r ?? 0) >= 70 ? 'var(--danger)' : (r ?? 0) >= 40 ? 'var(--warning)' : 'var(--success)'
const roomFor = (wardType: string) => /icu|critical/i.test(wardType) ? 'ICU Room' : /private/i.test(wardType) ? 'Private Room' : 'General Ward'

export default function WardBoard({ hospitalId, canAdmit = false, onDischarge, refreshKey = 0 }: Props) {
  const [board, setBoard] = useState<Board | null>(null)
  const [error, setError] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [wardFilter, setWardFilter] = useState('all')

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${API_URL}/api/wards/board${hospitalId ? `?hospital_id=${hospitalId}` : ''}`)
      const data = await res.json()
      if (data.status === 'success') { setBoard(data); setError('') } else setError(data.message || 'Could not load the wards')
    } catch { setError('Backend not reachable') }
  }, [hospitalId])

  // Load now, on a 15 s timer (safety net), and whenever the server says beds or admissions changed.
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => { void load() }, [load, refreshKey])
  useEffect(() => {
    const id = window.setInterval(() => void load(), 15000)
    const soon = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(() => void load(), 400) }
    const events = ['patient_admitted', 'patient_discharged', 'bed_status_changed', 'admission_confirmed',
                    'admission_transferred', 'admission_recommended']
    events.forEach(e => socket.on(e, soon))
    return () => { window.clearInterval(id); events.forEach(e => socket.off(e, soon)) }   // remove only OUR listeners
  }, [load])

  const allBeds = useMemo(() => (board?.wards || []).flatMap(w => w.beds.map(b => ({ ...b, ward: w }))), [board])
  const selected = allBeds.find(b => b.id === selectedId) || null
  const q = search.trim().toLowerCase()
  const matches = (b: Bed) => !q || b.bed_number.toLowerCase().includes(q) ||
    (b.admission?.patients?.name || '').toLowerCase().includes(q) || (b.admission?.patients?.vela_id || '').toLowerCase().includes(q)

  if (!board) {
    return <div className="py-20 text-center text-ink-3">{error || 'Loading wards…'}</div>
  }
  const s = board.summary
  const visibleWards = board.wards.filter(w => wardFilter === 'all' || w.id === wardFilter)

  return (
    <div className="space-y-8">
      {/* Totals */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[
          { label: 'Beds', value: s.total, tone: 'var(--ink)' },
          { label: 'Occupied', value: s.occupied, tone: 'var(--brand)' },
          { label: 'Free', value: s.empty, tone: 'var(--success)' },
          { label: 'Occupancy', value: `${s.occupancy}%`, tone: s.occupancy > 80 ? 'var(--danger)' : s.occupancy > 50 ? 'var(--warning)' : 'var(--success)' },
        ].map(c => (
          <div key={c.label} className="bg-white border border-line-soft rounded-2xl p-5">
            <div className="text-sm text-ink-3">{c.label}</div>
            <div className="text-4xl font-semibold" style={{ color: c.tone }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Atlas requests waiting for reception */}
      {board.recommendations.length > 0 && (
        <section aria-label="Admission requests" className="space-y-3">
          <h3 className="text-lg font-semibold text-ink">Waiting for you · {board.recommendations.length}</h3>
          {board.recommendations.map(r => (
            <div key={r.rec_id} className="bg-white border-2 border-brand/25 rounded-2xl p-5 flex flex-wrap items-center gap-4 justify-between">
              <div>
                <div className="text-xl font-semibold text-ink flex items-center gap-2">
                  {r.priority === 'urgent' && <Siren size={18} color="var(--danger)" />}{r.patient_name}
                </div>
                <div className="text-ink-2">
                  {r.ward_name || r.ward_type}{r.bed_number ? ` · bed ${r.bed_number}` : ''} · asked by {r.doctor || 'doctor'}
                  {r.reason ? ` · “${r.reason}”` : ''}
                </div>
                {!r.bed_still_free && <div className="text-sm" style={{ color: 'var(--warning)' }}>That bed is taken. Pick another free bed below.</div>}
              </div>
              <div className="flex gap-2">
                <button className="min-h-11 px-5 rounded-xl bg-brand text-white font-semibold disabled:opacity-40"
                  disabled={!canAdmit || !r.bed_still_free} onClick={() => setSelectedId(r.bed_id)}>
                  Review and admit
                </button>
                <button className="min-h-11 px-4 rounded-xl border border-line text-ink-2"
                  onClick={async () => { await fetch(`${API_URL}/api/admissions/recommended/${r.rec_id}/dismiss`, { method: 'POST' }); void load() }}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </section>
      )}

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 bg-white border border-line rounded-xl px-3 min-h-11 flex-1 min-w-[220px]">
          <Search size={16} className="text-ink-3" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a patient, VELA ID or bed"
                 className="flex-1 bg-transparent outline-none text-ink" aria-label="Search wards" />
        </label>
        <select value={wardFilter} onChange={e => setWardFilter(e.target.value)} aria-label="Ward"
                className="min-h-11 rounded-xl border border-line bg-white px-3 text-ink">
          <option value="all">All wards</option>
          {board.wards.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
        <div className="flex items-center gap-4 text-sm text-ink-2">
          <span className="flex items-center gap-1"><i className="w-3 h-3 rounded bg-brand-tint border border-brand/40" /> Patient</span>
          <span className="flex items-center gap-1"><i className="w-3 h-3 rounded border border-dashed" style={{ borderColor: 'var(--success)' }} /> Free</span>
          <span className="flex items-center gap-1"><i className="w-3 h-3 rounded bg-surface-2" /> Out of service</span>
        </div>
      </div>

      {board.wards.length === 0 && (
        <div className="p-12 border border-line-soft bg-canvas/50 rounded-2xl text-center text-ink-2">
          No wards yet. The hospital manager can add them from the manager console.
        </div>
      )}

      {/* Ward cards */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {visibleWards.map(w => {
          const occ = w.beds.filter(b => b.status === 'occupied').length
          const pct = w.beds.length ? (occ / w.beds.length) * 100 : 0
          return (
            <section key={w.id} className="bg-white border border-line-soft rounded-3xl overflow-hidden">
              <div className="h-1.5" style={{ background: w.color || 'var(--brand)' }} />
              <div className="p-5">
                <div className="flex items-baseline justify-between gap-3">
                  <h3 className="text-xl font-semibold text-ink">{w.name}</h3>
                  <span className="text-sm text-ink-2">{w.type} · {occ}/{w.beds.length} beds</span>
                </div>
                <div className="h-1.5 bg-surface-2 rounded-full my-3 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${pct}%`, background: pct > 80 ? 'var(--danger)' : pct > 50 ? 'var(--warning)' : 'var(--success)' }} />
                </div>
                <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(118px, 1fr))' }}>
                  {w.beds.map(b => <BedTile key={b.id} bed={b} dim={!matches(b)} onClick={() => setSelectedId(b.id)} />)}
                </div>
              </div>
            </section>
          )
        })}
      </div>

      {selected && (
        <BedDrawer bed={selected} ward={selected.ward} board={board} canAdmit={canAdmit} onClose={() => setSelectedId(null)}
                   onChanged={() => void load()} onDischarge={(a) => { setSelectedId(null); onDischarge?.(a) }} />
      )}
    </div>
  )
}

// One bed on the card.
function BedTile({ bed, dim, onClick }: { bed: Bed; dim: boolean; onClick: () => void }) {
  const a = bed.admission, p = a?.patients
  const base = 'text-left rounded-xl p-2.5 min-h-[76px] transition-shadow hover:shadow-md focus-visible:outline-2 ' + (dim ? 'opacity-30' : '')
  if (bed.status === 'occupied') {
    return (
      <button onClick={onClick} className={`${base} bg-brand-tint border border-brand/30`} aria-label={`Bed ${bed.bed_number}, ${p?.name || 'patient'}`}>
        <div className="flex items-center justify-between text-[11px] text-ink-2">
          <span className="font-mono">{bed.bed_number}</span>
          <span className="flex items-center gap-1">
            <i className="w-2 h-2 rounded-full" style={{ background: riskTone(p?.risk_score) }} />Day {a?.days ?? 1}
          </span>
        </div>
        <div className="font-semibold text-ink leading-tight mt-1 line-clamp-2">{p?.name || 'Patient'}</div>
      </button>
    )
  }
  if (bed.status === 'empty') {
    return (
      <button onClick={onClick} className={`${base} bg-white border border-dashed`} style={{ borderColor: 'var(--success)' }} aria-label={`Bed ${bed.bed_number}, free`}>
        <div className="font-mono text-[11px] text-ink-2">{bed.bed_number}</div>
        <div className="font-medium mt-2" style={{ color: 'var(--success)' }}>Free</div>
      </button>
    )
  }
  return (
    <button onClick={onClick} className={`${base} bg-surface-2 border border-line`} aria-label={`Bed ${bed.bed_number}, out of service`}>
      <div className="font-mono text-[11px] text-ink-2">{bed.bed_number}</div>
      <div className="text-ink-3 mt-2 flex items-center gap-1"><Wrench size={13} /> Out of service</div>
    </button>
  )
}

// Slide-over with everything about one bed.
function BedDrawer({ bed, ward, board, canAdmit, onClose, onChanged, onDischarge }: {
  bed: Bed; ward: Ward; board: Board; canAdmit: boolean; onClose: () => void; onChanged: () => void; onDischarge: (a: Admission) => void
}) {
  const a = bed.admission, p = a?.patients
  const [busy, setBusy] = useState(false)
  const [target, setTarget] = useState('')                 // transfer destination bed
  const [velaId, setVelaId] = useState('')
  const [found, setFound] = useState<{ id: string; name: string; vela_id: string } | null>(null)
  const [rec, setRec] = useState<Rec | null>(board.recommendations.find(r => r.bed_id === bed.id) || null)
  const [room, setRoom] = useState(roomFor(ward.type))
  const [reason, setReason] = useState(rec?.reason || '')
  const [diagnosis, setDiagnosis] = useState('')
  const [by, setBy] = useState(rec?.doctor || '')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const post = async (url: string, body: unknown, ok: string) => {
    setBusy(true)
    try {
      const res = await fetch(`${API_URL}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      const d = await res.json()
      if (d.status === 'success') { toast.success(ok); onChanged(); return d }
      toast.error(d.message || 'That did not work')
    } catch { toast.error('Backend not reachable') } finally { setBusy(false) }
  }

  const lookup = async () => {
    const r = await fetch(`${API_URL}/api/receptionist/lookup/${encodeURIComponent(velaId.trim())}`)
    const d = await r.json()
    if (d.status === 'success') setFound({ id: d.patient.id, name: d.patient.name, vela_id: d.patient.vela_id })
    else { setFound(null); toast.error(d.message || 'No patient with that VELA ID') }
  }
  const patientToAdmit = rec ? { id: rec.patient_id, name: rec.patient_name } : found
  const admit = async () => {
    if (!patientToAdmit) return
    const d = await post('/api/admissions/confirm', {
      patient_id: patientToAdmit.id, bed_id: bed.id, ward_id: ward.id, ward_name: ward.name, bed_number: bed.bed_number,
      room_type: room, admission_reason: reason, diagnosis, recommended_by: by || 'Reception',
    }, `${patientToAdmit.name} admitted to ${ward.name}, bed ${bed.bed_number}`)
    if (d) onClose()
  }
  const setBedStatus = (status: 'empty' | 'maintenance') =>
    fetch(`${API_URL}/api/beds/${bed.id}/status`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) })
      .then(r => r.json()).then(d => { if (d.status === 'success') { onChanged(); onClose() } else toast.error(d.message || 'Could not change the bed') })

  const freeBeds = board.wards.flatMap(w => w.beds.filter(b => b.status === 'empty').map(b => ({ id: b.id, label: `${w.name} · ${b.bed_number}` })))
  const row = (label: string, value?: string | number | null) => value ? (
    <div className="flex justify-between gap-6 py-2 border-b border-line-soft">
      <span className="text-ink-3">{label}</span><span className="text-ink text-right">{value}</span>
    </div>) : null

  return (
    <div className="fixed inset-0 z-[9998]" role="dialog" aria-modal="true" aria-label={`Bed ${bed.bed_number}`}>
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="absolute right-0 top-0 h-full w-[min(460px,100vw)] bg-white shadow-2xl overflow-y-auto p-6 space-y-6">
        <header className="flex items-start justify-between gap-4">
          <div>
            <div className="text-sm text-ink-3 flex items-center gap-1"><BedDouble size={14} /> {ward.name} · bed {bed.bed_number}</div>
            <h2 className="text-3xl font-semibold text-ink mt-1">{a ? p?.name : bed.status === 'empty' ? 'Free bed' : 'Out of service'}</h2>
            {p?.vela_id && <div className="font-mono text-sm text-brand">{p.vela_id}</div>}
          </div>
          <button onClick={onClose} aria-label="Close" className="min-w-11 min-h-11 grid place-items-center rounded-full hover:bg-surface-2"><X /></button>
        </header>

        {a && p && (<>
          <div className="flex flex-wrap gap-2">
            <span className="px-3 py-1 rounded-full bg-brand-tint text-brand font-medium">Admitted</span>
            <span className="px-3 py-1 rounded-full bg-surface-2 text-ink-2 flex items-center gap-1"><Clock size={13} /> Day {a.days}</span>
            {typeof p.risk_score === 'number' && (
              <span className="px-3 py-1 rounded-full text-white font-medium" style={{ background: riskTone(p.risk_score) }}>Risk {p.risk_score}</span>
            )}
          </div>

          <section>
            <h3 className="font-semibold text-ink mb-1">Why and who</h3>
            {row('Reason', a.reason || a.admission_reason)}{row('Diagnosis', a.diagnosis || p.diagnosis)}
            {row('Recommended by', a.recommended_by)}{row('Admitted by', a.admitted_by)}{row('Admitted', when(a.admitted_at))}
          </section>
          <section>
            <h3 className="font-semibold text-ink mb-1">Stay and cost</h3>
            {row('Room', a.room_type)}{row('Per day', money(a.cost_per_day))}{row('Room cost so far', `${money(a.room_cost_so_far)} (${a.days} day${a.days > 1 ? 's' : ''})`)}
            <div className="text-xs text-ink-3 mt-2">Tests during the stay are added at discharge.</div>
          </section>
          <section>
            <h3 className="font-semibold text-ink mb-1 flex items-center gap-2"><UserRound size={16} /> Patient</h3>
            {row('Age / gender', [p.age, p.gender].filter(Boolean).join(' · '))}{row('Blood group', p.blood_group)}
            {row('Allergies', p.allergies)}{row('Conditions', p.existing_conditions)}{row('Phone', p.phone)}{row('Emergency contact', p.emergency_contact)}
          </section>
          {a.admission_qr && (
            <button className="flex items-center gap-2 text-sm text-ink-2 hover:text-ink" onClick={() => { void navigator.clipboard?.writeText(a.admission_qr!); toast.success('Admission code copied') }}>
              <Copy size={14} /> Admission code {a.admission_qr}
            </button>
          )}

          {canAdmit && (
            <section className="space-y-3 pt-2">
              <button className="w-full min-h-12 rounded-xl bg-ink text-white font-semibold flex items-center justify-center gap-2" onClick={() => onDischarge(a)}>
                <LogOut size={18} /> Discharge {p.name?.split(' ')[0]}
              </button>
              <div className="rounded-2xl border border-line p-4 space-y-2">
                <div className="font-medium text-ink flex items-center gap-2"><ArrowRightLeft size={16} /> Move to another bed</div>
                <select value={target} onChange={e => setTarget(e.target.value)} className="w-full min-h-11 rounded-xl border border-line px-3 bg-white" aria-label="Destination bed">
                  <option value="">Choose a free bed…</option>
                  {freeBeds.map(b => <option key={b.id} value={b.id}>{b.label}</option>)}
                </select>
                <button disabled={!target || busy} className="w-full min-h-11 rounded-xl border border-brand text-brand font-semibold disabled:opacity-40"
                        onClick={async () => { const d = await post(`/api/admissions/${a.id}/transfer`, { bed_id: target }, 'Patient moved'); if (d) onClose() }}>
                  Move patient
                </button>
              </div>
            </section>
          )}
        </>)}

        {!a && bed.status === 'empty' && canAdmit && (
          <section className="space-y-4">
            <h3 className="font-semibold text-ink">Admit a patient to this bed</h3>
            {board.recommendations.length > 0 && !found && (
              <label className="block">
                <span className="text-sm text-ink-3">From a doctor's request</span>
                <select value={rec?.rec_id || ''} className="w-full min-h-11 rounded-xl border border-line px-3 bg-white mt-1"
                        onChange={e => { const r = board.recommendations.find(x => x.rec_id === e.target.value) || null; setRec(r); setReason(r?.reason || ''); setBy(r?.doctor || '') }}>
                  <option value="">None</option>
                  {board.recommendations.map(r => <option key={r.rec_id} value={r.rec_id}>{r.patient_name} → {r.ward_name || r.ward_type}</option>)}
                </select>
              </label>
            )}
            {!rec && (
              <div className="flex gap-2">
                <input value={velaId} onChange={e => setVelaId(e.target.value)} placeholder="VELA ID, e.g. VLA-8888" aria-label="VELA ID"
                       className="flex-1 min-h-11 rounded-xl border border-line px-3" onKeyDown={e => e.key === 'Enter' && lookup()} />
                <button onClick={lookup} className="min-h-11 px-4 rounded-xl border border-line">Find</button>
              </div>
            )}
            {patientToAdmit && (
              <div className="flex items-center gap-2 p-3 rounded-xl bg-brand-tint text-ink">
                <CheckCircle2 size={18} color="var(--brand)" /> <b>{patientToAdmit.name}</b>
              </div>
            )}
            <label className="block"><span className="text-sm text-ink-3">Room type</span>
              <select value={room} onChange={e => setRoom(e.target.value)} className="w-full min-h-11 rounded-xl border border-line px-3 bg-white mt-1">
                {board.room_types.map(r => <option key={r.name} value={r.name}>{r.name} · {money(r.cost_per_day)}/day</option>)}
              </select></label>
            <label className="block"><span className="text-sm text-ink-3">Reason for admission</span>
              <input value={reason} onChange={e => setReason(e.target.value)} className="w-full min-h-11 rounded-xl border border-line px-3 mt-1" /></label>
            <label className="block"><span className="text-sm text-ink-3">Diagnosis (optional)</span>
              <input value={diagnosis} onChange={e => setDiagnosis(e.target.value)} className="w-full min-h-11 rounded-xl border border-line px-3 mt-1" /></label>
            <label className="block"><span className="text-sm text-ink-3">Recommended by</span>
              <input value={by} onChange={e => setBy(e.target.value)} placeholder="Doctor's name" className="w-full min-h-11 rounded-xl border border-line px-3 mt-1" /></label>
            <button disabled={!patientToAdmit || busy} onClick={admit}
                    className="w-full min-h-12 rounded-xl bg-brand text-white font-semibold disabled:opacity-40">
              Admit to bed {bed.bed_number}
            </button>
            <button onClick={() => setBedStatus('maintenance')} className="w-full min-h-11 rounded-xl border border-line text-ink-2 flex items-center justify-center gap-2">
              <Wrench size={15} /> Mark bed out of service
            </button>
          </section>
        )}

        {!a && bed.status !== 'empty' && canAdmit && (
          <section className="space-y-3">
            <p className="text-ink-2 flex items-center gap-2"><ShieldAlert size={16} /> This bed is not available for patients.</p>
            <button onClick={() => setBedStatus('empty')} className="w-full min-h-12 rounded-xl bg-brand text-white font-semibold">Make bed available</button>
          </section>
        )}

        {!a && !canAdmit && <p className="text-ink-2">{bed.status === 'empty' ? 'This bed is free.' : 'This bed is out of service.'}</p>}
      </aside>
    </div>
  )
}
