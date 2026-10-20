/**
 * Retired Shengsuanyun seed cleanup. Only exact historical sections are removed;
 * unknown duplicate settings and user-edited profiles are preserved byte-for-byte.
 */
import {
  existsSync, lstatSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

const BEGIN = '# === dsh-cline shengsuanyun defaults (managed block, do not edit) ==='
const END = '# === end dsh-cline shengsuanyun defaults ==='
const SEED_SECTION = [
  'llm-pi-ai:',
  '  providers:',
  '    # DSH Cline default provider: Shengsuanyun, three wire protocols, one key.',
  '    shengsuanyun:',
  '      displayName: 胜算云',
  '      api: openai-completions',
  '      baseURL: https://router.shengsuanyun.com/api/v1',
  '      apiKeyEnv: SHENGSUANYUN_API_KEY',
  '    shengsuanyun-responses:',
  '      displayName: 胜算云 (Responses)',
  '      api: openai-responses',
  '      baseURL: https://router.shengsuanyun.com/api/v1',
  '      apiKeyEnv: SHENGSUANYUN_API_KEY',
  '    shengsuanyun-messages:',
  '      displayName: 胜算云 (Messages)',
  '      api: anthropic-messages',
  '      baseURL: https://router.shengsuanyun.com/api/v1',
  '      apiKeyEnv: SHENGSUANYUN_API_KEY',
].join('\n')

export const SSY_ROUTES_DATA = [
  { route: 'shengsuanyun', displayName: '胜算云', api: 'openai-completions' },
  { route: 'shengsuanyun-responses', displayName: '胜算云 (Responses)', api: 'openai-responses' },
  { route: 'shengsuanyun-messages', displayName: '胜算云 (Messages)', api: 'anthropic-messages' },
]
export const SSY_BASE_URL = 'https://router.shengsuanyun.com/api/v1'
export const SSY_KEY_REF = 'SHENGSUANYUN_API_KEY'

/** Resolve the isolated installation home, rejecting the user's original DSH tree. */
function canonical(path) {
  let current = resolve(path)
  const tail = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return resolve(path)
    tail.unshift(basename(current))
    current = parent
  }
  return join(realpathSync.native(current), ...tail)
}
function within(parent, path) {
  const part = relative(parent, path)
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part))
}
export function isolatedHome(value = process.env.DSH_CLINE_HOME ?? join(homedir(), '.dsh-cline')) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('DSH_CLINE_HOME must not be empty')
  const selected = resolve(value)
  if (dirname(selected) === selected || dirname(canonical(selected)) === canonical(selected)) {
    throw new Error('DSH_CLINE_HOME must not be a filesystem root')
  }
  const original = resolve(homedir(), '.dsh')
  if (within(canonical(original), canonical(selected)) || within(original, selected)) {
    throw new Error('DSH Cline must not modify the original ~/.dsh')
  }
  return selected
}

export function assertWithinHome(home, path) {
  if (!within(canonical(home), canonical(path))) throw new Error('Path escapes DSH_CLINE_HOME: ' + path)
}

/** Reject redirected files: migration/install never follows a profile file symlink. */
export function assertRegularTarget(path) {
  if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('Refusing to modify a symlink: ' + path)
}

/** Sibling temp+rename avoids publishing truncated YAML on write failure. */
export function writeAtomic(path, content, expected) {
  assertRegularTarget(path)
  const temporary = join(dirname(path), '.' + randomUUID() + '.dsh-cline.tmp')
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600
  try {
    writeFileSync(temporary, content, { encoding: 'utf8', flag: 'wx', mode })
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined
    if (current !== expected) throw new Error('File changed during installation; retry: ' + path)
    renameSync(temporary, path)
  } finally {
    if (existsSync(temporary)) rmSync(temporary)
  }
}
function normalize(text) {
  return text.split(/\r?\n/).map(line => line.trimEnd()).filter(line => line.trim() !== '').join('\n')
}

/** Pure transform; an unrecognized file is returned exactly as received. */
export function stripRetiredSeed(text) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const lines = text.split(/\r?\n/)
  const remove = new Set()
  for (let at = 0; at < lines.length; at++) {
    if (!/^llm-(?:pi-ai|shengsuanyun-ai):\s*$/.test(lines[at])) continue
    let end = at + 1
    while (end < lines.length && !/^[^\s#]/.test(lines[end])) end++
    // Keep comments belonging to the next section rather than swallowing
    // them with the historical provider table.
    let contentEnd = end
    while (contentEnd > at + 1 && (lines[contentEnd - 1].trim() === '' || /^#/.test(lines[contentEnd - 1]))) contentEnd--
    const section = lines.slice(at, contentEnd).filter(line => line !== BEGIN && line !== END)
    section[0] = 'llm-pi-ai:'
    if (normalize(section.join('\n')) !== normalize(SEED_SECTION)) continue
    for (let index = at; index < contentEnd; index++) remove.add(index)
    for (let index = contentEnd; index < end; index++) {
      if (lines[index] === END) remove.add(index)
      else if (lines[index].trim() !== '') break
    }
    let before = at - 1
    while (before >= 0 && lines[before].trim() === '') before--
    if (lines[before] === BEGIN) for (let index = before; index < at; index++) remove.add(index)
    at = end - 1
  }
  if (remove.size === 0) return text
  return lines.filter((_, index) => !remove.has(index)).join(newline)
}

/** Never seeds providers/defaults. No exact legacy match means no filesystem write. */
export function ensureShengsuanyunDefaults(value) {
  const home = isolatedHome(value)
  const path = join(home, 'settings.yaml')
  assertWithinHome(home, path)
  if (!existsSync(path)) return 'clean'
  assertRegularTarget(path)
  const text = readFileSync(path, 'utf8')
  const result = stripRetiredSeed(text)
  if (result === text) return 'clean'
  if (result.trim() === '') {
    if (readFileSync(path, 'utf8') !== text) throw new Error('Settings changed during migration; retry')
    rmSync(path)
    return 'removed'
  }
  writeAtomic(path, result, text)
  return 'healed'
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Only the dedicated override controls a CLI run; DSH_HOME and positional paths do not.
  const home = isolatedHome()
  console.log('legacy settings cleanup:', ensureShengsuanyunDefaults(home))
}
