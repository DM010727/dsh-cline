/** Explicit selection-action task delivery; never infer a session from global events. */
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Context, WebServerService } from '@deepseek-ai/cordis'
import { guardRequest, readJsonObject, requestErrorStatus, RequestError, sendJson } from './request-guard.js'
import { executionCwd, sameWorkspace, type AgentContext } from './workspace-context.js'

interface AgentLike extends AgentContext { followup(message: unknown): void }
interface AgentHandle { agent: AgentLike; dispose(): Promise<void> }
interface Agents {
  get(id: unknown): AgentLike | undefined
  create(options: {
    sessionId: unknown
    meta: { cwd: string }
    agentOptions: { provider: string; model: string }
    setup: (agentCtx: unknown) => void
  }): Promise<AgentHandle>
}

/** An omitted session id creates a new conversation in this exact workspace. */
export function registerTaskInjector(ctx: Context, webServer: WebServerService): void {
  ctx.effect(() => webServer.register({
    kind: 'exact',
    path: '/dsh-cline/task',
    handler: async (req, res) => {
      if (!guardRequest(req, res, ['POST'], true)) return
      try {
        const body = await readJsonObject(req)
        if (typeof body.content !== 'string' || body.content.trim() === '') throw new RequestError(400, 'content is required')
        if (body.cwd !== undefined && (typeof body.cwd !== 'string' || !sameWorkspace(body.cwd))) {
          throw new RequestError(409, 'task workspace does not match this DSH instance')
        }
        const agents = ctx.get('agents') as Agents | undefined
        if (agents === undefined) throw new RequestError(503, 'DSH agent service unavailable')
        if (body.sessionId !== undefined) {
          if (typeof body.sessionId !== 'string' || body.sessionId === '') throw new RequestError(400, 'sessionId must be a nonempty string')
          const agent = agents.get(SessionId(body.sessionId))
          if (agent === undefined) throw new RequestError(409, 'requested DSH session is not live')
          if (!sameWorkspace(executionCwd(ctx, agent))) throw new RequestError(409, 'session belongs to another workspace')
          agent.followup(message(body.content))
          sendJson(res, 200, { ok: true, sessionId: body.sessionId, created: false })
          return
        }
        const defaults = ctx.get('agentDefaultModel') as { currentSelection(): { provider: string; model: string } } | undefined
        if (defaults === undefined) throw new RequestError(503, 'DSH default model unavailable')
        const selection = defaults.currentSelection()
        const sessionId = 'session-' + randomUUID()
        const handle = await agents.create({
          sessionId: SessionId(sessionId),
          meta: { cwd: process.cwd() },
          agentOptions: selection,
          setup: agentCtx => { installModelSelection(agentCtx, { current: selection, assembled: undefined }) },
        })
        try {
          handle.agent.followup(message(body.content))
          const sessions = ctx.get('sessions') as { flush(session: unknown): Promise<unknown> } | undefined
          await sessions?.flush(handle.agent.session)
        } catch (error) {
          await handle.dispose().catch(() => {})
          throw error
        }
        sendJson(res, 200, { ok: true, sessionId, created: true })
      } catch (error) {
        sendJson(res, requestErrorStatus(error, 500), { ok: false, error: String(error) })
      }
    },
  }), 'dsh-cline-host-services: task route')
}

function message(content: string): unknown {
  return createUserMessage({ content: [{ type: 'text', text: content }], source: { kind: 'user' } })
}
