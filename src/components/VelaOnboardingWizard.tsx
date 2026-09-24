import { useState, useRef, useEffect } from 'react';
import { gsap } from 'gsap';
import confetti from 'canvas-confetti';
import { API_URL } from '../utils/config';
import toast from 'react-hot-toast';

const SPECIALIZATIONS = [
  'General Medicine', 'Cardiology', 'Orthopedics', 'Pediatrics',
  'Gynecology', 'Neurology', 'Dermatology', 'Ophthalmology',
  'ENT', 'Emergency/Trauma', 'Oncology', 'Psychiatry'
];

interface Props {
  initialData?: any;
  onboarderName: string;
  onClose: () => void;
  isManagerSetup?: boolean;
}

export default function VelaOnboardingWizard({ initialData, onboarderName, onClose, isManagerSetup }: Props) {
  const [step, setStep] = useState(1);
  const [form, setForm] = useState({
    name: initialData?.name || '',
    address: initialData?.address || '',
    city: initialData?.city || '',
    state: initialData?.state || '',
    phone: initialData?.phone || '',
    email: initialData?.email || '',
    total_beds: 100,
    latitude: initialData?.lat || null,
    longitude: initialData?.lng || null,
    mapbox_place_id: initialData?.place_id || '',
    manager_name: '',
  });
  const [selectedSpecs, setSelectedSpecs] = useState<string[]>([]);
  const [credentials, setCredentials] = useState<any>(null);
  const [confirmSteps, setConfirmSteps] = useState<string[]>([]);
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const stepRef = useRef<HTMLDivElement>(null);

  const animateStep = () => {
    if (stepRef.current) {
      gsap.fromTo(stepRef.current, { opacity: 0, x: 60 }, { opacity: 1, x: 0, duration: 0.5, ease: 'power3.out' });
    }
  };

  useEffect(() => { animateStep(); }, [step]);

  const nextStep = () => setStep(s => Math.min(s + 1, 5));
  const prevStep = () => setStep(s => Math.max(s - 1, 1));

  const toggleSpec = (s: string) => {
    setSelectedSpecs(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);
  };

  const slugFromName = (name: string) => {
    return name.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-').replace('hospital', '').replace('--', '-').replace(/^-|-$/g, '').slice(0, 15) || 'hospital';
  };

  const previewEmail = form.manager_name
    ? `manager@${slugFromName(form.name)}.vela.health`
    : 'manager@hospital.vela.health';

  const runManagerSetup = async () => {
    const steps = [
      'Configuring facility parameters...',
      'Mapping clinical specializations...',
      'Syncing with Vela Command Center...',
      'Updating hospital profile...',
      'Setup finalized!',
    ];
    for (let i = 0; i < steps.length; i++) {
        await new Promise(r => setTimeout(r, 600));
        setConfirmSteps(prev => [...prev, steps[i]]);
    }
    try {
        const res = await fetch(`${API_URL}/api/hospital/setup/complete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                hospital_id: initialData?.id,
                specializations: selectedSpecs,
                total_beds: form.total_beds
            })
        });
        const data = await res.json();
        if (data.status === 'success') {
            setStep(5);
            setTimeout(() => {
                confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 }, colors: ['#0071E3', '#0071E3', '#1D1D1F', '#248A3D'] });
            }, 300);
        } else {
            toast.error(data.message || 'Setup failed');
        }
    } catch {
        toast.error('Connection failed');
    }
  };

  const runOnboarding = async () => {
    const steps = [
      'Creating hospital profile...',
      'Setting up dashboards...',
      'Generating credentials...',
      'Connecting to Vela network...',
      'Going live...',
    ];
    for (let i = 0; i < steps.length; i++) {
      await new Promise(r => setTimeout(r, 600));
      setConfirmSteps(prev => [...prev, steps[i]]);
    }
    try {
      const res = await fetch(`${API_URL}/api/owner/onboard-hospital`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, specializations: selectedSpecs, manager_name: onboarderName })
      });
      const data = await res.json();
      if (data.status === 'success') {
        setCredentials(data);
        setStep(5);
        setTimeout(() => {
          confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 }, colors: ['#0071E3', '#0071E3', '#1D1D1F', '#248A3D'] });
        }, 300);
      } else {
        toast.error(data.message || 'Onboarding failed');
      }
    } catch {
      toast.error('Backend not reachable');
    }
  };

  const copy = (val: string, key: string) => {
    navigator.clipboard.writeText(val);
    setCopiedField(key);
    setTimeout(() => setCopiedField(null), 1500);
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'var(--bg)', zIndex: 9999, display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-sans)' }}>
      {/* Header */}
      <div style={{ padding: '24px 48px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {[1,2,3,4,5].filter(i => !(isManagerSetup && i === 3)).map((i) => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: i === step ? 'var(--brand)' : i < step ? 'var(--success)' : 'rgba(0,0,0,0.12)', transition: 'all 0.3s', boxShadow: i === step ? '0 0 8px rgba(0,113,227,0.6)' : 'none' }} />
          ))}
        </div>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Step {step === 5 ? (isManagerSetup ? 4 : 5) : step} of {isManagerSetup ? 4 : 5}</div>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          {isManagerSetup && step < 4 && (
            <button type="button" onClick={onClose} style={{ background: 'rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 8, padding: '8px 16px', color: 'var(--text-secondary)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 12 }}>
              Skip for now
            </button>
          )}
          <button type="button" onClick={onClose} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em' }}>✕ Close</button>
        </div>
      </div>

      {/* Content */}
      <div ref={stepRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px', overflowY: 'auto' }}>

        {step === 1 && (
          <div style={{ maxWidth: 560, width: '100%' }}>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 48, color: 'var(--text)', marginBottom: 8 }}>{form.name || 'Hospital Details'}</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 32, fontSize: 16 }}>Confirm and complete the hospital information.</p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {[
                { label: 'Hospital Name', key: 'name', placeholder: 'Apollo Hospital Hyderabad' },
                { label: 'Address', key: 'address', placeholder: 'Jubilee Hills, Hyderabad' },
                { label: 'City', key: 'city', placeholder: 'Hyderabad' },
                { label: 'State', key: 'state', placeholder: 'Telangana' },
                { label: 'Phone', key: 'phone', placeholder: '+91 40 2360 7777' },
                { label: 'Email', key: 'email', placeholder: 'info@apollo.com' },
              ].map(({ label, key, placeholder }) => (
                <div key={key}>
                  <label style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 6 }}>{label}</label>
                  <input value={(form as any)[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))} placeholder={placeholder}
                    style={{ width: '100%', background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 8, padding: '12px 16px', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
                </div>
              ))}
              <div>
                <label style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 6 }}>Total Beds: {form.total_beds}</label>
                <input type="range" min={10} max={500} value={form.total_beds} onChange={e => setForm(f => ({ ...f, total_beds: Number(e.target.value) }))}
                  style={{ width: '100%', accentColor: 'var(--brand)' }} />
              </div>
            </div>
            <button type="button" onClick={nextStep} disabled={!form.name || !form.address}
              style={{ marginTop: 32, background: 'var(--brand)', color: '#FFFFFF', border: 'none', borderRadius: 10, padding: '14px 32px', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 15, cursor: 'pointer', opacity: !form.name || !form.address ? 0.5 : 1 }}>
              Looks correct →
            </button>
          </div>
        )}

        {step === 2 && (
          <div style={{ maxWidth: 600, width: '100%' }}>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 40, color: 'var(--text)', marginBottom: 8 }}>What does this hospital offer?</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 32 }}>Select all specializations available at this hospital.</p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 32 }}>
              {SPECIALIZATIONS.map((s, i) => {
                const selected = selectedSpecs.includes(s);
                return (
                  <button key={s} type="button" onClick={() => toggleSpec(s)}
                    style={{ padding: '10px 18px', borderRadius: 100, border: `1px solid ${selected ? 'var(--brand)' : 'rgba(0,0,0,0.12)'}`, background: selected ? 'rgba(0,113,227,0.12)' : 'transparent', color: selected ? 'var(--brand)' : 'var(--text-secondary)', fontFamily: 'var(--font-sans)', fontSize: 13, cursor: 'pointer', transition: 'all 0.2s', fontWeight: selected ? 600 : 400, animationDelay: `${i * 0.05}s` }}>
                    {s}
                  </button>
                );
              })}
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button type="button" onClick={prevStep} style={{ background: 'rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 10, padding: '12px 24px', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 14, cursor: 'pointer' }}>← Back</button>
              <button type="button" onClick={() => {
                  if (isManagerSetup) {
                      setStep(4);
                      runManagerSetup();
                  } else {
                      nextStep();
                  }
                }} disabled={selectedSpecs.length === 0}
                style={{ background: 'var(--brand)', color: '#FFFFFF', border: 'none', borderRadius: 10, padding: '12px 32px', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 14, cursor: 'pointer', opacity: selectedSpecs.length === 0 ? 0.5 : 1 }}>
                {isManagerSetup ? 'Finalize Setup →' : 'Continue →'}
              </button>
            </div>
          </div>
        )}

        {step === 3 && !isManagerSetup && (
          <div style={{ maxWidth: 480, width: '100%' }}>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 40, color: 'var(--text)', marginBottom: 8 }}>Who will manage this hospital?</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 32 }}>Enter the name of the hospital manager or admin.</p>
            <div style={{ marginBottom: 24 }}>
              <label style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.1em', display: 'block', marginBottom: 6 }}>Manager Name</label>
              <input value={form.manager_name} onChange={e => setForm(f => ({ ...f, manager_name: e.target.value }))} placeholder="Priya Sharma"
                style={{ width: '100%', background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 8, padding: '12px 16px', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 14, outline: 'none', boxSizing: 'border-box' }} />
            </div>
            <div style={{ background: 'rgba(0,113,227,0.06)', border: '1px solid rgba(0,113,227,0.2)', borderRadius: 12, padding: 20, marginBottom: 32 }}>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--brand)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: 12 }}>Manager Login Preview</div>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text)', marginBottom: 4 }}>{previewEmail}</div>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text-secondary)' }}>Vela@XXXX (auto-generated)</div>
            </div>
            <div style={{ display: 'flex', gap: 12 }}>
              <button type="button" onClick={prevStep} style={{ background: 'rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 10, padding: '12px 24px', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 14, cursor: 'pointer' }}>← Back</button>
              <button type="button" onClick={() => { setStep(4); runOnboarding(); }} disabled={!form.manager_name}
                style={{ background: 'var(--brand)', color: '#FFFFFF', border: 'none', borderRadius: 10, padding: '12px 32px', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 14, cursor: 'pointer', opacity: !form.manager_name ? 0.5 : 1 }}>
                Generate Credentials →
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div style={{ maxWidth: 400, width: '100%', textAlign: 'center' }}>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 40, color: 'var(--text)', marginBottom: 32 }}>Setting up...</h1>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {['Creating hospital profile...', 'Setting up dashboards...', 'Generating credentials...', 'Connecting to Vela network...', 'Going live...'].map((s, i) => {
                const done = confirmSteps.includes(s);
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 12, opacity: done ? 1 : 0.3, transition: 'opacity 0.3s' }}>
                    <div style={{ width: 20, height: 20, borderRadius: '50%', background: done ? 'var(--success)' : 'rgba(0,0,0,0.10)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, flexShrink: 0 }}>
                      {done ? '✓' : ''}
                    </div>
                    <span style={{ fontFamily: 'var(--font-sans)', fontSize: 15, color: done ? 'var(--text)' : 'var(--text-secondary)' }}>{s}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {step === 5 && credentials && (
          <div style={{ maxWidth: 480, width: '100%', textAlign: 'center' }}>
            <div style={{ fontSize: 64, marginBottom: 16 }}>🎉</div>
            <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 40, color: 'var(--text)', marginBottom: 8 }}>{isManagerSetup ? 'Facility Setup Complete!' : 'Hospital is now on VELA!'}</h1>
            <p style={{ color: 'var(--text-secondary)', marginBottom: 32 }}>{isManagerSetup ? 'Your hospital dashboard is now ready to use.' : 'Share these credentials with the hospital manager.'}</p>
            
            {!isManagerSetup && credentials && (
              <div style={{ background: 'rgba(0,113,227,0.06)', border: '1px solid rgba(0,113,227,0.3)', borderRadius: 16, padding: 28, marginBottom: 32, textAlign: 'left' }}>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--brand)', textTransform: 'uppercase', letterSpacing: '0.2em', marginBottom: 16 }}>Hospital Manager Login</div>
              <div style={{ fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text-secondary)', marginBottom: 4 }}>Hospital</div>
              <div style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 16, color: 'var(--text)', marginBottom: 16 }}>{credentials.hospital_name}</div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-secondary)', marginBottom: 2 }}>EMAIL</div>
                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text)' }}>{credentials.manager_email}</div>
                </div>
                <button type="button" onClick={() => copy(credentials.manager_email, 'email')}
                  style={{ background: copiedField === 'email' ? 'var(--success)' : 'var(--brand)', color: 'var(--bg)', border: 'none', borderRadius: 6, padding: '6px 14px', fontFamily: 'var(--font-sans)', fontSize: 10, cursor: 'pointer', fontWeight: 700 }}>
                  {copiedField === 'email' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: 9, color: 'var(--text-secondary)', marginBottom: 2 }}>PASSWORD</div>
                  <div style={{ fontFamily: 'var(--font-sans)', fontSize: 13, color: 'var(--text)' }}>{credentials.manager_password}</div>
                </div>
                <button type="button" onClick={() => copy(credentials.manager_password, 'pass')}
                  style={{ background: copiedField === 'pass' ? 'var(--success)' : 'var(--brand)', color: 'var(--bg)', border: 'none', borderRadius: 6, padding: '6px 14px', fontFamily: 'var(--font-sans)', fontSize: 10, cursor: 'pointer', fontWeight: 700 }}>
                  {copiedField === 'pass' ? 'Copied!' : 'Copy'}
                </button>
              </div>
              </div>
            )}
            <div style={{ display: 'flex', gap: 12 }}>
              {!isManagerSetup ? (
                  <>
                    <button type="button" onClick={() => { setStep(1); setForm({ name: '', address: '', city: '', state: '', phone: '', email: '', total_beds: 100, latitude: null, longitude: null, mapbox_place_id: '', manager_name: '' }); setSelectedSpecs([]); setCredentials(null); setConfirmSteps([]); }}
                        style={{ flex: 1, background: 'rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 10, padding: '12px', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 14, cursor: 'pointer' }}>
                        Onboard Another
                    </button>
                    <button type="button" onClick={onClose}
                        style={{ flex: 1, background: 'var(--brand)', border: 'none', borderRadius: 10, padding: '12px', color: '#FFFFFF', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
                        View All Hospitals
                    </button>
                  </>
              ) : (
                  <button type="button" onClick={onClose}
                      style={{ width: '100%', background: 'var(--brand)', border: 'none', borderRadius: 10, padding: '16px', color: '#FFFFFF', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 14, cursor: 'pointer' }}>
                      Go to Dashboard
                  </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
