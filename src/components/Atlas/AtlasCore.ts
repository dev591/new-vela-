import { API_URL } from "../../utils/config";
import { getUser } from "../../utils/auth";

export type AtlasState =
  | "sleeping"
  | "waking"
  | "listening"
  | "processing"
  | "streaming"
  | "speaking"
  | "error"

interface Callbacks {
  onState: (s: AtlasState) => void
  onAnswer: (q: string, a: string) => void
  onToken: (token: string) => void
  onError: (msg: string) => void
  userRole?: string
}

class AtlasCore {
  private recognition: any = null
  private isSpeaking = false
  private state: AtlasState = "sleeping"
  private patientId?: string
  private userRole: string = "doctor"
  private callbacks: Callbacks
  private SR: any = null
  private isHoldingSpace = false
  private currentAudio: HTMLAudioElement | null = null  // active TTS playback, so stop() can halt it
  private interrupted = false                            // set by stop() so speakAnswer bails out
  private speakResolve: (() => void) | null = null       // resolves a pending speak promise on interrupt
  private streamAbort: AbortController | null = null

  constructor(cb: Callbacks) {
    this.callbacks = cb
    this.userRole = cb.userRole || "doctor"
  }

  /** The logged-in staff member's id, used to scope the server-side session
   *  and to tell the backend whose active consult to answer about. */
  private get staffId(): string | undefined {
    return getUser()?.staff_id || localStorage.getItem("vela_staff_id") || undefined
  }

  /** Per-user session. This was hardcoded to "doctor_session_1", so every
   *  doctor on the deployment shared one server-side conversation — and
   *  overwrote each other's current patient. */
  private get sessionId(): string {
    return this.staffId ? `staff_${this.staffId}` : "anonymous_session"
  }

  private setState(s: AtlasState) {
    this.state = s
    this.callbacks.onState(s)
  }

  init() {
    const SR = (window as any).SpeechRecognition
              || (window as any).webkitSpeechRecognition

    if (!SR) {
      this.callbacks.onError("Use Chrome for voice")
      return
    }

    this.SR = SR
    this.setupSpacebar()
    this.setState("sleeping")
  }

  // Bound handlers kept as fields so destroy() can remove them — otherwise
  // React StrictMode's mount→cleanup→mount leaves zombie listeners that spawn
  // a second SpeechRecognition on every Space press (Chrome allows only one,
  // so voice input dies while typed input keeps working).
  // Tap-to-toggle (NOT hold-to-talk). The old hold model required holding Space
  // for the entire utterance and dropped the query if released early — which
  // read as "Space does nothing". Now: tap Space to start listening (recognition
  // auto-ends when you stop speaking and sends), tap again to cancel, or tap
  // while Atlas is talking to interrupt it. isHoldingSpace only debounces the
  // OS key-repeat so one physical press = one toggle.
  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code !== "Space" || this.isHoldingSpace) return
    const tag = (e.target as HTMLElement).tagName.toLowerCase()
    const isInput = tag === "input" || tag === "textarea" || tag === "select" ||
      (e.target as HTMLElement).isContentEditable
    if (isInput) return
    e.preventDefault()
    e.stopPropagation()
    this.isHoldingSpace = true
    if (this.isSpeaking || this.state === "speaking" || this.state === "streaming" || this.state === "processing") {
      this.stop()          // interrupt current answer/playback
    } else if (this.state === "listening") {
      this.stopListening() // finish and send
    } else {
      this.startListening()
    }
  }

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === "Space") this.isHoldingSpace = false
  }

  private setupSpacebar() {
    window.addEventListener("keydown", this.onKeyDown)
    window.addEventListener("keyup", this.onKeyUp)
  }

  private startListening() {
    if (this.isSpeaking) return

    // Never run two recognitions at once — Chrome errors the first one out.
    if (this.recognition) {
      try { this.recognition.abort() } catch {}
      this.recognition = null
    }

    const recognition = new this.SR()
    recognition.lang = "en-US"
    recognition.continuous = false
    recognition.interimResults = false
    recognition.maxAlternatives = 1

    let gotResult = false

    recognition.onstart = () => {
      this.setState("listening")
      console.log("[Atlas] listening started")
    }

    recognition.onresult = (e: any) => {
      gotResult = true
      const raw = e.results[0][0].transcript.trim().toLowerCase()
      console.log("[Atlas] heard:", raw)

      const query = raw
        .replace(/hey atlas[,\s]*/gi, "")
        .replace(/hateless[,\s]*/gi, "")
        .replace(/hatless[,\s]*/gi, "")
        .replace(/^atlas[,\s]*/gi, "")
        .trim()

      if (query.length > 1) {
        this.sendQuery(query)
      } else {
        this.setState("sleeping")
      }
    }

    recognition.onerror = (e: any) => {
      console.log("[Atlas] error:", e.error)
      gotResult = true // suppress the onend no-speech fallback below
      // Every failure mode must be visible — silent failures made voice look dead.
      const messages: Record<string, string> = {
        "not-allowed": "Microphone blocked. Allow in Chrome settings.",
        "service-not-allowed": "Microphone blocked. Allow in Chrome settings.",
        "no-speech": "I didn't hear anything — try again and speak clearly.",
        "audio-capture": "No microphone found. Check your input device.",
        "network": "Voice service unreachable. Chrome's speech engine needs internet, and browsers like Brave/Arc block it — use Google Chrome.",
      }
      const msg = messages[e.error]
      if (msg) this.callbacks.onError(msg)
      this.setState("sleeping")
    }

    recognition.onend = () => {
      console.log("[Atlas] recognition ended")
      // stopListening() moves state to "processing" before results arrive; if
      // recognition ends with no result we must not stay stuck there forever.
      if (!gotResult && (this.state === "listening" || this.state === "processing")) {
        if (this.state === "processing") {
          this.callbacks.onError("I didn't catch that — hold Space and speak clearly.")
        }
        this.setState("sleeping")
      }
    }

    this.recognition = recognition
    
    try {
      recognition.start()
      this.playWakeSound()
    } catch(e) {
      console.error("[Atlas] could not start:", e)
      this.setState("sleeping")
    }
  }

  private stopListening() {
    if (this.recognition && this.state === "listening") {
      console.log("[Atlas] stopping — processing query")
      this.setState("processing")
      try {
        this.recognition.stop()
      } catch {}
    }
  }

  // FIX 3 — Two-tone rising wake sound, 140ms total
  private playWakeSound() {
    try {
      const ctx = new window.AudioContext()

      const osc1 = ctx.createOscillator()
      const gain1 = ctx.createGain()
      osc1.connect(gain1)
      gain1.connect(ctx.destination)
      osc1.frequency.setValueAtTime(600, ctx.currentTime)
      osc1.frequency.exponentialRampToValueAtTime(900, ctx.currentTime + 0.06)
      gain1.gain.setValueAtTime(0.08, ctx.currentTime)
      gain1.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08)
      osc1.start(ctx.currentTime)
      osc1.stop(ctx.currentTime + 0.08)

      const osc2 = ctx.createOscillator()
      const gain2 = ctx.createGain()
      osc2.connect(gain2)
      gain2.connect(ctx.destination)
      osc2.frequency.setValueAtTime(900, ctx.currentTime + 0.05)
      osc2.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.12)
      gain2.gain.setValueAtTime(0.06, ctx.currentTime + 0.05)
      gain2.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14)
      osc2.start(ctx.currentTime + 0.05)
      osc2.stop(ctx.currentTime + 0.14)
    } catch {}
  }

  // SSE streaming query — streams tokens as they arrive from the backend.
  // Falls back to the non-streaming endpoint on error.
  private async sendQuery(query: string, retryCount = 0): Promise<void> {
    this.setState("processing")
    try { this.recognition?.abort() } catch {}

    // Abort any previous stream
    if (this.streamAbort) {
      this.streamAbort.abort()
      this.streamAbort = null
    }

    const controller = new AbortController()
    this.streamAbort = controller

    try {
      const res = await fetch(`${API_URL}/api/voice/query/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          patient_id: this.patientId || undefined,
          doctor_id: this.staffId,
          session_id: this.sessionId,
          user_role: this.userRole || "doctor"
        }),
        signal: controller.signal,
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      // Check if we actually got an SSE stream
      const contentType = res.headers.get("content-type") || ""
      if (!contentType.includes("text/event-stream")) {
        // Non-streaming fallback: parse as JSON
        const data = await res.json()
        const answer = data?.answer || "I couldn't get a response right now."
        this.callbacks.onAnswer(query, answer)
        await this.speakAnswer(query, answer, data)
        return
      }

      // Stream SSE tokens
      const reader = res.body?.getReader()
      if (!reader) throw new Error("No readable stream")

      const decoder = new TextDecoder()
      let buffer = ""
      let fullAnswer = ""
      let doneData: any = null
      let gotFirstToken = false

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })

        // Parse SSE events from the buffer
        const lines = buffer.split("\n")
        buffer = ""

        let currentEvent = ""
        let currentData = ""

        for (const line of lines) {
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim()
          } else if (line.startsWith("data: ")) {
            currentData = line.slice(6)
            // Process the complete event
            try {
              const parsed = JSON.parse(currentData)

              if (currentEvent === "token") {
                if (!gotFirstToken) {
                  gotFirstToken = true
                  this.setState("streaming")
                }
                fullAnswer += parsed.t
                this.callbacks.onToken(parsed.t)
              } else if (currentEvent === "done") {
                doneData = parsed
                fullAnswer = parsed.answer || fullAnswer
              } else if (currentEvent === "error") {
                throw new Error(parsed.message || "Stream error")
              }
            } catch (parseErr: any) {
              // If it's a rethrown error, propagate it
              if (parseErr.message && parseErr.message !== "Unexpected end of JSON input") {
                if (currentEvent === "error") throw parseErr
              }
              // Otherwise it's an incomplete JSON chunk — put it back in the buffer
              buffer = line + "\n"
            }
            currentEvent = ""
            currentData = ""
          } else if (line.trim() === "") {
            // Empty line — event boundary, reset
            currentEvent = ""
            currentData = ""
          } else {
            // Incomplete line — put back in buffer
            buffer = line
          }
        }
      }

      // We finished reading the stream
      if (doneData) {
        this.callbacks.onAnswer(query, fullAnswer)
        await this.speakAnswer(query, fullAnswer, doneData)
      } else if (fullAnswer) {
        // Stream ended without a done event — partial response
        this.callbacks.onAnswer(query, fullAnswer)
        await this.speakAnswer(query, fullAnswer, {})
      } else {
        throw new Error("Stream ended with no data")
      }

    } catch (err: any) {
      if (err.name === "AbortError") {
        // Intentional abort (user clicked stop)
        this.setState("sleeping")
        return
      }

      console.error("[Atlas] Streaming query failed:", err)

      // Fallback to non-streaming endpoint
      if (retryCount < 1) {
        console.log("[Atlas] Falling back to non-streaming endpoint...")
        await this.sendQueryFallback(query)
        return
      }

      this.callbacks.onError("Atlas is unavailable. Is the backend running?")
      this.setState("sleeping")
    } finally {
      if (this.streamAbort === controller) {
        this.streamAbort = null
      }
    }
  }

  // Non-streaming fallback — mirrors the original sendQuery behavior
  private async sendQueryFallback(query: string): Promise<void> {
    this.setState("processing")
    try {
      const res = await fetch(`${API_URL}/api/voice/query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          patient_id: this.patientId || undefined,
          doctor_id: this.staffId,
          session_id: this.sessionId,
          user_role: this.userRole || "doctor"
        }),
        signal: AbortSignal.timeout(15000)
      })

      if (!res.ok) throw new Error(`HTTP ${res.status}`)

      const data = await res.json()
      const answer = data?.answer || "I couldn't get a response right now."
      this.callbacks.onAnswer(query, answer)
      await this.speakAnswer(query, answer, data)
    } catch (err: any) {
      console.error("[Atlas] Fallback query failed:", err)
      this.callbacks.onError("Atlas is unavailable. Is the backend running?")
      this.setState("sleeping")
    }
  }

  // FIX 1 — ElevenLabs streaming with optimize_streaming_latency: 3
  // Plays an MP3 stream through MediaSource so speech begins on the first chunk.
  private async playProgressive(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<boolean> {
    const ms = new MediaSource()
    const url = URL.createObjectURL(ms)
    const audio = new Audio()
    audio.volume = 1.0
    audio.src = url
    this.currentAudio = audio

    const cleanup = () => { URL.revokeObjectURL(url); this.currentAudio = null; this.speakResolve = null }

    return new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (ok: boolean) => { if (settled) return; settled = true; cleanup(); resolve(ok) }
      this.speakResolve = () => { try { reader.cancel() } catch { /* already closed */ } finish(false) }
      audio.onended = () => finish(true)
      audio.onerror = () => finish(false)

      ms.addEventListener("sourceopen", async () => {
        let sb: SourceBuffer
        try { sb = ms.addSourceBuffer("audio/mpeg") } catch { finish(false); return }
        const pending: Uint8Array[] = []
        let streamDone = false
        let started = false

        const pump = () => {
          if (settled || sb.updating) return
          const next = pending.shift()
          if (next) {
            try { sb.appendBuffer(next as BufferSource) } catch { finish(false); return }
            if (!started) { started = true; audio.play().catch(() => finish(false)) }
          } else if (streamDone && ms.readyState === "open") {
            try { ms.endOfStream() } catch { /* already ended */ }
          }
        }
        sb.addEventListener("updateend", pump)

        try {
          while (!settled) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) { pending.push(value); pump() }
          }
        } catch { if (!started) { finish(false); return } }
        streamDone = true
        pump()
        if (!started) finish(false)   // stream ended without any audio
      }, { once: true })
    })
  }

  // Strip markdown so TTS doesn't read "asterisk asterisk" etc. aloud.
  private cleanForSpeech(text: string): string {
    return text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s*[-*+•]\s+/gm, "")
      .replace(/^\s*>\s?/gm, "")
      .replace(/[*_~#`|]+/g, " ")
      .replace(/\s{2,}/g, " ")
      .trim()
  }

  private async speakAnswer(_question: string, rawAnswer: string, fullResponse: any) {
    const answer = this.cleanForSpeech(rawAnswer)
    this.isSpeaking = true
    this.interrupted = false
    this.setState("speaking")

    const apiKey = import.meta.env.VITE_ELEVENLABS_API_KEY
    const voiceId = import.meta.env.VITE_ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM"
    let spoken = false

    if (apiKey && apiKey.length > 10) {
      try {
        const r = await fetch(
          `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "xi-api-key": apiKey,
              "Accept": "audio/mpeg"
            },
            body: JSON.stringify({
              text: answer,
              model_id: "eleven_turbo_v2",
              voice_settings: {
                stability: 0.4,
                similarity_boost: 0.8,
                style: 0.1,
                use_speaker_boost: false
              },
              optimize_streaming_latency: 3
            })
          }
        )

        if (r.ok && r.body && typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg")) {
          // Start playing as soon as the first audio bytes arrive instead of waiting for the whole clip.
          spoken = await this.playProgressive(r.body.getReader())
        } else if (r.ok && r.body) {
          // Fallback (browser can't stream MP3): buffer the clip, then play.
          const reader = r.body.getReader()
          const chunks: Uint8Array[] = []
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            if (value) chunks.push(value)
          }
          const total = chunks.reduce((acc, c) => acc + c.length, 0)
          const merged = new Uint8Array(total)
          let offset = 0
          for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.length }

          const blob = new Blob([merged], { type: "audio/mpeg" })
          const url = URL.createObjectURL(blob)
          const audio = new Audio(url)
          audio.volume = 1.0
          this.currentAudio = audio

          spoken = await new Promise<boolean>((resolve) => {
            this.speakResolve = () => resolve(false)  // stop() calls this to interrupt
            audio.onended = () => { URL.revokeObjectURL(url); this.currentAudio = null; this.speakResolve = null; resolve(true) }
            audio.onerror = () => { URL.revokeObjectURL(url); this.currentAudio = null; this.speakResolve = null; resolve(false) }
            audio.play().catch(() => { URL.revokeObjectURL(url); this.currentAudio = null; this.speakResolve = null; resolve(false) })
          })
        }
      } catch (e) {
        console.warn("[Atlas] ElevenLabs error", e)
        spoken = false
      }
    }

    // If the user interrupted (clicked orb / tapped Space during playback),
    // do not fall through to browser TTS or fire navigation — just stop.
    if (this.interrupted) { this.isSpeaking = false; return }

    if (!spoken) {
      console.log("[Atlas] Using browser TTS")
      await new Promise<void>((resolve) => {
        window.speechSynthesis.cancel()
        const u = new SpeechSynthesisUtterance(answer)
        u.rate = 0.88
        u.pitch = 1.05
        u.volume = 1.0
        const voices = window.speechSynthesis.getVoices()
        const preferred = voices.find((v: SpeechSynthesisVoice) => v.lang.startsWith("en"))
        if (preferred) u.voice = preferred
        this.speakResolve = () => resolve()  // stop() resolves this after cancel()
        u.onend = () => { this.speakResolve = null; resolve() }
        u.onerror = () => { this.speakResolve = null; resolve() }
        window.speechSynthesis.speak(u)
      })
    }

    if (this.interrupted) { this.isSpeaking = false; return }

    if (fullResponse?.intent === "navigate_reports" && fullResponse?.patient) {
      window.dispatchEvent(new CustomEvent("atlas_navigate", {
        detail: { path: `/patients/${fullResponse.patient.id}`, tab: "reports" }
      }))
    }
    if (fullResponse?.intent === "navigate_patient" && fullResponse?.patient) {
      window.dispatchEvent(new CustomEvent("atlas_navigate", {
        detail: { path: `/patients/${fullResponse.patient.id}`, tab: "summary" }
      }))
    }

    this.isSpeaking = false
    this.setState("sleeping")
  }

  setPatientId(id: string | undefined) {
    this.patientId = id
  }

  // Click-to-talk: spacebar-independent voice path (orb click).
  toggleListening() {
    if (!this.SR) {
      this.callbacks.onError("Use Chrome for voice")
      return
    }
    if (this.state === "listening") {
      this.stopListening()
      return
    }
    if (this.isSpeaking || this.state === "processing" || this.state === "streaming") return
    this.startListening()
  }

  ask(query: string) {
    const trimmed = query?.toString().trim()
    if (!trimmed) return
    this.setState("processing")
    try { this.recognition?.abort() } catch {}
    this.sendQuery(trimmed)
  }

  stop() {
    this.interrupted = true
    this.isSpeaking = false
    // Halt ElevenLabs playback (previously this leaked — stop() only cancelled
    // browser TTS, so an ElevenLabs answer kept playing with no way to stop it).
    if (this.currentAudio) {
      try { this.currentAudio.pause(); this.currentAudio.src = "" } catch {}
      this.currentAudio = null
    }
    window.speechSynthesis.cancel()
    // Resolve any pending speak() promise so speakAnswer unwinds cleanly.
    if (this.speakResolve) { const r = this.speakResolve; this.speakResolve = null; r() }
    if (this.recognition) {
      try { this.recognition.abort() } catch {}
    }
    if (this.streamAbort) {
      this.streamAbort.abort()
      this.streamAbort = null
    }
    this.setState("sleeping")
  }

  destroy() {
    this.interrupted = true
    window.removeEventListener("keydown", this.onKeyDown)
    window.removeEventListener("keyup", this.onKeyUp)
    if (this.currentAudio) {
      try { this.currentAudio.pause(); this.currentAudio.src = "" } catch {}
      this.currentAudio = null
    }
    if (this.speakResolve) { const r = this.speakResolve; this.speakResolve = null; r() }
    if (this.recognition) {
      try { this.recognition.abort() } catch {}
      this.recognition = null
    }
    if (this.streamAbort) {
      this.streamAbort.abort()
      this.streamAbort = null
    }
    window.speechSynthesis.cancel()
  }
}

export default AtlasCore
