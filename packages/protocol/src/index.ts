/**
 * Shared contracts between the VS Code extension host and DSH-side plugins.
 *
 * The protocol layer is pure types plus channel constants: both sides bundle
 * their own copy, so only JSON-compatible values cross the boundary.
 *
 * @module @dsh-cline/protocol
 */

/** Lifecycle of the DSH sidecar process, as observed by the extension host. */
export type SidecarState = 'stopped' | 'starting' | 'ready' | 'failed'

/** Sidecar snapshot posted to webview shells and shown in the status bar. */
export interface SidecarStatus {
  state: SidecarState
  /** Loopback URL of the sidecar once ready, e.g. http://127.0.0.1:52341. */
  url?: string
  /** Human-readable diagnostic for the starting/failed states. */
  detail?: string
}

/** Channel constant for the postMessage bridge shell <-> extension host. */
export const SHELL_CHANNEL = 'dsh-cline.shell'

/** Channel constant for onboarding-guide page messages, guide -> extension host. */
export const GUIDE_CHANNEL = 'dsh-cline.guide'

/** Where the resolved `dsh` executable came from; drives the guide page. */
export type DshVia = 'configured' | 'path' | 'npx-cache' | 'none'

/** Runtime detection snapshot backing the onboarding guide page. */
export interface RuntimeStatus {
  /** Whether a usable `node` is on PATH (npm install needs it). */
  node: boolean
  via: DshVia
  cmd: string
}

/** Messages the onboarding guide page sends to the extension host. */
export type GuideToHost =
  | { channel: typeof GUIDE_CHANNEL; type: 'install' }
  | { channel: typeof GUIDE_CHANNEL; type: 'install-node' }
  | { channel: typeof GUIDE_CHANNEL; type: 'open-node-page' }
  | { channel: typeof GUIDE_CHANNEL; type: 'show-terminal' }
  | { channel: typeof GUIDE_CHANNEL; type: 'recheck' }
  | { channel: typeof GUIDE_CHANNEL; type: 'continue-anyway' }

/** Messages the webview shell sends to the extension host. */
export type ShellToHost =
  | { channel: typeof SHELL_CHANNEL; type: 'shell-ready' }
  | { channel: typeof SHELL_CHANNEL; type: 'retry' }

/** Messages the extension host sends to the webview shell. */
export type HostToShell =
  | { channel: typeof SHELL_CHANNEL; type: 'status'; status: SidecarStatus }
  | { channel: typeof SHELL_CHANNEL; type: 'bridge'; payload: unknown }

/**
 * Channel constant for host-service RPC relayed shell <-> extension host.
 * Gate 2: the DSH client plugin posts these from inside the iframe; the shell
 * relays them; the extension host executes the real VS Code API call.
 */
export const HOST_SERVICE_CHANNEL = 'dsh-cline.host-service'

/** One host-service invocation, DSH side -> extension host. */
export interface HostServiceRequest {
  channel: typeof HOST_SERVICE_CHANNEL
  /** Correlation id; the response echoes it. */
  id: number
  /** Logical service name, e.g. 'vscode.diff'. */
  service: string
  /** Method on that service. */
  method: string
  /** JSON arguments. */
  args: unknown[]
}

/** Settlement of a host-service invocation, extension host -> DSH side. */
export interface HostServiceResponse {
  channel: typeof HOST_SERVICE_CHANNEL
  id: number
  ok: boolean
  result?: unknown
  error?: string
}
