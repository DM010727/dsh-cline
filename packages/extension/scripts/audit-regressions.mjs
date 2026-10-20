import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import * as http from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
let assertions = 0
const check = (value, message) => { assert.ok(value, message); assertions++ }
class Emitter { event = () => ({ dispose() {} }); fire() {} dispose() {} }
async function load(name, vscode = {}, modules = {}) {
  const result = await build({ entryPoints: [join(root, 'src', name)], bundle: true, write: false, platform: 'node', format: 'cjs', external: ['vscode'], logLevel: 'silent' })
  const module = { exports: {} }
  vm.runInNewContext(result.outputFiles[0].text, {
    module, exports: module.exports, require: id => id === 'vscode' ? vscode : Object.hasOwn(modules, id) ? modules[id] : require(id),
    Buffer, URL, URLSearchParams, AbortController, AbortSignal, fetch, process, console, setTimeout, clearTimeout, setInterval, clearInterval,
  }, { filename: name })
  return module.exports
}

const fixture = await mkdtemp(join(tmpdir(), 'dsh-cline-audit-'))
let bridge
try {
  const animation = await load('edit-preview.ts', { EventEmitter: Emitter })
  for (const [before, after] of [['a\nb\nc', 'a\nB\nc'], ['a\nc', 'a\nb\nc'], ['a\nb\nc', 'a\nc']]) {
    const result = animation.buildEditPreviewAnimation(before, after)
    check(result.frames.at(-1).content === after, 'final diff matches edit')
    check(result.firstChangedLine === 1, 'first insertion/replacement/deletion is revealed')
  }
  check(animation.buildEditPreviewAnimation('a\nb', 'a\nB').frames.some(f => !f.zip), 'real changes animate instead of silently rendering one frame')
  check(animation.buildEditPreviewAnimation('same', 'same').frames.length === 1, 'identical content does not animate')
  const huge = Array.from({ length: 500 }, (_, i) => 'x'.repeat(4096) + i).join('\n')
  const frames = animation.buildEditPreviewAnimation(huge, huge.replace('x', 'Y')).frames
  check(frames.reduce((n, f) => n + f.content.length * 2, 0) <= 32 * 1024 * 1024, 'animation memory is bounded')

  const runtime = await load('runtime.ts')
  check(runtime.launchLine("C:\\a b\\dsh.cmd", ['web', 'x\'y'], true) === "& 'C:\\a b\\dsh.cmd' 'web' 'x''y'", 'PowerShell spaced executable uses call operator and literal quoting')
  check(runtime.launchLine('/a b/dsh', ["x'y"], false) === "'/a b/dsh' 'x'\\''y'", 'POSIX command quotes literals')
  assert.throws(() => runtime.launchLine('dsh\nmalicious', [])); assertions++
  check(runtime.workspacePort('/workspace/a') === runtime.workspacePort('/workspace/a'), 'workspace port is stable')
  check(runtime.workspaceKey('/workspace/a') !== runtime.workspaceKey('/workspace/b'), 'locators distinguish workspaces')
  check(!runtime.supportsNode('v20.20.0') && !runtime.supportsNode('v22.18.0') && !runtime.supportsNode('v23.0.0'), 'unsupported Node releases cannot pass onboarding')
  check(runtime.supportsNode('v22.19.0') && runtime.supportsNode('v24.0.0'), 'documented Node range is accepted')

  const workspace = join(fixture, 'workspace')
  await mkdir(workspace)
  await writeFile(join(workspace, 'file with space.ts'), 'export const fixtureValue = 42')
  await writeFile(join(fixture, 'private.txt'), 'OUTSIDE_WORKSPACE_MARKER')
  const selection = await load('selection-actions.ts', { workspace: { workspaceFolders: [{ uri: { fsPath: workspace } }] } })
  const expanded = await selection.expandMentions('@"/file with space.ts" @../private.txt')
  check(expanded.includes('fixtureValue = 42'), 'workspace-root quoted mention expands')
  check(!expanded.includes('OUTSIDE_WORKSPACE_MARKER'), 'parent traversal does not disclose an outside file')
  check((await selection.sendTask('x'.repeat(70 * 1024), 'http://127.0.0.1:1')).ok === false, 'oversize task rejected before network')

  const shell = await load('shell.ts')
  const html = shell.buildShellHtml({ state: 'ready', url: 'http://127.0.0.1:52341' })
  let receive
  const outbound = []
  const framesOut = []
  const iframe = { contentWindow: { postMessage: (...args) => framesOut.push(args) } }
  const window = { parent: {}, addEventListener: (_name, callback) => { receive = callback } }
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
    window, document: { getElementById: id => id === 'dsh-frame' ? iframe : undefined },
    acquireVsCodeApi: () => ({ postMessage: message => outbound.push(message) }),
  })
  const originalCount = outbound.length
  receive({ source: {}, origin: 'https://attacker.example', data: { channel: 'dsh-cline.host-service', type: 'clipboard', op: 'paste' } })
  check(outbound.length === originalCount, 'foreign source cannot request OS clipboard')
  receive({ source: iframe.contentWindow, origin: 'https://attacker.example', data: { channel: 'dsh-cline.host-service' } })
  check(outbound.length === originalCount, 'navigated iframe origin is rejected')
  receive({ source: iframe.contentWindow, origin: 'http://127.0.0.1:52341', data: { channel: 'dsh-cline.host-service' } })
  check(outbound.length === originalCount + 1, 'expected iframe can relay host messages')
  receive({ source: null, data: { channel: 'dsh-cline.shell', type: 'bridge', payload: { secret: 'fixture' } } })
  check(framesOut.at(-1)[1] === 'http://127.0.0.1:52341', 'host response targets exact DSH origin')
  const embedded = shell.buildShellHtml({ state: 'ready', url: 'http://127.0.0.1:52341', browserUrl: 'http://127.0.0.1:52342/fixture-capability/' })
  check(embedded.includes('src="http://127.0.0.1:52342/fixture-capability/"')
    && embedded.includes('frame-src http://127.0.0.1:52342;'), 'embedded entrance and CSP target the authenticated proxy')
  check(embedded.includes('referrerpolicy="no-referrer"'), 'embedded capability is not sent in Referer')
  const oldCount = outbound.length
  vm.runInNewContext(embedded.match(/<script>([\s\S]*?)<\/script>/)[1], {
    window, document: { getElementById: id => id === 'dsh-frame' ? iframe : undefined },
    acquireVsCodeApi: () => ({ postMessage: message => outbound.push(message) }),
  })
  receive({ source: iframe.contentWindow, origin: 'http://127.0.0.1:52341', data: { channel: 'dsh-cline.host-service' } })
  check(outbound.length === oldCount + 1, 'native service origin cannot impersonate the embedded proxy frame')
  receive({ source: iframe.contentWindow, origin: 'http://127.0.0.1:52342', data: { channel: 'dsh-cline.host-service' } })
  check(outbound.length === oldCount + 2, 'authenticated proxy frame retains the host relay')
  const guide = shell.buildGuideHtml({ node: true, via: 'path', cmd: 'dsh', installedVersion: '0.1.0-rc.7', compatible: false })
  check(guide.includes('0.2.1-rc.2') && !guide.includes('data-act="continue-anyway"'), 'old runtime has a clear upgrade guide and no bypass')

  const viewModule = await load('view.ts', { env: { clipboard: { readText: async () => 'fixture', writeText: async () => {} } } })
  const viewSidecar = { on() {}, off() {}, status: () => ({ state: 'stopped' }), start: () => { throw new Error('old runtime must not start') } }
  const view = new viewModule.DshClineView(viewSidecar, { getRuntime: async () => ({ node: true, via: 'path', cmd: 'dsh', compatible: false }) })
  await view.ensureStarted()
  check(view.guide.compatible === false, 'existing incompatible runtime is gated before launch')
  const delivered = []
  let receiveHost
  const webview = { postMessage: message => { delivered.push(message); return Promise.resolve(true) }, onDidReceiveMessage: callback => { receiveHost = callback; return { dispose() {} } } }
  view.view = { webview }
  view.attach(webview)
  view.broadcastToFrame({ channel: 'dsh-cline.open-session', sessionId: 'session-fixture' })
  check(delivered.length === 0, 'new session navigation waits for client hydration')
  receiveHost({ channel: 'dsh-cline.host-service', type: 'client-ready' })
  check(delivered.at(-1).payload.sessionId === 'session-fixture', 'ready handshake delivers queued session navigation')
  const deliveredAfterReady = delivered.length
  receiveHost({ channel: 'dsh-cline.host-service', type: 'client-ready' })
  check(delivered.length === deliveredAfterReady, 'consumed task navigation is not replayed on another ready handshake')
  let receiveReopened
  const reopened = {
    postMessage: message => { delivered.push(message); return Promise.resolve(true) },
    onDidReceiveMessage: callback => { receiveReopened = callback; return { dispose() {} } },
  }
  view.view = { webview: reopened }
  view.attach(reopened)
  receiveReopened({ channel: 'dsh-cline.host-service', type: 'client-ready' })
  check(delivered.length === deliveredAfterReady + 1 && delivered.at(-1).payload.channel === 'dsh-cline.open-workspace', 'reopening a surface selects the VS Code workspace without replaying an old task')
  receiveHost(null)
  receiveHost({ channel: 'dsh-cline.host-service', type: 'clipboard', op: 'cut', text: 'fixture', requestId: 'fixture-request' })
  await new Promise(resolve => setTimeout(resolve, 0))
  check(delivered.at(-1).payload.ok === true && delivered.at(-1).payload.requestId === 'fixture-request', 'cut receives correlated success ACK')
  view.dispose()

  // Sidebar launch must reveal one reusable editor panel, not replace the code tab.
  const panels = [], layouts = []
  let sidebarVisibility, sidebarDispose
  const makeWebview = () => ({ options: {}, html: '', postMessage: async () => true, onDidReceiveMessage: () => ({ dispose() {} }) })
  const panelApi = { ViewColumn: { Two: 2, Beside: -2 }, window: {
    tabGroups: { all: [{}] },
    createWebviewPanel: (_type, _title, column) => {
      let onDispose
      const panel = { column, webview: makeWebview(), visible: true, reveals: 0,
        reveal() { this.reveals++ }, onDidChangeViewState: () => ({ dispose() {} }),
        onDidDispose(callback) { onDispose = callback }, dispose() { onDispose?.() } }
      panels.push(panel); return panel
    },
  }, commands: { executeCommand: async (...args) => { layouts.push(args) } } }
  const launchModule = await load('view.ts', panelApi)
  const launchView = new launchModule.DshClineView(viewSidecar, { getRuntime: async () => ({ node: true, via: 'none' }) })
  const sidebar = { webview: makeWebview(), visible: true,
    onDidChangeVisibility(callback) { sidebarVisibility = callback; return { dispose() {} } },
    onDidDispose(callback) { sidebarDispose = callback } }
  launchView.resolveWebviewView(sidebar)
  check(panels.length === 1 && panels[0].column === 2, 'opening sidebar launches the editor panel on the right')
  check(layouts[0]?.[0] === 'vscode.setEditorLayout' && layouts[0][1].orientation === 0
    && layouts[0][1].groups.every(group => group.size === 0.5), 'a single editor starts with two equal horizontal columns')
  launchView.openPanel(); sidebarVisibility()
  check(panels.length === 1 && layouts.length === 1 && panels[0].reveals === 2, 'repeated launch reuses the panel without resizing the user layout')
  panels[0].dispose(); panelApi.window.tabGroups.all = [{}, {}, {}]; sidebarVisibility()
  check(panels.length === 2 && panels[1].column === -2 && layouts.length === 1, 'reopen preserves existing multi-group layouts')
  sidebar.visible = false; sidebarVisibility()
  check(panels.length === 2 && panels[1].reveals === 0, 'hiding the sidebar does not steal focus')
  sidebarDispose(); launchView.dispose()

  const { BridgeServer } = await load('bridge.ts')
  bridge = new BridgeServer()
  bridge.handle('fixture.echo', async args => args[0])
  const url = await bridge.start()
  const request = async (body, headers = { 'content-type': 'application/json' }) => {
    const response = await fetch(url, { method: 'POST', headers, body })
    return { status: response.status, text: await response.text() }
  }
  check((await request('null')).status === 400, 'null bridge envelope rejected without unhandled rejection')
  check((await request('{')).status === 400, 'invalid JSON rejected')
  check((await request('{}', { 'content-type': 'application/json', origin: 'https://attacker.example' })).status === 403, 'browser-origin bridge RPC rejected')
  const text = '中文分片输入'
  const body = Buffer.from(JSON.stringify({ service: 'fixture', method: 'echo', args: [text] }))
  const split = body.indexOf(Buffer.from('中')) + 1
  const reply = await new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      const data = []; res.on('data', chunk => data.push(chunk)); res.on('end', () => resolve(JSON.parse(Buffer.concat(data).toString('utf8'))))
    })
    req.on('error', reject); req.write(body.subarray(0, split)); req.end(body.subarray(split))
  })
  check(reply.result === text, 'UTF-8 payload survives split byte chunks')
  await bridge.dispose(); bridge = undefined

  const { SidecarManager } = await load('sidecar.ts')
  let release
  let launches = 0
  const preparation = new Promise(resolve => { release = resolve })
  const sidecar = new SidecarManager(() => ({ cmd: 'dsh', args: [], host: '127.0.0.1', port: 1 }), () => preparation, { launch: () => { launches++ }, alive: () => true })
  const start = sidecar.start()
  sidecar.stop(); release()
  await assert.rejects(start, /superseded/); assertions++
  check(launches === 0, 'cancelled preparation cannot launch a stale DSH process')
  sidecar.dispose()
  let launched
  const entered = new Promise(resolve => { launched = resolve })
  let launchSignal
  const duringLaunch = new SidecarManager(() => ({ cmd: 'dsh', args: [], host: '127.0.0.1', port: 1 }), undefined, {
    launch: (_cmd, signal) => new Promise(resolve => { launchSignal = signal; launched(); signal.addEventListener('abort', resolve, { once: true }) }), alive: () => true,
  })
  duringLaunch.probeReady = async () => false
  const pendingStart = duringLaunch.start()
  await entered
  duringLaunch.stop()
  await assert.rejects(pendingStart, /superseded/); assertions++
  check(launchSignal.aborted, 'cancellation reaches a terminal waiting for shell readiness')
  duringLaunch.dispose()

  const savedHome = process.env.DSH_CLINE_HOME
  const home = join(fixture, 'isolated-home')
  process.env.DSH_CLINE_HOME = home
  try {
    const installer = await load('plugin-install.ts')
    const vendor = join(fixture, 'vendor')
    await mkdir(join(vendor, 'lib'), { recursive: true })
    await writeFile(join(vendor, 'package.json'), JSON.stringify({ version: 'fixture.1' }))
    await writeFile(join(vendor, 'lib/client.js'), '// fixture browser')
    await writeFile(join(vendor, 'lib/index.js'), '// fixture host')
    await mkdir(home, { recursive: true })
    const customSettings = 'llm-pi-ai:\n  providers:\n    userOne: {}\nllm-pi-ai:\n  providers:\n    userTwo: {}\n'
    await writeFile(join(home, 'settings.yaml'), customSettings)
    await installer.ensurePluginInstalled(vendor)
    check(await readFile(join(home, 'settings.yaml'), 'utf8') === customSettings, 'ambiguous duplicate settings are never silently deleted')
    check((await readFile(join(home, 'profiles/web/cordis.patch.yml'), 'utf8')).includes('enabled: false'), 'new full-session contribution defaults off')
    const index = join(home, 'profiles/node_modules/@dsh-cline/host-services/lib/index.js')
    await rm(index)
    await installer.ensurePluginInstalled(vendor)
    check((await stat(index)).isFile(), 'incomplete same-version plugin is repaired')
    await rm(index) // force both overlapping callers to encounter an incomplete installation
    const concurrent = await Promise.allSettled([installer.ensurePluginInstalled(vendor), installer.ensurePluginInstalled(vendor)])
    check(concurrent.every(result => result.status === 'fulfilled'), 'overlapping installation attempts serialize without EEXIST')
    check(await readFile(index, 'utf8') === '// fixture host'
      && await readFile(join(home, 'profiles/node_modules/@dsh-cline/host-services/lib/client.js'), 'utf8') === '// fixture browser', 'concurrent repair installs both complete host and client artifacts')

    check(!(await installer.ensurePluginInstalled(vendor)).some(action => action.startsWith('host-services ')), 'identical same-version payload does not trigger replacement or restart')
    await writeFile(join(vendor, 'lib/client.js'), '// changed browser')
    const sameVersionUpdate = await installer.ensurePluginInstalled(vendor)
    check(sameVersionUpdate.some(action => action.startsWith('host-services '))
      && await readFile(join(home, 'profiles/node_modules/@dsh-cline/host-services/lib/client.js'), 'utf8') === '// changed browser', 'same-version client change installs and signals the existing restart mechanism')
    await writeFile(join(vendor, 'lib/rsi-runtime.js'), '// first runtime')
    await installer.ensurePluginInstalled(vendor)
    await writeFile(join(vendor, 'lib/rsi-runtime.js'), '// newer runtime')
    await installer.ensurePluginInstalled(vendor)
    check(await readFile(join(home, 'profiles/node_modules/@dsh-cline/host-services/lib/rsi-runtime.js'), 'utf8') === '// newer runtime', 'same-version transitive host module changes are detected even when entry points match')
    await rm(join(vendor, 'lib/rsi-runtime.js'))
    await installer.ensurePluginInstalled(vendor)
    check(!existsSync(join(home, 'profiles/node_modules/@dsh-cline/host-services/lib/rsi-runtime.js')), 'same-version repack removes obsolete managed modules')

    assert.throws(() => installer.mergeWebProfilePatch('plugins:\n  host-services: true\n'), /YAML sequence/); assertions++
    const manual = installer.mergeWebProfilePatch('- insert:\n    - id: dsh-cline-host-services\n      name: "@dsh-cline/host-services"\n')
    check((manual.match(/id:\s*dsh-cline-host-services/g) ?? []).length === 1, 'manual host-services registration is not duplicated')
    const optedIn = installer.mergeWebProfilePatch('- id: \'session-log-deepseek\'\n  config:\n    enabled: true\n')
    check(optedIn.includes('enabled: true') && !optedIn.includes('enabled: false')
      && (optedIn.match(/id:\s*['"]?session-log-deepseek/g) ?? []).length === 1, 'quoted explicit session contribution opt-in survives patch merging')
    assert.throws(() => installer.mergeWebProfilePatch('# === dsh-cline host-services (managed block, do not edit) ===\n'), /Incomplete/); assertions++

    // Mock the original user home entirely inside the tool-created fixture.
    // No fixture, junction, or cleanup ever touches the user's actual ~/.dsh.
    const mockUser = join(fixture, 'mock-user')
    const original = join(mockUser, '.dsh')
    await mkdir(original, { recursive: true })
    await writeFile(join(original, 'keep.txt'), 'original-home-marker')
    const guarded = await load('plugin-install.ts', {}, { 'node:os': { ...require('node:os'), homedir: () => mockUser } })
    for (const candidate of ['', parse(fixture).root, join(original, 'new-child')]) {
      process.env.DSH_CLINE_HOME = candidate
      assert.throws(() => guarded.dshClineHome(), /isolated|empty/); assertions++
    }
    const alias = join(fixture, 'alias-to-original-home')
    await symlink(original, alias, process.platform === 'win32' ? 'junction' : 'dir')
    process.env.DSH_CLINE_HOME = join(alias, 'not-yet-created')
    assert.throws(() => guarded.dshClineHome(), /isolated/); assertions++
    check((await readdir(original)).join() === 'keep.txt'
      && await readFile(join(original, 'keep.txt'), 'utf8') === 'original-home-marker', 'synchronous aliased-home rejection leaves original home untouched')

    for (const branch of ['web', 'node_modules']) {
      const redirectedHome = join(fixture, 'redirected-' + branch)
      const outside = join(fixture, 'outside-' + branch)
      await mkdir(outside)
      await writeFile(join(outside, 'keep.txt'), 'outside-marker')
      const link = join(redirectedHome, 'profiles', branch)
      await mkdir(dirname(link), { recursive: true })
      await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
      process.env.DSH_CLINE_HOME = redirectedHome
      await assert.rejects(guarded.ensurePluginInstalled(vendor), /escapes|redirected/); assertions++
      check((await readdir(outside)).join() === 'keep.txt'
        && await readFile(join(outside, 'keep.txt'), 'utf8') === 'outside-marker', 'redirected profiles/' + branch + ' cannot write outside its isolated home')
    }
    for (const entry of ['settings.yaml', 'profiles/web/cordis.patch.yml', 'profiles/node_modules/@dsh-cline/host-services']) {
      const directHome = join(fixture, 'direct-link-' + assertions)
      const link = join(directHome, entry)
      const destination = join(directHome, 'untouched-target')
      const directory = entry.endsWith('host-services')
      await mkdir(dirname(link), { recursive: true })
      if (directory) await mkdir(destination)
      else await writeFile(destination, '[]\n')
      await symlink(destination, link, directory ? process.platform === 'win32' ? 'junction' : 'dir' : 'file')
      process.env.DSH_CLINE_HOME = directHome
      await assert.rejects(guarded.ensurePluginInstalled(vendor), /redirected/); assertions++
      check(directory ? (await readdir(destination)).length === 0 : await readFile(destination, 'utf8') === '[]\n', 'direct installer link is rejected even when its destination remains inside the home')
    }
  } finally { if (savedHome === undefined) delete process.env.DSH_CLINE_HOME; else process.env.DSH_CLINE_HOME = savedHome }

  console.log(JSON.stringify({ assertions, passed: true, services: 'one ephemeral local HTTP fixture; no DSH, VS Code, model calls or user state' }))
} finally {
  await bridge?.dispose()
  await rm(fixture, { recursive: true, force: true })
}
