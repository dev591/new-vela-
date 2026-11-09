// Microphone -> 16 kHz mono WAV, using only the Web Audio API.
//
// Why not MediaRecorder? Chrome's MediaRecorder makes WebM/Opus, and Gnani's Prisma
// rejects WebM (we tested: UNSUPPORTED_AUDIO_FORMAT). Prisma accepts WAV, so we grab
// the raw samples ourselves and write the WAV header by hand. This also works in Safari.

export interface RecorderOptions {
  onChunk: (wav: Blob) => void        // one finished utterance as a WAV file
  onLevel?: (rms: number) => void     // 0..~0.3 loudness, for a live mic meter
  onError: (message: string) => void  // human-readable problem
  onEnd?: () => void                  // microphone released
  maxMs?: number                      // hard cap per recording (Prisma accepts at most 30 s)
  silenceMs?: number                  // stop after this much quiet once speech has started
  noSpeechMs?: number                 // give up if nobody speaks within this time
  continuous?: boolean                // keep listening after each utterance (ambient scribe)
}

const TARGET_RATE = 16000
// A tiny AudioWorklet that copies every 128-sample block of mic audio to the main thread.
const WORKLET_SRC = `class Tap extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true }
}
registerProcessor('pcm-tap', Tap)`

export class VoiceRecorder {
  private opts: Required<Pick<RecorderOptions, 'maxMs' | 'silenceMs' | 'noSpeechMs'>> & RecorderOptions
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private blocks: Float32Array[] = []   // raw samples of the current utterance
  private samples = 0
  private talking: boolean[] = []   // per block: was someone talking? (used to trim silence before upload)
  private heardSpeech = false
  private quietSince = 0
  private startedAt = 0
  private floor = 0.004                 // background noise level, learned in the first 300 ms
  private calibrating: number[] = []
  active = false
  private paused = false            // true while Atlas is thinking or talking: the mic stays open but nothing is kept
  private stopping = false          // true when the user pressed stop (so continuous mode must really stop)

  constructor(opts: RecorderOptions) {
    // `??` so an option passed as undefined still gets its default (a plain spread would overwrite it).
    this.opts = { ...opts, maxMs: opts.maxMs ?? 29000, silenceMs: opts.silenceMs ?? 800, noSpeechMs: opts.noSpeechMs ?? 8000 }
  }

  async start(): Promise<void> {
    if (this.active) return
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      })
    } catch (e) {
      const name = (e as DOMException).name
      this.opts.onError(
        name === 'NotFoundError' ? 'No microphone found. Check your input device.'
          : 'Microphone blocked. Allow it in the browser address bar.')
      return
    }
    // Ask for 16 kHz directly; if the browser ignores that we resample when encoding.
    this.ctx = new AudioContext({ sampleRate: TARGET_RATE })
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }))
    try { await this.ctx.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }
    this.node = new AudioWorkletNode(this.ctx, 'pcm-tap')
    this.node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onBlock(e.data)
    const mute = this.ctx.createGain()   // worklets only run when connected to the output
    mute.gain.value = 0
    this.ctx.createMediaStreamSource(this.stream).connect(this.node).connect(mute).connect(this.ctx.destination)
    this.resetUtterance()
    this.stopping = false
    this.paused = false
    this.active = true
  }

  private resetUtterance() {
    this.blocks = []; this.talking = []; this.samples = 0; this.heardSpeech = false
    this.quietSince = 0; this.startedAt = performance.now(); this.calibrating = []
  }

  // Called for every 128-sample block (~8 ms at 16 kHz).
  private onBlock(block: Float32Array) {
    if (!this.active || this.paused) return
    this.blocks.push(block); this.samples += block.length
    this.talking.push(false)
    let sum = 0
    for (let i = 0; i < block.length; i++) sum += block[i] * block[i]
    const rms = Math.sqrt(sum / block.length)
    this.opts.onLevel?.(rms)

    const now = performance.now()
    const elapsed = now - this.startedAt
    if (elapsed < 300) { this.calibrating.push(rms); return }       // learn the room's noise level
    if (this.calibrating.length) {
      this.floor = this.calibrating.reduce((a, b) => a + b, 0) / this.calibrating.length
      this.calibrating = []
    }
    const talking = rms > Math.max(0.012, this.floor * 3)
    this.talking[this.talking.length - 1] = talking
    if (talking) { this.heardSpeech = true; this.quietSince = 0 }
    else if (this.heardSpeech && !this.quietSince) this.quietSince = now

    // Cut the utterance: long silence after speech, the 30 s cap, or nobody spoke at all.
    if (this.heardSpeech && this.quietSince && now - this.quietSince > this.opts.silenceMs) this.finish()
    else if (elapsed > this.opts.maxMs) this.finish()
    else if (!this.heardSpeech && elapsed > this.opts.noSpeechMs) {
      this.release()
      this.opts.onError("I didn't hear anything. Tap the mic and try again.")
    }
  }

  /** Send what has been said so far (or release the mic if nothing was said). */
  stop() { if (this.active) { this.stopping = true; this.finish() } }

  /** Keep the microphone open but ignore it (so Atlas does not hear its own voice). */
  pause() { this.paused = true; this.resetUtterance() }

  /** Start listening again with a fresh utterance. */
  resume() { if (this.active) { this.resetUtterance(); this.paused = false } }

  /** Throw the recording away. */
  cancel() { if (this.active) this.release() }

  private finish() {
    const spoke = this.heardSpeech
    const { blocks, samples } = this.trimSilence()
    const wav = encodeWav(blocks, samples, this.ctx?.sampleRate ?? TARGET_RATE)
    if (this.opts.continuous && !this.stopping && this.active) {
      this.resetUtterance()                       // keep the mic open for the next utterance
    } else {
      this.release()
    }
    if (spoke) this.opts.onChunk(wav)
    else if (!this.opts.continuous) this.opts.onError("I didn't hear anything. Tap the mic and try again.")
  }

  // Drop the long silences before and after the speech: a smaller upload reaches Prisma sooner.
  // Keep ~320 ms before and ~280 ms after the first/last talking block so no word is clipped.
  private trimSilence() {
    const first = this.talking.indexOf(true), last = this.talking.lastIndexOf(true)
    if (first < 0) return { blocks: this.blocks, samples: this.samples }
    const rate = this.ctx?.sampleRate ?? TARGET_RATE
    const perMs = rate / 1000 / 128                         // blocks per millisecond
    const from = Math.max(0, first - Math.round(320 * perMs))
    const to = Math.min(this.blocks.length, last + Math.round(280 * perMs))
    const blocks = this.blocks.slice(from, to)
    return { blocks, samples: blocks.reduce((n, b) => n + b.length, 0) }
  }

  private release() {
    this.active = false
    try { this.node?.disconnect() } catch { /* already disconnected */ }
    this.stream?.getTracks().forEach(t => t.stop())
    void this.ctx?.close().catch(() => {})
    this.node = null; this.stream = null; this.ctx = null; this.blocks = []
    this.opts.onEnd?.()
  }
}

// Join the blocks, resample to 16 kHz if needed, and write a 44-byte WAV header + 16-bit PCM.
export function encodeWav(blocks: Float32Array[], total: number, rate: number): Blob {
  const all = new Float32Array(total)
  let o = 0
  for (const b of blocks) { all.set(b, o); o += b.length }
  const pcm = rate === TARGET_RATE ? all : resample(all, rate, TARGET_RATE)

  const buf = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(buf)
  const str = (off: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); v.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true)        // PCM
  v.setUint16(22, 1, true); v.setUint32(24, TARGET_RATE, true)                // mono, 16 kHz
  v.setUint32(28, TARGET_RATE * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true)
  str(36, 'data'); v.setUint32(40, pcm.length * 2, true)
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]))                               // clamp, then to int16
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true)
  }
  return new Blob([buf], { type: 'audio/wav' })
}

function resample(src: Float32Array, from: number, to: number): Float32Array {
  const out = new Float32Array(Math.floor(src.length * to / from))
  const ratio = from / to
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, src.length - 1)
    out[i] = src[i0] + (src[i1] - src[i0]) * (pos - i0)                       // linear interpolation
  }
  return out
}

export const canRecord = () =>
  typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof AudioWorkletNode !== 'undefined'
