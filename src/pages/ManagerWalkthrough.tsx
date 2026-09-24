import { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { gsap } from 'gsap';
import confetti from 'canvas-confetti';
import { API_URL } from '../utils/config';

const STEPS = [
  {
    title: 'Welcome to VELA',
    subtitle: (name: string) => `Welcome to VELA, ${name}`,
    body: "You are now part of India's most intelligent hospital network. Let's set up your hospital in 2 minutes.",
    icon: '🏥',
    cta: "Let's Begin →"
  },
  {
    title: 'Your Command Center',
    subtitle: () => 'Your Dashboard',
    body: 'This is your command center. See every patient, every staff member, every bed in real time.',
    icon: '📊',
    cta: 'Next →'
  },
  {
    title: 'Add Your Team',
    subtitle: () => 'Add Your Team',
    body: 'Add your doctors, receptionists, and lab staff. Each gets their own login. They can start immediately.',
    icon: '👥',
    cta: 'Next →'
  },
  {
    title: 'Meet Atlas AI',
    subtitle: () => 'Atlas AI',
    body: 'Doctors hold spacebar and ask anything. Atlas reads every report and answers out loud.',
    icon: '🤖',
    cta: 'Next →'
  },
  {
    title: "You're Ready!",
    subtitle: () => 'Your hospital is live on the Vela network.',
    body: 'Everything is set up. Start by adding your first doctor or registering your first patient.',
    icon: '🎉',
    cta: 'Go to Dashboard'
  }
];

export default function ManagerWalkthrough() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const stepRef = useRef<HTMLDivElement>(null);
  const hospitalName = localStorage.getItem('vela_hospital_name') || 'Your Hospital';
  const hospitalId = localStorage.getItem('vela_hospital_id');

  const animateStep = () => {
    if (stepRef.current) {
      gsap.fromTo(stepRef.current, { opacity: 0, x: 60 }, { opacity: 1, x: 0, duration: 0.5, ease: 'power3.out' });
    }
  };

  useEffect(() => { animateStep(); }, [step]);

  useEffect(() => {
    if (step === 4) {
      setTimeout(() => {
        confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 }, colors: ['#0071E3', '#0071E3', '#1D1D1F', '#248A3D'] });
      }, 300);
    }
  }, [step]);

  const complete = async () => {
    if (hospitalId) {
      try {
        await fetch(`${API_URL}/api/manager/complete-walkthrough`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ hospital_id: hospitalId })
        });
      } catch {}
    }
    localStorage.setItem('vela_walkthrough_done', 'true');
    navigate('/hospital-manager');
  };

  const skip = () => complete();

  const current = STEPS[step];

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', flexDirection: 'column', fontFamily: 'var(--font-sans)', color: 'var(--text)' }}>
      {/* Header */}
      <div style={{ padding: '24px 48px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(0,0,0,0.07)' }}>
        <div style={{ display: 'flex', gap: 8 }}>
          {STEPS.map((_, i) => (
            <div key={i} style={{ width: 8, height: 8, borderRadius: '50%', background: i === step ? 'var(--brand)' : i < step ? 'var(--success)' : 'rgba(0,0,0,0.12)', transition: 'all 0.3s', boxShadow: i === step ? '0 0 8px rgba(0,113,227,0.6)' : 'none' }} />
          ))}
        </div>
        <div style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.1em' }}>Step {step + 1} of {STEPS.length}</div>
        <button type="button" onClick={skip} style={{ background: 'none', border: 'none', color: 'var(--text-tertiary)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.1em' }}>Skip →</button>
      </div>

      {/* Content */}
      <div ref={stepRef} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '48px', textAlign: 'center' }}>
        <div style={{ fontSize: 80, marginBottom: 24 }}>{current.icon}</div>
        <h1 style={{ fontFamily: 'var(--font-sans)', fontSize: 52, color: 'var(--text)', marginBottom: 16, maxWidth: 600 }}>
          {current.subtitle(hospitalName)}
        </h1>
        <p style={{ fontSize: 18, color: 'var(--text-secondary)', maxWidth: 520, lineHeight: 1.7, marginBottom: 48 }}>
          {current.body}
        </p>

        {/* Step-specific extras */}
        {step === 2 && (
          <div style={{ background: 'rgba(0,0,0,0.04)', border: '1px solid rgba(0,0,0,0.08)', borderRadius: 12, padding: '16px 24px', marginBottom: 32, textAlign: 'left', minWidth: 320 }}>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--text-secondary)', marginBottom: 8 }}>EXAMPLE STAFF CARD</div>
            <div style={{ fontFamily: 'var(--font-sans)', fontWeight: 600, fontSize: 15, marginBottom: 2 }}>Dr. Sharma — Cardiology</div>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-secondary)' }}>dr.sharma@hospital.vela.health</div>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 12, color: 'var(--text-secondary)' }}>Vela@****</div>
          </div>
        )}

        {step === 3 && (
          <div style={{ background: 'rgba(0,113,227,0.06)', border: '1px solid rgba(0,113,227,0.2)', borderRadius: 12, padding: '16px 24px', marginBottom: 32, textAlign: 'left', minWidth: 360 }}>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 10, color: 'var(--brand)', marginBottom: 8 }}>ATLAS EXAMPLE</div>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text-secondary)', marginBottom: 8 }}>Doctor asks: "How is patient Rajesh?"</div>
            <div style={{ fontFamily: 'var(--font-sans)', fontSize: 14, color: 'var(--text)' }}>Atlas: "Rajesh shows critically low potassium. Needs immediate attention."</div>
          </div>
        )}

        {step === 4 && (
          <div style={{ display: 'flex', gap: 12, marginBottom: 32 }}>
            {['Add your first doctor →', 'Register first patient →', 'Explore dashboard →'].map((action, i) => (
              <button key={i} type="button" onClick={complete}
                style={{ background: 'rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 10, padding: '12px 20px', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 13, cursor: 'pointer' }}>
                {action}
              </button>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', gap: 12 }}>
          {step > 0 && (
            <button type="button" onClick={() => setStep(s => s - 1)}
              style={{ background: 'rgba(0,0,0,0.07)', border: '1px solid rgba(0,0,0,0.10)', borderRadius: 10, padding: '14px 28px', color: 'var(--text)', fontFamily: 'var(--font-sans)', fontSize: 15, cursor: 'pointer' }}>
              ← Back
            </button>
          )}
          <button type="button" onClick={step === 4 ? complete : () => setStep(s => s + 1)}
            style={{ background: 'var(--brand)', color: '#FFFFFF', border: 'none', borderRadius: 10, padding: '14px 36px', fontFamily: 'var(--font-sans)', fontWeight: 700, fontSize: 15, cursor: 'pointer' }}>
            {current.cta}
          </button>
        </div>
      </div>
    </div>
  );
}
