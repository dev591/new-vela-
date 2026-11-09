// Voice front desk kiosk: a patient taps the mic, speaks Hindi / Hinglish / English, and is
// checked in. Public page (no sign-in). Flow:
//   mic -> Prisma (transcript)  ->  cached filler plays at once  ->  /checkin streams the spoken
//   reply sentence by sentence  ->  token number on screen and in the receptionist's queue.
import { useCallback, useEffect, useRef, useState } from 'react'
import { Mic, Loader2, Siren, CheckCircle2 } from 'lucide-react'
import { API_URL } from '../utils/config'
import useVoiceInput from '../hooks/useVoiceInput'

type Phase = 'idle' | 'listening' | 'thinking' | 'done' | 'error'
interface Ticket { token: number; ticket_number: string; queue_position: number }
type Clips = Record<string, AudioBuffer>   // language -> decoded cached clip

// Plays clips through the Web Audio API. Each clip is scheduled to start exactly when the previous
// one ends, so there is no gap between sentences, and a cached clip starts within a few milliseconds.
class Player {
  private ctx = new AudioContext()
  private nextAt = 0                                 // when the clip queue is free again (ctx.currentTime)
  private sources: AudioBufferSourceNode[] = []
  onPlaying?: (tag: string) => void
  resume() { return this.ctx.state === 'suspended' ? this.ctx.resume() : Promise.resolve() }   // needs a tap first
  async decode(b64: string): Promise<AudioBuffer> {       // base64 mp3 from the server -> playable audio
    return this.ctx.decodeAudioData(Uint8Array.from(atob(b64), c => c.charCodeAt(0)).buffer)
  }
  play(buf: AudioBuffer, tag: string) {
    const src = this.ctx.createBufferSource(); src.buffer = buf; src.connect(this.ctx.destination)
    const at = Math.max(this.ctx.currentTime + 0.01, this.nextAt)    // right now, or right after the last clip
    src.start(at); this.nextAt = at + buf.duration; this.sources.push(src)
    setTimeout(() => this.onPlaying?.(tag), Math.max(0, (at - this.ctx.currentTime) * 1000))
  }
  chime() {                                          // soft two-tone "I heard you", plays the instant you stop talking
    const t = this.ctx.currentTime, osc = this.ctx.createOscillator(), g = this.ctx.createGain()
    osc.connect(g); g.connect(this.ctx.destination)
    osc.frequency.setValueAtTime(660, t); osc.frequency.setValueAtTime(880, t + 0.07)
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.01)
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16)
    osc.start(t); osc.stop(t + 0.17)
  }
  clear() { this.sources.forEach(s => { try { s.stop() } catch { /* already finished */ } }); this.sources = []; this.nextAt = 0 }
}

const COPY: Record<string, string> = { 'hi-IN': 'बोलिए', 'hi-en': 'Boliye', 'en-IN': 'Speak' }

export default function FrontDesk() {
  const [phase, setPhase] = useState<Phase>('idle')
  const [transcript, setTranscript] = useState('')
  const [emergency, setEmergency] = useState(false)
  const [ticket, setTicket] = useState<Ticket | null>(null)
  const [symptom, setSymptom] = useState('')
  const [message, setMessage] = useState('')
  const [timings, setTimings] = useState<Record<string, number> | null>(null)
  const fillers = useRef<Clips>({})
  const acks = useRef<Clips>({})
  const player = useRef<Player | null>(null)
  if (!player.current) player.current = new Player()
  const marks = useRef<Record<string, number>>({})   // performance.now() marks for the latency log
  const debug = new URLSearchParams(window.location.search).has('debug')

  // On page load: ask the server to open its Gnani/OpenAI connections and send the cached clips.
  useEffect(() => {
    const p = player.current!
    fetch(`${API_URL}/api/frontdesk/warm`).then(r => r.json()).then(async d => {
      for (const [l, c] of Object.entries<{ audio: string }>(d.fillers || {})) fillers.current[l] = await p.decode(c.audio)
      for (const [l, c] of Object.entries<{ audio: string }>(d.emergency_acks || {})) acks.current[l] = await p.decode(c.audio)
    }).catch(() => { /* kiosk still works without cached clips, just less instantly */ })
    p.onPlaying = (tag) => {                       // latency log: when does sound actually start?
      const m = marks.current, now = performance.now()
      if (tag === 'filler' && !m.fillerPlaying) m.fillerPlaying = now
      if (tag === 'reply' && !m.replyPlaying) m.replyPlaying = now
      if (!m.firstSound) { m.firstSound = now; report() }
    }
    return () => p.clear()
  }, [])

  // Print the timings the user asked for (record end -> Prisma -> sound) once the first sound starts.
  const report = () => {
    const m = marks.current
    if (!m.recordEnd) return
    const t = (a: number, b: number) => (a && b ? Math.round(b - a) : null)
    const row = {
      'record end -> Prisma back (ms)': t(m.recordEnd, m.prismaDone),
      'Prisma back -> first sound (ms)': t(m.prismaDone, m.firstSound),
      'record end -> first sound (ms)': t(m.recordEnd, m.firstSound),
    }
    console.table(row)
    setTimings(prev => ({ ...(prev || {}), ...(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, v ?? 0]))) }))
  }

  // Read the server-sent events from /checkin and queue each spoken sentence as it arrives.
  const checkin = useCallback(async (text: string, skipAck: boolean) => {
    const res = await fetch(`${API_URL}/api/frontdesk/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript: text, skip_ack: skipAck }),
    })
    if (res.status === 429) throw new Error('Please wait a moment and try again.')
    if (!res.ok || !res.body) throw new Error('Please see the reception desk.')
    const reader = res.body.getReader(), dec = new TextDecoder()
    let buf = ''
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      const parts = buf.split('\n\n'); buf = parts.pop() || ''
      for (const part of parts) {
        if (!part.startsWith('data: ')) continue
        const e = JSON.parse(part.slice(6))
        if (e.type === 'meta') setEmergency(e.emergency)
        else if (e.type === 'audio') {
          if (!marks.current.firstReplyEvent) marks.current.firstReplyEvent = performance.now()
          player.current!.play(await player.current!.decode(e.audio), 'reply')
        } else if (e.type === 'ticket') setTicket({ token: e.token, ticket_number: e.ticket_number, queue_position: e.queue_position })
        else if (e.type === 'extract') setSymptom(e.symptom || '')
        else if (e.type === 'timings') { console.log('[frontdesk] server timings', e); setTimings(p => ({ ...(p || {}), ...e })) }
        else if (e.type === 'error') throw new Error(e.message)
      }
    }
  }, [])

  const voice = useVoiceInput({
    kiosk: true,
    silenceMs: 600,                                 // a shorter pause ends the recording: sound starts sooner
    onRecordEnd: () => player.current!.chime(),     // instant "heard you" before Prisma even answers
    onError: (m) => { setMessage(m); setPhase('error') },
    onTranscript: async (text, _lang, x) => {
      marks.current = { recordEnd: x.recordEnd, prismaDone: x.prismaDone }
      setTranscript(text); setEmergency(x.emergency); setPhase('thinking')
      // Play a cached clip THIS instant: the urgent line for emergencies, a "one moment" filler otherwise.
      const clip = (x.emergency ? acks.current : fillers.current)[x.replyLanguage]
      if (clip) player.current!.play(clip, x.emergency ? 'reply' : 'filler')
      try {
        await checkin(text, x.emergency && !!clip)
        setPhase('done')
      } catch (e) { setMessage((e as Error).message); setPhase('error') }
    },
  })

  const reset = () => {
    player.current!.clear(); setPhase('idle'); setTranscript(''); setTicket(null)
    setEmergency(false); setSymptom(''); setMessage(''); setTimings(null)
  }
  const onMic = () => {
    if (voice.listening) { voice.stop(); return }
    if (phase === 'thinking' || voice.processing) return
    reset(); setPhase('listening'); void player.current!.resume(); void voice.start()   // the tap lets audio play
  }

  const listening = voice.listening
  const busy = voice.processing || phase === 'thinking'
  const ring = listening ? 1 + Math.min(voice.level * 6, 0.45) : 1
  const accent = emergency ? 'var(--danger)' : 'var(--brand)'

  return (
    <main style={{ minHeight: '100vh', background: 'var(--canvas, #F5F5F7)', display: 'flex', flexDirection: 'column',
                   alignItems: 'center', justifyContent: 'center', padding: '24px 16px', gap: 24, textAlign: 'center' }}>
      <header>
        <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--brand)', letterSpacing: 0.2 }}>VELA Front Desk</div>
        <h1 style={{ fontSize: 34, fontWeight: 700, margin: '8px 0 4px' }}>
          {phase === 'done' && ticket ? 'You are checked in' : 'Tap the mic and tell us why you are here'}
        </h1>
        <p style={{ fontSize: 18, color: 'var(--ink-2, #6e6e73)', margin: 0 }}>
          {Object.values(COPY).join(' · ')} — Hindi, Hinglish or English
        </p>
      </header>

      {emergency && (
        <div role="alert" style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'var(--danger-light)',
                                   border: '2px solid var(--danger)', color: 'var(--danger)', borderRadius: 16,
                                   padding: '14px 20px', fontSize: 20, fontWeight: 700 }}>
          <Siren size={26} /> Emergency: our staff are being alerted now
        </div>
      )}

      <button onClick={onMic} aria-label={listening ? 'Stop and send' : 'Start speaking'}
              disabled={busy}
              style={{ width: 168, height: 168, borderRadius: '50%', border: 'none', cursor: busy ? 'default' : 'pointer',
                       background: accent, color: '#fff', display: 'grid', placeItems: 'center',
                       boxShadow: `0 0 0 ${listening ? 14 : 0}px color-mix(in srgb, ${accent} 20%, transparent), var(--shadow-lg)`,
                       transform: `scale(${ring})`, transition: 'transform 80ms linear, box-shadow 200ms' }}>
        {busy ? <Loader2 size={64} className="animate-spin" /> : <Mic size={72} />}
      </button>

      <div aria-live="polite" style={{ minHeight: 28, fontSize: 18, color: 'var(--ink-2, #6e6e73)' }}>
        {phase === 'idle' && 'Ready'}
        {phase === 'listening' && (listening ? 'Listening… tap again when you are done' : 'Allow the microphone…')}
        {phase === 'thinking' && 'One moment…'}
        {phase === 'error' && <span style={{ color: 'var(--danger)' }}>{message}</span>}
      </div>

      {transcript && (
        <blockquote style={{ maxWidth: 560, margin: 0, background: 'var(--surface-color, #fff)', borderRadius: 16,
                             padding: '14px 18px', fontSize: 20, boxShadow: 'var(--shadow-sm)' }}>
          “{transcript}”{symptom && <div style={{ fontSize: 14, color: 'var(--ink-2, #6e6e73)', marginTop: 6 }}>Noted: {symptom}</div>}
        </blockquote>
      )}

      {ticket && (
        <section style={{ background: 'var(--surface-color, #fff)', borderRadius: 24, padding: '24px 40px',
                          boxShadow: 'var(--shadow-md)', border: `2px solid ${accent}` }}>
          <CheckCircle2 size={28} color={accent} />
          <div style={{ fontSize: 18, color: 'var(--ink-2, #6e6e73)' }}>Your token number</div>
          <div style={{ fontSize: 88, fontWeight: 800, lineHeight: 1, color: accent }}>{ticket.token}</div>
          <div style={{ fontSize: 18 }}>{emergency ? 'Staff will see you first.' : 'Please take a seat near reception.'}</div>
        </section>
      )}

      {(phase === 'done' || phase === 'error') && (
        <button onClick={reset} style={{ minHeight: 52, padding: '0 28px', borderRadius: 14, border: '1px solid var(--line, #d2d2d7)',
                                         background: 'var(--surface-color, #fff)', fontSize: 18, fontWeight: 600, cursor: 'pointer' }}>
          New check-in
        </button>
      )}

      <footer style={{ fontSize: 13, color: 'var(--ink-3, #86868b)', maxWidth: 520 }}>
        This desk only checks you in and alerts staff. It does not give medical advice.
        {debug && timings && <pre style={{ textAlign: 'left', marginTop: 12 }}>{JSON.stringify(timings, null, 1)}</pre>}
      </footer>
    </main>
  )
}
