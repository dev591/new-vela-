import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { SplitText } from 'gsap/SplitText'
import { ArrowRight, ArrowUpRight, FileText, Mic, PenLine, Pill, ShieldAlert, Activity, ScanLine, Sparkles } from 'lucide-react'
import ParticleField from '../components/cinematic/ParticleField'
import CinematicCursor from '../components/cinematic/CinematicCursor'
import useSmoothScroll from '../components/cinematic/useSmoothScroll'

gsap.registerPlugin(ScrollTrigger, SplitText)

/**
 * VELA landing — an Apple-style product film you scroll.
 *
 * One protagonist runs through every chapter: a patient's history. It opens as
 * scattered light (the hero particles), is pulled into a heartbeat, lands as
 * loose fragments that assemble into one record, is queried by Atlas, travels
 * through every role, and finally becomes the sign-in screen.
 *
 * Motion rules:
 *   - Everything is scrubbed by scroll (scrub: true), never fire-and-forget,
 *     so the viewer sets the pace and can scroll back.
 *   - The DOM is written in its END state and animated FROM the start state,
 *     so prefers-reduced-motion gets a complete, static page for free.
 *   - Every figure on the page is verifiable in the product; the patient shown
 *     is the seeded demo record.
 */

const FRAGMENTS = [
  { key: 'lab', icon: FileText, title: 'Blood_Report.pdf', meta: 'Lab · Tuesday', body: 'Potassium 2.8 mEq/L', flag: true },
  { key: 'note', icon: PenLine, title: 'Handwritten note', meta: 'Ward round', body: 'c/o fatigue, cramps — K+?', hand: true },
  { key: 'xray', icon: ScanLine, title: 'Chest X-ray PA', meta: 'Radiology', body: 'No acute findings', scan: true },
  { key: 'rx', icon: Pill, title: 'Furosemide 40 mg', meta: 'Started 6 days ago', body: 'Once daily' },
  { key: 'voice', icon: Mic, title: 'Voice memo', meta: '0:42', body: '', wave: true },
  { key: 'allergy', icon: ShieldAlert, title: 'Allergy', meta: 'At registration', body: 'Penicillin', flag: true },
] as const

// Where each fragment starts (vw / vh offsets from its place in the record).
// Kept inside the viewport so the mess is visible from the first frame.
const SCATTER = [
  { x: -16, y: -22, r: -16, rx: 30, ry: -35 },
  { x: 8, y: -28, r: 12, rx: -25, ry: 30 },
  { x: 14, y: -6, r: 18, rx: 20, ry: 40 },
  { x: -20, y: 18, r: 10, rx: -30, ry: -25 },
  { x: 2, y: 24, r: -20, rx: 35, ry: 20 },
  { x: 16, y: 20, r: -12, rx: -20, ry: -40 },
]

const STEPS = [
  'A lab PDF from Tuesday.',
  'A note nobody can read.',
  'A scan in another department.',
  'A prescription from last week.',
  'One record. Assembled in seconds.',
]

const ATLAS = [
  { q: 'What was his last potassium?', a: '2.8 mEq/L — critically low, from this morning’s panel.', src: 'Blood_Report.pdf' },
  { q: 'Is he on anything that could cause that?', a: 'Furosemide 40 mg, started six days ago.', src: 'Prescription · 22 Oct' },
  { q: 'Any allergies before I prescribe?', a: 'Penicillin. Documented at registration.', src: 'Registration' },
]

const ROLES = [
  { n: '01', role: 'Reception', line: 'Registers a walk-in in under a minute and puts emergencies at the front of the queue.', chip: 'Emergency → front of queue',
    rows: [['TKT-0142', 'Emergency', true], ['TKT-0139', 'Routine · 15 min', false], ['TKT-0140', 'Routine · 30 min', false]] },
  { n: '02', role: 'Doctor', line: 'Calls the next patient and has the whole history, summarised, before they sit down.', chip: 'Atlas summary ready',
    rows: [['Rajesh Kumar', 'Now', true], ['Anita Rao', 'Next', false], ['M. Iyer', 'Waiting', false]] },
  { n: '03', role: 'Laboratory', line: 'Works only paid, arrived orders, and files a report that flags its own critical values.', chip: 'Flagged to doctor on duty',
    rows: [['Potassium', '2.8 mEq/L', true], ['Sodium', '138 mEq/L', false], ['Creatinine', '1.1 mg/dL', false]] },
  { n: '04', role: 'Ward', line: 'Scans a bed QR to admit, track the stay and price the discharge.', chip: 'ICU · Day 3',
    rows: [['Bed 4', 'Occupied', true], ['Bed 5', 'Available', false], ['Bed 6', 'Cleaning', false]] },
  { n: '05', role: 'Management', line: 'Sees beds, staff and throughput live — and who opened which record.', chip: 'Audit trail · tamper-evident',
    rows: [['Beds occupied', '18 / 24', true], ['Staff online', '11', false], ['Audit chain', 'Intact', false]] },
  { n: '06', role: 'Patient', line: 'Books without an account, pays for tests, and hears “it’s your turn” on their phone.', chip: 'You are next in line',
    rows: [['Your turn', 'Room 3', true], ['Lab tests', 'Paid', false], ['Report', 'Ready', false]] },
] as const

const FACTS = [
  { v: 6, l: 'Roles on one record' },
  { v: 4, l: 'AI subsystems, each cited' },
  { v: 0, l: 'Findings filed without a doctor' },
]

const SAFETY_LINE =
  'A confident wrong answer is more dangerous than no answer. So Vela holds back: handwriting is never guessed, scans are read blind before the notes, and nothing reaches a record until a clinician accepts it.'

export default function LandingPage() {
  const navigate = useNavigate()
  const root = useRef<HTMLDivElement>(null)
  const heroProgress = useRef(0)
  const wipe = useRef<HTMLDivElement>(null)

  useSmoothScroll()

  // Leave through a black iris that grows from the button — the sign-in page
  // opens on black, so the film never cuts.
  const enter = (e?: React.MouseEvent) => {
    const el = wipe.current
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { navigate('/login'); return }
    const x = e ? e.clientX : window.innerWidth / 2
    const y = e ? e.clientY : window.innerHeight / 2
    gsap.set(el, { display: 'block', clipPath: `circle(0px at ${x}px ${y}px)` })
    gsap.to(el, { clipPath: `circle(150vmax at ${x}px ${y}px)`, duration: 0.85, ease: 'power3.inOut', onComplete: () => { navigate('/login') } })
  }

  useEffect(() => {
    const mm = gsap.matchMedia()
    const ctx = gsap.context(() => {
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        // ── 0. Title card ──
        const intro = gsap.timeline()
        intro
          .fromTo('.intro-word', { yPercent: 110 }, { yPercent: 0, duration: 0.9, ease: 'power4.out' })
          .to('.intro-word', { yPercent: -110, duration: 0.7, ease: 'power4.in' }, '+=0.35')
          .to('.intro', { yPercent: -100, duration: 0.9, ease: 'power4.inOut' }, '-=0.2')
          .set('.intro', { display: 'none' })

        // ── 1. Hero: pieces → heartbeat ──
        const heroSplit = SplitText.create('.hero-a', { type: 'words,chars', mask: 'words' })
        gsap.fromTo(heroSplit.chars, { yPercent: 120, opacity: 0 }, { yPercent: 0, opacity: 1, stagger: 0.018, duration: 1.1, ease: 'power4.out', delay: 1.9 })
        // fromTo, not from: buttons carry a CSS opacity transition, and from() would
        // read a mid-transition value as its end state under StrictMode's re-run.
        gsap.fromTo('.hero-sub, .hero-cue, .nav-in', { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 1, stagger: 0.08, delay: 2.4, ease: 'power3.out' })

        const heroTl = gsap.timeline({
          scrollTrigger: { trigger: '.ch-hero', start: 'top top', end: '+=180%', scrub: 0.6, pin: true },
        })
        heroTl
          .to(heroProgress, { current: 1, duration: 1, ease: 'none' }, 0)
          .to('.hero-a', { opacity: 0, filter: 'blur(14px)', scale: 0.94, duration: 0.35 }, 0.15)
          .to('.hero-sub, .hero-cue', { opacity: 0, duration: 0.2 }, 0.1)
          .fromTo('.hero-b', { opacity: 0, y: 40, filter: 'blur(12px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.35 }, 0.6)
          .fromTo('.hero-glow', { opacity: 0 }, { opacity: 1, duration: 0.4 }, 0.55)

        // ── 2. Pieces → one record ──
        const frags = gsap.utils.toArray<HTMLElement>('.frag')
        const piecesTl = gsap.timeline({
          scrollTrigger: { trigger: '.ch-pieces', start: 'top top', end: '+=260%', scrub: 0.8, pin: true },
        })
        frags.forEach((el, i) => {
          const s = SCATTER[i % SCATTER.length]
          piecesTl.fromTo(el,
            { xPercent: 0, x: `${s.x}vw`, y: `${s.y}vh`, rotation: s.r, rotationX: s.rx, rotationY: s.ry, scale: 0.92 },
            { x: 0, y: 0, rotation: 0, rotationX: 0, rotationY: 0, scale: 1, duration: 0.55, ease: 'power2.inOut' },
            0.1 + i * 0.07)
        })
        piecesTl
          .fromTo('.record-frame', { opacity: 0, scale: 0.96 }, { opacity: 1, scale: 1, duration: 0.25 }, 0.62)
          .fromTo('.record-head > *', { opacity: 0, y: 14 }, { opacity: 1, y: 0, stagger: 0.04, duration: 0.2 }, 0.7)
        gsap.utils.toArray<HTMLElement>('.step').forEach((el, i, all) => {
          const at = (i / all.length) * 0.85
          piecesTl.fromTo(el, { opacity: 0.18 }, { opacity: 1, duration: 0.08 }, at)
          if (i < all.length - 1) piecesTl.to(el, { opacity: 0.18, duration: 0.08 }, at + 0.85 / all.length)
        })
        piecesTl.fromTo('.pieces-bar', { scaleX: 0 }, { scaleX: 1, ease: 'none', duration: 1 }, 0)

        // ── 3. Atlas: the device tilts up, the conversation plays ──
        const atlasTl = gsap.timeline({
          scrollTrigger: { trigger: '.ch-atlas', start: 'top top', end: '+=220%', scrub: 0.8, pin: true },
        })
        atlasTl
          .fromTo('.device', { rotateX: 32, scale: 0.82, y: 120 }, { rotateX: 0, scale: 1, y: 0, duration: 0.35, ease: 'power2.out' }, 0)
          .fromTo('.atlas-title', { opacity: 1, y: 0 }, { opacity: 0.25, y: -40, duration: 0.3 }, 0.15)
        gsap.utils.toArray<HTMLElement>('.qa').forEach((el, i) => {
          const at = 0.35 + i * 0.2
          atlasTl
            .fromTo(el.querySelector('.qa-q'), { opacity: 0, x: 30 }, { opacity: 1, x: 0, duration: 0.08 }, at)
            .fromTo(el.querySelector('.qa-a'), { opacity: 0, y: 16, filter: 'blur(6px)' }, { opacity: 1, y: 0, filter: 'blur(0px)', duration: 0.1 }, at + 0.07)
        })
        atlasTl.fromTo('.orb', { scale: 0.85 }, { scale: 1.08, duration: 0.2, yoyo: true, repeat: 5, ease: 'sine.inOut' }, 0.35)

        // ── 4. One system: a horizontal pass through every role ──
        const track = document.querySelector<HTMLElement>('.roles-track')
        if (track) {
          const distance = () => track.scrollWidth - window.innerWidth
          gsap.to(track, {
            x: () => -distance(),
            ease: 'none',
            scrollTrigger: { trigger: '.ch-roles', start: 'top top', end: () => `+=${distance()}`, scrub: 0.6, pin: true, invalidateOnRefresh: true },
          })
          gsap.fromTo('.roles-bar', { scaleX: 0 }, {
            scaleX: 1, ease: 'none',
            scrollTrigger: { trigger: '.ch-roles', start: 'top top', end: () => `+=${distance()}`, scrub: true },
          })
        }

        // ── 5. Safety: the statement reads itself, word by word ──
        const words = SplitText.create('.safety-line', { type: 'words' })
        gsap.fromTo(words.words, { opacity: 0.14 }, {
          opacity: 1, stagger: 0.1, ease: 'none',
          scrollTrigger: { trigger: '.ch-safety', start: 'top 70%', end: 'bottom 75%', scrub: true },
        })
        gsap.utils.toArray<HTMLElement>('.principle').forEach((el) => {
          gsap.fromTo(el, { opacity: 0, y: 60 }, { opacity: 1, y: 0, ease: 'power3.out', scrollTrigger: { trigger: el, start: 'top 92%', end: 'top 60%', scrub: true } })
        })

        // ── 6. Facts count up, CTA rises ──
        gsap.utils.toArray<HTMLElement>('.count').forEach((el) => {
          const to = Number(el.dataset.to || 0)
          const o = { v: to === 0 ? 9 : 0 }
          gsap.to(o, {
            v: to, ease: 'power2.out',
            scrollTrigger: { trigger: el, start: 'top 85%', end: 'top 45%', scrub: true },
            onUpdate: () => { el.textContent = String(Math.round(o.v)) },
          })
        })
        const ctaSplit = SplitText.create('.cta-title', { type: 'lines', mask: 'lines' })
        gsap.fromTo(ctaSplit.lines, { yPercent: 110 }, { yPercent: 0, stagger: 0.12, ease: 'power3.out', scrollTrigger: { trigger: '.ch-cta', start: 'top 75%', end: 'top 25%', scrub: true } })
      })
    }, root)

    return () => { mm.revert(); ctx.revert() }
  }, [])

  return (
    <div ref={root} className="relative bg-black text-white">
      <CinematicCursor />

      {/* Exit iris */}
      <div ref={wipe} className="fixed inset-0 z-[200] bg-black hidden" aria-hidden="true" />

      {/* Title card */}
      <div className="intro fixed inset-0 z-[150] bg-black flex items-center justify-center motion-reduce:hidden">
        <div className="overflow-hidden">
          <div className="intro-word text-[clamp(3rem,10vw,8rem)] font-semibold tracking-[-0.05em]">Vela</div>
        </div>
      </div>

      {/* Nav — difference blend keeps it legible over black and white chapters */}
      <nav className="fixed top-0 inset-x-0 z-[100] mix-blend-difference text-white">
        <div className="max-w-[1400px] mx-auto px-6 md:px-10 h-[72px] flex items-center justify-between">
          <a href="#top" className="nav-in text-[22px] font-semibold tracking-[-0.04em]" data-cursor="Top">Vela</a>
          <div className="nav-in hidden md:flex items-center gap-9 text-[14px]">
            <a href="#record" className="opacity-70 hover:opacity-100 transition-opacity">Record</a>
            <a href="#atlas" className="opacity-70 hover:opacity-100 transition-opacity">Atlas</a>
            <a href="#roles" className="opacity-70 hover:opacity-100 transition-opacity">Platform</a>
            <a href="#safety" className="opacity-70 hover:opacity-100 transition-opacity">Safety</a>
          </div>
          <button type="button" onClick={enter} data-magnetic data-cursor="Enter"
            className="nav-in group inline-flex items-center gap-2 text-[14px] font-medium h-10 px-5 rounded-full border border-white/40 hover:bg-white hover:text-black">
            Sign in <ArrowRight size={15} className="transition-transform group-hover:translate-x-0.5" />
          </button>
        </div>
      </nav>

      {/* ── 1. Hero ─────────────────────────────────────────── */}
      <section id="top" className="ch-hero theatre film-grain relative h-screen overflow-hidden">
        <ParticleField progress={heroProgress} shape="ecg" className="absolute inset-0" />
        <div className="hero-glow pointer-events-none absolute inset-x-0 top-[62%] -translate-y-1/2 h-[40vh] opacity-0"
          style={{ background: 'radial-gradient(60% 50% at 50% 50%, rgba(41,151,255,0.22), transparent 70%)' }} />

        <div className="relative z-10 h-full max-w-[1400px] mx-auto px-6 md:px-10 grid place-items-center text-center">
          <div className="grid [grid-template-areas:'stack'] place-items-center">
            <div className="[grid-area:stack]">
              <h1 className="hero-a text-[clamp(3rem,9vw,9rem)] leading-[0.95] font-semibold tracking-[-0.05em]">
                Every patient<br />arrives in pieces.
              </h1>
              <p className="hero-sub t-2 mt-8 text-[clamp(1.05rem,1.4vw,1.3rem)] max-w-[34rem] mx-auto leading-relaxed">
                Paper, PDFs, three departments and someone’s memory. The clinician has minutes to put it back together.
              </p>
            </div>
            <h2 className="hero-b [grid-area:stack] opacity-0 motion-reduce:hidden text-[clamp(2.6rem,7.5vw,7.5rem)] leading-[0.98] font-semibold tracking-[-0.05em]">
              Vela puts them<br /><span className="text-gradient-blue">back together.</span>
            </h2>
          </div>
        </div>

        <div className="hero-cue absolute bottom-10 inset-x-0 flex flex-col items-center gap-3 t-3 text-[13px]" data-cursor="Scroll">
          <span>Scroll to play</span>
          <span className="block w-px h-10 bg-gradient-to-b from-white/60 to-transparent" />
        </div>
      </section>

      {/* ── 2. Pieces → record ──────────────────────────────── */}
      <section id="record" className="ch-pieces relative h-screen overflow-hidden bg-[#F5F5F7] text-[#1D1D1F]">
        <div className="absolute top-0 inset-x-0 h-[3px] bg-black/5">
          <div className="pieces-bar h-full origin-left bg-[#0071E3]" />
        </div>
        <div className="h-full max-w-[1400px] mx-auto px-6 md:px-10 grid grid-cols-1 lg:grid-cols-[0.36fr_0.64fr] gap-10 items-center pt-20 lg:pt-0">
          <div>
            <div className="text-[13px] font-semibold text-[#0071E3] mb-5">The record</div>
            <ol className="space-y-3">
              {STEPS.map((s, i) => (
                <li key={s} className={`step text-[clamp(1.35rem,2.4vw,2.2rem)] font-semibold tracking-[-0.03em] leading-tight ${i === STEPS.length - 1 ? 'text-[#0071E3]' : 'max-lg:hidden'}`}>{s}</li>
              ))}
            </ol>
          </div>

          <div className="relative [perspective:1400px]">
            <div className="relative p-5 md:p-7">
              {/* The frame fades in behind the fragments; fading the parent would hide them too. */}
              <div className="record-frame absolute inset-0 rounded-[28px] bg-white/70 backdrop-blur-xl border border-black/5 shadow-[0_40px_80px_-30px_rgba(0,0,0,0.25)]" />
              <div className="record-head relative flex items-end justify-between mb-5 px-1">
                <div>
                  <div className="text-[12px] text-[#6E6E73]">Demo patient · VLA-8888</div>
                  <div className="text-[clamp(1.4rem,2.2vw,2rem)] font-semibold tracking-[-0.03em]">Rajesh Kumar</div>
                </div>
                <div className="text-right">
                  <div className="text-[clamp(1.8rem,3vw,2.6rem)] font-semibold leading-none text-[#D70015] tabular-nums">82</div>
                  <div className="text-[12px] text-[#6E6E73] mt-1">Risk</div>
                </div>
              </div>
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3 [transform-style:preserve-3d]">
                {FRAGMENTS.map((f) => {
                  const Icon = f.icon
                  return (
                    <div key={f.key} className="frag relative rounded-2xl bg-white border border-black/[0.06] p-4 shadow-[0_1px_0_rgba(0,0,0,0.04),0_18px_36px_-18px_rgba(0,0,0,0.22)] min-h-[118px]">
                      <div className="flex items-center gap-2 mb-3">
                        <span className={`w-7 h-7 rounded-lg grid place-items-center ${'flag' in f && f.flag ? 'bg-[#FFEBEE] text-[#D70015]' : 'bg-[#E8F2FD] text-[#0071E3]'}`}><Icon size={15} /></span>
                        <div className="min-w-0">
                          <div className="text-[13px] font-semibold truncate">{f.title}</div>
                          <div className="text-[12px] text-[#6E6E73] truncate">{f.meta}</div>
                        </div>
                      </div>
                      {'scan' in f && f.scan ? (
                        <div className="h-12 rounded-lg bg-[radial-gradient(40%_70%_at_32%_50%,#5a6270,transparent),radial-gradient(40%_70%_at_68%_50%,#5a6270,transparent),#15171b]" />
                      ) : 'wave' in f && f.wave ? (
                        <div className="h-12 flex items-center gap-[3px]">
                          {Array.from({ length: 28 }).map((_, i) => (
                            <span key={i} className="w-[3px] rounded-full bg-[#0071E3]/70" style={{ height: `${18 + Math.abs(Math.sin(i * 1.7)) * 70}%` }} />
                          ))}
                        </div>
                      ) : (
                        <div className={`text-[14px] ${'flag' in f && f.flag ? 'text-[#D70015] font-semibold' : 'text-[#515154]'}`}
                          style={'hand' in f && f.hand ? { fontFamily: '"Bradley Hand", "Segoe Print", cursive', fontSize: 16 } : undefined}>
                          {f.body}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 3. Atlas ────────────────────────────────────────── */}
      <section id="atlas" className="ch-atlas theatre film-grain relative h-screen overflow-hidden">
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(50% 40% at 50% 70%, rgba(0,113,227,0.18), transparent 70%)' }} />
        <div className="relative h-full max-w-[1200px] mx-auto px-6 md:px-10 flex flex-col items-center justify-center">
          <div className="atlas-title text-center mb-10">
            <div className="text-[13px] font-semibold text-[#2997FF] mb-4">Atlas</div>
            <h2 className="text-[clamp(2.4rem,6vw,5.5rem)] font-semibold tracking-[-0.05em] leading-[0.98]">Ask out loud.<br /><span className="t-3">Get the cited answer.</span></h2>
          </div>

          <div className="[perspective:1600px] w-full">
            <div className="device mx-auto w-full max-w-[1000px] [transform-origin:50%_100%]">
              <div className="device-screen text-[#1D1D1F]">
                <div className="flex items-center justify-between px-5 h-11 border-b border-black/5 bg-white">
                  <div className="flex gap-1.5"><span className="w-3 h-3 rounded-full bg-[#FF5F57]" /><span className="w-3 h-3 rounded-full bg-[#FEBC2E]" /><span className="w-3 h-3 rounded-full bg-[#28C840]" /></div>
                  <span className="text-[12px] text-[#6E6E73]">Rajesh Kumar · ICU · Bed 4 · VLA-8888</span>
                  <span className="text-[12px] text-[#248A3D] font-semibold flex items-center gap-1.5"><span className="w-1.5 h-1.5 rounded-full bg-[#248A3D] animate-pulse" />Live</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-[0.38fr_0.62fr] min-h-[360px] md:min-h-[440px]">
                  <div className="hidden md:block p-6 border-r border-black/5 bg-white">
                    <div className="text-[12px] text-[#6E6E73] mb-3">Flagged values</div>
                    {[{ t: 'Potassium', v: '2.8 mEq/L', f: true }, { t: 'Haemoglobin', v: '9.4 g/dL', f: true }, { t: 'Creatinine', v: '1.1 mg/dL', f: false }, { t: 'Sodium', v: '138 mEq/L', f: false }].map(r => (
                      <div key={r.t} className="flex justify-between py-3 border-t border-black/5 text-[14px]">
                        <span className={r.f ? 'text-[#D70015]' : 'text-[#515154]'}>{r.t}</span>
                        <span className={`tabular-nums ${r.f ? 'text-[#D70015] font-semibold' : ''}`}>{r.v}</span>
                      </div>
                    ))}
                    <div className="mt-6 rounded-xl bg-[#F5F5F7] p-4">
                      <div className="text-[12px] text-[#6E6E73] mb-2 flex items-center gap-1.5"><Activity size={13} /> Heart rate</div>
                      <svg viewBox="0 0 200 40" className="w-full h-10"><path d="M0 24 L40 24 L48 18 L56 24 L70 24 L76 4 L82 36 L88 24 L120 24 L128 16 L136 24 L200 24" fill="none" stroke="#0071E3" strokeWidth="2" /></svg>
                    </div>
                  </div>
                  <div className="p-5 md:p-7 bg-[#F5F5F7] flex flex-col gap-4">
                    {ATLAS.map((x) => (
                      <div key={x.q} className="qa flex flex-col gap-2">
                        <div className="qa-q self-end max-w-[80%] rounded-2xl rounded-br-md bg-[#0071E3] text-white px-4 py-2.5 text-[14px]">{x.q}</div>
                        <div className="qa-a self-start max-w-[88%] rounded-2xl rounded-bl-md bg-white px-4 py-3 shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
                          <div className="text-[15px] font-medium">{x.a}</div>
                          <div className="text-[12px] text-[#6E6E73] mt-1.5 flex items-center gap-1"><FileText size={12} /> {x.src}</div>
                        </div>
                      </div>
                    ))}
                    <div className="mt-auto flex items-center gap-3 pt-2">
                      <span className="orb w-9 h-9 rounded-full" style={{ background: 'radial-gradient(circle at 35% 30%, #A1D1FF, #0071E3 55%, #003C7A)' }} />
                      <span className="text-[13px] text-[#6E6E73]">Hold space to ask Atlas</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 4. One system ───────────────────────────────────── */}
      <section id="roles" className="ch-roles relative h-screen overflow-hidden motion-reduce:h-auto bg-white text-[#1D1D1F]">
        <div className="absolute top-0 inset-x-0 h-[3px] bg-black/5 z-10"><div className="roles-bar h-full origin-left bg-[#0071E3]" /></div>
        <div className="roles-track h-full flex items-center gap-6 md:gap-8 pl-6 md:pl-10 pr-[10vw] motion-reduce:flex-wrap motion-reduce:h-auto motion-reduce:py-24">
          <div className="shrink-0 w-[80vw] md:w-[38vw] pr-6">
            <div className="text-[13px] font-semibold text-[#0071E3] mb-5">One system</div>
            <h2 className="text-[clamp(2.4rem,5vw,4.8rem)] font-semibold tracking-[-0.05em] leading-[0.98]">Six roles.<br />One source<br />of truth.</h2>
            <p className="mt-6 text-[17px] text-[#515154] max-w-md leading-relaxed">The same patient record, scoped to what each person in the building needs to see.</p>
          </div>
          {ROLES.map((r) => (
            <article key={r.n} data-cursor="Scroll" className="shrink-0 w-[80vw] md:w-[30vw] h-[62vh] rounded-[28px] bg-[#F5F5F7] p-7 md:p-9 flex flex-col justify-between">
              <div>
                <div className="text-[13px] text-[#6E6E73] tabular-nums mb-10">{r.n}</div>
                <h3 className="text-[clamp(2rem,3.4vw,3.2rem)] font-semibold tracking-[-0.04em] leading-none mb-5">{r.role}</h3>
                <p className="text-[16px] text-[#515154] leading-relaxed">{r.line}</p>
              </div>
              <div className="rounded-2xl bg-white p-2 shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
                {r.rows.map(([k, v, hot]) => (
                  <div key={k} className={`flex items-center justify-between rounded-xl px-3.5 py-2.5 text-[14px] ${hot ? 'bg-[#E8F2FD]' : ''}`}>
                    <span className={`flex items-center gap-2 ${hot ? 'font-semibold' : 'text-[#515154]'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${hot ? 'bg-[#0071E3] animate-pulse' : 'bg-black/15'}`} />{k}
                    </span>
                    <span className={`tabular-nums ${hot ? 'text-[#0071E3] font-semibold' : 'text-[#6E6E73]'}`}>{v}</span>
                  </div>
                ))}
              </div>
              <div className="inline-flex self-start items-center gap-2 rounded-full bg-white px-4 py-2.5 text-[13px] font-medium shadow-[0_1px_2px_rgba(0,0,0,0.05)]">
                <Sparkles size={14} className="text-[#0071E3]" /> {r.chip}
              </div>
            </article>
          ))}
        </div>
      </section>

      {/* ── 5. Safety ───────────────────────────────────────── */}
      <section id="safety" className="ch-safety theatre film-grain relative py-[22vh]">
        <div className="max-w-[1200px] mx-auto px-6 md:px-10">
          <div className="text-[13px] font-semibold text-[#2997FF] mb-8">Safety</div>
          <p className="safety-line text-[clamp(1.8rem,4.2vw,3.9rem)] font-semibold tracking-[-0.04em] leading-[1.12]">{SAFETY_LINE}</p>

          <div className="mt-[14vh] grid grid-cols-1 md:grid-cols-3 gap-px bg-white/10 rounded-[28px] overflow-hidden">
            {[
              { t: 'Blind read first', d: 'Radiology findings come from the image alone; the notes are withheld until after, so the AI can’t invent a finding that fits the story.' },
              { t: 'Uncertainty is visible', d: 'Every extraction carries a confidence. Low-confidence values are flagged for review against the original, never filed silently.' },
              { t: 'A human signs off', d: 'Findings stay suggestions until a doctor accepts them — attributed, with their name on it, in a tamper-evident audit trail.' },
            ].map((p) => (
              <div key={p.t} className="principle bg-black p-8 md:p-10">
                <h3 className="text-[22px] font-semibold tracking-[-0.03em] mb-4">{p.t}</h3>
                <p className="t-2 text-[15px] leading-relaxed">{p.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── 6. Facts + CTA ──────────────────────────────────── */}
      <section className="relative bg-[#F5F5F7] text-[#1D1D1F] py-[16vh]">
        <div className="max-w-[1400px] mx-auto px-6 md:px-10 grid grid-cols-1 md:grid-cols-3 gap-12">
          {FACTS.map(f => (
            <div key={f.l}>
              <div className="count text-[clamp(5rem,12vw,11rem)] font-semibold leading-none tracking-[-0.06em] tabular-nums" data-to={f.v}>{f.v}</div>
              <div className="text-[15px] text-[#515154] mt-3">{f.l}</div>
            </div>
          ))}
        </div>
        <div className="mt-[12vh] overflow-hidden border-y border-black/5 py-6" aria-hidden="true">
          <div className="marquee-track">
            {[0, 1].map(k => (
              <div key={k} className="flex shrink-0 items-center gap-12 pr-12">
                {['Reception', 'Doctor', 'Atlas', 'Laboratory', 'Radiology', 'Ward', 'Discharge', 'Management', 'Patient'].map(w => (
                  <span key={w + k} className="text-[clamp(2rem,4vw,3.4rem)] font-semibold tracking-[-0.04em] text-[#1D1D1F]/15 whitespace-nowrap">{w} <span className="text-[#0071E3]/40">·</span></span>
                ))}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="ch-cta theatre film-grain relative min-h-screen flex items-center overflow-hidden">
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(45% 45% at 50% 60%, rgba(0,113,227,0.25), transparent 70%)' }} />
        <div className="relative max-w-[1400px] mx-auto px-6 md:px-10 w-full text-center">
          <h2 className="cta-title text-[clamp(3rem,9vw,9rem)] font-semibold tracking-[-0.055em] leading-[0.95]">
            Practice medicine.<br /><span className="text-gradient-blue">We’ll hold the record.</span>
          </h2>
          <button type="button" onClick={enter} data-magnetic data-cursor="Enter"
            className="mt-14 inline-flex items-center gap-3 h-16 px-9 rounded-full bg-white text-black text-[17px] font-semibold hover:bg-[#2997FF] hover:text-white">
            Enter Vela <ArrowUpRight size={19} />
          </button>
          <div className="mt-6 t-3 text-[13px]">Demo accounts available on the sign-in screen.</div>
        </div>
      </section>

      <footer className="theatre border-t border-white/10">
        <div className="max-w-[1400px] mx-auto px-6 md:px-10 py-10 flex flex-col md:flex-row gap-4 justify-between text-[13px] t-3">
          <span className="text-white font-semibold text-[16px] tracking-[-0.03em]">Vela</span>
          <span>© 2026 Vela Medical Intelligence</span>
          <span>Decision support · Not a diagnostic device</span>
        </div>
      </footer>

    </div>
  )
}
