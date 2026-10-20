/** Shared boundary for privileged HTTP routes on DSH's local web carrier. */
import type { IncomingMessage, ServerResponse } from 'node:http'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const MAX_BODY_BYTES = 64 * 1024
const BODY_TIMEOUT_MS = 10_000

export class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

/**
 * Local Node callers have no Origin. Browser callers must be same-origin;
 * Host validation also closes DNS rebinding, which an Origin check alone misses.
 */
export function guardRequest(req: IncomingMessage, res: ServerResponse, methods: readonly string[], jsonBody = false): boolean {
  const reject = (status: number, error: string): false => {
    sendJson(res, status, { ok: false, error })
    return false
  }
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) return reject(403, 'local requests only')
  let target: URL
  try {
    const host = req.headers.host
    if (typeof host !== 'string' || !/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/.test(host)) throw new Error('host')
    target = new URL('http://' + host)
    if (!LOOPBACK_HOSTS.has(target.hostname) || Number(target.port || 80) !== req.socket.localPort) throw new Error('port')
  } catch { return reject(403, 'invalid local host') }

  const site = req.headers['sec-fetch-site']
  if (site === 'cross-site' || site === 'same-site') return reject(403, 'same-origin requests only')
  const origin = req.headers.origin
  if (origin !== undefined) {
    try {
      if (typeof origin !== 'string' || new URL(origin).origin !== target.origin) throw new Error('origin')
    } catch { return reject(403, 'same-origin requests only') }
  }
  if (!methods.includes(req.method ?? '')) {
    res.setHeader('allow', methods.join(', '))
    return reject(405, 'method not allowed')
  }
  if (jsonBody && req.method === 'POST' && req.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
    return reject(415, 'application/json required')
  }
  return true
}

/** Bounded JSON object reader, shared by all mutation routes. */
export async function readJsonObject(req: IncomingMessage, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 * 1024 * 1024) throw new RequestError(500, 'invalid request size limit')
  const length = req.headers['content-length']
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    throw new RequestError(413, 'request body too large')
  }
  const chunks: Buffer[] = []
  let size = 0
  const timer = setTimeout(() => req.destroy(new RequestError(408, 'request body timeout')), BODY_TIMEOUT_MS)
  timer.unref()
  try {
    for await (const chunk of req) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      size += buf.length
      if (size > maxBytes) throw new RequestError(413, 'request body too large')
      chunks.push(buf)
    }
    let value: unknown
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { throw new RequestError(400, 'invalid JSON') }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new RequestError(400, 'JSON object required')
    return value as Record<string, unknown>
  } finally { clearTimeout(timer) }
}

export function requestErrorStatus(error: unknown, fallback = 400): number {
  return error instanceof RequestError ? error.status : fallback
}
