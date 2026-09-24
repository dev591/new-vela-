import { API_URL, POLL_INTERVALS } from "../utils/config";
import { useEffect, useState, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { gsap } from 'gsap'
import DoctorSidebar from '../components/DoctorSidebar'
import { getUser } from '../utils/auth'
import toast from 'react-hot-toast'
import { socket, type SocketEventPayload } from '../hooks/useSocket'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip } from 'recharts'
import { CheckCircle, Send, ArrowRight, ArrowUpRight } from 'lucide-react'

type Ticket = {
  id: string;
  ticket_number: string;
  patient_id: string;
  patient_name: string;
  status: string;
  created_at: string;
  queue_position: number;
  notes?: string;
  vela_id?: string;
}

type Patient = { id: string; name: string; risk_score: number; ward: string; room: string; vela_id: string; documents?: any[] }

// Helper Component for Dynamic AI Autowriting
function Typist({ text }: { text: string }) {
  const [displayedText, setDisplayedText] = useState('')

  useEffect(() => {
    if (!text) {
      setDisplayedText('')
      return
    }

    setDisplayedText('')
    let index = 0
    const words = text.split(' ')
    const timer = setInterval(() => {
      if (index < words.length) {
        const word = words[index]
        setDisplayedText(prev => prev + (prev ? ' ' : '') + word)
        index++
      } else {
        clearInterval(timer)
      }
    }, 70) // Fast, smooth clinical typing speed

    return () => clearInterval(timer)
  }, [text])

  return <span>{displayedText}</span>
}

/**
 * Risk gauge — a thin arc rather than a heavy ring. Risk is a number a doctor
 * reads in a glance, so the digit carries the weight and the arc is support.
 */
function RiskGauge({ score }: { score: number }) {
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    let start = 0
    const duration = 900
    const stepTime = Math.abs(Math.floor(duration / (score || 1)))
    const timer = setInterval(() => {
      start += 1
      if (start <= score) setCurrent(start)
      else clearInterval(timer)
    }, stepTime || 15)
    return () => clearInterval(timer)
  }, [score])

  const color = score <= 40 ? 'var(--success)' : score <= 70 ? 'var(--warning)' : 'var(--danger)'
  const circumference = 2 * Math.PI * 34
  const offset = circumference - (circumference * current) / 100

  return (
    <div className="relative flex items-center justify-center w-[92px] h-[92px]">
      <svg className="w-full h-full -rotate-90" viewBox="0 0 92 92">
        <circle cx="46" cy="46" r="34" fill="none" stroke="var(--border)" strokeWidth="1.5" />
        <circle
          cx="46" cy="46" r="34" fill="none"
          stroke={color} strokeWidth="1.5" strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          style={{ transition: 'stroke-dashoffset 0.3s ease-out' }}
        />
      </svg>
      <div className="absolute flex flex-col items-center">
        <span className="display text-[34px] leading-none" style={{ color }}>{current}</span>
        <span className="label-mono mt-1" style={{ fontSize: 8 }}>Risk</span>
      </div>
    </div>
  )
}

export default function Doctor() {
  const [sidebarExpanded, setSidebarExpanded] = useState(false)
  const [queue, setQueue] = useState<Ticket[]>([])
  const [emergency, setEmergency] = useState<Patient[]>([])
  const [nextLoading, setNextLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  const navigate = useNavigate()

  const hospitalId = localStorage.getItem("vela_hospital_id")
  // A solo/independent doctor (see plan Phase 3/5) has no hospital — their
  // "queue" is their own booked appointments, never a hospital's shared one.
  const networkDoctorId = localStorage.getItem("vela_network_doctor_id")

  const [doctorState, setDoctorState] = useState<'Available' | 'Examining' | 'Writing Notes' | 'On Break'>('Available')

  const changeState = (newState: 'Available' | 'Examining' | 'Writing Notes' | 'On Break') => {
    setDoctorState(newState)
    if (socket && hospitalId) {
      const user = getUser()
      socket.emit("doctor_state", {
        doctor_id: user?.staff_id || localStorage.getItem("vela_staff_id"),
        name: user?.name || "Doctor",
        status: newState,
        hospital_id: hospitalId
      })
    }
  }

  useEffect(() => {
    if (!socket || !hospitalId) return
    socket.emit("join_hospital", { hospital_id: hospitalId })
  }, [hospitalId])

  const [activePatient, setActivePatient] = useState<any>(null)
  const [activePatientLoading, setActivePatientLoading] = useState(false)
  const [quickNote, setQuickNote] = useState('')
  const [quickNoteSubmitting, setQuickNoteSubmitting] = useState(false)
  const [selectedChartTest, setSelectedChartTest] = useState('')

  const fetchActivePatient = async (patientId: string) => {
    setActivePatientLoading(true)
    try {
      const res = await fetch(`${API_URL}/api/patients/${patientId}`)
      const data = await res.json()
      if (res.ok && data.status === 'success') {
        setActivePatient(data)
      }
    } catch (err) {
      console.error("Error fetching active patient details:", err)
    } finally {
      setActivePatientLoading(false)
    }
  }

  const handleQuickNoteSubmit = async () => {
    if (!quickNote.trim() || !activePatient?.patient?.id) return
    setQuickNoteSubmitting(true)
    try {
      const res = await fetch(`${API_URL}/api/notes/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patient_id: activePatient.patient.id,
          content: quickNote.trim(),
          created_by: getUser()?.name || 'Unknown'
        })
      })
      const data = await res.json()
      if (res.ok && data.status === 'success') {
        toast.success('Clinical note added successfully', { icon: '📝' })
        setQuickNote('')
        fetchActivePatient(activePatient.patient.id)
      }
    } catch {
      toast.error('Could not add clinical note')
    } finally {
      setQuickNoteSubmitting(false)
    }
  }

  const handleQuickComplete = async () => {
    if (!activePatient?.patient?.id) return
    const ticket = queue.find(t => t.status === 'in-progress' && t.patient_id === activePatient.patient.id)
      || queue.find(t => t.status === 'in-progress')
    if (!ticket) {
      toast.error('No active consultation ticket found')
      return
    }
    try {
      const res = await fetch(`${API_URL}/api/tickets/${ticket.id}/complete`, {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || 'Failed to complete consultation')
      }
      toast.success('Consultation completed & patient discharged', { icon: '✓' })
      setActivePatient(null)
      fetchQueue()
      fetchEmergency()
    } catch (err: any) {
      toast.error(err.message || 'Error completing consultation')
    }
  }

  useEffect(() => {
    const inProgressTicket = queue.find(t => t.status === 'in-progress')
    if (inProgressTicket) {
      if (!activePatient || activePatient.patient?.id !== inProgressTicket.patient_id) {
        fetchActivePatient(inProgressTicket.patient_id)
      }
    } else {
      setActivePatient(null)
    }
  }, [queue])

  // Keep the single global Atlas pointed at whoever is in the chair. The
  // backend also resolves this on its own from the doctor's active consult, so
  // sending undefined here is safe — better than sending a stale id, which
  // would override the correct answer.
  useEffect(() => {
    const inProgressTicket = queue.find(t => t.status === 'in-progress')
    ;(window as any).setAtlasPatient?.(
      activePatient?.patient?.id || inProgressTicket?.patient_id || undefined
    )
  }, [activePatient, queue])

  useEffect(() => {
    if (activePatient?.documents && activePatient.documents.length > 0) {
      const tests = Object.keys(activePatient.documents.reduce((acc: any, doc: any) => {
        if (doc.values && Array.isArray(doc.values)) {
          doc.values.forEach((v: any) => { if (v.test) acc[v.test.trim()] = true })
        }
        return acc
      }, {}))
      if (tests.length > 0 && !selectedChartTest) {
        const preferred = tests.find((t: string) => t.toLowerCase().includes('hemoglobin') || t.toLowerCase().includes('glucose') || t.toLowerCase().includes('sugar') || t.toLowerCase().includes('wbc')) || tests[0]
        setSelectedChartTest(preferred)
      }
    }
  }, [activePatient, selectedChartTest])

  const fetchQueue = async () => {
    try {
      if (networkDoctorId) {
        const res = await fetch(`${API_URL}/api/network/doctors/appointments?doctor_id=${networkDoctorId}`)
        const data = await res.json()
        if (res.ok && data.status === 'success') {
          const appts = (data.appointments || []).filter((a: any) => a.status !== 'cancelled')
          setQueue(appts.map((a: any, i: number): Ticket => ({
            id: a.id,
            ticket_number: a.time || '',
            patient_id: a.patient_id,
            patient_name: a.patient_name,
            status: a.status,
            created_at: a.created_at,
            queue_position: i,
            vela_id: a.vela_id,
          })))
        }
        return
      }

      const staffMember = getUser()
      const docId = staffMember?.staff_id || localStorage.getItem("vela_staff_id")
      let url = `${API_URL}/api/receptionist/queue?include_active=1&`
      if (docId) url += `doctor_id=${docId}&`
      if (hospitalId) url += `hospital_id=${hospitalId}`

      const res = await fetch(url)
      const data = await res.json()
      if (res.ok && data.status === 'success') {
        setQueue(data.queue || [])
      }
    } catch {
      // silent fail
    }
  }

  const fetchEmergency = async () => {
    // A solo doctor has no hospital-wide emergency board to see — and calling
    // this unscoped would otherwise leak every hospital's emergency patients.
    if (networkDoctorId) return
    try {
      const url = hospitalId
        ? `${API_URL}/api/patients/emergency?hospital_id=${hospitalId}`
        : `${API_URL}/api/patients/emergency`
      const res = await fetch(url)
      const data = await res.json()
      if (res.ok && data.status === 'success') {
        setEmergency(data.patients || [])
      }
    } catch {
      // silent fail
    }
  }

  useEffect(() => {
    Promise.all([fetchQueue(), fetchEmergency()])

    const queueTimer = setInterval(fetchQueue, POLL_INTERVALS.queue)
    const emergencyTimer = setInterval(fetchEmergency, POLL_INTERVALS.emergency)
    return () => {
      clearInterval(queueTimer)
      clearInterval(emergencyTimer)
    }
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    gsap.fromTo('.stat-cell',
      { y: 20, opacity: 0 },
      { y: 0, opacity: 1, stagger: 0.07, duration: 0.8, ease: 'power3.out', delay: 0.15 }
    )
  }, [])

  const callNext = async () => {
    setNextLoading(true)
    try {
      if (networkDoctorId) {
        const next = queue.find((t) => t.status === 'pending') || queue[0]
        if (!next) {
          toast('No patients waiting in queue', { icon: 'ℹ️' })
          return
        }
        if (next.status === 'pending') {
          await fetch(`${API_URL}/api/network/doctors/appointments/${next.id}/arrive`, { method: 'PATCH' })
        }
        navigate(`/patients/${next.patient_id}`)
        ;(window as any).setAtlasPatient(next.patient_id)
        fetchQueue()
        return
      }

      const staffMember = getUser()
      const res = await fetch(`${API_URL}/api/doctor/next-patient`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            department: staffMember?.specialization || localStorage.getItem("vela_specialization") || 'General',
            doctor_id: staffMember?.staff_id || localStorage.getItem("vela_staff_id"),
            hospital_id: hospitalId
        })
      })
      const data = await res.json()
      if (!res.ok || data.status !== 'success') throw new Error(data.message || 'No patients')

      if (!data.patient) {
        toast('No patients waiting in queue', { icon: 'ℹ️' })
        return
      }

      // Do NOT automatically speak the atlas summary on next patient click.
      // The doctor must ask Atlas manually via Spacebar to hear clinical insights.

      if (data.patient?.id) {
        // Hand the pre-loaded chart to the patient page so it paints instantly (it refreshes in the background).
        try { sessionStorage.setItem(`vela_chart_${data.patient.id}`, JSON.stringify({ patient: data.patient, documents: data.documents || [], medications: data.medications || [] })) } catch { /* storage unavailable */ }
        navigate(`/patients/${data.patient.id}`)
        ;(window as any).setAtlasPatient(data.patient.id)
      }
      fetchQueue()
      fetchEmergency()
    } catch (err: any) {
      toast.error(err.message || 'Next patient call failed')
    } finally {
      setNextLoading(false)
    }
  }

  const markComplete = async (ticketId: string) => {
    try {
      const res = await fetch(`${API_URL}/api/tickets/${ticketId}/complete`, {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || 'Failed to mark ticket complete')
      }
      toast.success('Ticket marked as complete')
      fetchQueue()
      fetchEmergency()
    } catch (err: any) {
      toast.error(err.message || 'Error completing ticket')
    }
  }

  useEffect(() => {
    if (!socket) return

    const handlePatientCompleted = () => {
      fetchQueue()
      fetchEmergency()
    }

    const handleLabUpdate = (data: SocketEventPayload) => {
      toast.success(`Lab Order for ${data.patient_name || 'Patient'}: ${(data.status || '').toUpperCase()}`, { icon: '🧪' })
    }

    const handleReportSubmitted = (data: SocketEventPayload) => {
      toast.success(`New Lab Report: ${data.patient_name || 'Patient'}`, {
        icon: '📊',
        duration: 8000
      })
      // Speak alert for doctor
      const u = new SpeechSynthesisUtterance(`New lab results are available for review for patient ${data.patient_name || 'unknown'}.`);
      window.speechSynthesis.speak(u);

      fetchQueue()
      fetchEmergency()
    }

    const handleAdmissionConfirmed = (data: SocketEventPayload) => {
      toast.success(`Admission Confirmed: ${data.patient_name || 'Patient'} assigned to ${data.ward_name}`, {
        icon: '🏥',
        duration: 6000
      });
      const u = new SpeechSynthesisUtterance(`Patient ${data.patient_name || 'unknown'} has been admitted to ${data.ward_name}.`);
      window.speechSynthesis.speak(u);
    }

    socket.on('patient_completed', handlePatientCompleted)
    socket.on('lab_update', handleLabUpdate)
    socket.on('report_submitted', handleReportSubmitted)
    socket.on('admission_confirmed', handleAdmissionConfirmed)

    return () => {
      socket.off('patient_completed', handlePatientCompleted)
      socket.off('lab_update', handleLabUpdate)
      socket.off('report_submitted', handleReportSubmitted)
      socket.off('admission_confirmed', handleAdmissionConfirmed)
    }
  }, [])

  const greeting = () => {
    const h = new Date().getHours()
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  }

  const waitingNow = queue.filter((t) => t.status === 'waiting').length
  const inProgress = queue.filter((t) => t.status === 'in-progress').length
  const completed = queue.filter((t) => t.status === 'completed').length
  const highRisk = emergency.length

  const user = getUser()

  const getDateLabel = () => {
    const date = new Date()
    return date.toLocaleDateString('en-US', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  }

  return (
    <div className="flex min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>
      <DoctorSidebar onExpandChange={setSidebarExpanded} />

      <main
        ref={containerRef}
        className="flex-1 transition-all duration-500 px-6 md:px-12 py-12"
        style={{ marginLeft: sidebarExpanded ? '260px' : '72px' }}
      >

        {/* ── Header ─────────────────────────────────────────── */}
        <header className="flex flex-wrap justify-between items-start gap-8 pb-10" style={{ borderBottom: '1px solid var(--border)' }}>
          <div>
            <div className="label-mono mb-5">{getDateLabel()}</div>
            <h1 className="display text-[44px] md:text-[60px] leading-[1.02]" style={{ color: 'var(--text)' }}>
              {greeting()},<br />
              <span className="display-italic" style={{ color: 'var(--brand)' }}>
                Dr. {user?.name?.split(' ')[1] || user?.name || 'Doctor'}.
              </span>
            </h1>

            {/* Status switcher */}
            <div className="flex gap-6 mt-8 flex-wrap">
              {(['Available', 'Examining', 'Writing Notes', 'On Break'] as const).map((status) => (
                <button
                  key={status}
                  type="button"
                  onClick={() => changeState(status)}
                  className="bg-transparent border-none p-0 cursor-pointer transition-opacity duration-300"
                  style={{ opacity: doctorState === status ? 1 : 0.4 }}
                >
                  <span className="label-mono flex items-center gap-2" style={{ color: doctorState === status ? 'var(--brand)' : 'var(--text-tertiary)' }}>
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: doctorState === status ? 'var(--brand)' : 'var(--text-tertiary)' }}
                    />
                    {status}
                  </span>
                </button>
              ))}
            </div>
          </div>

          <button
            type="button"
            onClick={callNext}
            disabled={nextLoading}
            className="group inline-flex items-center gap-4 pb-3 bg-transparent border-none cursor-pointer disabled:opacity-50"
            style={{ borderBottom: '1px solid var(--text)', cursor: nextLoading ? 'wait' : 'pointer' }}
          >
            <span className="text-[16px] font-medium" style={{ color: 'var(--text)' }}>
              {nextLoading ? 'Calling next…' : 'Next patient'}
            </span>
            <ArrowRight size={17} className="transition-transform duration-300 group-hover:translate-x-1.5" />
          </button>
        </header>

        {activePatient ? (

          /* ── Live consultation ──────────────────────────── */
          <section className="py-12">
            <div className="flex flex-wrap items-end justify-between gap-8 mb-12">
              <div>
                <div className="label-mono mb-4 flex items-center gap-2.5" style={{ color: 'var(--success)' }}>
                  <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--success)' }} />
                  Live consultation
                </div>
                <h2 className="display text-[40px] md:text-[54px] leading-none mb-3" style={{ color: 'var(--text)' }}>
                  {activePatient.patient.name}
                </h2>
                <div className="label-mono">
                  {activePatient.patient.vela_id} · Room {activePatient.patient.room} · {activePatient.patient.ward}
                </div>
              </div>

              <div className="flex items-center gap-8">
                <button
                  type="button"
                  onClick={() => navigate(`/patients/${activePatient.patient.id}`)}
                  className="group inline-flex items-center gap-2.5 bg-transparent border-none p-0 cursor-pointer"
                >
                  <span className="label-mono" style={{ color: 'var(--brand)' }}>Full record</span>
                  <ArrowUpRight size={15} style={{ color: 'var(--brand)' }} className="transition-transform duration-300 group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
                </button>

                <button
                  type="button"
                  onClick={handleQuickComplete}
                  className="group inline-flex items-center gap-3 pb-2.5 bg-transparent border-none cursor-pointer"
                  style={{ borderBottom: '1px solid var(--success)' }}
                >
                  <CheckCircle size={15} style={{ color: 'var(--success)' }} />
                  <span className="text-[14px] font-medium" style={{ color: 'var(--success)' }}>Complete & discharge</span>
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-[1.25fr_0.75fr] gap-12">

              {/* Left — vitals + trends */}
              <div>
                <div className="grid grid-cols-1 sm:grid-cols-[auto_1fr] gap-10 pb-10" style={{ borderTop: '1px solid var(--border)', paddingTop: 32 }}>
                  <RiskGauge score={activePatient.patient.risk_score} />

                  <div className="grid grid-cols-2 gap-x-8 gap-y-5 self-center">
                    {[
                      ['Age / Sex', `${activePatient.patient.age} · ${activePatient.patient.gender}`],
                      ['Blood group', activePatient.patient.blood_group || 'O+'],
                      ['Allergies', activePatient.patient.allergies || 'None'],
                      ['Conditions', activePatient.patient.existing_conditions || 'None recorded'],
                    ].map(([label, value]) => (
                      <div key={label}>
                        <div className="label-mono mb-1.5">{label}</div>
                        <div
                          className="text-[15px]"
                          style={{ color: label === 'Allergies' && value !== 'None' ? 'var(--danger)' : 'var(--text)' }}
                        >
                          {value}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Lab trends */}
                {(() => {
                  const labHistory = activePatient.documents.reduce((acc: any, doc: any) => {
                    if (doc.values && Array.isArray(doc.values)) {
                      doc.values.forEach((v: any) => {
                        const numVal = parseFloat(v.result);
                        if (!isNaN(numVal) && v.test) {
                          const testName = v.test.trim();
                          if (!acc[testName]) acc[testName] = [];
                          acc[testName].push({
                            date: new Date(doc.report_date).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
                            value: numVal,
                            unit: v.unit || '',
                            status: v.status || ''
                          });
                        }
                      });
                    }
                    return acc;
                  }, {});

                  Object.keys(labHistory).forEach(testName => {
                    labHistory[testName].sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());
                  });

                  const availableTests = Object.keys(labHistory);
                  const chartData = selectedChartTest ? labHistory[selectedChartTest] || [] : [];
                  const unit = chartData[0]?.unit || '';

                  return (
                    <div className="pt-8" style={{ borderTop: '1px solid var(--border)' }}>
                      <div className="flex justify-between items-center flex-wrap gap-4 mb-8">
                        <div className="label-mono">Laboratory trends</div>
                        {availableTests.length > 0 && (
                          <select
                            value={selectedChartTest}
                            onChange={(e) => setSelectedChartTest(e.target.value)}
                            className="bg-transparent text-[13px] py-1.5 outline-none cursor-pointer"
                            style={{ borderBottom: '1px solid var(--border-strong)', color: 'var(--text)' }}
                          >
                            {availableTests.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        )}
                      </div>

                      {chartData.length > 0 ? (
                        <div className="w-full h-60">
                          <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={chartData} margin={{ top: 8, right: 8, left: -22, bottom: 0 }}>
                              <CartesianGrid strokeDasharray="2 4" stroke="var(--border)" vertical={false} />
                              <XAxis dataKey="date" stroke="var(--text-tertiary)" tickLine={false} axisLine={{ stroke: 'var(--border)' }}
                                     tick={{ fontFamily: 'var(--font-sans)', fontSize: 9 }} />
                              <YAxis stroke="var(--text-tertiary)" tickLine={false} axisLine={false}
                                     tick={{ fontFamily: 'var(--font-sans)', fontSize: 9 }} unit={unit ? ` ${unit}` : ''} />
                              <ChartTooltip
                                contentStyle={{
                                  background: '#fff', border: '1px solid var(--border)', borderRadius: 0,
                                  fontFamily: 'var(--font-sans)', fontSize: 12, boxShadow: 'var(--shadow-md)'
                                }}
                              />
                              <Line type="monotone" dataKey="value" stroke="var(--brand)" strokeWidth={1.5}
                                    dot={{ fill: 'var(--brand)', r: 3, strokeWidth: 0 }} activeDot={{ r: 5 }} name={selectedChartTest} />
                            </LineChart>
                          </ResponsiveContainer>
                        </div>
                      ) : (
                        <div className="h-60 flex items-center justify-center text-[14px]" style={{ color: 'var(--text-tertiary)' }}>
                          No historical reports available to map trends.
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>

              {/* Right — Atlas prognosis + note */}
              <div className="flex flex-col gap-10">
                <div className="pt-8" style={{ borderTop: '1px solid var(--text)' }}>
                  <div className="label-mono mb-5" style={{ color: 'var(--brand)' }}>Atlas prognosis</div>
                  <p className="display display-italic text-[22px] leading-[1.35] min-h-[120px]" style={{ color: 'var(--text)' }}>
                    {activePatient.patient.atlas_analysis ? (
                      <Typist text={activePatient.patient.atlas_analysis} />
                    ) : (
                      'Clinical summary is processing. Hold the spacebar to ask Atlas for insights.'
                    )}
                  </p>
                </div>

                <div className="pt-8" style={{ borderTop: '1px solid var(--border)' }}>
                  <div className="label-mono mb-5">Progress note</div>
                  <textarea
                    value={quickNote}
                    onChange={(e) => setQuickNote(e.target.value)}
                    placeholder="Observations, prescriptions, plan…"
                    rows={5}
                    className="w-full bg-transparent text-[15px] outline-none resize-none leading-relaxed"
                    style={{ color: 'var(--text)', borderBottom: '1px solid var(--border-strong)', paddingBottom: 12 }}
                  />
                  <button
                    type="button"
                    onClick={handleQuickNoteSubmit}
                    disabled={quickNoteSubmitting || !quickNote.trim()}
                    className="group mt-6 inline-flex items-center gap-3 bg-transparent border-none p-0 cursor-pointer disabled:opacity-40"
                  >
                    <Send size={14} style={{ color: 'var(--brand)' }} />
                    <span className="label-mono" style={{ color: 'var(--brand)' }}>
                      {quickNoteSubmitting ? 'Saving…' : 'Save to patient file'}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </section>

        ) : activePatientLoading ? (
          <div className="py-32 text-center">
            <div className="label-mono">Loading active consultation…</div>
          </div>
        ) : (
          <>
            {/* ── Stats ───────────────────────────────────── */}
            <section className="grid grid-cols-2 lg:grid-cols-4 gap-px py-12" style={{ background: 'var(--border)' }}>
              {[
                { label: 'Waiting', value: waitingNow },
                { label: 'In progress', value: inProgress },
                { label: 'High risk', value: highRisk, alert: highRisk > 0 },
                { label: 'Completed', value: completed },
              ].map((stat) => (
                <div key={stat.label} className="stat-cell px-8 py-10" style={{ background: 'var(--bg)' }}>
                  <div className="label-mono mb-5" style={{ color: stat.alert ? 'var(--danger)' : 'var(--text-tertiary)' }}>
                    {stat.label}
                  </div>
                  <div className="display text-[64px] leading-none" style={{ color: stat.alert ? 'var(--danger)' : 'var(--text)' }}>
                    {String(stat.value).padStart(2, '0')}
                  </div>
                </div>
              ))}
            </section>

            {/* ── Queue + priority ────────────────────────── */}
            <div className="grid grid-cols-1 xl:grid-cols-[1.6fr_1fr] gap-16 pb-20">

              <section>
                <div className="flex justify-between items-baseline pb-6 mb-2" style={{ borderBottom: '1px solid var(--text)' }}>
                  <h2 className="display text-[30px]" style={{ color: 'var(--text)' }}>Patient queue</h2>
                  <span className="label-mono">{queue.length} total</span>
                </div>

                {queue.length === 0 ? (
                  <div className="py-24 text-center">
                    <div className="display text-[26px] mb-3" style={{ color: 'var(--text-tertiary)' }}>
                      The waiting room is empty
                    </div>
                    <div className="label-mono">No active patients</div>
                  </div>
                ) : queue.map((t) => {
                  const nowMinutes = Math.floor((new Date().getTime() - new Date(t.created_at).getTime()) / 60000)
                  const isWaiting = t.status === 'waiting'

                  return (
                    <div
                      key={t.id}
                      onClick={() => navigate(`/patients/${t.patient_id}`)}
                      className="group grid grid-cols-[48px_1fr_auto] items-center gap-6 py-7 cursor-pointer transition-all duration-300"
                      style={{ borderBottom: '1px solid var(--border)' }}
                      onMouseEnter={e => (e.currentTarget.style.paddingLeft = '8px')}
                      onMouseLeave={e => (e.currentTarget.style.paddingLeft = '0px')}
                    >
                      <span className="label-mono">{String(t.queue_position).padStart(2, '0')}</span>

                      <div className="min-w-0">
                        <div className="flex items-center gap-3 mb-1.5">
                          <span className="display text-[26px] leading-none" style={{ color: 'var(--text)' }}>
                            {t.patient_name}
                          </span>
                          {t.notes?.includes('Appointment Arrival') && (
                            <span className="label-mono" style={{ color: 'var(--brand)' }}>Appointment</span>
                          )}
                        </div>
                        {t.notes && (
                          <p className="text-[13px] truncate" style={{ color: 'var(--text-secondary)' }}>
                            {t.notes.replace('Appointment Arrival:', '').trim()}
                          </p>
                        )}
                        <div className="label-mono mt-2">TKT {t.ticket_number}</div>
                      </div>

                      <div className="flex items-center gap-6 shrink-0">
                        {!isWaiting && (
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); markComplete(t.id) }}
                            className="bg-transparent border-none p-0 cursor-pointer"
                          >
                            <span className="label-mono" style={{ color: 'var(--success)' }}>Complete</span>
                          </button>
                        )}
                        <span className="label-mono" style={{ color: isWaiting ? 'var(--text-tertiary)' : 'var(--brand)' }}>
                          {isWaiting ? `Waiting ${nowMinutes}m` : 'In progress'}
                        </span>
                        <ArrowRight size={16} style={{ color: 'var(--text-tertiary)' }}
                                    className="transition-transform duration-300 group-hover:translate-x-1" />
                      </div>
                    </div>
                  )
                })}
              </section>

              <section>
                <div className="flex justify-between items-baseline pb-6 mb-2"
                     style={{ borderBottom: `1px solid ${highRisk > 0 ? 'var(--danger)' : 'var(--text)'}` }}>
                  <h2 className="display text-[30px]" style={{ color: highRisk > 0 ? 'var(--danger)' : 'var(--text)' }}>
                    Priority
                  </h2>
                  {highRisk > 0 && (
                    <span className="w-2 h-2 rounded-full animate-pulse" style={{ background: 'var(--danger)' }} />
                  )}
                </div>

                {highRisk === 0 ? (
                  <div className="py-16">
                    <p className="text-[14px]" style={{ color: 'var(--text-tertiary)' }}>
                      No critical patients at this moment.
                    </p>
                  </div>
                ) : emergency.map((p) => (
                  <div
                    key={p.id}
                    onClick={() => navigate(`/patients/${p.id}`)}
                    className="group py-7 cursor-pointer transition-all duration-300"
                    style={{ borderBottom: '1px solid var(--border)' }}
                    onMouseEnter={e => (e.currentTarget.style.paddingLeft = '8px')}
                    onMouseLeave={e => (e.currentTarget.style.paddingLeft = '0px')}
                  >
                    <div className="flex items-start justify-between gap-4 mb-3">
                      <div className="min-w-0">
                        <div className="display text-[26px] leading-none mb-2" style={{ color: 'var(--text)' }}>
                          {p.name}
                        </div>
                        <div className="label-mono">{p.vela_id} · {p.ward}</div>
                      </div>
                      <div className="display text-[34px] leading-none shrink-0" style={{ color: 'var(--danger)' }}>
                        {p.risk_score}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-x-4 gap-y-1.5 mt-3">
                      {(p.documents?.[0]?.critical_flags || []).slice(0, 3).map((flag: string, idx: number) => (
                        <span key={idx} className="label-mono" style={{ color: 'var(--danger)' }}>
                          {flag}
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </section>
            </div>
          </>
        )}

        {/* Atlas is rendered once, globally, in App.tsx. A second instance used
            to live here — both grabbed the spacebar and raced over speech
            recognition, and each sent its own patient_id. The active patient is
            pushed to that single instance via setAtlasPatient (see effect above). */}

      </main>
    </div>
  )
}
