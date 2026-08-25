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
import type { Context } from '@deepseek-ai/cordis';
/** Stable Cordis plugin name. */
export declare const name = "dsh-cline-host-services";
/** Services this plugin consumes: the web carrier, plus the tool and prompt registries its vscode tool extends. */
export declare const inject: string[];
/** Settings namespace the web「DSH Cline」section edits (checkpoint policy). */
export declare const SETTINGS_NS = "dsh-cline-host-services";
/** Service name consumers inject to reach the VS Code extension host. */
export declare const VSCODE_HOST_SERVICE = "vscodeHost";
/** One host-service invocation crossing the bridge. */
export interface BridgeRequest {
    service: string;
    method: string;
    args: unknown[];
}
/** Settlement coming back from the extension host. */
export interface BridgeResult {
    ok: boolean;
    result?: unknown;
    error?: string;
}
/** The vscodeHost service surface (grows per gate). */
export interface VscodeHostService {
    /** Liveness probe of the extension-host bridge. */
    ping(): Promise<{
        pong: true;
        extensionVersion: string;
    }>;
    /** Generic channel for future vscode.* methods. */
    call(service: string, method: string, args: unknown[]): Promise<unknown>;
}
/** Plugin config: the loopback bridge URL the extension host listens on. */
export interface PluginConfig {
    bridgeUrl?: string | null;
    /** Which tools trigger pre-execution auto-snapshots. */
    checkpointAuto?: 'off' | 'edit-only' | 'all';
}
/**
 * Mount MCP servers from the user config file (bridge-independent), then
 * activate the VS Code bridge when the launching environment provided one.
 * @param ctx - plugin context carrying webServer/tools/systemPrompt.
 * @param config - composed row config; `bridgeUrl` absent or null means no
 *   VS Code host launched this process, so only the MCP half activates.
 */
export declare function apply(ctx: Context, config: PluginConfig): Promise<void>;
