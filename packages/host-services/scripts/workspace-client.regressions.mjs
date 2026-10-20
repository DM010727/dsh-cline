/** Actual client coordinator against native catalog/service faces; no DSH/model/profile. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
const require = createRequire(new URL('../package.json', import.meta.url))
const { build } = require('esbuild')
const result = await build({ entryPoints: [fileURLToPath(new URL('../src/client/workspace-binding.ts', import.meta.url))], platform: 'node', format: 'esm', bundle: true, write: false, logLevel: 'silent' })
const { installWorkspaceBinding, getProjectBinding, retryProjectBinding } = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
const original = new Map(['window', 'document', 'fetch'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
let passed = 0
const check = (condition, label) => { assert.ok(condition, label); passed++ }
const tick = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setTimeout(resolve, 1)) }
const ids = { A: 'a'.repeat(32), B: 'b'.repeat(32), C: 'c'.repeat(32) }
function source(value) { const listeners = new Set(); return { getSnapshot: () => value, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) }, set(next) { value = next; for (const listener of listeners) listener() }, get listeners() { return listeners.size } } }
function fixture({ initial = 'B', ready = true, bootstrapDelay, sessionDelay, bootstrapFailure = false } = {}) {
  const calls = [], opens = [], phases = [], handlers = new Map(), parent = { postMessage(value) { calls.push({ ready: value }) } }
  const windowMock = Object.assign(new EventTarget(), { parent })
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowMock })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { baseURI: 'http://127.0.0.1:12345/capability/', referrer: '' } })
  const catalog = source({ phase: ready ? 'ready' : 'connecting', items: [{ workspaceId: 'workspace-A', path: '/project/A', sessionIds: ['session-A'] }, { workspaceId: 'workspace-B', path: '/project/B', sessionIds: ['session-B'] }] })
  const row = (name, active = false) => ({ id: 'session-' + name, cwd: '/project/' + name, retainedBy: { mainView: active ? 1 : 0 }, updatedAt: name === 'B' ? 999999 : 0 })
  const sessions = source({ phase: ready ? 'ready' : 'connecting', byId: { 'session-A': row('A', initial === 'A'), 'session-B': row('B', initial === 'B'), 'session-C': row('C', initial === 'C') } })
  let actual = { A: 'A', B: 'B', C: 'C' }, failBootstrap = bootstrapFailure
  const select = name => {
    const before = sessions.getSnapshot()
    sessions.set({ ...before, byId: Object.fromEntries(Object.entries(before.byId).map(([id, value]) => [id, { ...value, retainedBy: { mainView: id === 'session-' + name ? 1 : 0 } }])) })
  }
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname, body = JSON.parse(options.body); calls.push({ path, body, options })
    if (path.endsWith('/workspace')) {
      if (bootstrapDelay) await bootstrapDelay
      if (failBootstrap) return { ok: false, json: async () => ({ error: '启动绑定失败' }) }
      return { ok: true, json: async () => ({ workspace: { workspaceId: 'workspace-A', path: '/project/A' }, projectId: ids.A }) }
    }
    if (sessionDelay) await sessionDelay(body.sessionId)
    const name = actual[body.sessionId.slice(-1)]
    if (!name) return { ok: false, json: async () => ({ error: '未知会话项目' }) }
    return { ok: true, json: async () => ({ projectId: ids[name], workspace: '/project/' + name }) }
  }
  const ctx = { workspaces: { list: catalog }, sessions: { list: sessions },
    uiWorkspace: { async openWorkspace(id) { opens.push(id); select(id.slice(-1)) }, openSession(id) { phases.push('explicit-session:' + id); select(id.slice(-1)) } },
    layout: { beginNavigation() { phases.push('cancel-native-navigation'); return new AbortController().signal } },
    remote: { $on(name, listener) { handlers.set(name, listener); return () => handlers.delete(name) } }, logger: { warn() {} },
  }
  const message = (data, from = parent) => windowMock.dispatchEvent(Object.assign(new Event('message'), { source: from, origin: 'https://vscode-webview.example', data }))
  const stop = installWorkspaceBinding(ctx)
  return { calls, opens, sessions, catalog, select, stop, message, phases, actual, setBootstrapFailure(value) { failBootstrap = value }, activity: id => handlers.get('api-session/activity')?.(id) }
}
try {
  let f = fixture()
  await tick()
  check(f.opens.join() === 'workspace-A' && getProjectBinding().projectId === ids.A, 'startup supersedes another recent project with the VS Code workspace')
  check(f.calls.find(call => call.path?.endsWith('/workspace')).body && Object.keys(f.calls.find(call => call.path?.endsWith('/workspace')).body).length === 0, 'client never sends an arbitrary startup path')
  check(f.calls.filter(call => call.path).every(call => call.options.credentials === 'same-origin' && call.path.startsWith('/capability/')), 'authenticated endpoints preserve capability prefix')
  f.select('B'); await tick()
  check(getProjectBinding().projectId === ids.B && getProjectBinding().sessionId === 'session-B', 'manual native project selection changes footer to actual project B')
  f.message({ channel: 'dsh-cline.open-workspace' }, {}); await tick()
  check(f.opens.length === 1 && getProjectBinding().projectId === ids.B, 'forged window cannot force navigation')
  f.message({ channel: 'dsh-cline.open-workspace' }); await tick()
  check(f.opens.length === 2 && getProjectBinding().projectId === ids.A, 'reopening a retained webview restores VS Code project again')
  f.actual.A = 'C'; const before = f.sessions.getSnapshot()
  f.sessions.set({ ...before, byId: { ...before.byId, 'session-A': { ...before.byId['session-A'], projectionValues: { workingDirectory: '/project/C' } } } }); await tick()
  check(getProjectBinding().projectId === ids.C, 'working-directory projection change updates same-session RSI target')
  f.actual.A = undefined; f.sessions.set({ ...f.sessions.getSnapshot(), byId: { ...f.sessions.getSnapshot().byId, 'session-A': { ...f.sessions.getSnapshot().byId['session-A'], projectionValues: { workingDirectory: '/missing' } } } }); await tick()
  check(!getProjectBinding().projectId && getProjectBinding().error === '未知会话项目', 'unknown session disables controls instead of defaulting to startup project')
  f.actual.A = 'A'; retryProjectBinding(); await tick()
  check(getProjectBinding().projectId === ids.A, 'explicit retry repairs mapping after native state becomes available')
  f.stop(); check(f.sessions.listeners === 0 && f.catalog.listeners === 0, 'dispose releases native subscriptions')

  f = fixture({ initial: 'A' }); await tick()
  check(f.opens.length === 0 && getProjectBinding().projectId === ids.A, 'already-in-target workspace keeps its current conversation')
  f.stop()

  let releaseB
  f = fixture({ initial: 'A', sessionDelay: id => id === 'session-B' ? new Promise(resolve => { releaseB = resolve }) : undefined }); await tick()
  f.select('B'); await tick(); f.select('A'); await tick(); releaseB(); await tick()
  check(getProjectBinding().projectId === ids.A, 'late B mapping cannot overwrite a newer A selection')
  const ambiguous = f.sessions.getSnapshot()
  f.sessions.set({ ...ambiguous, byId: { ...ambiguous.byId, 'session-B': { ...ambiguous.byId['session-B'], retainedBy: { mainView: 1 } } } }); await tick()
  check(!getProjectBinding().projectId && getProjectBinding().loading, 'ambiguous mainView transition does not guess last-used project')
  f.stop()

  f = fixture({ ready: false })
  await tick(); f.message({ channel: 'dsh-cline.open-session', sessionId: 'session-B' }); await tick()
  f.catalog.set({ ...f.catalog.getSnapshot(), phase: 'ready' }); f.sessions.set({ ...f.sessions.getSnapshot(), phase: 'ready' }); await tick()
  check(f.opens.length === 0 && getProjectBinding().projectId === ids.B, 'explicit editor task wins while bootstrap waits for native catalogs')
  check(f.phases.join().includes('cancel-native-navigation,explicit-session:session-B'), 'explicit task cancels pending native workspace restoration first')
  f.stop()

  f = fixture({ bootstrapFailure: true }); await tick()
  check(!getProjectBinding().projectId && getProjectBinding().error === '启动绑定失败', 'bootstrap failure is visible and cannot leave a misleading active switch')
  f.setBootstrapFailure(false); retryProjectBinding(); await tick()
  check(f.opens.length === 1 && getProjectBinding().projectId === ids.A, 'bootstrap retry realigns instead of enabling the restored wrong project')
  f.stop()

  let releaseBootstrap
  f = fixture({ bootstrapDelay: new Promise(resolve => { releaseBootstrap = resolve }) }); f.stop(); releaseBootstrap(); await tick()
  check(f.opens.length === 0 && !getProjectBinding().projectId, 'disposed client cannot navigate on late bootstrap response')
  console.log('Workspace client binding regressions: ' + passed + ' passed.')
} finally { for (const [key, descriptor] of original) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete globalThis[key] } }
