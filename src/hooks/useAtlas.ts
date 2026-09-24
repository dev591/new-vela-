import { useState, useEffect, useRef } from "react"
import AtlasCore, { type AtlasState } from "../components/Atlas/AtlasCore"

export function useAtlas(patientId?: string, userRole?: string | null) {
  const [state, setState] = useState<AtlasState>("sleeping")
  const [question, setQuestion] = useState("")
  const [answer, setAnswer] = useState("")
  const [streamingText, setStreamingText] = useState("")
  const [showAnswer, setShowAnswer] = useState(false)
  const [errorMsg, setErrorMsg] = useState("")

  const coreRef = useRef<AtlasCore | null>(null)
  const dismissTimer = useRef<any>(null)

  useEffect(() => {
    const core = new AtlasCore({
      onState: setState,
      onToken: (token) => {
        setStreamingText(prev => prev + token)
        // Show the answer card on the very first token
        setShowAnswer(true)
        clearTimeout(dismissTimer.current)
      },
      onAnswer: (q, a) => {
        setQuestion(q)
        setAnswer(a)
        setStreamingText("") // Clear streaming text once the final answer is set
        setShowAnswer(true)
        clearTimeout(dismissTimer.current)
        dismissTimer.current = setTimeout(() => setShowAnswer(false), 12000)
      },
      onError: (msg) => {
        setErrorMsg(msg)
        setTimeout(() => setErrorMsg(""), 5000)
      },
      userRole: userRole || "doctor"
    })

    core.init()
    coreRef.current = core

    return () => {
      core.destroy()
      clearTimeout(dismissTimer.current)
    }
  }, [userRole])

  useEffect(() => {
    coreRef.current?.setPatientId(patientId)
  }, [patientId])

  const stop = () => {
    coreRef.current?.stop()
    setStreamingText("")
  }
  const ask = (query: string) => {
    // Reset streaming state when asking a new question
    setStreamingText("")
    setAnswer("")
    coreRef.current?.ask(query)
  }
  const toggleVoice = () => coreRef.current?.toggleListening()

  return {
    state,
    question,
    answer,
    streamingText,
    showAnswer,
    errorMsg,
    setShowAnswer,
    stop,
    ask,
    toggleVoice
  }
}
