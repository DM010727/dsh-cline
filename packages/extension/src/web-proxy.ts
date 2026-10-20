/** Capability-scoped loopback carrier; native DSH cookies never enter the webview. */
import * as http from 'node:http'
import { randomBytes } from 'node:crypto'
import type { LookupFunction } from 'node:net'
import type { Duplex } from 'node:stream'

const BOOTSTRAP_TIMEOUT_MS = 5_000
const FORWARD_TIMEOUT_MS = 30_000
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

/** Family fallback must not consult DNS/hosts, while preserving the localhost cookie authority. */
const lookupLoopback: LookupFunction = (_hostname, options, callback) => {
  const family = options.family === 6 || options.family === 'IPv6' ? 6
    : options.family === 4 || options.family === 'IPv4' ? 4 : undefined
  const addresses = [{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]
    .filter(entry => family === undefined || entry.family === family)
  process.nextTick(() => {
    if (options.all) callback(null, addresses)
    else callback(null, addresses[0]!.address, addresses[0]!.family)
  })
}

interface Destination {
  target: URL
  cookie: string
  key: string
  prefix: string
}

/** Only canonical HTTP loopback origins and the official root token exchange are accepted. */
function destination(targetOrigin: string, authenticatedUrl: string): { target: URL; auth: URL; key: string } {
  try {
    const target = new URL(targetOrigin)
    const auth = new URL(authenticatedUrl)
    if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname)
      || target.username || target.password || target.pathname !== '/' || target.search || target.hash
      || auth.origin !== target.origin || auth.username || auth.password || auth.pathname !== '/' || auth.hash) throw new Error()
    const entries = [...auth.searchParams]
    if (entries.length !== 1 || entries[0]![0] !== 'token' || !/^[A-Za-z0-9_-]{1,1024}$/.test(entries[0]![1])) throw new Error()
    return { target, auth, key: target.origin + '\n' + auth.href }
  } catch { throw new Error('Invalid DSH Web authentication endpoint') }
}

/** Remove credentials, proxy hints and connection-nominated hop headers before forwarding. */
function cleanHeaders(input: http.IncomingHttpHeaders, response = false): http.OutgoingHttpHeaders {
  const dropped = new Set(HOP_HEADERS)
  for (const name of String(input.connection ?? '').split(',')) dropped.add(name.trim().toLowerCase())
  const result: http.OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || dropped.has(name) || name === 'host' || name === 'cookie' || name === 'authorization'
      || name === 'origin' || name === 'referer' || name === 'forwarded' || name === 'via'
      || name === 'x-real-ip' || name.startsWith('x-forwarded-') || name.startsWith('sec-fetch-')
      || response && ['set-cookie', 'location', 'refresh', 'content-location'].includes(name)) continue
    result[name] = value
  }
  return result
}

/**
 * Exchange the official launch URL once in Node, then expose a separate random
 * path to the iframe. The browser neither stores nor forwards the native cookie.
 */
export class WebProxy {
  private readonly server: http.Server
  private readonly sockets = new Set<Duplex>()
  private readonly requests = new Set<http.ClientRequest>()
  private active?: Destination
  private origin?: string
  private listening?: Promise<void>
  private connecting?: { key: string; promise: Promise<string> }
  private disposed = false

  constructor() {
    this.server = http.createServer((req, res) => this.forward(req, res))
    this.server.on('connection', socket => this.track(socket))
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
    this.server.requestTimeout = 60_000
    this.server.headersTimeout = 10_000
    this.server.on('clientError', (_error, socket) => socket.destroy())
    this.server.on('error', () => { /* Startup is rejected by listen(); transport errors never contain diagnostics. */ })
  }

  /** Same target and launch token share their cookie and capability URL. */
  connect(targetOrigin: string, authenticatedUrl: string): Promise<string> {
    if (this.disposed) return Promise.reject(new Error('DSH Web proxy is closed'))
    let parsed: ReturnType<typeof destination>
    try { parsed = destination(targetOrigin, authenticatedUrl) } catch (error) { return Promise.reject(error) }
    if (this.active?.key === parsed.key && this.origin !== undefined) return Promise.resolve(this.origin + this.active.prefix)
    if (this.connecting !== undefined) {
      if (this.connecting.key === parsed.key) return this.connecting.promise
      return this.connecting.promise.catch(() => {}).then(() => this.connect(targetOrigin, authenticatedUrl))
    }
    const promise = this.establish(parsed).finally(() => {
      if (this.connecting?.promise === promise) this.connecting = undefined
    })
    this.connecting = { key: parsed.key, promise }
    return promise
  }

  private async establish(parsed: ReturnType<typeof destination>): Promise<string> {
    try {
      const exchange = await this.inspect(parsed.auth)
      if (exchange.status !== 303 || exchange.headers.location !== './') throw new Error()
      const cookies = (exchange.headers['set-cookie'] ?? []).map(value => value.split(';', 1)[0]!)
        .filter(value => /^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9._-]+$/.test(value) && value.length <= 16_384)
      if (cookies.length !== 1) throw new Error()
      const cookie = cookies[0]!
      const confirmed = await this.inspect(parsed.target, { cookie })
      if (confirmed.status !== 200 || !/^text\/html(?:;|$)/i.test(String(confirmed.headers['content-type'] ?? ''))) throw new Error()
      await this.listen()
      if (this.disposed) throw new Error()
      // A different process token invalidates the old capability and its sockets.
      if (this.active !== undefined) for (const socket of this.sockets) socket.destroy()
      this.active = { target: parsed.target, cookie, key: parsed.key, prefix: '/' + randomBytes(32).toString('base64url') + '/' }
      return this.origin! + this.active.prefix
    } catch { throw new Error(this.disposed ? 'DSH Web proxy is closed' : 'DSH Web authentication failed') }
  }

  private listen(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('DSH Web proxy is closed'))
    if (this.listening !== undefined) return this.listening
    this.listening = new Promise<void>((resolve, reject) => {
      const failed = (): void => reject(new Error('DSH Web proxy could not listen'))
      this.server.once('error', failed)
      this.server.listen(0, '127.0.0.1', () => {
        this.server.off('error', failed)
        const address = this.server.address()
        if (address === null || typeof address === 'string') { failed(); return }
        this.origin = 'http://127.0.0.1:' + String(address.port)
        resolve()
      })
    })
    return this.listening
  }

  /** Header-only bootstrap requests are bounded and never expose raw transport errors. */
  private inspect(url: URL, headers: http.OutgoingHttpHeaders = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
    return new Promise((resolve, reject) => {
      const req = this.request(url, { headers, method: 'GET', agent: false })
      const timer = setTimeout(() => req.destroy(new Error('DSH Web bootstrap timeout')), BOOTSTRAP_TIMEOUT_MS)
      const finish = (): void => clearTimeout(timer)
      req.on('error', () => { finish(); reject(new Error('DSH Web authentication failed')) })
      req.on('response', res => {
        finish()
        resolve({ status: res.statusCode ?? 0, headers: res.headers })
        res.destroy()
      })
      req.end()
    })
  }

  private request(url: URL, options: http.RequestOptions): http.ClientRequest {
    const req = http.request(url, {
      ...options,
      // A native localhost listener may bind only ::1 or only 127.0.0.1.
      ...(url.hostname === 'localhost' ? { lookup: lookupLoopback, autoSelectFamily: true, autoSelectFamilyAttemptTimeout: 250 } : {}),
      headers: { ...options.headers, host: url.host },
    })
    this.requests.add(req)
    req.once('close', () => this.requests.delete(req))
    req.on('socket', socket => this.track(socket))
    return req
  }

  private track(socket: Duplex): void {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
  }

  /** The random path is the browser capability; it never leaves this listener. */
  private route(req: http.IncomingMessage): { url: URL; headers: http.OutgoingHttpHeaders; browserBase: string } | undefined {
    const active = this.active
    if (this.disposed || active === undefined || this.origin === undefined) return undefined
    const host = new URL(this.origin).host
    if (req.headers.host !== host || req.headers.origin !== undefined && req.headers.origin !== this.origin) return undefined
    if (req.headers.origin === undefined && req.headers['sec-fetch-site'] === 'cross-site'
      && (req.method !== 'GET' || !['iframe', 'document'].includes(String(req.headers['sec-fetch-dest'] ?? '')))) return undefined
    const raw = req.url ?? ''
    if (!raw.startsWith(active.prefix) || /[\\\r\n\0#]/.test(raw)) return undefined
    let path: URL
    try { path = new URL(raw, this.origin) } catch { return undefined }
    if (path.origin !== this.origin || !path.pathname.startsWith(active.prefix)) return undefined
    const url = new URL(active.target.origin)
    url.pathname = '/' + path.pathname.slice(active.prefix.length)
    url.search = path.search
    const headers = cleanHeaders(req.headers)
    headers.host = active.target.host
    headers.cookie = active.cookie
    if (req.headers.origin !== undefined) headers.origin = active.target.origin
    return { url, headers, browserBase: this.origin + active.prefix }
  }

  private reject(res: http.ServerResponse, status = 403): void {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    res.end(status === 403 ? 'Forbidden' : 'DSH Web unavailable')
  }

  private forward(req: http.IncomingMessage, res: http.ServerResponse): void {
    const route = this.route(req)
    if (route === undefined) { this.reject(res); return }
    const upstream = this.request(route.url, { method: req.method, headers: route.headers, agent: false })
    upstream.setTimeout(FORWARD_TIMEOUT_MS, () => upstream.destroy(new Error('DSH Web request timeout')))
    upstream.on('error', () => { if (!res.headersSent) this.reject(res, 502); else res.destroy() })
    req.on('aborted', () => upstream.destroy())
    req.on('error', () => upstream.destroy())
    res.on('close', () => upstream.destroy())
    upstream.on('response', response => {
      const headers = cleanHeaders(response.headers, true)
      headers['referrer-policy'] = 'no-referrer'
      headers['cache-control'] = 'no-store'
      const location = response.headers.location
      if (location !== undefined) {
        let redirected: URL
        try { redirected = new URL(location, route.url) } catch { response.destroy(); this.reject(res, 502); return }
        if (redirected.origin !== route.url.origin || redirected.username || redirected.password || redirected.searchParams.has('token')) {
          response.destroy(); this.reject(res, 502); return
        }
        headers.location = route.browserBase + redirected.pathname.slice(1) + redirected.search + redirected.hash
      }
      res.writeHead(response.statusCode ?? 502, headers)
      response.on('error', () => res.destroy())
      response.pipe(res)
    })
    req.pipe(upstream)
  }

  private upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const route = this.route(req)
    if (route === undefined || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return
    }
    const upstream = this.request(route.url, { method: 'GET', headers: { ...route.headers, connection: 'Upgrade', upgrade: 'websocket' }, agent: false })
    const timer = setTimeout(() => { upstream.destroy(); socket.destroy() }, BOOTSTRAP_TIMEOUT_MS)
    const failed = (): void => { clearTimeout(timer); upstream.destroy(); socket.destroy() }
    upstream.on('error', failed)
    socket.on('error', failed)
    socket.once('close', () => { clearTimeout(timer); upstream.destroy() })
    upstream.on('response', response => { response.destroy(); failed() })
    upstream.on('upgrade', (response, remote, remoteHead) => {
      clearTimeout(timer)
      if (response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'websocket' || socket.destroyed || this.disposed) {
        remote.destroy(); failed(); return
      }
      this.track(remote)
      const headers = cleanHeaders(response.headers, true)
      const lines = ['HTTP/1.1 101 Switching Protocols', 'Connection: Upgrade', 'Upgrade: websocket']
      for (const [name, value] of Object.entries(headers)) {
        for (const entry of Array.isArray(value) ? value : [value]) if (entry !== undefined) lines.push(name + ': ' + String(entry))
      }
      socket.write(lines.join('\r\n') + '\r\n\r\n')
      if (remoteHead.length > 0) socket.write(remoteHead)
      if (head.length > 0) remote.write(head)
      socket.once('end', () => remote.destroy())
      socket.once('close', () => remote.destroy())
      remote.once('end', () => socket.destroy())
      remote.once('close', () => socket.destroy())
      remote.on('error', () => socket.destroy())
      socket.pipe(remote).pipe(socket)
    })
    upstream.end()
  }

  /** Close both HTTP and upgraded sockets, including a pending authentication exchange. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.active = undefined
    for (const request of this.requests) request.destroy()
    for (const socket of this.sockets) socket.destroy()
    await this.connecting?.promise.catch(() => {})
    if (this.server.listening) await new Promise<void>(resolve => this.server.close(() => resolve()))
  }
}
