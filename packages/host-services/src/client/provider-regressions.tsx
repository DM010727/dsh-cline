/** Bounded native-provider UI and credential fixtures; no services, real keys or user state. */
import * as React from 'react'
import type { ClientApi, ClientContext, Result, SettingsDescribe, SettingsPathOpView } from './api.ts'
import { apply } from './index.ts'
import { SsyProviderCard } from './ssy-provider-card.tsx'
import { SsyModelsFooter } from './ssy-provider-setup.tsx'
import { readSsySettings, saveSsyLogin } from './shared.ts'

interface Element { type: unknown; props: Record<string, unknown> }
const ok = <T,>(value: T): Result<T> => ({ ok: true, value })
const denied: Result<never> = { ok: false, error: { code: 'fixture/refused', message: 'fixture refused' } }
function textOf(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (Array.isArray(value)) return value.map(textOf).join('')
  return value && typeof value === 'object' ? textOf((value as Element).props?.children) : ''
}
function nodes(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!value || typeof value !== 'object' || !('props' in value)) return []
  const item = value as Element
  return [item, ...nodes(item.props.children)]
}
export async function runProviderRegressions(): Promise<number> {
  let passed = 0
  const check = (test: unknown, label: string): void => { if (!test) throw new Error('Provider regression: ' + label); passed++ }
  const settings: SettingsDescribe = { writable: true, namespaces: [
    { ns: 'llm-pi-ai', revision: 7, value: { providers: { shengsuanyun: { apiKeyEnv: 'EXISTING_REF', baseURL: 'https://fixture.invalid', models: [{ id: 'keep' }], headers: { custom: 'keep' } }, 'shengsuanyun-responses': {} } } },
    { ns: 'agent-default-model', revision: 3, value: { provider: 'deepseek-official', model: 'keep-default' } },
  ] }
  const writes: Array<{ kind: string; ref?: string; ns?: string; ops?: SettingsPathOpView[]; revision?: number }> = []
  const invalidations = new Set<() => void>()
  let writable = true, failLink = false
  const api: ClientApi = {
    $on: (_event, fn) => { invalidations.add(fn); return () => invalidations.delete(fn) },
    settings: { describe: async () => ok(settings), mutate: async (ns, ops, revision) => { writes.push({ kind: 'settings', ns, ops, revision }); return failLink ? denied : ok({}) } },
    credentials: { describe: async refs => ok(Object.fromEntries(refs.map(ref => [ref, { configured: true, writable }]))), set: async ref => { writes.push({ kind: 'key', ref }); return ok({}) } },
  }
  const registered: Array<Record<string, unknown>> = []
  apply({ effect: () => () => {}, remote: api, slots: { inject: (_name: string, fn: () => void) => { fn() }, register: (entry: Record<string, unknown>) => { registered.push(entry); return () => {} } } } as unknown as ClientContext)
  check(!registered.some(e => e.id === 'dsh-cline-recommended-provider' || (e.label as (() => string) | undefined)?.() === '推荐供应商'), 'removed standalone provider navigation')
  check(registered.some(e => e.name === 'settings.models.provider-card' && e.key === 'llm-pi-ai'), 'OAuth uses actual native keyed adapter slot')
  check(registered.some(e => e.name === 'settings.models.footer'), 'first-time add stays on native Models page')
  check(!registered.some(e => e.name === 'settings.section' && e.id === 'models'), 'native Models page is never replaced')
  const original = JSON.stringify(settings)
  check(await saveSsyLogin(api, 'shengsuanyun', 'fixture-key') === undefined, 'configured route can update OAuth credential')
  check(writes.length === 1 && writes[0].ref === 'EXISTING_REF', 'existing reference is preserved without route rewrites')
  check(JSON.stringify(settings) === original, 'models, headers, endpoint and default remain untouched')
  writes.length = 0; writable = false
  check(await saveSsyLogin(api, 'shengsuanyun', 'fixture-key') !== undefined && writes.length === 0, 'read-only credentials refuse before side effects')
  writable = true
  check(await saveSsyLogin(api, 'unrelated', 'fixture-key') !== undefined && writes.length === 0, 'unrelated providers cannot receive this login')
  check(await saveSsyLogin(api, 'shengsuanyun', '') !== undefined && writes.length === 0, 'empty callbacks cannot overwrite credential')
  check(await saveSsyLogin(api, 'shengsuanyun-responses', 'fixture-key') === undefined, 'keyless saved route can link shared credential')
  check(writes[0].kind === 'key' && writes[1].revision === 7 && JSON.stringify(writes[1].ops?.[0].path) === '["providers","shengsuanyun-responses","apiKeyEnv"]', 'only missing reference is linked using CAS after key storage')
  check(writes.every(w => w.ns !== 'agent-default-model'), 'login never changes default model')
  failLink = true; writes.length = 0
  check((await saveSsyLogin(api, 'shengsuanyun-responses', 'fixture-key'))?.includes('凭据已保存') && writes.length === 2, 'partial credential success is reported honestly')
  failLink = false; writes.length = 0
  check((await readSsySettings(api)).providerConfigured, 'existing provider detected even with empty models')

  const globals = globalThis as unknown as Record<string, unknown>
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'), priorFetch = globalThis.fetch
  const internal = (React as unknown as { __SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED: { ReactCurrentDispatcher: { current: unknown } } }).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const priorDispatcher = internal.ReactCurrentDispatcher.current
  const seats = new Map<string, unknown[]>(), cleanups = new Set<() => void>()
  let values: unknown[] = [], cursor = 0, effects: Array<() => void> = [], logins = 0, loginFailure = false
  function state<T>(initial: T | (() => T)): [T, (next: T | ((prior: T) => T)) => void] {
    const list = values, at = cursor++
    if (!(at in list)) list[at] = typeof initial === 'function' ? (initial as () => T)() : initial
    return [list[at] as T, next => { list[at] = typeof next === 'function' ? (next as (v: T) => T)(list[at] as T) : next }]
  }
  internal.ReactCurrentDispatcher.current = {
    useState: state, useRef: <T,>(initial: T) => state({ current: initial })[0], useMemo: <T,>(fn: () => T) => { cursor++; return fn() },
    useCallback: <T,>(fn: T) => { cursor++; return fn },
    useEffect: (fn: () => (() => void) | void, deps: unknown[]) => {
      const list = values, at = cursor++, prior = list[at] as { deps: unknown[]; stop?: () => void } | undefined
      if (!prior || deps.some((v, i) => v !== prior.deps[i])) effects.push(() => { prior?.stop?.(); const stop = fn() || undefined; list[at] = { deps, stop }; if (stop) cleanups.add(stop) })
    },
  }
  function render(value: unknown, path: string): unknown {
    if (Array.isArray(value)) return value.map((v, i) => render(v, path + '.' + i))
    if (!value || typeof value !== 'object' || !('props' in value)) return value
    const item = value as Element
    if (typeof item.type === 'function') {
      const previous = values, position = cursor; values = seats.get(path) ?? []; seats.set(path, values); cursor = 0
      const out = (item.type as (props: Record<string, unknown>) => unknown)(item.props)
      values = previous; cursor = position; return render(out, path + '.body')
    }
    return { ...item, props: { ...item.props, children: render(item.props.children, path + '.children') } }
  }
  function view(value: React.ReactElement, path: string): unknown { const out = render(value, path); const queue = effects; effects = []; queue.forEach(fn => fn()); return out }
  const settle = async (): Promise<void> => { for (let i = 0; i < 16; i++) await Promise.resolve() }
  const button = (tree: unknown, label: string): Element => { const out = nodes(tree).find(n => n.type === 'button' && textOf(n) === label); if (!out) throw new Error('Missing button ' + label); return out }
  const click = (item: Element): void => { (item.props.onClick as () => void)() }
  const parent = { postMessage() {} }, win = Object.assign(new EventTarget(), { parent })
  const message = (source: unknown = parent): void => { win.dispatchEvent(Object.assign(new Event('message'), { source, origin: 'https://carrier.example', data: { channel: 'dsh-cline.ssy-key', apiKey: 'fixture-key' } })) }
  const card = (id = 'shengsuanyun', key = true) => React.createElement(SsyProviderCard, { api, configured: true, keyConfigured: key, provider: { provider: id, settingsNs: 'llm-pi-ai' } })
  try {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: win })
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { referrer: 'https://carrier.example/frame' } })
    globalThis.fetch = async input => { check(String(input) === 'dsh-cline/ssy-login', 'only explicit login request is sent'); logins++; return new Response('{}', { status: loginFailure ? 503 : 200 }) }
    check(view(card('unrelated'), 'other') === null, 'unrelated native card contains no Shengsuanyun UI')
    let tree = view(card(), 'card')
    check(textOf(tree).includes('重新登录胜算云'), 'existing provider keeps discoverable native-card re-login')
    message(); await settle(); check(writes.length === 0, 'unsolicited callback cannot update idle card')
    click(button(tree, '重新登录胜算云')); await settle(); tree = view(card(), 'card')
    check(logins === 1 && textOf(tree).includes('等待浏览器登录'), 'native-card button starts login and reports pending state')
    let second = view(card('shengsuanyun-responses', false), 'second'); click(button(second, '登录胜算云')); await settle(); second = view(card('shengsuanyun-responses', false), 'second')
    check(logins === 1 && textOf(second).includes('已有胜算云登录'), 'different cards cannot claim the same pending login')
    message({}); await settle(); check(writes.length === 0, 'forged frame cannot deliver a key')
    message(); await settle(); tree = view(card(), 'card')
    check(writes.length === 1 && writes[0].ref === 'EXISTING_REF', 'trusted callback saves only initiating card reference')
    check(textOf(tree).includes('模型列表和默认模型保持原配置'), 'actual save success is shown locally')
    writes.length = 0; click(button(tree, '重新登录胜算云')); await settle(); tree = view(card(), 'card'); click(button(tree, '取消等待')); message(); await settle()
    check(writes.length === 0, 'cancelled login no longer consumes callback')
    loginFailure = true; tree = view(card(), 'card'); click(button(tree, '重新登录胜算云')); await settle(); tree = view(card(), 'card')
    check(textOf(tree).includes('无法打开胜算云登录') && !textOf(tree).includes('等待浏览器登录'), 'launch failure releases pending owner and shows usable error')
    let footer = view(React.createElement(SsyModelsFooter, { api }), 'footer'); await settle(); footer = view(React.createElement(SsyModelsFooter, { api }), 'footer')
    check(footer === null, 'configured provider has no duplicate setup form in Models footer')
    settings.namespaces[0].value = { providers: {} }; invalidations.forEach(fn => fn()); await settle()
    footer = view(React.createElement(SsyModelsFooter, { api }), 'footer')
    check(textOf(footer).includes('添加胜算云') && nodes(footer).some(n => n.type === 'details'), 'unconfigured state offers collapsed first-time add on native page')
    check(!(await readSsySettings(api)).providerConfigured, 'removing native routes restores add affordance without deleting keys')
  } finally {
    cleanups.forEach(stop => stop()); internal.ReactCurrentDispatcher.current = priorDispatcher; globalThis.fetch = priorFetch
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else delete globals.window
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument); else delete globals.document
  }
  return passed
}
