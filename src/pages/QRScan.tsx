import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import { Loader2, ArrowLeft } from "lucide-react";
import { API_URL } from "../utils/config";
import toast from "react-hot-toast";

const QRScan = () => {
  const { velaId } = useParams<{ velaId: string }>();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [patient, setPatient] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const fetchQR = async () => {
      try {
        const res = await axios.get(`${API_URL}/api/patient/qr/${velaId}`);
        if (res.data.status === "success") {
          setPatient(res.data.patient);
        } else {
          setError("This VELA ID was not found");
        }
      } catch (err: any) {
        if (err.response?.status === 404) {
             setError("This VELA ID was not found");
        } else {
             setError("Invalid QR code or network error");
        }
      } finally {
        setLoading(false);
      }
    };
    if (velaId) fetchQR();
  }, [velaId]);

  const handleAddToPatients = async () => {
    const role = localStorage.getItem("vela_role");
    if (role === "receptionist" || role === "doctor") {
      try {
        await axios.post(`${API_URL}/api/receptionist/ticket/create`, {
          vela_id: velaId,
          department: "General"
        });
        toast.success("Patient added to queue!");
        navigate("/receptionist");
      } catch (err) {
        toast.error("Failed to add patient to queue");
      }
    } else {
      toast("Please login as a staff member first");
      localStorage.setItem("vela_pending_scan_action", velaId || "");
      navigate("/login");
    }
  };

  const handleSelfLogin = () => {
    navigate("/portal");
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-canvas flex flex-col items-center justify-center font-sans tracking-wide">
        <img src="/vela-icon.png" alt="VELA" className="h-10 mb-6 animate-pulse" />
        <Loader2 className="animate-spin text-ink mb-4" size={32} />
        <p className="text-ink font-mono text-[11px] uppercase tracking-widest">Loading patient profile...</p>
      </div>
    );
  }

  if (error || !patient) {
    return (
      <div className="min-h-screen bg-canvas flex flex-col items-center justify-center text-center px-4">
        <h1 className="font-serif text-3xl text-ink mb-2">Invalid QR Code</h1>
        <p className="text-ink-2 mb-8">{error}</p>
        <button onClick={() => navigate("/")} className="flex items-center gap-2 text-brand font-medium uppercase text-sm tracking-wide bg-white px-6 py-3 rounded-md hover:bg-surface-2 transition-colors">
          <ArrowLeft size={16} /> Return Home
        </button>
      </div>
    );
  }

  const allergiesArray = patient.allergies ? patient.allergies.split(",").map((s: string) => s.trim()).filter((s: string) => s) : [];

  return (
    <div className="min-h-screen bg-canvas font-sans flex flex-col justify-center items-center py-6 px-4 relative">
      <div className="w-full max-w-lg relative z-10 flex flex-col gap-6">
        
        {/* TOP SECTION */}
        <div className="text-center">
            <img src="/vela-icon.png" alt="VELA" className="h-6 mx-auto mb-3" />
            <h1 className="font-mono text-[11px] text-ink tracking-[0.2em] mb-4">VELA HEALTH PROFILE</h1>
            <h2 className="font-serif italic text-5xl md:text-6xl text-ink tracking-widest mb-1">{patient.vela_id}</h2>
            <p className="font-light text-[20px] text-ink">{patient.name}</p>
        </div>

        {/* CRITICAL INFO GRID */}
        <div className="grid grid-cols-2 gap-4 mt-4">
           {patient.blood_group && (
             <div className="bg-white border border-black/15 rounded-xl p-5 flex flex-col justify-center items-center">
                <span className="font-mono text-[9px] uppercase tracking-widest text-ink-2 mb-1">Blood Type</span>
                <span className="font-serif text-4xl text-ink">{patient.blood_group}</span>
             </div>
           )}
           <div className="bg-white border border-black/15 rounded-xl p-5 flex flex-col justify-center items-center">
              <span className="font-mono text-[9px] uppercase tracking-widest text-ink-2 mb-1">Demographics</span>
              <span className="font-sans font-medium text-lg text-ink">{patient.age}yrs • {patient.gender}</span>
           </div>
        </div>

        {/* ALLERGIES */}
        <div className="bg-danger-tint border border-danger-soft rounded-xl p-5">
           <span className="font-mono text-[11px] uppercase tracking-widest text-danger block mb-3">Allergies</span>
           {allergiesArray.length > 0 ? (
               <div className="flex flex-wrap gap-2">
                 {allergiesArray.map((a: string, i: number) => (
                    <span key={i} className="bg-danger-tint border border-danger-soft text-danger px-3 py-1 rounded-full text-xs font-medium">
                       {a}
                    </span>
                 ))}
               </div>
           ) : (
               <span className="text-ink-2 text-sm italic">None recorded</span>
           )}
        </div>

        {/* CONDITIONS */}
        {patient.existing_conditions && (
          <div className="bg-white border border-black/10 rounded-xl p-5">
              <span className="font-mono text-[11px] uppercase tracking-widest text-ink-2 block mb-2">Existing Conditions</span>
              <p className="text-ink text-sm leading-relaxed">{patient.existing_conditions}</p>
          </div>
        )}

        {/* EMERGENCY CONTACT */}
        <div className="bg-surface-2 rounded-xl p-5 mt-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-ink-2 block mb-3">Emergency Contact</span>
            <div className="flex flex-col mb-4">
                <span className="font-semibold text-lg text-ink">{patient.emergency_contact_name || "Not provided"}</span>
                {patient.emergency_contact_relation && <span className="font-light text-sm text-ink-2">{patient.emergency_contact_relation}</span>}
            </div>
            {patient.emergency_contact_phone && (
               <div className="flex items-center justify-between">
                  <span className="font-mono text-base text-ink tracking-wider">{patient.emergency_contact_phone}</span>
                  <a href={`tel:${patient.emergency_contact_phone}`} className="bg-brand text-white px-4 py-2 rounded-lg font-bold text-xs uppercase tracking-wider hover:scale-105 transition-transform">
                     Call Now
                  </a>
               </div>
            )}
        </div>

        {/* ACTIONS */}
        <div className="flex flex-col gap-3 mt-6">
            <button 
               onClick={handleAddToPatients}
               className="w-full bg-brand hover:bg-brand-dark text-white py-4 rounded-xl font-medium text-sm transition-colors"
            >
                Add to My Patients
            </button>
            <button 
               onClick={handleSelfLogin}
               className="w-full bg-transparent hover:bg-white border border-line-strong text-ink py-4 rounded-xl font-medium text-sm transition-colors"
            >
                This is me — Login
            </button>
        </div>

      </div>
    </div>
  );
};

export default QRScan;
