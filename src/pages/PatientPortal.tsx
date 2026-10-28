import { useState, useEffect, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import toast from "react-hot-toast";
import {
  Phone,
  CalendarPlus,
  ArrowLeft,
  ArrowRight,
  Loader2,
  Eye,
  EyeOff,
  MapPin,
  Check,
  AlertTriangle,
  Copy,
} from "lucide-react";
import { supabase } from "../utils/supabase";
import { API_URL } from "../utils/config";

/**
 * PATIENT PORTAL
 *
 * The person opening this page is often unwell, sometimes frightened, and may
 * never have used the app before. Three assumptions shape every decision here:
 *
 *   1. They may need help *now*. Emergency is the first thing on the page, it
 *      needs no account, and it needs no typing — one tap dials 108.
 *   2. Their next most likely goal is booking. That comes second, above
 *      sign-in, and works without an existing account: we register them
 *      quietly in the background from the details the booking already needs.
 *   3. They may not be technical. Everything is written the way a person
 *      speaks — "Sign in", not "INITIATE_VAULT_DECRYPT" — set at readable
 *      sizes, with targets big enough for an unsteady hand.
 *
 * A returning patient never sees a login form: the session persists until they
 * sign out, so the page opens straight into "Continue as …".
 */

const EMERGENCY_NUMBER = "108";

type Screen = "home" | "book" | "signin" | "register" | "booked" | "registered";

type Hospital = {
  id: string;
  name: string;
  city?: string;
  address?: string;
  distance_km?: number;
};

/** Big, legible, plainly-labelled text field. */
const Field = ({
  label,
  hint,
  className = "",
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) => (
  <label className={`block ${className}`}>
    <span className="block text-base font-medium text-ink mb-2">{label}</span>
    {hint && <span className="block text-sm text-ink-2 mb-2">{hint}</span>}
    <input
      {...props}
      className="w-full h-14 px-4 text-lg text-ink bg-white border border-line-strong rounded-xl focus:outline-none focus:border-brand focus:ring-4 focus:ring-brand/10 transition-all placeholder:text-ink-3"
    />
  </label>
);

const PatientPortal = () => {
  const navigate = useNavigate();

  const [screen, setScreen] = useState<Screen>("home");
  const [busy, setBusy] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // A session that survives closing the tab. The patient signs out explicitly
  // or stays signed in — the same way the phone app will behave.
  const [session, setSession] = useState<{ name: string; vela_id: string } | null>(null);

  const [hospitals, setHospitals] = useState<Hospital[]>([]);
  const [locating, setLocating] = useState(true);
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(null);

  const [alerting, setAlerting] = useState(false);
  const [alerted, setAlerted] = useState<{ hospital: string } | null>(null);

  const [booking, setBooking] = useState({
    problem: "",
    name: "",
    phone: "",
    age: "",
    gender: "",
    hospitalId: "",
    date: "",
    time: "",
  });
  const [bookedInfo, setBookedInfo] = useState<{ hospital: string; date: string; time: string } | null>(null);

  const [signin, setSignin] = useState({ id: "", password: "" });

  const [register, setRegister] = useState({
    name: "",
    age: "",
    gender: "",
    phone: "",
    email: "",
    password: "",
  });
  const [newVelaId, setNewVelaId] = useState("");

  /* ── Session ────────────────────────────────────────────────────── */

  useEffect(() => {
    if (localStorage.getItem("vela_auth") !== "true") return;
    if (localStorage.getItem("vela_role") !== "patient") return;
    const velaId = localStorage.getItem("vela_vela_id") || "";
    let name = "";
    try {
      name = JSON.parse(localStorage.getItem("vela_patient") || "{}")?.name || "";
    } catch {
      /* stored profile is unreadable — the ID alone still identifies them */
    }
    if (velaId) setSession({ name: name || "your account", vela_id: velaId });
  }, []);

  /* ── Where they are ─────────────────────────────────────────────── */

  const loadHospitals = useCallback(async (loc: { lat: number; lng: number } | null) => {
    try {
      const q = loc ? `?lat=${loc.lat}&lng=${loc.lng}` : "";
      const res = await axios.get(`${API_URL}/api/hospitals/search${q}`);
      if (res.data?.status === "success") setHospitals(res.data.hospitals || []);
    } catch {
      // A failed lookup must never block the emergency call, which is why the
      // 108 button never depends on this resolving.
      setHospitals([]);
    } finally {
      setLocating(false);
    }
  }, []);

  useEffect(() => {
    if (!navigator.geolocation) {
      loadHospitals(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setCoords(loc);
        loadHospitals(loc);
      },
      () => loadHospitals(null),
      { timeout: 8000, maximumAge: 300000 },
    );
  }, [loadHospitals]);

  /* ── Emergency ──────────────────────────────────────────────────── */

  /**
   * Tells the nearest VELA hospital that this patient is on their way, carrying
   * the details that matter on arrival. It reuses the same emergency ticket the
   * front desk creates for a walk-in, so the patient lands at the front of the
   * queue and reception's screen alerts — no new path to keep in sync.
   */
  const alertNearestHospital = async () => {
    if (!session || alerting) return;
    const nearest = hospitals[0];
    if (!nearest) {
      toast.error("Could not find a nearby VELA hospital — please call 108.");
      return;
    }

    setAlerting(true);
    try {
      let profile: any = {};
      try {
        profile = JSON.parse(localStorage.getItem("vela_patient") || "{}");
      } catch {
        /* fall through with an empty profile */
      }
      const details = [
        profile.blood_group ? `Blood group ${profile.blood_group}` : null,
        profile.allergies ? `Allergies: ${profile.allergies}` : null,
        profile.existing_conditions ? `Conditions: ${profile.existing_conditions}` : null,
      ]
        .filter(Boolean)
        .join(" · ");

      const res = await axios.post(`${API_URL}/api/receptionist/ticket/create`, {
        vela_id: session.vela_id,
        department: "Emergency",
        triage_level: "Emergency",
        hospital_id: nearest.id,
        notes: `PATIENT-INITIATED EMERGENCY — on their way in.${details ? ` ${details}` : ""}`,
      });

      if (res.data?.status !== "success") {
        throw new Error(res.data?.message || "Could not reach the hospital");
      }
      setAlerted({ hospital: nearest.name });
      toast.success(`${nearest.name} has been told you are coming.`);
    } catch (err: any) {
      toast.error(
        err?.response?.data?.message || err.message || "Could not reach the hospital — please call 108.",
      );
    } finally {
      setAlerting(false);
    }
  };

  /* ── Booking ────────────────────────────────────────────────────── */

  const submitBooking = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;

    if (!booking.hospitalId) return toast.error("Please choose a hospital.");
    if (!booking.date || !booking.time) return toast.error("Please choose a day and time.");

    let patientId = localStorage.getItem("vela_patient_uuid") || "";
    let velaId = session?.vela_id || "";

    if (!session) {
      if (!booking.name.trim()) return toast.error("Please enter your name.");
      if (!booking.age.trim()) return toast.error("Please enter your age.");
      if (!booking.gender) return toast.error("Please choose male, female or other.");
    }

    setBusy(true);
    try {
      // A first-time patient gets a record created from what the booking already
      // asked for. They never fill a separate registration form to see a doctor.
      if (!session) {
        const reg = await axios.post(`${API_URL}/api/patient/self-register`, {
          name: booking.name.trim(),
          age: booking.age.trim(),
          gender: booking.gender,
          phone: booking.phone.trim(),
          emergency_contact: booking.phone.trim(),
        });
        if (reg.data?.status !== "success") {
          throw new Error(reg.data?.message || "Could not create your record");
        }
        const patient = reg.data.patient;
        velaId = reg.data.vela_id || patient?.vela_id || "";
        patientId = patient?.id || "";

        // The booking call right below needs this session.
        localStorage.setItem("vela_token", reg.data.token || "");
        localStorage.setItem("vela_auth", "true");
        localStorage.setItem("vela_role", "patient");
        localStorage.setItem("vela_vela_id", velaId);
        localStorage.setItem("vela_patient", JSON.stringify(patient));
        localStorage.setItem("vela_patient_uuid", patientId);
      } else {
        try {
          patientId = JSON.parse(localStorage.getItem("vela_patient") || "{}")?.id || patientId;
        } catch {
          /* keep whatever we already had */
        }
      }

      const hospital = hospitals.find((h) => h.id === booking.hospitalId);
      const res = await axios.post(`${API_URL}/api/appointments/book`, {
        patient_id: patientId,
        hospital_id: booking.hospitalId,
        hospital_name: hospital?.name,
        hospital_address: hospital?.address || hospital?.city,
        date: booking.date,
        time: booking.time,
        notes: booking.problem.trim(),
      });
      if (res.data?.status !== "success") {
        throw new Error(res.data?.message || "Could not book the appointment");
      }

      setBookedInfo({
        hospital: hospital?.name || "the hospital",
        date: booking.date,
        time: booking.time,
      });
      if (velaId) setNewVelaId(velaId);
      setScreen("booked");
    } catch (err: any) {
      toast.error(err?.response?.data?.message || err.message || "Could not book the appointment.");
    } finally {
      setBusy(false);
    }
  };

  /* ── Sign in ────────────────────────────────────────────────────── */

  const submitSignin = async (e: React.FormEvent) => {
    e.preventDefault();
    const identifier = signin.id.trim();
    if (!identifier || !signin.password) {
      toast.error("Please enter your ID and password.");
      return;
    }
    setBusy(true);
    try {
      // Patient records don't carry a password — sign-in is by email through
      // Supabase Auth. A VELA ID isn't an email, so there's nothing to check
      // it against; point the patient at the right field instead of a
      // silent/always-failing password check.
      if (/^VLA-/i.test(identifier)) {
        throw new Error("Sign in with the email you registered with, not your VELA ID.");
      }

      // The backend checks the password with Supabase Auth and only then
      // issues a session for the record with that email.
      const res = await axios.post(`${API_URL}/api/patient/login`, {
        email: identifier,
        password: signin.password,
      });
      const patient = res.data?.patient;
      if (res.data?.status !== "success" || !patient) {
        throw new Error(res.data?.message || "We could not find an account with those details.");
      }

      localStorage.setItem("vela_token", res.data.token || "");
      localStorage.setItem("vela_auth", "true");
      localStorage.setItem("vela_role", "patient");
      localStorage.setItem("vela_vela_id", patient.vela_id);
      localStorage.setItem("vela_patient", JSON.stringify(patient));
      localStorage.setItem("vela_patient_uuid", patient.id || "");
      localStorage.setItem("vela_email", identifier);
      navigate("/patient-dashboard");
    } catch (err: any) {
      toast.error(err?.response?.data?.message || err.message || "Could not sign you in.");
    } finally {
      setBusy(false);
    }
  };

  const resetPassword = async () => {
    if (!signin.id.includes("@")) {
      toast.error("Enter your email address first, then tap this again.");
      return;
    }
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(signin.id.trim(), {
        redirectTo: `${window.location.origin}/portal`,
      });
      if (error) throw new Error(error.message);
      toast.success("We've emailed you a link to set a new password.");
    } catch (err: any) {
      toast.error(err.message || "Could not send the reset link.");
    }
  };

  /* ── Register ───────────────────────────────────────────────────── */

  const submitRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!register.name.trim() || !register.age.trim() || !register.gender) {
      toast.error("Please fill in your name, age and gender.");
      return;
    }
    if (register.password.length < 8) {
      toast.error("Please choose a password of at least 8 characters.");
      return;
    }
    setBusy(true);
    try {
      if (register.email.trim()) {
        const { error } = await supabase.auth.signUp({
          email: register.email.trim(),
          password: register.password,
          options: { data: { name: register.name.trim(), role: "patient" } },
        });
        if (error) throw new Error(error.message);
      }

      const res = await axios.post(`${API_URL}/api/patient/self-register`, {
        name: register.name.trim(),
        age: register.age.trim(),
        gender: register.gender,
        phone: register.phone.trim(),
        email: register.email.trim(),
        emergency_contact: register.phone.trim(),
      });
      if (res.data?.code === "email_exists") {
        throw new Error("You already have a VELA record with this email. Please sign in instead.");
      }
      const velaId = res.data?.vela_id || res.data?.patient?.vela_id;
      if (!velaId) throw new Error(res.data?.message || "Could not create your account");

      localStorage.setItem("vela_token", res.data.token || "");
      localStorage.setItem("vela_auth", "true");
      localStorage.setItem("vela_role", "patient");
      localStorage.setItem("vela_vela_id", velaId);
      localStorage.setItem("vela_patient", JSON.stringify(res.data.patient));
      localStorage.setItem("vela_patient_uuid", res.data.patient?.id || "");
      localStorage.setItem("vela_email", register.email.trim());

      setNewVelaId(velaId);
      setScreen("registered");
    } catch (err: any) {
      toast.error(err?.response?.data?.message || err.message || "Could not create your account.");
    } finally {
      setBusy(false);
    }
  };

  /* ── Shared pieces ──────────────────────────────────────────────── */

  const BackButton = ({ to = "home" as Screen }) => (
    <button
      type="button"
      onClick={() => setScreen(to)}
      className="inline-flex items-center gap-2 h-12 px-4 -ml-4 text-base text-ink-2 hover:text-ink transition-colors"
    >
      <ArrowLeft size={20} /> Back
    </button>
  );

  const GenderChoice = ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (v: string) => void;
  }) => (
    <div>
      <span className="block text-base font-medium text-ink mb-2">Gender</span>
      <div className="grid grid-cols-3 gap-3">
        {["Male", "Female", "Other"].map((g) => (
          <button
            key={g}
            type="button"
            onClick={() => onChange(g)}
            className={`h-14 rounded-xl border text-base font-medium transition-all ${
              value === g
                ? "bg-brand text-white border-brand"
                : "bg-white text-ink border-line-strong hover:border-brand"
            }`}
          >
            {g}
          </button>
        ))}
      </div>
    </div>
  );

  const VelaIdCard = ({ id }: { id: string }) => (
    <div className="bg-brand-tint border border-brand-soft rounded-2xl p-6 text-left">
      <p className="text-sm text-ink-2 mb-1">Your VELA health ID</p>
      <p className="text-3xl font-mono font-bold text-brand tracking-wide mb-3">{id}</p>
      <p className="text-sm text-ink-2 leading-relaxed mb-4">
        Show this at any VELA hospital and they'll have your records. Keep it somewhere safe.
      </p>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(id);
          toast.success("Copied");
        }}
        className="inline-flex items-center gap-2 h-11 px-4 bg-white border border-brand-soft rounded-xl text-base text-brand font-medium hover:bg-white/60 transition-colors"
      >
        <Copy size={16} /> Copy
      </button>
    </div>
  );

  /* ── Screens ────────────────────────────────────────────────────── */

  const renderEmergency = () => (
    <section className="bg-danger-tint border border-danger-soft rounded-2xl p-6 sm:p-8">
      <div className="flex items-start gap-3 mb-5">
        <AlertTriangle className="text-danger shrink-0 mt-0.5" size={24} />
        <div>
          <h2 className="text-2xl font-semibold text-ink leading-tight">Need help right now?</h2>
          <p className="text-base text-ink-2 mt-1">
            If this is serious — chest pain, bleeding, trouble breathing, an accident — call first.
          </p>
        </div>
      </div>

      <a
        href={`tel:${EMERGENCY_NUMBER}`}
        className="flex items-center justify-center gap-3 w-full h-16 bg-danger text-white rounded-xl text-xl font-semibold hover:brightness-95 active:scale-[0.99] transition-all"
      >
        <Phone size={24} /> Call {EMERGENCY_NUMBER} now
      </a>

      {session && (
        <>
          {alerted ? (
            <div className="flex items-center gap-3 mt-4 p-4 bg-white border border-success-soft rounded-xl">
              <Check className="text-success shrink-0" size={22} />
              <p className="text-base text-ink">
                <strong>{alerted.hospital}</strong> knows you're coming. Go straight there — you won't
                need to queue.
              </p>
            </div>
          ) : (
            <button
              type="button"
              onClick={alertNearestHospital}
              disabled={alerting || !hospitals.length}
              className="flex items-center justify-center gap-3 w-full h-16 mt-4 bg-white text-danger border border-danger rounded-xl text-lg font-semibold hover:bg-white/60 disabled:opacity-50 transition-all"
            >
              {alerting ? (
                <>
                  <Loader2 size={22} className="animate-spin" /> Telling them…
                </>
              ) : (
                <>Tell {hospitals[0]?.name || "the nearest hospital"} I'm coming</>
              )}
            </button>
          )}
        </>
      )}

      {!!hospitals.length && (
        <div className="mt-6">
          <p className="text-sm font-medium text-ink-2 mb-3">
            {coords ? "Hospitals closest to you" : "VELA hospitals"}
          </p>
          <ul className="space-y-2">
            {hospitals.slice(0, 3).map((h) => (
              <li
                key={h.id}
                className="flex items-center justify-between gap-4 p-4 bg-white border border-line rounded-xl"
              >
                <span className="min-w-0">
                  <span className="block text-base font-medium text-ink truncate">{h.name}</span>
                  <span className="block text-sm text-ink-2 truncate">{h.address || h.city}</span>
                </span>
                {typeof h.distance_km === "number" && (
                  <span className="shrink-0 text-base font-semibold text-ink-2 tabular-nums">
                    {h.distance_km} km
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );

  const renderHome = () => (
    <div className="space-y-6">
      {renderEmergency()}

      <section>
        <button
          type="button"
          onClick={() => {
            if (session) {
              try {
                const p = JSON.parse(localStorage.getItem("vela_patient") || "{}");
                setBooking((b) => ({
                  ...b,
                  name: p.name || "",
                  phone: p.phone || "",
                  age: String(p.age ?? ""),
                  gender: p.gender || "",
                }));
              } catch {
                /* an empty form still works */
              }
            }
            setScreen("book");
          }}
          className="w-full flex items-center justify-between gap-4 p-6 sm:p-8 bg-brand text-white rounded-2xl hover:brightness-105 active:scale-[0.995] transition-all text-left"
        >
          <span>
            <span className="flex items-center gap-3 text-2xl font-semibold mb-1">
              <CalendarPlus size={26} /> Book an appointment
            </span>
            <span className="block text-base text-white/80">
              See a doctor. Takes about a minute — no account needed.
            </span>
          </span>
          <ArrowRight size={26} className="shrink-0" />
        </button>
      </section>

      <section className="bg-white border border-line rounded-2xl p-6 sm:p-8">
        {session ? (
          <>
            <h2 className="text-xl font-semibold text-ink mb-1">Welcome back, {session.name}</h2>
            <p className="text-base text-ink-2 mb-5">
              Your records, medicines and appointments are ready.
            </p>
            <button
              type="button"
              onClick={() => navigate("/patient-dashboard")}
              className="w-full h-14 bg-ink text-white rounded-xl text-lg font-semibold hover:brightness-125 transition-all"
            >
              Continue
            </button>
            <button
              type="button"
              onClick={() => {
                localStorage.clear();
                setSession(null);
                setAlerted(null);
                toast.success("Signed out");
              }}
              className="w-full h-12 mt-2 text-base text-ink-2 hover:text-ink transition-colors"
            >
              Not you? Sign out
            </button>
          </>
        ) : (
          <>
            <h2 className="text-xl font-semibold text-ink mb-1">Been here before?</h2>
            <p className="text-base text-ink-2 mb-5">
              Sign in to see your records, test results and medicines.
            </p>
            <button
              type="button"
              onClick={() => setScreen("signin")}
              className="w-full h-14 bg-white text-ink border border-line-strong rounded-xl text-lg font-semibold hover:border-brand hover:text-brand transition-all"
            >
              Sign in
            </button>
            <button
              type="button"
              onClick={() => setScreen("register")}
              className="w-full h-12 mt-2 text-base text-brand font-medium hover:underline"
            >
              Create an account instead
            </button>
          </>
        )}
      </section>
    </div>
  );

  const renderBook = () => (
    <div>
      <BackButton />
      <h1 className="text-3xl sm:text-4xl font-semibold text-ink mt-4 mb-2">Book an appointment</h1>
      <p className="text-lg text-ink-2 mb-8">
        {session ? "We've filled in what we already know." : "We only need a few details."}
      </p>

      <form onSubmit={submitBooking} className="space-y-8">
        <div>
          <label className="block">
            <span className="block text-xl font-semibold text-ink mb-2">What's the problem?</span>
            <span className="block text-base text-ink-2 mb-3">
              In your own words. The doctor sees this before you arrive.
            </span>
            <textarea
              value={booking.problem}
              onChange={(e) => setBooking({ ...booking, problem: e.target.value })}
              rows={3}
              placeholder="For example: stomach pain since yesterday, and fever"
              className="w-full p-4 text-lg text-ink bg-white border border-line-strong rounded-xl focus:outline-none focus:border-brand focus:ring-4 focus:ring-brand/10 transition-all resize-none placeholder:text-ink-3"
            />
          </label>
        </div>

        {!session && (
          <div className="space-y-6 pt-2 border-t border-line">
            <h2 className="text-xl font-semibold text-ink pt-6">About you</h2>
            <Field
              label="Your name"
              value={booking.name}
              onChange={(e) => setBooking({ ...booking, name: e.target.value })}
              autoComplete="name"
            />
            <div className="grid grid-cols-2 gap-4">
              <Field
                label="Age"
                inputMode="numeric"
                value={booking.age}
                onChange={(e) => setBooking({ ...booking, age: e.target.value.replace(/\D/g, "") })}
              />
              <Field
                label="Phone"
                type="tel"
                value={booking.phone}
                onChange={(e) => setBooking({ ...booking, phone: e.target.value })}
                autoComplete="tel"
              />
            </div>
            <GenderChoice
              value={booking.gender}
              onChange={(g) => setBooking({ ...booking, gender: g })}
            />
          </div>
        )}

        <div className="pt-2 border-t border-line">
          <h2 className="text-xl font-semibold text-ink pt-6 mb-4">Where would you like to go?</h2>
          {locating ? (
            <p className="text-base text-ink-2 py-4">Finding hospitals near you…</p>
          ) : !hospitals.length ? (
            <p className="text-base text-ink-2 py-4">
              We couldn't load the hospital list. Please check your connection and try again.
            </p>
          ) : (
            <ul className="space-y-3">
              {hospitals.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    onClick={() => setBooking({ ...booking, hospitalId: h.id })}
                    className={`w-full flex items-center justify-between gap-4 p-5 rounded-xl border text-left transition-all ${
                      booking.hospitalId === h.id
                        ? "bg-brand-tint border-brand"
                        : "bg-white border-line-strong hover:border-brand"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block text-lg font-medium text-ink truncate">{h.name}</span>
                      <span className="flex items-center gap-1.5 text-base text-ink-2 truncate">
                        <MapPin size={15} className="shrink-0" />
                        {h.address || h.city}
                      </span>
                    </span>
                    <span className="flex items-center gap-3 shrink-0">
                      {typeof h.distance_km === "number" && (
                        <span className="text-base font-semibold text-ink-2 tabular-nums">
                          {h.distance_km} km
                        </span>
                      )}
                      {booking.hospitalId === h.id && (
                        <span className="w-7 h-7 rounded-full bg-brand text-white flex items-center justify-center">
                          <Check size={16} />
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="pt-2 border-t border-line">
          <h2 className="text-xl font-semibold text-ink pt-6 mb-4">When suits you?</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field
              label="Day"
              type="date"
              min={new Date().toISOString().split("T")[0]}
              value={booking.date}
              onChange={(e) => setBooking({ ...booking, date: e.target.value })}
            />
            <div>
              <span className="block text-base font-medium text-ink mb-2">Time</span>
              <div className="grid grid-cols-3 gap-2">
                {["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"].map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setBooking({ ...booking, time: t })}
                    className={`h-14 rounded-xl border text-base font-medium transition-all ${
                      booking.time === t
                        ? "bg-brand text-white border-brand"
                        : "bg-white text-ink border-line-strong hover:border-brand"
                    }`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <button
          type="submit"
          disabled={busy}
          className="w-full h-16 bg-brand text-white rounded-xl text-xl font-semibold hover:brightness-105 disabled:opacity-60 transition-all flex items-center justify-center gap-3"
        >
          {busy ? (
            <>
              <Loader2 size={24} className="animate-spin" /> Booking…
            </>
          ) : (
            "Book my appointment"
          )}
        </button>
      </form>
    </div>
  );

  const renderBooked = () => (
    <div className="text-center">
      <div className="w-20 h-20 rounded-full bg-success-tint border border-success-soft flex items-center justify-center mx-auto mb-6">
        <Check className="text-success" size={40} />
      </div>
      <h1 className="text-3xl sm:text-4xl font-semibold text-ink mb-3">You're booked</h1>
      <p className="text-lg text-ink-2 mb-8 leading-relaxed">
        {bookedInfo?.hospital} on <strong className="text-ink">{bookedInfo?.date}</strong> at{" "}
        <strong className="text-ink">{bookedInfo?.time}</strong>. The hospital will confirm shortly —
        arrive about ten minutes early.
      </p>

      {newVelaId && (
        <div className="mb-8">
          <VelaIdCard id={newVelaId} />
        </div>
      )}

      <button
        type="button"
        onClick={() => navigate("/patient-dashboard")}
        className="w-full h-16 bg-brand text-white rounded-xl text-xl font-semibold hover:brightness-105 transition-all"
      >
        See my appointment
      </button>
      <button
        type="button"
        onClick={() => setScreen("home")}
        className="w-full h-12 mt-2 text-base text-ink-2 hover:text-ink transition-colors"
      >
        Back to start
      </button>
    </div>
  );

  const renderSignin = () => (
    <div>
      <BackButton />
      <h1 className="text-3xl sm:text-4xl font-semibold text-ink mt-4 mb-2">Sign in</h1>
      <p className="text-lg text-ink-2 mb-8">We'll keep you signed in on this device.</p>

      <form onSubmit={submitSignin} className="space-y-6">
        <Field
          label="Email or VELA ID"
          hint="Your VELA ID looks like VLA-1234"
          value={signin.id}
          onChange={(e) => setSignin({ ...signin, id: e.target.value })}
          autoComplete="username"
        />

        <div>
          <span className="block text-base font-medium text-ink mb-2">Password</span>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={signin.password}
              onChange={(e) => setSignin({ ...signin, password: e.target.value })}
              autoComplete="current-password"
              className="w-full h-14 px-4 pr-14 text-lg text-ink bg-white border border-line-strong rounded-xl focus:outline-none focus:border-brand focus:ring-4 focus:ring-brand/10 transition-all"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-1 top-1 w-12 h-12 flex items-center justify-center text-ink-2 hover:text-ink transition-colors"
            >
              {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
          <button
            type="button"
            onClick={resetPassword}
            className="mt-3 h-11 text-base text-brand font-medium hover:underline"
          >
            I've forgotten my password
          </button>
        </div>

        <button
          type="submit"
          disabled={busy}
          className="w-full h-16 bg-brand text-white rounded-xl text-xl font-semibold hover:brightness-105 disabled:opacity-60 transition-all flex items-center justify-center gap-3"
        >
          {busy ? <Loader2 size={24} className="animate-spin" /> : "Sign in"}
        </button>
      </form>

      <button
        type="button"
        onClick={() => setScreen("register")}
        className="w-full h-12 mt-6 text-base text-ink-2 hover:text-ink transition-colors"
      >
        I don't have an account yet
      </button>
    </div>
  );

  const renderRegister = () => (
    <div>
      <BackButton />
      <h1 className="text-3xl sm:text-4xl font-semibold text-ink mt-4 mb-2">Create your account</h1>
      <p className="text-lg text-ink-2 mb-8">
        Just the basics. You can add your blood group, allergies and medical history later — or let
        the hospital add them for you.
      </p>

      <form onSubmit={submitRegister} className="space-y-6">
        <Field
          label="Your name"
          value={register.name}
          onChange={(e) => setRegister({ ...register, name: e.target.value })}
          autoComplete="name"
        />
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Age"
            inputMode="numeric"
            value={register.age}
            onChange={(e) => setRegister({ ...register, age: e.target.value.replace(/\D/g, "") })}
          />
          <Field
            label="Phone"
            type="tel"
            value={register.phone}
            onChange={(e) => setRegister({ ...register, phone: e.target.value })}
            autoComplete="tel"
          />
        </div>
        <GenderChoice
          value={register.gender}
          onChange={(g) => setRegister({ ...register, gender: g })}
        />
        <Field
          label="Email"
          hint="So you can sign in and reset your password"
          type="email"
          value={register.email}
          onChange={(e) => setRegister({ ...register, email: e.target.value })}
          autoComplete="email"
        />
        <div>
          <span className="block text-base font-medium text-ink mb-2">Choose a password</span>
          <span className="block text-sm text-ink-2 mb-2">At least 8 characters</span>
          <div className="relative">
            <input
              type={showPassword ? "text" : "password"}
              value={register.password}
              onChange={(e) => setRegister({ ...register, password: e.target.value })}
              autoComplete="new-password"
              className="w-full h-14 px-4 pr-14 text-lg text-ink bg-white border border-line-strong rounded-xl focus:outline-none focus:border-brand focus:ring-4 focus:ring-brand/10 transition-all"
            />
            <button
              type="button"
              onClick={() => setShowPassword(!showPassword)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-1 top-1 w-12 h-12 flex items-center justify-center text-ink-2 hover:text-ink transition-colors"
            >
              {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
            </button>
          </div>
        </div>

        <button
          type="submit"
          disabled={busy}
          className="w-full h-16 bg-brand text-white rounded-xl text-xl font-semibold hover:brightness-105 disabled:opacity-60 transition-all flex items-center justify-center gap-3"
        >
          {busy ? <Loader2 size={24} className="animate-spin" /> : "Create my account"}
        </button>
      </form>
    </div>
  );

  const renderRegistered = () => (
    <div className="text-center">
      <div className="w-20 h-20 rounded-full bg-success-tint border border-success-soft flex items-center justify-center mx-auto mb-6">
        <Check className="text-success" size={40} />
      </div>
      <h1 className="text-3xl sm:text-4xl font-semibold text-ink mb-3">You're all set</h1>
      <p className="text-lg text-ink-2 mb-8">This is your health ID. You'll only need it once.</p>

      <div className="mb-8">
        <VelaIdCard id={newVelaId} />
      </div>

      <button
        type="button"
        onClick={() => navigate("/patient-dashboard")}
        className="w-full h-16 bg-brand text-white rounded-xl text-xl font-semibold hover:brightness-105 transition-all"
      >
        Continue
      </button>
    </div>
  );

  /* ── Shell ──────────────────────────────────────────────────────── */

  return (
    <div className="min-h-screen bg-canvas text-ink font-sans">
      <header className="border-b border-line bg-white">
        <div className="max-w-[640px] mx-auto px-5 h-20 flex items-center gap-3">
          <img src="/vela-icon.png" alt="" className="h-8 w-auto" />
          <span className="text-xl font-semibold text-ink">VELA</span>
        </div>
      </header>

      <main className="max-w-[640px] mx-auto px-5 py-8 sm:py-12 pb-24">
        {screen === "home" && renderHome()}
        {screen === "book" && renderBook()}
        {screen === "booked" && renderBooked()}
        {screen === "signin" && renderSignin()}
        {screen === "register" && renderRegister()}
        {screen === "registered" && renderRegistered()}
      </main>

      {screen !== "home" && screen !== "booked" && screen !== "registered" && (
        <div className="fixed bottom-0 inset-x-0 border-t border-line bg-white">
          <div className="max-w-[640px] mx-auto px-5 py-3">
            <a
              href={`tel:${EMERGENCY_NUMBER}`}
              className="flex items-center justify-center gap-2 h-12 text-base font-semibold text-danger"
            >
              <Phone size={18} /> Emergency? Call {EMERGENCY_NUMBER}
            </a>
          </div>
        </div>
      )}
    </div>
  );
};

export default PatientPortal;
