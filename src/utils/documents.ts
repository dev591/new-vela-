import { API_URL } from './config'

/**
 * Open a VELA-generated PDF (lab report or consultation record).
 *
 * These live behind the authenticated API, and a plain `<a href>` cannot carry
 * the session token — the browser would navigate straight to a 401. So the file
 * is fetched through the patched `window.fetch` (which attaches the token),
 * turned into a blob URL, and handed to the browser from there.
 */
export async function openGeneratedDocument(
  documentId: string,
  filename?: string,
  mode: 'open' | 'download' = 'open',
): Promise<{ ok: boolean; message?: string }> {
  try {
    const res = await fetch(`${API_URL}/api/documents/${documentId}/file`)

    if (res.status === 404) {
      // Patient-uploaded documents have no VELA-rendered PDF behind them.
      return { ok: false, message: 'No downloadable file for this document' }
    }
    if (!res.ok) {
      return { ok: false, message: 'Could not open this document' }
    }

    const blob = await res.blob()
    const url = URL.createObjectURL(blob)

    if (mode === 'download') {
      const a = document.createElement('a')
      a.href = url
      a.download = filename || 'vela-report.pdf'
      document.body.appendChild(a)
      a.click()
      a.remove()
    } else {
      const win = window.open(url, '_blank', 'noopener')
      if (!win) {
        // Popup blocked — fall back to downloading it instead of failing silently.
        const a = document.createElement('a')
        a.href = url
        a.download = filename || 'vela-report.pdf'
        document.body.appendChild(a)
        a.click()
        a.remove()
      }
    }

    // Give the browser time to consume the blob before revoking it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000)
    return { ok: true }
  } catch {
    return { ok: false, message: 'Could not open this document' }
  }
}
