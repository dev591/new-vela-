import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * A render error in one screen must never leave a blank page in front of a clinician
 * or patient. Show what happened and a way back instead.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[UI] Render error:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)", padding: 24 }}>
        <div style={{ maxWidth: 420, width: "100%", background: "#fff", border: "0.5px solid rgba(0,0,0,0.1)", borderRadius: 24, padding: 32, textAlign: "center", boxShadow: "var(--shadow-md)" }}>
          <h1 style={{ fontSize: 24, fontWeight: 600, color: "var(--text)", margin: "0 0 8px" }}>Something went wrong</h1>
          <p style={{ fontSize: 16, color: "var(--text-secondary)", margin: "0 0 24px" }}>
            This screen couldn't load. Your data is safe. Try again, or go back.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
            <button onClick={() => window.location.reload()} style={{ minHeight: 48, padding: "0 24px", borderRadius: 14, border: "none", background: "var(--brand)", color: "#fff", fontSize: 16, fontWeight: 600, cursor: "pointer" }}>
              Reload
            </button>
            <button onClick={() => { this.setState({ error: null }); window.history.back(); }} style={{ minHeight: 48, padding: "0 24px", borderRadius: 14, border: "1px solid var(--border-strong)", background: "#fff", color: "var(--text)", fontSize: 16, fontWeight: 500, cursor: "pointer" }}>
              Go back
            </button>
          </div>
        </div>
      </div>
    );
  }
}
