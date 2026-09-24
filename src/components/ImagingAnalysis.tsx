import { useCallback, useEffect, useRef, useState } from 'react'
import { API_URL } from '../utils/config'
import { getUser } from '../utils/auth'
import { socket, type SocketEventPayload } from '../hooks/useSocket'
import toast from 'react-hot-toast'
import {
  Upload, ScanLine, AlertTriangle, CheckCircle2, XCircle, Trash2,
  ShieldAlert, Activity, Loader2,
} from 'lucide-react'

/**
 * Radiology second-read panel (Imaging tab on the patient page).
 *
 * The UI has one job beyond showing findings: make it structurally impossible
 * to mistake an AI suggestion for a confirmed diagnosis. So every finding
 * carries a visible confidence, nothing is styled as settled until a doctor
 * confirms it, and the disclaimer the backend returns is rendered verbatim.
 */

type Finding = {
  finding: string
  location: string
  severity: 'critical' | 'significant' | 'minor' | 'incidental'
  confidence: 'high' | 'medium' | 'low'
  description: string
}

type Correlation = { observation: string; context: string; interpretation: string }

type Analysis = {
  modality: string
  body_region: string
  view: string
  technical_quality: string
  normal_study: boolean
  findings: Finding[]
  normal_structures: string[]
  impression: string
  correlation: Correlation[]
  urgent: boolean
  urgent_reason: string
  next_steps: string[]
  overall_confidence: 'high' | 'medium' | 'low'
  disclaimer: string
}

type Study = {
  id: string
  filename: string
  analysis: Analysis
  image_data: string | null
  urgent: boolean
  review_status: 'pending' | 'confirmed' | 'rejected'
  reviewed_by?: string | null
  reviewed_at?: string | null
  review_note?: string | null
  confirmed_findings: string[]
  created_at: string
}

const SEVERITY: Record<Finding['severity'], { label: string; fg: string; bg: string; border: string }> = {
  critical:    { label: 'Critical',    fg: 'var(--danger)', bg: 'rgba(185,28,28,0.08)',  border: 'rgba(185,28,28,0.25)' },
  significant: { label: 'Significant', fg: '#C2410C', bg: 'rgba(194,65,12,0.08)',  border: 'rgba(194,65,12,0.25)' },
  minor:       { label: 'Minor',       fg: '#A16207', bg: 'rgba(161,98,7,0.08)',   border: 'rgba(161,98,7,0.22)' },
  incidental:  { label: 'Incidental',  fg: '#475569', bg: 'rgba(71,85,105,0.07)',  border: 'rgba(71,85,105,0.2)' },
}

const CONFIDENCE_WIDTH = { high: '100%', medium: '62%', low: '28%' } as const

function ConfidenceBar({ level }: { level: Finding['confidence'] }) {
  const color = level === 'high' ? '#059669' : level === 'medium' ? '#D97706' : '#DC2626'
  return (
    <div className="flex items-center gap-2 shrink-0" title={`Model confidence: ${level}`}>
      <div className="w-14 h-1.5 rounded-full bg-surface-2 overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700"
             style={{ width: CONFIDENCE_WIDTH[level], background: color }} />
      </div>
      <span className="font-mono text-[9px] uppercase tracking-wider" style={{ color }}>
        {level}
      </span>
    </div>
  )
}

export default function ImagingAnalysis({ patientId }: { patientId: string }) {
  const [studies, setStudies] = useState<Study[]>([])
  const [loading, setLoading] = useState(true)
  const [analyzing, setAnalyzing] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [complaint, setComplaint] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [selectedFindings, setSelectedFindings] = useState<Record<string, Set<number>>>({})
  const [reviewNote, setReviewNote] = useState<Record<string, string>>({})
  const [lightbox, setLightbox] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const fetchStudies = useCallback(async () => {
    if (!patientId) return
    try {
      const res = await fetch(`${API_URL}/api/imaging/patient/${patientId}`)
      const data = await res.json()
      if (res.ok && data.status === 'success') {
        setStudies(data.studies || [])
        // Newest study opens by default — that's the one being discussed.
        if (data.studies?.length) setExpanded(prev => prev ?? data.studies[0].id)
      }
    } catch {
      // Non-fatal: the panel still works for new uploads.
    } finally {
      setLoading(false)
    }
  }, [patientId])

  useEffect(() => { fetchStudies() }, [fetchStudies])

  // A scan uploaded from elsewhere (patient portal, reception desk) is
  // auto-routed to radiology by the backend — reflect that here live.
  useEffect(() => {
    if (!socket) return
    const onAnalyzed = (data: SocketEventPayload) => {
      if (data?.patient_id !== patientId) return
      toast.success(data.urgent ? 'Urgent imaging finding — review now' : 'New imaging analysis ready',
                    { icon: data.urgent ? '🚨' : '🩻' })
      fetchStudies()
    }
    socket.on('imaging_analyzed', onAnalyzed)
    return () => { socket.off('imaging_analyzed', onAnalyzed) }
  }, [patientId, fetchStudies])

  const analyze = async (file: File) => {
    if (!file || analyzing) return
    setAnalyzing(true)
    const toastId = toast.loading(`Reading ${file.name}…`)
    try {
      const form = new FormData()
      form.append('file', file)
      form.append('patient_id', patientId)
      form.append('complaint', complaint.trim())
      form.append('uploaded_by', getUser()?.name || '')

      const res = await fetch(`${API_URL}/api/imaging/analyze`, { method: 'POST', body: form })
      const data = await res.json()

      if (data.status === 'not_imaging') {
        toast(data.message || 'That is not a radiology image', { id: toastId, icon: 'ℹ️' })
        return
      }
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || 'Analysis failed')
      }

      setStudies(prev => [data.study, ...prev])
      setExpanded(data.study.id)
      setComplaint('')
      toast.success(
        data.study.urgent ? 'Urgent findings — review immediately' : 'Second read complete',
        { id: toastId, icon: data.study.urgent ? '🚨' : '✓' },
      )
    } catch (err: any) {
      toast.error(err.message || 'Imaging analysis failed', { id: toastId })
    } finally {
      setAnalyzing(false)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files?.[0]
    if (file) analyze(file)
  }

  const toggleFinding = (studyId: string, idx: number) => {
    setSelectedFindings(prev => {
      const next = new Set(prev[studyId] ?? [])
      next.has(idx) ? next.delete(idx) : next.add(idx)
      return { ...prev, [studyId]: next }
    })
  }

  const submitReview = async (study: Study, decision: 'confirmed' | 'rejected') => {
    const picked = Array.from(selectedFindings[study.id] ?? [])
      .map(i => study.analysis.findings[i])
      .filter(Boolean)

    if (decision === 'confirmed' && picked.length === 0 && study.analysis.findings.length > 0) {
      toast('Select which findings you are confirming first', { icon: '☝️' })
      return
    }

    try {
      const res = await fetch(`${API_URL}/api/imaging/${study.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          reviewed_by: getUser()?.name || 'Doctor',
          note: reviewNote[study.id] || '',
          confirmed_findings: picked.map(f => `${f.finding}${f.location ? ` (${f.location})` : ''}`),
        }),
      })
      const data = await res.json()
      if (!res.ok || data.status !== 'success') throw new Error(data.message || 'Review failed')

      toast.success(
        decision === 'confirmed'
          ? 'Confirmed — written to the patient file'
          : 'Marked as rejected. Nothing was written to the record.',
        { icon: decision === 'confirmed' ? '✓' : '✕' },
      )
      fetchStudies()
    } catch (err: any) {
      toast.error(err.message || 'Could not save review')
    }
  }

  const removeStudy = async (studyId: string) => {
    try {
      await fetch(`${API_URL}/api/imaging/${studyId}`, { method: 'DELETE' })
      setStudies(prev => prev.filter(s => s.id !== studyId))
      toast.success('Study removed')
    } catch {
      toast.error('Could not remove study')
    }
  }

  return (
    <div className="flex flex-col gap-8">
      {/* ── Upload zone ─────────────────────────────────────────────── */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true) }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => !analyzing && fileRef.current?.click()}
        className={`relative rounded-2xl border-2 border-dashed p-10 text-center transition-all duration-300 cursor-pointer ${
          dragging ? 'border-brand-soft bg-brand-tint/60 scale-[1.01]'
                   : 'border-line-strong hover:border-brand-soft hover:bg-canvas/60'
        } ${analyzing ? 'pointer-events-none opacity-70' : ''}`}
      >
        <input
          ref={fileRef}
          type="file"
          accept="image/*,.pdf,.dcm"
          className="hidden"
          onChange={e => e.target.files?.[0] && analyze(e.target.files[0])}
        />
        {analyzing ? (
          <div className="flex flex-col items-center gap-3">
            <Loader2 size={30} className="text-brand animate-spin" />
            <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-brand">
              Analysing study…
            </div>
            <div className="text-xs text-ink-2 font-light">
              Systematic read in progress — this takes 10–20 seconds.
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3">
            <div className="w-14 h-14 rounded-2xl bg-night flex items-center justify-center">
              <ScanLine size={24} className="text-white" strokeWidth={1.5} />
            </div>
            <div className="font-serif italic text-2xl text-ink">
              Drop an X-ray, CT, MRI or ultrasound
            </div>
            <div className="text-xs text-ink-2 font-light max-w-md">
              VELA performs a structured second read — modality, systematic findings,
              impression, and correlation against this patient's existing labs.
            </div>
            <div className="flex items-center gap-2 mt-1 font-mono text-[10px] uppercase tracking-widest text-ink-3">
              <Upload size={12} /> Click or drag to upload
            </div>
          </div>
        )}
      </div>

      {/* Optional clinical context — measurably sharpens the correlation output */}
      <div className="flex flex-col gap-2 -mt-4">
        <label className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">
          Presenting complaint <span className="normal-case tracking-normal">(optional — improves correlation)</span>
        </label>
        <input
          value={complaint}
          onChange={e => setComplaint(e.target.value)}
          placeholder="e.g. Fever with productive cough for 5 days, left-sided chest pain"
          className="w-full bg-white border border-line rounded-xl px-4 py-3 text-sm font-sans text-ink outline-none focus:border-brand-soft transition-colors"
        />
      </div>

      {/* ── Studies ─────────────────────────────────────────────────── */}
      {loading ? (
        <div className="py-16 text-center font-mono text-[11px] uppercase tracking-widest text-ink-3">
          Loading imaging studies…
        </div>
      ) : studies.length === 0 ? (
        <div className="py-16 text-center border border-dashed border-line rounded-2xl bg-canvas/50">
          <Activity size={22} className="text-ink-3 mx-auto mb-3" />
          <div className="font-serif italic text-xl text-ink-2">No imaging studies yet</div>
          <div className="text-xs text-ink-3 font-light mt-1">
            Uploaded scans and their second reads will appear here.
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-6">
          {studies.map(study => {
            const a = study.analysis || ({} as Analysis)
            const isOpen = expanded === study.id
            const picked = selectedFindings[study.id] ?? new Set<number>()

            return (
              <div
                key={study.id}
                className={`rounded-2xl border bg-white overflow-hidden transition-all duration-300 ${
                  study.urgent ? 'border-danger-soft shadow-lg shadow-danger-soft/10' : 'border-line'
                }`}
              >
                {/* Urgent banner */}
                {study.urgent && (
                  <div className="flex items-center gap-3 bg-danger text-white px-6 py-3">
                    <ShieldAlert size={16} />
                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] font-bold">
                      Urgent — immediate review
                    </span>
                    {a.urgent_reason && (
                      <span className="font-sans text-xs font-light opacity-90 truncate">
                        {a.urgent_reason}
                      </span>
                    )}
                  </div>
                )}

                {/* Header */}
                <button
                  type="button"
                  onClick={() => setExpanded(isOpen ? null : study.id)}
                  className="w-full flex items-center justify-between gap-6 px-6 py-5 text-left hover:bg-canvas/70 transition-colors"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    {study.image_data && (
                      <img
                        src={study.image_data}
                        alt={study.filename}
                        className="w-14 h-14 rounded-lg object-cover bg-black shrink-0"
                      />
                    )}
                    <div className="min-w-0">
                      <div className="font-serif italic text-2xl text-ink truncate">
                        {a.modality || 'Study'} — {a.body_region || 'Unknown region'}
                      </div>
                      <div className="font-mono text-[10px] uppercase tracking-widest text-ink-3 mt-1 truncate">
                        {a.view && `${a.view} • `}
                        {new Date(study.created_at).toLocaleString()} • {study.filename}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-3 shrink-0">
                    {study.review_status === 'confirmed' && (
                      <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest px-3 py-1.5 rounded-full bg-success-tint text-success border border-success-soft">
                        <CheckCircle2 size={11} /> Confirmed
                      </span>
                    )}
                    {study.review_status === 'rejected' && (
                      <span className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-widest px-3 py-1.5 rounded-full bg-surface-2 text-ink-2 border border-line">
                        <XCircle size={11} /> Rejected
                      </span>
                    )}
                    {study.review_status === 'pending' && (
                      <span className="font-mono text-[9px] uppercase tracking-widest px-3 py-1.5 rounded-full bg-warning-tint text-warning border border-warning-soft">
                        Awaiting review
                      </span>
                    )}
                    <span className="font-mono text-[10px] text-ink-3">
                      {a.findings?.length || 0} finding{a.findings?.length === 1 ? '' : 's'}
                    </span>
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-line px-6 py-8 grid grid-cols-1 lg:grid-cols-[0.9fr_1.1fr] gap-8">
                    {/* Image + technical */}
                    <div className="flex flex-col gap-4">
                      {study.image_data && (
                        <img
                          src={study.image_data}
                          alt={study.filename}
                          onClick={() => setLightbox(study.image_data)}
                          className="w-full rounded-xl bg-black object-contain max-h-[420px] cursor-zoom-in"
                        />
                      )}
                      {a.technical_quality && (
                        <div className="text-xs text-ink-2 font-light leading-relaxed border border-line bg-canvas/60 rounded-xl p-4">
                          <span className="font-mono text-[9px] uppercase tracking-widest text-ink-3 block mb-1.5">
                            Technical quality
                          </span>
                          {a.technical_quality}
                        </div>
                      )}
                      {a.normal_structures?.length > 0 && (
                        <div className="border border-line bg-canvas/60 rounded-xl p-4">
                          <span className="font-mono text-[9px] uppercase tracking-widest text-ink-3 block mb-2">
                            Checked and normal
                          </span>
                          <div className="flex flex-wrap gap-1.5">
                            {a.normal_structures.map((s, i) => (
                              <span key={i} className="font-mono text-[10px] px-2 py-1 rounded-md bg-success-tint text-success border border-success-soft">
                                {s}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Findings + impression */}
                    <div className="flex flex-col gap-6">
                      <div>
                        <h4 className="font-serif italic text-2xl text-ink mb-1">Findings</h4>
                        <p className="font-mono text-[9px] uppercase tracking-widest text-ink-3 mb-4">
                          Tick each finding you accept — only ticked findings are written to the record
                        </p>

                        {a.normal_study && a.findings?.length === 0 ? (
                          <div className="flex items-center gap-3 border border-success-soft bg-success-tint/60 rounded-xl p-5">
                            <CheckCircle2 size={18} className="text-success shrink-0" />
                            <div className="text-sm text-success font-light">
                              No significant abnormality reported on this study.
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-col gap-3">
                            {(a.findings || []).map((f, i) => {
                              const sev = SEVERITY[f.severity] ?? SEVERITY.minor
                              const isPicked = picked.has(i)
                              const locked = study.review_status !== 'pending'
                              return (
                                <div
                                  key={i}
                                  onClick={() => !locked && toggleFinding(study.id, i)}
                                  className={`rounded-xl border p-4 transition-all ${locked ? '' : 'cursor-pointer'} ${
                                    isPicked ? 'ring-2 ring-brand-soft/40 border-brand-soft' : 'hover:border-line-strong'
                                  }`}
                                  style={{ background: sev.bg, borderColor: isPicked ? undefined : sev.border }}
                                >
                                  <div className="flex items-start justify-between gap-4 mb-2">
                                    <div className="flex items-start gap-3 min-w-0">
                                      {!locked && (
                                        <span className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 transition-colors ${
                                          isPicked ? 'bg-brand border-brand-soft' : 'bg-white border-line-strong'
                                        }`}>
                                          {isPicked && <CheckCircle2 size={11} className="text-white" />}
                                        </span>
                                      )}
                                      <div className="min-w-0">
                                        <div className="font-sans text-sm font-semibold text-ink">
                                          {f.finding}
                                        </div>
                                        {f.location && (
                                          <div className="font-mono text-[10px] uppercase tracking-wider mt-0.5" style={{ color: sev.fg }}>
                                            {f.location}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    <ConfidenceBar level={f.confidence} />
                                  </div>
                                  {f.description && (
                                    <p className="text-xs text-ink-2 font-light leading-relaxed pl-0 md:pl-7">
                                      {f.description}
                                    </p>
                                  )}
                                  <div className="mt-2 md:pl-7">
                                    <span className="font-mono text-[9px] uppercase tracking-widest px-2 py-0.5 rounded-full border"
                                          style={{ color: sev.fg, borderColor: sev.border, background: '#fff' }}>
                                      {sev.label}
                                    </span>
                                  </div>
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>

                      {a.impression && (
                        <div className="border border-line rounded-xl p-5 bg-canvas/50">
                          <span className="font-mono text-[9px] uppercase tracking-widest text-ink-3 block mb-2">
                            Impression
                          </span>
                          <p className="font-sans text-sm text-ink leading-relaxed italic">
                            {a.impression}
                          </p>
                        </div>
                      )}

                      {a.correlation?.length > 0 && (
                        <div className="border border-brand-soft rounded-xl p-5 bg-brand-tint/40">
                          <span className="font-mono text-[9px] uppercase tracking-widest text-brand-dark block mb-3">
                            Correlation with this patient's record
                          </span>
                          <div className="flex flex-col gap-3">
                            {a.correlation.map((c, i) => (
                              <div key={i} className="text-xs leading-relaxed">
                                <div className="font-mono text-[10px] text-brand-dark">
                                  {c.observation} <span className="text-ink-3">↔</span> {c.context}
                                </div>
                                <div className="text-ink font-light mt-0.5">{c.interpretation}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {a.next_steps?.length > 0 && (
                        <div>
                          <span className="font-mono text-[9px] uppercase tracking-widest text-ink-3 block mb-2">
                            Suggested next steps
                          </span>
                          <ul className="flex flex-col gap-1.5">
                            {a.next_steps.map((s, i) => (
                              <li key={i} className="text-xs text-ink font-light flex gap-2">
                                <span className="text-ink-3">—</span> {s}
                              </li>
                            ))}
                          </ul>
                        </div>
                      )}

                      {/* Doctor-in-the-loop gate */}
                      {study.review_status === 'pending' ? (
                        <div className="border-t border-line pt-5 flex flex-col gap-3">
                          <textarea
                            value={reviewNote[study.id] || ''}
                            onChange={e => setReviewNote(prev => ({ ...prev, [study.id]: e.target.value }))}
                            rows={2}
                            placeholder="Your reading / correction (optional, saved with your name)"
                            className="w-full bg-white border border-line rounded-xl p-3 text-sm font-sans text-ink outline-none focus:border-brand-soft resize-none"
                          />
                          <div className="flex flex-wrap gap-3">
                            <button
                              type="button"
                              onClick={() => submitReview(study, 'confirmed')}
                              className="flex items-center gap-2 bg-success hover:bg-success text-white px-5 py-3 rounded-xl font-mono text-[10px] uppercase tracking-[0.15em] font-bold transition-colors"
                            >
                              <CheckCircle2 size={13} /> Confirm selected
                            </button>
                            <button
                              type="button"
                              onClick={() => submitReview(study, 'rejected')}
                              className="flex items-center gap-2 bg-white border border-line-strong text-ink-2 hover:text-ink px-5 py-3 rounded-xl font-mono text-[10px] uppercase tracking-[0.15em] transition-colors"
                            >
                              <XCircle size={13} /> Reject read
                            </button>
                            <button
                              type="button"
                              onClick={() => removeStudy(study.id)}
                              className="flex items-center gap-2 text-ink-3 hover:text-danger px-3 py-3 rounded-xl font-mono text-[10px] uppercase tracking-[0.15em] transition-colors ml-auto"
                            >
                              <Trash2 size={13} /> Delete
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="border-t border-line pt-5 text-xs text-ink-2 font-light">
                          {study.review_status === 'confirmed' ? 'Confirmed' : 'Rejected'} by{' '}
                          <strong className="text-ink font-medium">{study.reviewed_by}</strong>
                          {study.reviewed_at && ` • ${new Date(study.reviewed_at).toLocaleString()}`}
                          {study.confirmed_findings?.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              {study.confirmed_findings.map((f, i) => (
                                <span key={i} className="font-mono text-[10px] px-2 py-1 rounded-md bg-success-tint text-success border border-success-soft">
                                  ✓ {f}
                                </span>
                              ))}
                            </div>
                          )}
                          {study.review_note && (
                            <p className="mt-2 italic text-ink-2">"{study.review_note}"</p>
                          )}
                        </div>
                      )}

                      {/* Rendered verbatim from the backend — do not soften. */}
                      {a.disclaimer && (
                        <div className="flex gap-2.5 items-start border border-warning-soft bg-warning-tint/70 rounded-xl p-4">
                          <AlertTriangle size={14} className="text-warning shrink-0 mt-0.5" />
                          <p className="text-[11px] text-warning font-light leading-relaxed">
                            {a.disclaimer}
                          </p>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Lightbox */}
      {lightbox && (
        <div
          onClick={() => setLightbox(null)}
          className="fixed inset-0 z-[100] bg-black/90 flex items-center justify-center p-8 cursor-zoom-out"
        >
          <img src={lightbox} alt="Study" className="max-w-full max-h-full object-contain" />
        </div>
      )}
    </div>
  )
}
