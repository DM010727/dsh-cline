/**
 * Auto-install of the DSH-side host-services plugin into the DSH CLINE HOME
 * (`~/.dsh-cline`, overridable via $DSH_CLINE_HOME) at activation.
 * Never edits the user's independent ~/.dsh configuration or credentials.
 *
 * Isolation rationale: the user's own DSH keeps its `~/.dsh` untouched (their
 * default provider, sessions, credentials); the DSH Cline service terminal
 * launches `dsh web` with DSH_HOME pointed at the cline home, which carries
 * the native DeepSeek defaults and our plugin. Every step is idempotent and
 * independently checked, so activation re-heals whatever a dsh first-boot or
 * a partial install left behind — the vsix is the single distribution unit.
 *
 * @module dsh-cline/plugin-install
 */

import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import { acquireInstallLock } from '../../host-services/scripts/install-lock.mjs'

const execFile = promisify(execFileCb)

/** Profile patch managed-block boundaries (mirror scripts/install-profile.mjs). */
const PATCH_BEGIN = '# === dsh-cline host-services (managed block, do not edit) ==='
const PATCH_END = '# === end dsh-cline host-services ==='

const PATCH_BLOCK = [
  PATCH_BEGIN,
  '- insert:',
  '    - id: dsh-cline-host-services',
  "      name: '@dsh-cline/host-services'",
  '      # bridge half activates only when the DSH Cline extension exports the env',
  '      config:',
  '        bridgeUrl: !!js process.env.DSH_CLINE_BRIDGE ?? null',
  PATCH_END,
].join('\n')

/** Preserve manual registrations and reject malformed patches before publishing. */
export function mergeWebProfilePatch(original: string): string {
  if (original.includes(PATCH_BEGIN) !== original.includes(PATCH_END)) {
    throw new Error('Incomplete host-services managed profile block; repair it before installing')
  }
  const content = original.split(/\r?\n/).filter(line => line.trim() !== '' && !/^\s*#/.test(line) && !/^\s*---\s*$/.test(line))
  if (content.length > 0 && content[0].trim() !== '[]' && !/^\s*-/.test(content[0])) {
    throw new Error('Expected a YAML sequence profile patch; existing configuration was preserved')
  }
  const hasId = (id: string): boolean => new RegExp('^\\s*(?:-\\s*)?id:\\s*([\\\'"]?)' + id + '\\1\\s*(?:#.*)?$', 'm').test(original)
  const additions: string[] = []
  if (!original.includes(PATCH_BEGIN) && !hasId('dsh-cline-host-services')) additions.push(PATCH_BLOCK)
  if (!hasId('session-log-deepseek')) additions.push('- id: session-log-deepseek\n  config:\n    enabled: false')
  if (additions.length === 0) return original
  const stripped = original.replace(/(^|\n)\s*\[\]\s*(?=\r?\n|$)/, '\n').replace(/\s+$/, '')
  return stripped + (stripped === '' ? '' : '\n\n') + additions.join('\n\n') + '\n'
}

/** Settings.yaml managed-block boundaries (mirror scripts/shengsuanyun-defaults.mjs). */
const SSY_BEGIN = '# === dsh-cline shengsuanyun defaults (managed block, do not edit) ==='
const SSY_END = '# === end dsh-cline shengsuanyun defaults ==='

const SSY_BLOCK = [
  SSY_BEGIN,
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
  SSY_END,
].join('\n')

/** The DSH Cline isolated home: settings, credentials, profiles, sessions. */
export function dshClineHome(): string {
  const configured = process.env.DSH_CLINE_HOME ?? join(os.homedir(), '.dsh-cline')
  if (configured.trim() === '') throw new Error('DSH_CLINE_HOME must not be empty')
  const home = resolve(configured)
  if (home === parse(home).root || isWithin(resolve(os.homedir(), '.dsh'), home)) {
    throw new Error('DSH_CLINE_HOME must be isolated from the original ~/.dsh and filesystem root')
  }
  // Activation also uses this synchronous accessor before publishing bridge.json.
  // Reject aliases here, before any caller can write through the chosen home.
  const actual = canonicalPathSync(home)
  if (actual === parse(actual).root || isWithin(canonicalPathSync(join(os.homedir(), '.dsh')), actual)) {
    throw new Error('DSH_CLINE_HOME must be isolated from the original ~/.dsh')
  }
  return home
}

function isWithin(parent: string, path: string): boolean {
  const part = relative(parent, path)
  return part === '' || (part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part))
}

function canonicalPathSync(path: string): string {
  let current = resolve(path)
  const tail: string[] = []
  for (;;) {
    try { return join(realpathSync.native(current), ...tail) } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error('Refusing a dangling redirected path: ' + current)
      } catch (statError: unknown) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
      }
      const parent = dirname(current)
      if (parent === current) throw error
      tail.unshift(basename(current))
      current = parent
    }
  }
}

/** Resolve missing descendants through the nearest existing ancestor, including junctions. */
async function canonicalPath(path: string): Promise<string> {
  let current = resolve(path)
  const tail: string[] = []
  for (;;) {
    try { return join(await realpath(current), ...tail) } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // A dangling link is not a missing directory we may create through.
      try {
        if ((await lstat(current)).isSymbolicLink()) throw new Error('Refusing a dangling redirected path: ' + current)
      } catch (statError: unknown) {
        if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError
      }
      const parent = dirname(current)
      if (parent === current) throw error
      tail.unshift(basename(current))
      current = parent
    }
  }
}

async function checkedHome(): Promise<string> {
  const home = dshClineHome()
  const actual = await canonicalPath(home)
  const original = await canonicalPath(join(os.homedir(), '.dsh'))
  if (actual === parse(actual).root || isWithin(original, actual)) {
    throw new Error('DSH_CLINE_HOME must be an isolated configuration directory')
  }
  return home
}

/** Revalidate every mutation/cleanup target, including its existing ancestors. */
async function assertSafeTarget(home: string, path: string): Promise<void> {
  if (!isWithin(resolve(home), resolve(path)) || !isWithin(await canonicalPath(home), await canonicalPath(path))) {
    throw new Error('Installer path escapes DSH_CLINE_HOME: ' + path)
  }
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error('Refusing a redirected installer target: ' + path)
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function writeTextAtomic(home: string, path: string, text: string, expected: string | undefined): Promise<void> {
  await assertSafeTarget(home, path)
  const temporary = join(dirname(path), '.' + randomUUID() + '.dsh-cline.tmp')
  await assertSafeTarget(home, temporary)
  try {
    await writeFile(temporary, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
    if (await readText(path) !== expected) throw new Error('Installer file changed concurrently; retry: ' + path)
    await assertSafeTarget(home, path)
    await rename(temporary, path)
  } finally {
    await assertSafeTarget(home, temporary)
    await rm(temporary, { force: true })
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * One-time heal of the isolated home's settings.yaml, off the v0.9.0-and-
 * earlier practice of seeding a managed `llm-pi-ai` block into it. DSH's
 * settings service owns that file exclusively (comment-preserving leaf-level
 * diffs), and a seeded second `llm-pi-ai` key turns the document into a
 * DUPLICATE_KEY parse failure - the settings provider then dies at boot and
 * every namespace (llm-pi-ai included) stays unregistered, surfacing as
 * "settings namespace llm-pi-ai is not registered" on the first configure.
 * The Shengsuanyun routes are written through the settings API on demand
 * (onboarding / the「模型」page), so nothing needs seeding anymore.
 *
 * Removed: the managed-block marker comments; the seed's own subtree - the
 * renamed `llm-shengsuanyun-ai:` key when the user already hand-renamed it,
 * else the FIRST of duplicate `llm-pi-ai` keys (the no-models seed; the
 * settings service's own section stays), else a lone `llm-pi-ai` subtree that
 * is byte-identical to the seed. An emptied file is deleted.
 * @returns human-readable actions taken, for the output channel log.
 */
async function healSeededSettings(home: string): Promise<string[]> {
  const actions: string[] = []
  const settingsPath = join(home, 'settings.yaml')
  await assertSafeTarget(home, settingsPath)
  const text = await readText(settingsPath)
  if (text === undefined) return actions
  // Marker comments first, wherever the settings service's re-emits moved them.
  let lines = text.split(/\r?\n/).filter(line => line !== SSY_BEGIN && line !== SSY_END)
  const seedKey = /^llm-shengsuanyun-ai:\s*$/
  const llmKey = /^llm-pi-ai:\s*$/
  const llmAt = lines.map((line, i) => (llmKey.test(line) ? i : -1)).filter(i => i >= 0)
  let removedSeed = false
  const renamedAt = lines.findIndex(line => seedKey.test(line))
  if (renamedAt >= 0 && normalizeLines(subtreeLines(lines, renamedAt).map((line, i) => i === 0 ? 'llm-pi-ai:' : line)) === normalizeLines(SEED_SECTION_LINES)) {
    // The user hand-renamed the seed key: remove that subtree, keep any
    // settings-service-written llm-pi-ai.
    lines = removeTopLevelSubtree(lines, seedKey)
    removedSeed = true
  } else if (llmAt.length >= 2) {
    // Duplicate keys (the parse-breaking state): the seed is the first.
    const seedAt = llmAt.find(at => normalizeLines(subtreeLines(lines, at)) === normalizeLines(SEED_SECTION_LINES))
    if (seedAt !== undefined) {
      const subtree = subtreeLines(lines, seedAt)
      lines.splice(seedAt, subtree.length)
      removedSeed = true
    } else return ['migration: duplicate llm-pi-ai sections preserved; no exact legacy seed identified']
  } else if (llmAt.length === 1) {
    // A lone llm-pi-ai: ours only when it is still the exact seed text (the
    // service-written section carries models and must survive).
    const subtree = subtreeLines(lines, llmAt[0])
    if (normalizeLines(subtree) === normalizeLines(SEED_SECTION_LINES)) {
      lines = removeTopLevelSubtree(lines, llmKey)
      removedSeed = true
    }
  }
  if (!removedSeed) return actions
  const result = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '')
  if (result === '') {
    await assertSafeTarget(home, settingsPath)
    if (await readText(settingsPath) !== text) throw new Error('Settings changed during migration; retry')
    await rm(settingsPath, { force: true })
    actions.push('migration: removed seeded ' + settingsPath + ' (the DSH settings service owns it now)')
  } else if (result !== text.replace(/\s+$/, '')) {
    await writeTextAtomic(home, settingsPath, result + '\n', text)
    actions.push('migration: removed the seeded llm-pi-ai block from ' + settingsPath)
  }
  return actions
}

/** The seed section text (SSY_BLOCK without the marker comments), as lines. */
const SEED_SECTION_LINES = SSY_BLOCK.split('\n').slice(1, -1)

/** One top-level key's subtree: the key line through the line before the next column-0 key. */
function subtreeLines(lines: readonly string[], at: number): string[] {
  let end = lines.length
  for (let i = at + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) { end = i; break }
  }
  return lines.slice(at, end)
}

/** Remove one top-level key's subtree (no-op when the key is absent). */
function removeTopLevelSubtree(lines: readonly string[], key: RegExp): string[] {
  const at = lines.findIndex(line => key.test(line))
  if (at < 0) return [...lines]
  const subtree = subtreeLines(lines, at)
  return [...lines.slice(0, at), ...lines.slice(at + subtree.length)]
}

/** Blank-line-insensitive comparison form of a subtree. */
function normalizeLines(lines: readonly string[]): string {
  return lines.map(line => line.trimEnd()).filter(line => line.trim() !== '').join('\n')
}

/**
 * Ensure the isolated home's web profile carries the dsh launcher scaffold the
 * first `dsh web` boot would normally create (prepareProfile: the profile
 * manifest with the base+web-app bundle list, the empty root `cordis.yml`, and
 * the flat `profiles/node_modules` symlink fallback). The extension provisions
 * the home BEFORE that boot, and a half-scaffolded profile mounts no bundles —
 * so the base bundle's llm-pi-ai (and agent-default-model, llm-deepseek, ...)
 * never activate and the settings service rejects any `llm-pi-ai` write with
 * "settings namespace is not registered". Triggering dsh's own `--dump-config`
 * (headless, prints the composed tree and exits) runs the identical scaffold
 * using the installation's own machinery; idempotent, skipped once present.
 * @param cmd - the resolved `dsh` executable (from the runtime detection).
 * @returns human-readable actions taken, for the output channel log.
 */
async function ensureWebProfileScaffold(home: string, cmd: string | undefined): Promise<string[]> {
  const webDir = join(home, 'profiles', 'web')
  const manifestPath = join(webDir, 'package.json')
  if (cmd === undefined || existsSync(manifestPath)) return []
  try {
    for (const path of [webDir, manifestPath, join(home, 'cordis.yml'), join(home, 'profiles', 'node_modules'), join(webDir, 'node_modules')]) {
      await assertSafeTarget(home, path)
    }
    const exe = cmd
    if (/["%!\r\n\0]/.test(cmd)) throw new Error('invalid dsh executable')
    // cmd.exe /c "dsh web --dump-config": the config dump composes the profile
    // (healing the module fallback + writing the manifest) without booting a
    // server or opening a window. A large tree needs a generous buffer.
    const executable = process.platform === 'win32' ? (process.env.ComSpec ?? 'cmd.exe') : cmd
    const args = process.platform === 'win32'
      ? ['/d', '/s', '/c', '""' + cmd + '" web --dump-config"']
      : ['web', '--dump-config']
    await execFile(executable, args, {
      env: { ...process.env, DSH_HOME: home },
      windowsHide: true,
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return ['web profile scaffolded via `' + exe + ' web --dump-config`']
  } catch (err: unknown) {
    // Non-fatal: `dsh web` re-runs prepareProfile at its own boot and heals the
    // same scaffold; a scaffold failure here must never block the sidecar.
    return ['web profile scaffold skipped (' + String(err) + '); dsh web will heal it at boot']
  }
}

/** Compare managed payloads so same-version VSIX replacements actually install. */
async function samePluginContents(home: string, vendorDir: string, target: string): Promise<boolean> {
  const stat = async (path: string) => {
    try { return await lstat(path) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  }
  const same = async (source: string, destination: string): Promise<boolean> => {
    await assertSafeTarget(home, destination)
    const [left, right] = await Promise.all([stat(source), stat(destination)])
    if (!left || !right) return left === undefined && right === undefined
    if (left.isSymbolicLink() || right.isSymbolicLink()) return false
    if (left.isDirectory() && right.isDirectory()) {
      const [a, b] = await Promise.all([readdir(source), readdir(destination)])
      a.sort(); b.sort()
      if (a.length !== b.length || a.some((name, index) => name !== b[index])) return false
      for (const name of a) if (!await same(join(source, name), join(destination, name))) return false
      return true
    }
    if (!left.isFile() || !right.isFile() || left.size !== right.size) return false
    const [a, b] = await Promise.all([readFile(source), readFile(destination)])
    return a.equals(b)
  }
  for (const item of ['lib', 'package.json', 'README.md', 'scripts/install-lock.mjs']) {
    if (!await same(join(vendorDir, item), join(target, item))) return false
  }
  return true
}

/**
 * Install/heal the DSH-side plugin. Compare the small managed payload as well
 * as its version, so a user-requested same-version repack is not skipped.
 * @returns human-readable actions taken, for the output channel log.
 */
export async function ensurePluginInstalled(vendorDir: string, dshCommand?: string): Promise<string[]> {
  const home = await checkedHome()
  await mkdir(home, { recursive: true })
  const lockPath = join(home, '.host-services-install.lock')
  await assertSafeTarget(home, lockPath)
  const lock = await acquireInstallLock(lockPath)
  try { return await installPlugin(home, vendorDir, dshCommand) } finally {
    lock.release()
  }
}

async function installPlugin(home: string, vendorDir: string, dshCommand?: string): Promise<string[]> {
  const actions: string[] = []
  const target = join(home, 'profiles', 'node_modules', '@dsh-cline', 'host-services')
  const webProfileDir = join(home, 'profiles', 'web')
  const patchPath = join(webProfileDir, 'cordis.patch.yml')
  // Preflight all file targets before publishing any plugin/config changes.
  for (const path of [target, patchPath, join(home, 'settings.yaml'), join(webProfileDir, 'package.json')]) {
    await assertSafeTarget(home, path)
  }
  for (const entry of ['lib/index.js', 'lib/client.js']) {
    if (!existsSync(join(vendorDir, entry))) throw new Error('vendored host-services missing ' + entry)
  }
  const originalPatch = await readText(patchPath)
  const mergedPatch = mergeWebProfilePatch(originalPatch ?? '[]\n')

  // 1. Plugin files: copy when absent, at a different version, or changed in-place.
  const [vendoredPkg, targetPkg] = await Promise.all([
    readText(join(vendorDir, 'package.json')),
    readText(join(target, 'package.json')),
  ])
  if (vendoredPkg === undefined) {
    throw new Error('vendored host-services missing from the extension (dist/vendor/host-services)')
  }
  const vendoredVersion = (JSON.parse(vendoredPkg) as { version?: string }).version
  const targetVersion = targetPkg === undefined
    ? undefined
    : (JSON.parse(targetPkg) as { version?: string }).version
  if (vendoredVersion !== targetVersion || !await samePluginContents(home, vendorDir, target)) {
    const token = randomUUID()
    const staging = target + '.staging-' + token
    const backup = target + '.previous-' + token
    for (const path of [dirname(target), staging, backup]) await assertSafeTarget(home, path)
    await mkdir(dirname(target), { recursive: true })
    await mkdir(staging)
    let previousMoved = false
    try {
      for (const item of ['lib', 'package.json', 'README.md']) {
        if (!existsSync(join(vendorDir, item))) continue
        await assertSafeTarget(home, join(staging, item))
        await cp(join(vendorDir, item), join(staging, item), { recursive: true })
      }
      const lockSource = join(vendorDir, 'scripts', 'install-lock.mjs')
      if (existsSync(lockSource)) {
        await mkdir(join(staging, 'scripts'), { recursive: true })
        await cp(lockSource, join(staging, 'scripts', 'install-lock.mjs'))
      }
      for (const entry of ['lib/index.js', 'lib/client.js', 'package.json']) {
        await assertSafeTarget(home, join(staging, entry))
        if (!existsSync(join(staging, entry))) throw new Error('incomplete plugin staging: ' + entry)
      }
      await assertSafeTarget(home, target)
      await assertSafeTarget(home, backup)
      if (existsSync(target)) { await rename(target, backup); previousMoved = true }
      try {
        await assertSafeTarget(home, staging)
        await assertSafeTarget(home, target)
        await rename(staging, target)
      } catch (error) {
        if (previousMoved && !existsSync(target)) {
          await assertSafeTarget(home, backup)
          await assertSafeTarget(home, target)
          await rename(backup, target)
        }
        throw error
      }
      await assertSafeTarget(home, backup)
      await rm(backup, { recursive: true, force: true })
    } finally {
      await assertSafeTarget(home, staging)
      await rm(staging, { recursive: true, force: true })
    }
    actions.push('host-services ' + String(vendoredVersion) + ' -> ' + target)
  }

  // 2. Profile patch row: create the file (dsh tolerates `[]` as an empty
  // user layer) and append the managed block when absent.
  if (mergedPatch !== originalPatch) {
    await assertSafeTarget(home, webProfileDir)
    await mkdir(webProfileDir, { recursive: true })
    await writeTextAtomic(home, patchPath, mergedPatch, originalPatch)
    actions.push('patch row -> ' + patchPath)
  }

  // 3. settings.yaml is the DSH settings service's own document - never seed
  // into it (a second llm-pi-ai key breaks the document's parse and with it
  // every namespace registration). Only heal OFF the v0.9.0-and-earlier seed.
  actions.push(...await healSeededSettings(home))

  if (!existsSync(join(target, 'lib', 'client.js'))) {
    throw new Error('host-services install incomplete: lib/client.js missing after copy')
  }
  actions.push(...await ensureWebProfileScaffold(home, dshCommand))
  return actions
}
