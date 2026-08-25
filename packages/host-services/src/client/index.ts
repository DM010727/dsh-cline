/**
 * @dsh-cline/host-services browser half. Ships inside the DSH web client as a
 * static dual-face plugin (package.json `dsh.client`): registers the
 * Shengsuanyun onboarding step (shadowing the official DeepSeek step under the
 * same slot id at a lower priority), the「模型」section (shadowing DSH's native
 * one the same way - Shengsuanyun is the default provider and the single
 * place keys/models are configured), the「DSH Cline」fusion-feature section,
 * and the sidebar brand re-label. All data moves either through the DSH wire
 * APIs (settings/credentials/llm) or the plugin's own same-origin gateway
 * routes (model catalog, VS Code configuration, MCP declarations, restart,
 * external links).
 *
 * @module @dsh-cline/host-services/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
import { SsyOnboarding } from './onboarding.tsx'
import { DshClineSection } from './section.tsx'
import { DshClineModelsSection } from './models-section.tsx'
import { CLIENT_CSS } from './styles.ts'
import { installClipboard } from './clipboard.ts'

/** Required services (cordis fiber inject, same contract as ui-settings-models). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'theme']

/** localStorage flag: the first-run dark-theme default has been applied. */
const THEME_DEFAULTED_KEY = 'dsh-cline.theme-defaulted'

/** Nav labels the native「模型」section may render as (zh + en). */
const MODELS_NAV_LABELS = new Set(['模型', 'Models'])

/**
 * Mount every DSH Cline browser surface.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  // Clipboard bridge + right-click menu for the DSH inputs (webview iframe
  // swallows native Cmd/Ctrl+C/V and the native context menu; see clipboard.ts).
  installClipboard()

  // One style tag for all hand-prefixed classes plus the brand re-label.
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = '@dsh-cline/host-services'
    tag.textContent = CLIENT_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-cline: stylesheet')

  // First-run default: dark theme. DSH ships preference `system`, so a light
  // OS gets a light GUI on first boot; DSH Cline's product default is dark.
  // Applied once (flag in localStorage) and only while the preference is the
  // untouched `system` - a deliberate user choice is never overridden. The
  // write itself is the theme service's normal setTheme, persisted through the
  // settings scope (settings.theme.preference) like the Appearance row does.
  ctx.effect(() => {
    try {
      if (localStorage.getItem(THEME_DEFAULTED_KEY) === null) {
        if (ctx.theme.getTheme().preference === 'system') ctx.theme.setTheme('dark')
        localStorage.setItem(THEME_DEFAULTED_KEY, '1')
      }
    } catch (err: unknown) {
      // Storage or theme write failed: leave the flag unset so the next GUI
      // load retries, and never block the rest of the surfaces over a default.
      ctx.logger.warn('dsh-cline client: dark-theme default skipped: ' + String(err))
    }
    return undefined
  }, 'dsh-cline: first-run dark theme')

  // Nav dedupe: the settings shell renders its nav from the RAW slot ledger,
  // so our priority -1 models shadow cannot remove the native「模型」row (the
  // slot API exposes no disposer for another registrant's entry). What it CAN
  // do is hide the duplicate in the DOM: ledger order sorts our registration
  // (priority -1) before the native one, so the FIRST models-labeled nav
  // button is ours - keep it, hide the rest. Either row would render our
  // content anyway (the winner projection picks the lowest priority entry for
  // the id), so this is purely cosmetic and can never break navigation.
  ctx.effect(() => {
    const dedupeNav = (): void => {
      const buttons = document.querySelectorAll('[role="dialog"] nav button')
      let seen = false
      for (const button of buttons) {
        if (!MODELS_NAV_LABELS.has((button.textContent ?? '').trim())) continue
        const duplicate = seen
        seen = true
        const el = button as HTMLElement
        const display = duplicate ? 'none' : ''
        if (el.style.display !== display) el.style.display = display
      }
    }
    const observer = new MutationObserver(dedupeNav)
    observer.observe(document.body, { childList: true, subtree: true })
    dedupeNav()
    return () => { observer.disconnect() }
  }, 'dsh-cline: settings nav dedupe')

  const connection = ctx.get('connection') as ConnectionHandle | undefined
  if (connection === undefined) {
    ctx.logger.warn('dsh-cline client: connection service unavailable; surfaces dormant')
    return
  }
  const api = connection.api

  // Shadow the official deepseek-official onboarding step (same slot id,
  // priority -1: the lower priority registration is the cell winner).
  ctx.slots.inject('settings.onboarding', () => ctx.slots.register({
    name: 'settings.onboarding',
    id: 'deepseek-official',
    order: 0,
    priority: -1,
    inject: () => ({ api }),
  }, SsyOnboarding))

  // Take over the native Models section: DSH Cline makes Shengsuanyun the
  // default provider, and API keys/models are configured ONLY here. A plain
  // priority -1 shadow (lowest priority wins the cell) makes OUR registration
  // the rendered「模型」content. The settings shell's nav reads the RAW ledger
  // (winner projection is never used), so the native「模型」row is unavoidably
  // present too — removing it would need the native registration's disposer,
  // which the slot API does not expose. What we must NOT do is "keep our entry
  // at the head" by deregistering/re-registering on every ledger change: that
  // self-touching loop spins unbounded and crashed the renderer (v0.9.2). One
  // registration, shadowed by priority, is the whole fix.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'models',
    order: 10,
    priority: -1,
    label: () => '模型',
    inject: () => ({ api }),
  }, DshClineModelsSection))

  // The DSH Cline settings section in the settings panel nav.
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-cline',
    order: 20,
    label: () => 'DSH Cline',
    inject: () => ({ api }),
  }, DshClineSection))
}
