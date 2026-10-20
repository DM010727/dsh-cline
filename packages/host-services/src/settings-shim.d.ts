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

}

declare module '@deepseek-ai/schemastery' {
  /** Schemastery schema node (callable: validates/normalizes its input). */
  export interface ZodType {
    (...args: unknown[]): unknown
    default(value: unknown): ZodType
    volatile(): ZodType
  }

  /** The builder subset this package's Config schemas use. */
  const z: {
    object(shape: Record<string, unknown>): ZodType
    string(): ZodType
    boolean(): ZodType
    const(value: unknown): ZodType
    union(schemas: unknown[]): ZodType
  }
  export default z
}
