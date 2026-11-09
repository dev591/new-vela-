// React hook around the Gnani recorder: tap to start, it stops by itself when you stop
// talking (or at 30 s), sends the audio to Prisma and hands back the text.
import { useCallback, useEffect, useRef, useState } from 'react'
import { VoiceRecorder, canRecord } from '../utils/voiceRecorder'
import { transcribe } from '../utils/speech'

export interface TranscriptExtra {
  emergency: boolean; replyLanguage: string
  recordEnd: number; prismaDone: number           // performance.now() marks, for latency logs
}

interface Options {
  kiosk?: boolean                                  // true = public kiosk route (no login)
  onTranscript: (text: string, language: string, extra: TranscriptExtra) => void
  onError?: (message: string) => void
  onAudio?: (wav: Blob) => void                    // optional: get the raw recording instead of transcribing
  onRecordEnd?: () => void                         // the moment the user stops talking (before Prisma answers)
  silenceMs?: number                               // how long a pause ends the recording (default 800)
}

export default function useVoiceInput(options: Options) {
  const [listening, setListening] = useState(false)    // mic is open
  const [processing, setProcessing] = useState(false)  // waiting for Prisma
  const [level, setLevel] = useState(0)                // mic loudness for a meter
  const opts = useRef(options)
  opts.current = options                               // always call the latest callbacks
  const rec = useRef<VoiceRecorder | null>(null)

  const start = useCallback(async () => {
    if (rec.current?.active || processing) return
    rec.current = new VoiceRecorder({
      silenceMs: opts.current.silenceMs,
      onLevel: setLevel,
      onEnd: () => { setListening(false); setLevel(0) },
      onError: (m) => opts.current.onError?.(m),
      onChunk: async (wav) => {
        if (opts.current.onAudio) { opts.current.onAudio(wav); return }
        const recordEnd = performance.now()           // the user just stopped talking
        opts.current.onRecordEnd?.()                  // e.g. play an instant "heard you" chime
        setProcessing(true)
        try {
          const r = await transcribe(wav, opts.current.kiosk)
          if (r.transcript) opts.current.onTranscript(r.transcript, r.language, {
            emergency: !!r.emergency, replyLanguage: r.reply_language || 'en-IN',
            recordEnd, prismaDone: performance.now(),
          })
          else opts.current.onError?.("I didn't catch that. Please try again.")
        } catch (e) { opts.current.onError?.((e as Error).message) }
        finally { setProcessing(false) }
      },
    })
    await rec.current.start()
    setListening(!!rec.current?.active)
  }, [processing])

  const stop = useCallback(() => rec.current?.stop(), [])       // finish and send
  const cancel = useCallback(() => rec.current?.cancel(), [])   // discard
  useEffect(() => () => rec.current?.cancel(), [])              // release the mic on unmount

  return { listening, processing, level, start, stop, cancel, supported: canRecord() }
}
