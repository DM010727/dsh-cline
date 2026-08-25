/**
 * Minimal ambient surface of the vendored Cordis the host-services plugin
 * consumes. The runtime module resolves from the DSH installation that loads
 * this plugin; this file exists only so the package type-checks standalone.
 * Keep the surface in sync with @deepseek-ai/cordis Context.
 */

/**
 * Ambient declaration for the MCP client plugin this package dynamically
 * imports at runtime (resolved from the DSH installation). Loose on purpose:
 * the real shapes live with the harness; only the plugin-module form matters
 * here.
 */
declare module '@deepseek-ai/dsh-mcp-client' {
  /** Named-export cordis plugin module (no default export). */
  export const name: string
  export const inject: string[]
  export function apply(ctx: unknown, config: unknown): void | Promise<void>
}

declare module '@deepseek-ai/cordis' {
  import type { IncomingMessage, ServerResponse } from 'node:http'

  /** Effect disposer. */
  type Disposer = () => void

  /** Named HTTP route on the DSH web carrier. */
  interface WebRoute {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }

  /** The webServer service the web profile provides. */
  interface WebServerService {
    register(route: WebRoute): Disposer
    readonly port: number
  }

  /** Around-dispatch view of one tool call (subset this plugin reads). */
  interface ToolDispatchExecution {
    readonly name: string
    readonly arguments: unknown
    signal: AbortSignal
  }

  /** Settled outcome of one tool call (subset this plugin reads). */
  interface ToolExecutionResult {
    readonly isError?: boolean
  }

  /** Waterfall next(): delegates to the next wrapper / the tool body. */
  type ToolNext = () => Promise<ToolExecutionResult>

  /** One registered tool (schema plus execution; hand-built, no defineTool). */
  interface ToolDefinition {
    readonly name: string
    readonly description: string
    /** JSON Schema for the model-facing arguments object. */
    readonly parameters: Record<string, unknown>
    readonly output: {
      readonly schema: Record<string, unknown>
      render(args: unknown, value: unknown): Array<{ type: 'text', text: string }>
    }
    isConcurrencySafe?(args: unknown): boolean
    execute(args: unknown, exec: { signal: AbortSignal }): Promise<unknown>
  }

  /** The tools registry service. */
  interface ToolsService {
    register(definition: ToolDefinition): Disposer
  }

  /** The system-prompt section registry service. */
  interface SystemPromptService {
    section(section: { name: string, order: number, text: string }): Disposer
  }

  /** Plugin context subset used by this plugin. */
  interface Context {
    effect(factory: () => Disposer, label?: string): Disposer
    /** Provide an ordinary value service. */
    provide(name: string, value: unknown): void
    /** Run once every listed service is available; disposed with the fiber. */
    inject(services: string[], callback: (ctx: Context) => void | Promise<void>): unknown
    /** Read an optional service from the global store. */
    get(name: 'webServer'): WebServerService | undefined
    get(name: 'tools'): ToolsService | undefined
    get(name: 'systemPrompt'): SystemPromptService | undefined
    get(name: string): unknown
    /** Registry seats used by the vscode tool. */
    readonly tools: ToolsService
    readonly systemPrompt: SystemPromptService
    /** Mount a nested plugin (module object) with config; returns its fiber. */
    plugin(module: object, config?: unknown): unknown
    /** Dispose-time cleanup. */
    on(event: 'dispose', callback: () => void): Disposer
    /** Around-dispatch tool waterfall; the listener MUST call next(). */
    on(event: 'tools/execute', listener: (exec: ToolDispatchExecution, next: ToolNext) => Promise<ToolExecutionResult>): Disposer
    logger: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void }
  }
}
