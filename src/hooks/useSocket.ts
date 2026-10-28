import { SOCKET_URL } from "../utils/config";
import { useEffect } from "react"
import { io } from "socket.io-client"
import toast from "react-hot-toast"
import { getToken } from "../utils/auth"

// Real-time event payloads. Fields are the ones handlers across the app
// actually read (Doctor, Receptionist, PatientDashboard, PatientDetail,
// ImagingAnalysis) — named and typed where accessed, with an index signature
// for the rest, since payload shape isn't independently enforced on the
// Python/socket.io side and a hand-maintained exhaustive contract would just
// go stale.
export interface SocketEventPayload {
  patient_id?: string
  patient_name?: string
  name?: string
  risk_score?: number
  risk_level?: string
  summary?: string
  medication?: string
  bed_number?: string | number
  status?: string
  message?: string
  role?: string
  billing_mode?: string
  ticket_number?: string
  test_type?: string
  study?: string
  notes?: string
  follow_up_days?: number
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prescriptions?: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lab_requisitions?: any[]
  abnormal_fields?: string[]
  [key: string]: unknown
}

// The server refuses sockets without a session token and decides which rooms
// (hospital / patient) a socket joins from that session. So the socket only
// connects once there is a token, and re-reads it on every (re)connect.
export const socket = io(SOCKET_URL, {
  autoConnect: false,
  auth: (cb) => cb({ token: getToken() }),
})

export function connectSocket() {
  if (getToken() && !socket.connected) socket.connect()
}

// A new login must not keep riding the previous user's socket session.
export function resetSocket() {
  if (socket.connected) socket.disconnect()
}

export default function useSocket() {
  useEffect(() => {
    connectSocket()
    socket.on("risk_alert", (data: SocketEventPayload) => {
      toast.error(
        `RISK ALERT — ${data.patient_name} · Score: ${data.risk_score}/100\n${data.summary}`,
        { duration: 10000, style: { fontFamily: "Geist Mono", fontSize: "13px" } }
      )
      const utterance = new SpeechSynthesisUtterance(
        `Risk alert. ${data.patient_name}. Risk score ${data.risk_score}. ${data.summary}`
      )
      utterance.rate = 1.1
      utterance.volume = 1
      window.speechSynthesis.speak(utterance)
    })

    socket.on("deterioration_alert", (data: SocketEventPayload) => {
      toast(`DETERIORATION — ${data.summary}`,
        { duration: 10000, icon: "⚠️", style: { fontFamily: "Geist Mono", fontSize: "13px" } }
      )
    })

    socket.on("medication_warning", (data: SocketEventPayload) => {
      toast(`MEDICATION WARNING — ${data.medication} · Risk: ${(data.risk_level || '').toUpperCase()}`,
        { duration: 12000, icon: "💊", style: { fontFamily: "Geist Mono", fontSize: "13px" } }
      )
    })

    socket.on("recommendations_ready", () => {
      toast.success(`Recommendations ready for patient`,
        { duration: 4000, style: { fontFamily: "Geist Mono", fontSize: "13px" } }
      )
    })

    socket.on("next_patient", (data: SocketEventPayload) => {
      // Do NOT automatically speak the atlas summary on next patient turn announcement.
      // Speech should only occur on-demand when the doctor queries Atlas manually.
      toast.success(`Next: ${data.patient_name}`, { duration: 5000 })
      window.dispatchEvent(new CustomEvent("navigate_to_patient", { detail: { patient_id: data.patient_id } }))
    })

    const handlePatientCompleted = (data: SocketEventPayload) => {
      toast.success(`Consultation completed: ${data.patient_name || ''}`)
      window.dispatchEvent(new CustomEvent("patient_completed", { detail: data }))
    }
    socket.on("patient_completed", handlePatientCompleted)

    socket.on("patient_registered", (data: SocketEventPayload) => {
      toast.success(`New patient registered: ${data.patient_name || ''}`, { icon: "🆕", duration: 4000 })
    })

    socket.on("atlas_analysis_ready", (data: SocketEventPayload) => {
      toast.success(`Atlas analysis ready for ${data.patient_name || 'patient'}`, { icon: "🧠", duration: 5000 })
    })

    socket.on("lab_report_submitted", (data: SocketEventPayload) => {
      toast.success(`Lab report submitted: ${data.patient_name || ''}`, { icon: "📊", duration: 6000 })
    })

    socket.on("patient_admitted_qr", (data: SocketEventPayload) => {
      toast.success(`${data.patient_name || 'Patient'} admitted — QR generated`, { icon: "🏥", duration: 6000 })
    })

    socket.on("patient_discharged", (data: SocketEventPayload) => {
      toast(`${data.patient_name || 'Patient'} discharged`, { icon: "🏠", duration: 5000 })
    })

    socket.on("bed_status_changed", (data: SocketEventPayload) => {
      toast(`Bed ${data.bed_number || ''} status: ${data.status || ''}`, { icon: "🛏", duration: 4000 })
    })

    socket.on("discharge_recommended", (data: SocketEventPayload) => {
      toast(`Discharge recommended: ${data.patient_name || ''}`, { icon: "📋", duration: 6000 })
    })

    socket.on("admission_recommended", (data: SocketEventPayload) => {
      toast(`Admission recommended: ${data.patient_name || ''}`, { icon: "🏥", duration: 6000 })
    })

    socket.on("test_ordered", (data: SocketEventPayload) => {
      toast(`Test ordered for ${data.patient_name || ''}`, { icon: "🔬", duration: 4000 })
    })

    socket.on("payment_confirmed", (data: SocketEventPayload) => {
      toast.success(`Payment confirmed: ${data.patient_name || ''}`, { icon: "💳", duration: 4000 })
    })

    socket.on("queue_updated", () => {
      window.dispatchEvent(new CustomEvent("vela_queue_updated"))
    })

    socket.on("queue_position_update", (data: SocketEventPayload) => {
      window.dispatchEvent(new CustomEvent("vela_queue_position_updated", { detail: data }))
    })

    socket.on("new_appointment", (data: SocketEventPayload) => {
      toast(`New appointment: ${data.patient_name || ''}`, { icon: "📅", duration: 4000 })
    })

    socket.on("appointment_approved", (data: SocketEventPayload) => {
      toast.success(`Appointment approved: ${data.patient_name || ''}`, { icon: "✅", duration: 4000 })
    })

    return () => {
      socket.off("risk_alert")
      socket.off("deterioration_alert")
      socket.off("medication_warning")
      socket.off("recommendations_ready")
      socket.off("next_patient")
      socket.off("patient_completed", handlePatientCompleted)
      socket.off("patient_registered")
      socket.off("atlas_analysis_ready")
      socket.off("lab_report_submitted")
      socket.off("patient_admitted_qr")
      socket.off("patient_discharged")
      socket.off("bed_status_changed")
      socket.off("discharge_recommended")
      socket.off("admission_recommended")
      socket.off("test_ordered")
      socket.off("payment_confirmed")
      socket.off("queue_updated")
      socket.off("queue_position_update")
      socket.off("new_appointment")
      socket.off("appointment_approved")
    }
  }, [])

  return socket
}
