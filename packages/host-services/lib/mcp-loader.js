/**
 * MCP loader: reads `~/.dsh/dsh-cline/mcp.json` and mounts one
 * `@deepseek-ai/dsh-mcp-client` plugin instance per declared server, so MCP
 * tools (`mcp__<server>__<tool>`) compose from a user-editable file instead
 * of hand-written cordis rows. Independent of the VS Code bridge: a plain
 * `dsh web` gets the same MCP servers.
 *
 * @module @dsh-cline/host-services/mcp-loader
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** The mcp.json file path (DSH_CLINE_MCP override, else $DSH_HOME/dsh-cline/mcp.json). */
export function mcpConfigFile() {
    return process.env.DSH_CLINE_MCP ?? join(dshHome(), 'dsh-cline', 'mcp.json');
}
/**
 * Validate one mcp.json document server-by-server (the same rules the loader
 * enforces), so the managed-UI write path rejects a bad edit before it lands
 * in the file a next boot would fail on. Returns the normalized document.
 * @param doc - the parsed candidate document.
 * @returns every server entry, validated and `disabled` flag preserved.
 */
export function validateMcpDocument(doc) {
    if (typeof doc.servers !== 'object' || doc.servers === null || Array.isArray(doc.servers)) {
        throw new Error('mcp.json 必须包含 "servers" 对象');
    }
    const out = {};
    for (const [serverName, declared] of Object.entries(doc.servers)) {
        if (!SERVER_NAME_PATTERN.test(serverName)) {
            throw new Error('MCP 服务器名 ' + JSON.stringify(serverName) + ' 须匹配 [A-Za-z0-9_-]{1,32}');
        }
        if (typeof declared !== 'object' || declared === null) {
            throw new Error('MCP 服务器 ' + JSON.stringify(serverName) + ' 必须是对象');
        }
        const entry = declared;
        if (entry.disabled !== true)
            serverConfig(serverName, entry);
        out[serverName] = entry;
    }
    return out;
}
/**
 * Load and mount every declared MCP server. A malformed file or entry fails
 * loud (throws out of apply); a server that fails to CONNECT stays contained
 * by the client plugin's own reconnect policy (failOnStartupError defaults
 * false there).
 * @param ctx - plugin context mounting the per-server client instances.
 * @returns the number of mounted servers (0 when no config file exists).
 */
export async function loadMcpServers(ctx) {
    const file = mcpConfigFile();
    if (!existsSync(file)) {
        ctx.logger.info('no ' + file + '; skipping MCP servers');
        return 0;
    }
    let doc;
    try {
        doc = JSON.parse(readFileSync(file, 'utf8'));
    }
    catch (err) {
        throw new Error('dsh-cline mcp.json is not valid JSON: ' + String(err));
    }
    const mod = await import('@deepseek-ai/dsh-mcp-client');
    let mounted = 0;
    for (const [serverName, declared] of Object.entries(validateMcpDocument(doc))) {
        if (declared.disabled === true) {
            ctx.logger.info('MCP server disabled, not mounted: ' + serverName);
            continue;
        }
        const config = serverConfig(serverName, declared);
        ctx.plugin(mod, config);
        ctx.logger.info('MCP server mounted: ' + serverName + ' (' + String(config.transport) + ')');
        mounted++;
    }
    return mounted;
}
/** Validate one declared server into the client plugin's config shape. */
function serverConfig(serverName, declared) {
    if (declared.transport === 'stdio') {
        if (typeof declared.command !== 'string' || declared.command === '') {
            throw new Error('dsh-cline mcp.json: stdio server ' + serverName + ' needs "command"');
        }
        return { ...pick(declared), serverName, transport: 'stdio' };
    }
    if (declared.transport === 'streamable-http') {
        if (typeof declared.url !== 'string' || !/^https?:\/\//.test(declared.url)) {
            throw new Error('dsh-cline mcp.json: streamable-http server ' + serverName + ' needs an http(s) "url"');
        }
        return { ...pick(declared), serverName, transport: 'streamable-http' };
    }
    throw new Error('dsh-cline mcp.json: server ' + serverName
        + ' needs "transport": "stdio" or "streamable-http"');
}
/** Keep only the optional fields the client config schema understands. */
function pick(declared) {
    const out = {};
    for (const key of ['args', 'env', 'cwd', 'url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError', 'reconnect']) {
        const value = declared[key];
        if (value !== undefined)
            out[key] = value;
    }
    return out;
}
/** DSH home (`DSH_HOME` or `~/.dsh`). */
function dshHome() {
    return process.env.DSH_HOME ?? join(homedir(), '.dsh');
}
