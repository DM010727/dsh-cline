/**
 * Minimal ambient surface of the DSH settings service packages the
 * host-services plugin consumes to register its own settings namespace. At
 * runtime both resolve from the DSH installation that loads this plugin (the
 * profiles/node_modules flat fallback); this file exists only so the package
 * type-checks standalone, like cordis-shim.d.ts.
 */

declare module '@deepseek-ai/dsh-settings' {
  /** Namespace id string (e.g. 'dsh-cline-host-services'). */
  export type SettingsNamespace = string

  /** Hooks the settings-section installer hands back to the consumer. */
  export interface SettingsSectionHooks<T> {
    /** Receive the authoritative value thunk (settings scope, else entry). */
    setSource(current: () => T): void
    /** Re-judge derived facts after attach/detach/committed change. */
    onChange(): void
    /** Reject a schema-valid section this consumer cannot act on. */
    validate?(value: T): void
  }

  /**
   * Canonical optional-settings consumer wiring: register `ns` with the
   * composition entry as the `base` layer while a settings service exists,
   * falling back to the entry when it does not.
   */
  export function installSettingsSection<T>(
    ctx: import('@deepseek-ai/cordis').Context,
    ns: SettingsNamespace,
    schema: unknown,
    entry: T,
    hooks: SettingsSectionHooks<T>,
  ): void
}

declare module '@deepseek-ai/schemastery' {
  /** Schemastery schema node (callable: validates/normalizes its input). */
  export interface ZodType {
    (...args: unknown[]): unknown
  }

  /** The builder subset this package's Config schemas use. */
  const z: {
    object(shape: Record<string, unknown>): unknown
    string(): unknown
    boolean(): unknown
    const(value: unknown): unknown
    union(schemas: unknown[]): unknown
  }
  export default z
}

/** The pi-ai compatibility module the web gateway reads the builtin catalog from. */
declare module '@earendil-works/pi-ai/dist/compat.js' {
  /** Every provider route id the installed catalog ships. */
  export function getProviders(): string[]
  /** The model rows one provider ships (only `id` is consumed). */
  export function getModels(provider: string): Array<{ id: string }>
}
