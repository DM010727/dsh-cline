/**
 * Shengsuanyun integration constants and gateway helpers shared by the
 * onboarding step and the DSH Cline settings section.
 *
 * The three DSH wire protocols map onto one base URL (prefix-style joining:
 * DSH appends /chat/completions, /responses, or /messages itself):
 * https://router.shengsuanyun.com/api/v1/... - verified against the live API.
 */

import type { IApiClient, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'

/** Credential reference shared by all three routes. */
export const SSY_KEY_REF = 'SHENGSUANYUN_API_KEY'

/** The one base URL every route uses (DSH appends the protocol suffix). */
export const SSY_BASE_URL = 'https://router.shengsuanyun.com/api/v1'

/** Where the "获取 API Key" button sends the user (referral link, console overview). */
export const SSY_SIGNUP_URL = 'https://console.shengsuanyun.com/user/overview/?from=CH_L5K542DT'

/** Route ids under llm-pi-ai.providers, one per wire protocol. */
export const SSY_ROUTES = {
  chat: 'shengsuanyun',
  responses: 'shengsuanyun-responses',
  messages: 'shengsuanyun-messages',
} as const

/** Profile shape DSH expects per route (llm-pi-ai PiAiProviderProfile subset). */
export interface SsyRouteProfile {
  displayName: string
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'
  baseURL: string
  apiKeyEnv: string
  models: Array<{ id: string; contextWindow?: number; maxTokens?: number }>
}

/** The three route profiles written into llm-pi-ai.providers. */
export function ssyRouteProfiles(): Record<string, SsyRouteProfile> {
  return {
    [SSY_ROUTES.chat]: {
      displayName: '胜算云',
      api: 'openai-completions',
      baseURL: SSY_BASE_URL,
      apiKeyEnv: SSY_KEY_REF,
      models: [],
    },
    [SSY_ROUTES.responses]: {
      displayName: '胜算云 (Responses)',
      api: 'openai-responses',
      baseURL: SSY_BASE_URL,
      apiKeyEnv: SSY_KEY_REF,
      models: [],
    },
    [SSY_ROUTES.messages]: {
      displayName: '胜算云 (Messages)',
      api: 'anthropic-messages',
      baseURL: SSY_BASE_URL,
      apiKeyEnv: SSY_KEY_REF,
      models: [],
    },
  }
}

/** One Shengsuanyun catalog row (subset the UI consumes). */
export interface SsyModel {
  id: string
  name?: string
  company?: string
  description?: string
  context_window?: number
  max_tokens?: number
  support_apis?: string[]
  pricing?: { input_price?: number; output_price?: number; currency?: string }
}

/**
 * Pick the route whose protocol this model supports, chat-completions first
 * (the most widely exercised path).
 */
export function routeForModel(model: SsyModel | undefined): string {
  const apis = model?.support_apis ?? []
  if (apis.includes('/v1/chat/completions')) return SSY_ROUTES.chat
  if (apis.includes('/v1/responses')) return SSY_ROUTES.responses
  if (apis.includes('/v1/messages')) return SSY_ROUTES.messages
  return SSY_ROUTES.chat
}

/** Fetch the catalog through the plugin's same-origin gateway. */
export async function fetchSsyModels(): Promise<SsyModel[]> {
  const response = await fetch('/dsh-cline/models')
  if (!response.ok) throw new Error('模型列表获取失败（HTTP ' + String(response.status) + '）')
  const body = await response.json() as { data?: SsyModel[] }
  return Array.isArray(body.data) ? body.data : []
}

/** Open a URL in the system browser, falling back to window.open offline. */
export async function openExternal(url: string): Promise<void> {
  try {
    const response = await fetch('/dsh-cline/open-external', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    })
    if (response.ok) return
  } catch { /* no gateway or no carrier - fall through */ }
  window.open(url, '_blank', 'noopener')
}

/**
 * Start the Shengsuanyun OAuth login (ported from cline-Chinese): the
 * extension host opens router.shengsuanyun.com/auth in the system browser with
 * a vscode:// callback. When the flow completes, the exchanged API key arrives
 * as a `dsh-cline.ssy-key` message relayed through the shell - see
 * {@link listenSsyKey}.
 */
export async function ssyLogin(): Promise<void> {
  const response = await fetch('/dsh-cline/ssy-login', { method: 'POST' })
  if (!response.ok) throw new Error('发起胜算云登录失败（HTTP ' + String(response.status) + '）')
}

/**
 * Listen for an API key the extension exchanged after a Shengsuanyun OAuth
 * login (delivered through the shell's bridge relay). Returns a disposer.
 */
export function listenSsyKey(onKey: (apiKey: string) => void): () => void {
  const listener = (ev: MessageEvent): void => {
    const d = ev.data as { channel?: unknown; apiKey?: unknown } | null
    if (d !== null && typeof d === 'object' && d.channel === 'dsh-cline.ssy-key' && typeof d.apiKey === 'string') {
      onKey(d.apiKey)
    }
  }
  window.addEventListener('message', listener)
  return () => { window.removeEventListener('message', listener) }
}

/** Read one dsh-cline.* setting through the gateway (VS Code configuration). */
export async function readVscodeConfig(key: string): Promise<unknown> {
  const response = await fetch('/dsh-cline/vscode-config?key=' + encodeURIComponent(key))
  if (!response.ok) throw new Error('读取 VS Code 配置失败（HTTP ' + String(response.status) + '）')
  const body = await response.json() as { value?: unknown }
  return body.value
}

/** Write one dsh-cline.* setting through the gateway. */
export async function writeVscodeConfig(key: string, value: unknown): Promise<void> {
  const response = await fetch('/dsh-cline/vscode-config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, value }),
  })
  if (!response.ok) {
    throw new Error('写入 VS Code 配置失败（HTTP ' + String(response.status) + '）')
  }
}

/** Read one path out of a settings namespace value (plain-object walk). */
export function pathOf(value: unknown, path: readonly string[]): unknown {
  let node = value
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** The default-model selection the composer falls back to. */
export interface DefaultModel {
  provider: string
  model: string
}

/** Read the agent-default-model namespace (undefined when unset/absent). */
export async function readDefaultModel(api: IApiClient): Promise<DefaultModel | undefined> {
  const described = await api.settings.describe({})
  if (!described.result.ok) throw new Error(described.result.error.message)
  const ns = described.result.value.namespaces.find(n => n.ns === 'agent-default-model')
  const value = ns?.value
  if (typeof value !== 'object' || value === null) return undefined
  const provider = (value as { provider?: unknown }).provider
  const model = (value as { model?: unknown }).model
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined
  return { provider, model }
}

/**
 * Switch the default model to a Shengsuanyun route/model without touching the
 * key: writes the model into every route profile and points
 * agent-default-model at the chosen route.
 * @returns an error message, or undefined on success.
 */
export async function saveSsyModel(api: IApiClient, model: SsyModel): Promise<string | undefined> {
  const described = await api.settings.describe({})
  if (!described.result.ok) return described.result.error.message
  const llmNs = described.result.value.namespaces.find(ns => ns.ns === 'llm-pi-ai')
  const defaultNs = described.result.value.namespaces.find(ns => ns.ns === 'agent-default-model')
  const revision = llmNs?.revision
  const ops: SettingsPathOpView[] = []
  for (const [route, profile] of Object.entries(ssyRouteProfiles())) {
    const existing = pathOf(llmNs?.value, ['providers', route])
    const base = typeof existing === 'object' && existing !== null ? existing as Record<string, unknown> : {}
    ops.push({
      op: 'set',
      path: ['providers', route],
      value: { ...base, ...profile, models: [{ id: model.id, contextWindow: model.context_window, maxTokens: model.max_tokens }] },
    })
  }
  const mutate = await api.settings.mutate({ ns: 'llm-pi-ai', ops, ...(revision === undefined ? {} : { expectedRevision: revision }) })
  if (!mutate.result.ok) return mutate.result.error.message
  const defaultOps: SettingsPathOpView[] = [{
    op: 'set',
    path: [],
    value: {
      ...(typeof defaultNs?.value === 'object' && defaultNs?.value !== null ? defaultNs.value as Record<string, unknown> : {}),
      provider: routeForModel(model),
      model: model.id,
    },
  }]
  const defaultMutate = await api.settings.mutate({ ns: 'agent-default-model', ops: defaultOps })
  if (!defaultMutate.result.ok) return defaultMutate.result.error.message
  return undefined
}

/**
 * Persist the Shengsuanyun setup: key into the credential store, the selected
 * model into every route profile (creating routes the installer did not
 * seed), and the default-model selection onto the chosen route.
 * @returns an error message, or undefined on success.
 */
export async function saveSsySetup(
  api: IApiClient,
  apiKey: string,
  model: SsyModel,
): Promise<string | undefined> {
  const described = await api.settings.describe({})
  if (!described.result.ok) return described.result.error.message
  const llmNs = described.result.value.namespaces.find(ns => ns.ns === 'llm-pi-ai')
  const defaultNs = described.result.value.namespaces.find(ns => ns.ns === 'agent-default-model')
  const revision = llmNs?.revision

  const ops: SettingsPathOpView[] = []
  for (const [route, profile] of Object.entries(ssyRouteProfiles())) {
    const existing = pathOf(llmNs?.value, ['providers', route])
    const base = typeof existing === 'object' && existing !== null ? existing as Record<string, unknown> : {}
    ops.push({
      op: 'set',
      path: ['providers', route],
      value: { ...base, ...profile, models: [{ id: model.id, contextWindow: model.context_window, maxTokens: model.max_tokens }] },
    })
  }
  const mutate = await api.settings.mutate({ ns: 'llm-pi-ai', ops, ...(revision === undefined ? {} : { expectedRevision: revision }) })
  if (!mutate.result.ok) return mutate.result.error.message

  const defaultOps: SettingsPathOpView[] = [{
    op: 'set',
    path: [],
    value: {
      ...(typeof defaultNs?.value === 'object' && defaultNs?.value !== null ? defaultNs.value as Record<string, unknown> : {}),
      provider: routeForModel(model),
      model: model.id,
    },
  }]
  const defaultMutate = await api.settings.mutate({ ns: 'agent-default-model', ops: defaultOps })
  if (!defaultMutate.result.ok) return defaultMutate.result.error.message

  const stored = await api.credentials.set({ ref: SSY_KEY_REF, value: apiKey })
  if (!stored.result.ok) return stored.result.error.message
  return undefined
}

/**
 * Whether any provider can already serve requests (ends onboarding) and
 * whether the Shengsuanyun key specifically is stored. Mirrors the official
 * Models-page join: a route is usable when active and its resolved profile's
 * credential reference (if any) is configured.
 */
export async function probeProviders(api: IApiClient): Promise<{ anyUsable: boolean; ssyKeyed: boolean }> {
  const [providersResponse, settingsResponse] = await Promise.all([
    api.llm.providers({}),
    api.settings.describe({}),
  ])
  if (!providersResponse.result.ok) throw new Error(providersResponse.result.error.message)
  if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message)
  const namespaces = new Map(settingsResponse.result.value.namespaces.map(ns => [ns.ns, ns]))
  const refs = new Set<string>([SSY_KEY_REF])
  const usable = (provider: string, ns: string, path: readonly string[]): boolean | 'unknown' => {
    const profile = pathOf(namespaces.get(ns)?.value, path)
    const ref = typeof profile === 'object' && profile !== null
      ? (profile as { apiKeyEnv?: unknown }).apiKeyEnv
      : undefined
    const keyRef = typeof ref === 'string' && ref.length > 0 ? ref : undefined
    if (keyRef !== undefined) refs.add(keyRef)
    return keyRef === undefined
  }
  let anyUsable = false
  for (const entry of providersResponse.result.value.providers) {
    if (!entry.active) continue
    const noKeyNeeded = usable(entry.provider, entry.settingsNs, entry.settingsPath)
    if (noKeyNeeded === true) { anyUsable = true; break }
  }
  const credentialsResponse = await api.credentials.describe({ refs: [...refs] })
  if (!credentialsResponse.result.ok) throw new Error(credentialsResponse.result.error.message)
  const credentials = credentialsResponse.result.value.credentials
  if (!anyUsable) {
    // Re-check with the credential facts: a route naming a stored key is usable.
    anyUsable = providersResponse.result.value.providers.some(entry => {
      if (!entry.active) return false
      const profile = pathOf(namespaces.get(entry.settingsNs)?.value, entry.settingsPath)
      const ref = typeof profile === 'object' && profile !== null
        ? (profile as { apiKeyEnv?: unknown }).apiKeyEnv
        : undefined
      const keyRef = typeof ref === 'string' && ref.length > 0 ? ref : undefined
      return keyRef === undefined || credentials[keyRef]?.configured === true
    })
  }
  return { anyUsable, ssyKeyed: credentials[SSY_KEY_REF]?.configured === true }
}

/** One non-default provider row on the「模型」page. */
export interface ProviderRowView {
  provider: string
  displayName: string
  settingsNs: string
  settingsPath: readonly string[]
  /** A settings profile exists (the route resolves). */
  configured: boolean
  /** The user layer alone carries the profile; removal restores the base. */
  removable: boolean
  /** Credential reference the resolved profile names (conventional derivation otherwise). */
  keyRef: string
  keyConfigured: boolean | undefined
  /** Catalog model ids this route ships (empty for hand-declared / unknown routes). */
  catalogModels: string[]
  /** The adapter reports this route as hand-declared (absent from its catalog). */
  declared: boolean
}

/**
 * Declare a custom pi-ai provider route (DSH's "custom provider" flow): name,
 * display name, wire protocol, endpoint; the key stores under the conventional
 * derived reference.
 * @returns an error message, or undefined on success.
 */
export async function declareCustomProvider(
  api: IApiClient,
  route: string,
  displayName: string,
  apiKind: string,
  baseURL: string,
  key: string,
): Promise<string | undefined> {
  const keyRef = deriveKeyRef(route)
  const described = await api.settings.describe({})
  if (!described.result.ok) return described.result.error.message
  const ns = described.result.value.namespaces.find(n => n.ns === 'llm-pi-ai')
  const existing = pathOf(ns?.value, ['providers', route])
  if (existing !== undefined) return '供应商 ' + route + ' 已存在'
  const revision = ns?.revision
  const mutate = await api.settings.mutate({
    ns: 'llm-pi-ai',
    ops: [{
      op: 'set',
      path: ['providers', route],
      value: { displayName, api: apiKind, baseURL, apiKeyEnv: keyRef },
    }],
    ...(revision === undefined ? {} : { expectedRevision: revision }),
  })
  if (!mutate.result.ok) return mutate.result.error.message
  if (key.trim() !== '') {
    const stored = await api.credentials.set({ ref: keyRef, value: key.trim() })
    if (!stored.result.ok) return stored.result.error.message
  }
  return undefined
}

/**
 * Join the configurable-provider directory with settings and credential
 * states into the rows the「模型」page renders, minus the Shengsuanyun routes
 * (the default-provider hero card owns those). Only routes the user has
 * actually declared into llm-pi-ai.providers surface; every built-in catalog
 * auto-listing is dropped, so the page shows 胜算云 (default) plus 自定义
 * providers the user declared below. The rest of the installed catalog stays
 * reachable through settings.yaml.
 * @returns an error message, or the rows.
 */
export async function readProviderRows(api: IApiClient): Promise<{ error?: string, rows?: ProviderRowView[] }> {
  const [providersResponse, settingsResponse, catalogResponse] = await Promise.all([
    api.llm.providers({}),
    api.settings.describe({}),
    fetch('/dsh-cline/catalog')
      .then(r => (r.ok ? r.json() as Promise<{ models?: Record<string, string[]> }> : { models: {} as Record<string, string[]> }))
      .catch((): { models: Record<string, string[]> } => ({ models: {} })),
  ])
  if (!providersResponse.result.ok) return { error: providersResponse.result.error.message }
  if (!settingsResponse.result.ok) return { error: settingsResponse.result.error.message }
  const namespaces = new Map(settingsResponse.result.value.namespaces.map(ns => [ns.ns, ns]))
  const ssyRoutes = new Set<string>(Object.values(SSY_ROUTES))
  const rows: ProviderRowView[] = []
  const refs = new Set<string>()
  for (const entry of providersResponse.result.value.providers) {
    if (ssyRoutes.has(entry.provider)) continue
    const catalogModels = catalogResponse.models?.[entry.provider] ?? []
    const ns = namespaces.get(entry.settingsNs)
    const profile = ns === undefined ? undefined : pathOf(ns.value, entry.settingsPath)
    // Surface only hand-declared pi-ai routes: a route the user wrote into
    // llm-pi-ai.providers has a resolved profile at its (non-empty) settings
    // path. Every built-in catalog auto-listing (deepseek, amazon-bedrock,
    // anthropic, openai, ...) has no such profile yet and is dropped, so the
    // page shows only 胜算云 (default) + 自定义. Declare a new provider below
    // and it appears here to configure its key.
    const inProviders = entry.settingsPath.length > 0 && profile !== undefined
    if (!inProviders) continue
    const configured = ns !== undefined && profile !== undefined
    const removable = ns !== undefined
      && entry.settingsPath.length > 0
      && hasPathOf(ns.user, entry.settingsPath)
      && !hasPathOf(ns.base, entry.settingsPath)
    const named = typeof profile === 'object' && profile !== null
      ? (profile as { apiKeyEnv?: unknown }).apiKeyEnv : undefined
    const keyRef = typeof named === 'string' && named.length > 0 ? named : deriveKeyRef(entry.provider)
    refs.add(keyRef)
    rows.push({
      provider: entry.provider,
      displayName: entry.displayName,
      settingsNs: entry.settingsNs,
      settingsPath: entry.settingsPath,
      configured,
      removable,
      keyRef,
      keyConfigured: undefined,
      catalogModels,
      declared: true,
    })
  }
  try {
    const credentialsResponse = await api.credentials.describe({ refs: [...refs] })
    if (credentialsResponse.result.ok) {
      const credentials = credentialsResponse.result.value.credentials
      for (const row of rows) row.keyConfigured = credentials[row.keyRef]?.configured === true
    }
  } catch { /* enrichment failure keeps dots unknown */ }
  return { rows }
}

function hasPathOf(value: unknown, path: readonly string[]): boolean {
  return pathOf(value, path) !== undefined
}

/**
 * Store an API key (and pick the model for DeepSeek) for a non-default
 * provider. Whole-section providers (settingsPath empty, e.g. DeepSeek 原厂)
 * need only the credential - their composition entry already names the
 * conventional reference; pi-ai routes additionally get a minimal profile
 * recording the derived reference (plus the selected catalog model).
 * @returns an error message, or undefined on success.
 */
export async function saveProviderKey(
  api: IApiClient,
  row: ProviderRowView,
  key: string,
  model?: string,
): Promise<string | undefined> {
  if (row.settingsNs === 'llm-pi-ai' && row.settingsPath.length > 0) {
    const described = await api.settings.describe({})
    if (!described.result.ok) return described.result.error.message
    const ns = described.result.value.namespaces.find(n => n.ns === 'llm-pi-ai')
    const existing = pathOf(ns?.value, row.settingsPath)
    const base = typeof existing === 'object' && existing !== null ? existing as Record<string, unknown> : {}
    const ops: SettingsPathOpView[] = [{
      op: 'set',
      path: [...row.settingsPath],
      value: {
        ...base,
        apiKeyEnv: row.keyRef,
        ...(model === undefined ? {} : { models: [{ id: model }] }),
      },
    }]
    const revision = ns?.revision
    const mutate = await api.settings.mutate({
      ns: 'llm-pi-ai', ops, ...(revision === undefined ? {} : { expectedRevision: revision }),
    })
    if (!mutate.result.ok) return mutate.result.error.message
  }
  const stored = await api.credentials.set({ ref: row.keyRef, value: key })
  if (!stored.result.ok) return stored.result.error.message
  return undefined
}

/**
 * Remove a user-added pi-ai provider profile and its page-managed credential
 * (credential first, so a failed second step leaves the row retryable).
 * @returns an error message, or undefined on success.
 */
export async function removeProviderRow(api: IApiClient, row: ProviderRowView): Promise<string | undefined> {
  try {
    if (row.keyConfigured === true) {
      const credential = await api.credentials.unset({ ref: row.keyRef })
      if (!credential.result.ok) return credential.result.error.message
    }
    const mutate = await api.settings.mutate({
      ns: row.settingsNs,
      ops: [{ op: 'unset', path: [...row.settingsPath] }],
    })
    if (!mutate.result.ok) return mutate.result.error.message
  } catch (error) {
    return String(error)
  }
  return undefined
}

/** One MCP server declaration as the managed UI sees it. */
export interface McpServerEntry {
  transport?: string
  command?: string
  url?: string
  disabled?: boolean
  [key: string]: unknown
}

/** One MCP declaration merged with its file-level name. */
export interface McpServerRow extends McpServerEntry {
  name: string
}

/** Read the MCP declarations through the plugin's file-backed gateway route. */
export async function fetchMcpServers(): Promise<McpServerRow[]> {
  const response = await fetch('/dsh-cline/mcp')
  if (!response.ok) throw new Error('MCP 配置读取失败（HTTP ' + String(response.status) + '）')
  const body = await response.json() as { servers?: Record<string, McpServerEntry> }
  return Object.entries(body.servers ?? {}).map(([name, entry]) => ({ ...entry, name }))
}

/** Replace the MCP declarations through the gateway route. */
export async function writeMcpServers(servers: Record<string, McpServerEntry>): Promise<void> {
  const response = await fetch('/dsh-cline/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ servers }),
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error('MCP 配置保存失败（HTTP ' + String(response.status) + '）' + (detail === '' ? '' : '：' + detail))
  }
}

/** Ask the VS Code host to restart the DSH service (answers before the kill). */
export async function restartDshService(): Promise<void> {
  const response = await fetch('/dsh-cline/restart', { method: 'POST' })
  if (!response.ok) {
    throw new Error('重启请求失败（HTTP ' + String(response.status) + '）— 桥未连接时请在 VS Code 使用「DSH Cline: 重启 DSH 服务」')
  }
}

/** Conventional credential reference for a provider route (DSH Models-page rule). */
export function deriveKeyRef(provider: string): string {
  return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}
