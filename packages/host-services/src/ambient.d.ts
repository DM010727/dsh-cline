/**
 * Ambient declarations for DSH packages this plugin imports at runtime but which
 * are NOT resolvable at typecheck time. host-services ships zero runtime
 * dependencies: its compiled output runs inside a dsh profile and resolves these
 * from the profile's node_modules at runtime. Declaring them here lets the local
 * typecheck pass without vendoring the packages.
 */

declare module '@deepseek-ai/dsh-llm' {
  /** Create one identified user-role message for `agent.followup`. */
  export function createUserMessage(input: {
    content: Array<{ type: 'text'; text: string }>
    source: { kind: string }
  }): unknown
}

declare module '@deepseek-ai/dsh-session' {
  /** Brand a session id string. */
  export function SessionId(value: string): unknown
}

declare module '@deepseek-ai/dsh-agent' {
  /** Install the model selection into a freshly created agent context. */
  export function installModelSelection(
    ctx: unknown,
    options: { current: { provider: string; model: string }; assembled: unknown },
  ): void
}
