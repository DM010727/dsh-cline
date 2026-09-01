/**
 * Same-origin HTTP gateway for the browser half: the webview-resident client
 * bundle cannot reach third-party APIs (CORS) or the extension-host bridge
 * (different loopback port), so it talks to this plugin's routes on the DSH
 * web carrier instead. Node-side fetches have neither restriction.
 *
 * Routes (all loopback-bound with the rest of the carrier):
 * - GET  /dsh-cline/models          proxy the Shengsuanyun model catalog
 * - GET  /dsh-cline/catalog         the pi-ai builtin catalog's provider → model-id map
 * - POST /dsh-cline/open-external   open a URL in the system browser (bridge)
 * - GET  /dsh-cline/vscode-config   read one dsh-cline setting (bridge)
 * - POST /dsh-cline/vscode-config   write one dsh-cline setting (bridge)
 * - GET  /dsh-cline/mcp             read the MCP server declarations (file)
 * - POST /dsh-cline/mcp             write the MCP server declarations (file)
 * - POST /dsh-cline/restart         restart the DSH service via the bridge
 * - POST /dsh-cline/ssy-login       start the Shengsuanyun OAuth login (bridge)
 * - GET  /dsh-cline/ssy-account     balance + recent usage (proxied account API)
 *
 * @module @dsh-cline/host-services/web-gateway
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import type { Context, WebServerService } from '@deepseek-ai/cordis'
import type { VscodeHostService } from './index.js'
import { mcpConfigFile, validateMcpDocument } from './mcp-loader.js'

/** Shengsuanyun account API base (see the SSYAccountService reference). */
const SSY_API_BASE = 'https://api.shengsuanyun.com'
/** Credential reference the Shengsuanyun key is stored under. */
const SSY_KEY_REF = 'SHENGSUANYUN_API_KEY'
/** One account fetch budget. */
const SSY_ACCOUNT_TIMEOUT_MS = 50_000

/**
 * The stored Shengsuanyun API key from the isolated home's credential
 * document, or undefined when not configured. The `yaml` package resolves
 * from the dsh profile at runtime (host-services ships zero deps).
 */
function readSsyApiKey(): string | undefined {
  const home = process.env.DSH_HOME
  if (home === undefined || home === '') return undefined
  try {
    const file = join(home, '.credentials.yaml')
    const doc = (createRequire(import.meta.url)('yaml') as { parse(text: string): unknown })
      .parse(readFileSync(file, 'utf8'))
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return undefined
    const value = (doc as Record<string, unknown>)[SSY_KEY_REF]
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/** One authenticated GET against the Shengsuanyun account API envelope. */
async function ssyApiGet<T>(endpoint: string, apiKey: string): Promise<T> {
  const response = await fetch(SSY_API_BASE + endpoint, {
    headers: { 'content-type': 'application/json', 'x-token': apiKey },
    signal: AbortSignal.timeout(SSY_ACCOUNT_TIMEOUT_MS),
  })
  const body = await response.json() as { code?: unknown, data?: unknown }
  if (body === null || typeof body !== 'object' || body.data === undefined || body.code === 103) {
    throw new Error('invalid response from ' + endpoint)
  }
  return body.data as T
}

/** yyyy-mm-dd for `daysAgo` (the usage log's date range params). */
function ssyDate(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** Shengsuanyun OpenAI-compatible model catalog; public, no auth required. */
const MODELS_URL = 'https://router.shengsuanyun.com/api/v1/models/'

/** Catalog cache lifetime: pricing/roster churn is slow, refresh lazily. */
const MODELS_CACHE_MS = 5 * 60_000

/** One gateway RPC budget. */
const GATEWAY_TIMEOUT_MS = 15_000

/** A model row from the Shengsuanyun catalog (subset we forward). */
export interface ShengsuanyunModel {
  id: string
  name?: string
  company?: string
  description?: string
  context_window?: number
  max_tokens?: number
  supports_prompt_cache?: boolean
  pricing?: Record<string, unknown>
  support_apis?: string[]
}

/** Cached catalog response. */
let modelsCache: { at: number; body: string } | undefined

/** Read the request body as JSON, size-capped. */
async function readJson(req: import('node:http').IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return undefined
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

/** Fetch the catalog through the short cache. */
async function fetchModels(): Promise<string> {
  if (modelsCache !== undefined && Date.now() - modelsCache.at < MODELS_CACHE_MS) {
    return modelsCache.body
  }
  const response = await fetch(MODELS_URL, { signal: AbortSignal.timeout(GATEWAY_TIMEOUT_MS) })
  if (!response.ok) throw new Error('shengsuanyun models HTTP ' + String(response.status))
  const body = await response.text()
  modelsCache = { at: Date.now(), body }
  return body
}

/**
 * Mount the gateway routes. The bridge-dependent routes answer 503 when no
 * VS Code host launched this process (plain `dsh web`); the catalog proxy is
 * bridge-independent and always serves.
 * @param ctx - plugin context (logging).
 * @param webServer - the DSH web carrier service.
 * @param bridge - the vscodeHost bridge face, or undefined when dormant.
 */
export function registerWebGateway(
  ctx: Context,
  webServer: WebServerService,
  bridge: VscodeHostService | undefined,
): void {
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-cline/models',
    handler: async (_req, res) => {
      try {
        const body = await fetchModels()
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
        res.end(body)
      } catch (err: unknown) {
        sendJson(res, 502, { error: 'shengsuanyun catalog unreachable: ' + String(err) })
      }
    },
  }), 'dsh-cline-host-services: models route')

  // The pi-ai builtin catalog as the browser half needs it: provider → model
  // ids. Resolved from the same installation the adapter itself loads, so the
  // model select can never drift from what the route actually serves.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-cline/catalog',
    handler: async (_req, res) => {
      try {
        const compat = await import('@earendil-works/pi-ai/dist/compat.js') as {
          getProviders(): string[]
          getModels(provider: string): Array<{ id: string }>
        }
        const models: Record<string, string[]> = {}
        for (const provider of compat.getProviders()) {
          try {
            models[provider] = compat.getModels(provider).map(model => model.id)
          } catch { /* a provider without models stays absent */ }
        }
        sendJson(res, 200, { models })
      } catch (err: unknown) {
        sendJson(res, 500, { error: 'catalog unavailable: ' + String(err) })
      }
    },
  }), 'dsh-cline-host-services: catalog route')

  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-cline/open-external',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      if (bridge === undefined) {
        sendJson(res, 503, { error: 'no VS Code bridge (plain dsh web)' })
        return
      }
      try {
        const { url } = await readJson(req) as { url?: unknown }
        if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw new Error('url must be http(s)')
        const opened = await bridge.call('vscode.browser', 'openExternal', [{ url }])
        sendJson(res, 200, opened as object)
      } catch (err: unknown) {
        sendJson(res, 400, { error: String(err) })
      }
    },
  }), 'dsh-cline-host-services: open-external route')

  const config = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): Promise<void> => {
    if (bridge === undefined) {
      sendJson(res, 503, { error: 'no VS Code bridge (plain dsh web)' })
      return
    }
    try {
      if (req.method === 'GET') {
        const key = new URL(req.url ?? '/', 'http://x').searchParams.get('key') ?? ''
        const value = await bridge.call('vscode.config', 'get', [key])
        sendJson(res, 200, { key, value })
        return
      }
      if (req.method === 'POST') {
        const { key, value } = await readJson(req) as { key?: unknown; value?: unknown }
        if (typeof key !== 'string' || key === '') throw new Error('key is required')
        await bridge.call('vscode.config', 'update', [key, value])
        sendJson(res, 200, { key, value })
        return
      }
      res.writeHead(405).end()
    } catch (err: unknown) {
      sendJson(res, 400, { error: String(err) })
    }
  }
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-cline/vscode-config',
    handler: (req, res) => { void config(req, res) },
  }), 'dsh-cline-host-services: vscode-config route')

  // MCP declarations live in a file both halves share; the route is
  // bridge-independent so a plain `dsh web` can manage them too. Changes take
  // effect on the next DSH boot (servers mount at startup) - the response says so.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-cline/mcp',
    handler: async (req, res) => {
      try {
        const file = mcpConfigFile()
        if (req.method === 'GET') {
          const servers = existsSync(file)
            ? validateMcpDocument(JSON.parse(readFileSync(file, 'utf8')) as { servers?: unknown })
            : {}
          sendJson(res, 200, { file, servers, restartRequired: true })
          return
        }
        if (req.method === 'POST') {
          const body = await readJson(req) as { servers?: unknown }
          const servers = validateMcpDocument({ servers: body.servers })
          mkdirSync(dirname(file), { recursive: true })
          writeFileSync(file, JSON.stringify({ servers }, undefined, 2) + '\n', 'utf8')
          sendJson(res, 200, { file, servers, restartRequired: true })
          return
        }
        res.writeHead(405).end()
      } catch (err: unknown) {
        sendJson(res, 400, { error: String(err) })
      }
    },
  }), 'dsh-cline-host-services: mcp route')

  // Restart: answer the browser first, then ask the extension host (over the
  // bridge) to restart the DSH service - the Ctrl+C it sends kills this very
  // process, so the bridge call is fire-and-forget by design.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-cline/restart',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      if (bridge === undefined) {
        sendJson(res, 503, { error: 'no VS Code bridge (plain dsh web)' })
        return
      }
      sendJson(res, 200, { restarting: true })
      try {
        await bridge.call('vscode.dsh', 'restart', [])
      } catch (err: unknown) {
        ctx.logger.warn('dsh-cline restart bridge call failed: ' + String(err))
      }
    },
  }), 'dsh-cline-host-services: restart route')

  // Shengsuanyun OAuth login (ported from cline-Chinese): the extension host
  // builds the auth URL with its own vscode:// callback and opens the system
  // browser. The exchanged key comes back through the bridge relay into the
  // iframe, so this route only triggers the flow.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-cline/ssy-login',
    handler: async (req, res) => {
      if (req.method !== 'POST') {
        res.writeHead(405).end()
        return
      }
      if (bridge === undefined) {
        sendJson(res, 503, { error: 'no VS Code bridge (plain dsh web)' })
        return
      }
      try {
        const opened = await bridge.call('vscode.ssy', 'login', [])
        sendJson(res, 200, opened as object)
      } catch (err: unknown) {
        sendJson(res, 400, { error: String(err) })
      }
    },
  }), 'dsh-cline-host-services: ssy-login route')

  // Shengsuanyun account balance + recent usage (mirrors the reference
  // SSYAccountService): the browser half cannot reach api.shengsuanyun.com
  // (CORS), so this route reads the stored key from the isolated home's
  // credential document and proxies /user/info, /base/rate and
  // /modelrouter/userlog, composing one compact payload for the models page.
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-cline/ssy-account',
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405).end()
        return
      }
      const apiKey = readSsyApiKey()
      if (apiKey === undefined) {
        sendJson(res, 200, { ok: false, reason: 'no-key' })
        return
      }
      try {
        const range = 'startDate=' + ssyDate(7) + '&endDate=' + ssyDate(0)
        const [info, rate, usage] = await Promise.all([
          ssyApiGet<{ Nickname?: unknown, Username?: unknown, Wallet?: { Assets?: unknown } }>('/user/info', apiKey),
          ssyApiGet<number>('/base/rate', apiKey),
          ssyApiGet<{ logs?: Array<{ request_time?: unknown, model?: { company?: unknown, name?: unknown }, total_amount?: unknown, input_tokens?: unknown, output_tokens?: unknown }> }>(
            '/modelrouter/userlog?page=1&pageSize=1000&' + range, apiKey),
        ])
        const rateNumber = typeof rate === 'number' ? rate : Number(rate)
        const logs = Array.isArray(usage?.logs) ? usage.logs : []
        const entries = logs.map(log => {
          const model = log.model !== null && typeof log.model === 'object' ? log.model : undefined
          const amount = Number(log.total_amount ?? 0)
          return {
            at: typeof log.request_time === 'string' ? log.request_time : '',
            model: [model?.company, model?.name].filter(v => typeof v === 'string' && v !== '').join('/'),
            // The reference's formula: credits = rate * total_amount / 1e7.
            credits: Number.isFinite(rateNumber) ? (rateNumber * amount) / 10_000_000 : 0,
            promptTokens: Number(log.input_tokens ?? 0),
            completionTokens: Number(log.output_tokens ?? 0),
          }
        })
        const assets = Number(info?.Wallet?.Assets ?? NaN)
        sendJson(res, 200, {
          ok: true,
          displayName: typeof info?.Nickname === 'string' && info.Nickname !== ''
            ? info.Nickname
            : typeof info?.Username === 'string' ? info.Username : undefined,
          balance: Number.isFinite(assets) ? assets / 10_000 : undefined,
          usageDays: 7,
          usageTotal: entries.reduce((sum, e) => sum + e.credits, 0),
          usage: entries.slice(0, 50),
        })
      } catch (err: unknown) {
        sendJson(res, 200, { ok: false, reason: 'api', error: String(err) })
      }
    },
  }), 'dsh-cline-host-services: ssy-account route')
}
