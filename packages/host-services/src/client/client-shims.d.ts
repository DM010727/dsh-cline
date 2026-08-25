/**
 * Minimal ambient surface of the DSH browser-half platform the client bundle
 * consumes. At runtime these modules resolve through the DSH web boot's module
 * table (platform words + plugin bundles); this file exists only so the
 * package type-checks standalone, like cordis-shim.d.ts does for the node half.
 * Keep the surface in sync with the DSH client packages.
 */

declare module '@deepseek-ai/dsh-client-runtime/client' {
  /** Browser-half plugin context (subset this bundle consumes). */
  export interface ClientContext {
    /** Register a scoped effect; its disposer runs on plugin unload. */
    effect(factory: () => (() => void) | void, label?: string): () => void
    /** Read a provided client service by name. */
    get<T = unknown>(name: string): T
    /** Subscribe to a client event (e.g. 'connection/reset'). */
    on(event: string, listener: (payload: unknown) => void): () => void
    /** The UI slot registry. */
    readonly slots: {
      /** Register into a slot once its declaration is on the ledger. */
      inject(name: string, register: () => (() => void)): () => void
      /** One slot registration; options match the DSH SlotCore register shape. */
      register(options: Record<string, unknown>, component: unknown): () => void
      /** Subscribe to one slot's ledger changes (microtask-batched). */
      subscribe(name: string, fn: () => void): () => void
    }
    /** Locale service (unused copy-wise; kept for the inject contract). */
    readonly locale: {
      register(ns: string, dict: unknown): () => void
      bind(ns: string): (key: string) => string
    }
    /** Wire event bus (pushed invalidations). */
    readonly remote: {
      $on(event: string, listener: (payload: unknown) => void): () => void
    }
    /** Theme service (dsh-client-ui-theme): preference owner, durable via settings. */
    readonly theme: {
      /** Current immutable snapshot (preference: 'system' | 'light' | 'dark' | registered id). */
      getTheme(): { preference: string }
      /** Switch the preference; built-ins persist through the settings scope. */
      setTheme(id: 'light' | 'dark' | 'system'): void
    }
    logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
  }
}

declare module '@deepseek-ai/dsh-api-remotes/client' {
  /** Wire envelope: every API call answers ok/value or error. */
  export type ApiResult<T> = Promise<{
    result:
      | { ok: true; value: T }
      | { ok: false; error: { code: string; message: string } }
  }>

  /** One configurable provider directory row. */
  export interface ConfigurableProviderView {
    provider: string
    displayName: string
    settingsNs: string
    settingsPath: readonly string[]
    active: boolean
  }

  /** Credential state for one reference. */
  export interface CredentialView {
    configured: boolean
    writable: boolean
  }

  /** One settings namespace view (schema + merged/user/base layers). */
  export interface SettingsNamespaceView {
    ns: string
    value: unknown
    user: unknown
    base: unknown
    revision?: unknown
  }

  /** One path op for settings.mutate. */
  export interface SettingsPathOpView {
    op: 'set' | 'unset'
    path: readonly string[]
    value?: unknown
  }

  /** The wire API face (subset this bundle consumes). */
  export interface IApiClient {
    settings: {
      describe(args: Record<string, never>): ApiResult<{
        writable: boolean
        namespaces: SettingsNamespaceView[]
      }>
      mutate(args: {
        ns: string
        ops: SettingsPathOpView[]
        expectedRevision?: unknown
      }): ApiResult<{ user: unknown; revision: unknown }>
    }
    credentials: {
      describe(args: { refs: string[] }): ApiResult<{ credentials: Record<string, CredentialView> }>
      set(args: { ref: string; value: string }): ApiResult<unknown>
      unset(args: { ref: string }): ApiResult<unknown>
    }
    llm: {
      providers(args: Record<string, never>): ApiResult<{ providers: ConfigurableProviderView[] }>
    }
  }

  /** The connection service: the wire API client plus link facts. */
  export interface ConnectionHandle {
    readonly api: IApiClient
    readonly isLoopback: boolean
  }
}
