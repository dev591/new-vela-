import { API_URL } from "../utils/config";
import React, { useEffect, useState, useRef, useMemo } from 'react'
import { gsap } from 'gsap'
import toast from 'react-hot-toast'
import useSocket, { type SocketEventPayload } from '../hooks/useSocket'
import { getUser, logout } from '../utils/auth'
import { 
  Users, 
  FileText, 
  Clock, 
  Activity,
  Calendar,
  LogOut,
  Monitor,
  Camera,
  Bell,
  CheckCircle2,
  UserPlus,
  X,
  CreditCard,
  Stethoscope,
  ShieldAlert,
  RefreshCw,
  Search,
  FlaskConical,
  Trash2,
  AlertTriangle
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react'
import { Html5QrcodeScanner } from 'html5-qrcode'

type Patient = {
  id: string; name: string; age: number; gender: string; blood_group: string; ward: string; room: string; doctor: string; status: string; risk_score: number; vela_id: string | null; diagnosis: string; registered_by: string; atlas_analysis?: string; atlas_confidence?: string; [key: string]: any
}

type Admission = {
  id: string; patient_id: string; bed_id: string; ward_id: string; status: string; room_type: string; admission_qr: string; admitted_at: string; diagnosis: string; admission_reason: string; recommended_by: string; patients?: Patient; beds?: { bed_number: string }; wards?: { name: string }
}

type RoomType = {
  id: string; name: string; cost_per_day: number; amenities: string[]
}

type QueueItem = {
  id: string;
  ticket_number: string;
  patient_id: string;
  patient_name: string;
  status: string;
  department: string;
  created_at: string;
  wait_minutes?: number;
  notes?: string;
  queue_position?: number;
  doctor_id?: string;
  vela_id?: string;
}

export default function Receptionist() {
  const socket = useSocket()
  
  const containerRef = useRef<HTMLDivElement>(null)
  const formRef = useRef<HTMLFormElement>(null)
  const queueRef = useRef<HTMLDivElement>(null)

  const [activeTab, setActiveTab] = useState<'register' | 'lookup' | 'appointments' | 'tests' | 'catalog' | 'admissions' | 'queue' | 'doctors'>('register')
  const [sidebarExpanded, setSidebarExpanded] = useState(false)

  const [registerForm, setRegisterForm] = useState({
    name: '', age: '', gender: 'Male', blood_group: '', height: '', weight: '', allergies: '', existing_conditions: '', emergency_contact: '', language: 'English', ward: 'General', room: '', doctor: '', diagnosis: '', registered_by: 'receptionist'
  })

  const [registering, setRegistering] = useState(false)
  const [registeredPatient, setRegisteredPatient] = useState<Patient | null>(null)

  // Emergency intake — kept out of the tab system on purpose. In a panic the
  // receptionist must not have to find the right tab first.
  const [emergencyOpen, setEmergencyOpen] = useState(false)
  const [emergencyName, setEmergencyName] = useState('')
  const [emergencyAge, setEmergencyAge] = useState('')
  const [emergencyNote, setEmergencyNote] = useState('')
  const [emergencySubmitting, setEmergencySubmitting] = useState(false)
  const [lastEmergency, setLastEmergency] = useState<{ name: string; vela_id: string; ticket: string } | null>(null)

  const [lookupId, setLookupId] = useState('')
  const [lookupPatient, setLookupPatient] = useState<Patient | null>(null)
  const [lookupLoading, setLookupLoading] = useState(false)
  const [isScanning, setIsScanning] = useState(false)

  const [queue, setQueue] = useState<QueueItem[]>([])
  const [queueLoading, setQueueLoading] = useState(false)

  const [ticketNotes, setTicketNotes] = useState('')
  const [ticketDepartment, setTicketDepartment] = useState('General')
  const [selectedTicketDoctor, setSelectedTicketDoctor] = useState<string>('')
  const [ticketCreating, setTicketCreating] = useState(false)

  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [uploadResult, setUploadResult] = useState<any>(null)
  const [dragOver, setDragOver] = useState(false)

  // Phase 1: Appointments & Notifications
  const [appointments, setAppointments] = useState<any[]>([])
  const [notifications, setNotifications] = useState<any[]>([])
  const [showNotifications, setShowNotifications] = useState(false)
  const [appointmentsLoading, setAppointmentsLoading] = useState(false)
  const [testOrders, setTestOrders] = useState<any[]>([])
  const [testLoading, setTestLoading] = useState(false)
  const [selectedTestOrder, setSelectedTestOrder] = useState<any>(null)
  const [showPaymentModal, setShowPaymentModal] = useState(false)
  const [cancellingOrderId, setCancellingOrderId] = useState<string | null>(null)
  // The counter can have a long line — reception needs to find one patient fast.
  const [testSearch, setTestSearch] = useState('')

  // Paid, waiting to be checked in at the lab that runs their test.
  const [arrivals, setArrivals] = useState<any[]>([])
  const [arrivalsLoading, setArrivalsLoading] = useState(false)
  const [arrivalSearch, setArrivalSearch] = useState('')
  const [arrivingId, setArrivingId] = useState<string | null>(null)

  // Lab catalog: which test is run by which lab, and what it costs.
  const [catalog, setCatalog] = useState<any[]>([])
  const [catalogDepartments, setCatalogDepartments] = useState<{ id: string; name: string }[]>([])
  const [catalogLoading, setCatalogLoading] = useState(false)
  const [catalogSearch, setCatalogSearch] = useState('')
  const [catalogForm, setCatalogForm] = useState({ test_type: '', department: 'pathology', price: '', tat_minutes: '' })
  const [catalogSaving, setCatalogSaving] = useState(false)

  // Phase 3: Admissions
  const [activeAdmissions, setActiveAdmissions] = useState<Admission[]>([])
  const [recommendedAdmissions, setRecommendedAdmissions] = useState<any[]>([])
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([])
  const [wards, setWards] = useState<any[]>([])
  const [admissionsLoading, setAdmissionsLoading] = useState(false)
  
  const [showAdmissionModal, setShowAdmissionModal] = useState(false)
  const [selectedRecommendation, setSelectedRecommendation] = useState<any>(null)
  const [admissionForm, setAdmissionForm] = useState({
      ward_id: '',
      bed_id: '',
      room_type: 'General Ward',
      diagnosis: '',
      reason: ''
  })
  const [confirmingAdmission, setConfirmingAdmission] = useState(false)
  const [successAdmission, setSuccessAdmission] = useState<any>(null)

  // Phase 4: Discharge
  const [showDischargeModal, setShowDischargeModal] = useState(false)
  const [selectedDischargeAdmission, setSelectedDischargeAdmission] = useState<Admission | null>(null)
  const [dischargeSummary, setDischargeSummary] = useState('')
  const [_dischargeLoading, setDischargeLoading] = useState(false)
  const [dischargeData, setDischargeData] = useState<any>(null)
  const [dischargeConfirmed, setDischargeConfirmed] = useState(false)
  const [followUpDate, setFollowUpDate] = useState('')
  const [followUpInstructions, setFollowUpInstructions] = useState('')
  const [finalDiagnosis, setFinalDiagnosis] = useState('')
  const [paymentAmount, setPaymentAmount] = useState(0)
  const [paymentMethod, setPaymentMethod] = useState('Cash')
  const [processLoading, setProcessLoading] = useState(false)

  const user = getUser()
  const hospitalId = localStorage.getItem("vela_hospital_id")

  const [showAssignModal, setShowAssignModal] = useState(false)
  const [selectedApt, setSelectedApt] = useState<any>(null)
  const [doctorStats, setDoctorStats] = useState<any[]>([])
  const [triageLevel, setTriageLevel] = useState('Routine')
  const [assigning, setAssigning] = useState(false)
  const [activeAcceptingAptId, setActiveAcceptingAptId] = useState<string | null>(null)
  const [assignedDoctorId, setAssignedDoctorId] = useState<string>('')
  const [selectedDoctorForQueue, setSelectedDoctorForQueue] = useState<any | null>(null)
  const [doctorQueueSearchQuery, setDoctorQueueSearchQuery] = useState<string>('')

  // The endpoint requires a hospital to scope against. When the session has no
  // hospital bound, saying so beats an empty directory that reads as "this
  // hospital employs no doctors".
  const [doctorStatsError, setDoctorStatsError] = useState<string | null>(null)

  const fetchDoctorStats = async () => {
    if (!hospitalId) {
      setDoctorStats([])
      setDoctorStatsError('No hospital is bound to this session — sign in again to load the roster.')
      return
    }
    try {
      const res = await fetch(`${API_URL}/api/receptionist/doctors-status?hospital_id=${hospitalId}`)
      const data = await res.json()
      if (data.status !== 'success') throw new Error(data.message || 'Could not load the doctor roster')
      setDoctorStats(data.doctors)
      setDoctorStatsError(null)
    } catch (err: any) {
      console.error(err)
      setDoctorStatsError(err.message || 'Could not reach the doctor roster')
    }
  }

  const handleOpenAssign = (apt: any) => {
    setSelectedApt(apt)
    fetchDoctorStats()
    setShowAssignModal(true)
  }

  const handleAssignSubmit = async (doctorId: string) => {
    setAssigning(true)
    try {
      const res = await fetch(`${API_URL}/api/receptionist/assign-doctor`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appointment_id: selectedApt.id,
          doctor_id: doctorId,
          triage_level: triageLevel
        })
      })
      const data = await res.json()
      if (data.status === 'success') {
        toast.success(`Patient assigned. Ticket: ${data.ticket.ticket_number}`)
        setShowAssignModal(false)
        fetchAppointments()
        fetchQueue()
      } else throw new Error(data.message)
    } catch (err: any) {
      toast.error(err.message || "Assignment failed")
    } finally {
      setAssigning(false)
    }
  }

  const fetchQueue = async () => {
    setQueueLoading(true)
    try {
      const url = hospitalId 
        ? `${API_URL}/api/receptionist/queue?hospital_id=${hospitalId}`
        : `${API_URL}/api/receptionist/queue`
      const res = await fetch(url)
      if (!res.ok) throw new Error('Could not load queue')
      const data = await res.json()
      if (data.status === 'success' && Array.isArray(data.queue)) {
        setQueue(data.queue)
      }
    } catch (err: any) {
      console.error(err)
    } finally {
      setQueueLoading(false)
    }
  }

  const fetchAppointments = async () => {
    setAppointmentsLoading(true)
    try {
      const url = hospitalId 
        ? `${API_URL}/api/appointments/today?hospital_id=${hospitalId}`
        : `${API_URL}/api/appointments/today`
      const res = await fetch(url)
      const data = await res.json()
      if (data.status === 'success') setAppointments(data.appointments || [])
    } catch (err) {
      console.error(err)
    } finally {
      setAppointmentsLoading(false)
    }
  }

  const fetchNotifications = async () => {
    try {
      const res = await fetch(`${API_URL}/api/notifications/receptionist`)
      const data = await res.json()
      if (data.status === 'success') setNotifications(data.notifications)
    } catch (err) {
      console.error(err)
    }
  }

  const markNotificationRead = async (id: string) => {
    try {
      await fetch(`${API_URL}/api/notifications/${id}/read`, { method: 'PUT' })
      fetchNotifications()
    } catch (err) {
      console.error(err)
    }
  }

  const handleMarkArrived = async (aptId: string) => {
    try {
      // Always use the new unified transactional check-in endpoint.
      // It prevents double check-ins, creates the live queue ticket,
      // and broadcasts real-time Socket.IO updates to all open panels.
      const res = await fetch(`${API_URL}/api/receptionist/appointment/${aptId}/arrive`, {
        method: 'POST',
      })
      const data = await res.json()
      if (data.status === 'success') {
        toast.success(
          data.queue_position
            ? `✅ Patient checked in — Queue Position: #${data.queue_position}`
            : '✅ Patient marked as arrived'
        )
        // Refresh all three panels so every metric updates instantly
        fetchAppointments()
        fetchQueue()
        fetchDoctorStats()
      } else {
        throw new Error(data.message || data.detail || 'Check-in failed')
      }
    } catch (err: any) {
      toast.error(err.message || 'Failed to mark arrival')
    }
  }

  const handleAcceptAppointment = async (aptId: string, doctorId?: string) => {
    try {
      const staffId = localStorage.getItem("vela_staff_id") || user?.id || "receptionist_01";
      const staffName = user?.name ? user.name.replace(/^(dr\.|dr\s)/i, '').trim() : "Receptionist";
      
      const res = await fetch(`${API_URL}/api/appointments/${aptId}/accept`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          staff_id: staffId, 
          staff_name: staffName,
          doctor_id: doctorId || null
        }),
        signal: AbortSignal.timeout(10000)
      })
      const data = await res.json()
      if (data.status === 'success') {
        toast.success(`Appointment accepted and patient queued! Ticket: ${data.ticket_number}`)
        setActiveAcceptingAptId(null)
        setAssignedDoctorId('')
        fetchAppointments()
        fetchQueue()
      } else {
        throw new Error(data.message)
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to accept appointment")
    }
  }

  const handleRejectAppointment = async (aptId: string) => {
    try {
      const staffId = localStorage.getItem("vela_staff_id") || user?.id || "receptionist_01";
      const staffName = user?.name ? user.name.replace(/^(dr\.|dr\s)/i, '').trim() : "Receptionist";
      
      const res = await fetch(`${API_URL}/api/appointments/${aptId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ staff_id: staffId, staff_name: staffName })
      })
      const data = await res.json()
      if (data.status === 'success') {
        toast.success('Appointment request rejected')
        fetchAppointments()
      } else {
        throw new Error(data.message)
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to reject appointment")
    }
  }

  const handleStartConsultation = async (ticket: any) => {
    try {
      const res = await fetch(`${API_URL}/api/tickets/${ticket.id}/consult`, { method: 'POST' })
      const data = await res.json()
      if (data.status === 'success') {
        toast.success(`Started consultation for ${ticket.patient_name}!`)
        fetchQueue()
      } else {
        throw new Error(data.message)
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to start consultation")
    }
  }

  const handleCompleteConsultation = async (ticket: any) => {
    try {
      const res = await fetch(`${API_URL}/api/tickets/${ticket.id}/complete`, { method: 'POST' })
      const data = await res.json()
      if (data.status === 'success') {
        toast.success(`Consultation completed for ${ticket.patient_name}!`)
        fetchQueue()
      } else {
        throw new Error(data.message)
      }
    } catch (err: any) {
      toast.error(err.message || "Failed to complete consultation")
    }
  }

  const fetchTestOrders = async () => {
    setTestLoading(true)
    try {
      const url = hospitalId 
        ? `${API_URL}/api/lab/orders/pending-payment?hospital_id=${hospitalId}`
        : `${API_URL}/api/lab/orders/pending-payment`
      const res = await fetch(url)
      const data = await res.json()
      if (data.status === 'success') setTestOrders(data.orders)
    } catch (err) {
      console.error(err)
    } finally {
      setTestLoading(false)
    }
  }

  // The order carries the price the catalog charged at order time — that is the
  // number the patient owes, not a hardcoded frontend guess.
  const orderPrice = (order: any) => Number(order?.price ?? order?.payment_amount ?? 0)

  const filteredTestOrders = useMemo(() => {
    const q = testSearch.trim().toLowerCase()
    if (!q) return testOrders
    return testOrders.filter((o) =>
      [o.patients?.name, o.patients?.vela_id, o.test_type, o.department, o.doctor_name]
        .some((f: any) => (f || '').toString().toLowerCase().includes(q))
    )
  }, [testOrders, testSearch])

  const filteredArrivals = useMemo(() => {
    const q = arrivalSearch.trim().toLowerCase()
    if (!q) return arrivals
    return arrivals.filter((o) =>
      [o.patients?.name, o.patients?.vela_id, o.test_type, o.department]
        .some((f: any) => (f || '').toString().toLowerCase().includes(q))
    )
  }, [arrivals, arrivalSearch])

  const filteredCatalog = useMemo(() => {
    const q = catalogSearch.trim().toLowerCase()
    if (!q) return catalog
    return catalog.filter((t) =>
      [t.test_type, t.department].some((f: any) => (f || '').toString().toLowerCase().includes(q))
    )
  }, [catalog, catalogSearch])

  const fetchCatalog = async () => {
    setCatalogLoading(true)
    try {
      const url = hospitalId
        ? `${API_URL}/api/lab/catalog?hospital_id=${hospitalId}`
        : `${API_URL}/api/lab/catalog`
      const res = await fetch(url)
      const data = await res.json()
      if (data.status === 'success') {
        setCatalog(data.tests || [])
        setCatalogDepartments(data.departments || [])
      }
    } catch (err) {
      toast.error('Could not load the test catalog')
    } finally {
      setCatalogLoading(false)
    }
  }

  const saveCatalogEntry = async () => {
    const name = catalogForm.test_type.trim()
    if (!name) return toast.error('Enter a test name')
    if (!catalogForm.price.trim() || isNaN(Number(catalogForm.price))) return toast.error('Enter a valid price')
    setCatalogSaving(true)
    try {
      const res = await fetch(`${API_URL}/api/lab/catalog/entry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          test_type: name,
          department: catalogForm.department,
          price: Number(catalogForm.price),
          tat_minutes: catalogForm.tat_minutes ? Number(catalogForm.tat_minutes) : undefined,
          hospital_id: hospitalId || undefined,
          created_by: getUser()?.name || 'Reception',
        }),
      })
      const data = await res.json()
      if (data.status !== 'success') throw new Error(data.message || 'Could not save the test')
      toast.success(`${data.test_type} → ${data.department} lab • ₹${data.price}`)
      setCatalogForm({ test_type: '', department: catalogForm.department, price: '', tat_minutes: '' })
      fetchCatalog()
    } catch (err: any) {
      toast.error(err.message || 'Could not save the test')
    } finally {
      setCatalogSaving(false)
    }
  }

  const deleteCatalogEntry = async (entry: any) => {
    if (!entry.id) return
    try {
      const res = await fetch(`${API_URL}/api/lab/catalog/entry/${entry.id}`, { method: 'DELETE' })
      const data = await res.json()
      if (data.status !== 'success') throw new Error(data.message || 'Delete failed')
      toast.success(`${entry.test_type} removed from this hospital's menu`)
      fetchCatalog()
    } catch (err: any) {
      toast.error(err.message || 'Delete failed')
    }
  }

  const fetchArrivals = async () => {
    setArrivalsLoading(true)
    try {
      const url = hospitalId
        ? `${API_URL}/api/lab/orders/awaiting-arrival?hospital_id=${hospitalId}`
        : `${API_URL}/api/lab/orders/awaiting-arrival`
      const res = await fetch(url)
      const data = await res.json()
      if (data.status === 'success') setArrivals(data.orders || [])
    } catch (err) {
      console.error(err)
    } finally {
      setArrivalsLoading(false)
    }
  }

  const markArrived = async (order: any) => {
    setArrivingId(order.id)
    try {
      const res = await fetch(`${API_URL}/api/lab/orders/${order.id}/arrive`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ arrived_by: getUser()?.name || 'Reception' }),
      })
      const data = await res.json()
      if (data.status !== 'success') throw new Error(data.message || 'Check-in failed')
      toast.success(
        data.already_arrived
          ? `${order.patients?.name || 'Patient'} was already checked in`
          : `Checked in at ${data.department} lab • queue #${data.queue_position}`
      )
      fetchArrivals()
    } catch (err: any) {
      toast.error(err.message || 'Check-in failed')
    } finally {
      setArrivingId(null)
    }
  }

  const handleConfirmPayment = async (orderId: string, amount: number) => {
    try {
      const res = await fetch(`${API_URL}/api/lab/orders/${orderId}/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount })
      })
      const data = await res.json()
      if (data.status !== 'success') throw new Error(data.message || 'Payment failed')
      // Paid ≠ queued. The patient still has to walk to the lab, where they get
      // checked in from the arrivals board below.
      toast.success(data.message || 'Payment confirmed — send the patient to the lab')
      setShowPaymentModal(false)
      fetchTestOrders()
      fetchArrivals()
    } catch (err: any) {
      toast.error(err.message || "Failed to confirm payment")
    }
  }

  const cancelTestOrder = async (order: any) => {
    if (!window.confirm(`Cancel ${order.test_type} for ${order.patients?.name || 'this patient'}?`)) return
    setCancellingOrderId(order.id)
    try {
      const res = await fetch(`${API_URL}/api/lab/orders/${order.id}/cancel`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cancelled_by: getUser()?.name || 'Reception' }),
      })
      const data = await res.json()
      if (data.status !== 'success') throw new Error(data.message || 'Cancel failed')
      toast.success(`${order.test_type} cancelled`)
      setShowPaymentModal(false)
      fetchTestOrders()
    } catch (err: any) {
      toast.error(err.message || 'Cancel failed')
    } finally {
      setCancellingOrderId(null)
    }
  }

  const fetchAdmissions = async () => {
      setAdmissionsLoading(true)
      try {
          const [admRes, roomRes, wardRes] = await Promise.all([
              fetch(hospitalId ? `${API_URL}/api/admissions/active?hospital_id=${hospitalId}` : `${API_URL}/api/admissions/active`),
              fetch(`${API_URL}/api/room-types`),
              fetch(hospitalId ? `${API_URL}/api/wards?hospital_id=${hospitalId}` : `${API_URL}/api/wards`)
          ])
          const [admData, roomData, wardData] = await Promise.all([
              admRes.json(), roomRes.json(), wardRes.json()
          ])
          if (admData.status === 'success') setActiveAdmissions(admData.admissions)
          if (roomData.status === 'success') setRoomTypes(roomData.room_types)
          if (wardData.status === 'success') setWards(wardData.wards)
      } catch (err) {
          console.error(err)
      } finally {
          setAdmissionsLoading(false)
      }
  }

  const handleConfirmAdmission = async () => {
      if (!selectedRecommendation || !admissionForm.ward_id || !admissionForm.bed_id) {
          toast.error("Please select ward and bed")
          return
      }

      setConfirmingAdmission(true)
      try {
          const selectedWard = wards.find(w => w.id === admissionForm.ward_id)
          const selectedBed = selectedWard?.beds.find((b: any) => b.id === admissionForm.bed_id)

          const res = await fetch(`${API_URL}/api/admissions/confirm`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  patient_id: selectedRecommendation.patient_id,
                  bed_id: admissionForm.bed_id,
                  ward_id: admissionForm.ward_id,
                  ward_name: selectedWard?.name,
                  bed_number: selectedBed?.bed_number,
                  room_type: admissionForm.room_type,
                  admission_reason: admissionForm.reason || selectedRecommendation.reason,
                  diagnosis: admissionForm.diagnosis || selectedRecommendation.reason,
                  recommended_by: selectedRecommendation.recommended_by || 'Atlas AI',
                  admitted_by: user?.name
              })
          })
          const data = await res.json()
          if (data.status !== 'success') {
              throw new Error(data.message || data.detail || 'The bed could not be reserved')
          }
          setSuccessAdmission(data)
          toast.success("Patient Admitted Successfully")
          setShowAdmissionModal(false)
          fetchAdmissions()
          setRecommendedAdmissions(prev => prev.filter(r => r.patient_id !== selectedRecommendation.patient_id))
      } catch (err: any) {
          toast.error(err.message || "Admission failed")
      } finally {
          setConfirmingAdmission(false)
      }
  }

  const handleInitiateDischarge = async (admission: Admission) => {
      setSelectedDischargeAdmission(admission)
      setDischargeLoading(true)
      setShowDischargeModal(true)
      setDischargeConfirmed(false)
      setDischargeSummary('')
      setFollowUpDate('')
      setFollowUpInstructions('')
      
      try {
          const res = await fetch(`${API_URL}/api/admissions/${admission.id}/cost`)
          const data = await res.json()
          if (data.status === 'success') {
              setDischargeData(data)
              setPaymentAmount(data.total)
              setFinalDiagnosis(admission.diagnosis)
          }
      } catch (err) {
          toast.error("Failed to fetch billing data")
      } finally {
          setDischargeLoading(false)
      }
  }

  const handleGenerateSummary = async () => {
      if (!selectedDischargeAdmission) return
      setProcessLoading(true)
      try {
          const res = await fetch(`${API_URL}/api/discharge/summary/generate`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ admission_id: selectedDischargeAdmission.id })
          })
          const data = await res.json()
          if (data.status === 'success') {
              setDischargeSummary(data.discharge_summary)
              setDischargeData((prev: any) => ({ ...prev, ...data }))
              toast.success("Atlas Summary Generated")
          } else {
              toast.error(data.message || "AI Summary generation failed")
          }
      } catch (err) {
          toast.error("AI Summary generation failed")
      } finally {
          setProcessLoading(false)
      }
  }

  const handleConfirmDischarge = async () => {
      if (!selectedDischargeAdmission || !dischargeSummary) {
          toast.error("Please generate discharge summary")
          return
      }

      setProcessLoading(true)
      try {
          const res = await fetch(`${API_URL}/api/discharge/confirm`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  admission_id: selectedDischargeAdmission.id,
                  patient_id: selectedDischargeAdmission.patient_id,
                  discharge_summary: dischargeSummary,
                  final_diagnosis: finalDiagnosis,
                  follow_up_date: followUpDate,
                  follow_up_instructions: followUpInstructions,
                  medications_on_discharge: dischargeData?.medications || [],
                  total_days: dischargeData?.days,
                  room_cost: dischargeData?.room_cost,
                  test_cost: dischargeData?.test_cost,
                  total_cost: dischargeData?.total,
                  payment_amount: paymentAmount,
                  discharged_by: user?.name
              })
          })
          const data = await res.json()
          if (data.status === 'success') {
              toast.success("Patient Discharged Successfully")
              setDischargeConfirmed(true)
              fetchAdmissions()
          } else {
              toast.error(data.message || "Discharge failed")
          }
      } catch (err) {
          toast.error("Discharge processing failed")
      } finally {
          setProcessLoading(false)
      }
  }

  /**
   * The two buttons on the discharge screen hand the patient two different
   * pieces of paper: a clinical summary they take to their next doctor, and a
   * billing receipt for their records. Printing the dashboard itself gives them
   * neither, so each one is rendered into its own print window.
   */
  const handlePrint = (type: 'summary' | 'receipt') => {
      const adm = selectedDischargeAdmission
      if (!adm) return

      const patientName = adm.patients?.name || 'Patient'
      const velaId = adm.patients?.vela_id || '—'
      const today = new Date().toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })
      const money = (n: number | undefined) => `₹${Number(n || 0).toLocaleString('en-IN')}`
      const esc = (s: string) =>
          String(s ?? '').replace(/[&<>"']/g, (c) =>
              ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))

      const body = type === 'summary'
          ? `
            <h2>Discharge Summary</h2>
            <dl>
              <dt>Final diagnosis</dt><dd>${esc(finalDiagnosis || adm.diagnosis || '—')}</dd>
              <dt>Ward &amp; bed</dt><dd>${esc(adm.wards?.name || '—')} · Bed ${esc(adm.beds?.bed_number || '—')}</dd>
              <dt>Length of stay</dt><dd>${dischargeData?.days ?? '—'} day(s)</dd>
              <dt>Follow-up</dt><dd>${esc(followUpDate || 'Not scheduled')}</dd>
            </dl>
            <h3>Clinical summary</h3>
            <p class="prose">${esc(dischargeSummary || 'No summary recorded.')}</p>
            ${followUpInstructions ? `<h3>Follow-up instructions</h3><p class="prose">${esc(followUpInstructions)}</p>` : ''}
            <p class="sign">Discharged by ${esc(user?.name || 'Reception')}</p>
          `
          : `
            <h2>Payment Receipt</h2>
            <dl>
              <dt>Admitted</dt><dd>${adm.admitted_at ? new Date(adm.admitted_at).toLocaleDateString('en-IN') : '—'}</dd>
              <dt>Discharged</dt><dd>${today}</dd>
              <dt>Length of stay</dt><dd>${dischargeData?.days ?? '—'} day(s)</dd>
            </dl>
            <table>
              <tr><td>Room &amp; ward charges</td><td>${money(dischargeData?.room_cost)}</td></tr>
              <tr><td>Laboratory &amp; diagnostic tests</td><td>${money(dischargeData?.test_cost)}</td></tr>
              <tr class="total"><td>Total</td><td>${money(dischargeData?.total)}</td></tr>
              <tr><td>Amount paid (${esc(paymentMethod)})</td><td>${money(paymentAmount)}</td></tr>
            </table>
            <p class="sign">Received by ${esc(user?.name || 'Reception')}</p>
          `

      const win = window.open('', '_blank', 'width=820,height=1000')
      if (!win) {
          toast.error('Allow pop-ups to print this document')
          return
      }
      win.document.write(`<!doctype html><html><head><meta charset="utf-8">
        <title>${type === 'summary' ? 'Discharge Summary' : 'Receipt'} — ${esc(patientName)}</title>
        <style>
          body{font:14px/1.6 -apple-system,Segoe UI,sans-serif;color:#1B2A44;margin:48px;}
          header{border-bottom:2px solid #1B2A44;padding-bottom:16px;margin-bottom:28px;}
          h1{font-size:20px;margin:0 0 4px;letter-spacing:-0.01em;}
          h2{font-size:16px;margin:0 0 20px;text-transform:uppercase;letter-spacing:.16em;}
          h3{font-size:12px;text-transform:uppercase;letter-spacing:.16em;color:#516079;margin:24px 0 8px;}
          .meta{color:#516079;font-size:12px;}
          dl{display:grid;grid-template-columns:180px 1fr;gap:6px 16px;margin:0 0 8px;}
          dt{color:#516079;font-size:12px;text-transform:uppercase;letter-spacing:.1em;}
          dd{margin:0;}
          .prose{white-space:pre-wrap;}
          table{width:100%;border-collapse:collapse;margin-top:12px;}
          td{padding:10px 0;border-bottom:1px solid #E4EAF2;}
          td:last-child{text-align:right;font-variant-numeric:tabular-nums;}
          .total td{font-weight:700;border-bottom:2px solid #1B2A44;}
          .sign{margin-top:48px;color:#516079;font-size:12px;}
          @media print{body{margin:24px;}}
        </style></head><body>
        <header>
          <h1>${esc(patientName)}</h1>
          <div class="meta">VELA ID ${esc(velaId)} · ${today}</div>
        </header>
        ${body}
        </body></html>`)
      win.document.close()
      win.focus()
      win.print()
  }

  useEffect(() => {
    const ctx = gsap.context(() => {
        gsap.fromTo('.fade-in-up', 
            { y: 30, opacity: 0 },
            { y: 0, opacity: 1, duration: 1, stagger: 0.1, ease: 'power4.out', delay: 0.2 }
        )
    }, containerRef)
    return () => ctx.revert()
  }, [])

  useEffect(() => {
    if (isScanning) {
      const scanner = new Html5QrcodeScanner(
        "qr-reader",
        { fps: 10, qrbox: { width: 250, height: 250 } },
        false
      )
      scanner.render(async (decodedText) => {
        scanner.clear()
        setIsScanning(false)
        const vId = decodedText.trim()
        setLookupId(vId)
        setLookupLoading(true)
        try {
            const res = await fetch(`${API_URL}/api/receptionist/lookup/${encodeURIComponent(vId)}`)
            const data = await res.json()
            if (!res.ok || data.status !== 'success') throw new Error('Patient not found')
            setLookupPatient(data.patient)
            toast.success(`Found ${data.patient.name}`)
        } catch (err: any) {
            toast.error(err.message)
            setLookupPatient(null)
        } finally {
            setLookupLoading(false)
        }
      }, () => {})
      return () => {
         scanner.clear().catch(e => console.log(e))
      }
    }
  }, [isScanning])

  useEffect(() => {
    fetchQueue()
    fetchAppointments()
    fetchNotifications()
    fetchDoctorStats()
    const interval = setInterval(() => {
        fetchQueue()
        fetchAppointments()
        fetchNotifications()
        fetchDoctorStats()
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    if (activeTab === 'tests') { fetchTestOrders(); fetchArrivals() }
    if (activeTab === 'catalog') fetchCatalog()
    if (activeTab === 'admissions') fetchAdmissions()
    if (activeTab === 'queue') fetchQueue()
    if (activeTab === 'doctors') fetchDoctorStats()
  }, [activeTab])

  useEffect(() => {
    if (!socket) return

    socket.on('test_ordered', (data: SocketEventPayload) => {
      toast(`New test order for ${data.patient_name}`, { icon: '🔬' })
      if (activeTab === 'tests') fetchTestOrders()
      fetchNotifications()
    })

    // A patient paid on their phone — they now show up on the arrivals board.
    socket.on('payment_confirmed', () => {
      if (activeTab === 'tests') { fetchTestOrders(); fetchArrivals() }
    })

        socket.on('admission_recommended', (data: SocketEventPayload) => {
            setRecommendedAdmissions(prev => {
                // Avoid duplicates
                if (prev.some(r => r.patient_id === data.patient_id)) return prev
                return [data, ...prev]
            })
            toast(`AI Recommends Admission: ${data.patient_name}`, { 
                icon: '🏥',
                duration: 6000
            })
            fetchNotifications()
        })

        socket.on('discharge_recommended', (data: SocketEventPayload) => {
            toast(`Discharge Recommended: ${data.patient_name}`, { 
                icon: '🏠',
                duration: 6000,
                style: { border: '1px solid #f59e0b' }
            })
            fetchNotifications()
            if (activeTab === 'admissions') fetchAdmissions()
        })

    return () => {
      socket.off('test_ordered')
      socket.off('payment_confirmed')
      socket.off('admission_recommended')
      socket.off('discharge_recommended')
    }
  }, [socket, activeTab])

  useEffect(() => {
    if (!socket) return

    const refreshQueue = () => fetchQueue()

    const nextPatientHandler = (data: SocketEventPayload) => {
        if (data?.atlas_summary) {
            toast('Next patient called', { icon: '📢' })
        }
        fetchQueue()
    }

    const handleDoctorStateChange = (data: SocketEventPayload) => {
        toast(`${data.name} operational status: ${data.status}`, { icon: '🧑‍⚕️' })
        fetchDoctorStats()
    }

    const handleQueuePositionUpdate = () => {
        fetchQueue()
    }

    // A patient can raise an emergency from their own phone. The ticket already
    // sorts to the front of the queue, but a silent re-sort is not an alert —
    // the desk needs to know someone is on their way in.
    const emergencyHandler = (data: SocketEventPayload) => {
      toast(
        `EMERGENCY — ${data.patient_name || 'Patient'} incoming${data.ticket_number ? ` · ${data.ticket_number}` : ''}${data.notes ? `\n${data.notes}` : ''}`,
        { icon: '🚨', duration: 20000, style: { border: '2px solid var(--danger)', color: 'var(--danger)', fontWeight: 600 } },
      )
      fetchQueue()
      fetchNotifications()
    }
    socket.on('emergency_intake', emergencyHandler)

    socket.on('queue_updated', refreshQueue)
    socket.on('patient_registered', refreshQueue)
    socket.on('patient_completed', refreshQueue)
    socket.on('next_patient', nextPatientHandler)
    socket.on('doctor_state_change', handleDoctorStateChange)
    socket.on('queue_position_update', handleQueuePositionUpdate)
    socket.on('new_notification', (data: SocketEventPayload) => {
        if (data.role === 'receptionist') {
            fetchNotifications()
            // A booking arriving as a notification should also refresh the
            // appointment list — otherwise a patient's booking stays invisible
            // until a manual page reload.
            fetchAppointments()
            toast('New update received', { icon: '🔔' })
        }
    })

    // Always refresh the appointment list on a new booking, whether or not this
    // receptionist is scoped to a specific hospital room.
    const handleNewAppointment = (data: SocketEventPayload) => {
      toast(`New appointment: ${data.patient_name || 'Patient'}${data.date ? ` on ${data.date}` : ''}${data.time ? ` at ${data.time}` : ''}`, { icon: '📅', duration: 8000 })
      fetchAppointments()
    }
    socket.on('new_appointment', handleNewAppointment)

    // Join hospital room & network room
    if (hospitalId) {
      socket.emit('join_hospital', { hospital_id: hospitalId })
      socket.emit('join_room', { room: `hospital_${hospitalId}` })
    }

    return () => {
        socket.off('emergency_intake', emergencyHandler)
        socket.off('queue_updated', refreshQueue)
        socket.off('patient_registered', refreshQueue)
        socket.off('patient_completed', refreshQueue)
        socket.off('next_patient', nextPatientHandler)
        socket.off('doctor_state_change', handleDoctorStateChange)
        socket.off('queue_position_update', handleQueuePositionUpdate)
        socket.off('new_notification')
        socket.off('new_appointment', handleNewAppointment)
    }
  }, [socket, hospitalId])

  /**
   * EMERGENCY INTAKE — the one path that must work under pressure.
   *
   * A real front desk in an emergency has seconds and no paperwork: someone is
   * brought in, often without ID, sometimes unconscious. So this asks for a
   * name (optional — falls back to "Unknown patient") and nothing else, then
   * does registration + triage-emergency ticket + broadcast in a single action.
   * Everything else about the patient can be filled in later from the record.
   */
  const handleEmergencyIntake = async () => {
    if (emergencySubmitting) return
    setEmergencySubmitting(true)
    const label = emergencyName.trim() || 'Unknown patient'
    try {
      // 1. Register a minimal record
      const regRes = await fetch(`${API_URL}/api/receptionist/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: label,
          age: emergencyAge.trim() ? Number(emergencyAge) : 0,
          gender: 'Unknown',
          ward: 'Emergency',
          diagnosis: emergencyNote.trim() || 'Emergency walk-in — triage pending',
          registered_by: 'receptionist',
          hospital_id: hospitalId,
        }),
      })
      const regData = await regRes.json()
      if (!regRes.ok || regData.status !== 'success') {
        throw new Error(regData.message || 'Could not register emergency patient')
      }
      const patient = regData.patient

      // 2. Emergency ticket — triage_level puts them at the front of the queue
      const tRes = await fetch(`${API_URL}/api/receptionist/ticket/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          vela_id: patient.vela_id,
          department: 'Emergency',
          triage_level: 'Emergency',
          notes: emergencyNote.trim() || 'EMERGENCY — immediate attention required',
          hospital_id: hospitalId,
        }),
      })
      const tData = await tRes.json()
      if (!tRes.ok || tData.status !== 'success') {
        throw new Error(tData.message || 'Patient registered but ticket failed — use Console')
      }

      toast.success(`${label} sent to the front of the queue`, { icon: '🚨', duration: 7000 })
      setEmergencyName('')
      setEmergencyAge('')
      setEmergencyNote('')
      setEmergencyOpen(false)
      setLastEmergency({ name: label, vela_id: patient.vela_id, ticket: tData.ticket_number })
      fetchQueue()
    } catch (err: any) {
      toast.error(err.message || 'Emergency intake failed', { duration: 8000 })
    } finally {
      setEmergencySubmitting(false)
    }
  }

  const handleRegisterChange = (key: string, value: string) => {
    setRegisterForm((prev) => ({ ...prev, [key]: value }))
  }

  const handleRegisterSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!registerForm.name || !registerForm.age || !registerForm.gender) {
      toast.error('Required fields missing')
      return
    }

    setRegistering(true)
    try {
      const res = await fetch(`${API_URL}/api/receptionist/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...registerForm,
          hospital_id: hospitalId
        })
      })

      const data = await res.json()
      if (!res.ok || data.status !== 'success') throw new Error(data.message)

      const patient: Patient = data.patient
      setRegisteredPatient(patient)
      toast.success(`Registered ${patient.name}`)
      
      setRegisterForm(prev => ({
        ...prev, name: '', age: '', gender: 'Male', blood_group: '', height: '', weight: '', allergies: '', existing_conditions: '', emergency_contact: '', diagnosis: '', room: '', doctor: ''
      }))
      fetchQueue()
    } catch (err: any) {
      toast.error(err.message || 'Registration failed')
    } finally {
      setRegistering(false)
    }
  }

  const handleLookup = async () => {
    if (!lookupId.trim()) return
    setLookupLoading(true)
    try {
        const res = await fetch(`${API_URL}/api/receptionist/lookup/${encodeURIComponent(lookupId.trim())}`)
        const data = await res.json()
        if (!res.ok || data.status !== 'success') throw new Error('Patient not found')
        setLookupPatient(data.patient)
        toast.success(`Found ${data.patient.name}`)
    } catch (err: any) {
        toast.error(err.message)
        setLookupPatient(null)
    } finally {
        setLookupLoading(false)
    }
  }

  const handleCreateTicket = async () => {
    const patient = lookupPatient || registeredPatient
    if (!patient?.vela_id) {
        toast.error('No patient selected')
        return
    }

    setTicketCreating(true)
    try {
        const res = await fetch(`${API_URL}/api/receptionist/ticket/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                vela_id: patient.vela_id,
                department: ticketDepartment,
                notes: ticketNotes,
                hospital_id: hospitalId,
                doctor_id: selectedTicketDoctor || null
            })
        })
        const data = await res.json()
        if (!res.ok || data.status !== 'success') throw new Error(data.message)

        toast.success(`Ticket #${data.ticket_number} created`)
        setTicketNotes('')
        setSelectedTicketDoctor('')
        fetchQueue()
        if (registeredPatient) setRegisteredPatient(null)
        if (lookupPatient) setLookupPatient(null)
        setLookupId('')
    } catch (err: any) {
        toast.error(err.message || 'Ticket creation failed')
    } finally {
        setTicketCreating(false)
    }
  }

  const handleUpload = async () => {
      if (!uploadFile || !lookupPatient) return
      setUploading(true)
      setUploadResult(null)

      const formData = new FormData()
      formData.append("file", uploadFile)
      formData.append("patient_id", lookupPatient.id)

      try {
          const res = await fetch(`${API_URL}/api/upload/document`, {
              method: "POST",
              body: formData
          })
          const data = await res.json()
          setUploadResult(data)
          setUploadFile(null)
          toast.success("Document analyzed")
      } catch {
          toast.error("Upload failed")
      } finally {
          setUploading(false)
      }
  }

  /**
   * How long a ticket has been waiting. The backend sends `wait_minutes` on some
   * queue payloads and omits it on others, so this falls back to `created_at`
   * rather than rendering "undefinedm" on screen.
   */
  const waitMinutes = (item: { wait_minutes?: number; created_at?: string }) => {
    if (typeof item.wait_minutes === 'number') return item.wait_minutes
    if (!item.created_at) return 0
    return Math.max(0, Math.floor((Date.now() - new Date(item.created_at).getTime()) / 60000))
  }

  /**
   * Longest current wait, in minutes. This is the number that tells a
   * receptionist whether the desk is coping — a queue of 3 with someone waiting
   * 50 minutes is a worse situation than a queue of 8 all just arrived, and the
   * raw count alone hides that completely.
   */
  const longestWait = useMemo(() => {
    const waiting = queue.filter((q) => q.status === 'waiting')
    if (!waiting.length) return 0
    return waiting.reduce((max, t) => Math.max(max, waitMinutes(t)), 0)
  }, [queue])

  // Register and Directory are two halves of one section, so the rail treats
  // them as a single destination and the strip below splits them.
  const isConsole = activeTab === 'register' || activeTab === 'lookup'

  const sectionTitle = ({
    queue: 'Live Queue',
    doctors: 'Doctors Directory',
    admissions: 'Admissions',
    appointments: 'Appointments',
    tests: 'Tests & Payments',
    catalog: 'Test Catalog',
  } as Record<string, string>)[activeTab] || 'Console'

  // The queue already lives permanently in the right rail. Opening it as a
  // section means the receptionist wants the long view, so it takes the page
  // and the rail steps aside rather than showing the same list twice.
  const queueIsFocused = activeTab === 'queue'

  const formatDate = () => {
    return new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })
  }

  return (
    <div className="flex min-h-screen bg-canvas text-ink font-sans selection:bg-brand/30">
      <div className="noise-overlay pointer-events-none z-0"></div>
      
      
      <aside 
        className={`${sidebarExpanded ? 'w-[280px]' : 'w-[80px]'} fixed left-0 top-0 h-full bg-ink border-r border-white/[0.08] z-50 transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] flex flex-col justify-between py-8 group`}
        onMouseEnter={() => setSidebarExpanded(true)}
        onMouseLeave={() => setSidebarExpanded(false)}
      >
        <div className="flex flex-col gap-4 px-4">
          <div className="flex items-center gap-4 px-3 mb-12 h-10">
            <div className="w-8 h-8 flex items-center justify-center shrink-0">
               <img src="/vela-icon.png" alt="Vela" style={{ height: 32, width: "auto" }} />
            </div>
            <span className={`text-white font-serif italic text-3xl tracking-wide whitespace-nowrap overflow-hidden transition-all duration-300 ${sidebarExpanded ? 'opacity-100 max-w-[200px]' : 'opacity-0 max-w-0'}`}>
                VELA
            </span>
          </div>
          
          {[
            { label: 'Console', icon: Monitor, active: activeTab === 'register' || activeTab === 'lookup', onClick: () => setActiveTab('register') },
            { label: 'Queue', icon: Users, active: activeTab === 'queue', onClick: () => setActiveTab('queue') },
            { label: 'Doctors', icon: Stethoscope, active: activeTab === 'doctors', onClick: () => { setActiveTab('doctors'); fetchDoctorStats(); } },
            { label: 'Admissions', icon: Activity, active: activeTab === 'admissions', onClick: () => setActiveTab('admissions') },
            { label: 'Appointments', icon: Calendar, active: activeTab === 'appointments', onClick: () => setActiveTab('appointments') },
            { label: 'Tests & Payments', icon: CreditCard, active: activeTab === 'tests', onClick: () => setActiveTab('tests') },
            { label: 'Test Catalog', icon: FlaskConical, active: activeTab === 'catalog', onClick: () => setActiveTab('catalog') },
          ].map((item, i) => (
            <button 
              key={i} 
              onClick={item.onClick}
              className={`w-full group relative flex items-center h-11 px-3 rounded-xl transition-all duration-300 ${
                item.active 
                  ? 'bg-brand text-white shadow-lg shadow-brand-light/20' 
                  : 'text-ink-3 hover:text-white hover:bg-white/[0.06]'
              }`}
            >
              <div className="w-8 h-8 flex items-center justify-center shrink-0">
                <item.icon size={20} strokeWidth={1.5} className="flex-shrink-0" />
              </div>
              <span className={`ml-3 font-mono text-[10px] uppercase tracking-[0.2em] whitespace-nowrap overflow-hidden transition-all duration-300 ${sidebarExpanded ? 'opacity-100 max-w-[200px]' : 'opacity-0 max-w-0'}`}>
                {item.label}
              </span>
            </button>
          ))}
        </div>

        <div className="px-4">
           <button 
             type="button" 
             onClick={logout} 
             className="w-full flex items-center h-11 px-3 rounded-xl text-ink-3 hover:text-white hover:bg-danger/20 transition-all duration-300"
           >
             <div className="w-8 h-8 flex items-center justify-center shrink-0">
               <LogOut size={20} strokeWidth={1.5} className="flex-shrink-0" />
             </div>
             <span className={`ml-3 font-mono text-[10px] uppercase tracking-[0.2em] whitespace-nowrap overflow-hidden transition-all duration-300 ${sidebarExpanded ? 'opacity-100 max-w-[200px]' : 'opacity-0 max-w-0'}`}>
                Logout
             </span>
           </button>
        </div>
      </aside>

      <main 
        ref={containerRef}
        className="flex-1 transition-all duration-500 ease-[cubic-bezier(0.23,1,0.32,1)] relative z-10"
        style={{ marginLeft: sidebarExpanded ? '280px' : '80px' }}
      >
        <div className="max-w-[1600px] mx-auto p-12 lg:p-16">
            
            {/* ── EMERGENCY BAR ──────────────────────────────────────
                Always first in the DOM and always on screen. Nothing about it
                depends on which tab is open. */}
            <div className="mb-10">
              {!emergencyOpen ? (
                <div className="flex flex-wrap items-center justify-between gap-6 p-6 bg-danger-tint border-l-[3px] border-danger">
                  <div>
                    <div className="label-mono mb-2 text-danger">Emergency</div>
                    <p className="text-[14px] text-ink-2">
                      Walk-in needing immediate attention — registers and jumps the queue in one step.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setEmergencyOpen(true)}
                    className="flex items-center gap-3 px-8 py-4 border-none cursor-pointer transition-transform duration-200 hover:-translate-y-0.5 bg-danger text-white"
                  >
                    <AlertTriangle size={17} />
                    <span className="text-[15px] font-semibold">Emergency intake</span>
                  </button>
                </div>
              ) : (
                <div className="p-8 bg-danger-tint border-l-[3px] border-danger">
                  <div className="flex items-center justify-between mb-6">
                    <div className="label-mono flex items-center gap-2.5 text-danger">
                      <span className="w-2 h-2 rounded-full animate-pulse bg-danger" />
                      Emergency intake
                    </div>
                    <button type="button" onClick={() => setEmergencyOpen(false)}
                            className="bg-transparent border-none cursor-pointer p-0 text-ink-3">
                      <X size={16} />
                    </button>
                  </div>

                  <p className="text-[13px] mb-6 text-ink-2">
                    Name optional — leave blank for an unidentified patient. Details can be completed later.
                  </p>

                  <div className="grid grid-cols-1 md:grid-cols-[1.4fr_0.5fr_1.6fr] gap-5 mb-7">
                    <input
                      autoFocus
                      value={emergencyName}
                      onChange={(e) => setEmergencyName(e.target.value)}
                      placeholder="Patient name (optional)"
                      className="bg-transparent text-[16px] py-2.5 outline-none text-ink border-b border-danger-soft"
                    />
                    <input
                      value={emergencyAge}
                      onChange={(e) => setEmergencyAge(e.target.value.replace(/\D/g, ''))}
                      placeholder="Age"
                      inputMode="numeric"
                      className="bg-transparent text-[16px] py-2.5 outline-none text-ink border-b border-danger-soft"
                    />
                    <input
                      value={emergencyNote}
                      onChange={(e) => setEmergencyNote(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleEmergencyIntake() }}
                      placeholder="Presenting complaint — e.g. chest pain, RTA, unconscious"
                      className="bg-transparent text-[16px] py-2.5 outline-none text-ink border-b border-danger-soft"
                    />
                  </div>

                  <button
                    type="button"
                    onClick={handleEmergencyIntake}
                    disabled={emergencySubmitting}
                    className="flex items-center gap-3 px-8 py-4 border-none cursor-pointer bg-danger text-white transition-transform duration-200 hover:-translate-y-0.5 disabled:opacity-60 disabled:hover:translate-y-0"
                  >
                    <AlertTriangle size={17} />
                    <span className="text-[15px] font-semibold">
                      {emergencySubmitting ? 'Admitting…' : 'Admit now — front of queue'}
                    </span>
                  </button>
                </div>
              )}

              {lastEmergency && (
                <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-4 mt-px bg-surface-2">
                  <span className="text-[13px] text-ink-2">
                    <strong className="text-ink">{lastEmergency.name}</strong> admitted ·{' '}
                    {lastEmergency.vela_id} · Ticket {lastEmergency.ticket}
                  </span>
                  <button type="button" onClick={() => setLastEmergency(null)}
                          className="bg-transparent border-none cursor-pointer p-0">
                    <span className="label-mono">Dismiss</span>
                  </button>
                </div>
              )}
            </div>

            <header className="flex justify-between items-end mb-16 border-b border-line pb-8 fade-in-up">
                <div>
                    <h1 className="display text-[52px] md:text-[64px] leading-none m-0 text-ink">
                        {user?.name ? user.name.replace(/^(dr\.|dr\s)/i, '').trim() : 'Reception'}
                    </h1>
                    <div className="label-mono mt-6">
                        {formatDate()} · Front desk operational
                    </div>
                </div>
                <div className="flex gap-10 items-center">
                    <div className="text-right">
                        <div className="display text-[46px] leading-none mb-1.5 text-ink">
                          {queue.filter(q => q.status === 'waiting').length}
                        </div>
                        <div className="label-mono">Waiting</div>
                    </div>
                    <div className="text-right">
                        <div className="display text-[46px] leading-none mb-1.5 text-ink">
                          {queue.filter(q => q.status === 'in-progress').length}
                        </div>
                        <div className="label-mono">Consulting</div>
                    </div>
                    <div className="text-right">
                        <div className={`display text-[46px] leading-none mb-1.5 ${longestWait > 30 ? 'text-danger' : 'text-ink'}`}>
                          {longestWait}<span className="text-[20px]">m</span>
                        </div>
                        <div className={`label-mono ${longestWait > 30 ? 'text-danger' : ''}`}>
                          Longest wait
                        </div>
                    </div>
                    <div className="relative">
                        <button 
                            type="button"
                            onClick={() => setShowNotifications(!showNotifications)}
                            className={`p-3 rounded-full transition-all ${notifications.some(n => !n.is_read) ? 'bg-brand-tint text-brand animate-pulse' : 'bg-canvas text-ink-3 hover:bg-line-soft'}`}
                        >
                            <Bell size={24} />
                            {notifications.some(n => !n.is_read) && (
                                <span className="absolute top-2 right-2 w-3 h-3 bg-danger border-2 border-white rounded-full"></span>
                            )}
                        </button>

                        {showNotifications && (
                            <div className="absolute right-0 mt-4 w-[320px] bg-white border border-line shadow-2xl z-[100] rounded-2xl overflow-hidden animate-in fade-in slide-in-from-top-4">
                                <div className="p-4 border-b border-line-soft flex justify-between items-center bg-canvas">
                                    <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink">Notifications</span>
                                    <button onClick={() => setShowNotifications(false)} className="text-ink-3 hover:text-ink"><X size={14} /></button>
                                </div>
                                <div className="max-h-[400px] overflow-y-auto">
                                    {notifications.length === 0 ? (
                                        <div className="p-8 text-center text-ink-3 font-mono text-[10px] uppercase tracking-widest">No alerts</div>
                                    ) : (
                                        notifications.map((n) => (
                                            <div 
                                                key={n.id} 
                                                className={`p-4 border-b border-canvas hover:bg-canvas transition-colors cursor-pointer ${!n.is_read ? 'bg-brand-tint/30' : ''}`}
                                                onClick={() => markNotificationRead(n.id)}
                                            >
                                                <div className="flex justify-between items-start mb-1">
                                                    <span className="font-bold text-xs text-ink">{n.title}</span>
                                                    <span className="text-[9px] text-ink-3 font-mono">{new Date(n.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                                </div>
                                                <p className="text-[11px] text-ink-2 leading-relaxed font-light">{n.message}</p>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </header>

            <div className="grid grid-cols-12 gap-12">
                
                <div className={`${queueIsFocused ? 'col-span-12' : 'col-span-12 lg:col-span-7'} fade-in-up`}>
                    <div className="sticky top-12">
                        {/* The rail on the left is the only place you change section.
                            This strip switches between the two halves of the Console —
                            taking a new patient in, and finding one already on file. */}
                        {isConsole ? (
                            <div className="flex border-b border-line mb-12">
                                {([
                                    ['register', 'Register Patient'],
                                    ['lookup', 'Directory & Triage'],
                                ] as const).map(([id, label]) => (
                                    <button
                                        key={id}
                                        onClick={() => setActiveTab(id)}
                                        className={`pb-4 px-4 font-mono text-[10px] uppercase tracking-[0.2em] mr-8 transition-colors ${activeTab === id ? 'border-b border-brand text-ink font-bold' : 'text-ink-2 hover:text-ink'}`}
                                    >
                                        {label}
                                    </button>
                                ))}
                            </div>
                        ) : (
                            <div className="flex items-baseline gap-4 border-b border-line pb-4 mb-12">
                                <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink font-bold">
                                    {sectionTitle}
                                </span>
                            </div>
                        )}

                        {activeTab === 'register' && (
                            <form ref={formRef} onSubmit={handleRegisterSubmit} className="grid grid-cols-2 gap-x-8 gap-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                <div className="col-span-2 mb-2">
                                    <h3 className="font-serif italic text-3xl text-ink font-light">Registration Details</h3>
                                </div>
                                <Input label="Full Name" value={registerForm.name} onChange={e => handleRegisterChange('name', e.target.value)} required />
                                <div className="grid grid-cols-2 gap-6">
                                    <Input label="Age" type="number" value={registerForm.age} onChange={e => handleRegisterChange('age', e.target.value)} required />
                                    <div>
                                        <label className="block font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-2 ml-1">Gender</label>
                                        <select 
                                            value={registerForm.gender} 
                                            onChange={e => handleRegisterChange('gender', e.target.value)}
                                            className="w-full bg-transparent border-b border-line-strong rounded-none px-2 py-3 font-sans text-ink focus:outline-none focus:border-line-strong transition-colors appearance-none"
                                        >
                                            <option className="bg-canvas">Male</option>
                                            <option className="bg-canvas">Female</option>
                                            <option className="bg-canvas">Other</option>
                                        </select>
                                    </div>
                                </div>
                                <Input label="Blood Type" value={registerForm.blood_group} onChange={e => handleRegisterChange('blood_group', e.target.value)} placeholder="e.g. O+" />
                                <Input label="Emergency Contact" value={registerForm.emergency_contact} onChange={e => handleRegisterChange('emergency_contact', e.target.value)} />

                                <div className="grid grid-cols-2 gap-6">
                                    <Input label="Height (cm)" type="number" value={registerForm.height} onChange={e => handleRegisterChange('height', e.target.value)} placeholder="e.g. 172" />
                                    <Input label="Weight (kg)" type="number" value={registerForm.weight} onChange={e => handleRegisterChange('weight', e.target.value)} placeholder="e.g. 68" />
                                </div>
                                <div>
                                    <label className="block font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-2 ml-1">Preferred Language</label>
                                    <select
                                        value={registerForm.language}
                                        onChange={e => handleRegisterChange('language', e.target.value)}
                                        className="w-full bg-transparent border-b border-line-strong rounded-none px-2 py-3 font-sans text-ink focus:outline-none focus:border-line-strong transition-colors appearance-none"
                                    >
                                        {['English', 'Hindi', 'Marathi', 'Tamil', 'Telugu', 'Bengali', 'Kannada', 'Malayalam', 'Gujarati'].map(l => (
                                            <option key={l} className="bg-canvas">{l}</option>
                                        ))}
                                    </select>
                                </div>

                                <div className="col-span-2 mt-8 mb-2">
                                    <h3 className="font-serif italic text-3xl text-ink font-light">Medical Context</h3>
                                </div>
                                <div>
                                    <label className="block font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-2 ml-1">Intake Ward</label>
                                    <select
                                        value={registerForm.ward}
                                        onChange={e => handleRegisterChange('ward', e.target.value)}
                                        className="w-full bg-transparent border-b border-line-strong rounded-none px-2 py-3 font-sans text-ink focus:outline-none focus:border-line-strong transition-colors appearance-none"
                                    >
                                        {['General', 'Cardiology', 'Neurology', 'Paediatrics', 'Orthopaedics', 'Emergency'].map(w => (
                                            <option key={w} className="bg-canvas">{w}</option>
                                        ))}
                                    </select>
                                </div>
                                <Input label="Presenting Complaint" value={registerForm.diagnosis} onChange={e => handleRegisterChange('diagnosis', e.target.value)} placeholder="Reason for visit" />
                                <Input label="Allergies" value={registerForm.allergies} onChange={e => handleRegisterChange('allergies', e.target.value)} className="col-span-2" />
                                <Input label="Existing Conditions" value={registerForm.existing_conditions} onChange={e => handleRegisterChange('existing_conditions', e.target.value)} className="col-span-2" />
        
                                <div className="col-span-2 mt-12 flex items-center justify-between border-t border-line pt-8">
                                    {registeredPatient && (
                                       <div className="font-mono text-xs text-ink flex items-center gap-3">
                                           <span className="w-2 h-2 rounded-full bg-success animate-pulse"></span>
                                           System ID: {registeredPatient.vela_id}
                                       </div>
                                    )}
                                    <button 
                                        type="submit" 
                                        disabled={registering}
                                        className="ml-auto bg-brand text-white px-12 py-4 text-xs hover:bg-brand-dark disabled:opacity-50 transition-all uppercase tracking-[0.2em] font-mono shadow-lg shadow-brand-light/20 rounded-xl"
                                    >
                                        {registering ? 'Processing...' : 'Generate Record'}
                                    </button>
                                </div>
                            </form>
                        )}

                        {activeTab === 'queue' && (
                            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                <div className="flex items-center justify-between mb-4">
                                    <h3 className="font-serif italic text-4xl text-ink font-light">Live Queue</h3>
                                    <div className="flex items-center gap-4">
                                        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-brand">
                                            {queue.filter(q => q.status === 'waiting').length} Waiting · {queue.filter(q => q.status === 'in-progress').length} In Progress
                                        </span>
                                        <button onClick={fetchQueue} className="p-2 text-ink-3 hover:text-ink transition-colors">
                                            <RefreshCw size={16} />
                                        </button>
                                    </div>
                                </div>

                                {queueLoading ? (
                                    <div className="p-16 text-center">
                                        <div className="w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                                        <p className="font-mono text-[10px] text-ink-3 uppercase tracking-widest">Syncing queue...</p>
                                    </div>
                                ) : queue.length === 0 ? (
                                    <div className="p-16 border border-line-soft bg-canvas/50 rounded-2xl text-center">
                                        <p className="font-serif italic text-2xl text-ink-3 mb-2">Queue is empty</p>
                                        <p className="font-mono text-[10px] text-ink-3 uppercase tracking-widest">No patients waiting</p>
                                    </div>
                                ) : (
                                    <div className="flex flex-col gap-3">
                                        {queue.map((item, idx) => {
                                            const waitMins = waitMinutes(item)
                                            const isWaiting = item.status === 'waiting'
                                            return (
                                                <div key={item.id || idx} className={`flex items-center gap-6 p-6 border rounded-2xl transition-all ${isWaiting ? 'border-brand-soft bg-brand-tint/30' : 'border-line-soft bg-white'}`}>
                                                    <div className="font-mono text-3xl text-line-strong w-10 text-center font-bold">
                                                        {String(item.queue_position || idx + 1).padStart(2, '0')}
                                                    </div>
                                                    <div className="flex-1">
                                                        <div className="font-serif italic text-2xl text-ink mb-1">{item.patient_name}</div>
                                                        <div className="flex gap-4 font-mono text-[10px] text-ink-3 uppercase tracking-widest">
                                                            <span>TKT {item.ticket_number}</span>
                                                            <span>{item.department || 'General'}</span>
                                                            {item.notes && <span className="text-ink-2 normal-case not-italic font-sans text-xs truncate max-w-[200px]">{item.notes}</span>}
                                                        </div>
                                                    </div>
                                                    <div className="text-right">
                                                        <div className={`font-mono text-[10px] uppercase tracking-widest px-3 py-1.5 rounded-full border ${isWaiting ? 'text-brand border-brand-soft bg-brand-tint' : 'text-ink-2 border-line bg-canvas'}`}>
                                                            {isWaiting ? `${waitMins}m wait` : 'In Progress'}
                                                        </div>
                                                    </div>
                                                </div>
                                            )
                                        })}
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'admissions' && (
                            <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                <div>
                                    <h3 className="font-serif italic text-4xl text-ink font-light mb-8">Admission Intelligence</h3>
                                    
                                    {recommendedAdmissions.length === 0 ? (
                                        <div className="p-12 border border-line-soft bg-canvas/50 rounded-2xl text-center">
                                            <p className="font-mono text-[10px] text-ink-3 uppercase tracking-widest">No pending AI recommendations</p>
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-1 gap-6">
                                            {recommendedAdmissions.map((rec, i) => (
                                                <div key={i} className="bg-white border-2 border-brand/20 p-8 rounded-2xl shadow-sm hover:shadow-xl transition-all relative overflow-hidden">
                                                    <div className="absolute top-0 right-0 px-4 py-2 bg-brand text-white font-mono text-[9px] uppercase tracking-widest rounded-bl-xl">Atlas Recommendation</div>
                                                    <div className="flex justify-between items-start mb-6">
                                                        <div>
                                                            <h4 className="font-serif italic text-3xl text-ink mb-2">{rec.patient_name}</h4>
                                                            <div className="font-mono text-[10px] text-ink-2 uppercase tracking-widest flex items-center gap-3">
                                                                Ward: <span className="text-brand font-bold">{rec.ward_type}</span>
                                                                <span className="text-line">|</span>
                                                                Priority: <span className={rec.priority === 'urgent' ? 'text-danger font-bold' : 'text-warning font-bold'}>{rec.priority}</span>
                                                            </div>
                                                        </div>
                                                        <button 
                                                            onClick={() => {
                                                                setSelectedRecommendation(rec)
                                                                setAdmissionForm(prev => ({ ...prev, room_type: rec.ward_type === 'ICU' ? 'ICU Bed' : 'General Ward' }))
                                                                setShowAdmissionModal(true)
                                                            }}
                                                            className="px-8 py-3 bg-ink text-white rounded-xl text-[10px] font-mono uppercase tracking-widest hover:bg-brand transition-all shadow-lg"
                                                        >
                                                            Confirm Admission
                                                        </button>
                                                    </div>
                                                    <div className="p-4 bg-canvas border border-line-soft rounded-2xl">
                                                        <p className="text-xs text-ink-2 leading-relaxed italic">"{rec.reason}"</p>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div>
                                    <h3 className="font-serif italic text-4xl text-ink font-light mb-8">Active Inpatients</h3>
                                    {admissionsLoading ? (
                                        <div className="py-20 text-center font-mono text-[10px] text-ink-3 uppercase tracking-widest">Syncing Ward Records...</div>
                                    ) : activeAdmissions.length === 0 ? (
                                        <div className="p-12 border border-line-soft bg-canvas/50 rounded-2xl text-center">
                                            <p className="font-mono text-[10px] text-ink-3 uppercase tracking-widest">No active admissions</p>
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-1 gap-4">
                                            {activeAdmissions.map((adm) => (
                                                <div key={adm.id} className="bg-white border border-line-soft p-6 rounded-2xl flex items-center justify-between hover:bg-canvas transition-all">
                                                    <div className="flex items-center gap-6">
                                                        <div className="w-12 h-12 bg-brand-tint text-brand rounded-xl flex items-center justify-center font-bold font-mono text-lg">
                                                            {adm.beds?.bed_number || '00'}
                                                        </div>
                                                        <div>
                                                            <h4 className="font-serif italic text-xl text-ink">{adm.patients?.name}</h4>
                                                            <p className="font-mono text-[9px] text-ink-3 uppercase tracking-widest">{adm.wards?.name} <span className="mx-2">•</span> {adm.room_type}</p>
                                                        </div>
                                                    </div>
                                                    <div className="flex items-center gap-6">
                                                        <div className="text-right">
                                                            <div className="font-mono text-[10px] text-ink-3 uppercase tracking-widest mb-1">Stay Duration</div>
                                                            <div className="font-serif italic text-xl text-ink">
                                                                {Math.max(1, Math.ceil((new Date().getTime() - new Date(adm.admitted_at).getTime()) / (1000 * 3600 * 24)))} Days
                                                            </div>
                                                        </div>
                                                        <button 
                                                            onClick={() => handleInitiateDischarge(adm)}
                                                            className="px-6 py-2 bg-ink text-white rounded-xl text-[9px] font-mono uppercase tracking-widest hover:bg-warning transition-all flex items-center gap-2"
                                                        >
                                                            <LogOut size={14} />
                                                            Discharge
                                                        </button>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {activeTab === 'lookup' && (
                            <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                <div className="flex gap-6 items-end">
                                    <div className="flex-1">
                                         <Input label="Directory Search (VELA ID)" value={lookupId} onChange={e => setLookupId(e.target.value)} placeholder="VLA-..." autoFocus />
                                    </div>
                                    <button 
                                        onClick={handleLookup}
                                        disabled={lookupLoading || !lookupId}
                                        className="h-[50px] px-10 border border-line-strong text-ink hover:bg-white transition-colors uppercase font-mono text-[10px] tracking-[0.2em] disabled:opacity-50 rounded-xl"
                                    >
                                        {lookupLoading ? 'Scanning...' : 'Search'}
                                    </button>
                                    <button 
                                        type="button"
                                        onClick={() => setIsScanning(!isScanning)}
                                        className="h-[50px] px-6 border border-brand text-brand hover:bg-brand-tint transition-colors uppercase font-mono text-[10px] tracking-[0.2em] flex flex-col justify-center items-center rounded-xl"
                                    >
                                        <Camera size={18} className="mb-0.5" />
                                        Scan QR
                                    </button>
                                </div>

                                {isScanning && (
                                    <div className="bg-line-soft p-8 rounded-2xl animate-in fade-in duration-300">
                                       <div id="qr-reader" className="max-w-[400px] mx-auto overflow-hidden rounded-xl border border-line-strong shadow-sm bg-white" />
                                       <button onClick={() => setIsScanning(false)} className="mt-4 text-center block w-full text-xs text-ink-2 hover:text-ink uppercase font-mono">Cancel Scanning</button>
                                    </div>
                                )}

                                {(lookupPatient || registeredPatient) && (
                                    <div className="bg-white border border-line p-10 rounded-2xl shadow-sm relative overflow-hidden group">
                                        <div className="relative z-10">
                                            <div className="flex justify-between items-start mb-10 border-b border-line-soft pb-8">
                                                <div>
                                                    <h3 className="font-serif italic text-4xl mb-3 text-ink">{(lookupPatient || registeredPatient)?.name}</h3>
                                                    <p className="font-mono text-[10px] text-brand tracking-widest uppercase mb-1">
                                                        {(lookupPatient || registeredPatient)?.vela_id} <span className="mx-2">•</span> Age {(lookupPatient || registeredPatient)?.age}
                                                    </p>
                                                    <div className="space-y-1 mt-4">
                                                        <p className="text-xs text-ink-2">Phone: {(lookupPatient || registeredPatient)?.phone || 'N/A'}</p>
                                                        <p className="text-xs text-ink-2 uppercase">Emergency: {(lookupPatient || registeredPatient)?.emergency_contact_name || 'N/A'}</p>
                                                    </div>
                                                </div>
                                                <div className="flex gap-4">
                                                     <div className="bg-canvas border border-line-soft p-4 flex flex-col items-center shadow-sm rounded-2xl">
                                                         <QRCodeSVG value={(lookupPatient || registeredPatient)?.vela_id || ""} size={96} bgColor="#F8FAFC" fgColor="#0F172A" />
                                                         <span className="text-[8px] uppercase tracking-widest font-mono text-ink-3 mt-3">Patient QR</span>
                                                     </div>
                                                </div>
                                            </div>

                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-10 mb-10">
                                                <div>
                                                    <label className="block font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-3 ml-1">Clinical Notes</label>
                                                    <textarea 
                                                        value={ticketNotes}
                                                        onChange={e => setTicketNotes(e.target.value)}
                                                        className="w-full bg-canvas border border-line p-4 rounded-xl text-ink text-sm focus:outline-none focus:border-brand min-h-[120px] resize-none transition-colors"
                                                        placeholder="Enter symptoms or reason for visit..."
                                                    />
                                                </div>
                                                <div className="space-y-6">
                                                    <div>
                                                        <label className="block font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-3 ml-1">Priority Routing</label>
                                                        <div className="grid grid-cols-2 gap-3">
                                                            {['General', 'Cardiology', 'Neurology', 'Emergency'].map(dept => (
                                                                <button 
                                                                    key={dept}
                                                                    onClick={() => setTicketDepartment(dept)}
                                                                    className={`text-center px-4 py-3 text-[10px] uppercase tracking-[0.1em] border rounded-xl transition-all ${ticketDepartment === dept ? 'bg-brand text-white border-brand shadow-md shadow-brand-light/10' : 'bg-white border-line text-ink-2 hover:border-brand-soft'}`}
                                                                >
                                                                    {dept}
                                                                </button>
                                                            ))}
                                                        </div>
                                                    </div>
                                                    
                                                    <div>
                                                        <label className="block font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-3 ml-1">Assign Doctor (Optional)</label>
                                                        <select
                                                            value={selectedTicketDoctor}
                                                            onChange={e => {
                                                                setSelectedTicketDoctor(e.target.value)
                                                                const matchedDoc = doctorStats.find(d => d.id === e.target.value)
                                                                if (matchedDoc?.specialization) {
                                                                    const specLower = matchedDoc.specialization.toLowerCase()
                                                                    if (specLower.includes('cardio')) setTicketDepartment('Cardiology')
                                                                    else if (specLower.includes('neuro')) setTicketDepartment('Neurology')
                                                                    else if (specLower.includes('emerg')) setTicketDepartment('Emergency')
                                                                }
                                                            }}
                                                            className="w-full bg-canvas border border-line p-4 rounded-xl text-ink text-sm focus:outline-none focus:border-brand transition-colors"
                                                        >
                                                            <option value="">General Waitlist (Unassigned)</option>
                                                            {doctorStats.map(doc => (
                                                                <option key={doc.id} value={doc.id}>
                                                                    Dr. {doc.name} ({doc.specialization || 'General'}) {doc.online ? '● Live' : '● Offline'}
                                                                </option>
                                                            ))}
                                                        </select>
                                                    </div>
                                                </div>
                                            </div>

                                            <button 
                                                onClick={handleCreateTicket}
                                                disabled={ticketCreating}
                                                className="w-full bg-ink text-white py-4 rounded-2xl font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-ink transition-all shadow-xl shadow-ink/10"
                                            >
                                                {ticketCreating ? 'Generating Ticket...' : 'Check-in Patient'}
                                            </button>
                                        </div>
                                    </div>
                                )}

                                {/* File Upload */}
                                {lookupPatient && (
                                    <div className="pt-10 border-t border-line">
                                        <div className="flex items-center gap-3 mb-6">
                                            <FileText className="text-brand" size={20} />
                                            <h3 className="font-serif italic text-3xl text-ink font-light">Document Ingestion</h3>
                                        </div>
                                        <div 
                                            className={`border-2 border-dashed rounded-2xl p-12 text-center transition-all cursor-pointer ${dragOver ? 'border-brand bg-brand-tint' : 'border-line hover:border-brand-light hover:bg-canvas/50'}`}
                                            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
                                            onDragLeave={() => setDragOver(false)}
                                            onDrop={(e) => {
                                                e.preventDefault(); setDragOver(false);
                                                const file = e.dataTransfer.files[0];
                                                if (file) setUploadFile(file);
                                            }}
                                            onClick={() => document.getElementById('file-upload')?.click()}
                                        >
                                            <input type="file" id="file-upload" className="hidden" onChange={e => setUploadFile(e.target.files?.[0] || null)} />
                                            {uploadFile ? (
                                                <div className="flex items-center justify-center gap-4 text-brand">
                                                    <CheckCircle2 size={24} />
                                                    <span className="font-mono text-sm tracking-widest font-bold">{uploadFile.name}</span>
                                                    <button onClick={(e) => {e.stopPropagation(); setUploadFile(null)}} className="ml-4 p-2 bg-line text-ink-2 rounded-full hover:bg-danger-soft hover:text-danger transition-colors"><X size={14}/></button>
                                                </div>
                                            ) : (
                                                <div className="text-ink-3">
                                                    <div className="font-mono text-xs uppercase tracking-[0.2em] mb-2 text-ink">Drop Clinical Logs</div>
                                                    <div className="text-xs font-light">Scanned reports, prescriptions, or imaging data (PDF/IMG)</div>
                                                </div>
                                            )}
                                        </div>
                                        {uploadFile && (
                                            <button 
                                                onClick={handleUpload}
                                                disabled={uploading}
                                                className="mt-6 w-full bg-brand text-white py-4 rounded-2xl font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-brand-dark transition-all"
                                            >
                                                {uploading ? 'Analyzing Pathology...' : 'Ingest & Cross-Reference'}
                                            </button>
                                        )}
                                        {uploadResult && (
                                            <div className="mt-6 p-6 border border-line bg-canvas rounded-2xl font-mono text-xs text-ink/80 tracking-wide border-l-4 border-l-brand">
                                                Analysis Complete. Intelligence Link ID: {uploadResult.risk_id}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}

                        {activeTab === 'appointments' && (
                            <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                
                                {/* 📬 PENDING REQUESTS SECTION */}
                                <div>
                                    <div className="flex justify-between items-center mb-6">
                                        <h3 className="font-serif italic text-3xl text-ink font-light">Pending Requests</h3>
                                        <span className="font-mono text-[10px] text-warning uppercase tracking-widest bg-warning-tint border border-warning-soft/50 px-3 py-1 rounded-full">
                                            {appointments.filter(a => a.status === 'pending').length} Action Required
                                        </span>
                                    </div>
                                    
                                    {appointments.filter(a => a.status === 'pending').length === 0 ? (
                                        <div className="py-12 border border-dashed border-line bg-canvas/50 flex flex-col items-center justify-center rounded-2xl">
                                            <p className="font-mono text-[10px] text-ink-3 uppercase tracking-widest">No pending appointment requests</p>
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-1 gap-4">
                                            {appointments.filter(a => a.status === 'pending').map((apt) => {
                                                let patientNotes = "";
                                                try {
                                                    const parsed = JSON.parse(apt.notes);
                                                    patientNotes = parsed.patient_notes || "";
                                                } catch(e) {}
                                                
                                                return (
                                                    <div key={apt.id} className="bg-warning-tint/40 border border-warning-soft/70 p-6 rounded-2xl hover:border-warning-soft hover:shadow-md transition-all flex flex-col md:flex-row md:items-center justify-between gap-6">
                                                        <div className="flex items-center gap-6">
                                                            <div className="w-16 h-16 bg-warning-tint border border-warning-soft rounded-2xl flex flex-col items-center justify-center">
                                                                <span className="font-mono text-xl font-bold text-warning">{(apt.appointment_time || apt.time || '00:00').split(':')[0]}</span>
                                                                <span className="font-mono text-[8px] text-warning uppercase font-bold">{(apt.appointment_time || apt.time || '00:00').split(':')[1]}</span>
                                                            </div>
                                                            <div>
                                                                <h4 className="font-serif italic text-2xl text-ink">
                                                                    {apt.patients?.name || apt.patient_name || 'Anonymous Patient'}
                                                                    <span className="ml-3 font-mono text-[9px] text-warning bg-warning-tint border border-warning-soft/80 uppercase tracking-widest px-2 py-0.5 rounded-full">Pending Approval</span>
                                                                </h4>
                                                                <div className="flex gap-4 mt-1.5 flex-wrap">
                                                                    <span className="font-mono text-[9px] text-ink-2 uppercase tracking-widest flex items-center gap-1">Date: {apt.appointment_date || apt.date}</span>
                                                                    <span className="font-mono text-[9px] text-ink-2 uppercase tracking-widest flex items-center gap-1">Time: {apt.appointment_time || apt.time}</span>
                                                                    <span className="font-mono text-[9px] text-brand uppercase tracking-widest flex items-center gap-1">Doc: {apt.doctor_name || 'General Waitlist'}</span>
                                                                </div>
                                                                {patientNotes && (
                                                                    <p className="mt-3 font-sans text-xs text-ink-2 bg-white border border-line-soft p-3 rounded-xl italic">
                                                                        "{patientNotes}"
                                                                    </p>
                                                                )}
                                                            </div>
                                                        </div>
                                                        {activeAcceptingAptId === apt.id ? (
                                                            <div className="flex flex-col md:flex-row items-stretch md:items-end gap-3 bg-canvas border border-line/80 p-4 rounded-2xl animate-in fade-in slide-in-from-top-2 duration-200 w-full md:w-auto">
                                                                <div className="flex-1 min-w-[200px]">
                                                                    <label className="block text-[8px] font-mono uppercase tracking-wider text-ink-3 mb-1.5 font-bold">Assign Consulting Practitioner</label>
                                                                    <select
                                                                        value={assignedDoctorId}
                                                                        onChange={(e) => setAssignedDoctorId(e.target.value)}
                                                                        className="w-full px-3 py-2 bg-white border border-line rounded-xl text-xs font-sans text-ink-2 focus:outline-none focus:ring-2 focus:ring-brand-light/20 focus:border-brand-light transition-all cursor-pointer font-medium"
                                                                    >
                                                                        <option value="">-- Choose Consulting Doctor --</option>
                                                                        {doctorStats.map(doc => (
                                                                            <option key={doc.id} value={doc.id}>Dr. {doc.name} ({doc.specialization})</option>
                                                                        ))}
                                                                    </select>
                                                                </div>
                                                                <div className="flex gap-2 self-end md:self-auto">
                                                                    <button
                                                                        onClick={() => {
                                                                            setActiveAcceptingAptId(null);
                                                                            setAssignedDoctorId('');
                                                                        }}
                                                                        className="px-4 py-2 border border-line text-ink-2 rounded-xl text-[9px] font-mono uppercase tracking-widest hover:bg-line-soft transition-all"
                                                                    >
                                                                        Cancel
                                                                    </button>
                                                                    <button
                                                                        disabled={!assignedDoctorId}
                                                                        onClick={() => handleAcceptAppointment(apt.id, assignedDoctorId)}
                                                                        className="px-5 py-2.5 bg-brand text-white rounded-xl text-[9px] font-mono uppercase tracking-widest hover:bg-brand-dark disabled:opacity-55 disabled:cursor-not-allowed disabled:hover:bg-brand disabled:shadow-none transition-all shadow-md shadow-brand-light/10"
                                                                    >
                                                                        Confirm & Accept
                                                                    </button>
                                                                </div>
                                                            </div>
                                                        ) : (
                                                            <div className="flex gap-3 self-end md:self-center">
                                                                <button 
                                                                    onClick={() => handleRejectAppointment(apt.id)}
                                                                    className="px-5 py-3 border border-danger-soft text-danger rounded-xl text-[10px] font-mono uppercase tracking-widest hover:bg-danger-tint transition-all"
                                                                >
                                                                    Reject
                                                                </button>
                                                                <button 
                                                                    onClick={() => {
                                                                        setActiveAcceptingAptId(apt.id);
                                                                        fetchDoctorStats();
                                                                    }}
                                                                    className="px-6 py-3 bg-brand text-white rounded-xl text-[10px] font-mono uppercase tracking-widest hover:bg-brand-dark transition-all shadow-lg shadow-brand-light/20"
                                                                >
                                                                    Accept Request
                                                                </button>
                                                            </div>
                                                        )}
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    )}
                                </div>

                                {/* Divider */}
                                <div className="border-t border-line-soft" />

                                {/* 📅 TODAY'S ACTIVE SCHEDULE SECTION */}
                                <div>
                                    <div className="flex justify-between items-center mb-6">
                                        <h3 className="font-serif italic text-3xl text-ink font-light">Today's Active Schedule</h3>
                                        <span className="font-mono text-[10px] text-brand uppercase tracking-widest bg-brand-tint px-3 py-1 rounded-full">
                                            {appointments.filter(a => a.status !== 'pending' && a.status !== 'rejected').length} Confirmed
                                        </span>
                                    </div>

                                    <div className="grid grid-cols-1 gap-4">
                                        {appointmentsLoading ? (
                                            <div className="py-20 text-center font-mono text-[10px] text-ink-3 uppercase tracking-widest">Synchronizing Registry...</div>
                                        ) : appointments.filter(a => a.status !== 'pending' && a.status !== 'rejected').length === 0 ? (
                                            <div className="py-20 border border-line-soft bg-canvas flex flex-col items-center justify-center rounded-2xl">
                                                <Calendar className="text-line mb-4" size={48} strokeWidth={1} />
                                                <p className="font-mono text-[10px] text-ink-3 uppercase tracking-widest">No active sessions scheduled for today</p>
                                            </div>
                                        ) : (
                                            appointments.filter(a => a.status !== 'pending' && a.status !== 'rejected').map((apt) => (
                                                <div key={apt.id} className="bg-white border border-line p-6 rounded-2xl hover:border-brand/30 hover:shadow-xl hover:shadow-brand-light/5 transition-all flex items-center justify-between group">
                                                    <div className="flex items-center gap-6">
                                                        <div className="w-16 h-16 bg-canvas border border-line-soft rounded-2xl flex flex-col items-center justify-center">
                                                            <span className="font-mono text-xl font-bold text-ink">{(apt.appointment_time || apt.time || '00:00').split(':')[0]}</span>
                                                            <span className="font-mono text-[8px] text-ink-3 uppercase font-bold">{(apt.appointment_time || apt.time || '00:00').split(':')[1]}</span>
                                                        </div>
                                                        <div>
                                                            <h4 className="font-serif italic text-2xl text-ink group-hover:text-brand transition-colors">
                                                                {apt.patients?.name || apt.patient_name || 'Anonymous Patient'}
                                                                {apt.vela_id && <span className="ml-3 font-mono text-[9px] text-brand uppercase tracking-widest border border-brand/20 px-2 py-0.5 rounded-full">Vela Network</span>}
                                                            </h4>
                                                            <div className="flex gap-4 mt-1">
                                                                <span className="font-mono text-[9px] text-ink-3 uppercase tracking-widest flex items-center gap-1"><Clock size={10}/> {apt.appointment_time || apt.time}</span>
                                                                <span className="font-mono text-[9px] text-ink-3 uppercase tracking-widest flex items-center gap-1"><UserPlus size={10}/> {apt.doctor_name || 'General Admission'}</span>
                                                                <span className="font-mono text-[9px] text-ink-3 uppercase tracking-widest">Status: <span className="text-success font-bold">{apt.status.toUpperCase()}</span></span>
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="flex gap-3">
                                                        {apt.status === 'scheduled' ? (
                                                            <button 
                                                                onClick={() => handleMarkArrived(apt.id)}
                                                                className="flex items-center gap-2 px-6 py-3 bg-brand text-white rounded-xl text-[10px] font-mono uppercase tracking-widest hover:bg-brand-dark transition-all shadow-lg shadow-brand-light/20"
                                                            >
                                                                <CheckCircle2 size={14} /> Mark Arrived
                                                            </button>
                                                        ) : apt.status === 'arrived' ? (
                                                            <button 
                                                                onClick={() => handleOpenAssign(apt)}
                                                                className="flex items-center gap-2 px-6 py-3 bg-ink text-white rounded-xl text-[10px] font-mono uppercase tracking-widest hover:bg-brand transition-all shadow-lg shadow-brand-light/20"
                                                            >
                                                                <Stethoscope size={14} /> Assign Doctor
                                                            </button>
                                                        ) : (
                                                            <span className="font-mono text-[9px] uppercase tracking-widest text-line-strong mr-4">Processed</span>
                                                        )}
                                                    </div>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                </div>
                            </div>
                        )}

                        {activeTab === 'tests' && (
                            <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                <div className="flex items-center justify-between">
                                    <h3 className="font-serif italic text-4xl text-ink font-light">Diagnostic Fees</h3>
                                    <button onClick={fetchTestOrders} className="p-3 bg-canvas border border-line-soft rounded-xl text-ink-3 hover:text-brand transition-all">
                                        <RefreshCw size={16} />
                                    </button>
                                </div>

                                {/* ── ARRIVALS: paid, waiting to be checked in at their lab ── */}
                                <div className="bg-success-tint/40 border border-success-soft/60 rounded-2xl p-8 space-y-6">
                                    <div className="flex items-center justify-between gap-6">
                                        <div>
                                            <h4 className="font-serif italic text-2xl text-ink">At the Lab</h4>
                                            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-3 mt-2">
                                                Paid — check the patient in when they reach the lab
                                            </p>
                                        </div>
                                        <div className="flex items-center gap-4">
                                            <span className="font-mono text-3xl font-bold text-success">{arrivals.length}</span>
                                            <button onClick={fetchArrivals} className="p-3 bg-white border border-success-soft rounded-xl text-ink-3 hover:text-success transition-all">
                                                <RefreshCw size={16} />
                                            </button>
                                        </div>
                                    </div>

                                    {arrivals.length > 3 && (
                                        <div className="relative">
                                            <Search size={15} className="absolute left-4 top-1/2 -translate-y-1/2 text-line-strong" />
                                            <input
                                                value={arrivalSearch}
                                                onChange={(e) => setArrivalSearch(e.target.value)}
                                                placeholder="Find a patient waiting at a lab…"
                                                className="w-full bg-white border border-success-soft/70 rounded-xl pl-11 pr-4 py-3 text-ink placeholder:text-line-strong focus:border-success focus:outline-none"
                                            />
                                        </div>
                                    )}

                                    {arrivalsLoading ? (
                                        <div className="text-center py-8 text-line-strong font-mono text-[10px] uppercase tracking-widest">Loading…</div>
                                    ) : filteredArrivals.length === 0 ? (
                                        <div className="text-center py-8 font-mono text-[9px] uppercase tracking-widest text-ink-3">
                                            {arrivals.length === 0 ? 'Nobody waiting to be checked in' : `No match for “${arrivalSearch}”`}
                                        </div>
                                    ) : (
                                        <div className="space-y-3">
                                            {filteredArrivals.map((order) => (
                                                <div key={order.id} className="bg-white border border-success-soft/60 px-6 py-4 rounded-2xl flex items-center justify-between gap-6">
                                                    <div className="min-w-0">
                                                        <div className="font-serif text-xl text-ink truncate">{order.patients?.name || 'Patient'}</div>
                                                        <div className="flex gap-4 mt-1 flex-wrap">
                                                            <span className="font-mono text-[9px] uppercase tracking-widest text-ink-3">{order.test_type}</span>
                                                            <span className="font-mono text-[9px] uppercase tracking-widest text-success font-bold">{order.department} lab</span>
                                                            {order.patients?.vela_id && (
                                                                <span className="font-mono text-[9px] uppercase tracking-widest text-line-strong">{order.patients.vela_id}</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                    <button
                                                        onClick={() => markArrived(order)}
                                                        disabled={arrivingId === order.id}
                                                        className="px-7 py-3 bg-success text-white rounded-xl font-mono text-[9px] uppercase tracking-[0.2em] hover:bg-success transition-all shadow-lg disabled:opacity-40 disabled:cursor-wait whitespace-nowrap shrink-0"
                                                    >
                                                        {arrivingId === order.id ? 'Checking in…' : 'Arrived'}
                                                    </button>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>

                                <div className="relative">
                                    <Search size={16} className="absolute left-5 top-1/2 -translate-y-1/2 text-line-strong" />
                                    <input
                                        value={testSearch}
                                        onChange={(e) => setTestSearch(e.target.value)}
                                        placeholder="Search by patient name, VELA ID or test…"
                                        className="w-full bg-white border border-line rounded-2xl pl-14 pr-6 py-5 text-ink placeholder:text-line-strong focus:border-brand focus:outline-none transition-colors"
                                    />
                                    {testSearch && (
                                        <button
                                            onClick={() => setTestSearch('')}
                                            className="absolute right-5 top-1/2 -translate-y-1/2 font-mono text-[9px] uppercase tracking-widest text-ink-3 hover:text-brand"
                                        >
                                            Clear
                                        </button>
                                    )}
                                </div>

                                <div className="grid grid-cols-1 gap-6">
                                    {testLoading ? (
                                        <div className="text-center py-20 text-line-strong font-mono text-[10px] uppercase tracking-widest">Scanning Clearinghouse...</div>
                                    ) : testOrders.length === 0 ? (
                                        <div className="text-center py-20 border border-line-soft bg-canvas rounded-2xl">
                                            <div className="font-serif italic text-2xl text-ink-3">All accounts cleared</div>
                                            <div className="font-mono text-[9px] uppercase tracking-widest text-line-strong mt-2">No pending lab payments</div>
                                        </div>
                                    ) : filteredTestOrders.length === 0 ? (
                                        <div className="text-center py-20 border border-line-soft bg-canvas rounded-2xl">
                                            <div className="font-serif italic text-2xl text-ink-3">No match for “{testSearch}”</div>
                                            <div className="font-mono text-[9px] uppercase tracking-widest text-line-strong mt-2">{testOrders.length} order(s) awaiting payment</div>
                                        </div>
                                    ) : (
                                        filteredTestOrders.map((order) => (
                                            <div key={order.id} className="bg-white border border-line p-8 rounded-2xl hover:border-brand/20 hover:shadow-xl hover:shadow-brand-light/5 transition-all flex items-center justify-between group">
                                                <div className="flex items-center gap-8">
                                                    <div className="w-16 h-16 bg-brand-tint border border-brand-soft rounded-2xl flex items-center justify-center text-brand">
                                                        <CreditCard size={28} />
                                                    </div>
                                                    <div>
                                                        <h4 className="font-serif italic text-3xl text-ink">{order.patients?.name}</h4>
                                                        <div className="flex gap-4 mt-2 flex-wrap">
                                                            <span className="font-mono text-[10px] text-ink-3 uppercase tracking-widest">{order.test_type}</span>
                                                            {order.department && (
                                                                <span className="font-mono text-[10px] text-ink-2 uppercase tracking-widest">{order.department} lab</span>
                                                            )}
                                                            <span className="font-mono text-[10px] text-brand font-bold uppercase tracking-widest">DR. {order.doctor_name || 'WEST'}</span>
                                                            {order.patients?.vela_id && (
                                                                <span className="font-mono text-[10px] text-line-strong uppercase tracking-widest">{order.patients.vela_id}</span>
                                                            )}
                                                            {order.payment_intent === 'counter' && (
                                                                <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-warning bg-warning-tint border border-warning-soft rounded px-2 py-0.5">
                                                                    Coming to counter
                                                                </span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-10">
                                                    <div className="text-right">
                                                        <div className="text-[10px] font-mono text-ink-3 uppercase tracking-widest mb-1">Catalog Fee</div>
                                                        <div className="text-3xl font-mono font-bold text-ink">₹{orderPrice(order)}</div>
                                                    </div>
                                                    <button
                                                        onClick={() => { setSelectedTestOrder(order); setShowPaymentModal(true); }}
                                                        className="px-8 py-4 bg-ink text-white rounded-xl font-mono text-[10px] uppercase tracking-[0.2em] hover:bg-brand transition-all shadow-lg"
                                                    >
                                                        Collect Payment
                                                    </button>
                                                    <button
                                                        onClick={() => cancelTestOrder(order)}
                                                        disabled={cancellingOrderId === order.id}
                                                        title="Cancel this test"
                                                        className="p-4 bg-canvas border border-line rounded-xl text-ink-3 hover:text-danger hover:border-danger-soft transition-all disabled:opacity-40 disabled:cursor-wait"
                                                    >
                                                        <Trash2 size={16} />
                                                    </button>
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        )}

                        {activeTab === 'catalog' && (
                            <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                <div className="flex items-center justify-between">
                                    <div>
                                        <h3 className="font-serif italic text-4xl text-ink font-light">Test Catalog</h3>
                                        <p className="font-mono text-[9px] uppercase tracking-widest text-ink-3 mt-2">
                                            Which lab runs each test, and what it costs
                                        </p>
                                    </div>
                                    <button onClick={fetchCatalog} className="p-3 bg-canvas border border-line-soft rounded-xl text-ink-3 hover:text-brand transition-all">
                                        <RefreshCw size={18} />
                                    </button>
                                </div>

                                {/* Add / update a test */}
                                <div className="bg-white border border-line rounded-2xl p-8 space-y-6">
                                    <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-2">
                                        Add or update a test
                                    </div>
                                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
                                        <div className="md:col-span-2">
                                            <label className="font-mono text-[9px] uppercase tracking-widest text-ink-3">Test name</label>
                                            <input
                                                value={catalogForm.test_type}
                                                onChange={(e) => setCatalogForm({ ...catalogForm, test_type: e.target.value })}
                                                placeholder="e.g. Blood CBC"
                                                className="w-full mt-2 bg-canvas border border-line rounded-xl px-4 py-3 text-ink placeholder:text-line-strong focus:border-brand focus:outline-none"
                                            />
                                        </div>
                                        <div>
                                            <label className="font-mono text-[9px] uppercase tracking-widest text-ink-3">Laboratory</label>
                                            <select
                                                value={catalogForm.department}
                                                onChange={(e) => setCatalogForm({ ...catalogForm, department: e.target.value })}
                                                className="w-full mt-2 bg-canvas border border-line rounded-xl px-4 py-3 text-ink focus:border-brand focus:outline-none"
                                            >
                                                {(catalogDepartments.length ? catalogDepartments : [{ id: 'pathology', name: 'Pathology' }]).map((d) => (
                                                    <option key={d.id} value={d.id}>{d.name}</option>
                                                ))}
                                            </select>
                                        </div>
                                        <div>
                                            <label className="font-mono text-[9px] uppercase tracking-widest text-ink-3">Price (₹)</label>
                                            <input
                                                value={catalogForm.price}
                                                onChange={(e) => setCatalogForm({ ...catalogForm, price: e.target.value })}
                                                placeholder="350"
                                                inputMode="decimal"
                                                className="w-full mt-2 bg-canvas border border-line rounded-xl px-4 py-3 text-ink placeholder:text-line-strong focus:border-brand focus:outline-none"
                                            />
                                        </div>
                                    </div>
                                    <div className="flex items-center justify-between gap-6">
                                        <p className="font-mono text-[9px] uppercase tracking-widest text-ink-3 leading-relaxed">
                                            Saving an existing test only changes its lab and price — the report format the lab built stays intact.
                                        </p>
                                        <button
                                            onClick={saveCatalogEntry}
                                            disabled={catalogSaving}
                                            className="px-8 py-4 bg-ink text-white rounded-xl font-mono text-[10px] uppercase tracking-[0.2em] hover:bg-brand transition-all shadow-lg disabled:opacity-40 disabled:cursor-wait whitespace-nowrap"
                                        >
                                            {catalogSaving ? 'Saving…' : 'Save Test'}
                                        </button>
                                    </div>
                                </div>

                                <div className="relative">
                                    <Search size={16} className="absolute left-5 top-1/2 -translate-y-1/2 text-line-strong" />
                                    <input
                                        value={catalogSearch}
                                        onChange={(e) => setCatalogSearch(e.target.value)}
                                        placeholder="Search the catalog…"
                                        className="w-full bg-white border border-line rounded-2xl pl-14 pr-6 py-5 text-ink placeholder:text-line-strong focus:border-brand focus:outline-none transition-colors"
                                    />
                                </div>

                                <div className="grid grid-cols-1 gap-3">
                                    {catalogLoading ? (
                                        <div className="text-center py-20 text-line-strong font-mono text-[10px] uppercase tracking-widest">Loading catalog…</div>
                                    ) : filteredCatalog.length === 0 ? (
                                        <div className="text-center py-20 border border-line-soft bg-canvas rounded-2xl">
                                            <div className="font-serif italic text-2xl text-ink-3">No tests found</div>
                                        </div>
                                    ) : (
                                        filteredCatalog.map((t) => (
                                            <div key={t.id || t.test_type} className="bg-white border border-line px-8 py-5 rounded-2xl flex items-center justify-between gap-6 hover:border-brand/20 transition-all">
                                                <div className="flex items-center gap-6 min-w-0">
                                                    <div className="w-11 h-11 shrink-0 bg-brand-tint border border-brand-soft rounded-xl flex items-center justify-center text-brand">
                                                        <FlaskConical size={18} />
                                                    </div>
                                                    <div className="min-w-0">
                                                        <div className="font-serif text-xl text-ink truncate">{t.test_type}</div>
                                                        <div className="flex gap-4 mt-1 flex-wrap">
                                                            <span className="font-mono text-[9px] uppercase tracking-widest text-ink-3">{t.department} lab</span>
                                                            {t.tat_minutes ? (
                                                                <span className="font-mono text-[9px] uppercase tracking-widest text-line-strong">~{t.tat_minutes} min</span>
                                                            ) : null}
                                                            {t.custom ? (
                                                                <span className="font-mono text-[9px] uppercase tracking-widest text-brand">This hospital</span>
                                                            ) : (
                                                                <span className="font-mono text-[9px] uppercase tracking-widest text-line-strong">Built-in</span>
                                                            )}
                                                        </div>
                                                    </div>
                                                </div>
                                                <div className="flex items-center gap-6 shrink-0">
                                                    <div className="text-2xl font-mono font-bold text-ink">₹{Number(t.price ?? 0)}</div>
                                                    <button
                                                        onClick={() => setCatalogForm({
                                                            test_type: t.test_type,
                                                            department: t.department || 'pathology',
                                                            price: String(t.price ?? ''),
                                                            tat_minutes: String(t.tat_minutes ?? ''),
                                                        })}
                                                        className="px-5 py-3 bg-canvas border border-line rounded-xl font-mono text-[9px] uppercase tracking-widest text-ink-2 hover:text-brand hover:border-brand/30 transition-all"
                                                    >
                                                        Edit
                                                    </button>
                                                    {t.custom && t.id && (
                                                        <button
                                                            onClick={() => deleteCatalogEntry(t)}
                                                            title="Remove from this hospital's menu"
                                                            className="p-3 bg-canvas border border-line rounded-xl text-ink-3 hover:text-danger hover:border-danger-soft transition-all"
                                                        >
                                                            <Trash2 size={15} />
                                                        </button>
                                                    )}
                                                </div>
                                            </div>
                                        ))
                                    )}
                                </div>
                            </div>
                        )}

                        {activeTab === 'doctors' && (
                            selectedDoctorForQueue ? (
                                <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-300">
                                    {/* Header & Back Button */}
                                    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-canvas border border-line/60 p-6 rounded-2xl">
                                        <div className="flex items-center gap-4">
                                            <div className="w-14 h-14 rounded-2xl bg-white border border-line flex items-center justify-center text-ink font-serif text-2xl font-bold relative shadow-sm">
                                                {selectedDoctorForQueue.name[0] || 'D'}
                                                <span className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-white ${selectedDoctorForQueue.online ? 'bg-success' : 'bg-line-strong'}`} />
                                            </div>
                                            <div>
                                                <h3 className="font-serif italic text-3xl text-ink font-semibold flex items-center gap-2">
                                                    Dr. {selectedDoctorForQueue.name}
                                                </h3>
                                                <p className="font-mono text-[9px] uppercase tracking-widest text-ink-3 mt-1">
                                                    {selectedDoctorForQueue.specialization || 'General Practice'} • {selectedDoctorForQueue.online ? 'Live On-duty' : 'Offline'}
                                                </p>
                                            </div>
                                        </div>
                                        <button
                                            onClick={() => {
                                                setSelectedDoctorForQueue(null);
                                                setDoctorQueueSearchQuery('');
                                            }}
                                            className="flex items-center gap-2 px-5 py-2.5 border border-line bg-white hover:bg-canvas text-ink-2 rounded-xl font-mono text-[9px] uppercase tracking-widest transition-all shadow-sm"
                                        >
                                            ← Back to Directory
                                        </button>
                                    </div>

                                    {/* Search & Stats Bar */}
                                    <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4">
                                        {/* Search */}
                                        <div className="relative flex-1 max-w-md">
                                            <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-3" size={16} />
                                            <input
                                                type="text"
                                                placeholder="Search patient name, ticket, or department..."
                                                value={doctorQueueSearchQuery}
                                                onChange={(e) => setDoctorQueueSearchQuery(e.target.value)}
                                                className="w-full pl-12 pr-4 py-3 bg-white border border-line rounded-2xl text-sm font-sans focus:outline-none focus:ring-2 focus:ring-brand-light/20 focus:border-brand-light transition-all shadow-sm placeholder:text-ink-3 text-ink"
                                            />
                                        </div>
                                        
                                        {/* Quick Stats badges */}
                                        <div className="flex gap-3">
                                            <span className="bg-brand-tint text-brand-dark border border-brand-soft px-3.5 py-2 rounded-xl font-mono text-[9px] uppercase tracking-widest font-bold">
                                                In Consult: {
                                                    queue.filter(q => q.doctor_id === selectedDoctorForQueue.id && q.status === 'in-progress').length
                                                }
                                            </span>
                                            <span className="bg-warning-tint text-warning border border-warning-soft px-3.5 py-2 rounded-xl font-mono text-[9px] uppercase tracking-widest font-bold">
                                                Waiting: {
                                                    queue.filter(q => q.doctor_id === selectedDoctorForQueue.id && q.status === 'waiting').length
                                                }
                                            </span>
                                        </div>
                                    </div>

                                    {/* Double Feed Column Grid */}
                                    <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                                        {/* Column 1: Actively Being Treated (5 cols) */}
                                        <div className="lg:col-span-5 space-y-4">
                                            <div className="flex items-center gap-2 mb-2">
                                                <div className="w-2 h-2 rounded-full bg-brand-light animate-pulse" />
                                                <h4 className="font-serif italic text-xl text-ink font-semibold">Active Consultation</h4>
                                            </div>
                                            
                                            {(() => {
                                                const activeList = queue.filter(q => 
                                                    q.doctor_id === selectedDoctorForQueue.id && 
                                                    q.status === 'in-progress' &&
                                                    (q.patient_name?.toLowerCase().includes(doctorQueueSearchQuery.toLowerCase()) || 
                                                     q.ticket_number?.toLowerCase().includes(doctorQueueSearchQuery.toLowerCase()))
                                                );
                                                
                                                if (activeList.length === 0) {
                                                    return (
                                                        <div className="bg-white border border-line-soft p-8 rounded-2xl text-center shadow-sm">
                                                            <p className="font-mono text-[9px] text-ink-3 uppercase tracking-widest">No patient in consultation</p>
                                                        </div>
                                                    );
                                                }
                                                
                                                return activeList.map((item, idx) => (
                                                    <div key={item.id || idx} className="bg-white border border-brand-soft/60 p-5 rounded-2xl shadow-sm hover:shadow-md transition-all relative overflow-hidden">
                                                        <div className="absolute top-0 right-0 w-24 h-24 bg-brand-tint/30 rounded-bl-full flex items-start justify-end p-4 font-mono text-[10px] text-brand-light font-bold uppercase tracking-widest">
                                                            In-Office
                                                        </div>
                                                        <div className="font-serif italic text-2xl text-ink mb-1 pr-16">{item.patient_name}</div>
                                                        <div className="flex flex-wrap gap-x-4 gap-y-1.5 font-mono text-[9px] text-ink-3 uppercase tracking-widest mb-3">
                                                            <span className="text-brand font-bold">TKT {item.ticket_number}</span>
                                                            <span>{item.department || 'General'}</span>
                                                            {item.vela_id && <span>VELA: {item.vela_id}</span>}
                                                        </div>
                                                        {item.notes && (
                                                            <div className="bg-canvas border border-line-soft p-3 rounded-xl text-xs text-ink-2 font-sans italic mb-4">
                                                                "{item.notes}"
                                                            </div>
                                                        )}
                                                        <button
                                                            onClick={() => handleCompleteConsultation(item)}
                                                            className="w-full py-2.5 bg-brand-tint hover:bg-brand-soft text-brand-dark rounded-xl font-mono text-[9px] uppercase tracking-widest font-bold transition-all"
                                                        >
                                                            Complete & discharge
                                                        </button>
                                                    </div>
                                                ));
                                            })()}
                                        </div>

                                        {/* Column 2: Waiting List with Search (7 cols) */}
                                        <div className="lg:col-span-7 space-y-4">
                                            <div className="flex items-center gap-2 mb-2">
                                                <div className="w-2 h-2 rounded-full bg-warning" />
                                                <h4 className="font-serif italic text-xl text-ink font-semibold">Waiting Queue</h4>
                                            </div>

                                            {(() => {
                                                const waitingList = queue.filter(q => 
                                                    q.doctor_id === selectedDoctorForQueue.id && 
                                                    q.status === 'waiting' &&
                                                    (q.patient_name?.toLowerCase().includes(doctorQueueSearchQuery.toLowerCase()) || 
                                                     q.ticket_number?.toLowerCase().includes(doctorQueueSearchQuery.toLowerCase()))
                                                );
                                                
                                                if (waitingList.length === 0) {
                                                    return (
                                                        <div className="bg-white border border-line-soft p-12 rounded-2xl text-center shadow-sm">
                                                            <p className="font-mono text-[9px] text-ink-3 uppercase tracking-widest">No patients in waiting queue</p>
                                                        </div>
                                                    );
                                                }
                                                
                                                return (
                                                    <div className="flex flex-col gap-3">
                                                        {waitingList.map((item, idx) => {
                                                            const waitMins = waitMinutes(item)
                                                            return (
                                                                <div key={item.id || idx} className="flex items-center justify-between p-5 bg-white border border-line-soft rounded-2xl shadow-sm hover:border-line/80 transition-all gap-4">
                                                                    <div className="flex items-center gap-4 min-w-0">
                                                                        <div className="font-mono text-xl text-line-strong font-bold shrink-0">
                                                                            #{String(item.queue_position || idx + 1).padStart(2, '0')}
                                                                        </div>
                                                                        <div className="min-w-0">
                                                                            <div className="font-serif italic text-xl text-ink mb-1 truncate">{item.patient_name}</div>
                                                                            <div className="flex flex-wrap gap-x-4 gap-y-1.5 font-mono text-[9px] text-ink-3 uppercase tracking-widest">
                                                                                <span>TKT {item.ticket_number}</span>
                                                                                {item.department && <span>{item.department}</span>}
                                                                            </div>
                                                                        </div>
                                                                    </div>
                                                                    <div className="flex items-center gap-3 shrink-0">
                                                                        <span className="bg-warning-tint text-warning border border-warning-soft px-2 py-1 rounded-lg font-mono text-[8px] uppercase tracking-widest font-bold">
                                                                            {waitMins}m wait
                                                                        </span>
                                                                        <button
                                                                            onClick={() => handleStartConsultation(item)}
                                                                            className="px-4 py-2 bg-brand hover:bg-brand-dark text-white rounded-xl font-mono text-[9px] uppercase tracking-widest font-bold transition-all shadow-sm"
                                                                        >
                                                                            Consult
                                                                        </button>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                );
                                            })()}
                                        </div>
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
                                    <div className="flex items-center justify-between mb-4">
                                        <h3 className="font-serif italic text-4xl text-ink font-light">Doctors Directory</h3>
                                        <button 
                                            type="button"
                                            onClick={fetchDoctorStats} 
                                            className="flex items-center gap-2 px-4 py-2 border border-line rounded-xl font-mono text-[9px] uppercase tracking-widest text-ink-2 hover:text-ink hover:border-line-strong transition-colors"
                                        >
                                            <RefreshCw size={12} /> Refresh
                                        </button>
                                    </div>

                                    {doctorStats.length === 0 ? (
                                        <div className="bg-white border border-line-soft p-12 rounded-2xl text-center shadow-sm">
                                            <Stethoscope className="text-line-strong mx-auto mb-4" size={40} />
                                            <p className="font-mono text-[10px] text-ink-3 uppercase tracking-widest">
                                                {doctorStatsError ? 'Roster unavailable' : 'No doctors found for this hospital'}
                                            </p>
                                            {doctorStatsError && (
                                                <p className="text-xs text-ink-2 mt-3 max-w-sm mx-auto">{doctorStatsError}</p>
                                            )}
                                        </div>
                                    ) : (
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                                            {doctorStats.map(doc => (
                                                <div 
                                                    key={doc.id} 
                                                    onClick={() => { setSelectedDoctorForQueue(doc); fetchQueue(); }}
                                                    className="bg-white border border-line-soft p-6 rounded-2xl shadow-sm relative group overflow-hidden transition-all duration-300 hover:shadow-md hover:border-line/80 cursor-pointer hover:scale-[1.01]"
                                                >
                                                    {/* Header Info */}
                                                    <div className="flex items-center gap-4 mb-6">
                                                        <div className="w-12 h-12 rounded-2xl bg-canvas border border-line-soft flex items-center justify-center text-ink font-serif text-lg font-bold shrink-0 relative">
                                                            {doc.name[0] || 'D'}
                                                            
                                                            {/* Online Status Badge Indicator */}
                                                            <span className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-white flex items-center justify-center ${doc.online ? 'bg-success' : 'bg-line-strong'}`}>
                                                                {doc.online && (
                                                                    <span className="absolute w-2 h-2 rounded-full bg-success animate-ping" />
                                                                )}
                                                            </span>
                                                        </div>
                                                        <div>
                                                            <h4 className="font-serif italic text-xl text-ink font-semibold flex items-center gap-2">
                                                                Dr. {doc.name}
                                                            </h4>
                                                            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-3 mt-0.5">
                                                                {doc.specialization || 'General Practice'}
                                                            </p>
                                                        </div>
                                                        
                                                        {doc.online ? (
                                                            <span className="ml-auto bg-success-tint text-success border border-success-soft px-2 py-1 rounded-lg font-mono text-[8px] uppercase tracking-widest font-bold">
                                                                Live
                                                            </span>
                                                        ) : (
                                                            <span className="ml-auto bg-canvas text-ink-3 border border-line-soft px-2 py-1 rounded-lg font-mono text-[8px] uppercase tracking-widest">
                                                                Offline
                                                            </span>
                                                        )}
                                                    </div>

                                                    {/* Queue Load Indicators */}
                                                    <div className="grid grid-cols-2 gap-4 bg-canvas/50 p-4 rounded-2xl border border-line-soft/50">
                                                        <div className="text-center border-r border-line-soft">
                                                            <p className="font-mono text-[8px] uppercase tracking-widest text-ink-3 mb-1">Waiting</p>
                                                            <p className="font-mono text-xl font-bold text-ink">{doc.waiting_count || 0}</p>
                                                        </div>
                                                        <div className="text-center">
                                                            <p className="font-mono text-[8px] uppercase tracking-widest text-ink-3 mb-1">Active Consult</p>
                                                            <p className="font-mono text-xl font-bold text-brand">{doc.consulting_count || 0}</p>
                                                        </div>
                                                    </div>
                                                </div>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            )
                        )}
                    </div>
                </div>
                              {/* Right Column: Visual Queue */}
                <div className={`${queueIsFocused ? 'hidden' : 'col-span-12 lg:col-span-5'} fade-in-up`} ref={queueRef}>
                    <div className="sticky top-12 bg-transparent min-h-[800px] border-l border-line pl-12 lg:pl-16">
                        
                        {/* 🌟 PREMIUM DOCTOR QUEUE RADAR 🌟 */}
                        <div className="mb-10">
                            <div className="flex items-center justify-between mb-6">
                                <h3 className="font-serif italic text-3xl text-ink font-light">Active Practitioners</h3>
                                <span className="font-mono text-[9px] uppercase tracking-widest text-ink-3 bg-canvas border border-line-soft/85 px-2.5 py-1 rounded-lg">
                                    {doctorStats.filter(d => d.online).length} Live
                                </span>
                            </div>
                            
                            {doctorStats.length === 0 ? (
                                <div className="p-6 bg-canvas border border-line-soft rounded-2xl text-center">
                                    <p className="font-mono text-[9px] text-ink-3 uppercase tracking-widest">No active staff registered</p>
                                </div>
                            ) : (
                                <div className="space-y-3 max-h-[220px] overflow-y-auto pr-2 custom-scrollbar">
                                    {doctorStats.map(doc => (
                                        <div key={doc.id} className="flex items-center justify-between p-3.5 bg-white border border-line-soft rounded-2xl hover:border-line/80 hover:shadow-sm transition-all duration-300">
                                            <div className="flex items-center gap-3">
                                                <div className="relative w-8 h-8 rounded-xl bg-canvas border border-line-soft flex items-center justify-center text-[11px] font-serif font-bold text-ink-2">
                                                    {doc.name[0] || 'D'}
                                                    <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-white ${doc.online ? 'bg-success' : 'bg-line-strong'}`}>
                                                        {doc.online && (
                                                            <span className="absolute inset-0 rounded-full bg-success animate-ping opacity-75" />
                                                        )}
                                                    </span>
                                                </div>
                                                <div>
                                                    <h4 className="font-serif italic text-sm font-semibold text-ink">Dr. {doc.name}</h4>
                                                    <p className="font-mono text-[8px] uppercase tracking-widest text-ink-3 mt-0.5">{doc.specialization || 'General'}</p>
                                                </div>
                                            </div>
                                            
                                            <div className="flex gap-2">
                                                <div className="px-2.5 py-1 bg-canvas border border-line-soft rounded-xl text-center shrink-0 min-w-[50px]">
                                                    <p className="font-mono text-[7px] uppercase tracking-widest text-ink-3 scale-90 origin-center">Wait</p>
                                                    <p className="font-mono text-[10px] font-bold text-ink">{doc.waiting_count || 0}</p>
                                                </div>
                                                <div className="px-2.5 py-1 bg-brand-tint/50 border border-brand-soft/50 rounded-xl text-center shrink-0 min-w-[50px]">
                                                    <p className="font-mono text-[7px] uppercase tracking-widest text-brand scale-90 origin-center">Consult</p>
                                                    <p className="font-mono text-[10px] font-bold text-brand">{doc.consulting_count || 0}</p>
                                                </div>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>

                        {/* Divider */}
                        <div className="border-t border-line-soft mb-10" />

                        <div className="flex items-center justify-between mb-8">
                            <h3 className="font-serif italic text-3xl text-ink font-light">Visual Queue</h3>
                            <button onClick={fetchQueue} className="w-10 h-10 flex items-center justify-center bg-white border border-line hover:bg-canvas hover:border-brand-light transition-all rounded-full shadow-sm">
                                <RefreshCw size={16} className="text-brand" />
                            </button>
                        </div>
                        
                        <div className="space-y-4">
                            {queueLoading ? (
                                <div className="text-center py-32 text-line-strong font-mono text-xs uppercase tracking-[0.2em]">Synchronizing...</div>
                            ) : queue.length === 0 ? (
                                <div className="text-center py-32 border border-line-soft bg-canvas text-ink-3 rounded-2xl">
                                    <Clock size={40} className="mx-auto mb-6 opacity-30" />
                                    <div className="font-serif italic text-3xl mb-2 text-ink-3">Operational calm</div>
                                    <div className="font-mono text-[10px] uppercase tracking-[0.2em]">No active triage tickets</div>
                                </div>
                            ) : (
                                queue.map((item, idx) => (
                                    <div 
                                        key={idx}
                                        className="relative bg-white border border-line p-8 rounded-2xl hover:border-brand-soft hover:shadow-xl hover:shadow-brand-light/5 transition-all flex flex-col justify-between overflow-hidden group"
                                    >
                                        <div className={`absolute left-0 top-0 bottom-0 w-1.5 ${item.status === 'in-progress' ? 'bg-brand' : 'bg-line'}`} />

                                        <div className="flex justify-between items-start mb-6 w-full">
                                            <div className="flex gap-6 items-start">
                                                <span className="font-mono text-4xl text-line group-hover:text-brand-soft transition-colors">
                                                    {String(idx + 1).padStart(2, '0')}
                                                </span>
                                                <div className="flex flex-col">
                                                    <span className="font-serif italic text-3xl text-ink mb-2">{item.patient_name}</span>
                                                    <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-brand font-bold">{item.department} ROUTINE</span>
                                                </div>
                                            </div>
                                            <div className="shrink-0">
                                                <div className={`font-mono text-[9px] uppercase tracking-[0.2em] px-3 py-1.5 rounded-full border ${
                                                    item.status === 'in-progress' 
                                                    ? 'bg-brand-tint text-brand border-brand-soft' 
                                                    : 'bg-canvas text-ink-3 border-line-soft'
                                                }`}>
                                                    {item.status.replace('-', ' ')}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="flex justify-between items-end border-t border-canvas pt-4">
                                            <div className="text-ink-3 text-[9px] font-mono tracking-widest uppercase">
                                                Ticket: {item.ticket_number} • {waitMinutes(item)}m
                                            </div>
                                            {item.notes && (
                                                <div className="text-xs font-sans text-ink-3 italic max-w-[200px] truncate">
                                                    "{item.notes}"
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>

        {/* Discharge Modal */}
        {showDischargeModal && selectedDischargeAdmission && (
            <div className="fixed inset-0 bg-ink/95 backdrop-blur-xl z-[200] flex items-center justify-center p-6 animate-in fade-in duration-500">
                <div className="w-full max-w-4xl bg-white rounded-3xl shadow-2xl overflow-hidden relative border border-line-soft flex flex-col max-h-[90vh]">
                    <button onClick={() => setShowDischargeModal(false)} className="absolute top-8 right-8 text-ink-3 hover:text-ink z-10">
                        <X size={24} />
                    </button>

                    <div className="grid grid-cols-12 h-full overflow-hidden">
                        {/* Left Info Panel */}
                        <div className="col-span-12 lg:col-span-4 bg-canvas p-10 border-r border-line-soft flex flex-col justify-between">
                            <div>
                                <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-brand mb-6 font-bold">Patient Clearance</div>
                                <h2 className="font-serif italic text-5xl text-ink mb-1">{selectedDischargeAdmission.patients?.name}</h2>
                                <p className="font-mono text-[11px] text-ink-3 uppercase tracking-widest mb-8">{selectedDischargeAdmission.patients?.vela_id}</p>
                                
                                <div className="space-y-6">
                                    <div className="p-4 bg-white rounded-2xl border border-line-soft">
                                        <div className="font-mono text-[9px] uppercase tracking-widest text-ink-3 mb-1">Ward Location</div>
                                        <div className="font-serif italic text-lg text-ink">{selectedDischargeAdmission.wards?.name} • Bed {selectedDischargeAdmission.beds?.bed_number}</div>
                                    </div>
                                    <div className="p-4 bg-white rounded-2xl border border-line-soft">
                                        <div className="font-mono text-[9px] uppercase tracking-widest text-ink-3 mb-1">Stay Duration</div>
                                        <div className="font-serif italic text-lg text-ink">{dischargeData?.days || '...'} Days</div>
                                    </div>
                                    <div className="p-4 bg-white rounded-2xl border border-line-soft">
                                        <div className="font-mono text-[9px] uppercase tracking-widest text-ink-3 mb-1">Current Diagnosis</div>
                                        <div className="text-xs text-ink-2 leading-relaxed italic line-clamp-2">{selectedDischargeAdmission.diagnosis}</div>
                                    </div>
                                </div>
                            </div>

                            <div className="mt-12 p-8 bg-brand rounded-2xl text-white shadow-xl shadow-brand-light/20">
                                <div className="font-mono text-[9px] uppercase tracking-widest opacity-70 mb-2">Final Billing Amount</div>
                                <div className="font-serif italic text-4xl mb-1">₹{paymentAmount.toLocaleString()}</div>
                                <div className="font-mono text-[8px] uppercase tracking-widest opacity-50 italic">Calculated by VELA Ledger</div>
                            </div>
                        </div>

                        {/* Right Content Area */}
                        <div className="col-span-12 lg:col-span-8 p-10 flex flex-col h-full overflow-hidden">
                            {!dischargeConfirmed ? (
                                <div className="flex flex-col h-full overflow-hidden">
                                    <div className="flex-1 overflow-y-auto pr-4 custom-scrollbar">
                                        {/* Step 1: Summary Generation */}
                                        <div className="mb-10">
                                            <div className="flex justify-between items-center mb-6">
                                                <h3 className="font-serif italic text-3xl text-ink">Medical Summary</h3>
                                                <button 
                                                    onClick={handleGenerateSummary}
                                                    disabled={processLoading}
                                                    className="px-6 py-2 bg-ink text-white rounded-full text-[10px] font-mono uppercase tracking-widest hover:bg-brand transition-all flex items-center gap-2"
                                                >
                                                    {dischargeSummary ? 'Regenerate Atlas' : 'Generate Atlas Summary'}
                                                </button>
                                            </div>
                                            
                                            {dischargeSummary ? (
                                                <textarea 
                                                    value={dischargeSummary}
                                                    onChange={(e) => setDischargeSummary(e.target.value)}
                                                    className="w-full h-48 bg-canvas border border-line-soft rounded-2xl p-6 font-sans text-xs leading-relaxed text-ink-2 focus:outline-none focus:ring-2 ring-brand-light/10 resize-none transition-all"
                                                />
                                            ) : (
                                                <div className="h-48 border-2 border-dashed border-line-soft rounded-2xl flex items-center justify-center bg-canvas/50">
                                                    {processLoading ? (
                                                        <div className="text-center">
                                                            <div className="w-8 h-8 border-2 border-brand border-t-transparent rounded-full animate-spin mx-auto mb-4"></div>
                                                            <p className="font-mono text-[9px] uppercase tracking-widest text-ink-3">Atlas is analyzing lab reports & notes...</p>
                                                        </div>
                                                    ) : (
                                                        <p className="font-mono text-[9px] uppercase tracking-widest text-ink-3 italic">Click generate to start AI analysis</p>
                                                    )}
                                                </div>
                                            )}
                                        </div>

                                        {/* Step 2: Review & Instructions */}
                                        <div className="grid grid-cols-2 gap-6 mb-10">
                                            <div className="col-span-2">
                                                <Input 
                                                    label="Final Diagnosis confirmed by Doctor" 
                                                    value={finalDiagnosis} 
                                                    onChange={(e) => setFinalDiagnosis(e.target.value)} 
                                                />
                                            </div>
                                            <div>
                                                <Input 
                                                    label="Follow-up Date" 
                                                    type="date"
                                                    value={followUpDate} 
                                                    onChange={(e) => setFollowUpDate(e.target.value)} 
                                                />
                                            </div>
                                            <div>
                                                <label className="block font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-2 ml-1">Payment Method</label>
                                                <select 
                                                    value={paymentMethod}
                                                    onChange={(e) => setPaymentMethod(e.target.value)}
                                                    className="w-full bg-canvas border-b border-line px-2 py-3 font-sans text-xs text-ink focus:outline-none focus:border-brand-light transition-all"
                                                >
                                                    <option>Cash</option>
                                                    <option>Card</option>
                                                    <option>UPI</option>
                                                    <option>Insurance</option>
                                                </select>
                                            </div>
                                            <div className="col-span-2">
                                                <label className="block font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-2 ml-1">Follow-up Instructions</label>
                                                <textarea 
                                                    value={followUpInstructions}
                                                    onChange={(e) => setFollowUpInstructions(e.target.value)}
                                                    className="w-full h-24 bg-canvas border border-line-soft rounded-2xl p-4 font-sans text-xs text-ink-2 focus:outline-none ring-brand-light/10 transition-all"
                                                    placeholder="Medication timing, diet restrictions, etc."
                                                />
                                            </div>
                                        </div>

                                        {/* Step 3: Cost Breakdown */}
                                        <div className="bg-canvas rounded-2xl p-8 border border-line-soft">
                                            <h4 className="font-mono text-[10px] uppercase tracking-widest text-ink font-bold mb-6 flex items-center gap-2">
                                                <FileText size={14} className="text-brand" />
                                                Billing Breakdown
                                            </h4>
                                            <div className="space-y-4">
                                                <div className="flex justify-between items-center text-xs">
                                                    <span className="text-ink-2">Room: {selectedDischargeAdmission.room_type} ({dischargeData?.days} days)</span>
                                                    <span className="font-mono font-bold">₹{dischargeData?.room_cost?.toLocaleString()}</span>
                                                </div>
                                                <div className="flex justify-between items-center text-xs">
                                                    <span className="text-ink-2">Laboratory & Diagnostic Tests</span>
                                                    <span className="font-mono font-bold">₹{dischargeData?.test_cost?.toLocaleString()}</span>
                                                </div>
                                                <div className="h-[1px] bg-line mt-2"></div>
                                                <div className="flex justify-between items-center">
                                                    <span className="font-mono text-[10px] uppercase tracking-widest text-ink font-bold">Total Stay & Treatment Cost</span>
                                                    <span className="font-serif italic text-2xl text-ink">₹{dischargeData?.total?.toLocaleString()}</span>
                                                </div>
                                            </div>
                                        </div>
                                    </div>

                                    <div className="pt-8 border-t border-line-soft flex items-center justify-between mt-auto">
                                        <div className="flex items-center gap-4">
                                            <span className="w-3 h-3 rounded-full bg-brand animate-pulse"></span>
                                            <span className="font-mono text-[9px] uppercase tracking-widest text-ink-3">Ledger Status: Balanced</span>
                                        </div>
                                        <button 
                                            onClick={handleConfirmDischarge}
                                            disabled={processLoading || !dischargeSummary}
                                            className="px-12 py-4 bg-brand text-white rounded-2xl font-mono text-[10px] uppercase tracking-[0.2em] shadow-xl shadow-brand-light/20 hover:scale-[1.02] active:scale-[0.98] transition-all disabled:opacity-50"
                                        >
                                            {processLoading ? 'Processing Clearance...' : 'Confirm Final Discharge'}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center justify-center p-12 text-center h-full animate-in zoom-in duration-500">
                                    <div className="w-24 h-24 bg-success-tint text-success rounded-full flex items-center justify-center mb-8">
                                        <CheckCircle2 size={48} strokeWidth={1.5} />
                                    </div>
                                    <h3 className="font-serif italic text-5xl text-ink mb-4">Clearance Successful</h3>
                                    <p className="text-ink-2 font-mono text-[10px] uppercase tracking-widest mb-12 max-w-sm mx-auto leading-relaxed">
                                        Patient {selectedDischargeAdmission.patients?.name} has been marked as discharged. Ward and billing records are synced.
                                    </p>
                                    
                                    <div className="grid grid-cols-2 gap-4 w-full max-w-md">
                                        <button 
                                            onClick={() => handlePrint('summary')}
                                            className="flex flex-col items-center gap-4 p-6 bg-canvas border border-line-soft rounded-2xl hover:bg-white hover:border-brand/30 hover:shadow-xl transition-all group"
                                        >
                                            <div className="p-3 bg-white rounded-xl text-ink-3 group-hover:text-brand transition-colors shadow-sm">
                                                <FileText size={20} />
                                            </div>
                                            <span className="font-mono text-[9px] uppercase tracking-widest text-ink-2">Print Summary</span>
                                        </button>
                                        <button 
                                            onClick={() => handlePrint('receipt')}
                                            className="flex flex-col items-center gap-4 p-6 bg-canvas border border-line-soft rounded-2xl hover:bg-white hover:border-brand/30 hover:shadow-xl transition-all group"
                                        >
                                            <div className="p-3 bg-white rounded-xl text-ink-3 group-hover:text-brand transition-colors shadow-sm">
                                                <CreditCard size={20} />
                                            </div>
                                            <span className="font-mono text-[9px] uppercase tracking-widest text-ink-2">Print Receipt</span>
                                        </button>
                                    </div>

                                    <button 
                                        onClick={() => setShowDischargeModal(false)}
                                        className="mt-12 font-mono text-[10px] uppercase tracking-widest text-brand hover:text-brand-dark font-bold"
                                    >
                                        Complete & Exit →
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        )}

        <style>{`
            @media print {
                body * { visibility: hidden; }
                .print-content, .print-content * { visibility: visible; }
                .print-content { position: absolute; left: 0; top: 0; width: 100%; }
            }
            .custom-scrollbar::-webkit-scrollbar { width: 4px; }
            .custom-scrollbar::-webkit-scrollbar-track { background: transparent; }
            .custom-scrollbar::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.05); border-radius: 10px; }
            .animate-pulse { animation: pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite; }
            @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
        `}</style>
      </main>
        {/* PAYMENT MODAL */}
        {showPaymentModal && selectedTestOrder && (
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-ink/40 backdrop-blur-sm animate-in fade-in transition-all">
             <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden border border-line animate-in zoom-in-95 duration-300">
                <div className="p-8 border-b border-line-soft flex justify-between items-center bg-canvas">
                   <div>
                      <h3 className="font-serif italic text-3xl text-ink mb-1">Compute Fees</h3>
                      <p className="font-mono text-[10px] text-ink-3 uppercase tracking-widest">{selectedTestOrder.patients?.name}</p>
                   </div>
                   <button onClick={() => setShowPaymentModal(false)} className="p-2 text-ink-3 hover:text-ink"><X size={20} /></button>
                </div>
                
                <div className="p-8 space-y-6">
                   <div className="space-y-3">
                      <div className="flex justify-between items-center text-sm font-medium text-ink-2 border-b border-canvas pb-3">
                         <span>Diagnostic Tool</span>
                         <span>Estimated Fee</span>
                      </div>
                      
                      <div className="flex justify-between items-center">
                         <span className="text-ink">{selectedTestOrder.test_type}</span>
                         <span className="font-mono text-brand">₹{orderPrice(selectedTestOrder)}</span>
                      </div>

                      <div className="pt-6 border-t border-line-soft flex justify-between items-center">
                         <span className="font-serif text-2xl text-ink">Total Due</span>
                         <div className="text-right">
                            <span className="text-3xl font-mono font-bold text-ink">₹{orderPrice(selectedTestOrder)}</span>
                            <div className="text-[9px] font-mono text-ink-3 uppercase tracking-widest">Tax Integrated</div>
                         </div>
                      </div>
                   </div>

                   <button
                      onClick={() => handleConfirmPayment(selectedTestOrder.id, orderPrice(selectedTestOrder))}
                      className="w-full py-5 bg-brand text-white font-mono text-[12px] font-bold uppercase tracking-[0.3em] hover:bg-brand-dark rounded-2xl transition-all shadow-xl shadow-brand-light/30 active:scale-[0.98]"
                   >
                      Confirm Collection
                   </button>
                   <button
                      onClick={() => cancelTestOrder(selectedTestOrder)}
                      disabled={cancellingOrderId === selectedTestOrder.id}
                      className="w-full py-3 text-danger font-mono text-[10px] font-bold uppercase tracking-[0.2em] hover:bg-danger-tint rounded-xl transition-all disabled:opacity-40 disabled:cursor-wait"
                   >
                      Cancel This Test
                   </button>
                   <p className="text-center text-[10px] font-mono text-ink-3 uppercase tracking-[0.1em]">Print Receipt Auto-Queued</p>
                </div>
             </div>
          </div>
        )}

        {/* ADMISSION MODAL */}
        {showAdmissionModal && selectedRecommendation && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-ink/60 backdrop-blur-md animate-in fade-in transition-all">
                <div className="bg-white w-full max-w-xl rounded-2xl shadow-2xl overflow-hidden border border-line animate-in zoom-in-95 duration-300">
                    <div className="p-8 border-b border-line-soft flex justify-between items-center bg-canvas">
                        <div>
                            <h3 className="font-serif italic text-3xl text-ink mb-1">Confirm Admission</h3>
                            <p className="font-mono text-[10px] text-ink-3 uppercase tracking-widest">Allocating resources for {selectedRecommendation.patient_name}</p>
                        </div>
                        <button onClick={() => setShowAdmissionModal(false)} className="p-2 text-ink-3 hover:text-ink transition-colors"><X size={24} /></button>
                    </div>

                    <div className="p-10 space-y-8">
                        <div className="grid grid-cols-2 gap-8">
                            <div>
                                <label className="block font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-3 ml-1">Select Ward</label>
                                <select 
                                    className="w-full bg-canvas border border-line p-4 rounded-xl text-ink text-sm focus:outline-none focus:border-brand transition-all appearance-none"
                                    value={admissionForm.ward_id}
                                    onChange={(e) => setAdmissionForm(prev => ({ ...prev, ward_id: e.target.value, bed_id: '' }))}
                                >
                                    <option value="">Select a Ward</option>
                                    {wards.map(w => (
                                        <option key={w.id} value={w.id}>{w.name} ({w.type})</option>
                                    ))}
                                </select>
                            </div>

                            <div>
                                <label className="block font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-3 ml-1">Select Bed</label>
                                <select 
                                    className="w-full bg-canvas border border-line p-4 rounded-xl text-ink text-sm focus:outline-none focus:border-brand transition-all appearance-none disabled:opacity-50"
                                    value={admissionForm.bed_id}
                                    disabled={!admissionForm.ward_id}
                                    onChange={(e) => setAdmissionForm(prev => ({ ...prev, bed_id: e.target.value }))}
                                >
                                    <option value="">Select a Bed</option>
                                    {wards.find(w => w.id === admissionForm.ward_id)?.beds
                                        .filter((b: any) => b.status === 'available')
                                        .map((b: any) => (
                                            <option key={b.id} value={b.id}>Bed {b.bed_number}</option>
                                        ))
                                    }
                                </select>
                            </div>
                        </div>

                        <div className="grid grid-cols-2 gap-8">
                            <div>
                                <label className="block font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-3 ml-1">Room Type</label>
                                <select 
                                    className="w-full bg-canvas border border-line p-4 rounded-xl text-ink text-sm focus:outline-none focus:border-brand transition-all appearance-none"
                                    value={admissionForm.room_type}
                                    onChange={(e) => setAdmissionForm(prev => ({ ...prev, room_type: e.target.value }))}
                                >
                                    {roomTypes.map(r => (
                                        <option key={r.id} value={r.name}>{r.name} - ₹{r.cost_per_day}/day</option>
                                    ))}
                                </select>
                            </div>
                            <div className="flex flex-col justify-end">
                                <div className="p-4 bg-brand-tint border border-brand-soft rounded-xl">
                                    <span className="font-mono text-[10px] text-brand-light uppercase tracking-widest mr-2">Estimated Rate:</span>
                                    <span className="font-mono text-lg font-bold text-brand">₹{roomTypes.find(r => r.name === admissionForm.room_type)?.cost_per_day || 0}</span>
                                </div>
                            </div>
                        </div>

                        <div>
                            <Input label="Final Diagnosis" value={admissionForm.diagnosis} onChange={(e) => setAdmissionForm(prev => ({ ...prev, diagnosis: e.target.value }))} placeholder={selectedRecommendation.reason} />
                        </div>

                        <button 
                            onClick={handleConfirmAdmission}
                            disabled={confirmingAdmission || !admissionForm.bed_id}
                            className="w-full py-5 bg-brand text-white font-mono text-[12px] font-bold uppercase tracking-[0.3em] hover:bg-brand-dark rounded-2xl transition-all shadow-xl shadow-brand-light/30 disabled:opacity-50"
                        >
                            {confirmingAdmission ? 'Confirming with Central Registry...' : 'Finalize Admission'}
                        </button>
                    </div>
                </div>
            </div>
        )}

        {/* SUCCESS MODAL with QR */}
        {successAdmission && (
            <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-ink/90 backdrop-blur-xl animate-in fade-in transition-all">
                <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl p-12 text-center relative animate-in zoom-in-95 duration-500">
                    <button onClick={() => setSuccessAdmission(null)} className="absolute top-8 right-8 text-line-strong hover:text-ink transition-colors"><X size={24} /></button>
                    
                    <div className="w-20 h-20 bg-success-tint text-success rounded-full flex items-center justify-center mx-auto mb-8 animate-bounce">
                        <CheckCircle2 size={40} />
                    </div>

                    <h3 className="font-serif italic text-4xl text-ink mb-2">Admission Confirmed</h3>
                    <p className="font-mono text-[10px] text-ink-3 uppercase tracking-[0.2em] mb-10">Patient lifecycle synchronized</p>

                    <div className="bg-canvas p-10 rounded-2xl mb-10 border border-line-soft flex flex-col items-center">
                        <div className="p-4 bg-white rounded-2xl shadow-sm mb-6">
                            <QRCodeSVG value={successAdmission.admission_qr} size={180} />
                        </div>
                        <div className="font-mono text-xl font-bold text-ink tracking-wider">
                            {successAdmission.admission_qr}
                        </div>
                        <p className="text-[10px] font-mono text-ink-3 uppercase tracking-widest mt-2">{successAdmission.ward_name} <span className="mx-2">•</span> BED {successAdmission.bed_number}</p>
                    </div>

                    <p className="text-xs text-ink-2 leading-relaxed max-w-[280px] mx-auto mb-8 font-light italic">
                        The patient record is now active in the ward database. Scan this code at any ward terminal for clinical history.
                    </p>

                    <button 
                        onClick={() => {
                            setSuccessAdmission(null)
                            setActiveTab('admissions')
                        }}
                        className="w-full py-4 bg-ink text-white rounded-2xl font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-ink transition-all"
                    >
                        Back to Console
                    </button>
                </div>
            </div>
        )}
        {/* ── ASSIGN DOCTOR MODAL ── */}
        {showAssignModal && selectedApt && (
            <div className="fixed inset-0 bg-ink/90 backdrop-blur-xl z-[200] flex items-center justify-center p-8 animate-in fade-in duration-500">
                <div className="bg-white max-w-4xl w-full rounded-3xl overflow-hidden shadow-2xl border border-white/20 animate-in slide-in-from-bottom-12 duration-700">
                    <div className="p-12 border-b border-line-soft flex justify-between items-start">
                        <div>
                            <span className="font-mono text-[10px] uppercase tracking-[0.4em] text-brand font-bold mb-4 block">Deployment Console</span>
                            <h2 className="font-serif italic text-5xl text-ink m-0">Assign Specialist</h2>
                            <p className="font-mono text-[10px] uppercase tracking-widest text-ink-3 mt-4">
                                Patient: <span className="text-ink font-bold font-sans normal-case">{selectedApt.patients?.name || selectedApt.patient_name}</span>
                                <span className="mx-4 text-line">|</span>
                                VELA ID: <span className="text-brand font-bold">{selectedApt.vela_id || 'LOCAL-REG'}</span>
                            </p>
                        </div>
                        <button onClick={() => setShowAssignModal(false)} className="p-4 hover:bg-canvas rounded-full transition-colors">
                            <X size={32} strokeWidth={1} text-line-strong />
                        </button>
                    </div>

                    <div className="p-12 max-h-[60vh] overflow-y-auto">
                        <div className="mb-12">
                            <label className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-6 block">Triage Level & Priority</label>
                            <div className="grid grid-cols-3 gap-4">
                                {[
                                    { id: 'Routine', color: 'bg-success-tint text-success', active: 'bg-success text-white' },
                                    { id: 'Stable', color: 'bg-brand-tint text-brand', active: 'bg-brand text-white' },
                                    { id: 'Urgent', color: 'bg-rose-50 text-rose-600', active: 'bg-rose-600 text-white' }
                                ].map(level => (
                                    <button
                                        key={level.id}
                                        onClick={() => setTriageLevel(level.id)}
                                        className={`px-8 py-5 rounded-2xl font-mono text-[10px] uppercase tracking-widest transition-all flex items-center justify-center gap-3 border border-transparent ${triageLevel === level.id ? level.active : 'bg-canvas text-ink-3 hover:border-line'}`}
                                    >
                                        {level.id === 'Urgent' && <ShieldAlert size={16} />}
                                        {level.id}
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div>
                            <label className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-6 block">Available Medical Personnel</label>
                            <div className="grid grid-cols-1 gap-4">
                                {doctorStats.length === 0 ? (
                                    <div className="py-20 text-center border border-line-soft border-dashed rounded-2xl">
                                        <p className="font-mono text-[10px] uppercase tracking-widest text-ink-3">No personnel currently listed as active in registry</p>
                                    </div>
                                ) : (
                                    doctorStats.map(doc => (
                                        <div key={doc.id} className="p-8 border border-line-soft rounded-2xl flex items-center justify-between hover:border-brand/30 transition-all bg-canvas/30 group">
                                            <div className="flex items-center gap-8">
                                                <div className="w-16 h-16 rounded-2xl bg-white border border-line-soft flex items-center justify-center text-line-strong">
                                                    <Stethoscope size={28} />
                                                </div>
                                                <div>
                                                    <h3 className="font-serif italic text-3xl text-ink group-hover:text-brand transition-all">Dr. {doc.name}</h3>
                                                    <div className="flex gap-4 items-center mt-2">
                                                        <span className="font-mono text-[9px] uppercase tracking-widest text-brand bg-brand-tint px-3 py-1 rounded-full">{doc.specialization}</span>
                                                        <span className={`w-1.5 h-1.5 rounded-full ${doc.online ? 'bg-success animate-pulse' : 'bg-line'}`}></span>
                                                        <span className="font-mono text-[9px] uppercase tracking-widest text-ink-3">{doc.online ? 'Online' : 'Offline'}</span>
                                                    </div>
                                                </div>
                                            </div>
                                            
                                            <div className="flex items-center gap-12">
                                                <div className="flex gap-8">
                                                    <div className="text-center">
                                                        <div className="font-serif italic text-4xl text-ink leading-none">{doc.waiting_count}</div>
                                                        <div className="font-mono text-[9px] uppercase tracking-widest text-ink-3 mt-2">Waiting</div>
                                                    </div>
                                                    <div className="text-center">
                                                        <div className="font-serif italic text-4xl text-ink leading-none">{doc.consulting_count}</div>
                                                        <div className="font-mono text-[9px] uppercase tracking-widest text-ink-3 mt-2">Inside</div>
                                                    </div>
                                                </div>
                                                <button 
                                                    onClick={() => handleAssignSubmit(doc.id)}
                                                    disabled={assigning}
                                                    className="px-8 py-4 bg-ink text-white rounded-2xl font-mono text-[10px] uppercase tracking-widest hover:bg-brand transition-all shadow-xl shadow-ink/10"
                                                >
                                                    {assigning ? '...' : 'Assign'}
                                                </button>
                                            </div>
                                        </div>
                                    ))
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        )}

    </div>
  )
}


function Input({ label, className = "", ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
    return (
        <div className={className}>
            <label className="block font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-2 ml-1">{label}</label>
            <input 
                {...props}
                className="w-full bg-transparent border-b border-line-strong rounded-none px-2 py-3 font-sans text-ink placeholder-ink-3 focus:outline-none focus:border-line-strong transition-colors"
                autoComplete="off"
            />
        </div>
    )
}
