/** Offline audit regressions: no DSH server, VS Code window, or user profile. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { build } from 'esbuild'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const execFileAsync = promisify(execFile)
const originalCwd = process.cwd()
const originalHome = process.env.DSH_HOME
const originalMcp = process.env.DSH_CLINE_MCP
const fixture = await mkdtemp(join(tmpdir(), 'dsh-cline-audit-'))
const workspace = join(fixture, 'workspace')
await mkdir(workspace)
process.env.DSH_HOME = join(fixture, 'home')
process.env.DSH_CLINE_MCP = join(fixture, 'mcp.json')
process.chdir(workspace)
let passed = 0

const stubs = {
  '@deepseek-ai/dsh-llm': 'export const createUserMessage = value => value',
  '@deepseek-ai/dsh-session': 'export const SessionId = value => value',
  '@deepseek-ai/dsh-agent': 'export const installModelSelection = () => () => {}',
  '@deepseek-ai/dsh-credentials': 'export const credentialRef = value => value',
  '@deepseek-ai/dsh-mcp-client': 'export const name = "mcp-client"; export function apply() {}',
  // Deliberately does not expose the removed installSettingsSection API.
  '@deepseek-ai/schemastery': `
    const node = fields => ({...fields, default(value) { this.fallback=value;return this }, volatile() { this.live=true;return this } });
    export default { object: shape=>node({shape}), string:()=>node({}), const:value=>node({value}), union:values=>node({values}) };
  `,
}
async function load(file) {
  const compiled = await build({
    entryPoints: [join(packageRoot, 'src', file)], bundle: true, write: false,
    platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
    plugins: [{ name: 'offline-dsh-contracts', setup(plugin) {
      plugin.onResolve({ filter: /^@deepseek-ai\// }, ({ path }) => {
        if (!Object.hasOwn(stubs, path)) throw new Error('Unreviewed DSH runtime import: ' + path)
        return { path, namespace: 'dsh-contract' }
      })
      plugin.onLoad({ filter: /.*/, namespace: 'dsh-contract' }, ({ path }) => ({ contents: stubs[path], loader: 'js' }))
    } }],
  })
  return import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'))
}
async function check(name, test) {
  await test()
  passed++
  process.stdout.write('PASS ' + name + '\n')
}
function request({ method = 'POST', body = {}, headers = {}, remoteAddress = '127.0.0.1' } = {}) {
  const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))])
  req.method = method
  req.url = '/'
  req.headers = { host: '127.0.0.1:52341', 'content-type': 'application/json', ...headers }
  req.socket = { remoteAddress, localPort: 52341 }
  return req
}
function response() {
  return {
    status: 0, headers: {}, text: '',
    setHeader(key, value) { this.headers[key] = value },
    writeHead(status, headers) { this.status = status; Object.assign(this.headers, headers); return this },
    end(text = '') { this.text = text; return this },
    json() { return JSON.parse(this.text) },
  }
}
function context(services = {}) {
  const routes = new Map()
  const hooks = new Map()
  const tools = new Map()
  const carrier = { register(route) { routes.set(route.path, route.handler); return () => {} } }
  return {
    routes, hooks, tools, carrier, fiber: {},
    get(name) { return name === 'webServer' ? carrier : services[name] },
    effect(factory) { return factory() },
    inject(_names, callback) { callback(this) },
    on(event, callback) { hooks.set(event, callback); return () => {} },
    provide() {},
    settings: { configure() { return () => {} } },
    systemPrompt: { section() { return () => {} } },
    logger: { info() {}, warn() {}, error() {} },
    tools: { register(tool) { tools.set(tool.name, tool); return () => {} } },
    toolDefinitions: tools,
  }
}
async function invoke(ctx, path, options = {}) {
  const res = response()
  await ctx.routes.get(path)(request(options), res)
  return res
}

try {
  const guard = await load('request-guard.ts')
  await check('same-origin browser and local Node requests remain valid', () => {
    assert.equal(guard.guardRequest(request({ headers: { origin: 'http://127.0.0.1:52341', 'sec-fetch-site': 'same-origin' } }), response(), ['POST'], true), true)
    assert.equal(guard.guardRequest(request(), response(), ['POST'], true), true)
  })
  await check('reject cross-origin, null Origin, DNS rebinding, remote and wrong port', () => {
    for (const options of [
      { headers: { origin: 'https://evil.example' } }, { headers: { origin: 'null' } },
      { headers: { host: 'evil.example:52341' } }, { remoteAddress: '192.168.1.20' },
      { headers: { host: '127.0.0.1:52342' } }, { headers: { 'sec-fetch-site': 'cross-site' } },
    ]) {
      const res = response()
      assert.equal(guard.guardRequest(request(options), res, ['POST']), false)
      assert.equal(res.status, 403)
    }
  })
  await check('reject simple form writes and unlisted HTTP methods', () => {
    const form = response()
    assert.equal(guard.guardRequest(request({ headers: { 'content-type': 'text/plain' } }), form, ['POST'], true), false)
    assert.equal(form.status, 415)
    const badMethod = response()
    assert.equal(guard.guardRequest(request({ method: 'DELETE' }), badMethod, ['GET', 'POST']), false)
    assert.equal(badMethod.status, 405)
  })
  await check('body parsing rejects null, arrays, invalid JSON and oversized content', async () => {
    for (const body of ['null', '[]', '{', '"' + 'x'.repeat(65536) + '"']) {
      await assert.rejects(guard.readJsonObject(request({ body })))
    }
    assert.deepEqual(await guard.readJsonObject(request({ body: { good: true } })), { good: true })
  })

  const mcp = await load('mcp-loader.ts')
  await check('stdio MCP command survives validated plugin mounting', async () => {
    await writeFile(process.env.DSH_CLINE_MCP, JSON.stringify({ servers: { demo: { transport: 'stdio', command: 'node', args: ['server.mjs'] } } }))
    const mounted = []
    const ctx = context()
    ctx.plugin = (_module, config) => mounted.push(config)
    assert.equal(await mcp.loadMcpServers(ctx), 1)
    assert.equal(mounted[0].command, 'node')
    assert.deepEqual(mounted[0].args, ['server.mjs'])
  })
  await check('MCP validation rejects malformed and disabled invalid entries', () => {
    for (const entry of [
      [], { transport: 'stdio', command: ' ' }, { transport: 'stdio', command: 'node', args: ['good', 1] },
      { transport: 'stdio', command: 'node', env: [] }, { transport: 'stdio', command: 'node', toolCallTimeoutMs: -1 },
      { transport: 'streamable-http', url: 'file:///etc/passwd' },
      { transport: 'stdio', command: 'node', disabled: true, reconnect: { initialDelayMs: 5, maxDelayMs: 1 } },
    ]) assert.throws(() => mcp.validateMcpDocument({ servers: { demo: entry } }))
    assert.throws(() => mcp.validateMcpDocument(null))
  })
  await check('MCP prototype names stay own serialized fields', () => {
    const result = mcp.validateMcpDocument(JSON.parse('{"servers":{"__proto__":{"transport":"stdio","command":"node"}}}'))
    assert.equal(Object.getPrototypeOf(result), null)
    assert.equal(JSON.parse(JSON.stringify(result)).__proto__.command, 'node')
  })

  const gateway = await load('web-gateway.ts')
  const gatewayContext = context()
  gateway.registerWebGateway(gatewayContext, gatewayContext.carrier, undefined)
  await check('MCP compare-and-swap refuses stale and missing revisions', async () => {
    const initial = (await invoke(gatewayContext, '/dsh-cline/mcp', { method: 'GET' })).json()
    assert.match(initial.revision, /^[a-f0-9]{64}$/)
    assert.equal((await invoke(gatewayContext, '/dsh-cline/mcp', { body: { servers: {} } })).status, 428)
    assert.equal((await invoke(gatewayContext, '/dsh-cline/mcp', { body: { servers: {}, expectedRevision: 'stale' } })).status, 409)
    const saved = await invoke(gatewayContext, '/dsh-cline/mcp', { body: { servers: {}, expectedRevision: initial.revision } })
    assert.equal(saved.status, 200)
    assert.notEqual(saved.json().revision, initial.revision)
    assert.deepEqual(JSON.parse(await readFile(process.env.DSH_CLINE_MCP, 'utf8')), { servers: {} })
  })
  await check('all gateway routes reject cross-site requests before their effects', async () => {
    for (const route of gatewayContext.routes.keys()) {
      const res = await invoke(gatewayContext, route, { headers: { origin: 'https://evil.example' } })
      assert.equal(res.status, 403, route)
    }
  })

  const tasks = await load('task-injector.ts')
  let created = 0
  let delivered = 0
  let flushed
  const session = { header: { cwd: workspace } }
  const agents = {
    get(id) { return id === 'foreign' ? { session: { header: { cwd: fixture } }, followup() { throw new Error('must not deliver') } } : undefined },
    async create() { created++; return { agent: { session, followup() { delivered++ } }, async dispose() {} } },
  }
  const taskContext = context({ agents, sessions: { async flush(value) { flushed = value } }, agentDefaultModel: { currentSelection() { return { provider: 'deepseek', model: 'deepseek-chat' } } } })
  tasks.registerTaskInjector(taskContext, taskContext.carrier)
  await check('selection without an explicit session creates one and flushes agent.session', async () => {
    const result = await invoke(taskContext, '/dsh-cline/task', { body: { content: 'explain', cwd: workspace } })
    assert.equal(result.status, 200)
    assert.equal(result.json().created, true)
    assert.equal(created, 1)
    assert.equal(delivered, 1)
    assert.equal(flushed, session)
    assert.equal(taskContext.hooks.size, 0)
  })
  await check('selection rejects unknown sessions and foreign workspace/cwd', async () => {
    for (const body of [{ sessionId: 'foreign' }, { sessionId: 'missing' }, { cwd: fixture }]) {
      assert.equal((await invoke(taskContext, '/dsh-cline/task', { body: { content: 'x', ...body } })).status, 409)
    }
    assert.equal(created, 1)
    assert.equal(delivered, 1)
  })

  const mirror = await load('diff-mirror.ts')
  const nested = join(workspace, 'nested')
  await mkdir(nested)
  await writeFile(join(nested, 'sample.txt'), 'before')
  const mirrorContext = context({ workingDirectory: { get() { return nested } } })
  const previews = []
  mirror.registerDiffMirror(mirrorContext, { async call(_service, _method, args) { previews.push(args[0]) } })
  const mirrorHook = mirrorContext.hooks.get('tools/execute')
  await check('diff snapshots session cwd synchronously after approval and emits absolute paths', () => {
    assert.equal(typeof mirrorHook, 'function')
    assert.equal(mirrorContext.hooks.has('tools/pre-execute'), false)
    let proceeded = false
    mirrorHook({ name: 'write', arguments: { file_path: 'sample.txt', content: 'after' }, agent: { session } }, () => { proceeded = true })
    assert.equal(proceeded, true)
    assert.equal(previews[0].original, 'before')
    assert.equal(previews[0].args.file_path, join(nested, 'sample.txt'))
  })
  await check('diff skips outside workspace, binary and oversized files', async () => {
    await writeFile(join(workspace, 'binary.bin'), Buffer.from([0, 1, 2]))
    await writeFile(join(workspace, 'large.txt'), Buffer.alloc(4 * 1024 * 1024 + 1, 97))
    for (const file_path of [join(fixture, 'private.txt'), join(workspace, 'binary.bin'), join(workspace, 'large.txt')]) {
      mirrorHook({ name: 'write', arguments: { file_path, content: 'after' } }, () => {})
    }
    assert.equal(previews.length, 1)
  })
  await check('symlinks cannot redirect a workspace preview to foreign files', async () => {
    const external = join(fixture, 'foreign')
    await mkdir(external)
    await writeFile(join(external, 'secret.txt'), 'private')
    await symlink(external, join(workspace, 'escaped'), process.platform === 'win32' ? 'junction' : 'dir')
    mirrorHook({ name: 'write', arguments: { file_path: join(workspace, 'escaped', 'secret.txt'), content: 'after' } }, () => {})
    assert.equal(previews.length, 1)
  })

  const checkpoints = await load('checkpoint.ts')
  const trackedFile = join(workspace, 'snapshot.txt')
  await writeFile(trackedFile, 'one')
  await mkdir(join(workspace, 'node_modules'))
  const excluded = join(workspace, 'node_modules', 'keep.txt')
  await writeFile(excluded, 'ignored')
  await execFileAsync('git', ['init', '--quiet', workspace], { windowsHide: true })
  await execFileAsync('git', ['-C', workspace, 'add', '--', 'snapshot.txt'], { windowsHide: true })
  const userIndex = await readFile(join(workspace, '.git', 'index'))
  const checkpointStore = new checkpoints.CheckpointStore(workspace)
  await check('checkpoint exclusions are placed in the real Git info directory', async () => {
    const first = await checkpointStore.snapshot('first\u001finvalid-label')
    assert.match(first, /^[a-f0-9]+$/)
    const entries = await checkpointStore.list(10)
    assert.equal(entries[0].label, 'first invalid-label')
    assert.equal(Number.isFinite(entries[0].time), true)
  })
  await check('restore recovers a snapshot, preserves excluded files and saves a recovery checkpoint', async () => {
    const first = (await checkpointStore.list(10))[0].id
    await writeFile(trackedFile, 'two')
    await checkpointStore.snapshot('second')
    await writeFile(trackedFile, 'dirty')
    await writeFile(join(workspace, 'after.txt'), 'new')
    await checkpointStore.restore(first)
    assert.equal(await readFile(trackedFile, 'utf8'), 'one')
    assert.equal(existsSync(join(workspace, 'after.txt')), false)
    assert.equal(await readFile(excluded, 'utf8'), 'ignored')
    const backup = (await checkpointStore.list(10)).find(item => item.label.startsWith('before restore'))
    assert.ok(backup)
    await checkpointStore.restore(backup.id)
    assert.equal(await readFile(trackedFile, 'utf8'), 'dirty')
    assert.equal(await readFile(join(workspace, 'after.txt'), 'utf8'), 'new')
  })
  await check('restore rejects Git options/revisions without mutating files', async () => {
    for (const id of ['--empty', 'HEAD', '../outside', 'abc;echo', 'deadbee']) await assert.rejects(checkpointStore.restore(id))
    assert.equal(await readFile(trackedFile, 'utf8'), 'dirty')
  })
  await check('empty directories receive a usable initial checkpoint', async () => {
    const empty = join(workspace, 'empty')
    await mkdir(empty)
    const store = new checkpoints.CheckpointStore(empty)
    const id = await store.snapshot('empty')
    assert.ok(id)
    await writeFile(join(empty, 'new.txt'), 'new')
    await store.restore(id)
    assert.equal(existsSync(join(empty, 'new.txt')), false)
  })
  await check('checkpoint snapshots and restoration preserve the user repository index', async () => {
    assert.deepEqual(await readFile(join(workspace, '.git', 'index')), userIndex)
  })
  await check('mutating tool bodies are serialized even with auto checkpoints off', async () => {
    const ctx = context()
    checkpoints.registerCheckpoint(ctx, () => 'off')
    const hook = ctx.hooks.get('tools/execute')
    let active = 0
    let maximum = 0
    const next = async () => { active++; maximum = Math.max(active, maximum); await new Promise(resolve => setTimeout(resolve, 5)); active--; return {} }
    await Promise.all([1, 2, 3].map(() => hook({ name: 'write', signal: new AbortController().signal }, next)))
    assert.equal(maximum, 1)
  })

  const vscodeTool = await load('vscode-tool.ts')
  await check('editor mutations are exclusive and invalid line numbers are rejected', async () => {
    const ctx = context()
    vscodeTool.registerVscodeTool(ctx, { async call() { return {} } })
    const tool = ctx.toolDefinitions.get('vscode')
    assert.equal(tool.isConcurrencySafe({ action: 'apply_selection' }), false)
    assert.equal(tool.isConcurrencySafe({ action: 'active_editor' }), true)
    await assert.rejects(tool.execute({ action: 'open_file', path: 'x', line: -1 }))
    await assert.rejects(tool.execute({ action: 'apply_selection', text: 'x' }))
  })

  const entry = await load('index.ts')
  await check('rc.2 settings schema exports a defaulted volatile policy', () => {
    assert.equal(entry.Config.shape.checkpointAuto.live, true)
    assert.equal(entry.Config.shape.checkpointAuto.fallback, 'edit-only')
    assert.equal(entry.Config.shape.bridgeUrl.fallback, null)
  })
  await check('dormant health still identifies instance and exact launch workspace', async () => {
    const ctx = context()
    await entry.apply(ctx, { checkpointAuto: { get() { return 'off' } } })
    const health = await invoke(ctx, '/dsh-cline/health', { method: 'GET' })
    assert.equal(health.status, 503)
    assert.equal(health.json().plugin, 'dsh-cline-host-services')
    assert.equal(health.json().workspaceRoot, workspace)
    assert.match(health.json().instanceId, /^[a-f0-9-]{36}$/)
    assert.equal(health.json().bridge, 'down')
  })
  process.stdout.write(`Host services audit regressions: ${passed} passed.\n`)
} finally {
  process.chdir(originalCwd)
  if (originalHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = originalHome
  if (originalMcp === undefined) delete process.env.DSH_CLINE_MCP; else process.env.DSH_CLINE_MCP = originalMcp
  // Only this tool-created, verified temporary root is removed.
  assert.ok(fixture.startsWith(join(tmpdir(), 'dsh-cline-audit-')))
  await rm(fixture, { recursive: true, force: true })
}
