/**
 * MCP loader: reads `~/.dsh/dsh-cline/mcp.json` and mounts one
 * `@deepseek-ai/dsh-mcp-client` plugin instance per declared server, so MCP
 * tools (`mcp__<server>__<tool>`) compose from a user-editable file instead
 * of hand-written cordis rows. Independent of the VS Code bridge: a plain
 * `dsh web` gets the same MCP servers.
 *
 * @module @dsh-cline/host-services/mcp-loader
 */
import type { Context } from '@deepseek-ai/cordis';
/** The mcp.json document. */
export interface McpDocument {
    servers?: unknown;
}
/** The mcp.json file path (DSH_CLINE_MCP override, else $DSH_HOME/dsh-cline/mcp.json). */
export declare function mcpConfigFile(): string;
/**
 * Validate one mcp.json document server-by-server (the same rules the loader
 * enforces), so the managed-UI write path rejects a bad edit before it lands
 * in the file a next boot would fail on. Returns the normalized document.
 * @param doc - the parsed candidate document.
 * @returns every server entry, validated and `disabled` flag preserved.
 */
export declare function validateMcpDocument(doc: McpDocument): Record<string, Record<string, unknown>>;
/**
 * Load and mount every declared MCP server. A malformed file or entry fails
 * loud (throws out of apply); a server that fails to CONNECT stays contained
 * by the client plugin's own reconnect policy (failOnStartupError defaults
 * false there).
 * @param ctx - plugin context mounting the per-server client instances.
 * @returns the number of mounted servers (0 when no config file exists).
 */
export declare function loadMcpServers(ctx: Context): Promise<number>;
