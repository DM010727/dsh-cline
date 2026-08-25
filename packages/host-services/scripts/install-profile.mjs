/**
 * Install the built plugin into the DSH CLINE home's web profile:
 *  1. copy lib/ + package.json + README.md to <home>/profiles/node_modules/@dsh-cline/host-services
 *  2. merge an insert row into <home>/profiles/web/cordis.patch.yml (idempotent)
 *  3. heal <home>/settings.yaml off the retired v0.9.0-and-earlier seeded llm-pi-ai block
 * <home> defaults to ~/.dsh-cline (the DSH Cline isolated home; the user's
 * own ~/.dsh is never touched). Set DSH_CLINE_HOME to override.
 * Run after `pnpm --filter @dsh-cline/host-services build`.
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ensureShengsuanyunDefaults } from './shengsuanyun-defaults.mjs'

const pkgRoot = fileURLToPath(new URL('..', import.meta.url))
const dshHome = process.env.DSH_CLINE_HOME
  ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh-cline')
const target = join(dshHome, 'profiles', 'node_modules', '@dsh-cline', 'host-services')
const patchPath = join(dshHome, 'profiles', 'web', 'cordis.patch.yml')

const BEGIN = '# === dsh-cline host-services (managed block, do not edit) ==='
const END = '# === end dsh-cline host-services ==='
const BLOCK = [
  BEGIN,
  '- insert:',
  '    - id: dsh-cline-host-services',
  "      name: '@dsh-cline/host-services'",
  '      # bridge half activates only when the DSH Cline extension exports the env',
  '      config:',
  '        bridgeUrl: !!js process.env.DSH_CLINE_BRIDGE ?? null',
  END,
].join('\n')

if (existsSync(join(pkgRoot, 'lib', 'client.js')) === false) {
  console.error('lib/client.js missing; run pnpm --filter @dsh-cline/host-services build first (builds both halves)')
  process.exit(1)
}

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
for (const item of ['lib', 'package.json', 'README.md']) {
  if (!existsSync(join(pkgRoot, item))) continue
  cpSync(join(pkgRoot, item), join(target, item), { recursive: true })
}
console.log('copied ->', target)

if (!existsSync(patchPath)) {
  // The isolated home may never have booted dsh yet: create the empty user
  // layer dsh expects (`[]`), same as the extension's installer.
  mkdirSync(join(dshHome, 'profiles', 'web'), { recursive: true })
  writeFileSync(patchPath, '[]\n')
  console.log('created empty profile patch ->', patchPath)
}
const original = readFileSync(patchPath, 'utf8')
if (original.includes(BEGIN)) {
  console.log('patch already has managed block; skipped')
} else {
  // Empty root `[]` cannot be followed by more items; drop it before appending.
  const stripped = original.replace(/(^|\n)\s*\[\]\s*(?=\n|$)/, '\n').replace(/\s+$/, '')
  writeFileSync(patchPath, stripped + '\n\n' + BLOCK + '\n')
  console.log('patch updated ->', patchPath)
}
console.log('done. spawn dsh web with DSH_CLINE_BRIDGE=<url> to activate')

const seed = ensureShengsuanyunDefaults(join(dshHome))
console.log(seed === 'clean'
  ? 'settings.yaml carries no dsh-cline seed; nothing to do'
  : seed === 'removed'
    ? 'removed the seeded ' + join(dshHome, 'settings.yaml') + ' (the DSH settings service owns it)'
    : 'removed the seeded llm-pi-ai block from ' + join(dshHome, 'settings.yaml'))
