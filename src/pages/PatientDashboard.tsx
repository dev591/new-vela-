import { openGeneratedDocument } from "../utils/documents";
import { API_URL, POLL_INTERVALS, OVERPASS_MIRRORS } from "../utils/config";
import { Activity, Calendar, Download, FileText, Pill, User, X, MapPin, Mic, CalendarPlus, ChevronRight, Clock, CheckCircle, AlertCircle, CheckCircle2, Upload, Trash2, Phone, LogOut, Pencil } from "lucide-react";
import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import toast from "react-hot-toast";
import { QRCodeSVG } from 'qrcode.react';
import mapboxgl from 'mapbox-gl';
import useSocket, { type SocketEventPayload } from "../hooks/useSocket";

/**
 * Ordered the way a patient's needs are, not the way the data model is:
 * booking and upcoming visits before records and archives. `primary` marks the
 * five that fit a phone's bottom bar; `short` is the label at that width.
 */
const PATIENT_TABS = [
  { id: 'home',         label: 'Home',          short: 'Home',      icon: User,     primary: true },
  { id: 'find-care',    label: 'Book a visit',  short: 'Book',      icon: MapPin,   primary: true },
  { id: 'appointments', label: 'Appointments',  short: 'Visits',    icon: Calendar, primary: true },
  { id: 'medications',  label: 'My medicines',  short: 'Medicines', icon: Pill,     primary: true },
  { id: 'reports',      label: 'Test results',  short: 'Results',   icon: Activity, primary: true },
  { id: 'history',      label: 'My records',    short: 'Records',   icon: FileText, primary: false },
  { id: 'atlas',        label: 'Ask Atlas',     short: 'Atlas',     icon: Mic,      primary: false },
];

// A patient app must open instantly: paint from the last saved copy, then refresh quietly.
const readCache = <T,>(key: string, fallback: T): T => {
  try { const v = JSON.parse(localStorage.getItem(key) || "null"); return v ?? fallback; } catch { return fallback; }
};
const writeCache = (key: string, value: unknown) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full/blocked */ } };
// Saved lists belong to one patient; never show them to whoever signs in next on this device.
const readOwnCache = <T,>(key: string, fallback: T): T => {
  const me = readCache<any>("vela_patient", null)?.id;
  return me && localStorage.getItem("vela_dash_owner") === me ? readCache<T>(key, fallback) : fallback;
};

const PatientDashboard = () => {
  const [patient, setPatient] = useState<any>(() => readCache<any>("vela_patient", null));
  const [isEditModalOpen, setIsEditModalOpen] = useState(false);
  const [editForm, setEditForm] = useState<any>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isUploading, setIsUploading] = useState(false);

  const [documents, setDocuments] = useState<any[]>(() => readOwnCache<any[]>("vela_dash_docs", []));
  const [medications, setMedications] = useState<any[]>(() => readOwnCache<any[]>("vela_dash_meds", []));
  // const [notes, setNotes] = useState<any[]>([]);
  const [loading, setLoading] = useState(() => !readCache<any>("vela_patient", null)?.id);
  const [activeTab, setActiveTab] = useState("home"); 
  const navigate = useNavigate();

  // Find Care State
  const [location, setLocation] = useState<{lat: number, lng: number} | null>(null);
  const [symptoms, setSymptoms] = useState("");
  const [isListeningFindCare, setIsListeningFindCare] = useState(false);
  const [isTriageLoading, setIsTriageLoading] = useState(false);
  const [triageResult, setTriageResult] = useState<any>(null);
  const [hospitals, setHospitals] = useState<any[]>([]);
  const [isSearchingHospitals, setIsSearchingHospitals] = useState(false);
  const mapRef = useRef<HTMLDivElement>(null);          // DOM container for map
  const mapInstanceRef = useRef<mapboxgl.Map | null>(null);  // Mapbox map instance
  const userLocationRef = useRef<{lat: number, lng: number} | null>(null);

  // Booking Modal
  const [bookingHospital, setBookingHospital] = useState<any>(null);
  const [selectedHospital, setSelectedHospital] = useState<any>(null);
  const [bookingDate, setBookingDate] = useState("");
  const [bookingTime, setBookingTime] = useState("");
  const [bookingDoctors, setBookingDoctors] = useState<any[]>([]);
  const [selectedBookingDoctor, setSelectedBookingDoctor] = useState("");
  const [bookingNotes, setBookingNotes] = useState("");
  const [networkHospitals, setNetworkHospitals] = useState<any[]>([]);
  const [bookingNetworkHospitalId, setBookingNetworkHospitalId] = useState<string | null>(null);
  // Solo/independent doctors — see plan Phase 5. A lighter booking flow than
  // the hospital modal since there's no department/doctor-picker step: the
  // provider IS the doctor.
  const [networkDoctors, setNetworkDoctors] = useState<any[]>([]);
  const [bookingNetworkDoctor, setBookingNetworkDoctor] = useState<any>(null);
  const [networkDoctorDate, setNetworkDoctorDate] = useState("");
  const [networkDoctorTime, setNetworkDoctorTime] = useState("");
  const [bookingNetworkDoctorSubmitting, setBookingNetworkDoctorSubmitting] = useState(false);
  const [bookingSubmitting, setBookingSubmitting] = useState(false);
  const [bookingOptimistic, setBookingOptimistic] = useState(false);
  const [searchMode, setSearchMode] = useState<"triage" | "direct">("triage");
  const [hospitalSearchQuery, setHospitalSearchQuery] = useState("");



  // Atlas State
  const [atlasListening, setAtlasListening] = useState(false);
  const [atlasResponse, setAtlasResponse] = useState("I am Atlas. Hold the mic to speak to me.");
  const recognitionRef = useRef<any>(null);

  // Appointments & Queue Tracking
  const [appointments, setAppointments] = useState<any[]>(() => readOwnCache<any[]>("vela_dash_apts", []));
  const [queueStatus, setQueueStatus] = useState<any>(null);
  const [labHistory, setLabHistory] = useState<any[]>([]);
  const [activeLabOrder, setActiveLabOrder] = useState<any>(null);
  const [isLabLoading, setIsLabLoading] = useState(false);
  const [reassessing, setReassessing] = useState<string | null>(null);
  const [activeAdmission, setActiveAdmission] = useState<any>(null);
  const [patientHistory, setPatientHistory] = useState<any[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [selectedVisit, setSelectedVisit] = useState<any>(null);

  // Test payment requests sent to the patient by their doctor. Tests billed to
  // an active admission never appear here — those are on the hospital bill.
  const [pendingPayments, setPendingPayments] = useState<any[]>([]);
  const [totalDue, setTotalDue] = useState(0);
  const [payingOrderId, setPayingOrderId] = useState<string | null>(null);
  // A doctor usually orders a panel — the patient chooses which of those tests
  // to pay for now, and whether to pay here or at the counter.
  const [selectedTests, setSelectedTests] = useState<string[]>([]);
  const [payingSelected, setPayingSelected] = useState(false);
  const [deferringToCounter, setDeferringToCounter] = useState(false);
  // "Find a lab" — send a not-yet-paid test to a Vela-registered independent
  // lab instead of the hospital's own department (plan Phase 4/5).
  const [networkLabs, setNetworkLabs] = useState<any[]>([]);
  const [routingOrderId, setRoutingOrderId] = useState<string | null>(null);
  const [routingToLabId, setRoutingToLabId] = useState<string | null>(null);

  const socket = useSocket();

  useEffect(() => {
    if (location || selectedHospital || networkHospitals.length || bookingNetworkHospitalId) {
      console.log("[FindCare] Map configuration active");
    }
  }, [location, selectedHospital, networkHospitals, bookingNetworkHospitalId]);

  useEffect(() => {
    if (bookingHospital?.is_vela) {
      setSelectedBookingDoctor("");
      setBookingDoctors([]);
      axios.get(`${API_URL}/api/receptionist/doctors-status?hospital_id=${bookingHospital.id}`)
        .then(res => {
          if (res.data?.status === 'success') {
            setBookingDoctors(res.data.doctors || []);
          }
        })
        .catch(err => console.error(err));
    }
  }, [bookingHospital]);

  const fetchPatientData = async () => {
    const velaId = localStorage.getItem("vela_vela_id");
    if (!velaId || velaId === "null" || velaId === "undefined") {
      localStorage.removeItem("vela_vela_id");
      localStorage.removeItem("vela_patient");
      localStorage.removeItem("vela_auth");
      localStorage.removeItem("vela_role");
      navigate("/portal");
      return;
    }
    const cached = readCache<any>("vela_patient", null);
    try {
      // Appointments only need the patient id, which we already have from the last visit —
      // fetch both at once instead of one after the other.
      const lookupP = axios.get(`${API_URL}/api/receptionist/lookup/${velaId}`);
      const aptP = cached?.id ? axios.get(`${API_URL}/api/appointments/patient/${cached.id}`).catch(() => null) : null;
      const res = await lookupP;
      if (res.data?.status === 'error' || !res.data?.patient) {
        throw Object.assign(new Error(res.data?.message || "Patient record not found."), { notFound: true });
      }

      const p = res.data.patient;
      setPatient(p);
      setDocuments(res.data.documents || []);
      setMedications(res.data.medications || []);
      writeCache("vela_patient", p);
      try { localStorage.setItem("vela_dash_owner", p.id); } catch { /* ignore */ }
      writeCache("vela_dash_docs", res.data.documents || []);
      writeCache("vela_dash_meds", res.data.medications || []);
      setLoading(false);

      const aptRes: any = (aptP && cached?.id === p.id) ? await aptP : null;
      const aptData = aptRes ?? await axios.get(`${API_URL}/api/appointments/patient/${p.id}`);
      const apts = aptData.data.appointments || [];
      setAppointments(apts);
      writeCache("vela_dash_apts", apts);

      fetchLabHistory(p.id);
      fetchPendingPayments(p.id);
      fetchNetworkLabs();
      fetchActiveAdmission(p.id);

      // Check for arrived appointment/live queue
      const arrivedApt = apts.find((a: any) => a.status === 'arrived');
      if (arrivedApt) {
          const qRes = await axios.get(`${API_URL}/api/appointments/queue/${arrivedApt.id}`);
          if (qRes.data.status === 'success') {
              setQueueStatus(qRes.data);
          }
      }
    } catch (err: any) {
      console.error(err);
      if (cached?.id && !err?.notFound) {
        // Backend hiccup: keep the patient in the app with what we have.
        toast.error("You're offline or the network is slow — showing your saved records.");
        return;
      }
      toast.error(err.message || "Could not load your records");
      localStorage.removeItem("vela_vela_id");
      localStorage.removeItem("vela_patient");
      localStorage.removeItem("vela_auth");
      localStorage.removeItem("vela_role");
      navigate("/portal");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPatientData();
  }, [navigate]);

  // Warm the Find Care data in the background so the "Book a visit" tab is instant.
  useEffect(() => {
    const lastLoc = readCache<{lat: number, lng: number} | null>("vela_last_loc", null);
    axios.get(`${API_URL}/api/hospitals/search`, { params: lastLoc ? { lat: lastLoc.lat, lng: lastLoc.lng } : {} })
      .then(r => { if (r.data?.status === 'success') writeCache("vela_partner_hospitals", r.data.hospitals); })
      .catch(() => {});
    axios.get(`${API_URL}/api/network/hospitals`).then(r => { if (r.data?.status === 'success') setNetworkHospitals(r.data.hospitals); }).catch(() => {});
    axios.get(`${API_URL}/api/network/doctors`).then(r => { if (r.data?.status === 'success') setNetworkDoctors(r.data.doctors); }).catch(() => {});
  }, []);

  const fetchActiveAdmission = async (patientId: string) => {
    try {
      const res = await axios.get(`${API_URL}/api/admissions/patient/${patientId}`);
      if (res.data.status === 'success') {
        setActiveAdmission(res.data.admission);
      }
    } catch (err) {
      console.error("Admission fetch error", err);
    }
  };

  const fetchLabHistory = async (patientId: string) => {
    setIsLabLoading(true);
    try {
        const res = await axios.get(`${API_URL}/api/lab/patient/${patientId}`);
        // The endpoint returns `orders`; this previously read `history`, which
        // is never present — so the lab section silently rendered empty.
        const history = res.data?.orders || [];
        setLabHistory(history);
        
        // Check for active (non-completed) lab order for live tracking
        if (Array.isArray(history)) {
          const active = history.find((h: any) => h.status !== 'completed' && h.status !== 'cancelled');
          if (active) {
              axios.get(`${API_URL}/api/lab/queue/${patientId}`)
                  .then(qRes => setActiveLabOrder({ ...active, queue: qRes.data }))
                  .catch(console.error);
          } else {
              setActiveLabOrder(null);
          }
        }
    } catch (err) {
        console.error("Lab fetch error", err);
    } finally {
        setIsLabLoading(false);
    }
  };

  const fetchPendingPayments = async (patientId: string) => {
    try {
      const res = await axios.get(`${API_URL}/api/patient/${patientId}/pending-payments`);
      if (res.data?.status === 'success') {
        const orders = res.data.orders || [];
        setPendingPayments(orders);
        setTotalDue(res.data.total_due || 0);
        // Default to everything selected — paying for the whole panel is the
        // common case; unticking is the deliberate act.
        setSelectedTests(orders.map((o: any) => o.id));
      }
    } catch (err) {
      console.error("Pending payments fetch error", err);
    }
  };

  const fetchNetworkLabs = async () => {
    try {
      const res = await axios.get(`${API_URL}/api/network/labs`);
      if (res.data?.status === 'success') setNetworkLabs(res.data.labs || []);
    } catch (err) {
      console.error("Network labs fetch error", err);
    }
  };

  const routeTestOrder = async (order: any, labId: string, labName: string) => {
    setRoutingToLabId(labId);
    try {
      const res = await axios.patch(`${API_URL}/api/lab/orders/${order.id}/route`, { network_lab_id: labId });
      if (res.data?.status !== 'success') throw new Error(res.data?.message || 'Could not route to that lab');
      toast.success(`${order.test_type} sent to ${labName} — pay there to confirm.`);
      setRoutingOrderId(null);
      refreshAfterPayment();
    } catch (err: any) {
      toast.error(err.response?.data?.message || err.message || 'Could not route to that lab');
    } finally {
      setRoutingToLabId(null);
    }
  };

  const toggleTestSelection = (orderId: string) => {
    setSelectedTests((prev) =>
      prev.includes(orderId) ? prev.filter((id) => id !== orderId) : [...prev, orderId]
    );
  };

  const selectedTotal = pendingPayments
    .filter((o: any) => selectedTests.includes(o.id))
    .reduce((sum: number, o: any) => sum + (o.price || 0), 0);

  const refreshAfterPayment = () => {
    if (patient?.id) {
      fetchPendingPayments(patient.id);
      fetchLabHistory(patient.id);
    }
  };

  const paySelectedTests = async () => {
    if (selectedTests.length === 0) return toast.error('Select at least one test');
    setPayingSelected(true);
    try {
      const res = await axios.post(`${API_URL}/api/lab/orders/pay`, {
        order_ids: selectedTests,
        paid_by: 'patient',
      });
      if (res.data?.status !== 'success') {
        throw new Error(res.data?.message || 'Payment could not be completed');
      }
      const labs = (res.data.departments || []).join(', ');
      toast.success(
        `Paid ₹${res.data.total_paid?.toLocaleString('en-IN')}. Report to the ${labs || 'lab'} to be checked in.`,
        { duration: 7000 }
      );
      if (res.data.failed?.length) {
        toast.error(`${res.data.failed.length} test(s) could not be paid for`);
      }
      refreshAfterPayment();
    } catch (err: any) {
      toast.error(err.message || 'Payment could not be completed');
    } finally {
      setPayingSelected(false);
    }
  };

  const payAtCounter = async () => {
    if (selectedTests.length === 0) return toast.error('Select at least one test');
    setDeferringToCounter(true);
    try {
      const res = await axios.post(`${API_URL}/api/lab/orders/pay-at-counter`, {
        order_ids: selectedTests,
      });
      if (res.data?.status !== 'success') {
        throw new Error(res.data?.message || 'Could not hold those tests for the counter');
      }
      toast.success(res.data.message, { duration: 7000 });
      refreshAfterPayment();
    } catch (err: any) {
      toast.error(err.message || 'Could not hold those tests for the counter');
    } finally {
      setDeferringToCounter(false);
    }
  };

  const payForTest = async (order: any) => {
    setPayingOrderId(order.id);
    try {
      const res = await axios.post(`${API_URL}/api/lab/orders/${order.id}/pay`, {});
      if (res.data?.status === 'success') {
        toast.success(
          res.data.already_paid
            ? `${order.test_type} is already paid for`
            : `Paid — report to the ${res.data.department} lab to be checked in`,
          { duration: 6000 }
        );
        if (patient?.id) {
          fetchPendingPayments(patient.id);
          fetchLabHistory(patient.id);
        }
      } else {
        toast.error(res.data?.message || "Payment could not be completed");
      }
    } catch (err) {
      toast.error("Payment could not be completed");
    } finally {
      setPayingOrderId(null);
    }
  };

  const fetchPatientHistory = async (patientId: string) => {
    setHistoryLoading(true);
    try {
      const res = await axios.get(`${API_URL}/api/history/patient/${patientId}`);
      if (res.data?.status === 'success') {
        setPatientHistory(res.data?.history || []);
      }
    } catch (err) {
      console.error("History fetch error", err);
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab !== "find-care") return;

    // Fetch Vela network hospitals
    axios.get(`${API_URL}/api/network/hospitals`)
      .then(r => { if (r.data.status === 'success') setNetworkHospitals(r.data.hospitals); })
      .catch(console.error);

    // Fetch Vela network solo doctors (verified only — patients never see
    // an unverified license, see plan Phase 3).
    axios.get(`${API_URL}/api/network/doctors`)
      .then(r => { if (r.data.status === 'success') setNetworkDoctors(r.data.doctors); })
      .catch(console.error);

    // Load Mapbox map
    const loadMap = () => {
      const token = import.meta.env.VITE_MAPBOX_TOKEN || "";
      if (!token) { console.error("[Maps] VITE_MAPBOX_TOKEN missing"); return; }
      mapboxgl.accessToken = token;
      // Disable telemetry to prevent ERR_BLOCKED_BY_CLIENT from ad blockers
      (mapboxgl as any).workerCount = 2;

      const initWithLocation = (loc: {lat: number, lng: number}) => {
        setLocation(loc);
        userLocationRef.current = loc;
        console.log("[Maps] Location:", loc);

        if (!mapRef.current) { console.error("[Maps] mapRef not ready"); return; }

        // Destroy existing map if re-entering tab
        if (mapInstanceRef.current) {
          mapInstanceRef.current.remove();
          mapInstanceRef.current = null;
        }

        const map = new mapboxgl.Map({
          container: mapRef.current,
          style: "mapbox://styles/mapbox/light-v11",
          center: [loc.lng, loc.lat],
          zoom: 13,
        });
        mapInstanceRef.current = map;

        // User location marker
        new mapboxgl.Marker({ color: "#0071E3" })
          .setLngLat([loc.lng, loc.lat])
          .setPopup(new mapboxgl.Popup().setHTML("<p style='font-family:Geist,sans-serif;font-size:12px;color:var(--text);margin:0'>📍 You are here</p>"))
          .addTo(map);

        console.log("[Maps] Mapbox ready");
        searchHospitals("", loc.lat, loc.lng);
      };

      // Start from the last known location right away (the GPS prompt can take many seconds),
      // then refine only if the patient has actually moved.
      const lastLoc = readCache<{lat: number, lng: number} | null>("vela_last_loc", null);
      initWithLocation(lastLoc || { lat: 17.3850, lng: 78.4867 });
      navigator.geolocation.getCurrentPosition(
        pos => {
          const fresh = { lat: pos.coords.latitude, lng: pos.coords.longitude };
          writeCache("vela_last_loc", fresh);
          if (!lastLoc || calculateDistance(lastLoc.lat, lastLoc.lng, fresh.lat, fresh.lng) > 1) initWithLocation(fresh);
        },
        () => { /* keep the location we started with */ },
        { maximumAge: 600000, timeout: 5000 }
      );
    };

    loadMap();

    // Auto-search if coming from Diagnostic result
    if (searchMode === "direct" && hospitalSearchQuery) {
        searchHospitals(hospitalSearchQuery);
    }

    return () => {
      // Don't destroy on tab switch — keep map alive
    };
  }, [activeTab]);

  useEffect(() => {
    if (activeTab === "history" && patient?.id) {
      fetchPatientHistory(patient.id);
    }
  }, [activeTab, patient]);

  const initVoice = (onResult: (text: string) => void, onEnd: () => void) => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) {
      toast.error("Speech recognition not supported in this browser");
      onEnd();
      return;
    }
    const recognition = new SR();
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.onresult = (e: any) => onResult(e.results[0][0].transcript);
    recognition.onerror = () => onEnd();
    recognition.onend = () => onEnd();
    recognition.start();
    return recognition;
  };

  useEffect(() => {
    if (!socket) return;

    socket.on("queue_updated", (_data: SocketEventPayload) => {
        // If our arrived appointment was updated
        const arrivedApt = appointments.find((a: any) => a.status === 'arrived');
        if (arrivedApt) {
            axios.get(`${API_URL}/api/appointments/queue/${arrivedApt.id}`)
                .then(res => setQueueStatus(res.data))
                .catch(console.error);
        }
    });

    socket.on("lab_update", (data: SocketEventPayload) => {
        if (data.patient_id === patient?.id) {
            fetchLabHistory(patient.id);
            toast.success(`Lab Status: ${(data.status || '').toUpperCase()}`);
        }
    });

    socket.on("report_submitted", (data: SocketEventPayload) => {
        if (data.patient_id === patient?.id) {
            fetchLabHistory(patient.id);
            fetchPatientData();  // the report is filed as a document too
            const flagged = (data.abnormal_fields || []).length;
            toast.success(
              flagged
                ? `${data.test_type} report ready — ${flagged} value${flagged > 1 ? 's' : ''} flagged for your doctor`
                : `${data.test_type} report ready — all values normal`,
              { icon: '📊', duration: 7000 }
            );
            const u = new SpeechSynthesisUtterance("A new lab report has been submitted and analysed. You can view it in your tests and reports tab.");
            window.speechSynthesis.speak(u);
        }
    });

    // A doctor has ordered tests — the payment request lands here first.
    socket.on("test_payment_requested", (data: SocketEventPayload) => {
        if (data.patient_id === patient?.id) {
            fetchPendingPayments(patient.id);
            toast(data.message || "A new test has been ordered for you.", {
                icon: '💳',
                duration: 10000,
                style: { background: 'var(--brand)', color: '#fff', fontWeight: 600 },
            });
        }
    });

    // Tests ordered while admitted are billed to the stay — no payment needed.
    socket.on("tests_assigned", (data: SocketEventPayload) => {
        if (data.patient_id === patient?.id && data.billing_mode === 'admission') {
            fetchLabHistory(patient.id);
            toast.success(data.message || 'Tests assigned', { icon: '🏥', duration: 8000 });
        }
    });

    socket.on("visit_report_ready", (data: SocketEventPayload) => {
        if (data.patient_id === patient?.id) {
            fetchPatientData();
            toast.success("Your consultation record is ready to view.", { icon: '📄', duration: 7000 });
        }
    });

    socket.on("next_patient", (data: SocketEventPayload) => {
        if (data.patient_id === patient?.id) {
            toast.success("It's your turn! Please proceed to the consultation room.", { duration: 10000 });
            // Speak alert
            const u = new SpeechSynthesisUtterance("It is your turn. Please proceed to the consultation room.");
            window.speechSynthesis.speak(u);
        }
    });

    socket.on("upcoming_patient_notification", (data: SocketEventPayload) => {
        if (data.patient_id === patient?.id) {
            toast("You are next in line! Please make your way toward the consultation room.", {
                icon: "🔔",
                duration: 10000,
                style: {
                    background: "var(--warning)",
                    color: "#FFFFFF",
                    fontWeight: "600"
                }
            });
            // Speak alert
            const u = new SpeechSynthesisUtterance("You are next in line. Please proceed near the consultation room.");
            window.speechSynthesis.speak(u);
        }
    });

    return () => {
        socket.off("queue_updated");
        socket.off("lab_update");
        socket.off("report_submitted");
        socket.off("test_payment_requested");
        socket.off("tests_assigned");
        socket.off("visit_report_ready");
        socket.off("next_patient");
        socket.off("upcoming_patient_notification");
    };
  }, [socket, patient, appointments]);

  const handleSymptomsVoice = () => {
    if (isListeningFindCare) {
      recognitionRef.current?.stop();
    } else {
      setIsListeningFindCare(true);
      recognitionRef.current = initVoice(
        (text) => {
          setSymptoms(text);
          triggerTriage(text);
        },
        () => setIsListeningFindCare(false)
      );
    }
  };

  const handleDocumentUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append("file", file);
    formData.append("patient_id", patient.id);

    setIsUploading(true);
    const loadingToast = toast.loading("Uploading and saving document...");

    try {
      const res = await axios.post(`${API_URL}/api/upload/document`, formData, {
        headers: { "Content-Type": "multipart/form-data" }
      });
      if (res.data.status === "success") {
        toast.success("Document uploaded successfully!", { id: loadingToast });
        fetchPatientData();
      } else {
        throw new Error(res.data.message || "Failed to upload document");
      }
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to upload document.", { id: loadingToast });
    } finally {
      setIsUploading(false);
      if (e.target) e.target.value = "";
    }
  };

  const handleDeleteDocument = async (docId: string) => {
    if (!window.confirm("Are you sure you want to delete this document? This will remove all associated lab records and history.")) {
      return;
    }
    const loadingToast = toast.loading("Deleting document...");
    try {
      const res = await axios.delete(`${API_URL}/api/upload/document/${docId}`);
      if (res.data.status === "success") {
        toast.success("Document deleted successfully!", { id: loadingToast });
        fetchPatientData();
      } else {
        throw new Error(res.data.message || "Failed to delete document");
      }
    } catch (err: any) {
      console.error(err);
      toast.error(err.message || "Failed to delete document.", { id: loadingToast });
    }
  };



  const searchHospitals = async (keyword: string, lat?: number, lng?: number) => {
    const loc = lat !== undefined && lng !== undefined ? { lat, lng } : userLocationRef.current;
    console.log("[FindCare] searchHospitals", keyword, !!mapInstanceRef.current, loc);
    // REMOVED: Strict location check. We want to allow searching even if GPS is not ready.

    setIsSearchingHospitals(true);
    // VELA network hospitals are pre-registered: show them from the last saved copy at once,
    // then let the live results replace them. Never make a patient stare at a spinner for them.
    const toPartner = (vh: any) => ({
      ...vh,
      distance: loc && vh.latitude != null ? calculateDistance(loc.lat, loc.lng, vh.latitude, vh.longitude) : 0,
      lat: vh.latitude, lng: vh.longitude, vicinity: vh.address, is_vela: true,
    });
    const byDistance = (a: any, b: any) => a.distance - b.distance;
    const cachedPartners = readCache<any[]>("vela_partner_hospitals", []);
    if (!keyword && cachedPartners.length) {
      setHospitals(cachedPartners.map(toPartner).filter((h: any) => h.lat && h.lng).sort(byDistance));
      setIsSearchingHospitals(false);
    } else {
      setHospitals([]);
    }

    // 1. Prepare OSM Search if needed
    const radius = 5000;
    let osmQuery = "";
    if (keyword && searchMode === "direct") {
      osmQuery = `[out:json][timeout:25];(node["amenity"~"hospital|clinic"]["name"~"${keyword}",i];node["healthcare"="hospital"]["name"~"${keyword}",i];way["amenity"~"hospital|clinic"]["name"~"${keyword}",i];);out center;`;
    } else if (loc) {
      osmQuery = `[out:json][timeout:25];(node["amenity"="hospital"](around:${radius},${loc.lat},${loc.lng});node["amenity"="clinic"](around:${radius},${loc.lat},${loc.lng});node["healthcare"="doctor"](around:${radius},${loc.lat},${loc.lng});way["amenity"="hospital"](around:${radius},${loc.lat},${loc.lng}););out center;`;
    } else {
      // Fallback if no location and no direct keyword
      osmQuery = `[out:json][timeout:25];(node["amenity"="hospital"];);out limit 5;`;
    }

    let osmData: any = null;
    let velaPartnerData: any[] = [];

    // Parallel fetch: internal Vela partners + OSM (mirrors raced, not tried one by one)
    const partnerPromise = axios.get(`${API_URL}/api/hospitals/search`, { params: { ...(keyword ? { query: keyword } : {}), ...(loc ? { lat: loc.lat, lng: loc.lng } : {}) } })
      .then(res => {
        if (res.data.status === 'success') {
          velaPartnerData = res.data.hospitals;
          if (!keyword) writeCache("vela_partner_hospitals", velaPartnerData);
        }
      })
      .catch(e => console.warn("[FindCare] Partner search failed", e));

    const osmPromise = (async () => {
      try {
        osmData = await Promise.any(OVERPASS_MIRRORS.map(async (mirror) => {
          const res = await fetch(mirror, { method: "POST", body: osmQuery, signal: AbortSignal.timeout(7000) });
          if (!res.ok) throw new Error("mirror " + res.status);
          const text = await res.text();
          if (text.trim().startsWith('<')) throw new Error("mirror returned HTML");
          return JSON.parse(text);
        }));
      } catch {
        console.warn("[FindCare] All OSM mirrors failed");
      }
    })();

    // VELA partners are quick: show them the moment they arrive, while OSM is still loading.
    await partnerPromise;
    if (velaPartnerData.length) {
      setHospitals(velaPartnerData.map(toPartner).filter((h: any) => h.lat && h.lng).sort(byDistance));
      setIsSearchingHospitals(false);
    }
    await osmPromise;

    try {
      const elements = osmData?.elements || [];

      // Combine OSM results with Global Vela partners
      const osmHospitals = elements
        .filter((el: any) => el.tags?.name)
        .map((el: any) => {
          const elLat = el.lat ?? el.center?.lat;
          const elLng = el.lon ?? el.center?.lon;
          const distance = (elLat && elLng && loc) ? calculateDistance(loc.lat, loc.lng, elLat, elLng) : 0;
          return {
            id: String(el.id),
            name: el.tags.name,
            vicinity: el.tags["addr:full"] || el.tags["addr:street"] || el.tags["addr:city"] || "Nearby",
            lat: elLat,
            lng: elLng,
            distance,
            type: el.tags.amenity || el.tags.healthcare || "hospital",
            is_vela: false,
            place_id: `osm_${el.id}`
          };
        });

      const processedPartners = velaPartnerData.map(vh => ({
        ...vh,
        distance: loc ? calculateDistance(loc.lat, loc.lng, vh.latitude, vh.longitude) : 0,
        lat: vh.latitude,
        lng: vh.longitude,
        vicinity: vh.address,
        is_vela: true
      }));

      const combined = [...processedPartners, ...osmHospitals]
        .filter((h: any) => h.lat && h.lng)
        .sort((a: any, b: any) => {
          if (a.is_vela && !b.is_vela) return -1;
          if (!a.is_vela && b.is_vela) return 1;
          return a.distance - b.distance;
        })
        .slice(0, 15);

      // Add markers
      if (mapInstanceRef.current) {
        // Clear existing markers if we had a way to track them, but Mapbox markers are often managed manually.
        // For simplicity, we just add new ones.
        combined.forEach((h: any, i: number) => {
          const el = document.createElement('div');
          if (h.is_vela) {
            el.style.cssText = `width:46px;height:46px;background:var(--brand);border:4px solid #fff;border-radius:14px;display:flex;align-items:center;justify-content:center;color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.25);font-size:20px;font-weight:900;cursor:pointer;box-shadow:0 0 30px rgba(200,184,154,0.9);z-index:20;transform: rotate(45deg);`;
            const inner = document.createElement('div');
            inner.style.cssText = `transform: rotate(-45deg);`;
            inner.innerHTML = 'V';
            el.appendChild(inner);
          } else {
            el.style.cssText = `width:26px;height:26px;background:#0071E3;border:2px solid white;border-radius:50%;display:flex;align-items:center;justify-content:center;color:white;font-size:10px;font-weight:bold;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.4);opacity:0.8;`;
            el.innerHTML = String(i + 1);
          }

          new mapboxgl.Marker({ element: el })
            .setLngLat([h.lng, h.lat])
            .setPopup(
              new mapboxgl.Popup({ offset: 25 }).setHTML(
                `<div style="font-family:Geist,sans-serif;padding:12px;background:var(--text);color:white;border-radius:12px;border:1px solid ${h.is_vela ? 'var(--brand)' : 'transparent'}">
                  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
                    <strong style="color:white;font-size:14px">${h.name}</strong>
                    ${h.is_vela ? '<span style="background:var(--brand);color:#fff;font-size:9px;font-weight:900;padding:2px 6px;border-radius:100px;text-transform:uppercase;letter-spacing:0.1em">VELA PARTNER</span>' : ''}
                  </div>
                  <div style="color:rgba(255,255,255,0.6);font-size:11px;margin-bottom:8px">${h.vicinity}</div>
                  <div style="display:flex;align-items:center;gap:4px">
                    <div style="width:6px;height:6px;border-radius:50%;background:var(--success)"></div>
                    <span style="color:var(--success);font-size:10px;font-weight:700;font-mono;text-transform:uppercase">${h.distance < 1 ? Math.round(h.distance * 1000) + 'm' : h.distance.toFixed(1) + 'km'}</span>
                  </div>
                </div>`
              )
            )
            .addTo(mapInstanceRef.current!);
        });

        if (combined.length > 0) {
            mapInstanceRef.current.flyTo({
              center: [combined[0].lng, combined[0].lat],
              zoom: 12,
              duration: 2000
            });
        }
      }

      setHospitals(combined);
    } catch (err) {
      console.error("[FindCare] Search error:", err);
      toast.error("Search failed. Please try again.");
    } finally {
      setIsSearchingHospitals(false);
    }
  };

  const triggerTriage = async (text: string) => {
    if (!text.trim()) return;
    setIsTriageLoading(true);
    try {
      const res = await axios.post(`${API_URL}/api/symptom/triage`, { symptoms: text });
      const triage = res.data.result;
      setTriageResult(triage);

      if (triage.red_flag) {
        setIsTriageLoading(false);
        return;
      }

      // Search hospitals via Overpass API (no Google Maps needed)
      searchHospitals(triage.search_keyword);
    } catch(err) {
      console.error("[Triage] Error:", err);
      toast.error("Triage analysis failed.");
    } finally {
      setIsTriageLoading(false);
    }
  };

  // Fallback path — the original blocking flow. Used when there isn't enough
  // state to safely build an optimistic appointment (e.g. patient not loaded
  // yet), so the button keeps its disabled/loading behavior instead of
  // showing a confirmation it can't back up.
  const bookNetworkDoctor = async () => {
    if (!bookingNetworkDoctor || !patient?.id) return
    if (!networkDoctorDate || !networkDoctorTime) return toast.error('Pick a date and time')
    setBookingNetworkDoctorSubmitting(true)
    try {
      const res = await axios.post(`${API_URL}/api/network/doctors/appointments/book`, {
        doctor_id: bookingNetworkDoctor.id,
        patient_id: patient.id,
        patient_name: patient.name,
        vela_id: patient.vela_id,
        date: networkDoctorDate,
        time: networkDoctorTime,
      })
      if (res.data?.status !== 'success') throw new Error(res.data?.message || 'Booking failed')
      toast.success(
        res.data.duplicate
          ? `Already booked with Dr. ${bookingNetworkDoctor.name} at that time.`
          : `Booked with Dr. ${bookingNetworkDoctor.name} — they'll see you at the appointment time.`
      )
      setBookingNetworkDoctor(null)
      setNetworkDoctorDate('')
      setNetworkDoctorTime('')
    } catch (err: any) {
      toast.error(err.response?.data?.message || err.message || 'Booking failed')
    } finally {
      setBookingNetworkDoctorSubmitting(false)
    }
  }

  const bookAppointmentBlocking = async () => {
    setBookingSubmitting(true);
    try {
      const doctorObj = bookingDoctors.find(d => d.id === selectedBookingDoctor);
      const payload = {
        patient_id: patient?.id,
        hospital_name: bookingHospital.name,
        hospital_address: bookingHospital.vicinity,
        hospital_id: bookingHospital.is_vela ? bookingHospital.id : null,
        date: bookingDate,
        time: bookingTime,
        doctor_id: selectedBookingDoctor || null,
        doctor_name: doctorObj ? doctorObj.name : "General Physician",
        notes: bookingNotes,
        checklist: {
          reports: true,
          medications: true,
          allergies: true,
          history: true
        }
      };

      const bookRes = await axios.post(`${API_URL}/api/appointments/book`, payload);

      // The backend returns the existing row instead of inserting when this
      // slot is already booked. Saying "success" there tells the patient a
      // booking was made that does not exist.
      if (bookRes.data?.duplicate) {
        toast.error("You already have an appointment at this date and time. Pick a different slot.");
      } else if (bookingHospital.is_vela) {
        toast.success(`Priority Appointment Request sent to ${bookingHospital.name}. The receptionist will confirm shortly.`);
      } else {
        toast.success("Appointment Scheduled Successfully");
      }

      setSelectedBookingDoctor("");
      setBookingNotes("");
      setBookingHospital(null);
      const aptRes = await axios.get(`${API_URL}/api/appointments/patient/${patient.id}`);
      setAppointments(aptRes.data.appointments || []);
    } catch(err) {
      console.error("[Booking] Error booking appointment:", err);
      toast.error("Booking failed. Please try again.");
    } finally {
      setBookingSubmitting(false);
    }
  };

  const bookAppointment = async () => {
    if (!bookingDate || !bookingTime) {
      toast.error("Date and Time are required");
      return;
    }
    if (bookingSubmitting || bookingOptimistic) return;

    // Without a hospital or a loaded patient we can't construct a safe
    // optimistic entry (and the modal that owns this button never renders
    // without bookingHospital anyway) — fall back to the plain blocking flow.
    if (!bookingHospital || !patient?.id) {
      return bookAppointmentBlocking();
    }

    const doctorObj = bookingDoctors.find(d => d.id === selectedBookingDoctor);
    const payload = {
      patient_id: patient.id,
      hospital_name: bookingHospital.name,
      hospital_address: bookingHospital.vicinity,
      hospital_id: bookingHospital.is_vela ? bookingHospital.id : null,
      date: bookingDate,
      time: bookingTime,
      doctor_id: selectedBookingDoctor || null,
      doctor_name: doctorObj ? doctorObj.name : "General Physician",
      notes: bookingNotes,
      checklist: { reports: true, medications: true, allergies: true, history: true }
    };

    // Snapshot the form so a failed save can restore it exactly, letting the
    // patient retry without re-entering anything.
    const snapshot = {
      hospital: bookingHospital,
      date: bookingDate,
      time: bookingTime,
      notes: bookingNotes,
      doctorId: selectedBookingDoctor,
    };
    const successMessage = bookingHospital.is_vela
      ? `Priority Appointment Request sent to ${bookingHospital.name}. The receptionist will confirm shortly.`
      : "Appointment Scheduled Successfully";

    // "confirming" (not "scheduled"/"arrived"/"in-progress") keeps this
    // placeholder out of QueueTracker, which fetches live queue data by
    // appointment id and would otherwise 404 on this temporary id.
    const tempId = `optimistic-${Date.now()}`;
    const optimisticAppointment = {
      id: tempId,
      hospital_name: bookingHospital.name,
      status: "confirming",
      date: bookingDate,
      time: bookingTime,
      doctor_name: doctorObj ? doctorObj.name : "General Physician",
      _optimistic: true,
    };

    // 1. Instant feedback — no network wait.
    setBookingOptimistic(true);
    setAppointments(prev => [optimisticAppointment, ...prev]);
    toast.success(successMessage);

    // 2. Let the "Booked ✓" state flash briefly, then close the modal and
    // reset the form — the save is still running in the background.
    window.setTimeout(() => {
      setBookingHospital(null);
      setSelectedBookingDoctor("");
      setBookingNotes("");
      setBookingOptimistic(false);
    }, 700);

    // 3. Real save, off the UI's critical path.
    try {
      const res = await axios.post(`${API_URL}/api/appointments/book`, payload);
      // Nothing was inserted — this slot was already booked. The optimistic
      // toast above already claimed success, so correct it rather than leave
      // the patient believing a new appointment exists.
      if (res.data?.duplicate) {
        toast.error("You already have an appointment at this date and time. Pick a different slot.");
      }
      const real = res.data?.appointment;
      if (real) {
        setAppointments(prev => prev.map(a => (a.id === tempId ? real : a)));
      } else {
        const aptRes = await axios.get(`${API_URL}/api/appointments/patient/${patient.id}`);
        setAppointments(aptRes.data.appointments || []);
      }
    } catch (err) {
      console.error("[Booking] Error booking appointment:", err);
      // Revert: drop the placeholder, say so, and restore the form so the
      // patient can retry without losing what they typed.
      setAppointments(prev => prev.filter(a => a.id !== tempId));
      toast.error("Booking failed — please try again.");
      setBookingHospital(snapshot.hospital);
      setBookingDate(snapshot.date);
      setBookingTime(snapshot.time);
      setBookingNotes(snapshot.notes);
      setSelectedBookingDoctor(snapshot.doctorId);
    }
  };

  const startAtlasVoice = () => {
    setAtlasListening(true);
    setAtlasResponse("Listening...");
    recognitionRef.current = initVoice(
      async (text) => {
        setAtlasListening(false);
        setAtlasResponse("Processing...");
        try {
          const res = await axios.post(`${API_URL}/api/voice/query`, {
            query: text,
            patient_id: patient?.id,
            session_id: "patient_session_1",
            user_role: "Patient"
          });
          setAtlasResponse(res.data.answer);
        } catch(err) {
          setAtlasResponse("Sorry, I could not reach the server.");
        }
      },
      () => setAtlasListening(false)
    );
  };

  if (loading) {
    return (
        <div className="min-h-screen bg-canvas text-ink flex flex-col items-center justify-center font-sans">
            <div className="w-8 h-8 relative mb-6">
                <div className="absolute inset-0 rounded-full border-t-2 border-brand-soft animate-spin"></div>
                <div className="absolute inset-2 rounded-full border-r-2 border-line-strong animate-reverse-spin"></div>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-brand">Synchronizing</span>
        </div>
    );
  }

  const EDITABLE_FIELDS = ["name", "date_of_birth", "gender", "blood_group", "phone", "email", "height", "weight", "allergies", "existing_conditions",
    "emergency_contact_name", "emergency_contact_phone", "emergency_contact_relation", "insurance_provider", "insurance_id"];

  const openEditProfile = () => {
    const form: any = {};
    EDITABLE_FIELDS.forEach(k => { form[k] = patient?.[k] ?? ""; });
    setEditForm(form);
    setIsEditModalOpen(true);
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    try {
      const payload: any = {};
      EDITABLE_FIELDS.forEach(k => { if (editForm[k] !== undefined) payload[k] = editForm[k]; });
      const res = await axios.put(`${API_URL}/api/patient/update/${patient.id}`, payload);
      if (res.data.status === "success") {
        setPatient(res.data.patient);
        localStorage.setItem("vela_patient", JSON.stringify(res.data.patient));
        toast.success("Your details are saved");
        setIsEditModalOpen(false);
      } else {
        toast.error(res.data.message || "Could not save your details");
      }
    } catch (err) {
      toast.error("Could not save your details. Please try again.");
    } finally {
      setIsSaving(false);
    }
  };

  const renderEditModal = () => {
    if (!isEditModalOpen) return null;
    return (
      <div className="fixed inset-0 z-[300] bg-black/30 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4">
        <div className="bg-white w-full max-w-2xl rounded-t-3xl sm:rounded-3xl overflow-hidden shadow-2xl flex flex-col max-h-[92vh] text-ink">
          <div className="p-6 border-b border-line flex justify-between items-center bg-canvas">
            <h3 className="text-2xl font-semibold text-ink">Edit my details</h3>
            <button onClick={() => setIsEditModalOpen(false)} className="text-ink-3 hover:text-ink-2"><X size={24}/></button>
          </div>
          <form id="editForm" onSubmit={handleSaveProfile} className="p-6 overflow-y-auto space-y-6 styled-scrollbar">
             {/* Personal */}
             <div className="space-y-4">
                <h4 className="font-mono text-[10px] text-brand uppercase tracking-widest border-b border-line pb-1">Personal Info</h4>
                <div className="grid grid-cols-2 gap-4">
                   <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Full Name</label><input required className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand" value={editForm.name || ""} onChange={e=>setEditForm({...editForm, name: e.target.value})} /></div>
                   <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Date of Birth</label><input type="date" className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand" value={editForm.date_of_birth || ""} onChange={e=>setEditForm({...editForm, date_of_birth: e.target.value})} /></div>
                   <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Gender</label><select className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand" value={editForm.gender || ""} onChange={e=>setEditForm({...editForm, gender: e.target.value})}><option value="Male">Male</option><option value="Female">Female</option><option value="Other">Other</option></select></div>
                   <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Blood Group</label><select className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand" value={editForm.blood_group || ""} onChange={e=>setEditForm({...editForm, blood_group: e.target.value})}><option value="A+">A+</option><option value="A-">A-</option><option value="B+">B+</option><option value="B-">B-</option><option value="AB+">AB+</option><option value="AB-">AB-</option><option value="O+">O+</option><option value="O-">O-</option></select></div>
                </div>
             </div>
             {/* Contact */}
             <div className="space-y-4">
                <h4 className="font-mono text-[10px] text-brand uppercase tracking-widest border-b border-line pb-1">Contact</h4>
                <div className="grid grid-cols-2 gap-4">
                   <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Phone</label><input required className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand" value={editForm.phone || ""} onChange={e=>setEditForm({...editForm, phone: e.target.value})} /></div>
                   <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Email</label><input required type="email" className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand" value={editForm.email || ""} onChange={e=>setEditForm({...editForm, email: e.target.value})} /></div>
                </div>
             </div>
             {/* Medical */}
             <div className="space-y-4">
                <h4 className="font-mono text-[10px] text-brand uppercase tracking-widest border-b border-line pb-1">Medical</h4>
                <div className="grid grid-cols-2 gap-4">
                   <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Height (cm)</label><input type="number" className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand" value={editForm.height || ""} onChange={e=>setEditForm({...editForm, height: e.target.value})} /></div>
                   <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Weight (kg)</label><input type="number" className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand" value={editForm.weight || ""} onChange={e=>setEditForm({...editForm, weight: e.target.value})} /></div>
                </div>
                <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Allergies (comma separated)</label><textarea rows={2} className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand resize-none" value={editForm.allergies || ""} onChange={e=>setEditForm({...editForm, allergies: e.target.value})} /></div>
                <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Existing Conditions (comma separated)</label><textarea rows={2} className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand resize-none" value={editForm.existing_conditions || ""} onChange={e=>setEditForm({...editForm, existing_conditions: e.target.value})} /></div>
             </div>
             {/* Emergency */}
             <div className="space-y-4">
                <h4 className="font-mono text-[10px] text-brand uppercase tracking-widest border-b border-line pb-1">Emergency & Insurance</h4>
                <div className="grid grid-cols-2 gap-4">
                   <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Emergency Contact Name</label><input className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand" value={editForm.emergency_contact_name || ""} onChange={e=>setEditForm({...editForm, emergency_contact_name: e.target.value})} /></div>
                   <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Emergency Contact Phone</label><input className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand" value={editForm.emergency_contact_phone || ""} onChange={e=>setEditForm({...editForm, emergency_contact_phone: e.target.value})} /></div>
                   <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Emergency Contact Relation</label><select className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand" value={editForm.emergency_contact_relation || ""} onChange={e=>setEditForm({...editForm, emergency_contact_relation: e.target.value})}><option value="">Select</option><option value="Spouse">Spouse</option><option value="Parent">Parent</option><option value="Child">Child</option><option value="Sibling">Sibling</option><option value="Other">Other</option></select></div>
                </div>
                <div className="grid grid-cols-2 gap-4 mt-2">
                   <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Insurance Provider</label><input className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand" value={editForm.insurance_provider || ""} onChange={e=>setEditForm({...editForm, insurance_provider: e.target.value})} /></div>
                   <div><label className="block text-sm font-medium text-ink-2 mb-1.5">Insurance ID</label><input className="w-full border border-line-strong px-3 py-3 min-h-[48px] rounded-xl text-base bg-white text-ink focus:outline-none focus:border-brand" value={editForm.insurance_id || ""} onChange={e=>setEditForm({...editForm, insurance_id: e.target.value})} /></div>
                </div>
             </div>
          </form>
          <div className="p-6 border-t border-line bg-canvas flex justify-end gap-3 rounded-b-2xl">
              <button disabled={isSaving} onClick={() => setIsEditModalOpen(false)} className="px-6 min-h-[48px] text-ink-2 bg-white border border-line-strong hover:bg-surface-2 rounded-xl text-base font-medium transition-colors">Cancel</button>
              <button disabled={isSaving} type="submit" form="editForm" className="px-6 min-h-[48px] bg-brand hover:bg-brand-dark text-white rounded-xl text-base font-semibold transition-colors">{isSaving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>
    );
  };

  // --- RENDERS ---

  const renderHome = () => (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-1000">
      {/* What a patient actually opens the app to do comes before anything they
          only need to look at. Booking leads; the emergency call sits beside it
          needing no typing and no navigation. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <button
          onClick={() => setActiveTab("find-care")}
          className="sm:col-span-2 flex items-center justify-between gap-4 p-6 bg-brand text-white rounded-2xl hover:brightness-105 active:scale-[0.995] transition-all text-left"
        >
          <span>
            <span className="flex items-center gap-3 text-2xl font-semibold mb-1">
              <Calendar size={24} /> Book an appointment
            </span>
            <span className="block text-base text-white/80">Find a hospital and see a doctor</span>
          </span>
          <ChevronRight size={26} className="shrink-0" />
        </button>

        <a
          href="tel:108"
          className="flex flex-col items-center justify-center gap-2 p-6 bg-danger-tint text-danger border border-danger-soft rounded-2xl hover:bg-danger-tint transition-all"
        >
          <Phone size={24} />
          <span className="text-lg font-semibold">Emergency</span>
          <span className="text-sm text-danger/70">Call 108</span>
        </a>
      </div>

      {activeAdmission ? (
        <div className="relative overflow-hidden rounded-[40px] p-8 md:p-12 text-white shadow-2xl" style={{ background: "linear-gradient(135deg, var(--text) 0%, var(--text) 100%)" }}>
           <div className="absolute top-0 right-0 w-96 h-96 bg-brand/10 blur-[100px] -mr-32 -mt-32"></div>
           
           {/* ADMISSION HEADER */}
           <div className="flex justify-between items-start mb-12 relative z-10">
              <div>
                 <div className="flex items-center gap-3 mb-3">
                    <span className="w-2.5 h-2.5 rounded-full bg-brand animate-pulse"></span>
                    <span className="font-mono text-[10px] uppercase tracking-[0.4em] text-brand-light font-bold">Admission Professional</span>
                 </div>
                 <h2 className="font-serif italic text-5xl md:text-6xl text-white tracking-tight">Active Inpatient</h2>
              </div>
              <div className="text-center group">
                 <div className="bg-white p-4 rounded-3xl shadow-2xl transition-transform group-hover:scale-105 duration-500">
                    <QRCodeSVG value={activeAdmission.admission_qr} size={120} bgColor="#FFFFFF" fgColor="var(--text)" level="H" />
                 </div>
                 <div className="font-mono text-[9px] uppercase tracking-[0.3em] text-white/40 mt-4 font-bold">Ward Access Token</div>
              </div>
           </div>

           {/* ADMISSION BODY */}
           <div className="grid grid-cols-1 md:grid-cols-2 gap-12 relative z-10">
              <div className="space-y-8">
                 <div>
                    <span className="block font-mono text-[10px] uppercase tracking-[0.2em] text-white/30 mb-2">Location Allocation</span>
                    <div className="text-3xl font-serif italic">{activeAdmission.ward_name} <span className="text-brand">#{activeAdmission.bed_number}</span></div>
                 </div>
                 <div className="flex gap-12">
                    <div>
                       <span className="block font-mono text-[9px] uppercase tracking-[0.2em] text-white/30 mb-1">Room Class</span>
                       <span className="text-lg">{activeAdmission.room_type}</span>
                    </div>
                    <div>
                        <span className="block font-mono text-[9px] uppercase tracking-[0.2em] text-white/30 mb-1">Stay Duration</span>
                        <span className="text-lg font-mono">{Math.floor((new Date().getTime() - new Date(activeAdmission.admitted_at).getTime()) / (1000 * 60 * 60 * 24)) + 1} Days</span>
                    </div>
                 </div>
              </div>

              <div className="bg-white/5 border border-white/10 rounded-[32px] p-8 flex flex-col justify-center">
                 <div className="flex items-center gap-3 mb-4">
                    <User className="text-brand" size={20} />
                    <span className="font-mono text-[10px] uppercase tracking-widest text-white/60">Patient Identity</span>
                 </div>
                 <div className="text-2xl font-bold mb-1 tracking-tight">{patient?.name}</div>
                 <div className="font-mono text-sm text-brand-light tracking-wider uppercase">{patient?.vela_id}</div>
              </div>
           </div>

           {/* BUTTONS */}
           <div className="mt-12 flex gap-4 relative z-10">
              <button 
                onClick={() => { navigator.clipboard.writeText(activeAdmission.admission_qr); toast.success("Code Copied!"); }}
                className="bg-white text-black px-8 py-3.5 rounded-2xl font-mono text-[10px] font-bold uppercase tracking-[0.2em] hover:bg-brand-tint transition-all shadow-xl shadow-black/20"
              >
                Copy QR String
              </button>
           </div>
        </div>
      ) : (
        <div className="relative overflow-hidden rounded-[20px] p-8 md:p-12 text-white shadow-xl" style={{ background: "linear-gradient(135deg, var(--brand) 0%, var(--brand-dark) 100%)" }}>
           {/* TOP ROW */}
           <div className="flex justify-between items-start mb-8 relative z-10">
              <div>
                 <img src="/vela-icon.png" alt="VELA" className="h-5 mb-2" />
                 <div className="font-mono text-[10px] uppercase tracking-[0.15em] text-white/60">VELA HEALTH</div>
              </div>
              <div className="text-center">
                 <div className="bg-white p-2 rounded-lg inline-block shadow-sm">
                    <QRCodeSVG value={patient?.vela_id || ""} size={72} bgColor="#FFFFFF" fgColor="var(--brand)" level="M" />
                 </div>
                 <div className="font-mono text-[8px] uppercase tracking-widest text-white/50 mt-1">Scan to share</div>
              </div>
           </div>
           {/* ID */}
           <div className="relative z-10">
              <h2 className="font-serif italic text-5xl md:text-[52px] text-white tracking-[0.06em] leading-none">{patient?.vela_id}</h2>
              <p className="font-sans font-light text-lg text-white/80 mt-2">{patient?.name}</p>
           </div>
           {/* BOTTOM ROW */}
           <div className="flex bg-white/5 border border-white/10 rounded-xl mt-8 relative z-10 overflow-hidden">
              <div className="flex-1 p-4 border-r border-white/10">
                 <span className="block font-mono text-[9px] uppercase tracking-[0.08em] text-white/45 mb-1">Blood Group</span>
                 <span className="font-medium text-[13px] text-white">{patient?.blood_group || "--"}</span>
              </div>
              <div className="flex-1 p-4 border-r border-white/10">
                 <span className="block font-mono text-[9px] uppercase tracking-[0.08em] text-white/45 mb-1">Age</span>
                 <span className="font-medium text-[13px] text-white">{patient?.age || "--"}</span>
              </div>
              <div className="flex-1 p-4 border-r border-white/10">
                 <span className="block font-mono text-[9px] uppercase tracking-[0.08em] text-white/45 mb-1">Gender</span>
                 <span className="font-medium text-[13px] text-white">{patient?.gender || "--"}</span>
              </div>
              <div className="flex-1 p-4">
                 <span className="block font-mono text-[9px] uppercase tracking-[0.08em] text-white/45 mb-1">Phone</span>
                 <span className="font-medium text-[13px] text-white">{patient?.phone || "--"}</span>
              </div>
           </div>
           {/* Copy button */}
           <button onClick={() => { navigator.clipboard.writeText(patient?.vela_id || ""); toast.success("Copied!"); }} className="absolute bottom-4 right-4 bg-white/10 hover:bg-white/20 border border-white/20 rounded-md px-3 py-1.5 font-mono text-[10px] text-ink transition-colors z-20">Copy VELA ID</button>
        </div>
      )}

      {!activeAdmission && patientHistory.length > 0 && patientHistory[0].event_type === 'discharge' && (
        <div className="bg-warning-tint border border-warning-soft rounded-[20px] p-8 flex items-center justify-between animate-in fade-in slide-in-from-right-4">
            <div className="flex items-center gap-6">
                <div className="w-16 h-16 bg-white rounded-2xl flex items-center justify-center text-warning shadow-sm">
                    <CheckCircle size={32} strokeWidth={1.5} />
                </div>
                <div>
                    <h4 className="font-serif italic text-2xl text-ink">Recently Discharged</h4>
                    <p className="text-ink-2 font-mono text-[10px] uppercase tracking-widest">Recovery in progress · Follow instructions</p>
                </div>
            </div>
            <button 
                onClick={() => setActiveTab('history')}
                className="bg-warning text-white px-8 py-3 rounded-xl font-mono text-[10px] uppercase tracking-widest hover:bg-warning transition-all shadow-lg shadow-warning-soft/20"
            >
                View Summary
            </button>
        </div>
      )}

      {queueStatus && (
        <div className="bg-brand rounded-[20px] p-8 text-white shadow-xl animate-in fade-in slide-in-from-top-4 relative overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-white/5 blur-3xl -mr-32 -mt-32"></div>
            
            <div className="flex justify-between items-center mb-10 relative z-10">
                <div className="flex items-center gap-4">
                    <div className="w-2.5 h-2.5 rounded-full bg-white animate-pulse"></div>
                    <div>
                        <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-white/80 block mb-1">Live Clinical Sequence</span>
                        <div className="flex items-center gap-3">
                            <h3 className="font-serif italic text-3xl">Assigned to Dr. {queueStatus.assigned_doctor || 'Specialist'}</h3>
                            {queueStatus.triage_level === 'Urgent' && (
                                <span className="bg-danger text-white font-mono text-[8px] px-2 py-0.5 rounded-full animate-bounce uppercase font-bold tracking-widest flex items-center gap-1">
                                    <AlertCircle size={10} /> Urgent Priority
                                </span>
                            )}
                        </div>
                    </div>
                </div>
                <div className="text-right">
                    <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/50 mb-1">Facility Registry</div>
                    <div className="font-mono text-sm tracking-wider font-bold">Vela {queueStatus.department || 'Main Hub'}</div>
                </div>
            </div>
            
            <div className="flex flex-col md:flex-row items-center gap-12 relative z-10">
                <div className="text-center md:text-left">
                    <div className="font-serif italic text-7xl md:text-9xl mb-2">{queueStatus.position}</div>
                    <div className="font-mono text-[10px] uppercase tracking-[0.4em] text-white/60">Position in Queue</div>
                </div>
                
                <div className="flex-1 w-full space-y-6">
                    <div className="h-2 bg-white/20 rounded-full overflow-hidden">
                        <div 
                            className="h-full bg-white transition-all duration-1000 ease-out shadow-[0_0_20px_rgba(255,255,255,0.5)]"
                            style={{ width: `${Math.max(8, 100 - (queueStatus.position * 12))}%` }}
                        ></div>
                    </div>
                    <div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.2em] text-white/50">
                        <span className="flex items-center gap-2"><MapPin size={12}/> Arrival</span>
                        <span className="text-white font-bold">{queueStatus.estimated_wait}m Est. Wait</span>
                        <span className="flex items-center gap-2">Consultation <ChevronRight size={12}/></span>
                    </div>
                </div>

                <div className="bg-white/10 backdrop-blur-md p-8 rounded-[32px] flex flex-col items-center justify-center border border-white/10 min-w-[180px]">
                    <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/50 mb-3">Electronic Ticket</span>
                    <span className="font-mono text-2xl font-black tracking-tighter">{queueStatus.ticket_number}</span>
                    <div className="w-full h-px bg-white/10 my-4"></div>
                    <div className="font-mono text-[8px] uppercase tracking-widest text-white font-bold">Ready for scan</div>
                </div>
            </div>
        </div>
      )}

      <div>
         <div className="flex justify-between items-center mb-6">
            <h3 className="font-serif italic text-2xl text-ink">My Profile</h3>
            <button onClick={() => { setEditForm(patient || {}); setIsEditModalOpen(true); }} className="text-brand border border-brand/20 hover:bg-brand/5 px-4 py-1.5 rounded-full text-xs font-medium transition-colors">Edit</button>
         </div>

         <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Card 1 */}
            <div className="bg-white border text-center text-left p-6 md:p-6 p-6 rounded-xl shadow-sm border-line">
               <span className="block font-mono text-[10px] text-brand uppercase tracking-widest mb-4">PERSONAL</span>
               <div className="space-y-3">
                  <div className="flex justify-between"><span className="text-ink-2 text-sm">Name</span><span className="text-ink font-medium text-sm">{patient?.name || "--"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-2 text-sm">Age / DOB</span><span className="text-ink font-medium text-sm">{patient?.age || "--"} / {patient?.date_of_birth || "--"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-2 text-sm">Gender</span><span className="text-ink font-medium text-sm">{patient?.gender || "--"}</span></div>
               </div>
            </div>
            {/* Card 2 */}
            <div className="bg-white border p-6 rounded-xl shadow-sm border-line">
               <span className="block font-mono text-[10px] text-brand uppercase tracking-widest mb-4">MEDICAL</span>
               <div className="space-y-3">
                  <div className="flex justify-between"><span className="text-ink-2 text-sm">Blood</span><span className="text-ink font-medium text-sm">{patient?.blood_group || "--"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-2 text-sm">Height / Weight</span><span className="text-ink font-medium text-sm">{patient?.height ? `${patient.height}cm` : "--"} / {patient?.weight ? `${patient.weight}kg` : "--"}</span></div>
                  <div className="mt-4 pt-4 border-t border-line">
                     <span className="block text-xs font-medium text-ink mb-2">Allergies</span>
                     <div className="flex flex-wrap gap-1">
                        {patient?.allergies ? patient.allergies.split(",").map((a:string, i:number)=><span key={i} className="bg-danger-tint text-danger px-2 py-1 rounded text-sm font-medium">{a.trim()}</span>) : <span className="text-sm text-ink-3">None</span>}
                     </div>
                  </div>
                  <div className="mt-2 text-sm text-ink">
                     <span className="block text-xs font-medium mb-1">Conditions</span>
                     {patient?.existing_conditions ? patient.existing_conditions.split(",").map((a:string, i:number)=><span key={i} className="inline-block bg-warning-tint text-warning px-2 py-1 rounded text-sm font-medium mr-1 mb-1">{a.trim()}</span>) : <span className="text-sm text-ink-3">None</span>}
                  </div>
               </div>
            </div>
            {/* Card 3 */}
            <div className="bg-white border p-6 rounded-xl shadow-sm border-line">
               <span className="block font-mono text-[10px] text-brand uppercase tracking-widest mb-4">CONTACT</span>
               <div className="space-y-3">
                  <div className="flex justify-between"><span className="text-ink-2 text-sm">Phone</span><span className="text-ink font-medium text-sm">{patient?.phone || "--"}</span></div>
                  <div className="flex justify-between"><span className="text-ink-2 text-sm">Email</span><span className="text-ink font-medium text-sm">{patient?.email || "--"}</span></div>
               </div>
            </div>
            {/* Card 4 */}
            <div className="bg-danger-tint/40 border border-danger-soft/15 p-6 rounded-xl shadow-sm">
               <span className="block font-mono text-[10px] text-danger uppercase tracking-widest mb-4">EMERGENCY CONTACT</span>
               {patient?.emergency_contact_name ? (
                 <>
                   <div className="text-ink font-semibold text-lg">{patient.emergency_contact_name}</div>
                   <div className="text-ink-2 text-sm mb-4">{patient.emergency_contact_relation || "Contact"} • {patient.emergency_contact_phone}</div>
                   {patient.emergency_contact_phone && (
                      <a href={`tel:${patient.emergency_contact_phone}`} className="inline-block bg-danger-tint text-danger hover:bg-danger px-4 py-2 rounded-lg text-xs font-semibold uppercase tracking-wider transition-colors">Call</a>
                   )}
                 </>
               ) : (
                 <span className="text-sm text-ink-3">No emergency contact on file.</span>
               )}
            </div>
         </div>
      </div>
    </div>
  );

  const handleReassess = async (orderId: string) => {
    setReassessing(orderId);
    try {
        const res = await axios.post(`${API_URL}/api/reassess/request`, { order_id: orderId });
        if (res.data.status === 'success') {
            toast.success("Reassessment request sent to Lab.");
            fetchLabHistory(patient.id);
        } else {
            toast.error(res.data.message);
        }
    } catch (err: any) {
        toast.error(err.response?.data?.detail || "Request failed");
    } finally {
        setReassessing(null);
    }
  };

  const renderReports = () => (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-1000">
      <div className="flex justify-between items-end">
        <div>
            <h2 className="text-4xl font-serif italic text-ink mb-2">Tests & Reports</h2>
            <p className="text-ink-2 font-light">Real-time diagnostic tracking and clinical intelligence.</p>
        </div>
        <button onClick={() => { fetchLabHistory(patient.id); fetchPendingPayments(patient.id); }} className="p-3 bg-white border border-line rounded-xl text-ink-3 hover:text-brand transition-all">
            <Activity size={18} />
        </button>
      </div>

      {/* Tests your doctor has ordered, awaiting payment. Paying releases the
          test to the lab and books the patient a queue slot. */}
      {pendingPayments.length > 0 && (
        <div className="bg-white border-2 border-brand/30 rounded-[24px] overflow-hidden shadow-sm">
          <div className="bg-brand/5 px-8 py-5 border-b border-brand/20 flex items-center justify-between flex-wrap gap-3">
            <div>
              <h3 className="font-serif italic text-2xl text-ink">Tests Awaiting Payment</h3>
              <p className="text-ink-2 text-sm mt-1">
                Your doctor has ordered {pendingPayments.length} test{pendingPayments.length > 1 ? 's' : ''}. Pay to confirm your slot.
              </p>
            </div>
            <div className="text-right">
              <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-1">Total Due</div>
              <div className="text-3xl font-bold text-brand">₹{totalDue.toLocaleString('en-IN')}</div>
            </div>
          </div>

          <div className="px-8 py-3 bg-canvas/70 border-b border-line flex items-center justify-between gap-4 flex-wrap">
            <label className="flex items-center gap-2.5 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={selectedTests.length === pendingPayments.length && pendingPayments.length > 0}
                onChange={(e) =>
                  setSelectedTests(e.target.checked ? pendingPayments.map((o: any) => o.id) : [])
                }
                className="w-4 h-4 accent-brand cursor-pointer"
              />
              <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2">
                Select all tests
              </span>
            </label>
            <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-3">
              {selectedTests.length} of {pendingPayments.length} selected
            </span>
          </div>

          <div className="divide-y divide-line">
            {pendingPayments.map((order: any) => {
              const checked = selectedTests.includes(order.id);
              const isRoutingHere = routingOrderId === order.id;
              return (
                <div key={order.id}>
                <div
                  className={`px-8 py-5 flex items-center justify-between gap-6 flex-wrap transition-colors ${checked ? 'bg-brand/[0.03]' : ''}`}
                >
                  <label className="flex items-center gap-4 min-w-0 cursor-pointer flex-1">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleTestSelection(order.id)}
                      className="w-4 h-4 accent-brand cursor-pointer shrink-0"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 mb-1 flex-wrap">
                        <h4 className="font-medium text-ink">{order.test_type}</h4>
                        {order.priority === 'urgent' && (
                          <span className="text-[8px] font-bold uppercase tracking-wider text-danger bg-danger-tint border border-danger-soft rounded px-1.5 py-0.5">
                            Urgent
                          </span>
                        )}
                        {order.payment_intent === 'counter' && (
                          <span className="text-[8px] font-bold uppercase tracking-wider text-warning bg-warning-tint border border-warning-soft rounded px-1.5 py-0.5">
                            Pay at counter
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] font-mono uppercase tracking-widest text-ink-3">
                        {order.department} lab {order.sample_type ? `• ${order.sample_type}` : ''} • Dr. {order.doctor_name}
                      </div>
                      {order.notes && <p className="text-xs text-ink-2 mt-1.5 max-w-md">{order.notes}</p>}
                    </div>
                  </label>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xl font-bold text-ink">₹{(order.price || 0).toLocaleString('en-IN')}</span>
                    <button
                      onClick={() => setRoutingOrderId(isRoutingHere ? null : order.id)}
                      className="border border-line-strong text-ink-2 hover:border-line-strong px-4 py-2.5 rounded-xl font-mono text-[10px] uppercase tracking-widest font-bold transition-all"
                    >
                      {isRoutingHere ? 'Close' : 'Find a lab'}
                    </button>
                    <button
                      onClick={() => payForTest(order)}
                      disabled={payingOrderId === order.id || payingSelected}
                      className="border border-brand/30 text-brand hover:bg-brand/5 px-5 py-2.5 rounded-xl font-mono text-[10px] uppercase tracking-widest font-bold transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                      {payingOrderId === order.id ? 'Processing…' : 'Pay This'}
                    </button>
                  </div>
                </div>
                {isRoutingHere && (
                  <div className="px-8 pb-5 -mt-2">
                    <div className="bg-canvas border border-line rounded-xl p-4">
                      <p className="text-xs text-ink-2 mb-3">
                        Send this test to a Vela-registered independent lab instead — you'll pay them directly.
                      </p>
                      {networkLabs.length === 0 ? (
                        <p className="text-xs text-ink-3 italic">No independent labs on the Vela network yet.</p>
                      ) : (
                        <div className="space-y-2">
                          {networkLabs.map((lab: any) => (
                            <div key={lab.id} className="flex items-center justify-between gap-4 bg-white border border-line rounded-lg px-4 py-2.5">
                              <div className="min-w-0">
                                <div className="text-sm text-ink truncate">{lab.name}</div>
                                <div className="text-[11px] text-ink-3 truncate">{lab.address}</div>
                              </div>
                              <button
                                disabled={routingToLabId === lab.id}
                                onClick={() => routeTestOrder(order, lab.id, lab.name)}
                                className="border border-brand/30 text-brand hover:bg-brand/5 px-3 py-2 rounded-lg font-mono text-[9px] uppercase tracking-widest font-bold transition-all disabled:opacity-60 whitespace-nowrap"
                              >
                                {routingToLabId === lab.id ? 'Sending…' : 'Send here'}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}
                </div>
              );
            })}
          </div>

          {/* How would you like to pay? */}
          <div className="px-8 py-6 bg-canvas border-t border-line flex items-center justify-between gap-6 flex-wrap">
            <div>
              <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-2 mb-1">Selected Total</div>
              <div className="text-2xl font-bold text-ink">₹{selectedTotal.toLocaleString('en-IN')}</div>
              <p className="text-xs text-ink-2 mt-1.5 max-w-sm">
                After paying, go to the lab that runs your test — reception checks you in there.
              </p>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              <button
                onClick={payAtCounter}
                disabled={selectedTests.length === 0 || deferringToCounter || payingSelected}
                className="border border-line-strong text-ink hover:border-line-strong hover:bg-white px-6 py-3.5 rounded-xl font-mono text-[10px] uppercase tracking-widest font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {deferringToCounter ? 'Holding…' : 'Pay at Counter'}
              </button>
              <button
                onClick={paySelectedTests}
                disabled={selectedTests.length === 0 || payingSelected || deferringToCounter}
                className="bg-brand hover:bg-brand-dark text-white px-8 py-3.5 rounded-xl font-mono text-[10px] uppercase tracking-widest font-bold transition-all shadow-lg shadow-brand/20 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {payingSelected
                  ? 'Processing…'
                  : `Pay Now${selectedTests.length > 1 ? ` (${selectedTests.length})` : ''}`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Upload Zone */}
      <div className="bg-white border border-line rounded-[24px] p-8 shadow-sm transition-all hover:border-brand/50">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="w-16 h-16 bg-brand-tint border border-brand-soft rounded-full flex items-center justify-center text-brand mb-4 shadow-sm">
            <Upload size={24} />
          </div>
          <h3 className="font-serif italic text-2xl text-ink mb-2">Upload Medical Record or Past Report</h3>
          <p className="text-ink-2 text-sm max-w-lg mb-6">
            Upload your diagnostic scans, lab reports, or blood tests (PDF, PNG, JPG, or JPEG).
            Vela AI will automatically analyze it, extract clinical findings, and update your health parameters.
          </p>
          <div className="relative">
            <label className={`bg-brand hover:bg-brand-dark text-white px-8 py-3 rounded-xl font-mono text-[10px] uppercase tracking-widest font-bold cursor-pointer transition-all flex items-center gap-2 shadow-lg shadow-brand/20 ${isUploading ? 'opacity-70 pointer-events-none' : ''}`}>
              <Upload size={14} />
              {isUploading ? "Uploading..." : "Select File / Photo"}
              <input
                type="file"
                accept=".pdf,.png,.jpg,.jpeg"
                onChange={handleDocumentUpload}
                disabled={isUploading}
                className="hidden"
              />
            </label>
          </div>
        </div>
      </div>

      {activeLabOrder && (
          <div className="bg-night rounded-[32px] p-10 text-white shadow-2xl relative overflow-hidden group">
              <div className="absolute top-0 right-0 w-64 h-64 bg-brand/10 blur-[100px] -mr-32 -mt-32"></div>
              
              <div className="relative z-10">
                  <div className="flex justify-between items-start mb-10">
                      <div>
                          <div className="flex items-center gap-3 mb-2">
                              <span className="w-2 h-2 rounded-full bg-brand animate-pulse"></span>
                              <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-brand-light">Active Test Stream</span>
                          </div>
                          <h3 className="text-4xl font-serif italic">{activeLabOrder.test_type}</h3>
                      </div>
                      <div className="text-right">
                          <div className="font-mono text-[32px] leading-none mb-1 text-brand-light">#{activeLabOrder.queue?.position || '--'}</div>
                          <div className="font-mono text-[9px] uppercase tracking-widest text-white/40">Lab Queue</div>
                      </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-10">
                      <div className="bg-white/5 border border-white/10 p-6 rounded-2xl">
                          <span className="block font-mono text-[9px] uppercase tracking-widest text-white/40 mb-3">Status</span>
                          <div className="font-mono text-xs uppercase tracking-widest text-brand-light font-bold">{activeLabOrder.status.replace('_', ' ')}</div>
                      </div>
                      <div className="bg-white/5 border border-white/10 p-6 rounded-2xl">
                          <span className="block font-mono text-[9px] uppercase tracking-widest text-white/40 mb-3">Estimate</span>
                          <div className="font-mono text-xs uppercase tracking-widest">~{activeLabOrder.queue?.wait_minutes || '20'} MIN WAIT</div>
                      </div>
                      <div className="bg-white/5 border border-white/10 p-6 rounded-2xl">
                          <span className="block font-mono text-[9px] uppercase tracking-widest text-white/40 mb-3">Doctor</span>
                          <div className="font-mono text-xs uppercase tracking-widest">DR. {activeLabOrder.doctor_name || 'WEST'}</div>
                      </div>
                  </div>

                  <div className="h-1 bg-white/10 rounded-full overflow-hidden">
                      <div 
                          className="h-full bg-brand transition-all duration-1000"
                          style={{ width: 
                              activeLabOrder.status === 'pending_payment' ? '10%' :
                              activeLabOrder.status === 'paid' ? '30%' :
                              activeLabOrder.status === 'accepted' ? '50%' :
                              activeLabOrder.status === 'in_progress' ? '80%' : '5%'
                          }}
                      ></div>
                  </div>
              </div>
          </div>
      )}

      <div className="space-y-6">
        <h3 className="font-serif italic text-2xl text-ink border-b border-line pb-4">Diagnostic History</h3>
        
        {isLabLoading ? (
            <div className="py-20 text-center font-mono text-[10px] uppercase tracking-[0.3em] text-ink-3">Decrypting clinical records...</div>
        ) : labHistory.length === 0 ? (
            <div className="p-20 border border-line border-dashed text-center flex flex-col items-center rounded-3xl bg-white">
                <FileText className="text-ink-3 mb-4" size={48} strokeWidth={1} />
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-3">No diagnostic records found</p>
            </div>
        ) : (
            <div className="grid grid-cols-1 gap-6">
                {labHistory.map((report) => (
                    <div key={report.id} className="bg-white border border-line rounded-[32px] overflow-hidden hover:shadow-2xl hover:shadow-line/50 transition-all group">
                        <div className="p-8 md:p-10">
                            <div className="flex justify-between items-start mb-8">
                                <div className="flex items-center gap-6">
                                    <div className={`w-14 h-14 rounded-2xl flex items-center justify-center border ${
                                        report.report?.risk_score === 'HIGH' ? 'bg-danger-tint border-danger-soft text-danger' :
                                        report.report?.risk_score === 'MEDIUM' ? 'bg-warning-tint border-warning-soft text-warning' :
                                        'bg-success-tint border-success-soft text-success'
                                    }`}>
                                        <Activity size={24} />
                                    </div>
                                    <div>
                                        <h4 className="text-3xl font-serif italic text-ink">{report.test_type}</h4>
                                        <div className="flex gap-4 mt-1 font-mono text-[9px] text-ink-3 uppercase tracking-widest">
                                            <span>{new Date(report.created_at).toLocaleDateString()}</span>
                                            <span>•</span>
                                            <span>Dr. {report.doctor_name || 'West'}</span>
                                        </div>
                                    </div>
                                </div>
                                <div className="text-right">
                                    <div className={`font-mono text-[10px] uppercase tracking-widest px-4 py-1.5 rounded-full border ${
                                        report.status === 'completed' ? 'bg-success-tint text-success border-success-soft' : 'bg-canvas text-ink-3 border-line'
                                    }`}>
                                        {report.status}
                                    </div>
                                </div>
                            </div>

                            {report.report && (
                                <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">
                                    <div className="lg:col-span-4 bg-canvas rounded-2xl p-6 border border-line">
                                        <div className="flex items-center gap-2 mb-6 text-ink-2">
                                            <AlertCircle size={14} />
                                            <span className="font-mono text-[10px] uppercase tracking-widest">Risk Assessment</span>
                                        </div>
                                        <div className="text-center">
                                            <div className={`text-6xl font-serif italic mb-2 ${
                                                report.report.risk_score === 'HIGH' ? 'text-danger' :
                                                report.report.risk_score === 'MEDIUM' ? 'text-warning' :
                                                'text-success'
                                            }`}>
                                                {report.report.risk_score}
                                            </div>
                                            <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-3">Clinical Risk Grade</div>
                                        </div>
                                    </div>

                                    <div className="lg:col-span-8 space-y-6">
                                        <div className="font-mono text-[9px] uppercase tracking-widest text-brand flex items-center gap-2">
                                            <Mic size={12} /> Atlas AI Analysis
                                        </div>
                                        <p className="text-sm text-ink leading-relaxed italic font-light">
                                            {report.report.analysis || "Analysis pending..."}
                                        </p>
                                        
                                        <div className="flex gap-4 pt-4">
                                            <button 
                                                onClick={() => handleReassess(report.id)}
                                                disabled={reassessing === report.id || report.reassess_count >= 3}
                                                className="px-6 py-3 border border-line rounded-xl font-mono text-[9px] text-ink-2 uppercase tracking-widest hover:border-brand-soft hover:text-brand transition-all disabled:opacity-50"
                                            >
                                                {reassessing === report.id ? 'Requesting...' : `Request Reassess (${report.reassess_count || 0}/3)`}
                                            </button>
                                            <button className="px-6 py-3 bg-night text-white rounded-xl font-mono text-[9px] uppercase tracking-widest hover:bg-brand transition-all flex items-center gap-2">
                                                <Download size={14} /> Download PDF
                                            </button>
                                        </div>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>
                ))}
            </div>
        )}
      </div>

      {/* Manual Uploads / Scans */}
      <div className="pt-12 border-t border-line">
          <div className="flex items-center gap-3 mb-8">
              <FileText size={18} className="text-ink-3" />
              <h3 className="font-serif italic text-2xl text-ink">Clinical Registry</h3>
          </div>
          
          {documents.length === 0 ? (
              <div className="p-12 border border-line border-dashed text-center rounded-2xl bg-white/50">
                  <p className="font-mono text-[9px] uppercase tracking-widest text-ink-3">No manual scans in record</p>
              </div>
          ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {documents.map((doc) => {
                      const needsReview = Array.isArray(doc.critical_flags) && doc.critical_flags.some((f: any) => typeof f === 'string' && f.includes('NEEDS DOCTOR REVIEW'));
                      return (
                      <div key={doc.id} className={`bg-white border p-6 rounded-2xl flex flex-col justify-between h-36 transition-all shadow-sm ${needsReview ? 'border-warning-soft' : 'border-line hover:border-brand-soft'}`}>
                          <div className="flex justify-between items-start">
                              <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${needsReview ? 'bg-warning-tint text-warning' : 'bg-canvas text-ink-3'}`}>
                                  <FileText size={16} />
                              </div>
                              <div className="flex items-center gap-3">
                                  {/* VELA-generated PDFs (lab reports, consultation
                                      records) are served back; patient uploads have
                                      no generated file to fetch. */}
                                  <button
                                      onClick={async () => {
                                          const r = await openGeneratedDocument(doc.id, doc.filename);
                                          if (!r.ok) toast.error(r.message || 'Could not open document');
                                      }}
                                      className="text-ink-3 hover:text-brand transition-colors"
                                      title="Open document"
                                  >
                                      <Download size={16} />
                                  </button>
                                  <button
                                      onClick={() => handleDeleteDocument(doc.id)}
                                      className="text-danger hover:text-danger transition-colors"
                                      title="Delete Document"
                                  >
                                      <Trash2 size={16} />
                                  </button>
                              </div>
                          </div>
                          <div>
                              <h4 className="text-ink font-sans font-medium text-sm truncate mb-1">{doc.filename}</h4>
                              {needsReview ? (
                                  <span className="inline-block text-[8px] font-mono uppercase tracking-widest text-warning bg-warning-tint border border-warning-soft rounded px-1.5 py-0.5">Pending doctor review</span>
                              ) : (
                                  <p className="text-[9px] text-ink-3 font-mono uppercase tracking-widest">{new Date(doc.uploaded_at).toLocaleDateString()}</p>
                              )}
                          </div>
                      </div>
                      );
                  })}
              </div>
          )}
      </div>
    </div>
  );

  const renderMedications = () => (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-1000">
      <h2 className="text-4xl font-serif italic text-ink mb-2">Active Prescriptions</h2>
      <p className="text-ink-2 font-light mb-12">Manage your current medications and protocols.</p>

      {medications.length === 0 ? (
            <div className="p-20 border border-line border-dashed text-center flex flex-col items-center rounded-xl">
              <div className="w-16 h-16 rounded-full flex items-center justify-center mb-6 text-ink-3">
                  <Pill size={24} strokeWidth={1} />
              </div>
              <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-2">No active medications</p>
          </div>
      ) : (
          <div className="grid grid-cols-1 gap-4">
               {medications.map((med) => (
                  <div key={med.id} className="bg-night border border-line p-6 flex items-center justify-between group rounded-xl">
                      <div className="flex items-center gap-6">
                           <div className="w-12 h-12 border border-brand/30 flex items-center justify-center text-brand bg-brand/5">
                              <Pill size={20} strokeWidth={1.5} />
                           </div>
                           <div>
                              <h4 className="text-2xl font-serif italic text-ink mb-1">{med.name}</h4>
                              <p className="text-base font-medium text-ink">{med.dosage} · {med.frequency}</p>
                           </div>
                      </div>
                      <div className="text-right">
                          <div className="text-[9px] font-mono tracking-[0.2em] uppercase text-brand border border-brand/30 px-3 py-1 bg-brand/10 rounded-full">
                              Active
                          </div>
                      </div>
                  </div>
               ))}
          </div>
      )}
    </div>
  );

  const renderEmergencyModal = () => {
    if (!triageResult?.red_flag) return null;
    return (
      <div className="fixed inset-0 z-[200] bg-danger flex flex-col items-center justify-center text-white text-center p-8 animate-in fade-in duration-300">
        <div className="w-32 h-32 rounded-full bg-white/20 flex items-center justify-center mb-10 animate-pulse">
            <Activity size={64} strokeWidth={1} />
        </div>
        <h1 className="text-5xl md:text-7xl font-serif italic mb-6">Medical Emergency</h1>
        <p className="text-xl md:text-2xl font-light max-w-2xl mb-12">
           Based on your symptoms, please go to the emergency room immediately or call emergency services.
        </p>
        <div className="flex gap-6">
          <a href="tel:112" className="bg-white text-danger px-12 py-5 font-sans font-bold text-lg uppercase tracking-widest rounded-full hover:scale-105 transition-transform">
             Call 112
          </a>
          <button onClick={() => setTriageResult(null)} className="bg-transparent border border-line-strong text-ink px-12 py-5 font-sans font-bold text-lg uppercase tracking-widest rounded-full hover:bg-surface-2 transition-colors">
             Dismiss
          </button>
        </div>
      </div>
    );
  };

  const renderBookingModal = () => {
    if (!bookingHospital) return null;
    return (
      <div className="fixed inset-0 z-[150] bg-black/30 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4">
        <div className="bg-white border border-line w-full max-w-lg max-h-[92vh] overflow-y-auto rounded-t-3xl sm:rounded-3xl shadow-2xl animate-in fade-in slide-in-from-bottom-10">
          <div className="p-6 sm:p-8 pb-5 border-b border-line">
            <h3 className="text-2xl font-semibold text-ink mb-1">{bookingHospital.name}</h3>
            <p className="text-sm text-ink-2">{bookingHospital.vicinity}</p>
          </div>
          <div className="p-6 sm:p-8 space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-ink-2 mb-2">Select Date</label>
                <input type="date" min={new Date().toISOString().split('T')[0]} value={bookingDate} onChange={e => setBookingDate(e.target.value)} className="w-full p-3 rounded-xl text-base focus:outline-none font-sans" style={{ background: 'var(--bg)', border: '1px solid var(--border-strong)', color: 'var(--text)', colorScheme: 'light', minHeight: 48 } as React.CSSProperties} />
              </div>
              <div>
                <label className="block text-sm font-medium text-ink-2 mb-2">Select Time</label>
                <input type="time" value={bookingTime} onChange={e => setBookingTime(e.target.value)} className="w-full p-3 rounded-xl text-base focus:outline-none font-sans" style={{ background: 'var(--bg)', border: '1px solid var(--border-strong)', color: 'var(--text)', colorScheme: 'light', minHeight: 48 } as React.CSSProperties} />
              </div>
            </div>
            
            {/* Conditional Doctor Selection for Vela Partners */}
            {bookingHospital.is_vela && (
              <div>
                <label className="block text-sm font-medium text-ink-2 mb-2">Select Doctor (Optional)</label>
                <select
                  value={selectedBookingDoctor}
                  onChange={e => setSelectedBookingDoctor(e.target.value)}
                  className="w-full p-3 rounded-xl text-base focus:outline-none font-sans border border-line-strong text-ink"
                  style={{ background: 'var(--bg)', colorScheme: 'light', minHeight: 48 } as React.CSSProperties}
                >
                  <option value="" className="bg-white text-ink">General Waitlist (Auto-Route)</option>
                  {bookingDoctors.map(doc => (
                    <option key={doc.id} value={doc.id} className="bg-white text-ink">
                      Dr. {doc.name} — {doc.specialization || 'General'} ({doc.online ? "Online" : "Offline"})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-ink-2 mb-2">Reason for Visit & Notes</label>
              <textarea
                value={bookingNotes}
                onChange={e => setBookingNotes(e.target.value)}
                placeholder="Briefly describe your symptoms or medical concern..."
                rows={3}
                className="w-full p-3 rounded-xl text-base focus:outline-none font-sans border border-line-strong text-ink placeholder:text-ink-3 resize-none"
                style={{ background: 'var(--bg)' } as React.CSSProperties}
              />
            </div>

            <div className="bg-canvas p-5 border border-line rounded-2xl">
               <div className="flex items-center gap-2 mb-4">
                  <AlertCircle size={14} className="text-brand" />
                  <span className="block text-sm font-medium text-ink-2">Secure Medical Transfer</span>
               </div>
               <div className="space-y-3 font-sans text-sm text-ink">
                 <div className="flex items-center gap-3"><CheckCircle size={14} className="text-success" /> All medical reports</div>
                 <div className="flex items-center gap-3"><CheckCircle size={14} className="text-success" /> Active medications</div>
                 <div className="flex items-center gap-3"><CheckCircle size={14} className="text-success" /> Documented allergies</div>
                 <div className="flex items-center gap-3"><CheckCircle size={14} className="text-success" /> Past visit history</div>
               </div>
            </div>
            
            <div className="flex gap-4 pt-4">
               <button
                 type="button"
                 onClick={bookAppointment}
                 disabled={bookingSubmitting || bookingOptimistic}
                 className={`flex-1 min-h-[52px] py-4 rounded-2xl text-base font-semibold transition-colors flex items-center justify-center gap-2 border ${
                   bookingOptimistic
                     ? 'bg-success border-success-soft text-white cursor-default'
                     : bookingSubmitting
                     ? 'bg-brand border-brand text-white opacity-60 cursor-wait'
                     : 'bg-brand hover:bg-brand-dark border-brand text-white'
                 }`}
               >
                 {bookingOptimistic ? (<><CheckCircle size={16} /> Booked</>) : bookingSubmitting ? 'Booking…' : 'Confirm Appointment'}
               </button>
               <button type="button" onClick={() => setBookingHospital(null)} disabled={bookingOptimistic} className="w-16 min-h-[52px] flex items-center justify-center border border-line-strong bg-canvas text-ink-2 hover:text-ink rounded-2xl transition-colors disabled:opacity-40">
                  <X size={20} />
               </button>
            </div>
          </div>
        </div>
      </div>
    );
  };

  // Haversine distance in km
  const calculateDistance = (lat1: number, lng1: number, lat2: number, lng2: number): number => {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng/2) * Math.sin(dLng/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  };

  const renderFindCare = () => (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-1000 h-full flex flex-col">
      {renderEmergencyModal()}
      {renderBookingModal()}
      
      <div className="flex-none">
        <h2 className="text-4xl font-serif italic text-ink mb-2">Find Care</h2>
        <p className="text-ink-2 font-light mb-8">AI-guided triage and intelligent facility routing.</p>

        <div className="flex gap-4 mb-8">
           <button onClick={() => setSearchMode('triage')} className={`px-6 py-2 rounded-full font-mono text-[10px] uppercase tracking-widest transition-all ${searchMode === 'triage' ? 'bg-brand text-white' : 'bg-surface-2 text-ink-3 hover:bg-surface-2'}`}>Triage (Symptoms)</button>
           <button onClick={() => setSearchMode('direct')} className={`px-6 py-2 rounded-full font-mono text-[10px] uppercase tracking-widest transition-all ${searchMode === 'direct' ? 'bg-brand text-white' : 'bg-surface-2 text-ink-3 hover:bg-surface-2'}`}>Direct Search</button>
        </div>

        {/* Input Area */}
        <div className="relative mb-6">
           {searchMode === 'triage' ? (
             <>
               <input 
                 type="text" 
                 value={symptoms}
                 onChange={e => setSymptoms(e.target.value)}
                 onKeyDown={e => e.key === "Enter" && triggerTriage(symptoms)}
                 placeholder="Describe your symptoms..."
                 className="symptom-input w-full py-5 pl-6 pr-16 rounded-xl text-lg font-sans focus:outline-none transition-colors"
                 style={{
                   width: "100%",
                   padding: "14px 16px",
                   paddingRight: 56,
                   background: "white",
                   border: "1px solid rgba(15,118,110,0.3)",
                   borderRadius: 10,
                   fontFamily: 'var(--font-sans)',
                   fontSize: 15,
                   color: "var(--text)",
                   outline: "none",
                   boxSizing: "border-box"
                 }}
               />
               <button 
                 onClick={handleSymptomsVoice}
                 className={`absolute right-4 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full flex items-center justify-center transition-all ${isListeningFindCare ? 'bg-danger/20 text-danger animate-pulse' : 'bg-canvas text-ink-2 hover:bg-surface-2 hover:text-brand'}`}
               >
                  <Mic size={18} />
               </button>
             </>
           ) : (
             <div className="relative">
               <input 
                 type="text" 
                 value={hospitalSearchQuery}
                 onChange={e => setHospitalSearchQuery(e.target.value)}
                 onKeyDown={e => e.key === "Enter" && searchHospitals(hospitalSearchQuery)}
                 placeholder="Search Hospital Name or City..."
                 className="w-full py-5 pl-6 pr-16 rounded-xl text-lg font-sans focus:outline-none transition-colors"
                 style={{
                   width: "100%",
                   padding: "14px 16px",
                   paddingRight: 100,
                   background: "white",
                   border: "1px solid var(--brand)",
                   borderRadius: 10,
                   fontFamily: 'var(--font-sans)',
                   fontSize: 15,
                   color: "var(--text)",
                   outline: "none",
                   boxSizing: "border-box"
                 }}
               />
               <button 
                 onClick={() => searchHospitals(hospitalSearchQuery)}
                 className="absolute right-3 top-1/2 -translate-y-1/2 bg-brand text-white px-4 py-2 rounded-lg font-mono text-[9px] uppercase tracking-widest font-bold"
               >
                 Search India
               </button>
             </div>
           )}
        </div>

        {isTriageLoading && (
           <div className="text-center py-4 font-mono text-[10px] uppercase tracking-widest text-brand animate-pulse">
              Analyzing Clinical Path...
           </div>
        )}

        {/* Triage Result Card */}
        {triageResult && !triageResult.red_flag && (
           <div style={{
             background: "rgba(15,118,110,0.06)",
             border: "1px solid rgba(15,118,110,0.2)",
             borderRadius: 12,
             padding: "16px 20px",
             marginBottom: 24,
             display: "flex",
             flexDirection: "column",
             gap: 8
           }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                 <span style={{
                   fontFamily: 'var(--font-sans)',
                   fontSize: 11,
                   color: "var(--brand)",
                   border: "1px solid rgba(15,118,110,0.3)",
                   padding: "3px 10px",
                   borderRadius: 100,
                   background: "rgba(15,118,110,0.08)",
                   fontWeight: 600,
                   letterSpacing: "0.05em"
                 }}>
                   {triageResult.specialist_type || triageResult.specialist}
                 </span>
                 <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                   {triageResult.urgency === 'routine' && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--success)", display: "inline-block" }}></span>}
                   {triageResult.urgency === 'urgent' && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--warning)", display: "inline-block" }}></span>}
                   {triageResult.urgency === 'emergency' && <span style={{ width: 8, height: 8, borderRadius: "50%", background: "var(--danger)", display: "inline-block", animation: "pulse 1s infinite" }}></span>}
                   <span style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: "var(--text-secondary)", textTransform: "uppercase", letterSpacing: "0.1em" }}>{triageResult.urgency}</span>
                 </div>
              </div>
              <p style={{ fontFamily: 'var(--font-sans)', fontSize: 14, color: "var(--text)", lineHeight: 1.6, margin: 0 }}>{triageResult.explanation}</p>
           </div>
        )}
      </div>

      {/* Verified Vela Network Partners (Dedicated Onboarded Facility List) */}
      {networkHospitals.length > 0 && (
         <div className="mb-8 animate-in fade-in slide-in-from-bottom-4 duration-500 flex-none">
            <h3 className="text-xs font-mono font-bold tracking-[0.2em] text-brand uppercase mb-4 flex items-center gap-2">
              <Activity size={12} className="text-brand animate-pulse" />
              Vela Network Partner Hospitals ({networkHospitals.length})
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
               {networkHospitals.map((vh) => (
                  <div 
                    key={vh.id} 
                    className="bg-night border border-brand/30 rounded-3xl p-6 hover:-translate-y-1 transition-all duration-300 relative overflow-hidden flex flex-col justify-between"
                    style={{ minHeight: 180, boxShadow: '0 20px 40px -15px rgba(200,184,154,0.15)' }}
                  >
                     <div className="absolute top-0 right-0 w-24 h-24 bg-brand/5 blur-2xl rounded-full" />
                     
                     <div>
                        <div className="flex items-start justify-between gap-4 mb-2">
                           <h4 className="font-serif italic text-xl text-white line-clamp-1">{vh.name}</h4>
                           <span className="bg-brand/20 border border-brand/30 text-brand font-mono text-[7px] font-bold px-2 py-0.5 rounded tracking-widest uppercase flex items-center gap-1">
                             <CheckCircle2 size={8} /> Verified
                           </span>
                        </div>
                        <p className="text-white/60 text-xs font-sans line-clamp-2 mb-4 leading-relaxed">{vh.address}</p>
                     </div>
                     
                     <div className="flex items-center justify-between gap-4 mt-auto">
                        <span className="text-[9px] font-mono text-success bg-success/10 px-2 py-0.5 rounded border border-success-soft/20 font-bold uppercase tracking-wider">Live Sync</span>
                        <button
                           type="button"
                           onClick={() => {
                              const formattedH = {
                                 id: vh.id,
                                 name: vh.name,
                                 lat: vh.lat,
                                 lng: vh.lng,
                                 vicinity: vh.address,
                                 is_vela: true
                              };
                              setBookingHospital(formattedH);
                              setBookingNetworkHospitalId(vh.id);
                           }}
                           className="bg-white hover:bg-white text-ink font-mono text-[8px] font-bold px-4 py-2.5 rounded-xl uppercase tracking-widest transition-all"
                        >
                           Initialize Transfer
                        </button>
                     </div>
                  </div>
               ))}
            </div>
         </div>
      )}

      {/* Verified Vela Network Solo Doctors */}
      {networkDoctors.length > 0 && (
         <div className="mb-8 animate-in fade-in slide-in-from-bottom-4 duration-500 flex-none">
            <h3 className="text-xs font-mono font-bold tracking-[0.2em] text-brand uppercase mb-4 flex items-center gap-2">
              <Activity size={12} className="text-brand animate-pulse" />
              Vela Network Solo Doctors ({networkDoctors.length})
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
               {networkDoctors.map((d) => (
                  <div key={d.id} className="bg-white border border-line rounded-3xl p-6 hover:-translate-y-1 transition-all duration-300 flex flex-col justify-between" style={{ minHeight: 180 }}>
                     <div>
                        <div className="flex items-start justify-between gap-4 mb-2">
                           <h4 className="font-serif italic text-xl text-ink line-clamp-1">Dr. {d.name}</h4>
                           <span className="bg-brand/10 border border-brand/20 text-brand font-mono text-[7px] font-bold px-2 py-0.5 rounded tracking-widest uppercase flex items-center gap-1">
                             <CheckCircle2 size={8} /> Verified
                           </span>
                        </div>
                        <p className="text-ink-2 text-xs font-sans mb-1">{d.specialization}</p>
                        <p className="text-ink-3 text-xs font-sans line-clamp-2 mb-4 leading-relaxed">{d.address}</p>
                     </div>
                     <div className="flex items-center justify-between gap-4 mt-auto">
                        <span className="text-sm font-bold text-ink">₹{Number(d.consultation_fee || 0).toLocaleString('en-IN')}</span>
                        <button
                           type="button"
                           onClick={() => setBookingNetworkDoctor(d)}
                           className="bg-night hover:bg-brand text-white font-mono text-[8px] font-bold px-4 py-2.5 rounded-xl uppercase tracking-widest transition-all"
                        >
                           Book Appointment
                        </button>
                     </div>
                  </div>
               ))}
            </div>
         </div>
      )}

      {bookingNetworkDoctor && (
         <div className="fixed inset-0 z-[200] flex items-center justify-center p-6 bg-black/40 backdrop-blur-sm">
            <div className="bg-white w-full max-w-md rounded-3xl shadow-2xl overflow-hidden">
               <div className="p-8 border-b border-line flex justify-between items-center bg-canvas">
                  <div>
                     <h3 className="font-serif italic text-2xl text-ink">Dr. {bookingNetworkDoctor.name}</h3>
                     <p className="font-mono text-[10px] text-ink-3 uppercase tracking-widest">{bookingNetworkDoctor.specialization}</p>
                  </div>
                  <button onClick={() => setBookingNetworkDoctor(null)} className="p-2 text-ink-3 hover:text-ink">✕</button>
               </div>
               <div className="p-8 space-y-4">
                  <div>
                     <label className="font-mono text-[9px] uppercase tracking-widest text-ink-3">Date</label>
                     <input type="date" value={networkDoctorDate} onChange={(e) => setNetworkDoctorDate(e.target.value)}
                        className="w-full mt-2 bg-canvas border border-line rounded-xl px-4 py-3 text-ink focus:border-brand focus:outline-none" />
                  </div>
                  <div>
                     <label className="font-mono text-[9px] uppercase tracking-widest text-ink-3">Time</label>
                     <input type="time" value={networkDoctorTime} onChange={(e) => setNetworkDoctorTime(e.target.value)}
                        className="w-full mt-2 bg-canvas border border-line rounded-xl px-4 py-3 text-ink focus:border-brand focus:outline-none" />
                  </div>
                  <p className="text-xs text-ink-3">
                     Consultation fee ₹{Number(bookingNetworkDoctor.consultation_fee || 0).toLocaleString('en-IN')}, paid directly to the doctor.
                  </p>
                  <button
                     onClick={bookNetworkDoctor}
                     disabled={bookingNetworkDoctorSubmitting}
                     className="w-full py-4 bg-brand text-white font-mono text-[11px] font-bold uppercase tracking-[0.2em] hover:bg-brand-dark rounded-2xl transition-all disabled:opacity-50"
                  >
                     {bookingNetworkDoctorSubmitting ? 'Booking…' : 'Confirm Appointment'}
                  </button>
               </div>
            </div>
         </div>
      )}

      <div className="flex-1 min-h-[400px] grid grid-cols-1 lg:grid-cols-2 gap-6 pb-12">
         {/* Map View */}
         <div style={{ borderRadius: 12, overflow: "hidden", border: "1px solid rgba(15,118,110,0.15)" }}>
            <div ref={mapRef} style={{ width: "100%", height: 400 }} />
         </div>

         {/* Hospitals List */}
         <div className="bg-transparent overflow-y-auto styled-scrollbar pr-2" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {isSearchingHospitals ? (
                <div className="h-full flex items-center justify-center" style={{ minHeight: 200 }}>
                   <div style={{ textAlign: "center" }}>
                     <div style={{ width: 24, height: 24, border: "2px solid var(--brand)", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} />
                     <p className="font-mono text-[10px] uppercase tracking-widest text-ink-3">Finding hospitals nearby...</p>
                   </div>
                </div>
            ) : hospitals.length === 0 ? (
                <div className="h-full flex items-center justify-center border border-line border-dashed rounded-3xl" style={{ minHeight: 180, background: 'rgba(248, 250, 252, 0.5)' }}>
                   <div className="text-center p-8">
                     <p className="font-serif italic text-xl text-ink-3 mb-2">No facilities found</p>
                     <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-3 max-w-xs mx-auto">Try searching for a different city or hospital name, or describe your symptoms</p>
                   </div>
                </div>
            ) : (
                hospitals.map((h, i) => (
                  <div key={h.id || i} 
                    className={`group relative overflow-hidden transition-all duration-500 hover:-translate-y-1 ${h.is_vela ? 'bg-night border-brand/40' : 'bg-white border-line'}`}
                    onClick={() => {
                      setSelectedHospital(h);
                      mapInstanceRef.current?.flyTo({ center: [h.lng, h.lat], zoom: 15 });
                    }}
                    style={{
                      borderWidth: 1, borderRadius: 24, padding: 24, cursor: "pointer",
                      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 20,
                      boxShadow: h.is_vela ? '0 20px 40px -15px rgba(200,184,154,0.15)' : '0 10px 30px -12px rgba(0,0,0,0.05)'
                    }}
                  >
                    {h.is_vela && <div className="absolute top-0 right-0 w-32 h-32 bg-brand/5 blur-3xl rounded-full -mr-16 -mt-16" />}
                    
                    <div className="flex items-center gap-6 relative z-10">
                      <div className={`w-14 h-14 rounded-2xl flex items-center justify-center font-mono text-lg font-black transition-all duration-500 ${h.is_vela ? 'bg-brand text-white shadow-[0_0_30px_rgba(200,184,154,0.4)]' : 'bg-canvas text-ink-3 group-hover:bg-white group-hover:text-white'}`}>
                        {h.is_vela ? 'V' : i + 1}
                      </div>
                      
                      <div>
                        <div className="flex items-center gap-4 mb-2">
                          <h4 className={`font-serif italic text-3xl leading-none ${h.is_vela ? 'text-white' : 'text-ink'}`}>{h.name}</h4>
                          {h.is_vela && (
                            <div className="flex items-center gap-2 bg-brand/20 px-4 py-1.5 rounded-full border border-brand/30 backdrop-blur-md">
                              <CheckCircle2 size={10} className="text-brand" />
                              <span className="text-[10px] font-black text-brand uppercase tracking-[0.2em]">VERIFIED PARTNER</span>
                              <div className="w-1.5 h-1.5 bg-brand rounded-full animate-pulse shadow-[0_0_8px_var(--brand)]" />
                            </div>
                          )}
                        </div>
                        <p className={`font-sans text-sm mb-4 max-w-md line-clamp-1 ${h.is_vela ? 'text-white/60' : 'text-ink-2'}`}>{h.vicinity}</p>
                        <div className="flex items-center gap-4">
                           <span className={`font-mono text-[10px] font-bold uppercase tracking-wider ${h.is_vela ? 'text-brand' : 'text-brand'}`}>
                             {h.distance < 1 ? Math.round(h.distance * 1000) + 'm' : h.distance.toFixed(1) + 'km'} AWAY
                           </span>
                           {h.is_vela && <span className="font-mono text-[9px] text-success bg-success/10 px-2 py-0.5 rounded border border-success/20 uppercase font-bold tracking-widest">Live Sync</span>}
                        </div>
                      </div>
                    </div>

                    <button 
                      type="button"
                      onClick={(e) => { e.stopPropagation(); setBookingHospital(h); if (h.is_vela) setBookingNetworkHospitalId(h.id); }}
                      className={`relative z-10 px-8 py-3.5 rounded-2xl font-mono text-[10px] font-black uppercase tracking-[0.2em] transition-all duration-300 ${h.is_vela ? 'bg-white text-night hover:bg-brand hover:scale-105 shadow-xl shadow-black/20' : 'bg-night text-white hover:bg-brand'}`}
                    >
                      {h.is_vela ? 'Initialize Transfer' : 'Book Session'}
                    </button>
                  </div>
                ))
            )}
         </div>
      </div>
    </div>
  );

  const QueueTracker: React.FC<{ appointmentId: string }> = ({ appointmentId }) => {
    const [loading, setLoading] = useState(true);
    const [queueData, setQueueData] = useState<any>(null);

    const fetchQueueStatus = async () => {
      try {
        const res = await axios.get(`${API_URL}/api/appointments/queue/${appointmentId}`);
        if (res.data?.status === 'success') {
          setQueueData(res.data);
        } else {
          setQueueData(null);
        }
      } catch (err) {
        setQueueData(null);
      } finally {
        setLoading(false);
      }
    };

    useEffect(() => {
      fetchQueueStatus();
      // Don't poll from a hidden tab — a dashboard left open in the background hammered the server.
      const interval = setInterval(() => { if (!document.hidden) fetchQueueStatus(); }, POLL_INTERVALS.patientQueue);
      return () => clearInterval(interval);
    }, [appointmentId]);

    if (loading) {
      return null;  // no "synchronizing" text — the position simply appears when it arrives
    }

    if (!queueData) return null;

    return (
      <div className="mt-4 bg-canvas border border-line p-4 rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-4 animate-in fade-in duration-300">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-brand text-white flex flex-col items-center justify-center shadow-lg shadow-brand/20">
            <span className="font-mono text-xs font-bold leading-none">{queueData.ticket_number?.split('-').pop()}</span>
            <span className="font-mono text-[5px] uppercase tracking-tight font-bold">Ticket</span>
          </div>
          <div>
            <div className="font-mono text-[8px] uppercase tracking-widest text-ink-3">Assigned Practitioner</div>
            <div className="font-sans text-xs font-bold text-ink">{queueData.assigned_doctor}</div>
          </div>
        </div>
        <div className="flex items-center gap-6">
          <div className="text-right">
            <div className="font-mono text-[8px] uppercase tracking-widest text-ink-3">Queue Place</div>
            <div className="font-serif italic text-base font-bold text-brand">#{queueData.position}</div>
          </div>
          <div className="text-right border-l border-line pl-4">
            <div className="font-mono text-[8px] uppercase tracking-widest text-ink-3">Waiting Ahead</div>
            <div className="font-serif italic text-base font-bold text-ink">{queueData.people_ahead} Patients</div>
          </div>
        </div>
      </div>
    );
  };

  const renderAppointments = () => (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-1000">
      <div className="flex justify-between items-end">
        <div>
           <h2 className="text-4xl font-serif italic text-ink mb-2">Appointments</h2>
           <p className="text-ink-2 font-light">Track your scheduled visits and historical journey.</p>
        </div>
        <button className="bg-brand text-white px-6 py-3 rounded-xl font-mono text-[10px] uppercase tracking-widest hover:bg-brand-dark transition-all flex items-center gap-2 shadow-lg shadow-brand/20" onClick={() => setActiveTab('find-care')}>
           <CalendarPlus size={16} /> New Booking
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4">
         {appointments.length === 0 ? (
            <div className="p-20 border border-line border-dashed text-center flex flex-col items-center rounded-xl bg-white">
                <div className="w-16 h-16 rounded-full flex items-center justify-center mb-6 text-ink-3 bg-canvas">
                    <CalendarPlus size={24} strokeWidth={1} />
                </div>
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-2">No upcoming appointments</p>
                <button onClick={() => setActiveTab('find-care')} className="mt-4 text-brand text-xs font-medium hover:underline">Schedule your first visit</button>
            </div>
         ) : (
            appointments.map((apt) => {
                const timeStr = apt.time || apt.appointment_time || "00:00";
                return (
                    <div key={apt.id} className="bg-white border border-line p-8 rounded-2xl flex flex-col justify-between group hover:border-brand/30 transition-all shadow-sm gap-4">
                        <div className="flex items-center justify-between flex-wrap gap-4">
                            <div className="flex items-center gap-8">
                                <div className="w-16 h-16 bg-canvas border border-line rounded-xl flex flex-col items-center justify-center">
                                    <span className="font-serif italic text-2xl text-ink">{timeStr.split(':')[0]}</span>
                                    <span className="font-mono text-[8px] text-brand font-bold uppercase">{timeStr.split(':')[1]} {parseInt(timeStr.split(':')[0]) >= 12 ? 'PM' : 'AM'}</span>
                                </div>
                                <div>
                                    <div className="flex items-center gap-3 mb-1">
                                        <h4 className="text-2xl font-serif italic text-ink">{apt.hospital_name}</h4>
                                        <span className={`font-mono text-[8px] uppercase tracking-widest px-2 py-0.5 rounded-full border ${
                                            apt.status === 'scheduled' ? 'bg-brand-tint text-brand border-brand-soft' :
                                            apt.status === 'arrived' ? 'bg-brand/10 text-brand border-brand/20 animate-pulse' :
                                            apt.status === 'pending' ? 'bg-warning-tint text-warning border-warning-soft' :
                                            apt.status === 'confirming' ? 'bg-success-tint text-success border-success-soft animate-pulse' :
                                            apt.status === 'rejected' ? 'bg-danger-tint text-danger border-danger-soft' :
                                            'bg-canvas text-ink-3 border-line'
                                        }`}>
                                            {apt.status === 'confirming' ? 'saving…' : apt.status}
                                        </span>
                                    </div>
                                    <div className="flex gap-4 text-sm text-ink-2 font-medium">
                                        <span className="flex items-center gap-1.5"><Clock size={14}/> {apt.appointment_date || apt.date}</span>
                                        <span className="flex items-center gap-1.5"><User size={14}/> {apt.doctor_name || 'General Physician'}</span>
                                    </div>
                                </div>
                            </div>
                            {apt.status === 'scheduled' && (
                                <div className="flex items-center gap-3">
                                    <button className="p-3 text-ink-3 hover:text-danger transition-colors"><X size={18}/></button>
                                    <button className="bg-white border border-line text-ink px-6 py-3 rounded-xl font-mono text-[9px] uppercase tracking-widest hover:border-brand transition-all">Details</button>
                                </div>
                            )}
                            {apt.status === 'arrived' && (
                                <div className="flex items-center gap-2 text-success font-mono text-[9px] uppercase tracking-widest font-bold">
                                    <div className="w-2 h-2 rounded-full bg-success animate-ping"></div>
                                    Check-in Complete
                                </div>
                            )}
                        </div>
                        {/* Only poll the live wait-queue once the patient has actually
                            checked in — a future "scheduled" appointment has no queue
                            position yet, so polling it just generates load. */}
                        {(apt.status === 'arrived' || apt.status === 'in-progress') && (
                            <QueueTracker appointmentId={apt.id} />
                        )}
                    </div>
                );
            })
         )}
      </div>
      
      {appointments.some(a => a.status === 'completed') && (
          <div className="pt-12 border-t border-line">
             <h3 className="font-serif italic text-2xl mb-6 text-ink">Historical Timeline</h3>
             <div className="space-y-4">
                 {appointments.filter(a => a.status === 'completed').map(apt => (
                     <div key={apt.id} className="flex gap-6 items-start opacity-70">
                         <div className="w-1 bg-surface-2 self-stretch rounded-full" />
                         <div className="pb-4">
                             <div className="font-mono text-[10px] text-ink-3 uppercase tracking-widest mb-1">{apt.appointment_date}</div>
                             <div className="font-sans text-sm text-ink font-medium">{apt.hospital_name} · Consultation Completed</div>
                         </div>
                     </div>
                 ))}
             </div>
          </div>
      )}
    </div>
  );

  const renderHistory = () => (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-1000">
        <div>
            <h2 className="text-4xl font-serif italic text-ink mb-2">Health Journey</h2>
            <p className="text-ink-2 font-light">A complete chronological record of your care at VELA.</p>
        </div>

        {historyLoading ? (
            <div className="py-20 text-center font-mono text-[10px] text-ink-3 uppercase tracking-widest">Retrieving Timeline...</div>
        ) : patientHistory.length === 0 ? (
            <div className="p-20 border border-line border-dashed text-center flex flex-col items-center rounded-3xl bg-white">
                <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-2">No medical history recorded yet</p>
            </div>
        ) : (
            <div className="relative space-y-12">
                <div className="absolute left-8 top-0 bottom-0 w-[1px] bg-surface-2 z-0"></div>
                
                {patientHistory.map((visit, i) => (
                    <div key={i} className="relative z-10 flex gap-12 group cursor-pointer" onClick={() => setSelectedVisit(visit)}>
                        <div className={`w-16 h-16 rounded-2xl flex items-center justify-center shadow-xl transition-all group-hover:scale-110 ${
                            visit.event_type === 'discharge' ? 'bg-success text-white shadow-success-soft/20' :
                            visit.event_type === 'admission' ? 'bg-brand text-white shadow-brand-soft/20' :
                            'bg-night text-white shadow-line-strong/20'
                        }`}>
                            {visit.event_type === 'discharge' ? <CheckCircle size={24} /> :
                             visit.event_type === 'admission' ? <Activity size={24} /> :
                             <FileText size={24} />}
                        </div>
                        
                        <div className="flex-1 bg-white border border-line p-8 rounded-[32px] group-hover:border-brand-soft/30 transition-all shadow-sm hover:shadow-xl">
                            <div className="flex justify-between items-start mb-4">
                                <div>
                                    <div className="font-mono text-[10px] text-ink-3 uppercase tracking-widest mb-1">{visit.date}</div>
                                    <h4 className="font-serif italic text-3xl text-ink">{visit.title}</h4>
                                </div>
                                <span className="font-mono text-[10px] text-brand font-bold uppercase tracking-widest">{visit.event_type}</span>
                            </div>
                            <p className="text-sm text-ink-2 leading-relaxed line-clamp-2 italic">"{visit.summary}"</p>
                            
                            <div className="mt-6 pt-6 border-t border-line flex items-center gap-4 text-xs text-ink-3 font-mono uppercase tracking-widest">
                                <span>Facility: {visit.hospital_id || 'VELA CENTRAL'}</span>
                                {visit.doctor_name && (
                                    <>
                                        <span className="text-ink-3">|</span>
                                        <span>Care: Dr. {visit.doctor_name}</span>
                                    </>
                                )}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        )}

        {/* Visit Details Modal */}
        {selectedVisit && (
            <div className="fixed inset-0 bg-night/90 backdrop-blur-xl z-[200] flex items-center justify-center p-6 animate-in fade-in duration-500">
                <div className="w-full max-w-3xl bg-white rounded-[40px] shadow-2xl overflow-hidden relative border border-line flex flex-col max-h-[85vh]">
                    <button onClick={() => setSelectedVisit(null)} className="absolute top-8 right-8 text-ink-3 hover:text-ink z-10 transition-colors">
                        <X size={24} />
                    </button>

                    <div className="p-12 overflow-y-auto custom-scrollbar">
                        <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-brand mb-4 font-bold">Clinical Record</div>
                        <h2 className="font-serif italic text-5xl text-ink mb-2">{selectedVisit.title}</h2>
                        <div className="font-mono text-[11px] text-ink-3 uppercase tracking-widest mb-12">{selectedVisit.date} · Facility ID: {selectedVisit.hospital_id}</div>

                        <div className="space-y-12">
                            {selectedVisit.details?.discharge_summary && (
                                <section>
                                    <h3 className="font-serif italic text-2xl text-ink mb-4">Medical Discharge Summary</h3>
                                    <div className="p-8 bg-canvas rounded-3xl border border-line text-sm leading-relaxed text-ink-2 whitespace-pre-wrap italic">
                                        {selectedVisit.details.discharge_summary}
                                    </div>
                                </section>
                            )}

                            {selectedVisit.details?.final_diagnosis && (
                                <div className="grid grid-cols-2 gap-8">
                                    <div className="p-6 bg-brand-tint/50 rounded-2xl border border-brand-soft/50">
                                        <div className="font-mono text-[9px] uppercase tracking-widest text-brand mb-2">Final Diagnosis</div>
                                        <div className="font-serif italic text-xl text-ink">{selectedVisit.details.final_diagnosis}</div>
                                    </div>
                                    <div className="p-6 bg-canvas rounded-2xl border border-line">
                                        <div className="font-mono text-[9px] uppercase tracking-widest text-ink-3 mb-2">Follow-up Date</div>
                                        <div className="font-serif italic text-xl text-ink">{selectedVisit.details.follow_up_date || 'None Scheduled'}</div>
                                    </div>
                                </div>
                            )}

                            {selectedVisit.details?.total_cost && (
                                <section className="p-8 bg-night rounded-[32px] text-white">
                                    <h4 className="font-mono text-[10px] uppercase tracking-widest opacity-50 mb-6 font-bold">Stay Billing Overview</h4>
                                    <div className="space-y-4 mb-8">
                                        <div className="flex justify-between text-xs opacity-70">
                                            <span>Accommodation & Services</span>
                                            <span className="font-mono font-bold">₹{selectedVisit.details.room_cost?.toLocaleString()}</span>
                                        </div>
                                        <div className="flex justify-between text-xs opacity-70">
                                            <span>Laboratory & Diagnostics</span>
                                            <span className="font-mono font-bold">₹{selectedVisit.details.test_cost?.toLocaleString()}</span>
                                        </div>
                                        <div className="h-[1px] bg-white/10"></div>
                                        <div className="flex justify-between items-center pt-2">
                                            <span className="font-mono text-[11px] uppercase tracking-widest text-brand-light font-bold">Total Settled</span>
                                            <span className="font-serif italic text-3xl">₹{selectedVisit.details.total_cost?.toLocaleString()}</span>
                                        </div>
                                    </div>
                                    <div className="flex items-center gap-3">
                                        <CheckCircle size={14} className="text-success" />
                                        <span className="font-mono text-[8px] uppercase tracking-[0.2em] opacity-40">Payment Confirmed · VELA Ledger Veridified</span>
                                    </div>
                                </section>
                            )}

                            {selectedVisit.details?.follow_up_instructions && (
                                <section className="pb-8">
                                    <h3 className="font-serif italic text-2xl text-ink mb-4">Recovery Instructions</h3>
                                    <p className="text-sm text-ink-2 leading-relaxed font-light">{selectedVisit.details.follow_up_instructions}</p>
                                </section>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        )}
    </div>
  );




  const renderAtlas = () => (
    <div className="space-y-12 animate-in fade-in slide-in-from-bottom-4 duration-1000 h-full flex flex-col items-center justify-center text-center">
       <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-brand mb-4 block">Atlas Patient Companion</span>
       <h2 className="text-4xl font-serif italic text-ink mb-12 max-w-lg leading-tight">Your personal medical intelligence, available instantly.</h2>
       
       <button 
           onMouseDown={startAtlasVoice}
           onMouseUp={() => { setAtlasListening(false); recognitionRef.current?.stop(); }}
           onMouseLeave={() => { setAtlasListening(false); recognitionRef.current?.stop(); }}
           onTouchStart={startAtlasVoice}
           onTouchEnd={() => { setAtlasListening(false); recognitionRef.current?.stop(); }}
           className={`relative w-40 h-40 rounded-full flex items-center justify-center transition-all duration-500 mb-16 shadow-2xl ${atlasListening ? 'bg-brand/10 border border-brand-soft scale-105' : 'bg-canvas border border-line-strong'}`}
       >
          {atlasListening && <div className="absolute inset-0 rounded-full border border-brand-soft animate-ping opacity-20"></div>}
          <Mic size={48} strokeWidth={1} className={atlasListening ? 'text-brand' : 'text-ink-2'} />
       </button>

       <p className="font-sans text-xl text-ink/80 font-light max-w-2xl h-24 flex items-center justify-center">"{atlasResponse}"</p>

       <div className="flex flex-wrap items-center justify-center gap-4 mt-8">
          <span className="bg-canvas border border-line px-4 py-2 rounded-full font-sans text-sm text-ink-2">"When is my next checkup?"</span>
          <span className="bg-canvas border border-line px-4 py-2 rounded-full font-sans text-sm text-ink-2">"What did my last blood test mean?"</span>
          <span className="bg-canvas border border-line px-4 py-2 rounded-full font-sans text-sm text-ink-2">"Should I take my medication with food?"</span>
       </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-canvas text-ink selection:bg-brand/30 flex font-sans overflow-hidden">
      <div className="absolute inset-0 opacity-[0.02] pointer-events-none" style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg viewBox=\'0 0 256 256\' xmlns=\'http://www.w3.org/2000/svg\'%3E%3Cfilter id=\'noise\'%3E%3CfeTurbulence type=\'fractalNoise\' baseFrequency=\'0.9\' numOctaves=\'4\' stitchTiles=\'stitch\'/%3E%3C/filter%3E%3Crect width=\'100%25\' height=\'100%25\' filter=\'url(%23noise)\'/%3E%3C/svg%3E")' }}></div>

      {renderEditModal()}
      
      {/* Sidebar Navigation — labelled. A bare icon rail asks the patient to
          decode a pill, a pin and a waveform before they can find anything;
          the words cost a little width and remove the guessing entirely. */}
      <aside className="hidden md:flex fixed left-0 top-0 h-screen w-60 border-r border-line bg-canvas/90 backdrop-blur-3xl z-50 flex-col py-8 px-4">
        <div className="flex items-center gap-3 px-3 mb-10">
             <img src="/vela-icon.png" alt="" style={{ height: 28, width: "auto" }} />
             <span className="text-lg font-semibold text-ink">VELA</span>
        </div>

        <nav className="flex flex-col gap-1">
            {PATIENT_TABS.map(tab => (
              <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`relative w-full h-12 flex items-center gap-3 px-3 rounded-xl text-base transition-colors ${activeTab === tab.id ? 'bg-brand text-white font-semibold' : 'text-ink-2 hover:bg-surface-2/60 hover:text-ink'}`}
              >
                  <tab.icon size={20} strokeWidth={1.75} className="shrink-0" />
                  {tab.label}
              </button>
            ))}
        </nav>

        <div className="mt-auto">
             <a
                href="tel:108"
                className="w-full h-12 flex items-center gap-3 px-3 mb-2 rounded-xl text-base font-semibold text-danger hover:bg-danger-tint transition-colors"
            >
                <Phone size={20} strokeWidth={1.75} className="shrink-0" /> Emergency · 108
            </a>
             <button
                onClick={() => { localStorage.clear(); navigate("/portal"); }}
                className="w-full h-12 flex items-center gap-3 px-3 rounded-xl text-base text-ink-2 hover:bg-surface-2/60 hover:text-ink transition-colors"
            >
                <LogOut size={20} strokeWidth={1.75} className="shrink-0" /> Sign out
            </button>
        </div>
      </aside>

      {/* Phone navigation. Patients are overwhelmingly on a phone, where a
          fixed side rail eats a third of the screen and reaches badly. */}
      <nav className="md:hidden fixed bottom-0 inset-x-0 z-50 border-t border-line bg-white/95 backdrop-blur-xl flex">
        {PATIENT_TABS.filter(t => t.primary).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex-1 h-16 flex flex-col items-center justify-center gap-1 transition-colors ${activeTab === tab.id ? 'text-brand' : 'text-ink-2'}`}
          >
            <tab.icon size={22} strokeWidth={1.75} />
            <span className="text-[11px] font-medium leading-none">{tab.short}</span>
          </button>
        ))}
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 md:ml-60 p-5 sm:p-8 md:p-16 max-w-[1400px] mx-auto w-full relative z-10 overflow-y-auto h-screen styled-scrollbar pb-28 md:pb-16">
        {/* Header */}
        <header className="flex items-end justify-between mb-12 border-b border-line pb-8 fade-in-up">
            <div>
                <h1 className="text-5xl md:text-6xl font-serif italic text-ink mb-4 leading-none tracking-tight">
                    Welcome back,<br/><span className="text-ink/80">{patient?.name?.split(" ")[0]}</span>.
                </h1>
                <div className="flex items-center gap-4 text-[10px] text-ink-2 font-mono uppercase tracking-[0.2em]">
                    <span>{new Date().toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</span>
                </div>
            </div>
            <div className="flex items-center gap-4">
                 <button type="button" onClick={openEditProfile} className="min-h-[48px] px-5 flex items-center gap-2 rounded-full bg-white border border-line-strong text-ink font-medium hover:bg-surface-2 transition-colors">
                    <Pencil size={18} strokeWidth={1.75} /> Edit my details
                 </button>
            </div>
        </header>

        <div className={activeTab === 'home' ? 'block' : 'hidden'}>
          {renderHome()}
        </div>
        <div className={activeTab === 'reports' ? 'block' : 'hidden'}>
          {renderReports()}
        </div>
        <div className={activeTab === 'medications' ? 'block' : 'hidden'}>
          {renderMedications()}
        </div>
        <div className={activeTab === 'find-care' ? 'block' : 'hidden'}>
          {renderFindCare()}
        </div>

        <div className={activeTab === 'appointments' ? 'block' : 'hidden'}>
          {renderAppointments()}
        </div>
        <div className={activeTab === 'atlas' ? 'block' : 'hidden'}>
          {renderAtlas()}
        </div>
        <div className={activeTab === 'history' ? 'block' : 'hidden'}>
          {renderHistory()}
        </div>
        
      </main>
    </div>
  );
};

export default PatientDashboard;
