import { API_URL } from "../utils/config";
import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import DoctorSidebar from '../components/DoctorSidebar'
import { getUser } from '../utils/auth'
import { socket, type SocketEventPayload } from '../hooks/useSocket'
import PatientHistoryRag from '../components/PatientHistoryRag'
import ImagingAnalysis from '../components/ImagingAnalysis'
import toast from 'react-hot-toast'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as ChartTooltip } from 'recharts'
import { TrendingUp, Trash2, ChevronDown, ChevronUp } from 'lucide-react'

type Patient = {
  id: string
  name: string
  age: number
  gender: string
  blood_group: string
  ward: string
  room: string
  doctor: string
  status: string
  risk_score: number
  vela_id: string
  allergies: string
  existing_conditions: string
  atlas_analysis?: string
  atlas_confidence?: string
}

type DocumentItem = {
  id: string
  filename: string
  report_date: string
  risk_score: number
  summary: string
  critical_flags: string[]
  file_url?: string | null
  uploaded_at?: string
  values: Array<{ test: string; result: string; unit: string; status: string; reference: string }>
}

type Medication = {
  id: string
  name: string
  dosage: string
  frequency: string
  prescribed_by: string
  start_date: string
  notes: string
}

type NoteItem = {
  id: string
  content: string
  created_by: string
  created_at: string
}

type ReminderItem = {
  id: string
  message: string
  due_time: string
  is_done: boolean
}

export default function PatientDetail() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [sidebarExpanded, setSidebarExpanded] = useState(false)
  const [patient, setPatient] = useState<Patient | null>(null)
  const [documents, setDocuments] = useState<DocumentItem[]>([])
  const [medications, setMedications] = useState<Medication[]>([])
  const [notes, setNotes] = useState<NoteItem[]>([])
  const [reminders, setReminders] = useState<ReminderItem[]>([])
  const [activeTab, setActiveTab] = useState<'summary' | 'labs' | 'reports' | 'imaging' | 'medications' | 'notes' | 'history'>('summary')
  const [testOrders, setTestOrders] = useState<any[]>([])
  const [cancellingTestOrderId, setCancellingTestOrderId] = useState<string | null>(null)
  const [networkLabs, setNetworkLabs] = useState<any[]>([])
  const [routingOrderId, setRoutingOrderId] = useState<string | null>(null)
  const [routingToLabId, setRoutingToLabId] = useState<string | null>(null)
  const [newNote, setNewNote] = useState('')
  const [newReminder, setNewReminder] = useState('')
  const [newReminderDue, setNewReminderDue] = useState('')
  const [uploadStatus, setUploadStatus] = useState('')
  const [selectedChartTest, setSelectedChartTest] = useState<string>('')
  const [isAnomaliesExpanded, setIsAnomaliesExpanded] = useState(false)
  const [reviewImage, setReviewImage] = useState<string | null>(null)

  // Ambient Voice-to-Order Scribe States
  const [draftOrders, setDraftOrders] = useState<{
    prescriptions: Array<{ medication_name: string; dosage: string; frequency: string; duration: string }>;
    lab_requisitions: string[];
    follow_up_days: number | null;
  } | null>(null)
  const [isAmbientListening, setIsAmbientListening] = useState(false)
  const [ambientTranscript, setAmbientTranscript] = useState("")
  const recognitionRef = useRef<any>(null)

  useEffect(() => {
    if (documents.length > 0) {
      const tests = Object.keys(documents.reduce<Record<string, any>>((acc, doc) => {
        if (doc.values && Array.isArray(doc.values)) {
          doc.values.forEach(v => { if (v.test) acc[v.test.trim()] = true; });
        }
        return acc;
      }, {}));
      if (tests.length > 0 && !selectedChartTest) {
        const preferred = tests.find(t => t.toLowerCase().includes('hemoglobin') || t.toLowerCase().includes('glucose') || t.toLowerCase().includes('sugar') || t.toLowerCase().includes('wbc')) || tests[0];
        setSelectedChartTest(preferred);
      }
    }
  }, [documents, selectedChartTest]);

  const fetchTestOrders = async () => {
    if (!id) return
    try {
      const res = await fetch(`${API_URL}/api/lab/patient/${id}`)
      const data = await res.json()
      if (res.ok && data.status === 'success') setTestOrders(data.orders || [])
    } catch {
      // silent — the Labs tab just shows empty state
    }
  }

  const cancelTestOrder = async (order: any) => {
    if (!window.confirm(`Cancel ${order.test_type}?`)) return
    setCancellingTestOrderId(order.id)
    try {
      const res = await fetch(`${API_URL}/api/lab/orders/${order.id}/cancel`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelled_by: getUser()?.name || 'Doctor' }),
      })
      const data = await res.json()
      if (data.status !== 'success') throw new Error(data.message || 'Cancel failed')
      toast.success(`${order.test_type} cancelled`)
      fetchTestOrders()
    } catch (err: any) {
      toast.error(err.message || 'Cancel failed')
    } finally {
      setCancellingTestOrderId(null)
    }
  }

  useEffect(() => {
    if (activeTab === 'labs' && networkLabs.length === 0) fetchNetworkLabs()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab])

  const fetchNetworkLabs = async () => {
    try {
      const res = await fetch(`${API_URL}/api/network/labs`)
      const data = await res.json()
      if (data.status === 'success') setNetworkLabs(data.labs || [])
    } catch {
      // silent — the picker just shows empty state
    }
  }

  const routeTestOrder = async (order: any, labId: string, labName: string) => {
    setRoutingToLabId(labId)
    try {
      const res = await fetch(`${API_URL}/api/lab/orders/${order.id}/route`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ network_lab_id: labId }),
      })
      const data = await res.json()
      if (data.status !== 'success') throw new Error(data.message || 'Could not route to that lab')
      toast.success(`${order.test_type} routed to ${labName}`)
      setRoutingOrderId(null)
      fetchTestOrders()
    } catch (err: any) {
      toast.error(err.message || 'Could not route to that lab')
    } finally {
      setRoutingToLabId(null)
    }
  }

  useEffect(() => {
    ;(window as any).setAtlasPatient(id)
    // Paint the last known chart immediately (handed over by "Next patient" or a previous visit),
    // then refresh it quietly — the doctor should never wait on a blank chart.
    try {
      const cached = JSON.parse(sessionStorage.getItem(`vela_chart_${id}`) || 'null')
      if (cached?.patient) {
        setPatient(cached.patient)
        setDocuments(cached.documents || [])
        setMedications(cached.medications || [])
      }
    } catch { /* ignore a bad cache */ }
    const fetchData = async () => {
      if (!id) return
      try {
        const res = await fetch(`${API_URL}/api/patients/${id}`)
        const data = await res.json()
        if (res.ok && data.status === 'success') {
          setPatient(data.patient)
          setDocuments(data.documents || [])
          setMedications(data.medications || [])
          setNotes(data.notes || [])
          setReminders(data.reminders || [])
          try { sessionStorage.setItem(`vela_chart_${id}`, JSON.stringify({ patient: data.patient, documents: data.documents || [], medications: data.medications || [] })) } catch { /* storage full */ }
        }
      } catch {
        toast.error('Failed to load patient details')
      }
    }
    fetchData()
    fetchTestOrders()

    if (socket) {
      socket.on("timeline_updated", (data: SocketEventPayload) => {
        if (data.patient_id === id) {
          toast.success("Medical report pre-parsed & timeline updated!", { icon: '📊', duration: 5000 })
          fetchData()
        }
      })

      socket.on("queue_updated", (data: SocketEventPayload) => {
        if (data.patient_id === id) fetchTestOrders()
      })

      socket.on("test_ordered", (data: SocketEventPayload) => {
        if (data.patient_id === id) fetchTestOrders()
      })

      socket.on("draft_orders_populated", (data: SocketEventPayload) => {
        if (data.patient_id === id) {
          toast.success("✨ Clinical directives extracted by Atlas!", { duration: 5000 })
          setDraftOrders({
            prescriptions: data.prescriptions || [],
            lab_requisitions: data.lab_requisitions || [],
            follow_up_days: data.follow_up_days || null
          })
          setActiveTab("medications")
        }
      })
    }

    // Smart background pre-analysis of the next waiting patient in the doctor's queue (zero-latency AI handoff)
    const preAnalyzeNext = async () => {
      try {
        const doctorId = localStorage.getItem("vela_staff_id") || getUser()?.staff_id;
        if (!doctorId) return;
        fetch(`${API_URL}/api/doctor/pre-analyze-next`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ doctor_id: doctorId })
        }).catch(err => console.warn('Silent pre-analysis error:', err));
      } catch (err) {
        console.warn('Background pre-analysis skipped:', err);
      }
    };
    preAnalyzeNext();

    return () => {
      ;(window as any).setAtlasPatient(undefined)
      if (socket) {
        socket.off("timeline_updated")
        socket.off("draft_orders_populated")
        socket.off("queue_updated")
        socket.off("test_ordered")
      }
    }
  }, [id])

  // --- AMBIENT VOICE-TO-ORDER LOGIC ---
  const transcriptRef = useRef("")

  const startAmbientListening = () => {
    if (isAmbientListening) return
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SpeechRecognition) {
      toast.error("Chrome Speech Recognition is required for voice capture.")
      return
    }

    const rec = new SpeechRecognition()
    rec.lang = "en-US"
    rec.continuous = true
    rec.interimResults = true

    let finalTranscript = ""
    rec.onresult = (e: any) => {
      let interim = ""
      for (let i = e.resultIndex; i < e.results.length; ++i) {
        if (e.results[i].isFinal) {
          finalTranscript += e.results[i][0].transcript + " "
        } else {
          interim += e.results[i][0].transcript
        }
      }
      const fullText = finalTranscript + interim
      transcriptRef.current = fullText
      setAmbientTranscript(fullText)
    }

    rec.onerror = (e: any) => {
      console.error("Ambient SpeechRecognition error:", e.error)
      if (e.error !== "no-speech") {
        toast.error(`Ambient error: ${e.error}`)
        setIsAmbientListening(false)
      }
    }

    rec.onend = () => {
      setIsAmbientListening(false)
    }

    recognitionRef.current = rec
    rec.start()
    setIsAmbientListening(true)
    setAmbientTranscript("")
    transcriptRef.current = ""
    toast.success("🎙️ Ambient Scribe is listening...", { icon: "🎙️", duration: 3000 })
  }

  const stopAmbientListening = async () => {
    if (recognitionRef.current) {
      try {
        recognitionRef.current.stop()
      } catch (err) {
        console.warn("SpeechRecognition stop error:", err)
      }
    }
    setIsAmbientListening(false)
    
    const textToSend = transcriptRef.current.trim()
    if (!textToSend) {
      toast.error("No consultation dialogue captured.")
      return
    }
    
    const processToastId = toast.loading("Atlas is parsing natural dialogue...", {
      style: { fontFamily: 'var(--font-sans)', fontSize: "12px" }
    })
    
    try {
      const res = await fetch(`${API_URL}/api/doctor/ambient-consult/process`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patient_id: id,
          transcript_text: textToSend
        })
      })
      
      const data = await res.json()
      if (res.ok && data.status === "success") {
        toast.success("✨ Ambient orders populated above medications!", { id: processToastId, icon: "✨" })
        if (data.orders) {
          setDraftOrders({
            prescriptions: data.orders.prescriptions || [],
            lab_requisitions: data.orders.lab_requisitions || [],
            follow_up_days: data.orders.follow_up_days || null
          })
          setActiveTab("medications")
        }
      } else {
        toast.error(data.message || "Failed to parse conversation.", { id: processToastId })
      }
    } catch (err) {
      console.error("Failed to process ambient dialogue:", err)
      toast.error("Service is offline. Run FastAPI backend server.", { id: processToastId })
    }
  }

  const approveAmbientOrders = async () => {
    if (!draftOrders) return
    const signToastId = toast.loading("Signing and committing clinical orders...", {
      style: { fontFamily: 'var(--font-sans)', fontSize: "12px" }
    })
    try {
      const res = await fetch(`${API_URL}/api/doctor/ambient-consult/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patient_id: id,
          prescriptions: draftOrders.prescriptions,
          lab_requisitions: draftOrders.lab_requisitions,
          follow_up_days: draftOrders.follow_up_days,
          prescribed_by: getUser()?.name || "Dr. dr.himanshu"
        })
      })
      const data = await res.json()
      if (res.ok && data.status === 'success') {
        toast.success("✍️ Clinical orders approved and signed successfully!", { id: signToastId })
        setDraftOrders(null) // Clear drafts
        
        // Refresh local details to reflect new medications/reminders
        try {
          const reloadRes = await fetch(`${API_URL}/api/patients/${id}`)
          const reloadData = await reloadRes.json()
          if (reloadRes.ok && reloadData.status === 'success') {
            setPatient(reloadData.patient)
            setDocuments(reloadData.documents || [])
            setMedications(reloadData.medications || [])
            setNotes(reloadData.notes || [])
            setReminders(reloadData.reminders || [])
          }
        } catch (reloadErr) {
          console.warn("Failed to reload data after signing:", reloadErr)
        }
      } else {
        toast.error(data.message || "Failed to sign clinical orders.", { id: signToastId })
      }
    } catch (err) {
      console.error(err)
      toast.error("Network error while signing orders.", { id: signToastId })
    }
  }

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName.toLowerCase()
      const isInput = tag === "input" ||
        tag === "textarea" ||
        tag === "select" ||
        (e.target as HTMLElement).isContentEditable
      
      if (e.code === "Space" && !isInput && !isAmbientListening) {
        e.preventDefault()
        e.stopPropagation()
        startAmbientListening()
      }
    }

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space" && isAmbientListening) {
        e.preventDefault()
        e.stopPropagation()
        stopAmbientListening()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    window.addEventListener("keyup", handleKeyUp)
    
    return () => {
      window.removeEventListener("keydown", handleKeyDown)
      window.removeEventListener("keyup", handleKeyUp)
    }
  }, [isAmbientListening])

  const markReminderDone = async (reminderId: string) => {
    try {
      await fetch(`${API_URL}/api/reminders/${reminderId}/done`, { method: 'PUT' })
      setReminders((prev) => prev.map((r) => (r.id === reminderId ? { ...r, is_done: true } : r)))
    } catch {
      toast.error('Could not mark reminder done')
    }
  }

  const addNote = async () => {
    if (!newNote.trim() || !id) return
    try {
      const res = await fetch(`${API_URL}/api/notes/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_id: id, content: newNote, created_by: getUser()?.name || 'Unknown' })
      })
      const data = await res.json()
      if (res.ok && data.status === 'success') {
        setNotes((prev) => [data.note, ...prev])
        setNewNote('')
      }
    } catch {
      toast.error('Could not add note')
    }
  }

  const addReminder = async () => {
    if (!newReminder.trim() || !newReminderDue || !id) return
    try {
      const res = await fetch(`${API_URL}/api/reminders/add`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patient_id: id, message: newReminder, due_time: newReminderDue, is_done: false })
      })
      const data = await res.json()
      if (res.ok && data.status === 'success') {
        setReminders((prev) => [data.reminder, ...prev])
        setNewReminder('')
        setNewReminderDue('')
      }
    } catch {
      toast.error('Could not add reminder')
    }
  }

  const uploadDocuments = async (files: File[]) => {
    if (!id || files.length === 0) return
    setUploadStatus('Uploading')
    writeToConsole(`Starting parallel ingestion of ${files.length} document(s)...`)

    try {
      await Promise.all(
        files.map(async (file) => {
          const formData = new FormData()
          formData.append('patient_id', id)
          formData.append('file', file)

          try {
            const res = await fetch(`${API_URL}/api/upload/document`, { method: 'POST', body: formData })
            const data = await res.json()
            if (res.ok && data.status === 'success') {
              // Immediately insert the skeleton card in local documents state list!
              // The skeleton document has summary = "processing" and is returned in data.document!
              setDocuments((prev) => [data.document, ...prev])
              writeToConsole(`Ingestion spawned for: ${file.name}`)
            } else {
              toast.error(`Upload failed: ${file.name}`)
            }
          } catch (err) {
            toast.error(`Upload failed: ${file.name}`)
          }
        })
      )
      setUploadStatus('Done')
    } catch {
      setUploadStatus('Failed')
    }
  }

  const handleDeleteDocument = async (docId: string) => {
    if (!window.confirm('Are you sure you want to delete this document? This will remove all associated lab records and history.')) {
      return
    }
    try {
      const res = await fetch(`${API_URL}/api/upload/document/${docId}`, {
        method: 'DELETE'
      })
      const data = await res.json()
      if (res.ok && data.status === 'success') {
        // Filter out the deleted document from the local state list
        setDocuments((prev) => prev.filter((d) => d.id !== docId))
        toast.success('Document deleted successfully')
        writeToConsole('Document deleted')
      } else {
        toast.error(data.message || 'Could not delete document')
      }
    } catch {
      toast.error('Could not delete document')
    }
  }

  const completeConsultation = async () => {
    if (!id) return
    try {
      const res = await fetch(`${API_URL}/api/patients/${id}/complete-consult`, {
        method: 'POST',
      })
      const data = await res.json()
      if (!res.ok || data.status !== 'success') {
        throw new Error(data.message || 'Failed to complete consultation')
      }
      toast.success('Consultation completed successfully')
      navigate('/dashboard')
    } catch (err: any) {
      toast.error(err.message || 'Error completing consultation')
    }
  }

  const writeToConsole = (msg: string) => {
    console.log(msg)
  }

  if (!patient) {
    return (
      <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-color)', color: 'var(--text-primary)', overflow: 'hidden' }}>
        <style>{`
          @keyframes shimmer {
            0% { background-position: -200% 0; }
            100% { background-position: 200% 0; }
          }
          .skeleton-pulse {
            background: linear-gradient(90deg, rgba(255,255,255,0.02) 25%, rgba(255,255,255,0.06) 50%, rgba(255,255,255,0.02) 75%);
            background-size: 200% 100%;
            animation: shimmer 1.8s infinite linear;
            border-radius: 4px;
          }
          .skeleton-circle {
            background: linear-gradient(90deg, rgba(255,255,255,0.02) 25%, rgba(255,255,255,0.06) 50%, rgba(255,255,255,0.02) 75%);
            background-size: 200% 100%;
            animation: shimmer 1.8s infinite linear;
            border-radius: 50%;
          }
        `}</style>
        <DoctorSidebar onExpandChange={setSidebarExpanded} />
        <main style={{ 
          flex: 1, 
          marginLeft: sidebarExpanded ? '280px' : '80px', 
          transition: 'margin-left 0.4s cubic-bezier(0.16, 1, 0.3, 1)', 
          padding: '48px',
          position: 'relative'
        }}>
          {/* Back Navigation Skeleton */}
          <div className="skeleton-pulse" style={{ width: 140, height: 14, marginBottom: 32 }} />

          {/* Patient Header Card Skeleton */}
          <div style={{ 
            background: 'var(--surface-color)', 
            border: '1px solid var(--border-color)', 
            borderRadius: 8, 
            padding: 32, 
            marginBottom: 32, 
            display: 'flex', 
            alignItems: 'flex-start', 
            justifyContent: 'space-between'
          }}>
            <div style={{ display: 'flex', gap: 32, width: '70%' }}>
              <div className="skeleton-circle" style={{ width: 96, height: 96, flexShrink: 0 }} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
                <div className="skeleton-pulse" style={{ width: '45%', height: 36, borderRadius: 6 }} />
                <div className="skeleton-pulse" style={{ width: '30%', height: 16, borderRadius: 4 }} />
                <div style={{ display: 'flex', gap: 24, marginTop: 8 }}>
                  <div className="skeleton-pulse" style={{ width: 70, height: 20 }} />
                  <div className="skeleton-pulse" style={{ width: 70, height: 20 }} />
                  <div className="skeleton-pulse" style={{ width: 90, height: 20 }} />
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
              <div className="skeleton-pulse" style={{ width: 80, height: 64, borderRadius: 6 }} />
              <div className="skeleton-pulse" style={{ width: 110, height: 12 }} />
            </div>
          </div>

          {/* Custom Tabs Skeleton */}
          <div style={{ display: 'flex', borderBottom: '1px solid var(--border-color)', marginBottom: 32, gap: 16 }}>
            <div className="skeleton-pulse" style={{ width: 100, height: 38, borderRadius: '4px 4px 0 0' }} />
            <div className="skeleton-pulse" style={{ width: 100, height: 38, borderRadius: '4px 4px 0 0' }} />
            <div className="skeleton-pulse" style={{ width: 120, height: 38, borderRadius: '4px 4px 0 0' }} />
            <div className="skeleton-pulse" style={{ width: 90, height: 38, borderRadius: '4px 4px 0 0' }} />
          </div>

          {/* Main Grid Skeleton */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 32 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
              {/* Summary panel mock */}
              <div style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 32, display: 'flex', flexDirection: 'column', gap: 20 }}>
                <div className="skeleton-pulse" style={{ width: '25%', height: 22, borderRadius: 4 }} />
                <div className="skeleton-pulse" style={{ width: '100%', height: 96, borderRadius: 6 }} />
                <div className="skeleton-pulse" style={{ width: '85%', height: 16 }} />
                <div className="skeleton-pulse" style={{ width: '65%', height: 16 }} />
              </div>
              {/* Chart mock */}
              <div style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 32, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div className="skeleton-pulse" style={{ width: '30%', height: 20 }} />
                <div className="skeleton-pulse" style={{ width: '100%', height: 260, borderRadius: 6 }} />
              </div>
            </div>
            
            <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
              {/* Right side cards */}
              <div style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div className="skeleton-pulse" style={{ width: '50%', height: 20 }} />
                <div className="skeleton-pulse" style={{ width: '100%', height: 80, borderRadius: 6 }} />
                <div className="skeleton-pulse" style={{ width: '100%', height: 80, borderRadius: 6 }} />
              </div>
              <div style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div className="skeleton-pulse" style={{ width: '40%', height: 20 }} />
                <div className="skeleton-pulse" style={{ width: '100%', height: 48, borderRadius: 6 }} />
                <div className="skeleton-pulse" style={{ width: '100%', height: 48, borderRadius: 6 }} />
              </div>
            </div>
          </div>
        </main>
      </div>
    )
  }

  const riskColor = patient.risk_score <= 40 ? 'var(--success-color)' : patient.risk_score <= 70 ? 'var(--warning-color)' : 'var(--error-color)'

  return (
    <div className="page-fade-in" style={{ display: 'flex', minHeight: '100vh', background: 'var(--bg-color)', color: 'var(--text-primary)' }}>
      <style>{`
        @keyframes pageFadeIn {
          from { opacity: 0; transform: translateY(6px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .page-fade-in {
          animation: pageFadeIn 0.5s cubic-bezier(0.16, 1, 0.3, 1) forwards;
        }
      `}</style>
      <DoctorSidebar onExpandChange={setSidebarExpanded} />
      
      <main style={{ 
        flex: 1, 
        marginLeft: sidebarExpanded ? '280px' : '80px', 
        transition: 'margin-left 0.4s cubic-bezier(0.16, 1, 0.3, 1)', 
        padding: '48px',
        position: 'relative'
      }}>

        {/* Back Navigation */}
        <button 
          onClick={() => navigate('/dashboard')}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-secondary)',
            fontFamily: 'var(--font-sans)',
            fontSize: 12,
            cursor: 'pointer',
            padding: 0,
            marginBottom: 32,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            textTransform: 'uppercase',
            letterSpacing: '0.05em'
          }}
        >
          ← Back to Dashboard
        </button>

        {/* Patient Header — editorial masthead. The name is the largest thing
            on screen, the risk score is the second; everything else is a
            hairline-separated fact row. */}
        <div className="pb-10 mb-10" style={{ borderBottom: '1px solid var(--text)' }}>
          <div className="flex flex-wrap items-start justify-between gap-8">
            <div className="min-w-0">
              <div className="label-mono mb-4">
                {patient.vela_id} · {patient.ward} · {patient.room}
              </div>
              <h1 className="display text-[52px] md:text-[72px] leading-[0.98] m-0" style={{ color: 'var(--text)' }}>
                {patient.name}
              </h1>
            </div>

            <div className="text-right shrink-0">
              <div className="display text-[76px] leading-none" style={{ color: riskColor }}>
                {patient.risk_score}
              </div>
              <div className="label-mono mt-1">Vela risk score</div>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-8 gap-y-5 mt-10 pt-8" style={{ borderTop: '1px solid var(--border)' }}>
            {[
              ['Age / Sex', `${patient.age} · ${patient.gender}`],
              ['Blood group', patient.blood_group || '—'],
              ['Attending', patient.doctor || '—'],
              ['Allergies', patient.allergies || 'None'],
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

        <style>{`
          @keyframes pulse {
            0% { transform: scale(0.85); opacity: 0.5; }
            100% { transform: scale(1.2); opacity: 1; }
          }
        `}</style>

        {/* ✨ Atlas Ambient Voice-to-Order Scribe Widget */}
        <div style={{
          background: isAmbientListening 
            ? 'linear-gradient(135deg, rgba(245, 158, 11, 0.06) 0%, rgba(239, 68, 68, 0.03) 100%)' 
            : 'var(--surface-color)',
          border: isAmbientListening
            ? '1px dashed rgba(245, 158, 11, 0.4)'
            : '1px solid var(--border-color)',
          borderRadius: 12,
          padding: '16px 20px',
          marginBottom: 32,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          transition: 'all 0.3s ease',
          boxShadow: isAmbientListening ? '0 0 20px rgba(245, 158, 11, 0.1)' : 'none'
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: isAmbientListening ? 'var(--warning)' : 'var(--text-tertiary)',
                animation: isAmbientListening ? 'pulse 1.5s infinite alternate' : 'none',
                boxShadow: isAmbientListening ? '0 0 8px var(--warning)' : 'none'
              }} />
              <div>
                <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                  {isAmbientListening ? '🔴 Ambient Scribe Active' : '✨ Ambient Voice-to-Order'}
                </div>
                <div style={{ fontSize: 12, color: 'var(--text-tertiary)', marginTop: 2 }}>
                  {isAmbientListening 
                    ? 'Atlas is listening to patient-doctor dialogue...' 
                    : 'Conduct a natural consultation. Hold [Spacebar] to listen, release to generate structured orders.'}
                </div>
              </div>
            </div>
            
            <button
              onClick={isAmbientListening ? stopAmbientListening : startAmbientListening}
              style={{
                background: isAmbientListening ? 'rgba(239, 68, 68, 0.15)' : 'rgba(245, 158, 11, 0.1)',
                border: isAmbientListening ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid rgba(245, 158, 11, 0.3)',
                color: isAmbientListening ? 'var(--danger)' : 'var(--warning)',
                borderRadius: 8,
                padding: '8px 16px',
                fontFamily: 'var(--font-sans)',
                fontWeight: 600,
                fontSize: 13,
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                transition: 'all 0.2s ease'
              }}
            >
              {isAmbientListening ? (
                <>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: 'var(--danger)', display: 'inline-block' }} />
                  Stop & Extract Orders
                </>
              ) : (
                <>
                  🎙️ Start Ambient Consultation
                </>
              )}
            </button>
          </div>

          {ambientTranscript && (
            <div style={{
              background: 'rgba(0, 0, 0, 0.12)',
              border: '1px solid var(--border-color)',
              borderRadius: 8,
              padding: '12px 16px',
              maxHeight: 100,
              overflowY: 'auto'
            }}>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--warning)', marginBottom: 4, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                🎙️ Live Consultation Dialogue Feed:
              </div>
              <p style={{ margin: 0, fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, fontStyle: 'italic' }}>
                "{ambientTranscript}"
              </p>
            </div>
          )}
        </div>

        {/* Tabs — numbered index rather than chips, matching the workspace
            list on sign-in. The active tab is marked by a solid rule. */}
        <div className="flex flex-wrap gap-x-10 gap-y-2 mb-12" style={{ borderBottom: '1px solid var(--border)' }}>
          {['summary', 'labs', 'history', 'reports', 'imaging', 'medications', 'notes'].map((tab, i) => {
            const isActive = activeTab === tab
            return (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab as any)}
                className="group bg-transparent border-none cursor-pointer px-0 pt-2 pb-4 flex items-baseline gap-2.5 transition-opacity duration-300"
                style={{
                  opacity: isActive ? 1 : 0.45,
                  boxShadow: isActive ? 'inset 0 -1px 0 0 var(--text)' : 'none',
                }}
              >
                <span className="label-mono" style={{ fontSize: 9, color: isActive ? 'var(--brand)' : 'var(--text-tertiary)' }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
                <span
                  className="text-[15px] capitalize"
                  style={{ color: isActive ? 'var(--text)' : 'var(--text-secondary)' }}
                >
                  {tab}
                </span>
              </button>
            )
          })}
        </div>

        {/* Tab Content */}
        <div style={{ minHeight: 400 }}>
          {activeTab === 'summary' && (() => {
            // Aggregate all critical flags across patient documents
            const allCriticalFlags = documents.reduce<Array<{ flag: string; date: string; file: string }>>((acc, doc) => {
              if (doc.critical_flags && Array.isArray(doc.critical_flags)) {
                doc.critical_flags.forEach(f => acc.push({ flag: f, date: doc.report_date, file: doc.filename }));
              }
              return acc;
            }, []);

            // Aggregate all abnormal values across patient documents
            const abnormalValues = documents.reduce<Array<{ test: string; result: string; unit: string; status: string; reference: string; date: string; file: string }>>((acc, doc) => {
              if (doc.values && Array.isArray(doc.values)) {
                doc.values.forEach(v => {
                  if (v.status && (v.status.toLowerCase() === 'high' || v.status.toLowerCase() === 'low' || v.status.toLowerCase() === 'abnormal')) {
                    acc.push({ ...v, date: doc.report_date, file: doc.filename });
                  }
                });
              }
              return acc;
            }, []);

            return (
              <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 0.8fr', gap: 32 }}>
                
                {/* LEFT: AI Handoff & Abnormalities */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
                  
                  {/* AI Prognosis Quote Card */}
                  <div style={{
                    background: 'linear-gradient(135deg, rgba(37, 99, 235, 0.08) 0%, rgba(99, 102, 241, 0.04) 100%)',
                    border: '1px solid rgba(37, 99, 235, 0.15)',
                    borderRadius: 8,
                    padding: 28,
                    position: 'relative',
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      position: 'absolute',
                      right: 16,
                      top: 16,
                      fontSize: 10,
                      fontFamily: 'var(--font-sans)',
                      color: 'var(--primary-color)',
                      fontWeight: 600,
                      background: 'rgba(37, 99, 235, 0.1)',
                      padding: '4px 10px',
                      borderRadius: 100
                    }}>
                      ATLAS INTEL
                    </div>
                    
                    <h4 style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: 26,
                      margin: '0 0 16px 0',
                      fontWeight: 400,
                      color: 'var(--text-primary)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8
                    }}>
                      ✨ Clinical Prognosis & Trend
                    </h4>
                    
                    <p style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: 15,
                      lineHeight: 1.6,
                      color: 'var(--text-secondary)',
                      margin: 0,
                      fontStyle: 'italic'
                    }}>
                      "{patient.atlas_analysis || "No automatic health trend summary generated yet. Ask Atlas to analyze their case history or upload new reports to activate clinical handoff analysis."}"
                    </p>
                    
                    {patient.atlas_confidence && (
                      <div style={{
                        marginTop: 16,
                        fontSize: 12,
                        fontFamily: 'var(--font-sans)',
                        color: 'var(--text-tertiary)'
                      }}>
                        AI Confidence Rating: <span style={{ color: 'var(--success-color)', fontWeight: 600 }}>{patient.atlas_confidence}</span>
                      </div>
                    )}
                  </div>

                  {/* Critical Flags Warning Banner */}
                  {allCriticalFlags.length > 0 && (() => {
                    // Sort: critical/urgent/worsening flags rise to the top
                    const PRIORITY_KEYWORDS = ['critical', 'critically', 'urgent', 'worsening', 'severe', 'high risk', 'danger', 'elevated'];
                    const sortedFlags = [...allCriticalFlags].sort((a, b) => {
                      const aScore = PRIORITY_KEYWORDS.some(kw => a.flag.toLowerCase().includes(kw)) ? 1 : 0;
                      const bScore = PRIORITY_KEYWORDS.some(kw => b.flag.toLowerCase().includes(kw)) ? 1 : 0;
                      return bScore - aScore;
                    });
                    const COLLAPSED_LIMIT = 3;
                    const visibleFlags = isAnomaliesExpanded ? sortedFlags : sortedFlags.slice(0, COLLAPSED_LIMIT);
                    const hiddenCount = sortedFlags.length - COLLAPSED_LIMIT;

                    return (
                      <div style={{
                        background: 'rgba(239, 68, 68, 0.06)',
                        border: '1px solid rgba(239, 68, 68, 0.2)',
                        borderRadius: 8,
                        padding: 24
                      }}>
                        <div style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          color: 'var(--error-color)',
                          fontFamily: 'var(--font-sans)',
                          fontSize: 12,
                          fontWeight: 600,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                          marginBottom: 16
                        }}>
                          <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: 'var(--error-color)', animation: 'pulse 1.5s infinite' }} />
                          AI Flagged Priority Anomalies ({allCriticalFlags.length})
                        </div>

                        {/* Truncated card grid */}
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {visibleFlags.map((item, idx) => {
                            const isPriority = PRIORITY_KEYWORDS.some(kw => item.flag.toLowerCase().includes(kw));
                            return (
                              <div key={idx} style={{
                                background: isPriority ? 'rgba(239, 68, 68, 0.15)' : 'rgba(239, 68, 68, 0.08)',
                                border: `1px solid ${isPriority ? 'rgba(239, 68, 68, 0.35)' : 'rgba(239, 68, 68, 0.15)'}`,
                                borderRadius: 6,
                                padding: '10px 16px',
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 2,
                                position: 'relative',
                                transition: 'border-color 0.2s'
                              }}>
                                {isPriority && (
                                  <span style={{
                                    position: 'absolute',
                                    top: -1,
                                    right: 8,
                                    background: 'rgba(239, 68, 68, 0.9)',
                                    color: '#fff',
                                    fontFamily: 'var(--font-sans)',
                                    fontSize: 8,
                                    fontWeight: 700,
                                    letterSpacing: '0.12em',
                                    padding: '2px 6px',
                                    borderRadius: '0 0 4px 4px',
                                    textTransform: 'uppercase'
                                  }}>PRIORITY</span>
                                )}
                                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', paddingTop: isPriority ? 6 : 0 }}>
                                  {item.flag}
                                </span>
                                <span style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-tertiary)' }}>
                                  Detected in {item.file} ({new Date(item.date).toLocaleDateString()})
                                </span>
                              </div>
                            );
                          })}
                        </div>

                        {/* Glassmorphic expand / collapse toggle — only shown when there are more than 3 */}
                        {sortedFlags.length > COLLAPSED_LIMIT && (
                          <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
                            <button
                              onClick={() => setIsAnomaliesExpanded(prev => !prev)}
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                background: 'rgba(255,255,255,0.04)',
                                border: '1px solid rgba(239, 68, 68, 0.22)',
                                borderRadius: 20,
                                padding: '7px 18px',
                                color: 'rgba(239, 68, 68, 0.85)',
                                fontFamily: 'var(--font-sans)',
                                fontSize: 11,
                                fontWeight: 600,
                                letterSpacing: '0.08em',
                                textTransform: 'uppercase',
                                cursor: 'pointer',
                                backdropFilter: 'blur(8px)',
                                WebkitBackdropFilter: 'blur(8px)',
                                transition: 'background 0.2s, border-color 0.2s, color 0.2s',
                                outline: 'none'
                              }}
                              onMouseEnter={e => {
                                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(239,68,68,0.1)';
                                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(239,68,68,0.4)';
                              }}
                              onMouseLeave={e => {
                                (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.04)';
                                (e.currentTarget as HTMLButtonElement).style.borderColor = 'rgba(239,68,68,0.22)';
                              }}
                            >
                              {isAnomaliesExpanded ? (
                                <><ChevronUp size={13} strokeWidth={2.5} /> Collapse View</>
                              ) : (
                                <><ChevronDown size={13} strokeWidth={2.5} /> View All Anomalies (+{hiddenCount})</>
                              )}
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Interactive Laboratory Trends Chart */}
                  {(() => {
                    const labHistory = documents.reduce<Record<string, Array<{ date: string; value: number; unit: string; status: string }>>>((acc, doc) => {
                      if (doc.values && Array.isArray(doc.values)) {
                        doc.values.forEach(v => {
                          const numVal = parseFloat(v.result);
                          if (!isNaN(numVal) && v.test) {
                            const testName = v.test.trim();
                            if (!acc[testName]) {
                              acc[testName] = [];
                            }
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

                    // Sort dates chronologically for each lab metric
                    Object.keys(labHistory).forEach(testName => {
                      labHistory[testName].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
                    });

                    const availableTests = Object.keys(labHistory);
                    const chartData = selectedChartTest ? labHistory[selectedChartTest] || [] : [];
                    const unit = chartData[0]?.unit || '';

                    if (availableTests.length === 0) return null;

                    return (
                      <div style={{
                        background: 'var(--surface-color)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 8,
                        padding: 28,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 20
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 12 }}>
                          <div>
                            <h4 style={{
                              fontFamily: 'var(--font-sans)',
                              fontSize: 26,
                              margin: '0 0 4px 0',
                              fontWeight: 400,
                              color: 'var(--text-primary)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8
                            }}>
                              <TrendingUp size={22} style={{ color: 'var(--primary-color)' }} />
                              Vela Clinical Lab Trends
                            </h4>
                            <p style={{
                              fontFamily: 'var(--font-sans)',
                              fontSize: 13,
                              color: 'var(--text-secondary)',
                              margin: 0
                            }}>
                              Interactive chronological tracking of extracted diagnostic markers.
                            </p>
                          </div>
                          
                          {/* Selector Dropdown */}
                          <select
                            value={selectedChartTest}
                            onChange={(e) => setSelectedChartTest(e.target.value)}
                            style={{
                              background: 'var(--bg-color)',
                              border: '1px solid var(--border-color)',
                              color: 'var(--text-primary)',
                              fontFamily: 'var(--font-sans)',
                              fontSize: 12,
                              padding: '8px 12px',
                              borderRadius: 6,
                              cursor: 'pointer',
                              outline: 'none'
                            }}
                          >
                            {availableTests.map((t) => (
                              <option key={t} value={t}>{t}</option>
                            ))}
                          </select>
                        </div>

                        {chartData.length > 0 ? (
                          <div style={{ width: '100%', height: 260 }}>
                            <ResponsiveContainer width="100%" height="100%">
                              <LineChart data={chartData} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                                <XAxis 
                                  dataKey="date" 
                                  stroke="var(--text-tertiary)" 
                                  tick={{ fontFamily: 'var(--font-sans)', fontSize: 10 }}
                                />
                                <YAxis 
                                  stroke="var(--text-tertiary)"
                                  tick={{ fontFamily: 'var(--font-sans)', fontSize: 10 }}
                                  unit={unit ? ` ${unit}` : ''}
                                />
                                <ChartTooltip
                                  contentStyle={{
                                    background: 'var(--surface-color)',
                                    border: '1px solid var(--border-color)',
                                    borderRadius: 8,
                                    fontFamily: 'var(--font-sans)',
                                    fontSize: 12,
                                    color: 'var(--text-primary)'
                                  }}
                                />
                                <Line 
                                  type="monotone" 
                                  dataKey="value" 
                                  stroke="var(--primary-color)" 
                                  strokeWidth={2}
                                  dot={{ fill: 'var(--primary-color)', strokeWidth: 2, r: 4 }}
                                  activeDot={{ r: 6, strokeWidth: 0 }}
                                  name={selectedChartTest}
                                />
                              </LineChart>
                            </ResponsiveContainer>
                          </div>
                        ) : (
                          <div style={{
                            height: 260,
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontFamily: 'var(--font-sans)',
                            color: 'var(--text-tertiary)',
                            border: '1px dashed var(--border-color)',
                            borderRadius: 6
                          }}>
                            Select a test from the dropdown to visualize historical trends.
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Latest Report Vitals & Values */}
                  <div style={{
                    background: 'var(--surface-color)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 8,
                    padding: 28
                  }}>
                    <h4 style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: 26,
                      margin: '0 0 8px 0',
                      fontWeight: 400,
                      color: 'var(--text-primary)'
                    }}>
                      🩸 Extracted Report Anomalies
                    </h4>
                    <p style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: 14,
                      color: 'var(--text-secondary)',
                      margin: '0 0 24px 0'
                    }}>
                      Showing vital metrics and lab values flagged as abnormal from verified diagnostic reports.
                    </p>

                    {abnormalValues.length === 0 ? (
                      <div style={{
                        padding: 32,
                        textAlign: 'center',
                        fontFamily: 'var(--font-sans)',
                        fontSize: 14,
                        color: 'var(--text-tertiary)',
                        border: '1px dashed var(--border-color)',
                        borderRadius: 6
                      }}>
                        No abnormal clinical vital measurements extracted from verified reports.
                      </div>
                    ) : (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                        <div style={{
                          display: 'grid',
                          gridTemplateColumns: '1.2fr 0.8fr 0.6fr 0.8fr 1.25fr',
                          gap: 12,
                          borderBottom: '1px solid var(--border-color)',
                          paddingBottom: 8,
                          fontFamily: 'var(--font-sans)',
                          fontSize: 11,
                          color: 'var(--text-tertiary)'
                        }}>
                          <div>TEST</div>
                          <div>RESULT</div>
                          <div>STATUS</div>
                          <div>REFERENCE</div>
                          <div>SOURCE & DATE</div>
                        </div>

                        {abnormalValues.map((v, i) => (
                          <div key={i} style={{
                            display: 'grid',
                            gridTemplateColumns: '1.2fr 0.8fr 0.6fr 0.8fr 1.25fr',
                            gap: 12,
                            padding: '12px 0',
                            borderBottom: '1px solid rgba(0,0,0,0.03)',
                            fontFamily: 'var(--font-sans)',
                            fontSize: 13,
                            alignItems: 'center'
                          }}>
                            <div style={{ fontWeight: 600, fontFamily: 'var(--font-sans)' }}>{v.test}</div>
                            <div>{v.result} <span style={{ color: 'var(--text-tertiary)', fontSize: 11 }}>{v.unit}</span></div>
                            <div>
                              <span style={{
                                color: 'white',
                                background: v.status.toLowerCase() === 'high' ? 'var(--error-color)' : 'var(--warning-color)',
                                fontSize: 10,
                                fontWeight: 700,
                                padding: '2px 6px',
                                borderRadius: 4,
                                textTransform: 'uppercase'
                              }}>
                                {v.status}
                              </span>
                            </div>
                            <div style={{ color: 'var(--text-tertiary)' }}>{v.reference}</div>
                            <div style={{
                              color: 'var(--text-secondary)',
                              fontSize: 11,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap'
                            }} title={`${v.file} - ${new Date(v.date).toLocaleDateString()}`}>
                              {new Date(v.date).toLocaleDateString()} • {v.file}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* RIGHT: Reminders & Discharge Actions */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
                  
                  {/* Action Panel */}
                  <section style={{
                    background: 'var(--surface-color)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 8,
                    padding: 28
                  }}>
                    <h3 style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: 24,
                      fontWeight: 400,
                      margin: '0 0 24px 0',
                      color: 'var(--text-primary)'
                    }}>Consultation Room Actions</h3>
                    
                    <button
                      onClick={completeConsultation}
                      style={{
                        width: '100%',
                        background: 'var(--success-color)',
                        color: 'var(--bg-color)',
                        padding: '16px',
                        border: 'none',
                        borderRadius: 6,
                        fontFamily: 'var(--font-sans)',
                        fontSize: 14,
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        cursor: 'pointer',
                        transition: 'all 0.2s ease',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 12
                      }}
                      onMouseEnter={e => (e.currentTarget.style.opacity = '0.9')}
                      onMouseLeave={e => (e.currentTarget.style.opacity = '1')}
                    >
                      ✓ Complete & Discharge Patient
                    </button>
                    
                    <div style={{
                      marginTop: 20,
                      background: 'rgba(37, 99, 235, 0.05)',
                      border: '1px dashed rgba(37, 99, 235, 0.2)',
                      borderRadius: 6,
                      padding: 16,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6
                    }}>
                      <span style={{ fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600, color: 'var(--primary-color)' }}>
                        🎙️ VOICE ASSISTANT ENABLED
                      </span>
                      <p style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text-secondary)', margin: 0, lineHeight: 1.4 }}>
                        Hold <strong>SPACEBAR</strong> to speak to Atlas. You can ask directly: <em>"Hey Atlas, what are their anomalies?"</em> or <em>"Explain the hemoglobin value."</em> without mentioning the patient's name.
                      </p>
                    </div>
                  </section>

                  {/* Clinical Reminders */}
                  <section style={{
                    background: 'var(--surface-color)',
                    border: '1px solid var(--border-color)',
                    borderRadius: 8,
                    padding: 28
                  }}>
                    <h3 style={{
                      fontFamily: 'var(--font-sans)',
                      fontSize: 24,
                      fontWeight: 400,
                      margin: '0 0 24px 0',
                      color: 'var(--text-primary)'
                    }}>Clinical Reminders</h3>
                    
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      {reminders.map((r, idx) => (
                        <div key={r.id || `reminder-${idx}`} style={{
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: 12,
                          padding: 12,
                          borderRadius: 6,
                          background: r.is_done ? 'rgba(0,0,0,0.03)' : 'var(--bg-color)',
                          border: '1px solid var(--border-color)',
                          opacity: r.is_done ? 0.6 : 1
                        }}>
                          <input
                            type="checkbox"
                            checked={r.is_done}
                            onChange={() => markReminderDone(r.id)}
                            style={{ marginTop: 4, cursor: 'pointer' }}
                          />
                          <div style={{ flex: 1 }}>
                            <div style={{
                              textDecoration: r.is_done ? 'line-through' : 'none',
                              fontFamily: 'var(--font-sans)',
                              color: 'var(--text-primary)',
                              fontSize: 14
                            }}>
                              {r.message}
                            </div>
                            <div style={{
                              fontFamily: 'var(--font-sans)',
                              fontSize: 11,
                              color: 'var(--text-tertiary)',
                              marginTop: 4
                            }}>
                              Due: {new Date(r.due_time).toLocaleString()}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div style={{ marginTop: 24, paddingTop: 24, borderTop: '1px dashed var(--border-color)' }}>
                      <input
                        value={newReminder}
                        onChange={(e) => setNewReminder(e.target.value)}
                        placeholder="New reminder..."
                        style={{
                          width: '100%',
                          padding: 12,
                          background: 'var(--bg-color)',
                          border: '1px solid var(--border-color)',
                          borderRadius: 4,
                          marginBottom: 8,
                          fontFamily: 'var(--font-sans)'
                        }}
                      />
                      <div style={{ display: 'flex', gap: 8 }}>
                        <input
                          type="datetime-local"
                          value={newReminderDue}
                          onChange={(e) => setNewReminderDue(e.target.value)}
                          style={{
                            flex: 1,
                            padding: 12,
                            background: 'var(--bg-color)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 4,
                            fontFamily: 'var(--font-sans)',
                            fontSize: 12
                          }}
                        />
                        <button
                          onClick={addReminder}
                          style={{
                            background: 'var(--primary-color)',
                            color: 'var(--bg-color)',
                            padding: '0 20px',
                            border: 'none',
                            borderRadius: 4,
                            fontFamily: 'var(--font-sans)',
                            cursor: 'pointer'
                          }}
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  </section>

                </div>

              </div>
            );
          })()}

          {activeTab === 'labs' && (
            <section style={{
              background: 'var(--surface-color)',
              border: '1px solid var(--border-color)',
              borderRadius: 8,
              padding: 32
            }}>
              <div className="label-mono" style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 20 }}>
                Lab tests ordered
              </div>
              {testOrders.length === 0 ? (
                <p style={{ fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                  No tests ordered for this patient yet.
                </p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  {testOrders.map((order: any) => {
                    const statusColor =
                      order.status === 'cancelled' ? 'var(--text-tertiary)' :
                      order.status === 'completed' ? 'var(--success)' :
                      ['accepted', 'in_progress', 'payment_confirmed'].includes(order.status) ? 'var(--brand)' :
                      'var(--warning)'
                    const canCancel = order.payment_status === 'pending' && order.status !== 'cancelled'
                    const isRoutingHere = routingOrderId === order.id
                    return (
                      <div key={order.id} style={{
                        border: '1px solid var(--border-color)',
                        borderRadius: 8,
                        padding: '14px 18px',
                      }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
                          <div>
                            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 15, color: 'var(--text)' }}>
                              {order.test_type}
                            </div>
                            <div style={{ display: 'flex', gap: 10, marginTop: 4, flexWrap: 'wrap' }}>
                              {order.department && (
                                <span className="label-mono" style={{ fontSize: 9, color: 'var(--text-tertiary)' }}>
                                  {order.department} lab
                                </span>
                              )}
                              {order.fulfilled_by === 'network_lab' && (
                                <span className="label-mono" style={{ fontSize: 9, color: 'var(--accent)' }}>
                                  Independent lab
                                </span>
                              )}
                              {order.doctor_name && (
                                <span className="label-mono" style={{ fontSize: 9, color: 'var(--brand)' }}>
                                  DR. {order.doctor_name.toUpperCase()}
                                </span>
                              )}
                              <span className="label-mono" style={{ fontSize: 9, color: statusColor }}>
                                {(order.status || 'pending').replace('_', ' ').toUpperCase()}
                              </span>
                            </div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 18, fontWeight: 600, color: 'var(--text)' }}>
                              ₹{Number(order.price ?? order.payment_amount ?? 0)}
                            </div>
                            {canCancel && (
                              <button
                                type="button"
                                onClick={() => setRoutingOrderId(isRoutingHere ? null : order.id)}
                                style={{
                                  fontFamily: 'var(--font-sans)',
                                  fontSize: 9,
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.15em',
                                  color: 'var(--brand)',
                                  background: 'transparent',
                                  border: '1px solid var(--brand)',
                                  borderRadius: 6,
                                  padding: '8px 12px',
                                  cursor: 'pointer',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {isRoutingHere ? 'Close' : 'Find a lab'}
                              </button>
                            )}
                            {canCancel && (
                              <button
                                type="button"
                                onClick={() => cancelTestOrder(order)}
                                disabled={cancellingTestOrderId === order.id}
                                style={{
                                  fontFamily: 'var(--font-sans)',
                                  fontSize: 9,
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.15em',
                                  color: 'var(--danger)',
                                  background: 'transparent',
                                  border: '1px solid var(--danger)',
                                  borderRadius: 6,
                                  padding: '8px 12px',
                                  cursor: cancellingTestOrderId === order.id ? 'wait' : 'pointer',
                                  opacity: cancellingTestOrderId === order.id ? 0.5 : 1,
                                }}
                              >
                                Cancel
                              </button>
                            )}
                          </div>
                        </div>

                        {isRoutingHere && (
                          <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-color)' }}>
                            {networkLabs.length === 0 ? (
                              <p style={{ fontSize: 12, color: 'var(--text-tertiary)', fontStyle: 'italic' }}>
                                No independent labs on the Vela network yet.
                              </p>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                                {networkLabs.map((lab: any) => (
                                  <div key={lab.id} style={{
                                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                                    padding: '10px 14px', borderRadius: 6, background: 'var(--bg)',
                                  }}>
                                    <div>
                                      <div style={{ fontSize: 13, color: 'var(--text)' }}>{lab.name}</div>
                                      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{lab.address}</div>
                                    </div>
                                    <button
                                      type="button"
                                      disabled={routingToLabId === lab.id}
                                      onClick={() => routeTestOrder(order, lab.id, lab.name)}
                                      style={{
                                        fontFamily: 'var(--font-sans)', fontSize: 9, textTransform: 'uppercase',
                                        letterSpacing: '0.1em', color: 'var(--brand)', background: 'transparent',
                                        border: '1px solid var(--brand)', borderRadius: 6, padding: '6px 10px',
                                        cursor: routingToLabId === lab.id ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                                      }}
                                    >
                                      {routingToLabId === lab.id ? 'Routing…' : 'Send here'}
                                    </button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </section>
          )}

          {activeTab === 'history' && (
            <PatientHistoryRag patientId={id!} />
          )}

          {activeTab === 'imaging' && (
            <ImagingAnalysis patientId={id!} />
          )}

          {activeTab === 'reports' && (
            <section style={{ 
              background: 'var(--surface-color)', 
              border: '1px solid var(--border-color)', 
              borderRadius: 8, 
              padding: 32 
            }}>
               <div style={{ 
                 border: '1px dashed var(--border-color)', 
                 borderRadius: 8, 
                 padding: 32,
                 textAlign: 'center',
                 marginBottom: 32
               }}>
                <label style={{ 
                  display: 'inline-block', 
                  cursor: 'pointer',
                  padding: '12px 24px',
                  background: 'var(--bg-color)',
                  border: '1px solid var(--border-color)',
                  borderRadius: 4,
                  fontFamily: 'var(--font-sans)',
                  fontSize: 14,
                  transition: 'all 0.2s ease'
                }}>
                  <span>+ Upload Report PDF/Image</span>
                  <input type="file" multiple accept=".pdf,image/*" style={{ display: 'none' }} onChange={(e) => e.target.files && uploadDocuments(Array.from(e.target.files))} />
                </label>
                {uploadStatus && <div style={{ marginTop: 12, fontFamily: 'var(--font-sans)', fontSize: 12 }}>{uploadStatus}</div>}
              </div>

              <h4 style={{ fontFamily: 'var(--font-sans)', fontSize: 24, fontWeight: 400, margin: '0 0 16px 0' }}>Report History</h4>
              <div style={{ display: 'grid', gap: 12 }}>
                <style>{`
                  @keyframes spin {
                    0% { transform: rotate(0deg); }
                    100% { transform: rotate(360deg); }
                  }
                  @keyframes pulse {
                    0%, 100% { opacity: 1; }
                    50% { opacity: 0.5; }
                  }
                  @keyframes shimmer {
                    0% { transform: translateX(-100%); }
                    100% { transform: translateX(100%); }
                  }
                `}</style>
                {documents.map((d) => {
                  const isProcessing = d.summary === 'processing';
                  const needsReview = Array.isArray(d.critical_flags) && d.critical_flags.some((f: any) => typeof f === 'string' && f.includes('NEEDS DOCTOR REVIEW'));
                  const reviewReason = needsReview ? d.critical_flags.filter((f: any) => typeof f === 'string' && !f.includes('NEEDS DOCTOR REVIEW')).join(' · ') : '';
                  return (
                    <div key={d.id} style={{ 
                      border: needsReview ? '1px solid rgba(245,158,11,0.45)' : '1px solid var(--border-color)', 
                      borderRadius: 6, 
                      background: 'var(--bg-color)',
                      position: 'relative',
                      overflow: 'hidden'
                    }}>
                     <div style={{ padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', position: 'relative' }}>
                      {isProcessing && (
                        <div style={{
                          position: 'absolute',
                          inset: 0,
                          background: 'linear-gradient(90deg, transparent, rgba(255,255,255,0.05), transparent)',
                          animation: 'shimmer 1.5s infinite',
                          zIndex: 1
                        }} />
                      )}
                      
                      <div style={{ zIndex: 2 }}>
                        <div style={{ fontFamily: 'var(--font-sans)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 8 }}>
                          {d.filename}
                          {isProcessing && (
                            <span style={{ 
                              fontSize: 10, 
                              fontFamily: 'var(--font-sans)',
                              padding: '2px 6px', 
                              background: 'rgba(59, 130, 246, 0.1)', 
                              border: '1px solid rgba(59, 130, 246, 0.2)',
                              color: 'var(--brand-light)', 
                              borderRadius: 4,
                              animation: 'pulse 1.5s infinite'
                            }}>
                              Processing AI Insights...
                            </span>
                          )}
                        </div>
                        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-tertiary)', marginTop: 4 }}>
                          {new Date(d.report_date).toLocaleDateString()}
                        </div>
                      </div>
                      
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12, zIndex: 2 }}>
                        {!isProcessing ? (
                          <>
                            <div style={{ 
                              fontFamily: 'var(--font-sans)', 
                              fontSize: 13,
                              padding: '4px 8px',
                              background: 'var(--surface-color)',
                              borderRadius: 4,
                              border: '1px solid var(--border-color)'
                            }}>
                              Risk Score: {d.risk_score}
                            </div>
                            <button 
                              onClick={() => handleDeleteDocument(d.id)}
                              style={{
                                background: 'rgba(239, 68, 68, 0.1)',
                                border: '1px solid rgba(239, 68, 68, 0.2)',
                                color: 'var(--danger)',
                                borderRadius: 4,
                                padding: 6,
                                cursor: 'pointer',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                transition: 'all 0.2s ease',
                                height: '28px',
                                width: '28px'
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.2)';
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.background = 'rgba(239, 68, 68, 0.1)';
                              }}
                              title="Delete Document"
                            >
                              <Trash2 size={15} />
                            </button>
                          </>
                        ) : (
                          <div style={{ 
                            width: 16, 
                            height: 16, 
                            border: '2px solid rgba(59, 130, 246, 0.2)', 
                            borderTop: '2px solid var(--brand-light)',
                            borderRadius: '50%',
                            animation: 'spin 1s linear infinite'
                          }} />
                        )}
                      </div>
                     </div>
                     {needsReview && (
                       <div style={{ borderTop: '1px solid rgba(245,158,11,0.25)', background: 'rgba(245,158,11,0.06)', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                         <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0 }}>
                           <span style={{ fontFamily: 'var(--font-sans)', fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', color: 'var(--warning)', background: 'rgba(245,158,11,0.15)', border: '1px solid rgba(245,158,11,0.35)', borderRadius: 4, padding: '2px 8px', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>⚠ Needs review</span>
                           <span style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-secondary)' }}>{reviewReason || 'Handwritten / low-confidence extraction — verify against the original before trusting.'}</span>
                         </div>
                         {d.file_url && (
                           <button onClick={() => setReviewImage(d.file_url || null)} style={{ fontFamily: 'var(--font-sans)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--accent)', background: 'rgba(15,118,110,0.08)', border: '1px solid rgba(15,118,110,0.28)', borderRadius: 4, padding: '6px 12px', cursor: 'pointer', whiteSpace: 'nowrap' }}>View original scan</button>
                         )}
                       </div>
                     )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}

          {activeTab === 'medications' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
              {/* ✨ Atlas Ambient Draft Orders Summary Card */}
              {draftOrders && (draftOrders.prescriptions.length > 0 || draftOrders.lab_requisitions.length > 0 || draftOrders.follow_up_days !== null) && (
                <div style={{
                  background: 'linear-gradient(135deg, rgba(245, 158, 11, 0.09) 0%, rgba(251, 191, 36, 0.03) 100%)',
                  border: '1px solid rgba(245, 158, 11, 0.28)',
                  borderRadius: 12,
                  padding: 24,
                  boxShadow: '0 8px 32px 0 rgba(245, 158, 11, 0.05), inset 0 1px 1px rgba(255, 255, 255, 0.05)',
                  backdropFilter: 'blur(8px)',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 20
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <h4 style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 18, color: 'var(--warning)', margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                        ✨ Atlas Ambient Draft Orders Summary
                      </h4>
                      <p style={{ fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 0 0' }}>
                        Atlas has drafted these clinical directives from your dialogue. Verify, adjust, or sign off to commit them.
                      </p>
                    </div>
                    <button
                      onClick={() => setDraftOrders(null)}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--text-tertiary)',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontFamily: 'var(--font-sans)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em'
                      }}
                    >
                      Dismiss Draft
                    </button>
                  </div>

                  {/* 1. Prescriptions Grid */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--warning)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                      📋 Prescriptions ({draftOrders.prescriptions.length})
                    </div>
                    
                    {draftOrders.prescriptions.map((pres, idx) => (
                      <div key={idx} style={{
                        display: 'grid',
                        gridTemplateColumns: '2fr 1fr 1fr 1fr auto',
                        gap: 12,
                        alignItems: 'center',
                        background: 'rgba(0, 0, 0, 0.15)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 8,
                        padding: '10px 14px'
                      }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>MEDICATION NAME</span>
                          <input
                            type="text"
                            value={pres.medication_name}
                            onChange={(e) => {
                              const list = [...draftOrders.prescriptions]
                              list[idx].medication_name = e.target.value
                              setDraftOrders({ ...draftOrders, prescriptions: list })
                            }}
                            placeholder="e.g. Metformin"
                            style={{
                              background: 'transparent',
                              border: 'none',
                              borderBottom: '1px dashed var(--border-color)',
                              color: 'var(--text-primary)',
                              fontSize: 14,
                              fontFamily: 'var(--font-sans)',
                              padding: '2px 0',
                              outline: 'none'
                            }}
                          />
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>DOSAGE</span>
                          <input
                            type="text"
                            value={pres.dosage}
                            onChange={(e) => {
                              const list = [...draftOrders.prescriptions]
                              list[idx].dosage = e.target.value
                              setDraftOrders({ ...draftOrders, prescriptions: list })
                            }}
                            placeholder="e.g. 500mg"
                            style={{
                              background: 'transparent',
                              border: 'none',
                              borderBottom: '1px dashed var(--border-color)',
                              color: 'var(--text-primary)',
                              fontSize: 14,
                              fontFamily: 'var(--font-sans)',
                              padding: '2px 0',
                              outline: 'none'
                            }}
                          />
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>FREQUENCY</span>
                          <input
                            type="text"
                            value={pres.frequency}
                            onChange={(e) => {
                              const list = [...draftOrders.prescriptions]
                              list[idx].frequency = e.target.value
                              setDraftOrders({ ...draftOrders, prescriptions: list })
                            }}
                            placeholder="e.g. once daily"
                            style={{
                              background: 'transparent',
                              border: 'none',
                              borderBottom: '1px dashed var(--border-color)',
                              color: 'var(--text-primary)',
                              fontSize: 14,
                              fontFamily: 'var(--font-sans)',
                              padding: '2px 0',
                              outline: 'none'
                            }}
                          />
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                          <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'var(--font-sans)' }}>DURATION</span>
                          <input
                            type="text"
                            value={pres.duration}
                            onChange={(e) => {
                              const list = [...draftOrders.prescriptions]
                              list[idx].duration = e.target.value
                              setDraftOrders({ ...draftOrders, prescriptions: list })
                            }}
                            placeholder="e.g. 30 days"
                            style={{
                              background: 'transparent',
                              border: 'none',
                              borderBottom: '1px dashed var(--border-color)',
                              color: 'var(--text-primary)',
                              fontSize: 14,
                              fontFamily: 'var(--font-sans)',
                              padding: '2px 0',
                              outline: 'none'
                            }}
                          />
                        </div>

                        <button
                          onClick={() => {
                            const list = draftOrders.prescriptions.filter((_, i) => i !== idx)
                            setDraftOrders({ ...draftOrders, prescriptions: list })
                          }}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--text-tertiary)',
                            cursor: 'pointer',
                            padding: '4px',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            transition: 'color 0.2s'
                          }}
                          onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--danger)')}
                          onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-tertiary)')}
                          title="Delete medication"
                        >
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}

                    <button
                      onClick={() => {
                        const list = [...draftOrders.prescriptions, { medication_name: "", dosage: "", frequency: "", duration: "" }]
                        setDraftOrders({ ...draftOrders, prescriptions: list })
                      }}
                      style={{
                        alignSelf: 'flex-start',
                        background: 'transparent',
                        border: 'none',
                        color: 'var(--warning)',
                        cursor: 'pointer',
                        fontSize: 12,
                        fontFamily: 'var(--font-sans)',
                        textTransform: 'uppercase',
                        letterSpacing: '0.05em',
                        padding: '4px 0',
                        marginTop: 4
                      }}
                    >
                      + Add Medication Item
                    </button>
                  </div>

                  {/* 2. Lab Requisitions & Follow-up Row */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
                    {/* Lab test orders */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--warning)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                        🔬 Lab Requisitions ({draftOrders.lab_requisitions.length})
                      </div>
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        {draftOrders.lab_requisitions.map((lab, idx) => (
                          <div key={idx} style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            background: 'rgba(0, 0, 0, 0.15)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 8,
                            padding: '6px 12px'
                          }}>
                            <input
                              type="text"
                              value={lab}
                              onChange={(e) => {
                                const list = [...draftOrders.lab_requisitions]
                                list[idx] = e.target.value
                                setDraftOrders({ ...draftOrders, lab_requisitions: list })
                              }}
                              placeholder="e.g. Fasting Blood Sugar"
                              style={{
                                flex: 1,
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-primary)',
                                fontSize: 13,
                                fontFamily: 'var(--font-sans)',
                                outline: 'none'
                              }}
                            />
                            <button
                              onClick={() => {
                                const list = draftOrders.lab_requisitions.filter((_, i) => i !== idx)
                                setDraftOrders({ ...draftOrders, lab_requisitions: list })
                              }}
                              style={{
                                background: 'transparent',
                                border: 'none',
                                color: 'var(--text-tertiary)',
                                cursor: 'pointer',
                                padding: '2px',
                                display: 'flex',
                                alignItems: 'center'
                              }}
                              onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--danger)')}
                              onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--text-tertiary)')}
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        ))}

                        <button
                          onClick={() => {
                            const list = [...draftOrders.lab_requisitions, ""]
                            setDraftOrders({ ...draftOrders, lab_requisitions: list })
                          }}
                          style={{
                            alignSelf: 'flex-start',
                            background: 'transparent',
                            border: 'none',
                            color: 'var(--warning)',
                            cursor: 'pointer',
                            fontSize: 11,
                            fontFamily: 'var(--font-sans)',
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                            padding: '4px 0'
                          }}
                        >
                          + Add Lab Order
                        </button>
                      </div>
                    </div>

                    {/* Follow-up Days */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                      <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--warning)', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
                        📅 Follow-Up Appointment
                      </div>
                      <div style={{
                        background: 'rgba(0, 0, 0, 0.15)',
                        border: '1px solid var(--border-color)',
                        borderRadius: 8,
                        padding: 16,
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12
                      }}>
                        <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>Recommend return in</span>
                        <input
                          type="number"
                          value={draftOrders.follow_up_days || ""}
                          onChange={(e) => {
                            const val = e.target.value === "" ? null : parseInt(e.target.value)
                            setDraftOrders({ ...draftOrders, follow_up_days: val })
                          }}
                          placeholder="e.g. 14"
                          style={{
                            width: 60,
                            background: 'rgba(0,0,0,0.2)',
                            border: '1px solid var(--border-color)',
                            borderRadius: 6,
                            color: 'var(--text-primary)',
                            padding: '4px 8px',
                            textAlign: 'center',
                            fontSize: 14,
                            fontFamily: 'var(--font-sans)',
                            outline: 'none'
                          }}
                        />
                        <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>days.</span>
                      </div>
                    </div>
                  </div>

                  {/* 3. Action Checkout Button */}
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                    <button
                      onClick={approveAmbientOrders}
                      style={{
                        background: 'linear-gradient(135deg, var(--warning) 0%, var(--warning) 100%)',
                        color: '#000',
                        border: 'none',
                        borderRadius: 8,
                        padding: '14px 28px',
                        fontFamily: 'var(--font-sans)',
                        fontWeight: 600,
                        fontSize: 14,
                        cursor: 'pointer',
                        boxShadow: '0 4px 14px 0 rgba(245, 158, 11, 0.3)',
                        transition: 'transform 0.2s, box-shadow 0.2s',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.transform = 'translateY(-1px)'
                        e.currentTarget.style.boxShadow = '0 6px 20px 0 rgba(245, 158, 11, 0.4)'
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.transform = 'none'
                        e.currentTarget.style.boxShadow = '0 4px 14px 0 rgba(245, 158, 11, 0.3)'
                      }}
                    >
                      ✍️ Approve & Sign Orders
                    </button>
                  </div>
                </div>
              )}

              {/* Main Medications Layout Grid */}
              <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 32 }}>
                <section style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 24 }}>
                  <h4 style={{ fontFamily: 'var(--font-sans)', fontSize: 24, fontWeight: 400, margin: '0 0 24px 0' }}>
                    Current Medications
                  </h4>
                  <div style={{ display: 'grid', gap: 12 }}>
                    {medications.map((m) => (
                      <div key={m.id} style={{ 
                        padding: 16, 
                        background: 'var(--bg-color)', 
                        border: '1px solid var(--border-color)', 
                        borderRadius: 6 
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                          <div style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 16 }}>{m.name}</div>
                          <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-tertiary)' }}>ID: {m.id.slice(0,6)}</div>
                        </div>
                        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>
                          {m.dosage} • {m.frequency}
                        </div>
                        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: 'var(--text-tertiary)' }}>
                          Prescribed by {m.prescribed_by} on {new Date(m.start_date).toLocaleDateString()}
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
                
                <section style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 24 }}>
                  <h4 style={{ fontFamily: 'var(--font-sans)', fontSize: 24, fontWeight: 400, margin: '0 0 24px 0' }}>Quick Notes</h4>
                  <textarea 
                    value={newNote} 
                    onChange={(e) => setNewNote(e.target.value)} 
                    placeholder="Add a medication note..."
                    style={{ 
                      width: '100%', 
                      minHeight: 120, 
                      background: 'var(--bg-color)',
                      border: '1px solid var(--border-color)', 
                      borderRadius: 6, 
                      padding: 12,
                      fontFamily: 'var(--font-sans)',
                      marginBottom: 12,
                      resize: 'vertical'
                    }} 
                  />
                  <button 
                    onClick={addNote}
                    style={{ 
                      width: '100%', 
                      background: 'var(--primary-color)', 
                      color: 'var(--bg-color)', 
                      padding: '12px', 
                      border: 'none', 
                      borderRadius: 4,
                      fontFamily: 'var(--font-sans)',
                      cursor: 'pointer'
                    }}
                  >
                    Save Note
                  </button>
                </section>
              </div>
            </div>
          )}

          {activeTab === 'notes' && (
            <section style={{ background: 'var(--surface-color)', border: '1px solid var(--border-color)', borderRadius: 8, padding: 24 }}>
              <div style={{ marginBottom: 32 }}>
                <textarea 
                  value={newNote} 
                  onChange={(e) => setNewNote(e.target.value)} 
                  placeholder="Enter clinical observations..." 
                  style={{ 
                    width: '100%', 
                    minHeight: 120, 
                    background: 'var(--bg-color)',
                    border: '1px solid var(--border-color)', 
                    borderRadius: 6, 
                    padding: 16,
                    fontFamily: 'var(--font-sans)',
                    marginBottom: 12,
                    resize: 'vertical',
                    fontSize: 15
                  }} 
                />
                <div style={{ textAlign: 'right' }}>
                  <button 
                    onClick={addNote} 
                    style={{ 
                      background: 'var(--primary-color)', 
                      color: 'var(--bg-color)', 
                      padding: '12px 24px', 
                      border: 'none', 
                      borderRadius: 4,
                      fontFamily: 'var(--font-sans)',
                      cursor: 'pointer'
                    }}
                  >
                    Add Observation
                  </button>
                </div>
              </div>
              
              <h4 style={{ fontFamily: 'var(--font-sans)', fontSize: 24, fontWeight: 400, margin: '0 0 24px 0' }}>History</h4>
              <div style={{ display: 'grid', gap: 16 }}>
                {notes.map((n) => (
                  <div key={n.id} style={{ 
                    background: 'var(--bg-color)', 
                    border: '1px solid var(--border-color)', 
                    borderRadius: 8, 
                    padding: 20 
                  }}>
                    <div style={{ fontFamily: 'var(--font-sans)', fontSize: 15, lineHeight: 1.6, marginBottom: 12 }}>
                      {n.content}
                    </div>
                    <div style={{ 
                      display: 'flex', 
                      justifyContent: 'space-between', 
                      borderTop: '1px solid var(--border-color)', 
                      paddingTop: 12,
                      fontFamily: 'var(--font-sans)', 
                      fontSize: 11, 
                      color: 'var(--text-tertiary)' 
                    }}>
                      <span>{n.created_by}</span>
                      <span>{new Date(n.created_at).toLocaleString()}</span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>
        
      </main>

      {/* Original-scan lightbox — lets the doctor read the source themselves
          instead of trusting an automated transcription of unclear content. */}
      {reviewImage && (
        <div
          onClick={() => setReviewImage(null)}
          style={{ position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0,0,0,0.85)', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 32, cursor: 'zoom-out' }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
            <span style={{ fontFamily: 'var(--font-sans)', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--warning)' }}>⚠ Original scan — verify handwritten content yourself</span>
            <button onClick={(e) => { e.stopPropagation(); setReviewImage(null) }} style={{ fontFamily: 'var(--font-sans)', fontSize: 11, color: '#fff', background: 'rgba(255,255,255,0.12)', border: '1px solid rgba(255,255,255,0.25)', borderRadius: 4, padding: '4px 10px', cursor: 'pointer' }}>Close ✕</button>
          </div>
          <img
            src={reviewImage}
            alt="Original medical document scan"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: '92vw', maxHeight: '82vh', objectFit: 'contain', borderRadius: 6, boxShadow: '0 20px 60px rgba(0,0,0,0.6)', cursor: 'default' }}
          />
        </div>
      )}
    </div>
  )
}
