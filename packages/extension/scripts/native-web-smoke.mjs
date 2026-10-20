/** One bounded real Web boot in an isolated fixture; no model calls or VS Code. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { build } from 'esbuild'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import http from 'node:http'
import { createHash, randomBytes } from 'node:crypto'

const runtime = resolve(process.argv[2] ?? '')
const fixtureParent = resolve(process.argv[3] ?? '')
assert.ok(process.argv[2] && process.argv[3], 'Usage: node native-web-smoke.mjs <verified runtime> <fixture parent>')
const root = fileURLToPath(new URL('..', import.meta.url))
const fixture = await mkdtemp(join(fixtureParent, 'native-web-smoke-'))
const workspace = join(fixture, 'workspace')
const home = join(fixture, 'home')
await mkdir(workspace)
await mkdir(home)

async function load(file) {
  const result = await build({ entryPoints: [join(root, 'src', file)], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
}
const { BridgeServer } = await load('bridge.ts')
const { SidecarManager } = await load('sidecar.ts')
const { WebProxy } = await load('web-proxy.ts')
const bridge = new BridgeServer()
bridge.handle('vscode.host.ping', async () => ({ pong: true, extensionVersion: '4.3.2-smoke' }))
const bridgeUrl = await bridge.start()
const proxy = new WebProxy()
let child, manager, output = '', launchCount = 0, assertions = 0
const check = (condition, description) => { assert.ok(condition, description); assertions++ }
const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(name)))
const reserved = createServer()
await new Promise((yes, no) => { reserved.once('error', no); reserved.listen(0, '127.0.0.1', yes) })
const port = reserved.address().port
await new Promise(yes => reserved.close(yes))
const origin = 'http://127.0.0.1:' + port
const savedHome = process.env.DSH_CLINE_HOME
process.env.DSH_CLINE_HOME = home
try {
  // The product installer writes only this freshly-created fixture home.
  const { ensurePluginInstalled } = await load('plugin-install.ts')
  await ensurePluginInstalled(join(root, 'dist/vendor/host-services'))
  const command = { cmd: process.execPath, args: [join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), 'web', '--no-open', '--host', '127.0.0.1', '--port', String(port)],
    host: '127.0.0.1', port, workspaceRoot: workspace, runtimeRevision: '0.2.1-rc.2-r1', bootstrapKey: bridgeUrl }
  manager = new SidecarManager(() => command, undefined, {
    launch(cmd) {
      launchCount++
      child = spawn(cmd.cmd, cmd.args, { cwd: workspace, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: {
        ...env, DSH_HOME: home, DSH_AGENTS_HOME: join(fixture, 'agents'), DSH_CLINE_BRIDGE: bridgeUrl,
        DSH_CLINE_RUNTIME_REVISION: command.runtimeRevision, DSH_TELEMETRY_DISABLED: '1', SSH_CONNECTION: '', SSH_TTY: '',
      } })
      const append = chunk => { output = (output + chunk).slice(-200_000) }
      child.stdout.on('data', append); child.stderr.on('data', append)
      child.once('error', error => { output += '\nSpawn failed: ' + error.code })
    }, alive: () => child !== undefined && child.exitCode === null,
  }, (base, auth) => proxy.connect(base, auth))
  manager.on('change', ({ state }) => console.log('Native Web smoke state: ' + state))
  let timer
  try { await Promise.race([manager.start(), new Promise((_, no) => { timer = setTimeout(() => no(new Error('Native Web startup exceeded 180s')), 180_000) })]) }
  finally { clearTimeout(timer) }
  const status = manager.status()
  check(launchCount === 1 && status.state === 'ready', 'one real boot reached ready')
  check(status.url === origin && !status.url.includes('token='), 'public service URL remains clean')
  check(!output.includes('opening the default browser'), '--no-open suppresses browser launch')
  check((await fetch(origin, { signal: AbortSignal.timeout(5000) })).status === 401, 'native root still requires authentication')
  const health = await (await fetch(origin + '/dsh-cline/health')).json()
  check(health.bridge === 'up' && !health.browserUrl && !health.bootstrapProof, 'ordinary health never reveals credentials')
  const page = await fetch(status.browserUrl, { signal: AbortSignal.timeout(5000) })
  const html = await page.text()
  check(page.status === 200 && /<html/i.test(html), 'iframe entrance serves real authenticated native HTML')
  check(page.headers.get('set-cookie') === null && !status.browserUrl.includes('token='), 'native cookie/token never enters the browser')
  const assets = [...html.matchAll(/(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g)].map(match => match[1])
  check(assets.length > 0, 'native page declares browser assets')
  for (const asset of assets.slice(0, 2)) {
    const address = new URL(asset, status.browserUrl)
    check(address.href.startsWith(status.browserUrl) && (await fetch(address)).status === 200, 'native asset stays under protected mount')
  }
  const browserHealth = await (await fetch(new URL('dsh-cline/health', status.browserUrl))).json()
  check(browserHealth.bridge === 'up' && !browserHealth.browserUrl, 'client relative gateway works through protected mount')
  const rpc = await fetch(new URL('api/settings/describe', status.browserUrl), { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'dsh-cline-native-smoke', method: 'settings/describe', payload: { args: {} } }) })
  const envelope = await rpc.json()
  check(rpc.status === 200 && envelope.result?.ok === true && Array.isArray(envelope.result.value?.namespaces), 'native settings API authenticates through proxy')
  const socketKey = randomBytes(16).toString('base64')
  const ws = new URL('api/remote.mux', status.browserUrl)
  const accepted = await new Promise((yes, no) => {
    const request = http.get(ws, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': socketKey, origin: ws.origin } })
    request.once('upgrade', (response, socket) => {
      const valid = response.statusCode === 101 && response.headers['sec-websocket-accept'] === createHash('sha1').update(socketKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
      socket.destroy(); yes(valid)
    })
    request.once('response', response => { response.resume(); yes(false) })
    request.once('error', no)
    request.setTimeout(5000, () => request.destroy(new Error('Native WebSocket timeout')))
  })
  check(accepted, 'native WebSocket accepts proxy cookie and mapped Origin')
  console.log(JSON.stringify({ assertions, passed: true, runtime: '0.2.1-rc.2-r1', serviceBoots: launchCount, fixture,
    scope: 'real native HTTP/SPA/assets/health/settings/WebSocket; no VS Code UI or model calls' }))
} catch (error) {
  console.error(JSON.stringify({ launchCount, childExit: child?.exitCode, sidecarState: manager?.status().state }))
  const redacted = output.replace(/([?&]token=)[^\s"']+/g, '$1<redacted>').replaceAll(bridgeUrl, '<bridge>')
  console.error(redacted.slice(-8000))
  throw error
} finally {
  manager?.dispose()
  await proxy.dispose()
  await bridge.dispose()
  if (child && child.exitCode === null) {
    const exited = new Promise(yes => child.once('exit', yes))
    child.kill()
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    await exited; clearTimeout(timer)
  }
  if (savedHome === undefined) delete process.env.DSH_CLINE_HOME
  else process.env.DSH_CLINE_HOME = savedHome
}
