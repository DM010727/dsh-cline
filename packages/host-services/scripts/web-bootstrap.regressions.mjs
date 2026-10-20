/** Synthetic requests and a private temporary bridge locator; no DSH/user profile/network. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createHmac } from 'node:crypto'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
let assertions = 0
const check = (value, message) => { assert.ok(value, message); assertions++ }
const stubs = {
  './diff-mirror.js': 'export const registerDiffMirror=()=>{}',
  './vscode-tool.js': 'export const registerVscodeTool=()=>{}',
  './mcp-loader.js': 'export const loadMcpServers=async()=>0',
  './checkpoint.js': 'export const registerCheckpoint=()=>{}',
  './web-gateway.js': 'export const registerWebGateway=()=>{}',
  './task-injector.js': 'export const registerTaskInjector=()=>{}',
  '@deepseek-ai/schemastery': 'const node=()=>({default(){return this},volatile(){return this}});export default {object:node,union:node,string:node,const:node}',
}
async function load(file) {
  const compiled = await build({ entryPoints: [join(root, 'src', file)], bundle: true, write: false, format: 'esm', platform: 'node', target: 'node22', logLevel: 'silent',
    plugins: [{ name: 'unrelated-plugin-hooks', setup(plugin) {
      plugin.onResolve({ filter: /.*/ }, args => Object.hasOwn(stubs, args.path) ? { path: args.path, namespace: 'fixture-stub' } : undefined)
      plugin.onLoad({ filter: /.*/, namespace: 'fixture-stub' }, args => ({ contents: stubs[args.path], loader: 'js' }))
    } }],
  })
  return import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'))
}
const { createHealthHandler } = await load('web-bootstrap.ts')
const keyA = 'http://127.0.0.1:31111/fixture_bridge_A', keyB = 'http://127.0.0.1:32222/fixture_bridge_B'
const origin = 'http://127.0.0.1:52341', challenge = Buffer.alloc(24, 7).toString('base64url')
const hmac = (key, text) => createHmac('sha256', key).update(text, 'utf8').digest('base64url')
const signed = (key = keyA, nonce = challenge, authority = origin) => ({ 'x-dsh-cline-challenge': nonce, 'x-dsh-cline-proof': hmac(key, `dsh-cline-bootstrap\n${authority}\n${nonce}`) })
const browserSecret = 'fixture_native_browser_token'
const browserUrl = 'http://127.0.0.1:52341/?token=' + browserSecret
const identity = { plugin: 'dsh-cline-host-services', workspaceRoot: '/fixture', instanceId: 'fixture-instance', runtimeRevision: 'fixture-revision' }
const pong = { pong: true, extensionVersion: 'fixture' }
const req = headers => ({ method: 'GET', headers: { host: '127.0.0.1:52341', ...headers }, socket: { remoteAddress: '127.0.0.1', localPort: 52341 } })
function response() {
  return { status: 0, headers: {}, text: '',
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers) }, setHeader(key, value) { this.headers[key] = value },
    end(text = '') { this.text = text }, json() { return JSON.parse(this.text) } }
}
async function invoke(handler, headers) { const res = response(); await handler(req(headers), res); return res }
let connectionReads = 0, pingCalls = 0
const connection = { authenticatedUrl(base) { assert.equal(base, 'http://127.0.0.1:52341/'); return browserUrl } }
const options = { identity: () => identity, bridgeUrl: () => keyA, service: { async ping() { pingCalls++; return pong } }, connection: () => { connectionReads++; return connection } }
const handler = createHealthHandler(options)
const publicHealth = await invoke(handler)
check(publicHealth.status === 200 && publicHealth.json().plugin === identity.plugin && publicHealth.json().bridge === 'up' && publicHealth.json().bootstrapProtocol === 1, 'ordinary health keeps public identity and bootstrap protocol')
check(!publicHealth.text.includes(browserSecret) && !publicHealth.text.includes(keyA) && !Object.hasOwn(publicHealth.json(), 'browserUrl') && connectionReads === 0, 'ordinary health never asks for or leaks native authentication')
for (const headers of [signed(keyB), { ...signed(), 'x-dsh-cline-proof': 'Z'.repeat(43) }, { ...signed(), 'x-dsh-cline-proof': [signed()['x-dsh-cline-proof']] }, { 'x-dsh-cline-bridge': keyA }]) {
  const reply = await invoke(handler, headers)
  check(reply.status === 200 && !Object.hasOwn(reply.json(), 'browserUrl') && !reply.text.includes(browserSecret), 'wrong or duplicate capability cannot obtain browser URL')
}
const authorized = await invoke(handler, signed())
check(authorized.status === 200 && authorized.json().browserUrl === browserUrl && connectionReads === 1 && pingCalls > 0, 'valid current HMAC proof receives the native URL only after bridge ping')
const expectedResponseProof = hmac(keyA, `dsh-cline-bootstrap-response\n${origin}\n${challenge}\n${browserUrl}\n${identity.workspaceRoot}\n${identity.runtimeRevision}`)
check(authorized.json().bootstrapProof === expectedResponseProof, 'response proof binds the origin, challenge, native URL, workspace and runtime revision')
const nullRevision = await invoke(createHealthHandler({ ...options, identity: () => ({ ...identity, runtimeRevision: null }) }), signed())
check(nullRevision.json().runtimeRevision === null && nullRevision.json().bootstrapProof === hmac(keyA, `dsh-cline-bootstrap-response\n${origin}\n${challenge}\n${browserUrl}\n${identity.workspaceRoot}\nnull`), 'missing runtime revision is signed as the literal string null')
check(authorized.headers['cache-control'] === 'no-store' && publicHealth.headers['cache-control'] === 'no-store', 'public and protected replies disable caching')
for (const headers of [signed(keyA, challenge, 'http://localhost:52341'), { ...signed(), 'x-dsh-cline-challenge': 'B'.repeat(32) }, signed(keyA, 'short')]) {
  check(!Object.hasOwn((await invoke(handler, headers)).json(), 'browserUrl'), 'invalid origin binding, nonce binding or nonce length cannot bootstrap')
}
const invalidBridge = await invoke(createHealthHandler({ ...options, bridgeUrl: () => keyA.replace('http:', 'https:') }), signed(keyA.replace('http:', 'https:')))
check(invalidBridge.status === 200 && !Object.hasOwn(invalidBridge.json(), 'browserUrl'), 'an invalid active bridge URL cannot authorize bootstrap')
const noConnection = await invoke(createHealthHandler({ ...options, connection: () => undefined }), signed())
check(noConnection.status === 503 && noConnection.json().bridge === 'up' && !noConnection.text.includes(browserSecret), 'authorized request waits cleanly for optional connection service')
const connectionError = await invoke(createHealthHandler({ ...options, connection: () => ({ authenticatedUrl() { throw new Error(browserUrl + keyA) } }) }), signed())
check(connectionError.status === 503 && !connectionError.text.includes(browserSecret) && !connectionError.text.includes(keyA), 'native errors cannot leak authentication material')
const badNativeUrl = await invoke(createHealthHandler({ ...options, connection: () => ({ authenticatedUrl: () => 'https://foreign.invalid/?token=' + browserSecret }) }), signed())
check(badNativeUrl.status === 503 && !badNativeUrl.text.includes(browserSecret), 'invalid native authority is rejected without reflecting its token')
const noBridge = await invoke(createHealthHandler({ ...options, service: undefined }), signed())
check(noBridge.status === 503 && noBridge.json().bridge === 'down' && !Object.hasOwn(noBridge.json(), 'browserUrl'), 'dormant bridge never provides a native URL')
const downBridge = await invoke(createHealthHandler({ ...options, service: { async ping() { throw new Error(keyA + browserUrl) } } }), signed())
check(downBridge.status === 502 && !downBridge.text.includes(keyA) && !downBridge.text.includes(browserSecret), 'failed ping errors are sanitized on public health')
for (const headers of [{ origin: 'https://attacker.invalid' }, { host: 'attacker.invalid:52341' }, { 'sec-fetch-site': 'cross-site' }]) {
  const blocked = await invoke(handler, { ...signed(), ...headers })
  check(blocked.status === 403 && !blocked.text.includes(browserSecret), 'request boundary rejects hostile requests even with capability')
}

const prior = { home: process.env.DSH_HOME, file: process.env.DSH_CLINE_BRIDGE_FILE, fetch: globalThis.fetch }
const fixture = await mkdtemp(join(tmpdir(), 'dsh-cline-bootstrap-'))
try {
  const home = join(fixture, 'home'), bridgeFile = join(home, 'bridge-current.json')
  await mkdir(home)
  process.env.DSH_HOME = home; process.env.DSH_CLINE_BRIDGE_FILE = bridgeFile
  await writeFile(bridgeFile, JSON.stringify({ url: keyA }))
  const pingUrls = [], logLines = [], routes = new Map()
  globalThis.fetch = async url => { pingUrls.push(url); return { ok: true, json: async () => ({ ok: true, result: pong }) } }
  const { apply, inject } = await load('index.ts')
  const services = { webServer: { register(route) { routes.set(route.path, route.handler); return () => {} } }, connection }
  const ctx = { fiber: {}, settings: { configure: () => () => {} }, inject(_names, callback) { callback(this) }, effect: callback => callback(), get: name => services[name], provide() {}, logger: { info: line => logLines.push(line) } }
  await apply(ctx, { bridgeUrl: 'http://127.0.0.1:33333/fixture_fallback', checkpointAuto: { get: () => 'off' } })
  check(!inject.includes('connection'), 'optional connection does not add an injection cycle')
  const actual = routes.get('/dsh-cline/health')
  const first = await invoke(actual, signed())
  check(first.status === 200 && first.json().browserUrl === browserUrl && pingUrls.at(-1) === keyA, 'actual plugin health reads the workspace bridge locator')
  await writeFile(bridgeFile, JSON.stringify({ url: keyB }))
  const stale = await invoke(actual, signed())
  const fresh = await invoke(actual, signed(keyB))
  check(stale.status === 200 && !Object.hasOwn(stale.json(), 'browserUrl') && !stale.text.includes(browserSecret), 'extension reload revokes the old bridge capability immediately')
  check(fresh.status === 200 && fresh.json().browserUrl === browserUrl && pingUrls.at(-1) === keyB, 'extension reload uses the replacement bridge capability without DSH restart')
  check(!logLines.join('\n').includes(keyA) && !logLines.join('\n').includes(browserSecret), 'plugin log does not record capability or native URL')
} finally {
  globalThis.fetch = prior.fetch
  for (const [key, value] of [['DSH_HOME', prior.home], ['DSH_CLINE_BRIDGE_FILE', prior.file]]) value === undefined ? delete process.env[key] : process.env[key] = value
  await rm(fixture, { recursive: true, force: true })
}
console.log(JSON.stringify({ assertions, passed: true, dshServersStarted: 0, userProfilesRead: false }))
