/** DSH keeps its official DeepSeek onboarding and complete native Models page. */
import type { ClientContext } from './api.ts'
import { DshClineSection } from './section.tsx'
import { SsyModelsFooter } from './ssy-provider-setup.tsx'
import { SsyProviderCard } from './ssy-provider-card.tsx'
import { CLIENT_CSS } from './styles.ts'
import { installClipboard } from './clipboard.ts'
import { pathOf } from './shared.ts'
import { installWorkspaceBinding } from './workspace-binding.ts'

export const inject = ['slots', 'locale', 'theme', 'remote', 'remote.settings', 'remote.credentials', 'uiWorkspace', 'commandUi', 'workspaces', 'sessions', 'layout']
const THEME_DEFAULTED_KEY = 'dsh-cline.theme-defaulted'
const LOCALE_DEFAULTED_KEY = 'dsh-cline.locale-defaulted'

export function apply(ctx: ClientContext): void {
  ctx.effect(installClipboard, 'dsh-cline: clipboard bridge')
  ctx.effect(() => installWorkspaceBinding(ctx), 'dsh-cline: project and session navigation')
  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = '@dsh-cline/host-services'
    tag.textContent = CLIENT_CSS
    document.head.appendChild(tag)
    return () => { tag.remove() }
  }, 'dsh-cline: stylesheet')

  const api = ctx.remote
  ctx.effect(() => {
    let disposed = false
    void api.settings.describe().then(described => {
      if (disposed || !described.ok) return
      try {
        const namespaces = described.value.namespaces
        if (localStorage.getItem(THEME_DEFAULTED_KEY) === null) {
          // An explicit system preference is still a deliberate choice.
          const theme = namespaces.find(ns => ns.ns === 'ui-theme')
          if (theme !== undefined && pathOf(theme.user, ['preference']) === undefined
            && ctx.theme.getTheme().preference === 'system') ctx.theme.setTheme('dark')
          localStorage.setItem(THEME_DEFAULTED_KEY, '1')
        }
        if (localStorage.getItem(LOCALE_DEFAULTED_KEY) === null) {
          const locale = namespaces.find(ns => ns.ns === 'locale')
          if (pathOf(locale?.value, ['preference']) === undefined
            && ctx.locale.getLocale().active !== 'zh') ctx.locale.setLocale('zh')
          localStorage.setItem(LOCALE_DEFAULTED_KEY, '1')
        }
      } catch (error: unknown) {
        ctx.logger.warn('dsh-cline: initial appearance preferences skipped: ' + String(error))
      }
    }).catch(() => { /* connection not ready: leave one-time flags unset */ })
    return () => { disposed = true }
  }, 'dsh-cline: first-run appearance')

  // Extend the native Models page; never add a second provider settings page.
  ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
    name: 'settings.models.provider-card', key: 'llm-pi-ai',
    inject: () => ({ api }),
  }, SsyProviderCard))
  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer', id: 'dsh-cline-shengsuanyun', order: 25,
    inject: () => ({ api }),
  }, SsyModelsFooter))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'dsh-cline',
    order: 20,
    label: () => 'DSH Cline',
    inject: () => ({ api }),
  }, DshClineSection))
}
