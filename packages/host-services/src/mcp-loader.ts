/**
 * MCP loader: reads `~/.dsh/dsh-cline/mcp.json` and mounts one
 * `@deepseek-ai/dsh-mcp-client` plugin instance per declared server, so MCP
 * tools (`mcp__<server>__<tool>`) compose from a user-editable file instead
 * of hand-written cordis rows. Independent of the VS Code bridge: a plain
 * `dsh web` gets the same MCP servers.
 *
 * @module @dsh-cline/host-services/mcp-loader
 */

import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** One declared server in mcp.json (fields beyond serverName pass through). */
interface DeclaredServer {
  transport?: unknown
  command?: unknown
  args?: unknown
  env?: unknown
  cwd?: unknown
  url?: unknown
  headers?: unknown
  toolCallTimeoutMs?: unknown
  failOnStartupError?: unknown
  reconnect?: unknown
  /** Managed-UI switch: a disabled server stays declared but is never mounted. */
  disabled?: unknown
}

/** The mcp.json document. */
export interface McpDocument {
  servers?: unknown
}

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** The mcp.json file path (DSH_CLINE_MCP override, else $DSH_HOME/dsh-cline/mcp.json). */
export function mcpConfigFile(): string {
  return process.env.DSH_CLINE_MCP ?? join(dshHome(), 'dsh-cline', 'mcp.json')
}

/**
 * Validate one mcp.json document server-by-server (the same rules the loader
 * enforces), so the managed-UI write path rejects a bad edit before it lands
 * in the file a next boot would fail on. Returns the normalized document.
 * @param doc - the parsed candidate document.
 * @returns every server entry, validated and `disabled` flag preserved.
 */
export function validateMcpDocument(doc: McpDocument): Record<string, Record<string, unknown>> {
  if (doc === null || typeof doc !== 'object' || typeof doc.servers !== 'object' || doc.servers === null || Array.isArray(doc.servers)) {
    throw new Error('mcp.json 必须包含 "servers" 对象')
  }
  const out: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>
  if (Object.keys(doc.servers).length > 128) throw new Error('mcp.json: at most 128 servers are supported')
  for (const [serverName, declared] of Object.entries(doc.servers as Record<string, unknown>)) {
    if (!SERVER_NAME_PATTERN.test(serverName)) {
      throw new Error('MCP 服务器名 ' + JSON.stringify(serverName) + ' 须匹配 [A-Za-z0-9_-]{1,32}')
    }
    if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
      throw new Error('MCP 服务器 ' + JSON.stringify(serverName) + ' 必须是对象')
    }
    const entry = declared as DeclaredServer
    if (entry.disabled !== undefined && typeof entry.disabled !== 'boolean') throw new Error('MCP disabled must be boolean')
    serverConfig(serverName, entry)
    out[serverName] = entry as Record<string, unknown>
  }
  return out
}

/**
 * Load and mount every declared MCP server. A malformed file or entry fails
 * loud (throws out of apply); a server that fails to CONNECT stays contained
 * by the client plugin's own reconnect policy (failOnStartupError defaults
 * false there).
 * @param ctx - plugin context mounting the per-server client instances.
 * @returns the number of mounted servers (0 when no config file exists).
 */
export async function loadMcpServers(ctx: Context): Promise<number> {
  const file = mcpConfigFile()
  if (!existsSync(file)) {
    ctx.logger.info('no ' + file + '; skipping MCP servers')
    return 0
  }
  let doc: McpDocument
  try {
    doc = JSON.parse(readFileSync(file, 'utf8')) as McpDocument
  } catch (err: unknown) {
    throw new Error('dsh-cline mcp.json is not valid JSON: ' + String(err))
  }
  const mod = await import('@deepseek-ai/dsh-mcp-client')
  let mounted = 0
  for (const [serverName, declared] of Object.entries(validateMcpDocument(doc))) {
    if (declared.disabled === true) {
      ctx.logger.info('MCP server disabled, not mounted: ' + serverName)
      continue
    }
    const config = serverConfig(serverName, declared as DeclaredServer)
    ctx.plugin(mod, config)
    ctx.logger.info('MCP server mounted: ' + serverName + ' (' + String(config.transport) + ')')
    mounted++
  }
  return mounted
}

/** Validate one declared server into the client plugin's config shape. */
function serverConfig(serverName: string, declared: DeclaredServer): Record<string, unknown> {
  validateOptions(declared)
  if (declared.transport === 'stdio') {
    if (typeof declared.command !== 'string' || declared.command.trim() === '' || declared.command.includes('\0')) {
      throw new Error('dsh-cline mcp.json: stdio server ' + serverName + ' needs "command"')
    }
    return { ...pick(declared), serverName, transport: 'stdio', command: declared.command }
  }
  if (declared.transport === 'streamable-http') {
    let validUrl = false
    try {
      const url = new URL(typeof declared.url === 'string' ? declared.url : '')
      validUrl = ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === ''
    } catch { /* report the same actionable error below */ }
    if (!validUrl) {
      throw new Error('dsh-cline mcp.json: streamable-http server ' + serverName + ' needs an http(s) "url"')
    }
    return { ...pick(declared), serverName, transport: 'streamable-http' }
  }
  throw new Error('dsh-cline mcp.json: server ' + serverName
    + ' needs "transport": "stdio" or "streamable-http"')
}

/** Reject malformed values before they can break the next process startup. */
function validateOptions(entry: DeclaredServer): void {
  if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) {
    throw new Error('MCP args must be an array of strings without NUL')
  }
  for (const field of ['env', 'headers'] as const) {
    const value = entry[field]
    if (value !== undefined && (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.entries(value).some(([key, item]) => key.includes('\0') || typeof item !== 'string' || item.includes('\0')))) {
      throw new Error('MCP ' + field + ' must contain string values')
    }
  }
  if (entry.cwd !== undefined && (typeof entry.cwd !== 'string' || entry.cwd.includes('\0'))) throw new Error('MCP cwd must be a string without NUL')
  if (entry.failOnStartupError !== undefined && typeof entry.failOnStartupError !== 'boolean') throw new Error('MCP failOnStartupError must be boolean')
  if (entry.toolCallTimeoutMs !== undefined && (!Number.isInteger(entry.toolCallTimeoutMs) || Number(entry.toolCallTimeoutMs) < 1 || Number(entry.toolCallTimeoutMs) > 2_147_483_647)) {
    throw new Error('MCP toolCallTimeoutMs must be an integer between 1 and 2147483647')
  }
  if (entry.reconnect !== undefined) {
    if (entry.reconnect === null || typeof entry.reconnect !== 'object' || Array.isArray(entry.reconnect)) throw new Error('MCP reconnect must be an object')
    const reconnect = entry.reconnect as Record<string, unknown>
    if (reconnect.enabled !== undefined && typeof reconnect.enabled !== 'boolean') throw new Error('MCP reconnect.enabled must be boolean')
    for (const key of ['initialDelayMs', 'maxDelayMs', 'maxAttempts'] as const) {
      const value = reconnect[key]
      const max = key === 'maxAttempts' ? Number.MAX_SAFE_INTEGER : 2_147_483_647
      if (value !== undefined && (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > max)) throw new Error('MCP reconnect.' + key + ' is out of range')
    }
    if (reconnect.initialDelayMs !== undefined && reconnect.maxDelayMs !== undefined && Number(reconnect.initialDelayMs) > Number(reconnect.maxDelayMs)) {
      throw new Error('MCP reconnect.initialDelayMs cannot exceed maxDelayMs')
    }
  }
}

/** Keep only the optional fields the client config schema understands. */
function pick(declared: DeclaredServer): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of ['args', 'env', 'cwd', 'url', 'headers', 'toolCallTimeoutMs', 'failOnStartupError', 'reconnect'] as const) {
    const value = declared[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

/** DSH home (`DSH_HOME` or `~/.dsh`). */
function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}
