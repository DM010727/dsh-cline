/** Accept carrier messages only from the actual embedding webview. */
export function isShellMessage(event: MessageEvent): boolean {
  if (window.parent === window || event.source !== window.parent) return false
  // VS Code can omit referrer. Source identity remains mandatory in that case.
  if (document.referrer !== '') {
    try {
      const origin = new URL(document.referrer).origin
      if (origin !== 'null' && event.origin !== origin) return false
    } catch { return false }
  }
  return true
}

export function shellOrigin(): string {
  try {
    const origin = document.referrer === '' ? 'null' : new URL(document.referrer).origin
    return origin === 'null' ? '*' : origin
  } catch { return '*' }
}

/** Reveal a task-created session through the native UI, never through a URL. */
export function listenOpenSession(onSession: (sessionId: string) => void): () => void {
  const listener = (event: MessageEvent): void => {
    if (!isShellMessage(event) || typeof event.data !== 'object' || event.data === null) return
    const data = event.data as { channel?: unknown; sessionId?: unknown }
    if (data.channel !== 'dsh-cline.open-session' || typeof data.sessionId !== 'string') return
    // Task injection generates ordinary IDs. Reject paths, controls, and huge payloads.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(data.sessionId)) return
    onSession(data.sessionId)
  }
  window.addEventListener('message', listener)
  // Register first, then ask the carrier to replay any task sent while this
  // iframe/plugin was loading. No credentials or task text ride the handshake.
  if (window.parent !== window) {
    try {
      window.parent.postMessage({ channel: 'dsh-cline.host-service', type: 'client-ready' }, shellOrigin())
    } catch { /* an unavailable carrier must not prevent the native UI boot */ }
  }
  return () => { window.removeEventListener('message', listener) }
}
