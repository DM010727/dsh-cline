import * as http from 'node:http'
import * as crypto from 'node:crypto'

/** One host-service invocation from the DSH side. */
export interface BridgeRequest {
  service: string
  method: string
  args: unknown[]
}

/** Settlement sent back to the DSH side. */
export interface BridgeResult {
  ok: boolean
  result?: unknown
  error?: string
}

/** Handler registry key: '<service>.<method>'. */
export type BridgeHandler = (args: unknown[]) => Promise<unknown>

const MAX_BODY_BYTES = 4 * 1024 * 1024

/**
 * Loopback HTTP bridge the DSH sidecar posts vscode.* RPCs into. Token is a
 * random URL path segment; anything not matching the exact path is refused.
 * No vscode import, so a plain node process can host it for tests.
 */
export class BridgeServer {
  private readonly server: http.Server
  private readonly token: string
  private readonly handlers = new Map<string, BridgeHandler>()
  private listening?: Promise<string>

  constructor() {
    this.token = crypto.randomBytes(24).toString('base64url')
    this.server = http.createServer((req, res) => { void this.dispatch(req, res) })
  }

  /** Register one handler under '<service>.<method>'; last write wins. */
  handle(key: string, handler: BridgeHandler): void {
    this.handlers.set(key, handler)
  }

  /**
   * Start listening on loopback with an OS-assigned port.
   * @returns the bridge URL carrying the token path.
   */
  start(): Promise<string> {
    if (this.listening !== undefined) return this.listening
    this.listening = new Promise<string>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server.address()
        if (address === null || typeof address === 'string') {
          reject(new Error('bridge listen returned ' + JSON.stringify(address)))
          return
        }
        resolve('http://127.0.0.1:' + String(address.port) + '/' + this.token)
      })
    })
    return this.listening
  }

  /** Stop accepting requests and close open sockets. */
  dispose(): Promise<void> {
    return new Promise<void>(resolve => {
      this.server.closeAllConnections?.()
      this.server.close(() => resolve())
    })
  }

  private async dispatch(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/' + this.token || req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    let bytes = 0
    let overflow = false
    for await (const chunk of req) {
      bytes += (chunk as Buffer).length
      if (bytes > MAX_BODY_BYTES) { overflow = true; break }
      body += (chunk as Buffer).toString('utf8')
    }
    if (overflow) {
      res.writeHead(413).end()
      return
    }
    let request: BridgeRequest
    try {
      request = JSON.parse(body) as BridgeRequest
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'invalid JSON' } satisfies BridgeResult))
      return
    }
    if (typeof request.service !== 'string' || typeof request.method !== 'string' || !Array.isArray(request.args)) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'invalid envelope' } satisfies BridgeResult))
      return
    }
    const handler = this.handlers.get(request.service + '.' + request.method)
    if (handler === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'no handler for ' + request.service + '.' + request.method } satisfies BridgeResult))
      return
    }
    try {
      const result = await handler(request.args)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result } satisfies BridgeResult))
    } catch (err: unknown) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: String(err) } satisfies BridgeResult))
    }
  }
}
