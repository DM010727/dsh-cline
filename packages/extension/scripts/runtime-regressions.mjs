import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import http from 'node:http'

const require = createRequire(import.meta.url)
const root = fileURLToPath(new URL('../src/', import.meta.url))
async function load(name, overrides = {}) {
  const built = await build({ entryPoints: [root + name], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })
  const module = { exports: {} }
  vm.runInNewContext(built.outputFiles[0].text, {
    module, exports: module.exports, require: id => overrides[id] ?? require(id),
    process, Buffer, URL, console, setTimeout, clearTimeout, setInterval, clearInterval, AbortController,
  })
  return module.exports
}
let count = 0
const check = (value, description) => { assert.ok(value, description); count++ }
let reply = { ok: true, version: '0.2.1-rc.2', command: process.platform === 'win32' ? 'C:\\managed\\dsh.cmd' : '/managed/dsh' }
let failed = false
let invocation
const runtime = await load('runtime.ts', { 'node:child_process': {
  execFile: (cmd, args, options, callback) => {
    invocation = { cmd, args, options }
    callback(failed ? new Error('fixture timeout') : null, { stdout: JSON.stringify(reply) })
  },
} })
check(runtime.servicePort(0, '/workspace') === runtime.workspacePort('/workspace'), 'legacy random-port zero migrates to the workspace port')
check(runtime.servicePort(52341, '/workspace') === 52341, 'explicit supported port is preserved')
assert.throws(() => runtime.servicePort(-1, '/workspace')); count++
check((await runtime.checkManagedRuntime('/assets', '/isolated')).ok, 'verified pinned runtime is accepted')
check(invocation.cmd === 'node' && invocation.args.at(-1) === '/isolated' && invocation.options.timeout === 15000,
  'runtime check uses explicit home, no shell and a bounded child')
reply = { ...reply, version: '0.1.0-rc.7' }
check(!(await runtime.checkManagedRuntime('/assets', '/isolated')).ok, 'top-level version mismatch is rejected')
reply = { ok: true, version: '0.2.1-rc.2', command: 'relative-dsh' }
check(!(await runtime.checkManagedRuntime('/assets', '/isolated')).ok, 'relative or missing command cannot pass verification')
failed = true
check(!(await runtime.checkManagedRuntime('/assets', '/isolated')).ok, 'missing or timed out verifier returns repair state')
const line = runtime.managedInstallLine('/assets with space', "/home/owner's config", true, true)
check(line.includes("'owner''s") || line.includes("owner''s config'"), 'installer path arguments preserve literal apostrophes')
check(line.includes('https://registry.npmmirror.com') && !line.includes('npm install -g'), 'mirror uses the same isolated installer')

const { SidecarManager } = await load('sidecar.ts')
let health = { plugin: 'dsh-cline-host-services', bridge: 'up', workspaceRoot: '/workspace', runtimeRevision: runtime.DSH_RUNTIME_REVISION }
const server = http.createServer((_req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(health)) })
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const sidecar = new SidecarManager(() => ({ cmd: 'unused', args: [], host: '127.0.0.1', port: 1, workspaceRoot: '/workspace', runtimeRevision: runtime.DSH_RUNTIME_REVISION }))
try {
  const url = 'http://127.0.0.1:' + server.address().port
  check(await sidecar.probeOurs(url), 'matching workspace and patched runtime can bind')
  delete health.runtimeRevision
  check(!(await sidecar.probeOurs(url)), 'legacy running service cannot bypass dependency verification')
  health.runtimeRevision = 'unpatched'
  check(!(await sidecar.probeOurs(url)), 'a different runtime revision is rejected')
  health.runtimeRevision = runtime.DSH_RUNTIME_REVISION
  health.workspaceRoot = '/foreign'
  check(!(await sidecar.probeOurs(url)), 'patched service from another workspace is rejected')
} finally {
  sidecar.dispose()
  await new Promise(resolve => server.close(resolve))
}
console.log('Managed runtime integration regressions: ' + count + ' passed (one temporary HTTP fixture, no DSH).')
