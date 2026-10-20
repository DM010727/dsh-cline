/** One owner for VS Code workspace startup and the current conversation's project identity. */
import type { ClientContext, NativeSource } from './api.ts'
import { isShellMessage, listenOpenSession } from './shell-message.ts'

export interface ProjectBinding { projectId?: string; workspace?: string; sessionId?: string; loading: boolean; error: string }
const empty: ProjectBinding = { loading: true, error: '' }
let snapshot: ProjectBinding = empty
const listeners = new Set<() => void>()
let retry: (() => void) | undefined
export const getProjectBinding = (): ProjectBinding => snapshot
export const subscribeProjectBinding = (listener: () => void): (() => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const retryProjectBinding = (): void => { retry?.() }
function publish(next: ProjectBinding): void {
  if (JSON.stringify(next) === JSON.stringify(snapshot)) return
  snapshot = next; for (const listener of listeners) listener()
}
interface WorkspaceReply { workspace: { workspaceId: string; path: string }; projectId: string }
interface SessionReply { projectId: string; workspace: string }
function validProject(value: SessionReply): boolean { return !!value && /^[a-f0-9]{32}$/.test(value.projectId) && typeof value.workspace === 'string' && value.workspace.length > 0 }
function waitReady(sources: NativeSource<{ phase: string }>[], signal: AbortSignal): Promise<void> {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const stops: Array<() => void> = []
    const finish = (error?: unknown): void => { for (const stop of stops.splice(0)) stop(); signal.removeEventListener('abort', aborted); error ? reject(error) : resolve() }
    const check = (): void => { if (sources.every(source => source.getSnapshot().phase === 'ready')) finish() }
    const aborted = (): void => { finish(signal.reason ?? new Error('工作区定位已取消')) }
    signal.addEventListener('abort', aborted, { once: true })
    for (const source of sources) stops.push(source.subscribe(check))
    check()
  })
}
/** Calls only the private authenticated endpoints; the browser never supplies a cwd. */
async function post<T>(path: string, body: object, signal: AbortSignal): Promise<T> {
  const response = await fetch(new URL(path, document.baseURI), { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal })
  const value = await response.json() as T & { error?: string }
  if (!response.ok) throw new Error(value.error || 'DSH Cline 工作区定位失败，请重试')
  return value
}
export function installWorkspaceBinding(ctx: ClientContext): () => void {
  const workspaces = ctx.workspaces, sessions = ctx.sessions
  if (!workspaces || !sessions || !ctx.uiWorkspace.openWorkspace) {
    publish({ loading: false, error: '工作区服务尚未就绪，已暂停项目开关以防操作错误项目。' })
    return () => {}
  }
  const lifetime = new AbortController()
  let disposed = false, aligning = false, bootFailed = false, generation = 0, mappingGeneration = 0, lastKey = ''
  let activation: AbortController | undefined, mapping: AbortController | undefined, deferred: ReturnType<typeof setTimeout> | undefined, activity: ReturnType<typeof setTimeout> | undefined
  const current = (): ReturnType<typeof sessions.list.getSnapshot>['byId'][string] | undefined => {
    const rows = Object.values(sessions.list.getSnapshot().byId).filter(row => (row.retainedBy?.mainView ?? 0) > 0)
    return rows.length === 1 ? rows[0] : undefined
  }
  const update = (force = false): void => {
    if (disposed || aligning) return
    const row = current()
    if (!row) { lastKey = ''; mappingGeneration++; mapping?.abort(); publish({ loading: true, error: '' }); return }
    const key = JSON.stringify([row.id, row.projectionValues?.workingDirectory, row.cwd])
    if (!force && key === lastKey) return
    lastKey = key; const turn = ++mappingGeneration
    mapping?.abort(); mapping = new AbortController()
    const signal = AbortSignal.any([mapping.signal, lifetime.signal, AbortSignal.timeout(15000)])
    publish({ sessionId: row.id, loading: true, error: '' })
    void post<SessionReply>('dsh-cline/workspace/session', { sessionId: row.id }, signal).then(value => {
      if (disposed || signal.aborted || turn !== mappingGeneration) return
      if (!validProject(value)) throw new Error('当前会话项目身份无效，已阻止开关操作。')
      publish({ ...value, sessionId: row.id, loading: false, error: '' })
    }).catch(error => {
      if (!disposed && turn === mappingGeneration && !mapping?.signal.aborted) publish({ sessionId: row.id, loading: false, error: error instanceof Error ? error.message : '当前会话项目无法定位' })
    })
  }
  const changed = (): void => { clearTimeout(deferred); deferred = setTimeout(() => update(), 0) }
  const activate = (): void => {
    if (disposed || aligning) return
    aligning = true; bootFailed = false; const turn = ++generation
    activation?.abort(); activation = new AbortController()
    const signal = AbortSignal.any([activation.signal, lifetime.signal, AbortSignal.timeout(20000)])
    mapping?.abort(); mappingGeneration++; lastKey = ''
    publish({ loading: true, error: '' })
    void (async () => {
      // Native startup may restore a different recent project. Wait for both
      // catalogs, then use its own navigation owner to supersede that restore.
      const reply = await post<WorkspaceReply>('dsh-cline/workspace', {}, signal)
      if (!reply?.workspace || typeof reply.workspace.workspaceId !== 'string' || !validProject({ projectId: reply.projectId, workspace: reply.workspace.path })) throw new Error('VS Code 工作区身份无效')
      await waitReady([workspaces.list, sessions.list], signal)
      if (!workspaces.list.getSnapshot().items.some(item => item.workspaceId === reply.workspace.workspaceId)) {
        await new Promise<void>((resolve, reject) => {
          let stop: (() => void) | undefined
          const done = (): void => { stop?.(); signal.removeEventListener('abort', abort); resolve() }
          const check = (): void => { if (workspaces.list.getSnapshot().items.some(item => item.workspaceId === reply.workspace.workspaceId)) done() }
          const abort = (): void => { stop?.(); signal.removeEventListener('abort', abort); reject(signal.reason) }
          signal.addEventListener('abort', abort, { once: true }); stop = workspaces.list.subscribe(check); check()
        })
      }
      signal.throwIfAborted()
      const row = current()
      let same = false
      if (row) {
        try { same = (await post<SessionReply>('dsh-cline/workspace/session', { sessionId: row.id }, signal)).projectId === reply.projectId } catch { signal.throwIfAborted() }
      }
      if (disposed || turn !== generation) return
      signal.throwIfAborted()
      if (!same) await ctx.uiWorkspace.openWorkspace!(reply.workspace.workspaceId)
      if (!disposed && turn === generation) { aligning = false; update(true) }
    })().catch(error => {
      if (disposed || turn !== generation) return
      aligning = false; bootFailed = true
      publish({ loading: false, error: error instanceof Error ? error.message : 'VS Code 工作区无法定位，请重试。' })
    })
  }
  const openSession = (sessionId: string): void => {
    // An explicit editor task wins over an in-flight default-workspace open.
    generation++; aligning = false; activation?.abort(); lastKey = ''
    ctx.layout?.beginNavigation()
    ctx.uiWorkspace.openSession(sessionId)
    changed()
  }
  const onMessage = (event: MessageEvent): void => {
    if (isShellMessage(event) && event.data?.channel === 'dsh-cline.open-workspace') activate()
  }
  window.addEventListener('message', onMessage)
  const stopWorkspaces = workspaces.list.subscribe(changed), stopSessions = sessions.list.subscribe(changed)
  const stopActivity = ctx.remote.$on?.('api-session/activity', (id: unknown) => {
    if (id !== current()?.id) return
    clearTimeout(activity); activity = setTimeout(() => update(true), 400)
  })
  const stopNavigation = listenOpenSession(openSession)
  retry = () => { if (!bootFailed && snapshot.error && current()) { lastKey = ''; update(true) } else activate() }
  // Also covers opening the managed web client directly and old shell carriers.
  activate()
  return () => {
    disposed = true; lifetime.abort(); activation?.abort(); mapping?.abort(); clearTimeout(deferred); clearTimeout(activity)
    stopWorkspaces(); stopSessions(); stopActivity?.(); stopNavigation(); window.removeEventListener('message', onMessage)
    retry = undefined; publish(empty)
  }
}
