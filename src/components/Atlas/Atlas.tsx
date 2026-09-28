import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useAtlas } from "../../hooks/useAtlas"
import AtlasOrb from "./AtlasOrb"
import AtlasAnswerCard from "./AtlasAnswerCard"

interface Props {
  currentPatientId?: string
  userRole?: string | null
}

export default function Atlas({ currentPatientId, userRole }: Props) {
  const navigate = useNavigate()
  const { state, question, answer, streamingText, showAnswer, errorMsg, setShowAnswer, stop, ask, toggleVoice } = useAtlas(currentPatientId, userRole)
  const [query, setQuery] = useState("")

  // Orb click: talk when idle, send when listening, interrupt when busy.
  const handleOrbClick = () => {
    if (state === "speaking" || state === "processing" || state === "streaming") stop()
    else toggleVoice()
  }

  useEffect(() => {
    const handler = (e: any) => {
      navigate(e.detail.path)
    }
    window.addEventListener("atlas_navigate", handler)
    return () => window.removeEventListener("atlas_navigate", handler)
  }, [navigate])

  const busy = state === "speaking" || state === "processing" || state === "streaming"
  const status =
    state === "listening" || state === "waking" ? "Listening… tap the orb or press Space to send"
    : state === "processing" ? "Thinking…"
    : state === "streaming" || state === "speaking" ? "Answering… tap the orb to stop"
    : ""
  const canSend = query.trim().length > 0 && !busy
  const submit = () => {
    if (!canSend) return
    ask && ask(query.trim())
    setQuery("")
  }

  return (
    <div style={{ position: "fixed", bottom: 24, right: 24, zIndex: 9999, display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 12, maxWidth: "calc(100vw - 32px)" }}>
      {showAnswer && (
        <AtlasAnswerCard
          question={question}
          answer={answer}
          streamingText={streamingText}
          onClose={() => setShowAnswer(false)}
        />
      )}

      {errorMsg && (
        <div style={{
          background: "#FFFFFF",
          border: "0.5px solid rgba(215,0,21,0.35)",
          borderRadius: 16,
          padding: "12px 16px",
          color: "var(--text)",
          fontFamily: "var(--font-sans)",
          fontSize: 14,
          maxWidth: 360,
          lineHeight: 1.45,
          boxShadow: "var(--shadow-md)",
        }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "var(--danger)", marginBottom: 2 }}>Atlas can't answer right now</div>
          {errorMsg.includes("backend") || errorMsg.includes("unavailable")
            ? "The server is offline. Start the backend and try again."
            : errorMsg.includes("Microphone") || errorMsg.includes("blocked")
            ? "Microphone blocked. Click the lock icon in Chrome and allow microphone access."
            : errorMsg.includes("Chrome")
            ? "Please use Chrome for voice features."
            : errorMsg}
        </div>
      )}

      {status && (
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-secondary)", background: "rgba(255,255,255,0.85)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", border: "0.5px solid rgba(0,0,0,0.08)", borderRadius: 999, padding: "6px 14px" }}>
          {status}
        </div>
      )}

      {/* One bar: orb · text field · send — the whole assistant in a single Apple-style control */}
      <div style={{
        display: "flex", alignItems: "center", gap: 4, width: 380, maxWidth: "100%",
        padding: "2px 8px 2px 2px",
        background: "rgba(255,255,255,0.86)",
        backdropFilter: "saturate(180%) blur(24px)", WebkitBackdropFilter: "saturate(180%) blur(24px)",
        border: "0.5px solid rgba(0,0,0,0.10)", borderRadius: 999,
        boxShadow: "0 8px 30px rgba(0,0,0,0.12)",
      }}>
        <AtlasOrb state={state} onStop={handleOrbClick} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") submit() }}
          placeholder="Ask Atlas anything"
          aria-label="Ask Atlas"
          style={{ flex: 1, minWidth: 0, height: 44, border: "none", outline: "none", background: "transparent", color: "var(--text)", fontFamily: "var(--font-sans)", fontSize: 16 }}
        />
        <button
          type="button"
          onClick={submit}
          disabled={!canSend}
          aria-label="Send"
          style={{
            width: 36, height: 36, flexShrink: 0, borderRadius: "50%", border: "none",
            display: "flex", alignItems: "center", justifyContent: "center",
            background: canSend ? "var(--brand)" : "rgba(0,0,0,0.08)",
            color: canSend ? "#fff" : "var(--text-tertiary)",
            cursor: canSend ? "pointer" : "default",
            transition: "background-color .18s, transform .18s",
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><line x1="12" y1="19" x2="12" y2="5" /><polyline points="5 12 12 5 19 12" /></svg>
        </button>
      </div>
    </div>
  )
}
