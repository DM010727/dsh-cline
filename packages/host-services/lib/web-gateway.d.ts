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
 *
 * @module @dsh-cline/host-services/web-gateway
 */
import type { Context, WebServerService } from '@deepseek-ai/cordis';
import type { VscodeHostService } from './index.js';
/** A model row from the Shengsuanyun catalog (subset we forward). */
export interface ShengsuanyunModel {
    id: string;
    name?: string;
    company?: string;
    description?: string;
    context_window?: number;
    max_tokens?: number;
    supports_prompt_cache?: boolean;
    pricing?: Record<string, unknown>;
    support_apis?: string[];
}
/**
 * Mount the gateway routes. The bridge-dependent routes answer 503 when no
 * VS Code host launched this process (plain `dsh web`); the catalog proxy is
 * bridge-independent and always serves.
 * @param ctx - plugin context (logging).
 * @param webServer - the DSH web carrier service.
 * @param bridge - the vscodeHost bridge face, or undefined when dormant.
 */
export declare function registerWebGateway(ctx: Context, webServer: WebServerService, bridge: VscodeHostService | undefined): void;
