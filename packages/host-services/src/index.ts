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
import { randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import type { Context, Volatile, WebServerService } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { registerDiffMirror } from './diff-mirror.js'
import { registerVscodeTool } from './vscode-tool.js'
import { loadMcpServers } from './mcp-loader.js'
import { registerCheckpoint } from './checkpoint.js'
import { registerWebGateway } from './web-gateway.js'
import { registerTaskInjector } from './task-injector.js'
import { createHealthHandler, isBridgeUrl } from './web-bootstrap.js'
import { canonicalPath, isWithinWorkspace } from './workspace-context.js'
import { registerWorkspaceBridge } from './workspace-bridge.js'

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
  checkpointAuto: Volatile<'off' | 'edit-only' | 'all'>
}

/** rc.2 settings expose the live checkpoint policy from this Loader entry. */
export const Config = z.object({
  bridgeUrl: z.union([z.string(), z.const(null)]).default(null),
  checkpointAuto: z.union([z.const('off'), z.const('edit-only'), z.const('all')]).default('edit-only').volatile(),
})

/** Default request budget for one bridge RPC. */
const BRIDGE_TIMEOUT_MS = 20_000
const instanceId = randomUUID()

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
    const configured = process.env.DSH_CLINE_BRIDGE_FILE
    const file = configured === undefined || configured === '' ? join(home, 'bridge.json') : resolve(configured)
    const rel = relative(resolve(home), file)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith('../') || rel.startsWith('..\\')) return undefined
    if (!isWithinWorkspace(canonicalPath(file), canonicalPath(home))) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { url?: unknown }
    const url = parsed.url
    if (isBridgeUrl(url)) return url
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
  // rc.2 settings project the volatile field from this plugin's Loader entry.
  // The client provides a custom page, so suppress only the generated form.
  ctx.inject(['settings'], child => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber))
  })

  const mcpServers = await loadMcpServers(ctx)
  registerCheckpoint(ctx, () => config.checkpointAuto.get())
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
    registerHealth(ctx, webServer, undefined, mcpServers, () => bridgeFileUrl() ?? config.bridgeUrl)
    return
  }
  if (!isBridgeUrl(bridgeUrl)) {
    throw new Error(
      'dsh-cline-host-services: bridgeUrl must be a loopback URL with a token path '
      + '(http://127.0.0.1:<port>/<token>)',
    )
  }

  registerWorkspaceBridge(ctx, webServer)

  // Resolve per call: a window reload replaces the extension host (new bridge
  // port) and rewrites the locator file; re-reading it here keeps this
  // long-lived process talking to the CURRENT bridge without a DSH restart.
  const bridge = createBridgeClient(() => bridgeFileUrl() ?? bridgeUrl)
  const service: VscodeHostService = {
    async ping() {
      const raw = await bridge({ service: 'vscode.host', method: 'ping', args: [] })
      if (raw === null || typeof raw !== 'object' || (raw as { pong?: unknown }).pong !== true
        || typeof (raw as { extensionVersion?: unknown }).extensionVersion !== 'string') throw new Error('invalid VS Code bridge pong')
      return { pong: true, extensionVersion: (raw as { extensionVersion: string }).extensionVersion }
    },
    call(service, method, args) {
      return bridge({ service, method, args }).then(v => v as unknown)
    },
  }
  ctx.provide(VSCODE_HOST_SERVICE, service)
  registerDiffMirror(ctx, service)
  registerVscodeTool(ctx, service)
  registerWebGateway(ctx, webServer, service)
  registerHealth(ctx, webServer, service, mcpServers, () => bridgeFileUrl() ?? config.bridgeUrl)
  ctx.logger.info('vscodeHost provided via bridge ' + bridgeUrl.replace(/\/[^/]+$/, '/***'))
}

function registerHealth(ctx: Context, webServer: WebServerService, service: VscodeHostService | undefined, mcpServers: number, bridgeUrl: () => unknown): void {
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: HEALTH_PATH,
    handler: createHealthHandler({
      identity: () => ({ plugin: name, workspaceRoot: process.cwd(), instanceId, mcpServers,
        runtimeRevision: process.env.DSH_CLINE_RUNTIME_REVISION ?? null }),
      service,
      bridgeUrl,
      connection: () => ctx.get('connection'),
    }),
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
        redirect: 'error',
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
