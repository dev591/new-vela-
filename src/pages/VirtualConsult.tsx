// Virtual consultation: a patient phones from another city and reads out their VELA ID.
// The doctor types it here and sees every report at once, explained in plain language, with downloads.
//
// COLLEGE-PRESENTATION NOTE: the VELA ID alone opens the records. The real product will make the patient
// approve each access with a one-time code (OTP) first. That step comes later.
import { useRef, useState } from 'react'
import toast from 'react-hot-toast'
import {
  Video, Search, Download, FileText, AlertTriangle, CheckCircle2, Eye, Info, ChevronDown, ChevronUp,
  Loader2, MessageCircleQuestion, Lightbulb, Sparkles, X,
} from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import DoctorSidebar from '../components/DoctorSidebar'
import { API_URL } from '../utils/config'

interface Value { test: string; unit: string; result: string; status: string; reference: string; number: number | null; low: number | null; high: number | null }
interface Report { id: string; filename: string; date: string; risk_score: number | null; summary?: string; flags: string[]; values: Value[]; has_file: boolean }
interface Abnormal extends Value { date: string; report: string }
interface Trend { test: string; unit: string; reference: string; points: { date: string; value: number; status: string }[] }
interface Patient { id: string; name: string; vela_id: string; age?: number; gender?: string; blood_group?: string; allergies?: string; existing_conditions?: string; risk_score?: number }
interface Records { patient: Patient; reports: Report[]; abnormal: Abnormal[]; trends: Trend[] }
interface Finding { title: string; detail: string; level: 'good' | 'watch' | 'concern' }
interface Analysis { headline: string; summary: string; findings: Finding[]; explanations: Record<string, string>; questions_to_ask: string[]; consider: string[] }

const LEVEL = {
  good: { color: 'var(--success)', bg: 'var(--success-light)', Icon: CheckCircle2, label: 'Looks fine' },
  watch: { color: 'var(--warning)', bg: 'var(--warning-light)', Icon: Eye, label: 'Keep an eye on' },
  concern: { color: 'var(--danger)', bg: 'var(--danger-light)', Icon: AlertTriangle, label: 'Needs attention' },
}
const statusTone = (s: string) => /crit|high|low|abnormal/i.test(s) ? (/crit/i.test(s) ? 'var(--danger)' : 'var(--warning)') : 'var(--success)'
const day = (d?: string) => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'

async function post(url: string, body: unknown) {
  const res = await fetch(`${API_URL}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return res
}
async function saveBlob(res: Response, fallbackName: string) {
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || fallbackName
  const url = URL.createObjectURL(await res.blob())
  const a = Object.assign(document.createElement('a'), { href: url, download: name })
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url)
}

// A bar showing the normal range in green and where this patient's value sits.
function Gauge({ v }: { v: Value }) {
  if (v.number === null || (v.low === null && v.high === null)) return null
  const lo = v.low ?? v.number, hi = v.high ?? v.number
  const span = Math.max(hi - lo, Math.abs(v.number) * 0.2, 1)
  const min = Math.min(lo, v.number) - span * 0.35, max = Math.max(hi, v.number) + span * 0.35
  const pos = (x: number) => `${Math.min(100, Math.max(0, ((x - min) / (max - min)) * 100))}%`
  return (
    <div className="mt-3" aria-hidden>
      <div className="relative h-2.5 rounded-full bg-surface-2">
        <div className="absolute inset-y-0 rounded-full" style={{ left: pos(lo), width: `calc(${pos(hi)} - ${pos(lo)})`, background: 'var(--success-light)', border: '1px solid var(--success)' }} />
        <div className="absolute -top-1 w-4 h-4 rounded-full border-2 border-white shadow" style={{ left: `calc(${pos(v.number)} - 8px)`, background: statusTone(v.status) }} />
      </div>
      <div className="flex justify-between text-xs text-ink-3 mt-1"><span>{v.low ?? ''}</span><span>normal {v.reference} {v.unit}</span><span>{v.high ?? ''}</span></div>
    </div>
  )
}

export default function VirtualConsult() {
  const [sidebarExpanded, setSidebarExpanded] = useState(false)
  const [velaId, setVelaId] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [data, setData] = useState<Records | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [analysisState, setAnalysisState] = useState<'idle' | 'loading' | 'error'>('idle')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [busy, setBusy] = useState('')
  const latest = useRef('')   // ignore a slow answer for an ID the doctor has already replaced

  const loadAnalysis = async (id: string) => {
    setAnalysis(null); setAnalysisState('loading')
    try {
      const res = await post('/api/virtual-consult/analysis', { vela_id: id })
      const d = await res.json()
      if (latest.current !== id) return
      if (res.ok && d.analysis) { setAnalysis(d.analysis); setAnalysisState('idle') } else setAnalysisState('error')
    } catch { if (latest.current === id) setAnalysisState('error') }
  }

  const search = async () => {
    const id = velaId.trim().toUpperCase()
    if (!id || loading) return
    latest.current = id
    setLoading(true); setError(''); setData(null); setAnalysis(null); setAnalysisState('idle')
    try {
      const res = await post('/api/virtual-consult/open', { vela_id: id })
      const d = await res.json().catch(() => ({}))
      if (res.status === 404) setError('No patient found with that VELA ID. Please check it with the patient.')
      else if (!res.ok) setError(d.detail || d.message || 'Could not open the records.')
      else {
        setData(d); setOpen(d.reports?.[0] ? { [d.reports[0].id]: true } : {})
        if (d.reports.length) void loadAnalysis(id)      // the reading takes a few seconds: show the reports first
      }
    } catch { setError('Backend not reachable. Is the server running?') } finally { setLoading(false) }
  }

  const download = async (kind: 'pdf' | 'file', documentId?: string) => {
    if (!data) return
    setBusy(documentId || kind)
    try {
      const res = kind === 'pdf'
        ? await post('/api/virtual-consult/pdf', { vela_id: data.patient.vela_id })
        : await post('/api/virtual-consult/file', { vela_id: data.patient.vela_id, document_id: documentId })
      if (!res.ok) throw new Error()
      await saveBlob(res, kind === 'pdf' ? 'VELA_summary.pdf' : 'report')
    } catch { toast.error('Could not download that') } finally { setBusy('') }
  }

  const p = data?.patient
  return (
    <div className="min-h-screen bg-canvas text-ink">
      <DoctorSidebar onExpandChange={setSidebarExpanded} />
      <main style={{ marginLeft: sidebarExpanded ? 240 : 64, transition: 'margin-left 0.4s cubic-bezier(0.16, 1, 0.3, 1)' }} className="p-6 md:p-10 min-h-screen">
        <div className="max-w-5xl mx-auto space-y-6">
          <header>
            <div className="flex items-center gap-2 text-brand font-semibold"><Video size={18} /> Virtual consultation</div>
            <h1 className="text-4xl font-semibold mt-1">See a patient's reports, even from another city</h1>
            <p className="text-lg text-ink-2 mt-1">Ask the patient for their VELA ID, type it below, and read everything in one calm page.</p>
          </header>

          <div className="flex gap-3 items-start rounded-2xl p-4" style={{ background: 'var(--warning-light)', border: '1px solid var(--warning)' }} role="note">
            <Info size={20} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: 2 }} />
            <p className="text-ink">
              <b>College presentation note.</b> For now, a VELA ID is enough to open a patient's records. In the real product the patient
              will approve each access with a one-time code (OTP) first. We will add that later.
            </p>
          </div>

          <form onSubmit={e => { e.preventDefault(); void search() }} className="bg-white rounded-3xl p-3 flex gap-3 shadow-sm border border-line-soft">
            <label className="flex items-center gap-3 flex-1 px-3">
              <Search size={22} className="text-ink-3" />
              <input value={velaId} onChange={e => setVelaId(e.target.value)} autoFocus aria-label="VELA ID"
                     placeholder="VELA ID the patient gives you, e.g. VLA-8888" className="flex-1 bg-transparent outline-none text-xl min-h-14" />
              {velaId && <button type="button" aria-label="Clear" onClick={() => { setVelaId(''); setData(null); setError('') }}><X size={18} className="text-ink-3" /></button>}
            </label>
            <button type="submit" disabled={!velaId.trim() || loading} className="min-h-14 px-8 rounded-2xl bg-brand text-white text-lg font-semibold disabled:opacity-40 flex items-center gap-2">
              {loading ? <Loader2 className="animate-spin" size={20} /> : null} Open records
            </button>
          </form>

          {error && <div role="alert" className="rounded-2xl p-4 font-medium" style={{ background: 'var(--danger-light)', color: 'var(--danger)' }}>{error}</div>}

          {data && p && (<>
            {/* Patient */}
            <section className="bg-white rounded-3xl p-6 border border-line-soft flex flex-wrap items-center gap-5 justify-between">
              <div className="flex items-center gap-4">
                <div className="w-16 h-16 rounded-full bg-brand-tint text-brand grid place-items-center text-2xl font-semibold">{p.name.split(' ').map(x => x[0]).slice(0, 2).join('')}</div>
                <div>
                  <h2 className="text-3xl font-semibold">{p.name}</h2>
                  <div className="text-ink-2 flex flex-wrap gap-x-4">
                    <span className="font-mono text-brand">{p.vela_id}</span>
                    {p.age ? <span>{p.age} years</span> : null}{p.gender ? <span>{p.gender}</span> : null}{p.blood_group ? <span>Blood {p.blood_group}</span> : null}
                  </div>
                  <div className="flex flex-wrap gap-2 mt-2">
                    {p.allergies && <span className="px-3 py-1 rounded-full text-sm font-medium" style={{ background: 'var(--danger-light)', color: 'var(--danger)' }}>Allergic: {p.allergies}</span>}
                    {p.existing_conditions && <span className="px-3 py-1 rounded-full text-sm bg-surface-2 text-ink-2">{p.existing_conditions}</span>}
                  </div>
                </div>
              </div>
              <button onClick={() => void download('pdf')} disabled={busy === 'pdf' || !data.reports.length}
                      className="min-h-12 px-6 rounded-2xl bg-ink text-white font-semibold flex items-center gap-2 disabled:opacity-40">
                {busy === 'pdf' ? <Loader2 className="animate-spin" size={18} /> : <Download size={18} />} Download summary (PDF)
              </button>
            </section>

            {!data.reports.length && (
              <div className="bg-white rounded-3xl p-10 text-center text-ink-2 border border-line-soft">
                <FileText size={32} className="mx-auto mb-2 text-ink-3" />
                <p className="text-xl font-medium text-ink">No reports on file for {p.name} yet</p>
                <p>Ask the patient to read out any recent results, or to upload their reports in the VELA app.</p>
              </div>
            )}

            {/* Plain-language reading */}
            {data.reports.length > 0 && (
              <section className="bg-white rounded-3xl p-6 border border-line-soft space-y-4" aria-live="polite">
                <h3 className="text-xl font-semibold flex items-center gap-2"><Sparkles size={20} className="text-brand" /> At a glance</h3>
                {analysisState === 'loading' && (
                  <div className="space-y-3 animate-pulse" aria-label="Reading the reports">
                    <div className="h-7 w-3/4 bg-surface-2 rounded" /><div className="h-4 w-full bg-surface-2 rounded" /><div className="h-4 w-5/6 bg-surface-2 rounded" />
                    <div className="grid md:grid-cols-2 gap-3">{[0, 1, 2, 3].map(i => <div key={i} className="h-20 bg-surface-2 rounded-2xl" />)}</div>
                    <p className="text-ink-3 text-sm">Reading the reports in plain language… the reports below are already ready.</p>
                  </div>
                )}
                {analysisState === 'error' && (
                  <p className="text-ink-2">The plain-language reading is unavailable right now. The reports and numbers below are still correct.{' '}
                    <button className="text-brand font-semibold" onClick={() => void loadAnalysis(p.vela_id)}>Try again</button></p>
                )}
                {analysis && (<>
                  <p className="text-2xl font-semibold leading-snug">{analysis.headline}</p>
                  {analysis.summary && <p className="text-lg text-ink-2">{analysis.summary}</p>}
                  <div className="grid md:grid-cols-2 gap-3">
                    {analysis.findings.map((f, i) => {
                      const L = LEVEL[f.level] || LEVEL.watch
                      return (
                        <div key={i} className="rounded-2xl p-4 flex gap-3" style={{ background: L.bg }}>
                          <L.Icon size={22} style={{ color: L.color, flexShrink: 0, marginTop: 2 }} />
                          <div><div className="font-semibold text-ink">{f.title}</div><div className="text-ink-2">{f.detail}</div>
                            <div className="text-xs font-semibold mt-1" style={{ color: L.color }}>{L.label}</div></div>
                        </div>)
                    })}
                  </div>
                </>)}
              </section>
            )}

            {/* Numbers that are off */}
            {data.abnormal.length > 0 && (
              <section className="space-y-3">
                <h3 className="text-xl font-semibold">Numbers to look at</h3>
                <div className="grid md:grid-cols-2 gap-4">
                  {data.abnormal.map((a, i) => (
                    <div key={i} className="bg-white rounded-3xl p-5 border border-line-soft">
                      <div className="flex justify-between items-baseline gap-3">
                        <div className="font-semibold text-lg">{a.test}</div>
                        <span className="px-3 py-0.5 rounded-full text-sm font-semibold text-white" style={{ background: statusTone(a.status) }}>{a.status}</span>
                      </div>
                      <div className="text-3xl font-semibold mt-1" style={{ color: statusTone(a.status) }}>{a.result} <span className="text-base text-ink-3 font-normal">{a.unit}</span></div>
                      <Gauge v={a} />
                      {analysis?.explanations?.[a.test] && <p className="text-ink-2 mt-3">{analysis.explanations[a.test]}</p>}
                      <div className="text-xs text-ink-3 mt-2">From {day(a.date)}</div>
                    </div>))}
                </div>
              </section>
            )}

            {/* Trends over time */}
            {data.trends.length > 0 && (
              <section className="space-y-3">
                <h3 className="text-xl font-semibold">How it has changed</h3>
                <div className="grid md:grid-cols-2 gap-4">
                  {data.trends.map(t => (
                    <div key={t.test} className="bg-white rounded-3xl p-5 border border-line-soft">
                      <div className="font-semibold">{t.test} <span className="text-ink-3 font-normal">({t.unit})</span></div>
                      <div style={{ height: 120 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={t.points.map(x => ({ ...x, label: day(x.date) }))} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                            <XAxis dataKey="label" tick={{ fontSize: 11 }} /><YAxis tick={{ fontSize: 11 }} domain={['auto', 'auto']} /><Tooltip />
                            <Line type="monotone" dataKey="value" stroke="var(--brand)" strokeWidth={2.5} dot={{ r: 4 }} />
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </div>))}
                </div>
              </section>
            )}

            {/* Every report */}
            {data.reports.length > 0 && (
              <section className="space-y-3">
                <h3 className="text-xl font-semibold">All reports · {data.reports.length}</h3>
                {data.reports.map(r => (
                  <div key={r.id} className="bg-white rounded-3xl border border-line-soft overflow-hidden">
                    <button className="w-full flex items-center justify-between gap-4 p-5 text-left" onClick={() => setOpen(o => ({ ...o, [r.id]: !o[r.id] }))} aria-expanded={!!open[r.id]}>
                      <div className="flex items-center gap-3 min-w-0">
                        <FileText className="text-brand shrink-0" />
                        <div className="min-w-0"><div className="font-semibold truncate">{r.filename}</div><div className="text-ink-3 text-sm">{day(r.date)}{r.risk_score !== null ? ` · risk ${r.risk_score}` : ''}</div></div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        {r.flags.map(f => <span key={f} className="hidden sm:inline px-3 py-1 rounded-full text-xs font-semibold" style={{ background: 'var(--danger-light)', color: 'var(--danger)' }}>{f}</span>)}
                        {open[r.id] ? <ChevronUp /> : <ChevronDown />}
                      </div>
                    </button>
                    {open[r.id] && (
                      <div className="px-5 pb-5 space-y-4 border-t border-line-soft pt-4">
                        {r.summary && <p className="text-ink-2 text-lg">{r.summary}</p>}
                        {r.values.length > 0 && (
                          <div className="overflow-x-auto"><table className="w-full text-left">
                            <thead><tr className="text-ink-3 text-sm"><th className="py-2 pr-4 font-medium">Test</th><th className="pr-4 font-medium">Result</th><th className="pr-4 font-medium">Normal range</th><th className="font-medium">Status</th></tr></thead>
                            <tbody>{r.values.map((v, i) => (
                              <tr key={i} className="border-t border-line-soft">
                                <td className="py-2 pr-4 font-medium">{v.test}</td><td className="pr-4">{v.result} {v.unit}</td><td className="pr-4 text-ink-2">{v.reference}</td>
                                <td><span className="font-semibold" style={{ color: statusTone(v.status) }}>{v.status || '—'}</span></td></tr>))}</tbody>
                          </table></div>
                        )}
                        {r.has_file && (
                          <button onClick={() => void download('file', r.id)} disabled={busy === r.id} className="min-h-11 px-5 rounded-xl border border-line font-semibold flex items-center gap-2">
                            {busy === r.id ? <Loader2 className="animate-spin" size={16} /> : <Download size={16} />} Download the original scan
                          </button>
                        )}
                      </div>
                    )}
                  </div>))}
              </section>
            )}

            {/* For the call */}
            {analysis && (analysis.questions_to_ask.length > 0 || analysis.consider.length > 0) && (
              <section className="grid md:grid-cols-2 gap-4">
                {analysis.questions_to_ask.length > 0 && (
                  <div className="bg-white rounded-3xl p-6 border border-line-soft">
                    <h3 className="text-lg font-semibold flex items-center gap-2 mb-2"><MessageCircleQuestion size={18} className="text-brand" /> Ask the patient</h3>
                    <ul className="space-y-2 list-disc pl-5 text-ink-2">{analysis.questions_to_ask.map((q, i) => <li key={i}>{q}</li>)}</ul>
                  </div>)}
                {analysis.consider.length > 0 && (
                  <div className="bg-white rounded-3xl p-6 border border-line-soft">
                    <h3 className="text-lg font-semibold flex items-center gap-2 mb-2"><Lightbulb size={18} className="text-brand" /> For you to consider</h3>
                    <ul className="space-y-2 list-disc pl-5 text-ink-2">{analysis.consider.map((q, i) => <li key={i}>{q}</li>)}</ul>
                  </div>)}
              </section>
            )}

            <p className="text-sm text-ink-3 text-center pb-8">
              The plain-language reading is decision support built from the patient's uploaded reports. It is not a diagnosis. Every access to these records is logged.
            </p>
          </>)}
        </div>
      </main>
    </div>
  )
}
