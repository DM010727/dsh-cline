/** Authenticated bootstrap of the VS Code project's native DSH workspace. */
import type { IncomingMessage } from 'node:http'
import { isAbsolute } from 'node:path'
import type { Context, WebServerService } from '@deepseek-ai/cordis'
import { createHash } from 'node:crypto'
import { canonicalPath, sameWorkspace, type AgentContext } from './workspace-context.js'
import { guardRequest, readJsonObject, RequestError, requestErrorStatus, sendJson } from './request-guard.js'

export function registerWorkspaceBridge(ctx: Context, webServer: WebServerService): void {
  // A later session-directory change cannot redirect the extension's startup project.
  const startupDirectory = process.cwd()
  for (const path of ['/dsh-cline/workspace', '/dsh-cline/workspace/session']) ctx.effect(() => webServer.register({ kind: 'exact', path, handler: async (req, res) => {
    if (!guardRequest(req, res, ['POST'], true)) return
    try {
      const connection = ctx.get('connection') as { requestRejection?(request: IncomingMessage): { status: number } | undefined } | undefined
      if (typeof connection?.requestRejection !== 'function') throw new RequestError(503, '本地会话认证服务尚未就绪')
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) throw new RequestError(rejection.status === 403 ? 403 : 401, '请先通过 DSH Cline 登录本地会话')
      const url = new URL(req.url ?? path, 'http://127.0.0.1')
      const body = await readJsonObject(req, 1024)
      if (url.search) throw new RequestError(400, '不接受工作区查询参数')
      if (path.endsWith('/session')) {
        if (Object.keys(body).length !== 1 || typeof body.sessionId !== 'string' || !body.sessionId.trim() || body.sessionId.length > 200 || /[\x00-\x20]/.test(body.sessionId)) throw new RequestError(400, '只接受非空 sessionId 字符串')
        const cwd = await sessionDirectory(ctx, body.sessionId)
        if (!cwd || !isAbsolute(cwd) || cwd.length > 8192 || /[\x00-\x1f]/.test(cwd)) throw new RequestError(409, '无法确定此会话的真实项目，请从项目侧栏重新打开')
        sendJson(res, 200, projectIdentity(cwd)); return
      }
      if (Object.keys(body).length) throw new RequestError(400, '工作区由扩展启动目录确定，请发送空 JSON 对象，不接受路径或标题参数')
      const registry = ctx.get('workspaceRegistry') as { create?(path: string): Promise<{ id: unknown; path: string; title: string }> } | undefined
      if (typeof registry?.create !== 'function') throw new RequestError(503, '原生工作区服务尚未就绪')
      // The native API serializes mutations and reuses canonical paths without retitling.
      const entity = await registry.create(startupDirectory)
      if (!entity || typeof entity.path !== 'string' || typeof entity.title !== 'string' || !sameWorkspace(entity.path, startupDirectory)
        || typeof entity.id !== 'string' || !entity.id || entity.id.length > 200) throw new Error('invalid workspace identity')
      sendJson(res, 200, { workspace: { workspaceId: String(entity.id), path: entity.path, title: entity.title }, projectId: projectIdentity(entity.path).projectId })
    } catch (error) {
      sendJson(res, requestErrorStatus(error, 500), { error: error instanceof RequestError ? error.message : '原生工作区暂不可用，请稍后重试；已有工作区与会话保持不变' })
    }
  } }), 'dsh-cline: ' + path)
}

// Workspace identity is independent of experimental learning storage.
function projectIdentity(path: string): { projectId: string; workspace: string } {
  const workspace = canonicalPath(path)
  const key = process.platform === 'win32' ? workspace.toLowerCase() : workspace
  return { projectId: createHash('sha256').update(key).digest('hex').slice(0, 32), workspace }
}

interface SessionLike { header: { cwd?: string } }
/** Resolve live, cold-observed, or loaded Session state without creating an Agent. */
async function sessionDirectory(ctx: Context, id: string): Promise<string | undefined> {
  const directory = ctx.get('workingDirectory') as { get?(session: SessionLike): string | undefined } | undefined
  const agents = ctx.get('agents') as { get?(id: string): AgentContext | undefined } | undefined
  const live = agents?.get?.(id)
  const livePath = live ? directory?.get?.(live.session) ?? live.session.header.cwd : undefined
  if (livePath !== undefined) return livePath
  interface Observation { header: { cwd?: string }; projections?: { values: { workingDirectory?: string | null } }; [Symbol.dispose]?: () => void }
  const query = ctx.get('sessionQuery') as { observeSession?(id: string): Promise<Observation> } | undefined
  if (query?.observeSession) {
    try {
      const observation = await query.observeSession(id)
      try {
        const path = observation.projections?.values.workingDirectory ?? observation.header.cwd
        if (path !== undefined) return path
      } finally { observation[Symbol.dispose]?.() }
    } catch (error) {
      if ((error as { code?: string })?.code !== 'SESSION_QUERY_SESSION_NOT_FOUND') throw error
    }
  }
  const sessions = ctx.get('sessions') as { get?(id: string): SessionLike | undefined } | undefined
  const session = sessions?.get?.(id)
  return session ? directory?.get?.(session) ?? session.header.cwd : undefined
}
