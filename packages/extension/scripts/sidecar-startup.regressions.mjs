/** Startup/authentication regressions: one Node process, local fixtures, no DSH or VS Code. */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import http from 'node:http'
import net from 'node:net'
import { createHmac } from 'node:crypto'
import { setImmediate as nextTurn } from 'node:timers/promises'

const require = createRequire(import.meta.url)
const source = fileURLToPath(new URL('../src/sidecar.ts', import.meta.url))
const compiled = (await build({ entryPoints: [source], bundle: true, write: false, platform: 'node', format: 'cjs', logLevel: 'silent' })).outputFiles[0].text
const WORKSPACE = process.platform === 'win32' ? 'C:\\sidecar-fixture\\workspace' : '/sidecar-fixture/workspace'
const REVISION = '0.2.1-rc.2-r1'
const KEY = 'synthetic-bridge-capability'
const PROXY = 'http://127.0.0.1:65432/synthetic-proxy-capability/'
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no }); return { promise, resolve, reject } }
const flush = async () => { for (let i = 0; i < 5; i++) await nextTurn() }
const bounded = async (promise, description, ms = 2000) => {
  let timeout
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error(description + ' did not settle')), ms) })]) }
  finally { clearTimeout(timeout) }
}

class Clock {
  now = 10_000
  sequence = 0
  pending = new Map()
  add(callback, delay, repeat, args) {
    const handle = { id: ++this.sequence, unref() { return this } }
    this.pending.set(handle.id, { handle, callback, args, due: this.now + Number(delay), repeat })
    return handle
  }
  timeout = (callback, delay, ...args) => this.add(callback, delay, 0, args)
  interval = (callback, delay, ...args) => this.add(callback, delay, Number(delay), args)
  clear = handle => { this.pending.delete(handle?.id ?? handle) }
  async advance(ms) {
    const end = this.now + ms
    for (let runs = 0; ; runs++) {
      assert.ok(runs < 1000, 'virtual timers must remain bounded')
      const next = [...this.pending.values()].filter(task => task.due <= end).sort((a, b) => a.due - b.due || a.handle.id - b.handle.id)[0]
      if (!next) break
      this.now = next.due
      if (next.repeat) next.due += next.repeat
      else this.pending.delete(next.handle.id)
      next.callback(...next.args)
      await flush()
    }
    this.now = end
    await flush()
  }
}

function load() {
  const clock = new Clock()
  const module = { exports: {} }
  const RealDate = Date
  class FixtureDate extends RealDate { static now() { return clock.now } }
  vm.runInNewContext(compiled, {
    module, exports: module.exports, require, Buffer, URL, URLSearchParams, process, console,
    AbortController, AbortSignal, Date: FixtureDate,
    setTimeout: clock.timeout, clearTimeout: clock.clear, setInterval: clock.interval, clearInterval: clock.clear,
  }, { filename: 'sidecar-startup-fixture.cjs' })
  return { SidecarManager: module.exports.SidecarManager, clock }
}

async function drive(promise, clock, ticks = 20) {
  let outcome
  void promise.then(value => { outcome = { value } }, error => { outcome = { error } })
  for (let i = 0; !outcome && i < ticks; i++) { await flush(); if (!outcome) await clock.advance(1000) }
  if (!outcome) return bounded(promise, 'sidecar transition')
  if (outcome.error) throw outcome.error
  return outcome.value
}

const sockets = new Set()
const proof = text => createHmac('sha256', KEY).update(text).digest('base64url')
let rootStatus = 401, healthStatus = 200, rootRequests = 0, receivedKey, receivedChallenge, receivedProof, health, healthProofMode = 'valid'
const fixture = http.createServer((request, response) => {
  if (request.url === '/dsh-cline/health') {
    receivedKey = request.headers['x-dsh-cline-bridge']
    receivedChallenge = request.headers['x-dsh-cline-challenge']
    receivedProof = request.headers['x-dsh-cline-proof']
    const body = { ...health }
    if (typeof body.browserUrl === 'string' && typeof receivedChallenge === 'string') {
      body.bootstrapProof = healthProofMode === 'valid'
        ? proof(`dsh-cline-bootstrap-response\n${origin}\n${receivedChallenge}\n${body.browserUrl}\n${body.workspaceRoot}\n${body.runtimeRevision}`)
        : healthProofMode === 'unicode' ? '中'.repeat(43) : 'synthetic-invalid-response-proof'
    }
    response.writeHead(healthStatus, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  } else {
    rootRequests++
    response.writeHead(rootStatus, { 'content-type': rootStatus === 200 ? 'text/html' : 'text/plain' })
    response.end(rootStatus === 200 ? '<html>Fixture GUI</html>' : 'authentication required')
  }
})
fixture.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve))
const origin = 'http://127.0.0.1:' + fixture.address().port
const bootstrap = origin + '/?token=synthetic-launch-token'
const command = { cmd: 'never-executed-dsh', args: ['web', '--no-open'], host: '127.0.0.1', port: fixture.address().port, workspaceRoot: WORKSPACE, runtimeRevision: REVISION, bootstrapKey: KEY }
const reset = () => {
  health = { plugin: 'dsh-cline-host-services', bridge: 'up', workspaceRoot: WORKSPACE, runtimeRevision: REVISION, browserUrl: bootstrap }
  rootStatus = 401; healthStatus = 200; rootRequests = 0; receivedKey = undefined; receivedChallenge = undefined; receivedProof = undefined; healthProofMode = 'valid'
}
const managers = new Set()
function manager(options = {}) {
  const { SidecarManager, clock } = load()
  const calls = { launch: 0, interrupt: 0, browser: [] }
  const host = {
    launch: async (...args) => { calls.launch++; await options.launch?.(...args) },
    alive: () => true,
    interrupt: () => { calls.interrupt++; return options.interrupt?.() ?? true },
    ...options.host,
  }
  const browser = options.browser ?? (async (...args) => { calls.browser.push(args); return PROXY })
  const sidecar = new SidecarManager(() => ({ ...command, ...options.command }), options.preLaunch, host, browser)
  managers.add(sidecar)
  return { sidecar, clock, calls, host }
}
let passed = 0
async function test(name, work) {
  reset()
  try { await work(); passed++; console.log('PASS ' + name) }
  finally { for (const sidecar of managers) sidecar.dispose(); managers.clear() }
}

try {
  await test('root 401 is compatible when authenticated health identifies this instance', async () => {
    const { sidecar, calls } = manager()
    assert.equal(await bounded(sidecar.start(), 'authenticated bind'), origin)
    assert.equal(sidecar.status().state, 'ready')
    assert.equal(sidecar.status().url, origin, 'API base stays clean')
    assert.equal(sidecar.status().browserUrl, PROXY, 'browser uses the isolated proxy entry')
    assert.equal(rootRequests, 0, 'new startup must not depend on an unauthenticated SPA request')
    assert.equal(receivedKey, undefined, 'the bridge capability must never be sent to an untrusted listener')
    assert.match(receivedChallenge, /^[A-Za-z0-9_-]{32}$/, 'each request uses a fresh 24-byte challenge')
    assert.equal(receivedProof, proof(`dsh-cline-bootstrap\n${origin}\n${receivedChallenge}`), 'request proves the capability without transmitting it')
    assert.equal(calls.launch, 0)
    assert.equal(calls.interrupt, 0)
    assert.deepEqual(calls.browser, [[origin, bootstrap]])
    assert.equal(sidecar.lastReadyVia, 'bind')
  })

  await test('a running instance never starts a duplicate command on repeated start', async () => {
    const { sidecar, calls } = manager()
    await bounded(sidecar.start(), 'initial bind')
    await bounded(Promise.all([sidecar.start(), sidecar.start()]), 'repeated bind')
    assert.equal(calls.launch, 0)
    assert.equal(calls.browser.length, 1)
  })

  await test('wrong plugin, workspace, revision, bridge or absent bootstrap cannot become ready', async () => {
    const cases = [{ plugin: 'foreign-service' }, { workspaceRoot: WORKSPACE + '-other' }, { runtimeRevision: 'unpatched' }, { runtimeRevision: undefined }, { bridge: 'down' }, { browserUrl: undefined }]
    for (const patch of cases) {
      reset(); Object.assign(health, patch)
      const { sidecar, calls } = manager()
      assert.equal(await bounded(sidecar.probeReady(origin), 'identity probe'), false, JSON.stringify(patch))
      assert.equal(calls.browser.length, 0, 'untrusted identity must not receive a proxy capability')
    }
  })

  await test('health errors and failed browser bootstrap never pass readiness', async () => {
    healthStatus = 500
    const { sidecar } = manager()
    assert.equal(await bounded(sidecar.probeReady(origin), 'failed health'), false)
    healthStatus = 200
    const rejecting = manager({ browser: async () => { throw new Error('synthetic bootstrap refusal') } })
    assert.equal(await bounded(rejecting.sidecar.probeReady(origin), 'failed browser bootstrap'), false)
  })

  await test('a forged bootstrap proof cannot connect a browser or trigger a legacy restart', async () => {
    healthProofMode = 'wrong'
    const { sidecar, calls, clock } = manager()
    assert.equal(await bounded(sidecar.probeReady(origin), 'forged bootstrap proof'), false)
    healthProofMode = 'unicode'
    assert.equal(await bounded(sidecar.probeReady(origin), 'invalid UTF-8 proof length'), false)
    assert.equal(calls.browser.length, 0)
    sidecar.carrierUp = async () => true
    const attempt = sidecar.start(); attempt.catch(() => {})
    await flush(); await clock.advance(3000)
    assert.equal(calls.launch, 0)
    assert.equal(calls.interrupt, 0)
    assert.equal(calls.browser.length, 0)
    sidecar.stop(); await clock.advance(1000)
    await assert.rejects(bounded(attempt, 'cancel forged listener wait'), /superseded/)
  })

  await test('legacy fixtures retain the root HTML and health requirement', async () => {
    delete health.browserUrl
    const { sidecar, calls } = manager({ command: { bootstrapKey: undefined } })
    assert.equal(await bounded(sidecar.probeReady(origin), 'legacy root authentication'), false)
    rootStatus = 200
    assert.equal(await bounded(sidecar.probeReady(origin), 'legacy fixture readiness'), true)
    assert.ok(rootRequests >= 2)
    assert.equal(calls.browser.length, 0)
  })

  await test('HTTP 500 and a silent TCP listener both count as an occupied carrier', async () => {
    const { sidecar } = manager()
    rootStatus = 500
    assert.equal(await bounded(sidecar.carrierUp(origin), '500 carrier'), true)
    const silentSockets = new Set()
    const silent = net.createServer(socket => { silentSockets.add(socket); socket.once('close', () => silentSockets.delete(socket)) })
    await new Promise(resolve => silent.listen(0, '127.0.0.1', resolve))
    const silentOrigin = 'http://127.0.0.1:' + silent.address().port
    try { assert.equal(await bounded(sidecar.carrierUp(silentOrigin), 'silent TCP carrier', 1000), true) }
    finally { for (const socket of silentSockets) socket.destroy(); await new Promise(resolve => silent.close(resolve)) }
    assert.equal(await bounded(sidecar.carrierUp(silentOrigin), 'closed TCP carrier'), false)
  })

  await test('cold start shares one launch and settles after the first healthy poll', async () => {
    const { sidecar, clock, calls } = manager()
    sidecar.probeReady = async () => calls.launch > 0
    sidecar.carrierUp = async () => calls.launch > 0
    const first = sidecar.start(), second = sidecar.start()
    assert.equal(first, second, 'concurrent callers share the startup promise')
    assert.equal(await drive(first, clock), origin)
    assert.equal(calls.launch, 1)
    assert.equal(calls.interrupt, 0)
    assert.equal(sidecar.lastReadyVia, 'launch')
  })

  await test('an occupied foreign listener is observed without launch or interruption', async () => {
    health.workspaceRoot = WORKSPACE + '-foreign'; delete health.browserUrl
    const { sidecar, clock, calls } = manager()
    sidecar.carrierUp = async () => true
    const attempt = sidecar.start(); attempt.catch(() => {})
    await flush(); await clock.advance(35_000)
    assert.equal(calls.launch, 0)
    assert.equal(calls.interrupt, 0)
    assert.equal(sidecar.status().state, 'starting')
    sidecar.stop(); await clock.advance(1000)
    await assert.rejects(bounded(attempt, 'cancel foreign listener wait'), /superseded/)
    assert.equal(sidecar.status().state, 'stopped')
  })

  await test('an identified old plugin is interrupted once and relaunched only after TCP closes', async () => {
    delete health.browserUrl
    const trace = []
    let listening = true
    const result = manager({
      interrupt: () => { trace.push('interrupt'); listening = false; return true },
      launch: async () => { assert.equal(listening, false, 'the old listener must have closed'); trace.push('launch'); health.browserUrl = bootstrap; listening = true },
    })
    result.sidecar.carrierUp = async () => { trace.push(listening ? 'tcp-up' : 'tcp-down'); return listening }
    await drive(result.sidecar.start(), result.clock)
    assert.equal(result.calls.interrupt, 1)
    assert.equal(result.calls.launch, 1)
    assert.ok(trace.indexOf('tcp-down') > trace.indexOf('interrupt'))
    assert.ok(trace.indexOf('launch') > trace.indexOf('tcp-down'))
    assert.equal(result.sidecar.status().browserUrl, PROXY)
    await result.sidecar.start()
    assert.equal(result.calls.interrupt, 1)
    assert.equal(result.calls.launch, 1)
  })

  await test('cancelling runtime preparation prevents any later command launch', async () => {
    const preparation = deferred()
    const { sidecar, calls } = manager({ preLaunch: () => preparation.promise })
    const attempt = sidecar.start(); attempt.catch(() => {})
    sidecar.stop(); preparation.resolve()
    await assert.rejects(bounded(attempt, 'cancel preparation'), /superseded/)
    assert.equal(calls.launch, 0)
    assert.equal(sidecar.status().state, 'stopped')
  })

  await test('cancelling an in-flight terminal launch aborts its signal and cannot become ready', async () => {
    const launching = deferred()
    let signal
    const { sidecar, calls } = manager({ launch: (_command, value) => { signal = value; return launching.promise } })
    sidecar.probeReady = async () => false
    sidecar.carrierUp = async () => false
    const attempt = sidecar.start(); attempt.catch(() => {})
    await flush()
    assert.equal(calls.launch, 1)
    sidecar.stop(); assert.equal(signal.aborted, true); launching.resolve()
    await assert.rejects(bounded(attempt, 'cancel terminal launch'), /superseded/)
    assert.equal(sidecar.status().state, 'stopped')
  })

  await test('late browser bootstrap cannot revive a stopped generation', async () => {
    const browser = deferred(), entered = deferred()
    const { sidecar } = manager({ browser: async () => { entered.resolve(); return browser.promise } })
    const attempt = sidecar.start(); attempt.catch(() => {})
    await bounded(entered.promise, 'browser bootstrap entry')
    sidecar.stop(); browser.resolve(PROXY)
    await assert.rejects(bounded(attempt, 'cancel browser bootstrap'), /superseded/)
    assert.equal(sidecar.status().state, 'stopped')
    assert.equal(sidecar.status().url, undefined)
    assert.equal(sidecar.status().browserUrl, undefined)
  })

  await test('watchdog leaves an occupied 401/500/unready service alone', async () => {
    const { sidecar, calls, clock } = manager()
    await bounded(sidecar.start(), 'watchdog initial bind')
    sidecar.probeReady = async () => false
    sidecar.carrierUp = async () => true
    for (let i = 0; i < 3; i++) await clock.advance(5000)
    assert.equal(calls.launch, 0)
    assert.equal(calls.interrupt, 0)
    assert.equal(sidecar.status().state, 'ready')
  })

  await test('watchdog recovers after two closed-carrier checks without duplicate commands', async () => {
    const { sidecar, calls, clock } = manager()
    await bounded(sidecar.start(), 'watchdog recovery initial bind')
    sidecar.probeReady = async () => calls.launch > 0
    sidecar.carrierUp = async () => calls.launch > 0
    await clock.advance(5000)
    assert.equal(calls.launch, 0, 'one missed carrier is tolerated')
    await clock.advance(5000)
    assert.equal(calls.launch, 1, 'two closed carriers start one recovery')
    await clock.advance(1000)
    assert.equal(sidecar.status().state, 'ready')
    assert.equal(calls.interrupt, 0)
    sidecar.dispose()
    await clock.advance(20_000)
    assert.equal(calls.launch, 1, 'disposed watchdog cannot relaunch')
  })
} finally {
  for (const sidecar of managers) sidecar.dispose()
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => fixture.close(resolve))
}
console.log('Sidecar startup regressions: ' + passed + ' scenarios passed (virtual clock and local HTTP/TCP only; no DSH).')
