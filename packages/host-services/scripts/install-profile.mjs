/**
 * Install the built plugin into the isolated DSH Cline web profile.
 * Source validation and a sibling staging/backup swap keep failed copies from
 * deleting a working plugin. No operation reads DSH_HOME or the original ~/.dsh.
 */
import {
  cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { acquireInstallLockSync } from './install-lock.mjs'
import {
  assertRegularTarget, assertWithinHome, ensureShengsuanyunDefaults, isolatedHome, writeAtomic,
} from './shengsuanyun-defaults.mjs'

const PKG_NAME = '@dsh-cline/host-services'
const BEGIN = '# === dsh-cline host-services (managed block, do not edit) ==='
const END = '# === end dsh-cline host-services ==='
const BLOCK = [
  BEGIN,
  '- insert:',
  '    - id: dsh-cline-host-services',
  "      name: '@dsh-cline/host-services'",
  '      config:',
  '        bridgeUrl: !!js process.env.DSH_CLINE_BRIDGE ?? null',
  END,
].join('\n')
const PRIVATE_SESSION_LOG = [
  '# DSH Cline: session uploads require an explicit user opt-in.',
  '- id: session-log-deepseek',
  '  config:',
  '    enabled: false',
].join('\n')

function hasId(text, id) {
  return new RegExp('^\\s*(?:-\\s*)?id:\\s*([\\\'\"]?)' + id + '\\1\\s*(?:#.*)?$', 'm').test(text)
}

/** Preserve explicit user configuration, including an opt-in to session logging. */
export function mergeProfilePatch(original) {
  const begin = original.includes(BEGIN)
  const end = original.includes(END)
  if (begin !== end) throw new Error('Incomplete host-services managed profile block; repair it before installing')
  const content = original.split(/\r?\n/).filter(line => line.trim() !== '' && !/^\s*#/.test(line) && !/^\s*---\s*$/.test(line))
  if (content.length > 0 && content[0].trim() !== '[]' && !/^\s*-/.test(content[0])) {
    throw new Error('Expected a YAML sequence profile patch; existing configuration was preserved')
  }
  const additions = []
  if (!begin && !hasId(original, 'dsh-cline-host-services')) additions.push(BLOCK)
  if (!hasId(original, 'session-log-deepseek')) additions.push(PRIVATE_SESSION_LOG)
  if (additions.length === 0) return original
  const stripped = original.replace(/(^|\n)\s*\[\]\s*(?=\r?\n|$)/, '\n').replace(/\s+$/, '')
  return stripped + (stripped === '' ? '' : '\n\n') + additions.join('\n\n') + '\n'
}

/** Testable entry; callers may pass a fixture home, never the independent DSH tree. */
export function installProfile(options = {}) {
  const home = isolatedHome(options.dshHome)
  mkdirSync(home, { recursive: true })
  const lockPath = join(home, '.host-services-install.lock')
  assertWithinHome(home, lockPath)
  assertRegularTarget(lockPath)
  const lock = acquireInstallLockSync(lockPath)
  try { return installProfileLocked({ ...options, dshHome: home }) }
  finally { lock.release() }
}

function installProfileLocked({
  pkgRoot = fileURLToPath(new URL('..', import.meta.url)),
  dshHome = isolatedHome(),
} = {}) {
  const home = isolatedHome(dshHome)
  const source = resolve(pkgRoot)
  for (const entry of ['lib/index.js', 'lib/client.js', 'package.json']) {
    if (!existsSync(join(source, entry))) throw new Error(entry + ' missing; run the host-services build first')
  }
  if (JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).name !== PKG_NAME) {
    throw new Error('Unexpected host-services package identity')
  }
  const target = join(home, 'profiles', 'node_modules', '@dsh-cline', 'host-services')
  const patchPath = join(home, 'profiles', 'web', 'cordis.patch.yml')
  for (const path of [target, patchPath]) { assertWithinHome(home, path); assertRegularTarget(path) }
  const originalPatch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : undefined
  const patch = mergeProfilePatch(originalPatch ?? '[]\n')
  const token = randomUUID()
  const staging = target + '.staging-' + token
  const backup = target + '.previous-' + token
  const actions = []
  const removeDirectory = path => {
    // Every recursive operation revalidates its resolved path under this home.
    assertWithinHome(home, path)
    if (path !== staging && path !== backup) throw new Error('Unexpected installer cleanup path')
    rmSync(path, { recursive: true, force: true })
  }
  assertWithinHome(home, staging)
  assertWithinHome(home, backup)
  mkdirSync(dirname(target), { recursive: true })
  mkdirSync(staging)
  let previousMoved = false
  let published = false
  try {
    for (const item of ['lib', 'package.json', 'README.md']) {
      if (existsSync(join(source, item))) cpSync(join(source, item), join(staging, item), { recursive: true })
    }
    if (existsSync(join(source, 'scripts', 'install-lock.mjs'))) {
      mkdirSync(join(staging, 'scripts'), { recursive: true })
      cpSync(join(source, 'scripts', 'install-lock.mjs'), join(staging, 'scripts', 'install-lock.mjs'))
    }
    for (const entry of ['lib/index.js', 'lib/client.js', 'package.json']) {
      if (!existsSync(join(staging, entry))) throw new Error('Incomplete host-services staging: ' + entry)
    }
    if (existsSync(target)) { renameSync(target, backup); previousMoved = true }
    try {
      renameSync(staging, target)
      published = true
    } catch (error) {
      if (previousMoved && !existsSync(target)) renameSync(backup, target)
      throw error
    }
  } finally {
    if (existsSync(staging)) removeDirectory(staging)
  }
  actions.push('copied host-services -> ' + target)
  if (published && previousMoved) {
    try { removeDirectory(backup) } catch { actions.push('previous plugin copy retained -> ' + backup) }
  }
  if (patch !== originalPatch) {
    assertWithinHome(home, patchPath)
    mkdirSync(dirname(patchPath), { recursive: true })
    writeAtomic(patchPath, patch, originalPatch)
    actions.push('updated web profile -> ' + patchPath)
  }
  actions.push('legacy settings cleanup: ' + ensureShengsuanyunDefaults(home))
  return actions
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { for (const action of installProfile()) console.log(action) }
  catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1 }
}
