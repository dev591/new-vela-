import { BrowserRouter, Routes, Route, useLocation } from "react-router-dom";
import { lazy, Suspense, useState, useEffect, useRef } from "react";
import { Toaster } from "react-hot-toast";
import LandingPage from "./pages/LandingPage";
import ProtectedRoute from "./components/ProtectedRoute";
import Atlas from "./components/Atlas/Atlas";
import useSocket from "./hooks/useSocket";
import ErrorBoundary from "./components/ErrorBoundary";

// Route-level code splitting keeps the initial bundle small — heavy deps
// (mapbox-gl, three, recharts) only load with the page that needs them.
const Login = lazy(() => import("./pages/Login"));
const Receptionist = lazy(() => import("./pages/Receptionist"));
const Doctor = lazy(() => import("./pages/Doctor"));
const PatientDetail = lazy(() => import("./pages/PatientDetail"));
const PatientsList = lazy(() => import("./pages/PatientsList"));
const Emergency = lazy(() => import("./pages/Emergency"));
const AddPatient = lazy(() => import("./pages/AddPatient"));
const Handover = lazy(() => import("./pages/Handover"));
const PatientPortal = lazy(() => import("./pages/PatientPortal"));
const PatientDashboard = lazy(() => import("./pages/PatientDashboard"));
const QRScan = lazy(() => import("./pages/QRScan"));
const HospitalManager = lazy(() => import("./pages/HospitalManager"));
const LabController = lazy(() => import("./pages/LabController"));
const WardScan = lazy(() => import("./pages/WardScan"));
const VelaOwner = lazy(() => import("./pages/VelaOwner"));
const ManagerWalkthrough = lazy(() => import("./pages/ManagerWalkthrough"));

function RouteFallback() {
  return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", color: "var(--text-secondary)", fontFamily: "var(--font-sans)", fontSize: 15 }}>
      Loading…
    </div>
  );
}

function AtlasWrapper({ currentPatientId }: { currentPatientId?: string }) {
  const location = useLocation();
  const hiddenPaths = ['/', '/login', '/portal', '/patient-dashboard', '/ward-scan'];
  
  // Also hide on dynamic scan routes
  if (hiddenPaths.includes(location.pathname)) return null;
  if (location.pathname.startsWith('/scan/')) return null;

  const role = localStorage.getItem("vela_role");
  const auth = localStorage.getItem("vela_auth");
  const showAtlas = auth === "true" && role === "doctor";

  if (!showAtlas) return null;

  return <Atlas currentPatientId={currentPatientId} userRole="doctor" />;
}

function App() {
  useSocket();
  // Staff auto-logoff after 30 min of inactivity (HIPAA-style). Patients stay signed in by design.
  useEffect(() => {
    const IDLE_MS = 30 * 60 * 1000;
    let last = Date.now();
    const bump = () => { last = Date.now(); };
    const evs = ["mousemove", "keydown", "click", "touchstart", "scroll"];
    evs.forEach(e => window.addEventListener(e, bump, { passive: true }));
    const timer = setInterval(() => {
      const role = localStorage.getItem("vela_role");
      if (localStorage.getItem("vela_auth") === "true" && role && role !== "patient" && Date.now() - last > IDLE_MS) {
        localStorage.clear();
        window.location.href = "/login";
      }
    }, 30000);
    return () => { evs.forEach(e => window.removeEventListener(e, bump)); clearInterval(timer); };
  }, []);
  const [currentPatientId, setCurrentPatientId] = useState<string | undefined>();
  const dotRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (window as any).setAtlasPatient = setCurrentPatientId;
  }, []);

  useEffect(() => {
    const dot = dotRef.current;
    const ring = ringRef.current;
    if (!dot || !ring) return;

    let rx = 0, ry = 0;
    let animId: number;

    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

    let mouseX = 0, mouseY = 0;

    const animate = () => {
      rx = lerp(rx, mouseX, 0.12);
      ry = lerp(ry, mouseY, 0.12);
      ring.style.transform = `translate(${rx - 14}px, ${ry - 14}px)`;
      animId = requestAnimationFrame(animate);
    };

    const onMove = (e: MouseEvent) => {
      mouseX = e.clientX;
      mouseY = e.clientY;
      dot.style.transform = `translate(${e.clientX - 2.5}px, ${e.clientY - 2.5}px)`;
    };

    const onDown = () => dot.classList.add('click');
    const onUp = () => dot.classList.remove('click');

    // Expanded interactive selectors
    const interactiveSelectors = 'a, button, [role="button"], input, select, textarea, label, [data-clickable="true"]';

    const addHover = (e: Event) => {
      const el = e.target as Element;
      if (el.closest(interactiveSelectors)) {
        dot.classList.add('hover');
        ring.classList.add('hover');
      }
    };

    const removeHover = (e: Event) => {
      const el = e.target as Element;
      if (el.closest(interactiveSelectors)) {
        dot.classList.remove('hover');
        ring.classList.remove('hover');
      }
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup', onUp);
    document.addEventListener('mouseover', addHover);
    document.addEventListener('mouseout', removeHover);
    animId = requestAnimationFrame(animate);

    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('mouseup', onUp);
      document.removeEventListener('mouseover', addHover);
      document.removeEventListener('mouseout', removeHover);
      cancelAnimationFrame(animId);
    };
  }, []);

  useEffect(() => {
    const stopSpace = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        const tag = (e.target as HTMLElement).tagName
        if (tag !== "INPUT" && 
            tag !== "TEXTAREA" && 
            tag !== "SELECT") {
          e.preventDefault()
        }
      }
    }
    window.addEventListener("keydown", stopSpace)
    return () => 
      window.removeEventListener("keydown", stopSpace)
  }, [])

  return (
    <BrowserRouter>
      <Toaster 
        position="top-right"
        toastOptions={{
          style: {
            background: 'rgba(255,255,255,0.92)',
            color: 'var(--text)',
            fontFamily: 'var(--font-sans)',
            border: '0.5px solid rgba(0,0,0,0.08)',
            borderRadius: '14px',
            fontSize: '15px',
            padding: '12px 18px',
            boxShadow: '0 8px 30px rgba(0,0,0,0.12)',
            backdropFilter: 'saturate(180%) blur(20px)',
          },
          success: {
            iconTheme: {
              primary: 'var(--success)',
              secondary: 'var(--success-light)',
            },
          },
          error: {
            iconTheme: {
              primary: 'var(--danger)',
              secondary: 'var(--danger-light)',
            },
          },
        }}
      />
      
      <AtlasWrapper currentPatientId={currentPatientId} />

      <ErrorBoundary>
      <Suspense fallback={<RouteFallback />}>
      <Routes>
        <Route path="/" element={<LandingPage />} />
        <Route path="/login" element={<Login />} />
        <Route path="/dashboard" element={<ProtectedRoute roles={['doctor']}><Doctor /></ProtectedRoute>} />
        <Route path="/receptionist" element={<ProtectedRoute roles={['receptionist']}><Receptionist /></ProtectedRoute>} />
        <Route path="/patients" element={<ProtectedRoute roles={['doctor']}><PatientsList /></ProtectedRoute>} />
        <Route path="/patients/add" element={<ProtectedRoute roles={['doctor']}><AddPatient /></ProtectedRoute>} />
        <Route path="/patients/:id" element={<ProtectedRoute roles={['doctor']}><PatientDetail /></ProtectedRoute>} />
        <Route path="/emergency" element={<ProtectedRoute roles={['doctor']}><Emergency /></ProtectedRoute>} />
        <Route path="/handover" element={<ProtectedRoute roles={['doctor']}><Handover /></ProtectedRoute>} />
        <Route path="/portal" element={<PatientPortal />} />
        <Route path="/patient-dashboard" element={<ProtectedRoute roles={['patient']}><PatientDashboard /></ProtectedRoute>} />
        <Route path="/scan/:velaId" element={<QRScan />} />
        <Route path="/hospital-manager" element={<ProtectedRoute roles={['hospital_manager', 'manager']}><HospitalManager /></ProtectedRoute>} />
        <Route path="/lab-controller" element={<ProtectedRoute roles={['lab_controller', 'lab']}><LabController /></ProtectedRoute>} />
        <Route path="/ward-scan" element={<ProtectedRoute roles={['doctor', 'nurse', 'receptionist', 'hospital_manager', 'manager', 'lab_controller', 'lab']}><WardScan /></ProtectedRoute>} />
        {/* VelaOwner renders its own sign-in form until an owner session exists. */}
        <Route path="/vela-owner" element={<VelaOwner />} />
        <Route path="/walkthrough" element={<ProtectedRoute roles={['hospital_manager', 'manager']}><ManagerWalkthrough /></ProtectedRoute>} />
      </Routes>
      </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  );
}

export default App;
