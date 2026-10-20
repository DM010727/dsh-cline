/** Recommended Shengsuanyun integration; native DSH owns defaults and providers. */
import type { ClientApi, SettingsPathOpView } from './api.ts'
import { isShellMessage } from './shell-message.ts'

export const SSY_KEY_REF = 'SHENGSUANYUN_API_KEY'
export const SSY_BASE_URL = 'https://router.shengsuanyun.com/api/v1'
export const SSY_SIGNUP_URL = 'https://console.shengsuanyun.com/user/overview/?from=CH_L5K542DT'
export const SSY_ROUTES = {
  chat: 'shengsuanyun',
  responses: 'shengsuanyun-responses',
  messages: 'shengsuanyun-messages',
} as const
export type SsyRoute = typeof SSY_ROUTES[keyof typeof SSY_ROUTES]
export interface SsyModel {
  id: string
  name?: string
  company?: string
  context_window?: number
  max_tokens?: number
  support_apis?: string[]
  pricing?: {
    price?: number; input_price?: number; output_price?: number
    cached_price?: number; image_price?: number; currency?: string
  }
}

const NOT_FREE_IDS = new Set([
  'deepseek/deepseek-v3.1-think', 'bigmodel/glm-z1-air',
  'streamlake/kat-coder-air-v1', 'streamlake/kat-coder-exp-72b-1010',
])
/** Unknown prices never justify a zero-price claim; image cost counts too. */
export function isFreeModel(model: SsyModel): boolean {
  if (NOT_FREE_IDS.has(model.id)) return false
  const price = model.pricing
  if (price === undefined) return false
  return price.price === 0 && price.input_price === 0 && price.output_price === 0
    && (price.cached_price === undefined || price.cached_price === 0)
    && (price.image_price === undefined || price.image_price === 0)
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/** Missing protocol metadata keeps compatibility; explicit non-chat APIs do not. */
export function routesForModel(model: SsyModel): SsyRoute[] {
  if (model.support_apis === undefined || model.support_apis.length === 0) return [SSY_ROUTES.chat]
  const routes: SsyRoute[] = []
  for (const api of model.support_apis) {
    const path = api.replace(/^\/v1(?=\/)/, '').replace(/\/$/, '')
    const route = path === '/chat/completions' ? SSY_ROUTES.chat
      : path === '/responses' ? SSY_ROUTES.responses : path === '/messages' ? SSY_ROUTES.messages : undefined
    if (route !== undefined && !routes.includes(route)) routes.push(route)
  }
  // Stable preference, independent of the API catalog's order.
  return Object.values(SSY_ROUTES).filter(route => routes.includes(route))
}

/** Runtime validation: catalogs are external data, not a TypeScript guarantee. */
export function normalizeModels(value: unknown): SsyModel[] {
  if (!Array.isArray(value)) throw new Error('模型目录返回格式错误')
  const seen = new Set<string>()
  return value.flatMap(raw => {
    const row = record(raw)
    if (row === undefined || typeof row.id !== 'string' || row.id.trim() === '' || seen.has(row.id)) return []
    const model: SsyModel = { id: row.id }
    if (typeof row.name === 'string') model.name = row.name
    if (typeof row.company === 'string') model.company = row.company
    const context = positiveInteger(row.context_window)
    const tokens = positiveInteger(row.max_tokens)
    if (context !== undefined) model.context_window = context
    if (tokens !== undefined) model.max_tokens = tokens
    if (Array.isArray(row.support_apis)) model.support_apis = row.support_apis.filter((s): s is string => typeof s === 'string')
    const pricing = record(row.pricing)
    if (pricing !== undefined) {
      model.pricing = {}
      let invalidPricing = false
      for (const key of ['price', 'input_price', 'output_price', 'cached_price', 'image_price'] as const) {
        const value = pricing[key]
        const numeric = typeof value === 'number' ? value
          : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
        if (Number.isFinite(numeric) && numeric >= 0) model.pricing[key] = numeric
        else if (Object.hasOwn(pricing, key)) invalidPricing = true
      }
      if (typeof pricing.currency === 'string') model.pricing.currency = pricing.currency
      if (invalidPricing) model.pricing = undefined
    }
    if (routesForModel(model).length === 0) return []
    seen.add(model.id)
    return [model]
  })
}

export async function fetchSsyModels(signal?: AbortSignal): Promise<SsyModel[]> {
  const response = await fetch('dsh-cline/models', { signal })
  if (!response.ok) throw new Error('模型列表获取失败（HTTP ' + String(response.status) + '）')
  const body = record(await response.json())
  return normalizeModels(body?.data)
}

export async function openExternal(url: string): Promise<void> {
  // Callers use fixed product links. Keep fallback behavior restricted too.
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('不支持的链接协议')
  try {
    const response = await fetch('dsh-cline/open-external', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }),
    })
    if (response.ok) return
  } catch { /* gateway unavailable: system browser fallback */ }
  window.open(url, '_blank', 'noopener')
}

export async function ssyLogin(): Promise<void> {
  const response = await fetch('dsh-cline/ssy-login', { method: 'POST' })
  if (!response.ok) throw new Error('发起胜算云登录失败（HTTP ' + String(response.status) + '）')
}
export interface SsyAccount {
  ok: boolean
  reason?: 'no-key' | 'api'
  error?: string
  displayName?: string
  balance?: number
  usageDays?: number
  usageTotal?: number
  usage?: Array<{ at: string; model: string; credits: number; promptTokens: number; completionTokens: number }>
}
export async function fetchSsyAccount(signal?: AbortSignal): Promise<SsyAccount> {
  const response = await fetch('dsh-cline/ssy-account', { signal })
  if (!response.ok) throw new Error('获取胜算云账户信息失败（HTTP ' + String(response.status) + '）')
  const body = record(await response.json())
  if (body === undefined || body.ok !== true) return {
    ok: false, reason: body?.reason === 'no-key' ? 'no-key' : 'api',
    error: typeof body?.error === 'string' ? body.error : '账户响应格式错误',
  }
  const result: SsyAccount = { ok: true }
  if (typeof body.displayName === 'string') result.displayName = body.displayName
  for (const key of ['balance', 'usageDays', 'usageTotal'] as const) {
    if (typeof body[key] === 'number' && Number.isFinite(body[key])) result[key] = body[key]
  }
  if (Array.isArray(body.usage)) result.usage = body.usage.flatMap(raw => {
    const row = record(raw)
    if (row === undefined || typeof row.at !== 'string' || typeof row.model !== 'string'
      || typeof row.credits !== 'number' || !Number.isFinite(row.credits)) return []
    return [{
      at: row.at, model: row.model, credits: row.credits,
      promptTokens: positiveInteger(row.promptTokens) ?? 0, completionTokens: positiveInteger(row.completionTokens) ?? 0,
    }]
  })
  return result
}

export function listenSsyKey(onKey: (apiKey: string) => void): () => void {
  const listener = (event: MessageEvent): void => {
    if (!isShellMessage(event)) return
    const data = record(event.data)
    if (data?.channel === 'dsh-cline.ssy-key' && typeof data.apiKey === 'string'
      && data.apiKey.trim() !== '' && data.apiKey.length <= 16_384) onKey(data.apiKey)
  }
  window.addEventListener('message', listener)
  return () => { window.removeEventListener('message', listener) }
}
export async function readVscodeConfig(key: string): Promise<unknown> {
  const response = await fetch('dsh-cline/vscode-config?key=' + encodeURIComponent(key))
  if (!response.ok) throw new Error('读取 VS Code 配置失败（HTTP ' + String(response.status) + '）')
  return record(await response.json())?.value
}
export async function writeVscodeConfig(key: string, value: unknown): Promise<void> {
  const response = await fetch('dsh-cline/vscode-config', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, value }),
  })
  if (!response.ok) throw new Error('写入 VS Code 配置失败（HTTP ' + String(response.status) + '）')
}
export function pathOf(value: unknown, path: readonly string[]): unknown {
  let node = value
  for (const key of path) {
    const object = record(node)
    if (object === undefined || !Object.hasOwn(object, key)) return undefined
    node = object[key]
  }
  return node
}
export interface DefaultModel { provider: string; model: string }
function defaultModelOf(value: unknown): DefaultModel | undefined {
  const object = record(value)
  return typeof object?.provider === 'string' && typeof object.model === 'string'
    ? { provider: object.provider, model: object.model } : undefined
}
export interface SsySettings {
  providerConfigured: boolean
  writable: boolean
  keyConfigured: boolean
  keyWritable: boolean
  selectedIds: string[]
  configuredModels: SsyModel[]
  defaultModel?: DefaultModel
}
export async function readSsySettings(api: ClientApi): Promise<SsySettings> {
  const [settings, credentials] = await Promise.all([
    api.settings.describe(), api.credentials.describe([SSY_KEY_REF]),
  ])
  if (!settings.ok) throw new Error(settings.error.message)
  if (!credentials.ok) throw new Error(credentials.error.message)
  const llm = settings.value.namespaces.find(ns => ns.ns === 'llm-pi-ai')
  const selected = new Set<string>()
  const configuredModels = new Map<string, SsyModel>()
  for (const route of Object.values(SSY_ROUTES)) {
    const models = pathOf(llm?.value, ['providers', route, 'models'])
    if (Array.isArray(models)) for (const model of models) {
      const id = record(model)?.id
      if (typeof id === 'string') {
        selected.add(id)
        const existing = configuredModels.get(id)
        const api = route === SSY_ROUTES.chat ? '/v1/chat/completions'
          : route === SSY_ROUTES.responses ? '/v1/responses' : '/v1/messages'
        configuredModels.set(id, {
          id,
          support_apis: [...existing?.support_apis ?? [], api],
          context_window: positiveInteger(record(model)?.contextWindow),
          max_tokens: positiveInteger(record(model)?.maxTokens),
        })
      }
    }
  }
  return {
    providerConfigured: Object.values(SSY_ROUTES).some(route => record(pathOf(llm?.value, ['providers', route])) !== undefined),
    writable: settings.value.writable && llm !== undefined,
    keyConfigured: credentials.value[SSY_KEY_REF]?.configured === true,
    keyWritable: credentials.value[SSY_KEY_REF]?.writable === true,
    selectedIds: [...selected],
    configuredModels: [...configuredModels.values()],
    defaultModel: defaultModelOf(settings.value.namespaces.find(ns => ns.ns === 'agent-default-model')?.value),
  }
}

const PROTOCOLS: Record<SsyRoute, string> = {
  shengsuanyun: 'openai-completions',
  'shengsuanyun-responses': 'openai-responses',
  'shengsuanyun-messages': 'anthropic-messages',
}

/** Save explicit model choices. A recommendation never changes the global default. */
export async function saveSsyConfiguration(api: ClientApi, models: SsyModel[], apiKey?: string): Promise<string | undefined> {
  if (models.length === 0) return '请至少勾选一个模型，或点击全选'
  const settings = await api.settings.describe()
  if (!settings.ok) return settings.error.message
  if (!settings.value.writable) return '当前配置只读'
  const llm = settings.value.namespaces.find(ns => ns.ns === 'llm-pi-ai')
  if (llm === undefined) return '当前 DSH 未注册 llm-pi-ai，无法添加胜算云'
  const defaultModel = defaultModelOf(settings.value.namespaces.find(ns => ns.ns === 'agent-default-model')?.value)
  const grouped = new Map<SsyRoute, SsyModel[]>(Object.values(SSY_ROUTES).map(route => [route, []]))
  for (const model of models) {
    const supported = routesForModel(model)
    let route = supported[0]
    if (defaultModel?.model === model.id && supported.includes(defaultModel.provider as SsyRoute)) {
      route = defaultModel.provider as SsyRoute
    }
    if (route === undefined) return '模型不支持文本对话接口：' + model.id
    grouped.get(route)!.push(model)
  }
  if (defaultModel !== undefined && Object.values(SSY_ROUTES).includes(defaultModel.provider as SsyRoute)
    && !grouped.get(defaultModel.provider as SsyRoute)?.some(model => model.id === defaultModel.model)) {
    return '当前默认模型必须保留在勾选列表中；如需移除，请先在原生「模型」页更改默认模型'
  }
  const ops: SettingsPathOpView[] = []
  for (const [route, selected] of grouped) {
    const existing = record(pathOf(llm.value, ['providers', route]))
    if (existing === undefined && selected.length === 0) continue
    const previous = Array.isArray(existing?.models) ? existing.models : []
    ops.push({
      op: 'set', path: ['providers', route],
      value: {
        ...existing,
        displayName: route === SSY_ROUTES.chat ? '胜算云（推荐）' : route === SSY_ROUTES.responses ? '胜算云（Responses）' : '胜算云（Messages）',
        api: PROTOCOLS[route], baseURL: SSY_BASE_URL, apiKeyEnv: SSY_KEY_REF,
        headers: { ...record(existing?.headers), 'X-title': 'DSH-Cline' },
        models: selected.map(model => ({
          ...record(previous.find(raw => record(raw)?.id === model.id)),
          id: model.id,
          ...(model.context_window === undefined ? {} : { contextWindow: model.context_window }),
          ...(model.max_tokens === undefined ? {} : { maxTokens: model.max_tokens }),
        })),
      },
    })
  }
  const key = apiKey?.trim()
  const credentials = await api.credentials.describe([SSY_KEY_REF])
  if (!credentials.ok) return credentials.error.message
  if (key) {
    if (!credentials.value[SSY_KEY_REF]?.writable) return '当前凭据只读'
    const stored = await api.credentials.set(SSY_KEY_REF, key)
    if (!stored.ok) return stored.error.message
  } else if (!credentials.value[SSY_KEY_REF]?.configured) return '请先填入胜算云 API Key'
  try {
    const written = await api.settings.mutate('llm-pi-ai', ops, llm.revision)
    if (!written.ok) return (key ? 'API Key 已保存，模型配置未保存，请重试：' : '') + written.error.message
  } catch (error: unknown) {
    return (key ? 'API Key 已保存，模型配置未确认，请重试：' : '') + String(error)
  }
  return undefined
}

/** Native Models-card OAuth updates only this route's existing credential reference. */
export async function saveSsyLogin(api: ClientApi, route: string, apiKey: string): Promise<string | undefined> {
  if (!Object.values(SSY_ROUTES).includes(route as SsyRoute)) return '未知胜算云供应商'
  const key = apiKey.trim()
  if (!key || key.length > 16_384) return '登录未返回有效 API Key'
  const settings = await api.settings.describe()
  if (!settings.ok) return settings.error.message
  const llm = settings.value.namespaces.find(ns => ns.ns === 'llm-pi-ai')
  const profile = record(pathOf(llm?.value, ['providers', route]))
  if (!llm || !profile) return '供应商已移除，请在「模型」页重新添加'
  const existingRef = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv.trim() : ''
  const ref = existingRef || SSY_KEY_REF
  if (!existingRef && !settings.value.writable) return '当前供应商配置只读，无法关联登录凭据'
  const credentials = await api.credentials.describe([ref])
  if (!credentials.ok) return credentials.error.message
  if (!credentials.value[ref]?.writable) return '当前供应商凭据只读'
  const stored = await api.credentials.set(ref, key)
  if (!stored.ok) return stored.error.message
  if (!existingRef) {
    try {
      const linked = await api.settings.mutate('llm-pi-ai', [{ op: 'set', path: ['providers', route, 'apiKeyEnv'], value: ref }], llm.revision)
      if (!linked.ok) return '登录凭据已保存，关联供应商失败，请重试：' + linked.error.message
    } catch { return '登录凭据已保存，供应商关联未确认，请刷新后重试' }
  }
  return undefined
}

export interface McpServerEntry {
  transport?: string; command?: string; url?: string; disabled?: boolean
  [key: string]: unknown
}
export interface McpServerRow extends McpServerEntry { name: string }
export interface McpSnapshot { rows: McpServerRow[]; revision: string }
export async function fetchMcpServers(): Promise<McpSnapshot> {
  const response = await fetch('dsh-cline/mcp')
  if (!response.ok) throw new Error('MCP 配置读取失败（HTTP ' + String(response.status) + '）')
  const body = record(await response.json())
  const servers = record(body?.servers)
  if (servers === undefined || typeof body?.revision !== 'string') throw new Error('MCP 配置响应格式错误')
  return {
    rows: Object.entries(servers).map(([name, entry]) => ({ ...record(entry), name })),
    revision: body.revision,
  }
}
export async function writeMcpServers(servers: Record<string, McpServerEntry>, expectedRevision: string): Promise<void> {
  const response = await fetch('dsh-cline/mcp', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ servers, expectedRevision }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(response.status === 409 ? 'MCP 配置已被其他窗口修改，请刷新后重试'
      : 'MCP 配置保存失败（HTTP ' + String(response.status) + '）' + (detail === '' ? '' : '：' + detail))
  }
}
export async function restartDshService(): Promise<void> {
  const response = await fetch('dsh-cline/restart', { method: 'POST' })
  if (!response.ok) throw new Error('重启请求失败（HTTP ' + String(response.status) + '）— 请在 VS Code 使用「DSH Cline: 重启 DSH 服务」')
}
