import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { gsap } from 'gsap'
import { ScrollTrigger } from 'gsap/ScrollTrigger'
import { SplitText } from 'gsap/SplitText'
import { ArrowRight, FileText, Mic, Play } from 'lucide-react'
import FlightWorld, { initialFlight, type FlightState } from '../components/film/FlightWorld'
import FilmPlayer, { type Chapter, type FilmPlayerHandle } from '../components/film/FilmPlayer'
import useLenis from '../components/film/useLenis'
import CinematicCursor from '../components/cinematic/CinematicCursor'

gsap.registerPlugin(ScrollTrigger, SplitText)

/**
 * VELA landing — a one-minute flight through a 3D world, not a page.
 *
 * Nothing scrolls past. A full-screen WebGL world (FlightWorld) fills the
 * frame, and scroll (or the Play button) moves a playhead through one
 * 60-second GSAP timeline. The timeline does two things at once:
 *
 *   1. writes numbers into `flight` (camera position, vortex progress…),
 *      which the 3D world reads every frame, and
 *   2. cuts the type on top of it in and out, scene by scene.
 *
 *   00:00 Opening     adrift among a patient's loose papers, films and pills
 *   00:05 The pieces  the camera flies through them
 *   00:13 The record  everything spirals into one record
 *   00:24 Atlas       a liquid orb answers out loud
 *   00:36 Six roles   the camera turns inside a ring of six monoliths
 *   00:48 Safety      the zero: a ring the camera flies through
 *   00:55 Enter       the Vela star, and the way in
 *
 * With prefers-reduced-motion there is no 3D and no pinning: the scenes stack
 * as a plain, complete page (see the .film block in index.css). Every patient
 * detail shown is the seeded synthetic demo record.
 */

const TOTAL = 60 // film length in seconds
const SPEED = 1.15 // film seconds per real second while playing
const SCROLL_PER_SECOND = 17 // svh of scroll per film second

const CHAPTERS: Chapter[] = [
  { name: 'Opening', start: 0, end: 5 },
  { name: 'The pieces', start: 5, end: 13 },
  { name: 'The record', start: 13, end: 24 },
  { name: 'Atlas', start: 24, end: 36 },
  { name: 'Six roles', start: 36, end: 48 },
  { name: 'Safety', start: 48, end: 55 },
  { name: 'Enter', start: 55, end: 60 },
]

// Where the nav links land: the moment each scene has finished arriving.
const NAV = [
  { label: 'Record', at: 21.5 },
  { label: 'Atlas', at: 28.6 },
  { label: 'Roles', at: 39.4 },
  { label: 'Safety', at: 52.6 },
]

const PIECES = [
  'A lab PDF from Tuesday.',
  'A note nobody can read.',
  'A scan in another department.',
]

const ATLAS = [
  { q: 'What was his last potassium?', a: '2.8 mEq/L. Critically low.', src: 'Blood_Report.pdf' },
  { q: 'Is he on anything that could cause that?', a: 'Furosemide, since six days.', src: 'Prescription · 22 Oct' },
  { q: 'Any allergies before I prescribe?', a: 'Penicillin.', src: 'Registration' },
]

const ROLES = [
  { role: 'Reception', line: 'Registers a walk-in in under a minute and puts emergencies at the front of the queue.', chip: 'Emergency goes first',
    rows: [['TKT-0142', 'Emergency', true], ['TKT-0139', '15 min', false], ['TKT-0140', '30 min', false]] },
  { role: 'Doctor', line: 'Calls the next patient and has the whole history, summarised, before they sit down.', chip: 'Atlas summary ready',
    rows: [['Rajesh Kumar', 'Now', true], ['Anita Rao', 'Next', false], ['M. Iyer', 'Waiting', false]] },
  { role: 'Laboratory', line: 'Works only paid, arrived orders, and files a report that flags its own critical values.', chip: 'Flagged to the doctor',
    rows: [['Potassium', '2.8', true], ['Sodium', '138', false], ['Creatinine', '1.1', false]] },
  { role: 'Ward', line: 'Scans a bed QR to admit, track the stay and price the discharge.', chip: 'ICU · Day 3',
    rows: [['Bed 4', 'Occupied', true], ['Bed 5', 'Available', false], ['Bed 6', 'Cleaning', false]] },
  { role: 'Management', line: 'Sees beds, staff and throughput live, and who opened which record.', chip: 'Audit trail intact',
    rows: [['Beds', '18 / 24', true], ['Staff online', '11', false], ['Audit chain', 'Intact', false]] },
  { role: 'Patient', line: 'Books without an account, pays for tests, and hears “it’s your turn” on their phone.', chip: 'You are next in line',
    rows: [['Your turn', 'Room 3', true], ['Lab tests', 'Paid', false], ['Report', 'Ready', false]] },
] as const

const PRINCIPLES = [
  { t: 'Scans are read blind', d: 'Findings come from the image alone. The notes stay hidden until after.' },
  { t: 'Doubt is shown', d: 'Every extracted value carries a confidence. Low ones are flagged, never filed quietly.' },
  { t: 'A doctor signs off', d: 'Suggestions stay suggestions until a named clinician accepts them.' },
]

export default function LandingPage() {
  const navigate = useNavigate()
  const root = useRef<HTMLDivElement>(null)
  const track = useRef<HTMLDivElement>(null)
  const wipe = useRef<HTMLDivElement>(null)
  const player = useRef<FilmPlayerHandle>(null)
  const flight = useRef<FlightState>(initialFlight()) // what the 3D world reads
  const now = useRef(0) // playhead, in film seconds
  const playingRef = useRef(false)
  const playPos = useRef(0)
  const [playing, setPlaying] = useState(false)

  const lenis = useLenis()

  // ── Playhead ──────────────────────────────────────────────────────
  const maxScroll = () => (track.current ? track.current.offsetHeight - window.innerHeight : 0)
  const scrollToY = useCallback((y: number) => {
    if (lenis.current) lenis.current.scrollTo(y, { immediate: true, force: true })
    else window.scrollTo(0, y)
  }, [lenis])

  const pause = useCallback(() => { playingRef.current = false; setPlaying(false) }, [])
  const play = useCallback(() => {
    const ended = now.current >= TOTAL - 0.05
    if (ended) scrollToY(0) // replay from the top
    playPos.current = ended ? 0 : window.scrollY
    playingRef.current = true
    setPlaying(true)
  }, [scrollToY])
  const seek = useCallback((seconds: number, thenPlay = false) => {
    const y = (seconds / TOTAL) * maxScroll()
    scrollToY(y)
    if (thenPlay) { playPos.current = y; playingRef.current = true; setPlaying(true) } else pause()
  }, [pause, scrollToY])

  // Playing = moving the scroll position at a steady rate, one frame at a time.
  useEffect(() => {
    const tick = (_time: number, deltaMs: number) => {
      if (!playingRef.current) return
      const max = maxScroll()
      playPos.current = Math.min(max, playPos.current + (deltaMs / 1000) * (SPEED / TOTAL) * max)
      scrollToY(playPos.current)
      if (playPos.current >= max) pause()
    }
    gsap.ticker.add(tick)
    // Any scroll gesture hands control back to the viewer.
    const onKey = (e: KeyboardEvent) => { if (/^(Arrow|Page|Home|End)/.test(e.key)) pause() }
    window.addEventListener('wheel', pause, { passive: true })
    window.addEventListener('touchmove', pause, { passive: true })
    window.addEventListener('keydown', onKey)
    return () => {
      gsap.ticker.remove(tick)
      window.removeEventListener('wheel', pause)
      window.removeEventListener('touchmove', pause)
      window.removeEventListener('keydown', onKey)
    }
  }, [pause, scrollToY])

  // Leave through an iris that grows from the button. Black, because the
  // sign-in page opens by fading in from black, so the two meet without a cut.
  const enter = (e?: React.MouseEvent) => {
    pause()
    const el = wipe.current
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { navigate('/login'); return }
    const x = e ? e.clientX : window.innerWidth / 2
    const y = e ? e.clientY : window.innerHeight / 2
    gsap.set(el, { display: 'block', clipPath: `circle(0px at ${x}px ${y}px)` })
    gsap.to(el, { clipPath: `circle(150vmax at ${x}px ${y}px)`, duration: 0.8, ease: 'power3.inOut', onComplete: () => { navigate('/login') } })
  }

  // ── The film ──────────────────────────────────────────────────────
  useEffect(() => {
    const mm = gsap.matchMedia()
    const ctx = gsap.context(() => {
      mm.add('(prefers-reduced-motion: no-preference)', () => {
        const f = flight.current
        Object.assign(f, initialFlight())

        // Opening titles (play once, not tied to scroll).
        const heroChars = SplitText.create('.hero-line', { type: 'chars' }).chars
        gsap.timeline()
          .fromTo('.title-word', { yPercent: 110 }, { yPercent: 0, duration: 0.9, ease: 'power4.out' })
          .to('.title-word', { yPercent: -110, duration: 0.6, ease: 'power4.in' }, '+=0.3')
          .to('.title-card', { autoAlpha: 0, duration: 0.9, ease: 'power2.inOut' }, '-=0.1')
          .set('.title-card', { display: 'none' })
          .fromTo(heroChars, { yPercent: 120, rotate: 8 }, { yPercent: 0, rotate: 0, duration: 1.1, stagger: 0.022, ease: 'power4.out' }, '-=0.7')
          // fromTo, not from: buttons carry a CSS opacity transition (see index.css).
          .fromTo('.hero-foot > *, .nav-in, .film-player', { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.8, stagger: 0.07, ease: 'power3.out' }, '-=0.6')

        // Scenes after the first start hidden; the timeline cuts them in.
        gsap.set('.sc-pieces, .sc-record, .sc-atlas, .sc-roles, .sc-safety, .sc-end', { autoAlpha: 0 })

        const tl = gsap.timeline({
          defaults: { ease: 'power2.out' },
          scrollTrigger: {
            trigger: track.current,
            start: 'top top',
            end: 'bottom bottom',
            scrub: 0.6,
            onUpdate: (self) => {
              now.current = self.progress * TOTAL
              player.current?.update(now.current)
            },
          },
        })
        /** Tween one number of the 3D world between two film times. */
        const fly = (prop: keyof FlightState, to: number, from: number, until: number, ease = 'power2.inOut') =>
          tl.to(f, { [prop]: to, duration: until - from, ease }, from)
        /** A masked line (or lines) that rises in. */
        const rise = (sel: string, at: number) =>
          tl.fromTo(sel, { yPercent: 118 }, { yPercent: 0, duration: 0.9, stagger: 0.14, ease: 'power3.out' }, at)

        // ── Camera: one continuous move down the flight line ──
        fly('pz', 8.6, 0, 5, 'none') // drifting among the pieces
        fly('pz', -24, 5, 13, 'power1.inOut') // through them
        fly('roll', 0.14, 5, 8, 'sine.inOut')
        fly('roll', -0.1, 8, 11, 'sine.inOut')
        fly('roll', 0, 11, 13.5, 'sine.inOut')
        fly('pz', -37, 13, 19, 'power2.out') // up to the record
        fly('pz', -61, 23.8, 28) // on to Atlas
        fly('pz', -100, 35.4, 38.4) // into the ring of roles
        fly('pz', -116, 46.6, 49.6) // out, up to the zero
        fly('pz', -141, 54, 57.8) // through it, to the star

        // 00:00 Opening — the camera flies through the headline.
        tl.to('.hero-title', { scale: 2.6, autoAlpha: 0, duration: 3, ease: 'power2.in' }, 1.6)
          .to('.hero-foot', { autoAlpha: 0, y: -24, duration: 1, ease: 'power2.in' }, 1)
          .set('.sc-hero', { autoAlpha: 0 }, 4.7)

        // 00:05 The pieces — named one by one as they fly past.
        tl.set('.sc-pieces', { autoAlpha: 1 }, 4.8)
        gsap.utils.toArray<HTMLElement>('.piece > span').forEach((el, i) => {
          const at = 5.3 + i * 2.5
          tl.fromTo(el, { yPercent: 118 }, { yPercent: 0, duration: 0.6, ease: 'power3.out' }, at)
            .to(el, { yPercent: -118, duration: 0.5, ease: 'power2.in' }, at + 1.9)
        })
        tl.set('.sc-pieces', { autoAlpha: 0 }, 13)

        // 00:13 The record — vortex, flash, slab.
        fly('vortex', 1, 13, 18.6, 'none')
        fly('slab', 1, 17.4, 19.4, 'none')
        fly('flash', 1, 17.6, 19.4, 'power2.out')
        tl.set('.sc-record', { autoAlpha: 1 }, 18.4)
        rise('.rec-line > span', 18.6)
        tl.fromTo('.rec-sub', { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.8 }, 19.6)
          .to('.sc-record', { autoAlpha: 0, y: -40, duration: 0.9, ease: 'power2.in' }, 23)
        fly('slabExit', 1, 23.4, 26.4)

        // 00:24 Atlas — one question and its answer at a time.
        fly('orbIn', 1, 25.2, 27.2, 'none')
        tl.set('.sc-atlas', { autoAlpha: 1 }, 24.6)
        rise('.at-line > span', 24.8)
        gsap.utils.toArray<HTMLElement>('.qa').forEach((el, i, all) => {
          const at = 26.2 + i * 2.9
          tl.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.01 }, at)
            .fromTo(el.querySelector('.qa-q'), { autoAlpha: 0, y: 16 }, { autoAlpha: 1, y: 0, duration: 0.5 }, at)
            .fromTo(el.querySelector('.qa-a > span'), { yPercent: 118 }, { yPercent: 0, duration: 0.7, ease: 'power3.out' }, at + 0.8)
            .fromTo(el.querySelector('.qa-src'), { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.4 }, at + 1.3)
            // The orb swells while it answers.
            .to(f, { orbAmp: 1.5, duration: 0.4, ease: 'power2.out' }, at + 0.8)
            .to(f, { orbAmp: 0.3, duration: 1.1, ease: 'power2.inOut' }, at + 1.2)
          if (i < all.length - 1) tl.to(el, { autoAlpha: 0, y: -20, duration: 0.4, ease: 'power2.in' }, at + 2.5)
        })
        tl.to('.sc-atlas', { autoAlpha: 0, y: -40, duration: 0.9, ease: 'power2.in' }, 34.6)

        // 00:36 Six roles — the camera turns to face each monolith in turn.
        tl.set('.sc-roles', { autoAlpha: 1 }, 35.8)
        rise('.ro-line > span', 36)
        tl.to('.roles-title', { autoAlpha: 0, y: -30, duration: 0.6, ease: 'power2.in' }, 38)
        gsap.utils.toArray<HTMLElement>('.role-cap').forEach((el, i) => {
          const at = 38.2 + i * 1.4
          fly('theta', 210 + i * 60, at, at + 0.7)
          tl.fromTo(el, { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: 0.3 }, at + 0.62)
            .to(el, { autoAlpha: 0, y: -20, duration: 0.2, ease: 'power2.in' }, at + 1.32)
        })
        fly('theta', 540, 46.6, 47.5) // a full turn: facing forward again

        // 00:48 Safety — the ring is the zero.
        tl.set('.sc-safety', { autoAlpha: 1 }, 48.2)
        rise('.sf-line > span', 48.4)
        tl.fromTo('.sf-say', { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.7 }, 49)
          .fromTo('.sf-zero', { autoAlpha: 0, scale: 0.9 }, { autoAlpha: 1, scale: 1, duration: 0.8 }, 49.4)
          .fromTo('.sf-rule', { autoAlpha: 0, y: 30 }, { autoAlpha: 1, y: 0, duration: 0.7, stagger: 0.6 }, 50)
          .to('.sc-safety', { autoAlpha: 0, scale: 1.25, duration: 0.9, ease: 'power2.in' }, 53.8)

        // 00:55 Enter — end card.
        fly('starIn', 1, 55.4, 57.6, 'none')
        tl.set('.sc-end', { autoAlpha: 1 }, 55.2)
        rise('.en-line > span', 55.8)
        tl.fromTo('.en-cta > *', { autoAlpha: 0, y: 18 }, { autoAlpha: 1, y: 0, duration: 0.7, stagger: 0.12 }, 56.9)
          .fromTo('.en-credits > *', { autoAlpha: 0, y: 12 }, { autoAlpha: 1, y: 0, duration: 0.6, stagger: 0.1 }, 57.5)
          .to({}, { duration: 0.01 }, TOTAL - 0.01) // pad the timeline to exactly one minute
      })
    }, root)

    return () => { mm.revert(); ctx.revert() }
  }, [])

  return (
    <div ref={root} className="film">
      <CinematicCursor />
      <div ref={wipe} className="film-wipe" aria-hidden="true" />

      {/* Opening title card */}
      <div className="title-card" aria-hidden="true">
        <span className="mask"><span className="title-word f-display">Vela</span></span>
      </div>

      <header className="film-nav">
        <button type="button" className="nav-in film-wordmark f-display" onClick={() => seek(0)} data-cursor="Top">Vela</button>
        <nav className="nav-in film-links" aria-label="Chapters">
          {NAV.map((n) => (
            <button key={n.label} type="button" onClick={() => seek(n.at)}>{n.label}</button>
          ))}
        </nav>
        <button type="button" onClick={enter} data-magnetic data-cursor="Enter" className="nav-in btn btn-ink">
          Sign in <ArrowRight size={16} />
        </button>
      </header>

      <main ref={track} className="film-track" style={{ height: `${TOTAL * SCROLL_PER_SECOND}svh` }}>
        <div className="film-stage">
          <FlightWorld flight={flight} roles={ROLES} className="film-canvas" />

          {/* ── 00:00 Opening ── */}
          <section className="scene sc-hero">
            <h1 className="hero-title f-hero">
              <span className="mask"><span className="hero-line">Every patient</span></span>
              <span className="mask"><span className="hero-line">arrives in pieces.</span></span>
            </h1>
            <div className="hero-foot">
              <p className="f-lead">
                Vela is the hospital record system that joins every report, scan and note into one patient record, and answers questions about it out loud.
              </p>
              <div className="hero-actions">
                <button type="button" className="btn btn-accent btn-lg" onClick={play} data-magnetic data-cursor="Play">
                  <Play size={18} fill="currentColor" strokeWidth={0} /> Play the film
                </button>
                <span className="f-small">One minute. Or scroll to fly at your own pace.</span>
                {/* The voice kiosk is public: no sign-in, so anyone can try it straight from here. */}
                <button type="button" className="btn btn-ink" onClick={() => navigate('/frontdesk')} data-magnetic data-cursor="Speak">
                  <Mic size={16} /> Try the voice front desk
                </button>
                <span className="f-small">Check in by speaking Hindi, Hinglish or English. Speech by Gnani Prisma and Timbre.</span>
              </div>
            </div>
          </section>

          {/* ── 00:05 The pieces ── */}
          <section className="scene sc-pieces" aria-label="The pieces">
            {PIECES.map((p) => <p key={p} className="piece mask f-head"><span>{p}</span></p>)}
          </section>

          {/* ── 00:13 The record ── */}
          <section className="scene sc-record" aria-labelledby="rec-title">
            <div className="copy">
              <h2 id="rec-title" className="f-head">
                <span className="mask rec-line"><span>One record.</span></span>
                <span className="mask rec-line"><span>Assembled in seconds.</span></span>
              </h2>
              <p className="rec-sub f-lead">Lab values, scans, prescriptions and voice notes, filed against one patient and scored for risk.</p>
            </div>
          </section>

          {/* ── 00:24 Atlas ── */}
          <section className="scene sc-atlas" aria-labelledby="at-title">
            <div className="copy">
              <h2 id="at-title" className="f-head">
                <span className="mask at-line"><span>Ask out loud.</span></span>
                <span className="mask at-line"><span>Get the cited answer.</span></span>
              </h2>
              <div className="qas">
                {ATLAS.map((x) => (
                  <div key={x.q} className="qa">
                    <p className="qa-q f-lead"><Mic size={18} /> {x.q}</p>
                    <p className="qa-a mask f-answer"><span>{x.a}</span></p>
                    <p className="qa-src f-small"><FileText size={14} /> Source: {x.src}</p>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* ── 00:36 Six roles ── */}
          <section className="scene sc-roles" aria-labelledby="ro-title">
            <h2 id="ro-title" className="roles-title f-hero">
              <span className="mask ro-line"><span>Six roles.</span></span>
              <span className="mask ro-line"><span>One record.</span></span>
            </h2>
            <div className="role-caps">
              {ROLES.map((r) => (
                <article key={r.role} className="role-cap">
                  <h3>{r.role}</h3>
                  <p className="f-lead">{r.line}</p>
                </article>
              ))}
            </div>
          </section>

          {/* ── 00:48 Safety ── */}
          <section className="scene sc-safety" aria-labelledby="sf-title">
            <div className="sf-top">
              <h2 id="sf-title" className="f-head"><span className="mask sf-line"><span>Vela holds back.</span></span></h2>
              <p className="sf-say f-lead">A confident wrong answer is more dangerous than no answer. So nothing reaches a record until a clinician accepts it.</p>
            </div>
            <div className="sf-zero">
              <div className="f-role">Zero</div>
              <p>findings filed without a doctor</p>
            </div>
            <div className="sf-rules">
              {PRINCIPLES.map((p) => (
                <div key={p.t} className="sf-rule">
                  <h3>{p.t}</h3>
                  <p>{p.d}</p>
                </div>
              ))}
            </div>
          </section>

          {/* ── 00:55 Enter ── */}
          <section className="scene sc-end" aria-labelledby="en-title">
            <div className="copy">
              <h2 id="en-title" className="f-end">
                <span className="mask en-line"><span>Practice medicine.</span></span>
                <span className="mask en-line"><span>We’ll hold the record.</span></span>
              </h2>
              <div className="en-cta">
                <button type="button" onClick={enter} data-magnetic data-cursor="Enter" className="btn btn-accent btn-lg">
                  Enter Vela <ArrowRight size={18} />
                </button>
                <button type="button" onClick={() => navigate('/frontdesk')} data-magnetic data-cursor="Speak" className="btn btn-ink btn-lg">
                  <Mic size={18} /> Try the voice front desk
                </button>
                <span className="f-small">The voice front desk needs no sign-in. Speech by Gnani Prisma and Timbre.</span>
              </div>
            </div>
            <footer className="en-credits f-small">
              <span>© 2026 Vela Medical Intelligence</span>
              <span>Decision support. Not a diagnostic device.</span>
              <span>Every patient shown is synthetic demo data.</span>
            </footer>
          </section>
        </div>
      </main>

      <FilmPlayer ref={player} chapters={CHAPTERS} total={TOTAL} playing={playing}
        onToggle={() => (playing ? pause() : play())} onSeek={(s) => seek(s, true)} />
    </div>
  )
}
