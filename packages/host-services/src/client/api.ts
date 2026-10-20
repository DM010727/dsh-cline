/** Only the settings and write-only credential operations our UI owns. */
export type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }
export interface SettingsNamespaceView {
  ns: string
  value: unknown
  user?: unknown
  base?: unknown
  revision: number
}
export interface SettingsPathOpView {
  op: 'set' | 'unset'
  path: string[]
  value?: unknown
}
export interface CredentialView { configured: boolean; writable: boolean }
export interface SettingsDescribe { writable: boolean; namespaces: SettingsNamespaceView[] }

/** DSH 0.2 Remote methods use positional arguments and direct Result values. */
export interface ClientApi {
  /** Native invalidations keep an open provider setup in sync with the Models page. */
  $on?(event: string, listener: (...args: unknown[]) => void): () => void
  settings: {
    describe(): Promise<Result<SettingsDescribe>>
    mutate(ns: string, ops: SettingsPathOpView[], expectedRevision: number | undefined): Promise<Result<unknown>>
  }
  credentials: {
    describe(refs: string[]): Promise<Result<Record<string, CredentialView>>>
    set(ref: string, value: string): Promise<Result<unknown>>
  }
}

/** Purely local type face; browser runtime modules remain DSH-owned. */
export interface ClientContext {
  effect(factory: () => (() => void) | void, label?: string): () => void
  slots: {
    inject(name: string, register: () => (() => void)): () => void
    register(options: Record<string, unknown>, component: unknown): () => void
  }
  remote: ClientApi
  commandUi?: {
    decorate(definition: {
      name: string; available(session: { sessionId: string }): boolean
      ui: { kind: 'action'; run(session: { sessionId: string }): void } | {
        kind: 'popupSelect'
        options(session: { sessionId: string }, signal: AbortSignal): Promise<Array<{ id: string; label: string; detail?: string }>>
        onSelect(option: { id: string }, session: { sessionId: string }): void
      }
    }): () => void
  }
  /** Native Workspace UI navigation owner; retains sessions and reveals the conversation. */
  uiWorkspace: { openSession(sessionId: string): void; openWorkspace?(workspaceId: string): Promise<void> }
  /** Native catalog readiness and mainView ownership, never "last active" guesses. */
  workspaces?: { list: NativeSource<{ phase: string; items: Array<{ workspaceId: string; path: string; sessionIds?: string[] }> }> }
  sessions?: { list: NativeSource<{ phase: string; byId: Record<string, { id: string; cwd?: string; projectionValues?: { workingDirectory?: string | null }; retainedBy?: { mainView?: number } }> }> }
  layout?: { beginNavigation(): AbortSignal }
  locale: { getLocale(): { active: string }; setLocale(id: string): void }
  theme: { getTheme(): { preference: string }; setTheme(id: 'light' | 'dark' | 'system'): void }
  logger: { warn(message: string): void }
}

export interface NativeSource<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
