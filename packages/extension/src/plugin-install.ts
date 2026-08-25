/**
 * Auto-install of the DSH-side host-services plugin into the DSH CLINE HOME
 * (`~/.dsh-cline`, overridable via $DSH_CLINE_HOME) at activation, plus the
 * one-time migration off the user's shared `~/.dsh` (v0.8.0 wrote the plugin,
 * the Shengsuanyun defaults, and the key there).
 *
 * Isolation rationale: the user's own DSH keeps its `~/.dsh` untouched (their
 * default provider, sessions, credentials); the DSH Cline service terminal
 * launches `dsh web` with DSH_HOME pointed at the cline home, which carries
 * the Shengsuanyun defaults and our plugin. Every step is idempotent and
 * independently checked, so activation re-heals whatever a dsh first-boot or
 * a partial install left behind — the vsix is the single distribution unit.
 *
 * @module dsh-cline/plugin-install
 */

import { cp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import * as os from 'node:os'

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

/** The shared Shengsuanyun credential reference. */
const SSY_KEY_REF = 'SHENGSUANYUN_API_KEY'

/** The DSH Cline isolated home: settings, credentials, profiles, sessions. */
export function dshClineHome(): string {
  return process.env.DSH_CLINE_HOME ?? join(os.homedir(), '.dsh-cline')
}

/** The user's own DSH home, which DSH Cline must never modify. */
function userDshHome(): string {
  return join(os.homedir(), '.dsh')
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return undefined
  }
}

/** Remove one BEGIN..END managed block (inclusive) plus surrounding blanks. */
function stripBlock(text: string, begin: string, end: string): string {
  const start = text.indexOf(begin)
  if (start < 0) return text
  const stop = text.indexOf(end, start)
  if (stop < 0) return text
  const head = text.slice(0, start)
  const tail = text.slice(stop + end.length)
  return (head.replace(/[ \t]*\n+$/, '') + tail.replace(/^\n+/, '')).replace(/^\s+$/, '')
}

/**
 * One-time migration: v0.8.0 wrote our plugin, defaults, and key into the
 * shared ~/.dsh. Move the key into the isolated home and remove everything
 * else we added, so the user's own DSH behaves exactly as before DSH Cline.
 * Each step is guarded: absent markers mean nothing to do.
 * @returns human-readable actions taken, for the output channel log.
 */
async function migrateOffSharedDshHome(newHome: string): Promise<string[]> {
  const actions: string[] = []
  const oldHome = userDshHome()
  if (oldHome === newHome) return actions

  // 1. Plugin files.
  const oldPlugin = join(oldHome, 'profiles', 'node_modules', '@dsh-cline')
  if (existsSync(oldPlugin)) {
    await rm(oldPlugin, { recursive: true, force: true })
    actions.push('migration: removed plugin from ' + oldPlugin)
  }

  // 2. Profile patch managed block; an emptied user layer returns to `[]`.
  const oldPatchPath = join(oldHome, 'profiles', 'web', 'cordis.patch.yml')
  const oldPatch = await readText(oldPatchPath)
  if (oldPatch !== undefined && oldPatch.includes(PATCH_BEGIN)) {
    const stripped = stripBlock(oldPatch, PATCH_BEGIN, PATCH_END)
    await writeFile(oldPatchPath, stripped.length === 0 ? '[]\n' : stripped + '\n', 'utf8')
    actions.push('migration: removed patch row from ' + oldPatchPath)
  }

  // 3. Settings managed block.
  const oldSettingsPath = join(oldHome, 'settings.yaml')
  const oldSettings = await readText(oldSettingsPath)
  if (oldSettings !== undefined && oldSettings.includes(SSY_BEGIN)) {
    const stripped = stripBlock(oldSettings, SSY_BEGIN, SSY_END)
    if (stripped.length === 0) await rm(oldSettingsPath, { force: true })
    else await writeFile(oldSettingsPath, stripped + '\n', 'utf8')
    actions.push('migration: removed shengsuanyun defaults from ' + oldSettingsPath)
  }

  // 4. Credential: move the key into the isolated home (with a backup).
  const oldCredsPath = join(oldHome, '.credentials.yaml')
  const oldCreds = await readText(oldCredsPath)
  if (oldCreds !== undefined) {
    const match = new RegExp(`^${SSY_KEY_REF}:\\s*(\\S.*)$`, 'm').exec(oldCreds)
    if (match !== null) {
      const value = match[1].trim().replace(/^["']|["']$/g, '')
      const withoutKey = oldCreds
        .replace(new RegExp(`^${SSY_KEY_REF}:.*\\n?`, 'm'), '')
        .replace(/^\s+$/, '')
      await rename(oldCredsPath, oldCredsPath + '.dsh-cline-bak')
      if (withoutKey.length > 0) await writeFile(oldCredsPath, withoutKey + '\n', 'utf8')
      const newCredsPath = join(newHome, '.credentials.yaml')
      const newCreds = await readText(newCredsPath)
      if (newCreds === undefined || !new RegExp(`^${SSY_KEY_REF}:`, 'm').test(newCreds)) {
        // The isolated home may not exist yet (migration runs before provisioning).
        await mkdir(newHome, { recursive: true })
        const body = (newCreds ?? '').replace(/\s*$/, '')
        await writeFile(newCredsPath, (body.length === 0 ? '' : body + '\n') + `${SSY_KEY_REF}: ${value}\n`, 'utf8')
      }
      actions.push('migration: moved ' + SSY_KEY_REF + ' into ' + newCredsPath + ' (old file backed up)')
    }
  }

  return actions
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
async function healSeededSettings(): Promise<string[]> {
  const actions: string[] = []
  const settingsPath = join(dshClineHome(), 'settings.yaml')
  const text = await readText(settingsPath)
  if (text === undefined) return actions
  // Marker comments first, wherever the settings service's re-emits moved them.
  let lines = text.split(/\r?\n/).filter(line => line !== SSY_BEGIN && line !== SSY_END)
  const seedKey = /^llm-shengsuanyun-ai:\s*$/
  const llmKey = /^llm-pi-ai:\s*$/
  const llmAt = lines.map((line, i) => (llmKey.test(line) ? i : -1)).filter(i => i >= 0)
  if (lines.some(line => seedKey.test(line))) {
    // The user hand-renamed the seed key: remove that subtree, keep any
    // settings-service-written llm-pi-ai.
    lines = removeTopLevelSubtree(lines, seedKey)
  } else if (llmAt.length >= 2) {
    // Duplicate keys (the parse-breaking state): the seed is the first.
    lines = removeTopLevelSubtree(lines, llmKey)
  } else if (llmAt.length === 1) {
    // A lone llm-pi-ai: ours only when it is still the exact seed text (the
    // service-written section carries models and must survive).
    const subtree = subtreeLines(lines, llmAt[0])
    if (normalizeLines(subtree) === normalizeLines(SEED_SECTION_LINES)) {
      lines = removeTopLevelSubtree(lines, llmKey)
    }
  }
  const result = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '')
  if (result === '') {
    await rm(settingsPath, { force: true })
    actions.push('migration: removed seeded ' + settingsPath + ' (the DSH settings service owns it now)')
  } else if (result !== text.replace(/\s+$/, '')) {
    await writeFile(settingsPath, result + '\n', 'utf8')
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
async function ensureWebProfileScaffold(cmd: string | undefined): Promise<string[]> {
  const home = dshClineHome()
  const webDir = join(home, 'profiles', 'web')
  const manifestPath = join(webDir, 'package.json')
  const inBoxPlugins = join(home, 'profiles', 'node_modules', '@deepseek-ai')
  if (cmd === undefined || (existsSync(manifestPath) && existsSync(inBoxPlugins))) return []
  try {
    const comspec = process.env.ComSpec ?? 'cmd.exe'
    const exe = /\s/.test(cmd) ? '"' + cmd + '"' : cmd
    // cmd.exe /c "dsh web --dump-config": the config dump composes the profile
    // (healing the module fallback + writing the manifest) without booting a
    // server or opening a window. A large tree needs a generous buffer.
    await execFile(comspec, ['/d', '/c', exe + ' web --dump-config'], {
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

/**
 * Install/heal the DSH-side plugin. Cheap when everything is current: a few
 * text reads and a version comparison.
 * @returns human-readable actions taken, for the output channel log.
 */
export async function ensurePluginInstalled(vendorDir: string, dshCommand?: string): Promise<string[]> {
  const actions = await migrateOffSharedDshHome(dshClineHome())
  const home = dshClineHome()
  const target = join(home, 'profiles', 'node_modules', '@dsh-cline', 'host-services')

  // 1. Plugin files: copy when absent or at a different version.
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
  if (vendoredVersion !== targetVersion) {
    await rm(target, { recursive: true, force: true })
    await mkdir(target, { recursive: true })
    for (const item of ['lib', 'package.json', 'README.md']) {
      if (!existsSync(join(vendorDir, item))) continue
      await cp(join(vendorDir, item), join(target, item), { recursive: true })
    }
    actions.push('host-services ' + String(vendoredVersion) + ' -> ' + target)
  }

  // 2. Profile patch row: create the file (dsh tolerates `[]` as an empty
  // user layer) and append the managed block when absent.
  const webProfileDir = join(home, 'profiles', 'web')
  const patchPath = join(webProfileDir, 'cordis.patch.yml')
  let patch = await readText(patchPath)
  if (patch === undefined) {
    await mkdir(webProfileDir, { recursive: true })
    patch = '[]\n'
  }
  if (!patch.includes(PATCH_BEGIN)) {
    // Empty root `[]` cannot be followed by more items; drop it before appending.
    const stripped = patch.replace(/(^|\n)\s*\[\]\s*(?=\n|$)/, '\n').replace(/\s+$/, '')
    await writeFile(patchPath, stripped + '\n\n' + PATCH_BLOCK + '\n', 'utf8')
    actions.push('patch row -> ' + patchPath)
  }

  // 3. settings.yaml is the DSH settings service's own document - never seed
  // into it (a second llm-pi-ai key breaks the document's parse and with it
  // every namespace registration). Only heal OFF the v0.9.0-and-earlier seed.
  actions.push(...await healSeededSettings())

  if (!existsSync(join(target, 'lib', 'client.js'))) {
    throw new Error('host-services install incomplete: lib/client.js missing after copy')
  }
  actions.push(...await ensureWebProfileScaffold(dshCommand))
  return actions
}
