/** Public health identity plus a capability-protected native browser bootstrap. */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { guardRequest, sendJson } from './request-guard.js'

interface HealthOptions {
  identity(): Record<string, unknown> & { workspaceRoot: string; runtimeRevision: string | null }
  service?: { ping(): Promise<Record<string, unknown>> }
  /** Read at request time: extension reloads replace the bridge locator. */
  bridgeUrl(): unknown
  connection(): unknown
}

export function isBridgeUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) > 0
      && /^\/[a-zA-Z0-9_-]+$/.test(url.pathname) && url.username === '' && url.password === '' && url.search === '' && url.hash === ''
  } catch { return false }
}

const sign = (key: string, message: string): string => createHmac('sha256', key).update(message, 'utf8').digest('base64url')

/** The extension sends a proof, never its reusable bridge capability. */
export function bootstrapRequestProof(bridgeUrl: string, origin: string, challenge: string): string {
  return sign(bridgeUrl, `dsh-cline-bootstrap\n${origin}\n${challenge}`)
}

export function bootstrapResponseProof(bridgeUrl: string, origin: string, challenge: string, browserUrl: string, workspaceRoot: string, runtimeRevision: string | null): string {
  return sign(bridgeUrl, `dsh-cline-bootstrap-response\n${origin}\n${challenge}\n${browserUrl}\n${workspaceRoot}\n${String(runtimeRevision)}`)
}

function proofMatches(supplied: unknown, expectedProof: string): boolean {
  if (typeof supplied !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) return false
  const expected = Buffer.from(expectedProof), received = Buffer.from(supplied)
  return expected.length === received.length && timingSafeEqual(expected, received)
}

export function createHealthHandler(options: HealthOptions): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!guardRequest(req, res, ['GET'])) return
    const identity = { ...options.identity(), bootstrapProtocol: 1 }
    if (options.service === undefined) { sendJson(res, 503, { ...identity, bridge: 'down' }); return }
    let pong: Record<string, unknown>
    try { pong = await options.service.ping() }
    catch { sendJson(res, 502, { ...identity, bridge: 'down', error: 'VS Code bridge unavailable' }); return }
    const origin = new URL('http://' + req.headers.host).origin
    const bridgeUrl = options.bridgeUrl()
    const challenge = req.headers['x-dsh-cline-challenge']
    const proof = req.headers['x-dsh-cline-proof']
    if (!isBridgeUrl(bridgeUrl) || typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(challenge)
      || !proofMatches(proof, bootstrapRequestProof(bridgeUrl, origin, challenge))) {
      sendJson(res, 200, { ...identity, ...pong, bridge: 'up' })
      return
    }
    try {
      const connection = options.connection() as { authenticatedUrl?: (baseUrl: string) => unknown } | undefined
      if (typeof connection?.authenticatedUrl !== 'function') throw new Error('connection unavailable')
      // guardRequest verified the exact loopback authority and local port.
      const baseUrl = origin + '/'
      const browserUrl = connection.authenticatedUrl(baseUrl)
      if (typeof browserUrl !== 'string') throw new Error('invalid authenticated URL')
      const parsed = new URL(browserUrl), base = new URL(baseUrl)
      if (parsed.origin !== base.origin || parsed.pathname !== base.pathname || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') throw new Error('invalid authenticated URL')
      const bootstrapProof = bootstrapResponseProof(bridgeUrl, origin, challenge, browserUrl, identity.workspaceRoot, identity.runtimeRevision)
      sendJson(res, 200, { ...identity, ...pong, bridge: 'up', browserUrl, bootstrapProof })
    } catch {
      // Native errors may contain the bearer URL; never serialize or log them.
      sendJson(res, 503, { ...identity, ...pong, bridge: 'up', error: 'Native browser authentication is not ready' })
    }
  }
}
