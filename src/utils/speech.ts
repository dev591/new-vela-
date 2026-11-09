// Send a recorded WAV to our backend, which calls Gnani Prisma and returns the text.
// The Gnani key lives on the server only; the browser never sees it.
import { API_URL } from './config'
import { VoiceRecorder } from './voiceRecorder'

export interface Transcript {
  transcript: string; language: string; timings?: Record<string, number>
  emergency?: boolean; reply_language?: string   // kiosk route only: deterministic triage + language to answer in
}

/** Signed-in screens use /api/stt (the session token is attached by installAuthFetch).
 *  The public kiosk uses /api/frontdesk/transcribe (no login, rate limited per IP). */
export async function transcribe(wav: Blob, kiosk = false): Promise<Transcript> {
  const form = new FormData()
  form.append('audio', wav, 'speech.wav')    // no Content-Type header: the browser adds the multipart boundary
  const res = await fetch(`${API_URL}${kiosk ? '/api/frontdesk/transcribe' : '/api/stt'}`, { method: 'POST', body: form })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new SpeechError(res.status, data.detail || data.message || 'Speech service unavailable')
  return data as Transcript
}

export class SpeechError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

/** Listen for ONE utterance, transcribe it, and call back. Used by screens that start the
 *  mic from a button (patient dashboard). Returns an object with stop(), like the old
 *  Web Speech recognizer did, so existing call sites keep working. */
export function listenOnce(onText: (text: string) => void, onDone: () => void, onError: (msg: string) => void,
                           kiosk = false) {
  let sending = false
  const rec = new VoiceRecorder({
    onChunk: async (wav) => {
      sending = true
      try {
        const r = await transcribe(wav, kiosk)
        if (r.transcript) onText(r.transcript); else onError("I didn't catch that. Please try again.")
      } catch (e) { onError((e as Error).message) } finally { onDone() }
    },
    onError: (m) => { onError(m); onDone() },
    // The mic is released just before onChunk runs; only report "done" if nothing was sent.
    onEnd: () => queueMicrotask(() => { if (!sending) onDone() }),
  })
  void rec.start()
  return { stop: () => rec.stop(), abort: () => rec.cancel() }
}
