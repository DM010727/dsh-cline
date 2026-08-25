/**
 * Shengsuanyun defaults: v0.9.1 reversed policy - settings.yaml is the DSH
 * settings service's own document and DSH Cline never seeds into it. A seeded
 * second `llm-pi-ai:` key turns the document into a DUPLICATE_KEY parse
 * failure, which takes the settings provider down at boot and leaves every
 * namespace (llm-pi-ai included) unregistered. The routes are written through
 * the settings wire API on demand (onboarding / the「模型」page).
 *
 * This module now only HEALS: it strips the v0.9.0-and-earlier managed block
 * (markers, the renamed `llm-shengsuanyun-ai:` key, or the first of duplicate
 * `llm-pi-ai` keys) when one is still present.
 *
 * Usable as a CLI (prints what it did) or as a module (see exports).
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Marked block boundaries of the retired seed. */
const BEGIN = '# === dsh-cline shengsuanyun defaults (managed block, do not edit) ==='
const END = '# === end dsh-cline shengsuanyun defaults ==='

/** The seed section as it was written (markers excluded), for exact-match removal. */
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

/** The same route table as data, for programmatic consumers. */
export const SSY_ROUTES_DATA = [
  { route: 'shengsuanyun', displayName: '胜算云', api: 'openai-completions' },
  { route: 'shengsuanyun-responses', displayName: '胜算云 (Responses)', api: 'openai-responses' },
  { route: 'shengsuanyun-messages', displayName: '胜算云 (Messages)', api: 'anthropic-messages' },
]

export const SSY_BASE_URL = 'https://router.shengsuanyun.com/api/v1'
export const SSY_KEY_REF = 'SHENGSUANYUN_API_KEY'

/** One top-level key's subtree: the key line through the line before the next column-0 key. */
function subtree(lines, at) {
  let end = lines.length
  for (let i = at + 1; i < lines.length; i++) {
    if (/^[^\s#]/.test(lines[i])) { end = i; break }
  }
  return lines.slice(at, end)
}

/** Remove one top-level key's subtree (returns the input when the key is absent). */
function removeSubtree(lines, key) {
  const at = lines.findIndex(line => key.test(line))
  if (at < 0) return lines
  return [...lines.slice(0, at), ...lines.slice(at + subtree(lines, at).length)]
}

/** Blank-line-insensitive comparison form. */
function normalize(text) {
  return text.split('\n').map(line => line.trimEnd()).filter(line => line.trim() !== '').join('\n')
}

/**
 * Strip the retired seed from $DSH_HOME/settings.yaml. Idempotent: a clean
 * file (or none at all) is left untouched.
 * @param {string} dshHome - $DSH_HOME (defaults to ~/.dsh).
 * @returns {'clean' | 'healed' | 'removed'} what happened, for logging.
 */
export function ensureShengsuanyunDefaults(dshHome) {
  const settingsPath = join(dshHome, 'settings.yaml')
  if (!existsSync(settingsPath)) return 'clean'
  const text = readFileSync(settingsPath, 'utf8')
  let lines = text.split(/\r?\n/).filter(line => line !== BEGIN && line !== END)
  const seedKey = /^llm-shengsuanyun-ai:\s*$/
  const llmKey = /^llm-pi-ai:\s*$/
  const llmAt = lines.map((line, i) => (llmKey.test(line) ? i : -1)).filter(i => i >= 0)
  if (lines.some(line => seedKey.test(line))) {
    lines = removeSubtree(lines, seedKey)
  } else if (llmAt.length >= 2) {
    lines = removeSubtree(lines, llmKey)
  } else if (llmAt.length === 1) {
    if (normalize(subtree(lines, llmAt[0]).join('\n')) === normalize(SEED_SECTION)) {
      lines = removeSubtree(lines, llmKey)
    }
  }
  const result = lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '').replace(/\s+$/, '')
  if (result === text.replace(/\s+$/, '')) return 'clean'
  if (result === '') {
    rmSync(settingsPath, { force: true })
    return 'removed'
  }
  writeFileSync(settingsPath, result + '\n', 'utf8')
  return 'healed'
}

/* CLI entry: node scripts/shengsuanyun-defaults.mjs [dshClineHome] */
if (process.argv[1] !== undefined && process.argv[1].endsWith('shengsuanyun-defaults.mjs')) {
  const home = process.argv[2]
    ?? process.env.DSH_CLINE_HOME
    ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '.', '.dsh-cline')
  const outcome = ensureShengsuanyunDefaults(home)
  console.log(outcome === 'clean'
    ? 'settings.yaml carries no dsh-cline seed; nothing to do'
    : outcome === 'removed'
      ? 'removed the seeded ' + join(home, 'settings.yaml') + ' (the DSH settings service owns it)'
      : 'removed the seeded llm-pi-ai block from ' + join(home, 'settings.yaml'))
}
