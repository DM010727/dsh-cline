/**
 * @dsh-cline/host-services - the DSH-side half of the VS Code bridge.
 *
 * A function plugin for the dsh web profile: when the launching environment
 * carries a bridge URL (DSH_CLINE_BRIDGE, set by the DSH Cline extension when
 * it spawns the sidecar), it provides the `vscodeHost` service whose methods
 * RPC the extension host over loopback HTTP, and mounts a diagnostic route on
 * the web carrier. Without the environment the plugin stays dormant, so a
 * plain `dsh web` boots unchanged.
 *
 * @module @dsh-cline/host-services
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Context, WebServerService } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installSettingsSection } from '@deepseek-ai/dsh-settings'
import { registerDiffMirror } from './diff-mirror.js'
import { registerVscodeTool } from './vscode-tool.js'
import { loadMcpServers } from './mcp-loader.js'
import { registerCheckpoint } from './checkpoint.js'
import { registerWebGateway } from './web-gateway.js'
import { registerTaskInjector } from './task-injector.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-cline-host-services'

/** Services this plugin consumes: the web carrier, plus the tool and prompt registries its vscode tool extends. */
export const inject = ['webServer', 'tools', 'systemPrompt']

/** Settings namespace the web「DSH Cline」section edits (checkpoint policy). */
export const SETTINGS_NS = 'dsh-cline-host-services'

/** Service name consumers inject to reach the VS Code extension host. */
export const VSCODE_HOST_SERVICE = 'vscodeHost'

/** One host-service invocation crossing the bridge. */
export interface BridgeRequest {
  service: string
  method: string
  args: unknown[]
}

/** Settlement coming back from the extension host. */
export interface BridgeResult {
  ok: boolean
  result?: unknown
  error?: string
}

/** The vscodeHost service surface (grows per gate). */
export interface VscodeHostService {
  /** Liveness probe of the extension-host bridge. */
  ping(): Promise<{ pong: true; extensionVersion: string }>
  /** Generic channel for future vscode.* methods. */
  call(service: string, method: string, args: unknown[]): Promise<unknown>
}

/** Plugin config: the loopback bridge URL the extension host listens on. */
export interface PluginConfig {
  bridgeUrl?: string | null
  /** Which tools trigger pre-execution auto-snapshots. */
  checkpointAuto?: 'off' | 'edit-only' | 'all'
}

/** The settings-editable slice of the config (the composition entry's bridgeUrl is not user-editable). */
interface SettingsConfig {
  checkpointAuto?: 'off' | 'edit-only' | 'all'
}

/** Config schema of {@link SETTINGS_NS} (web section writes land here). Schemastery,
 * like every DSH settings consumer: the service VALIDATES by calling `schema(value)`,
 * and a zod schema is not callable - registering with one fails the namespace. */
const ConfigSchema = z.object({
  checkpointAuto: z.union([z.const('off'), z.const('edit-only'), z.const('all')]),
})

/** Settings base layer: the composition entry's checkpoint policy with its default resolved. */
function entryOf(config: PluginConfig): SettingsConfig {
  return { checkpointAuto: config.checkpointAuto ?? 'edit-only' }
}

/** Default request budget for one bridge RPC. */
const BRIDGE_TIMEOUT_MS = 20_000

/**
 * Bridge locator file the extension rewrites at EVERY activation
 * ($DSH_HOME/bridge.json). The env-injected DSH_CLINE_BRIDGE goes stale the
 * moment the window reloads: the terminal-resident dsh web (and its terminal,
 * via VS Code's persistent sessions) outlives the extension host that wrote
 * the env, so a freshly reloaded extension listens on a new bridge port while
 * this still-running process keeps posting to the dead one — "bridge
 * unreachable: fetch failed" until DSH restarts. Reading the locator file
 * instead keeps bridge calls glued to whichever extension host activated most
 * recently, no DSH restart needed. The env config remains the fallback for a
 * dsh web the file writer never reached (plain dsh web has no DSH_HOME).
 * @returns the fresh loopback bridge URL, or undefined when absent/corrupt.
 */
function bridgeFileUrl(): string | undefined {
  const home = process.env.DSH_HOME
  if (home === undefined || home === '') return undefined
  try {
    const parsed = JSON.parse(readFileSync(join(home, 'bridge.json'), 'utf8')) as { url?: unknown }
    const url = parsed.url
    if (typeof url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/.+$/.test(url)) return url
  } catch { /* no locator yet, or mid-write: fall back to the composition entry */ }
  return undefined
}

/** Diagnostic route path on the web carrier. */
const HEALTH_PATH = '/dsh-cline/health'

/**
 * Mount MCP servers from the user config file (bridge-independent), then
 * activate the VS Code bridge when the launching environment provided one.
 * @param ctx - plugin context carrying webServer/tools/systemPrompt.
 * @param config - composed row config; `bridgeUrl` absent or null means no
 *   VS Code host launched this process, so only the MCP half activates.
 */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  // Register the settings namespace the web「DSH Cline」section edits: without
  // it every settings.mutate against 'dsh-cline-host-services' rejects with
  // "settings namespace is not registered". While a settings service exists
  // the resolved scope is authoritative; otherwise the composition entry is.
  let current: () => SettingsConfig = () => entryOf(config)
  installSettingsSection(ctx, SETTINGS_NS, ConfigSchema, entryOf(config), {
    setSource: (source) => { current = source },
    onChange: () => { /* checkpointAuto is read per tool dispatch */ },
  })

  const mcpServers = await loadMcpServers(ctx)
  registerCheckpoint(ctx, () => current().checkpointAuto ?? 'edit-only')
  // Prefer the locator file over the composition env: it tracks the live
  // extension host across window reloads, the env value does not.
  const bridgeUrl = bridgeFileUrl() ?? config.bridgeUrl

  const webServer = ctx.get('webServer') as WebServerService | undefined
  if (webServer === undefined) {
    throw new Error('dsh-cline-host-services: webServer service unavailable despite inject')
  }

  // Selection-actions injector: bridge-independent (it drives the DSH agent
  // directly), so mount it whether or not a VS Code host launched this process.
  registerTaskInjector(ctx, webServer)

  if (bridgeUrl === undefined || bridgeUrl === null || bridgeUrl === '') {
    ctx.logger.info('no bridgeUrl configured; bridge half dormant (plain dsh web)')
    // The gateway still mounts: the catalog proxy is bridge-independent, and
    // the bridge-dependent routes answer a clean 503 instead of 404.
    registerWebGateway(ctx, webServer, undefined)
    return
  }  if (!/^http:\/\/127\.0\.0\.1:\d+\/.+$/.test(bridgeUrl)) {
    throw new Error(
      'dsh-cline-host-services: bridgeUrl must be a loopback URL with a token path '
      + '(http://127.0.0.1:<port>/<token>), got ' + JSON.stringify(bridgeUrl),
    )
  }

  // Resolve per call: a window reload replaces the extension host (new bridge
  // port) and rewrites the locator file; re-reading it here keeps this
  // long-lived process talking to the CURRENT bridge without a DSH restart.
  const bridge = createBridgeClient(() => bridgeFileUrl() ?? bridgeUrl)
  const service: VscodeHostService = {
    async ping() {
      const raw = await bridge({ service: 'vscode.host', method: 'ping', args: [] })
      return raw as { pong: true; extensionVersion: string }
    },
    call(service, method, args) {
      return bridge({ service, method, args }).then(v => v as unknown)
    },
  }
  ctx.provide(VSCODE_HOST_SERVICE, service)
  registerDiffMirror(ctx, service)
  registerVscodeTool(ctx, service)
  registerWebGateway(ctx, webServer, service)
  ctx.logger.info('vscodeHost provided via bridge ' + bridgeUrl.replace(/\/[^/]+$/, '/***'))
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: HEALTH_PATH,
    handler: async (req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405).end()
        return
      }
      try {
        const pong = await service.ping()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ bridge: 'up', mcpServers, ...pong }))
      } catch (err: unknown) {
        res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ bridge: 'down', mcpServers, error: String(err) }))
      }
    },
  }), 'dsh-cline-host-services: health route')
}

/** POST one RPC to the extension-host bridge and unwrap its envelope. */
function createBridgeClient(resolveUrl: () => string): (request: BridgeRequest) => Promise<unknown> {
  return async (request: BridgeRequest): Promise<unknown> => {
    let response: Response
    try {
      response = await fetch(resolveUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
      })
    } catch (err: unknown) {
      throw new Error('dsh-cline bridge unreachable: ' + String(err))
    }
    if (!response.ok) {
      throw new Error('dsh-cline bridge HTTP ' + String(response.status))
    }
    const envelope = await response.json() as BridgeResult
    if (!envelope.ok) {
      throw new Error('dsh-cline bridge error: ' + (envelope.error ?? 'unknown'))
    }
    return envelope.result
  }
}
