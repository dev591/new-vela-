import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from '@studio-freight/lenis';
import { ArrowRight, ArrowUpRight } from 'lucide-react';

gsap.registerPlugin(ScrollTrigger);

/**
 * VELA landing page — editorial clinical.
 *
 * Design rules this page holds to, because breaking them is what makes a page
 * look machine-assembled:
 *   1. ONE accent colour. Clinical reds/ambers appear only where they describe
 *      an actual clinical state (a critical value), never as decoration.
 *   2. Asymmetric, left-aligned composition. A centred hero over a three-card
 *      grid is the single most recognisable template shape on the web.
 *   3. Numbered editorial rows instead of a card grid — content sets the
 *      rhythm, not a repeating container.
 *   4. Every number on this page is verifiable by opening the product. No
 *      invented benchmarks.
 */

const NAV_LINKS = [
  { label: 'Platform', href: '#platform' },
  { label: 'Atlas', href: '#atlas' },
  { label: 'Safety', href: '#safety' },
];

// Capabilities as an editorial sequence. Ordered as a clinician meets them.
const CAPABILITIES = [
  {
    n: '01',
    title: 'Reads every report',
    body: 'Blood work, pathology, discharge summaries — and the crooked phone photo of a handwritten note. Vela structures them into one chronological record.',
    detail: 'Vision extraction · RAG-indexed',
  },
  {
    n: '02',
    title: 'Answers out loud',
    body: 'Hold the spacebar and ask. Atlas answers from this patient’s own records, cites the document it came from, and stays quiet when it does not know.',
    detail: 'Voice · Cited answers',
  },
  {
    n: '03',
    title: 'Reads the scan',
    body: 'Chest films, CT, MRI and ultrasound get a structured second read — modality, systematic findings, impression, and correlation against the patient’s own labs.',
    detail: 'Radiology second read',
  },
  {
    n: '04',
    title: 'Escalates what matters',
    body: 'Critical values are flagged the moment they arrive and pushed to the clinician who needs them, across every department, in real time.',
    detail: 'Live across the hospital',
  },
];

// Verifiable in the product — nothing invented.
const FACTS = [
  { v: '6', l: 'Connected roles' },
  { v: '4', l: 'AI subsystems' },
  { v: '0', l: 'Findings auto-filed without a doctor' },
];

const ROLES = ['Doctor', 'Reception', 'Laboratory', 'Ward', 'Management', 'Patient'];

export default function LandingPage() {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const heroLines = useRef<(HTMLElement | null)[]>([]);

  useEffect(() => {
    const lenis = new Lenis({ duration: 1.1, easing: (t) => Math.min(1, 1.001 - Math.pow(2, -10 * t)) });
    const raf = (time: number) => { lenis.raf(time); requestAnimationFrame(raf); };
    requestAnimationFrame(raf);

    const handleScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', handleScroll);

    // Hero lines rise as a set — one gesture, not six competing ones.
    gsap.fromTo(heroLines.current.filter(Boolean),
      { y: 28, opacity: 0 },
      { y: 0, opacity: 1, duration: 1.1, stagger: 0.09, ease: 'power3.out', delay: 0.15 }
    );

    document.querySelectorAll('.reveal').forEach((el) => {
      gsap.fromTo(el,
        { opacity: 0, y: 24 },
        { opacity: 1, y: 0, duration: 0.85, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 88%' } }
      );
    });

    return () => {
      window.removeEventListener('scroll', handleScroll);
      lenis.destroy();
      ScrollTrigger.getAll().forEach(t => t.kill());
    };
  }, []);

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg)', color: 'var(--text)' }}>

      {/* ── Nav ─────────────────────────────────────────────── */}
      <nav
        className="fixed top-0 left-0 right-0 z-50 transition-all duration-500"
        style={{
          background: scrolled ? 'rgba(245,248,252,0.82)' : 'transparent',
          backdropFilter: scrolled ? 'blur(16px)' : 'none',
          borderBottom: `1px solid ${scrolled ? 'var(--border)' : 'transparent'}`,
        }}
      >
        <div className="max-w-[1400px] mx-auto px-6 md:px-12 flex items-center justify-between h-[76px]">
          <div className="flex items-baseline gap-3">
            <span className="display text-[26px]" style={{ color: 'var(--text)' }}>Vela</span>
            <span className="label-mono hidden sm:inline" style={{ fontSize: 9 }}>Clinical Intelligence</span>
          </div>

          <div className="flex items-center gap-10">
            <div className="hidden md:flex items-center gap-9">
              {NAV_LINKS.map(l => (
                <a key={l.label} href={l.href}
                   className="text-[13px] transition-colors duration-300"
                   style={{ color: 'var(--text-secondary)' }}
                   onMouseEnter={e => (e.currentTarget.style.color = 'var(--text)')}
                   onMouseLeave={e => (e.currentTarget.style.color = 'var(--text-secondary)')}>
                  {l.label}
                </a>
              ))}
            </div>
            <button
              type="button"
              onClick={() => navigate('/login')}
              className="group flex items-center gap-2 text-[13px] font-medium transition-colors duration-300"
              style={{ color: 'var(--text)' }}
            >
              Sign in
              <ArrowRight size={14} className="transition-transform duration-300 group-hover:translate-x-1" />
            </button>
          </div>
        </div>
      </nav>

      {/* ── Hero ────────────────────────────────────────────── */}
      <section className="relative px-6 md:px-12 pt-40 md:pt-52 pb-24">
        <div className="max-w-[1400px] mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-[1.35fr_0.65fr] gap-16 lg:gap-24 items-end">

            <div>
              <div ref={el => { heroLines.current[0] = el; }} className="label-mono mb-10">
                Clinical Intelligence OS
              </div>

              <h1 className="display text-[15vw] sm:text-[11vw] lg:text-[104px] mb-0" style={{ color: 'var(--text)' }}>
                <span ref={el => { heroLines.current[1] = el; }} className="block">Every patient.</span>
                <span ref={el => { heroLines.current[2] = el; }} className="block">Every report.</span>
                <span ref={el => { heroLines.current[3] = el; }} className="block display-italic" style={{ color: 'var(--brand)' }}>
                  Every answer.
                </span>
              </h1>
            </div>

            <div ref={el => { heroLines.current[4] = el; }} className="lg:pb-4">
              <p className="text-[17px] leading-[1.65] mb-10" style={{ color: 'var(--text-secondary)' }}>
                Hospitals do not lack data — they lack a way to hold it all at once.
                Vela reads every report, scan and note a patient has, and gives the
                clinician in the room the whole picture in seconds.
              </p>

              <button
                type="button"
                onClick={() => navigate('/login')}
                className="group inline-flex items-center gap-4 pb-3 transition-all duration-300"
                style={{ borderBottom: '1px solid var(--text)' }}
              >
                <span className="text-[15px] font-medium">Enter the platform</span>
                <ArrowRight size={16} className="transition-transform duration-300 group-hover:translate-x-1.5" />
              </button>
            </div>
          </div>
        </div>
      </section>

      {/* ── Product frame ───────────────────────────────────── */}
      <section className="px-6 md:px-12 pb-28">
        <div className="reveal max-w-[1400px] mx-auto">
          <div className="overflow-hidden" style={{ background: '#fff', border: '1px solid var(--border)' }}>

            <div className="flex items-center justify-between px-6 h-12" style={{ borderBottom: '1px solid var(--border)' }}>
              <span className="label-mono" style={{ fontSize: 9 }}>Patient · Rajesh Kumar · VLA-8888</span>
              <span className="label-mono hidden sm:inline" style={{ fontSize: 9 }}>Live</span>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr]">

              {/* Clinical column */}
              <div className="p-8 md:p-12" style={{ borderRight: '1px solid var(--border)' }}>
                <div className="flex items-start justify-between mb-10">
                  <div>
                    <div className="display text-[38px] leading-none mb-2">Rajesh Kumar</div>
                    <div className="label-mono">ICU · Bed 4 · 45Y · O+</div>
                  </div>
                  <div className="text-right">
                    <div className="display text-[52px] leading-none" style={{ color: 'var(--danger)' }}>82</div>
                    <div className="label-mono mt-1">Risk</div>
                  </div>
                </div>

                <div className="label-mono mb-4">Flagged values</div>
                <div>
                  {[
                    { t: 'Potassium', v: '2.8 mEq/L', flag: true },
                    { t: 'Creatinine', v: '1.1 mg/dL', flag: false },
                    { t: 'Haemoglobin', v: '9.4 g/dL', flag: true },
                  ].map((row, i) => (
                    <div key={row.t}
                         className="flex items-center justify-between py-4"
                         style={{ borderTop: i === 0 ? '1px solid var(--border)' : '1px solid var(--border)' }}>
                      <span className="text-[14px]" style={{ color: row.flag ? 'var(--danger)' : 'var(--text-secondary)' }}>
                        {row.t}
                      </span>
                      <span className="text-[14px] font-mono" style={{ color: row.flag ? 'var(--danger)' : 'var(--text)' }}>
                        {row.v}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Atlas column */}
              <div className="p-8 md:p-12 flex flex-col justify-between" style={{ background: 'var(--bg-secondary)' }}>
                <div>
                  <div className="label-mono mb-6">Atlas</div>
                  <p className="display display-italic text-[26px] leading-[1.25]" style={{ color: 'var(--text)' }}>
                    “Potassium has dropped to 2.8 — critically low. Consider replacement and recheck the ECG.”
                  </p>
                </div>
                <div className="label-mono mt-10" style={{ fontSize: 9 }}>
                  Cited · Blood_Report.pdf · Today
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── Position statement ──────────────────────────────── */}
      <section className="px-6 md:px-12 py-28" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="max-w-[1400px] mx-auto grid grid-cols-1 lg:grid-cols-[0.3fr_0.7fr] gap-12">
          <div className="label-mono">The problem</div>
          <p className="display text-[32px] md:text-[46px] leading-[1.2]" style={{ color: 'var(--text)' }}>
            A patient’s history is scattered across paper, PDFs, three departments
            and someone’s memory. The clinician has <span className="display-italic" style={{ color: 'var(--brand)' }}>eleven minutes</span> to
            reassemble it. Vela does that part.
          </p>
        </div>
      </section>

      {/* ── Capabilities ────────────────────────────────────── */}
      <section id="platform" className="px-6 md:px-12 py-10" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="max-w-[1400px] mx-auto">
          <div className="label-mono py-10">The platform</div>

          {CAPABILITIES.map((c) => (
            <div key={c.n}
                 className="reveal group grid grid-cols-1 lg:grid-cols-[0.12fr_0.38fr_0.5fr] gap-6 lg:gap-12 py-12 transition-colors duration-500"
                 style={{ borderTop: '1px solid var(--border)' }}>
              <div className="label-mono pt-2">{c.n}</div>
              <h3 className="display text-[30px] md:text-[38px] leading-[1.1]" style={{ color: 'var(--text)' }}>
                {c.title}
              </h3>
              <div>
                <p className="text-[16px] leading-[1.7] mb-4" style={{ color: 'var(--text-secondary)' }}>
                  {c.body}
                </p>
                <div className="label-mono" style={{ color: 'var(--brand)' }}>{c.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Atlas ───────────────────────────────────────────── */}
      <section id="atlas" className="px-6 md:px-12 py-28" style={{ background: '#101418' }}>
        <div className="max-w-[1400px] mx-auto grid grid-cols-1 lg:grid-cols-[0.55fr_0.45fr] gap-16 items-center">
          <div>
            <div className="label-mono mb-8" style={{ color: 'rgba(255,255,255,0.35)' }}>Atlas</div>
            <h2 className="display text-[44px] md:text-[64px] leading-[1.05] mb-8" style={{ color: '#fff' }}>
              The recall of a chief resident,<br />
              <span className="display-italic" style={{ color: 'var(--brand-light)' }}>always on call.</span>
            </h2>
            <p className="text-[17px] leading-[1.7] max-w-xl" style={{ color: 'rgba(255,255,255,0.55)' }}>
              Ask out loud, mid-consultation, without touching the keyboard. Atlas
              answers from the patient’s own documents and tells you which one it
              read. When the record does not contain the answer, it says so.
            </p>
          </div>

          <div className="space-y-px">
            {[
              { q: 'What was his last potassium?', a: '2.8 mEq/L — critically low, from this morning’s panel.' },
              { q: 'Is he on anything that could cause that?', a: 'Furosemide 40mg, started six days ago.' },
              { q: 'Any allergies before I prescribe?', a: 'Penicillin. Documented at registration.' },
            ].map((ex) => (
              <div key={ex.q} className="reveal p-7" style={{ background: 'rgba(255,255,255,0.03)', borderLeft: '1px solid rgba(255,255,255,0.12)' }}>
                <div className="text-[14px] mb-3" style={{ color: 'rgba(255,255,255,0.4)' }}>“{ex.q}”</div>
                <div className="display display-italic text-[19px] leading-snug" style={{ color: '#fff' }}>{ex.a}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Safety ──────────────────────────────────────────── */}
      <section id="safety" className="px-6 md:px-12 py-28">
        <div className="max-w-[1400px] mx-auto">
          <div className="grid grid-cols-1 lg:grid-cols-[0.3fr_0.7fr] gap-12 mb-16">
            <div className="label-mono">Safety</div>
            <div>
              <h2 className="display text-[36px] md:text-[52px] leading-[1.1] mb-8" style={{ color: 'var(--text)' }}>
                The AI never gets the last word.
              </h2>
              <p className="text-[17px] leading-[1.7] max-w-2xl" style={{ color: 'var(--text-secondary)' }}>
                A confident wrong answer is more dangerous than no answer. So the
                system is built to hold back: handwriting is never confidently
                transcribed, imaging findings are read blind before the patient’s
                notes are consulted, and nothing enters a record until a clinician
                accepts it.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3">
            {[
              { t: 'Blind read first', d: 'Radiology findings are detected from the image alone. The clinical notes are withheld until after, so the AI cannot invent a finding that fits the story it was told.' },
              { t: 'Uncertainty is surfaced', d: 'Every finding carries a visible confidence. Low-confidence extractions are flagged for review against the original document rather than filed silently.' },
              { t: 'A human signs off', d: 'Findings are suggestions until a doctor ticks them. Only accepted findings reach the patient record — attributed, and with their name on it.' },
            ].map((c, i) => (
              <div key={c.t} className="reveal p-8 md:p-10"
                   style={{
                     borderTop: '1px solid var(--text)',
                     borderRight: i < 2 ? '1px solid var(--border)' : 'none',
                   }}>
                <h3 className="display text-[24px] mb-4" style={{ color: 'var(--text)' }}>{c.t}</h3>
                <p className="text-[14px] leading-[1.7]" style={{ color: 'var(--text-secondary)' }}>{c.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Facts ───────────────────────────────────────────── */}
      <section className="px-6 md:px-12 py-24" style={{ borderTop: '1px solid var(--border)', background: '#fff' }}>
        <div className="max-w-[1400px] mx-auto grid grid-cols-1 md:grid-cols-3 gap-12">
          {FACTS.map(f => (
            <div key={f.l} className="reveal">
              <div className="display text-[80px] md:text-[110px] leading-none mb-3" style={{ color: 'var(--text)' }}>
                {f.v}
              </div>
              <div className="label-mono">{f.l}</div>
            </div>
          ))}
        </div>
      </section>

      {/* ── Roles ───────────────────────────────────────────── */}
      <section className="px-6 md:px-12 py-24" style={{ borderTop: '1px solid var(--border)', background: '#fff' }}>
        <div className="max-w-[1400px] mx-auto grid grid-cols-1 lg:grid-cols-[0.3fr_0.7fr] gap-12">
          <div className="label-mono">One system</div>
          <div>
            <h2 className="display text-[32px] md:text-[44px] leading-[1.15] mb-10" style={{ color: 'var(--text)' }}>
              Reception, lab, wards, doctors and management working from a single
              source of truth.
            </h2>
            <div className="flex flex-wrap gap-x-10 gap-y-4">
              {ROLES.map(r => (
                <span key={r} className="display text-[22px]" style={{ color: 'var(--text-secondary)' }}>{r}</span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── CTA ─────────────────────────────────────────────── */}
      <section className="px-6 md:px-12 py-36" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="reveal max-w-[1400px] mx-auto">
          <h2 className="display text-[13vw] lg:text-[110px] leading-[0.98] mb-14" style={{ color: 'var(--text)' }}>
            Practice medicine.<br />
            <span className="display-italic" style={{ color: 'var(--brand)' }}>We’ll hold the paperwork.</span>
          </h2>
          <button
            type="button"
            onClick={() => navigate('/login')}
            className="group inline-flex items-center gap-4 pb-3"
            style={{ borderBottom: '1px solid var(--text)' }}
          >
            <span className="text-[16px] font-medium">Enter the platform</span>
            <ArrowUpRight size={18} className="transition-transform duration-300 group-hover:translate-x-1 group-hover:-translate-y-1" />
          </button>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────── */}
      <footer className="px-6 md:px-12 py-12" style={{ borderTop: '1px solid var(--border)' }}>
        <div className="max-w-[1400px] mx-auto flex flex-col md:flex-row items-start md:items-center justify-between gap-6">
          <span className="display text-[20px]" style={{ color: 'var(--text)' }}>Vela</span>
          <span className="label-mono">© 2026 Vela Medical Intelligence</span>
          <span className="label-mono">Decision support · Not a diagnostic device</span>
        </div>
      </footer>
    </div>
  );
}
