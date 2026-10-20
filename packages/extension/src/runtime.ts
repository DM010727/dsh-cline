import { createHash } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/** Exact official npm next release verified during the 2026-10-19 audit. */
export const DSH_VERSION = '0.2.1-rc.2'
export const DSH_RUNTIME_REVISION = '0.2.1-rc.2-r1'

/** Validate the dependency-pinned install, never just a global version string. */
export async function checkManagedRuntime(assets: string, home: string): Promise<{ ok: boolean; version?: string; command?: string; reason?: string }> {
  try {
    const { stdout } = await promisify(execFile)('node', [join(assets, 'verify.mjs'), '--home', home], { windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 })
    const value = JSON.parse(stdout) as { ok?: unknown; version?: unknown; command?: unknown }
    if (value.ok === true && value.version === DSH_VERSION && typeof value.command === 'string' && isAbsolute(value.command)) {
      return { ok: true, version: value.version, command: value.command }
    }
  } catch { /* Missing, modified or unpatched installs must go through repair. */ }
  return { ok: false, reason: '尚未安装或校验未通过。请安装／修复扩展专用 DSH 运行时，然后重新检测。' }
}

export function managedInstallLine(assets: string, home: string, useMirror = false, windows = process.platform === 'win32'): string {
  return launchLine('node', [join(assets, 'install.mjs'), '--home', home,
    ...(useMirror ? ['--registry', 'https://registry.npmmirror.com'] : [])], windows)
}

export function supportsNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim())
  if (!match) return false
  const major = Number(match[1])
  return major >= 24 || major === 22 && Number(match[2]) >= 19
}

export function workspaceKey(cwd: string): string {
  const normalized = resolve(cwd)
  return createHash('sha256').update(process.platform === 'win32' ? normalized.toLowerCase() : normalized).digest('hex').slice(0, 12)
}

export function workspacePort(cwd: string): number {
  return 40_000 + Number.parseInt(workspaceKey(cwd).slice(0, 6), 16) % 20_000
}

export function servicePort(configured: number | undefined, cwd: string): number {
  const port = configured === undefined || configured === 0 ? workspacePort(cwd) : configured
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('DSH 端口必须为 1024–65535 的整数')
  return port
}

/** The extension explicitly creates PowerShell on Windows and sh elsewhere. */
export function launchLine(cmd: string, args: readonly string[], windows = process.platform === 'win32'): string {
  if (!cmd || /[\r\n\0]/.test(cmd) || args.some(arg => /[\r\n\0]/.test(arg))) throw new Error('命令不能包含换行或 NUL')
  const quote = (value: string): string => windows ? "'" + value.replace(/'/g, "''") + "'" : "'" + value.replace(/'/g, "'\\''") + "'"
  return (windows ? '& ' : '') + [cmd, ...args].map(quote).join(' ')
}
