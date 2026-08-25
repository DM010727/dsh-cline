import * as vscode from 'vscode'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import * as crypto from 'node:crypto'
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { join } from 'node:path'
import * as os from 'node:os'
import { SidecarManager } from './sidecar'
import { DshClineView } from './view'
import { BridgeServer } from './bridge'
import { registerHandlers } from './handlers'
import { editPreviewContentProvider, EDIT_URI_SCHEME } from './edit-preview'
import { getSelectionContext, buildTaskPrompt, sendTask } from './selection-actions'
import { ensurePluginInstalled, dshClineHome } from './plugin-install'
import type { RuntimeStatus, DshVia } from '@dsh-cline/protocol'

const execFile = promisify(execFileCb)

/** Env var carrying the bridge URL from extension host to the DSH plugin. */
const BRIDGE_ENV = 'DSH_CLINE_BRIDGE'

/**
 * Bridge locator file ($DSH_CLINE_HOME/bridge.json), rewritten at EVERY
 * activation with the live bridge URL plus this activation's nonce. The
 * terminal-resident dsh web outlives any one extension host (persistent
 * terminal sessions survive window reloads), so the env var it was launched
 * with goes stale on every reload — the running plugin then posts to a dead
 * port ("bridge unreachable: fetch failed"). The plugin reads this file per
 * bridge call, keeping it glued to the current window's bridge with no DSH
 * restart. The nonce lets a deactivating OLD host remove only its own file,
 * never the replacement a new window just wrote.
 */
function bridgeFile(): string {
  return join(dshClineHome(), 'bridge.json')
}

/** Pinned runtime version the guided install puts on PATH. */
const DSH_VERSION = '0.1.0-rc.7'

/**
 * Default loopback port of the terminal-resident DSH service. Terminal mode
 * cannot learn an OS-assigned port from stdout, so the port must be fixed -
 * which also lets the extension bind to a DSH the user started themselves.
 * A configured 0 (the old "random port" default) falls back to this too.
 */
const DSH_PORT = 52341

/** npm install scripts dsh's native modules need, or node-pty/koffi stay unbuilt. */
const ALLOW_SCRIPTS_PKGS = '@deepseek-ai/dsh-subprocess-local,koffi,node-pty,@google/genai,protobufjs'

async function onPath(cmd: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') await execFile('where.exe', [cmd], { windowsHide: true })
    else await execFile('sh', ['-lc', 'command -v ' + cmd])
    return true
  } catch {
    return false
  }
}

/** Newest `dsh` shim under the npm npx cache, or undefined when absent. */
async function inNpxCache(): Promise<string | undefined> {
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx')
  let entries: string[]
  try {
    entries = await readdir(cache)
  } catch {
    return undefined
  }
  let best: { p: string, m: number } | undefined
  for (const entry of entries) {
    for (const name of process.platform === 'win32' ? ['dsh.cmd', 'dsh'] : ['dsh']) {
      const p = path.join(cache, entry, 'node_modules', '.bin', name)
      try {
        const s = await stat(p)
        if (best === undefined || s.mtimeMs > best.m) best = { p, m: s.mtimeMs }
      } catch { /* not present in this entry */ }
    }
  }
  return best?.p
}

/**
 * Locate the `dsh` binary the user just installed globally with npm (the guide
 * page's install button runs `npm install -g @deepseek-ai/dsh`). The extension
 * host's PATH is snapshotted at VS Code launch, so `onPath('dsh')` misses a
 * freshly installed global dsh until a full restart — which is exactly why the
 * guide's「重新检测并启动」seemed to do nothing after a successful install.
 * Resolving the npm global prefix pins the absolute path instead, so the
 * recheck (and every launch after it) starts `dsh web` without a restart; the
 * stale-PATH npx-cache fallback is only reached when no global dsh exists.
 */
async function onNpmGlobalDsh(): Promise<string | undefined> {
  let stdout: string
  try {
    if (process.platform === 'win32') {
      ({ stdout } = await execFile('cmd.exe', ['/c', 'npm prefix -g'], { windowsHide: true }))
    } else {
      ({ stdout } = await execFile('sh', ['-lc', 'npm prefix -g']))
    }
  } catch {
    return undefined
  }
  const prefix = stdout.trim()
  if (prefix === '') return undefined
  const candidates = process.platform === 'win32'
    ? [path.join(prefix, 'dsh.cmd'), path.join(prefix, 'dsh')]
    : [path.join(prefix, 'bin', 'dsh'), path.join(prefix, 'dsh')]
  for (const p of candidates) {
    try { await stat(p); return p } catch { /* not present here */ }
  }
  return undefined
}

/** Full detection pass backing the guide page and the sidecar pre-launch. */
async function getRuntimeStatus(): Promise<RuntimeStatus> {
  // The shipped default for dshCommand is "dsh" - treat that as "not
  // configured" so fresh machines fall through to PATH/npx detection and the
  // onboarding guide instead of spawning a doomed `dsh`.
  const inspect = vscode.workspace.getConfiguration('dsh-cline').inspect<string>('dshCommand')
  const configured = inspect?.globalValue ?? inspect?.workspaceValue
  const node = await onPath('node')
  if (configured !== undefined && configured !== '') return { node, via: 'configured', cmd: configured }
  if (await onPath('dsh')) return { node, via: 'path', cmd: 'dsh' }
  const globalDsh = await onNpmGlobalDsh()
  if (globalDsh !== undefined) return { node, via: 'path', cmd: globalDsh }
  const cached = await inNpxCache()
  if (cached !== undefined) return { node, via: 'npx-cache', cmd: cached }
  return { node, via: 'none', cmd: 'dsh' }
}

/** Commands the guide page's install button sends to the terminal. */
function dshInstallLines(): string[] {
  return [
    'npm config set allow-scripts ' + ALLOW_SCRIPTS_PKGS + ' --location=user',
    'npm install -g @deepseek-ai/dsh@' + DSH_VERSION,
  ]
}

/**
 * Activation wires the host-service bridge, the terminal-resident DSH service
 * manager, the two shell surfaces (sidebar view and editor panel), and the
 * status bar. The service starts lazily on the first surface resolving: bind
 * to a locally running `dsh web` when one answers on the port, otherwise
 * launch it in the visible「DSH Cline 服务」terminal and auto-revive it via
 * watchdog whenever it dies.
 */
export function activate(context: vscode.ExtensionContext): Promise<void> {
  const bridge = new BridgeServer()
  // Cline-style pre-write edit preview: virtual documents whose right side DSH
  // animates as it applies an edit (see edit-preview.ts).
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(EDIT_URI_SCHEME, editPreviewContentProvider),
  )
  // The sidecar is created further down; the restart handler reads through
  // this indirection so registration order never matters.
  let restartSidecar = (): void => { /* wired below once the sidecar exists */ }
  registerHandlers(bridge, String(context.extension.packageJSON.version ?? '0.0.0'), {
    restartDsh: () => restartSidecar(),
  })

  let bridgeUrl: string | undefined
  /** This activation's identity in the locator file (see bridgeFile). */
  const bridgeNonce = crypto.randomBytes(8).toString('hex')
  /**
   * Publish the live bridge URL for the DSH-side plugin, which re-reads it per
   * bridge call. Best-effort: a write failure only means the plugin keeps
   * using its (possibly stale) env value.
   */
  const publishBridgeUrl = (url: string): void => {
    writeFile(bridgeFile(), JSON.stringify({ url, nonce: bridgeNonce }) + '\n', 'utf8')
      .catch((err: unknown) => channel.appendLine('[bridge] locator write failed: ' + String(err)))
  }
  /** Remove the locator only if it is still OURS (nonce match). */
  const unpublishBridgeUrl = (): Promise<void> => {
    return readFile(bridgeFile(), 'utf8').then(text => {
      const parsed = JSON.parse(text) as { nonce?: unknown }
      if (parsed.nonce === bridgeNonce) return rm(bridgeFile(), { force: true })
    }).catch(() => { /* absent/corrupt/replaced: nothing safe to remove */ })
  }
  let dsh = { cmd: 'dsh', via: 'none' as DshVia }
  // Terminal handles are session-scoped variables, never workspaceState: a
  // Terminal object does not survive a window reload (it serializes to an
  // empty object whose exitStatus stays undefined, and sendText on it fails).
  let installTerminal: vscode.Terminal | undefined
  let serviceTerminalRef: vscode.Terminal | undefined
  const channel = vscode.window.createOutputChannel('DSH Cline')
  /**
   * Resolution chain, re-run before every launch: explicit config -> PATH ->
   * npx cache. Never installs anything: when nothing resolves, the view shows
   * the onboarding guide and the user installs globally from a terminal. Also
   * (re)installs the DSH-side plugin first - idempotent, cheap when current -
   * so the dsh web that follows always carries both plugin halves.
   */
  /**
   * Set when this activation installed a NEW plugin version on disk. A bound
   * (already-running) dsh web keeps executing its old in-memory plugin; the
   * ready handler below restarts such an instance once so upgrades (bridge
   * fixes included) take effect without a manual restart command.
   */
  let pluginUpdated = false
  const ensureRuntime = async (detail?: (msg: string) => void): Promise<void> => {
    const rt = await getRuntimeStatus()
    dsh = { cmd: rt.cmd, via: rt.via === 'configured' ? 'configured' : rt.via }
    // Only `none` (no resolvable dsh at all) skips the plugin install. `npx-cache`
    // still installs/updates the vendored host-services: the file copy needs no
    // dsh command, and the trailing profile scaffold is already non-fatal. Skipping
    // npx-cache here stranded the installed plugin at an old version (the running
    // npx-cache dsh web loaded e.g. 0.2.0 while the vsix vendored 0.3.4), which is
    // why the diff-mirror and other host-side features never took effect.
    if (rt.via === 'none') return
    detail?.('正在安装/更新 DSH Cline 插件…')
    try {
      const actions = await ensurePluginInstalled(
        join(context.extensionUri.fsPath, 'dist', 'vendor', 'host-services'),
        dsh.cmd,
      )
      for (const action of actions) channel.appendLine('[plugin-install] ' + action)
      if (actions.some(action => action.startsWith('host-services '))) pluginUpdated = true
    } catch (err: unknown) {
      channel.appendLine('[plugin-install] failed: ' + String(err))
    }
  }

  /**
   * Run the guided global install in a visible VS Code terminal so the user
   * watches progress and any npm failure directly. `npm config set` first:
   * the `--allow-scripts` flag is rejected in project scope and older npm may
   * not know the flag at all, while an unknown user config key is harmless.
   */
  const runGuidedInstall = (lines: string[]): void => {
    if (installTerminal === undefined || installTerminal.exitStatus !== undefined) {
      installTerminal = vscode.window.createTerminal('DSH Cline 安装')
    }
    installTerminal.show(true)
    for (const line of lines) installTerminal.sendText(line)
  }

  /** The (reused) terminal the DSH service lives in; recreated when closed. */
  const serviceTerminal = (): vscode.Terminal => {
    if (serviceTerminalRef === undefined || serviceTerminalRef.exitStatus !== undefined) {
      serviceTerminalRef = vscode.window.createTerminal({
        name: 'DSH Cline 服务',
        // The workspace folder as cwd (checkpoints key on it) and the bridge
        // URL injected at creation, so whatever shell the user runs still
        // passes it to the DSH-side host-services plugin. DSH_HOME isolates
        // this instance's whole config tree (settings/credentials/profiles/
        // sessions) into ~/.dsh-cline - the user's own ~/.dsh stays untouched.
        cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        env: {
          DSH_HOME: dshClineHome(),
          ...(bridgeUrl === undefined ? {} : { [BRIDGE_ENV]: bridgeUrl }),
        },
      })
    }
    return serviceTerminalRef
  }
  /** One launch line typed into the service terminal, quoting a spaced path. */
  const launchLine = (cmd: string, args: string[]): string => {
    const exe = /\s/.test(cmd) ? '"' + cmd + '"' : cmd
    return [exe, ...args].join(' ')
  }

  /**
   * Wait for a FRESHLY created terminal's shell to accept input before
   * sendText: on Windows the pty accepts writes before PowerShell is ready,
   * and a command typed in that window lands without its Enter - the user
   * then has to press Enter themselves. Shell integration (VS Code ≥ 1.93)
   * reports readiness; without it, a fixed grace period bounds the wait.
   * @param terminal - the terminal just created by serviceTerminal().
   */
  const waitShellReady = (terminal: vscode.Terminal): Promise<void> => {
    return new Promise<void>(resolve => {
      let settled = false
      let listener: vscode.Disposable | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        listener?.dispose()
        // A short settle on top of the event: the integration can report
        // readiness a beat before the prompt actually reads input.
        setTimeout(resolve, 400)
      }
      let timer: ReturnType<typeof setTimeout>
      try {
        listener = vscode.window.onDidChangeTerminalShellIntegration(event => {
          if (event.terminal === terminal) finish()
        })
      } catch {
        // Shell-integration API unavailable: fall back to the grace period.
        listener = undefined
      }
      timer = setTimeout(finish, 5_000)
    })
  }

  /**
   * Fallback readiness source: find locally running `dsh web` processes by
   * their command line and read the port each one actually listens on. When
   * the configured port stays silent (whatever made it diverge), a running
   * dsh web is still discovered and bound to - the panel gets into DSH.
   */
  let discoveredAt = 0
  let discoveredUrls: string[] = []
  const discoverDshWebUrls = async (): Promise<string[]> => {
    if (Date.now() - discoveredAt < 5_000) return discoveredUrls
    discoveredAt = Date.now()
    try {
      let stdout = ''
      if (process.platform === 'win32') {
        const result = await execFile('powershell.exe', ['-NoProfile', '-Command',
          "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'dsh.+web' } | ForEach-Object { $_.CommandLine }"],
          { windowsHide: true, timeout: 8_000 })
        stdout = result.stdout
      } else {
        const result = await execFile('sh', ['-lc', "ps -eo command | grep -E 'dsh.+web' | grep -v grep || true"])
        stdout = result.stdout
      }
      const urls: string[] = []
      for (const line of stdout.split(/\r?\n/)) {
        const port = /--port[= ](\d+)/.exec(line)?.[1]
        if (port !== undefined && port !== '0') urls.push('http://127.0.0.1:' + port)
      }
      discoveredUrls = [...new Set(urls)]
    } catch {
      discoveredUrls = []
    }
    return discoveredUrls
  }

  const sidecar = new SidecarManager(() => {
    const cfg = vscode.workspace.getConfiguration('dsh-cline')
    const host = cfg.get<string>('host') ?? '127.0.0.1'
    const port = cfg.get<number>('port') ?? DSH_PORT
    return {
      cmd: dsh.cmd,
      args: ['web', '--host', host, '--port', String(port === 0 ? DSH_PORT : port)],
      host,
      port: port === 0 ? DSH_PORT : port,
    }
  }, ensureRuntime, {
    launch: async cmd => {
      const fresh = serviceTerminalRef === undefined || serviceTerminalRef.exitStatus !== undefined
      const terminal = serviceTerminal()
      terminal.show(true)
      if (fresh) await waitShellReady(terminal)
      else await new Promise(resolve => { setTimeout(resolve, 300) })
      terminal.sendText(launchLine(cmd.cmd, cmd.args))
    },
    alive: () => serviceTerminalRef !== undefined && serviceTerminalRef.exitStatus === undefined,
    discoverUrls: discoverDshWebUrls,
    interrupt: () => {
      // Ctrl+C (ETX) in the service terminal; restart() waits for the probe to die.
      serviceTerminalRef?.sendText(String.fromCharCode(3))
    },
  })
  // In-GUI「重启 DSH 服务」(web「DSH Cline」section -> bridge -> here).
  restartSidecar = () => {
    sidecar.restart().catch(() => { /* state broadcast already surfaced */ })
  }
  // Upgrade self-heal: a ready reached by BINDING to an already-running dsh web
  // whose on-disk plugin this activation just replaced runs stale plugin code
  // (a stale bridge env among it) - restart it once so the new plugin loads.
  // A LAUNCHED ready already boots the new plugin, so the flag just clears.
  sidecar.on('change', ({ state }) => {
    if (state !== 'ready' || !pluginUpdated) return
    if (sidecar.lastReadyVia === 'launch') { pluginUpdated = false; return }
    pluginUpdated = false
    channel.appendLine('[plugin-install] 插件已更新，重启运行中的 DSH 以加载新版…')
    sidecar.restart().catch((err: unknown) => channel.appendLine('[plugin-install] auto-restart failed: ' + String(err)))
  })

  const view = new DshClineView(sidecar, {
    getRuntime: getRuntimeStatus,
    installDsh: () => runGuidedInstall(dshInstallLines()),
    installNode: () => runGuidedInstall(['winget install OpenJS.NodeJS.LTS']),
    openNodePage: () => void vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/')),
    showTerminal: () => serviceTerminal().show(true),
  }, String(context.extension.packageJSON.version ?? '0.0.0'))

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  status.command = 'dsh-cline.openPanel'
  status.name = 'DSH Cline'
  const onStatus = (): void => {
    const s = sidecar.status()
    channel.appendLine('[sidecar] ' + s.state + (s.detail === undefined ? '' : '：' + s.detail))
    if (s.state === 'ready' && s.url !== undefined) {
      status.text = '$(check) DSH ' + portOf(s.url)
      status.tooltip = 'DSH Sidecar 就绪：' + s.url + '（点击打开面板）'
    } else if (s.state === 'starting') {
      status.text = '$(sync~spin) DSH 启动中'
      status.tooltip = '正在启动 dsh web…'
    } else if (s.state === 'failed') {
      status.text = '$(error) DSH 失败'
      status.tooltip = s.detail ?? 'dsh web 启动失败'
    } else {
      status.text = '$(circle-slash) DSH'
      status.tooltip = 'DSH Sidecar 未运行'
    }
    status.show()
  }
  sidecar.on('change', onStatus)
  onStatus()

  // Selection actions (editor context menu). Each captures the active selection,
  // builds a prompt, expands @-mentions, and POSTs it to the DSH-side task route
  // so the reply streams into the conversation the user is viewing.
  const runSelectionAction = async (action: 'explain' | 'improve' | 'add'): Promise<void> => {
    const ctx = getSelectionContext()
    if (ctx === undefined) {
      void vscode.window.showWarningMessage('请先在编辑器里选中一段代码')
      return
    }
    const dshUrl = sidecar.status().url
    if (dshUrl === undefined) {
      void vscode.window.showWarningMessage('DSH Sidecar 未就绪，无法发送')
      return
    }
    // If the DSH panel isn't open, bring it up so the reply lands somewhere the
    // user can see (host-services creates a session for the message if none is
    // active, per requirement #2).
    try { view.openPanel() } catch { /* best-effort: panel open is cosmetic */ }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    try {
      const prompt = await buildTaskPrompt(action, ctx)
      const result = await sendTask(prompt, dshUrl, cwd)
      if (!result.ok) {
        void vscode.window.showErrorMessage('DSH Cline 任务发送失败：' + (result.error ?? '未知错误'))
        return
      }
      const verb = action === 'explain' ? '解释' : action === 'improve' ? '优化' : '添加'
      void vscode.window.showInformationMessage('已用 DSH Cline ' + verb + '（请在 DSH 面板查看）')
    } catch (err: unknown) {
      void vscode.window.showErrorMessage('DSH Cline 任务失败：' + String(err))
    }
  }

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(DshClineView.viewId, view, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('dsh-cline.openPanel', () => view.openPanel()),
    vscode.commands.registerCommand('dsh-cline.restoreCheckpoint', async () => {
      const status = sidecar.status()
      if (status.state !== 'ready' || status.url === undefined) {
        void vscode.window.showWarningMessage('DSH Sidecar 未就绪，无法读取检查点')
        return
      }
      try {
        const listRes = await fetch(status.url + '/dsh-cline/checkpoints')
        const list = await listRes.json() as { workspace?: string, checkpoints?: Array<{ id: string, label: string, time: number }> }
        const entries = list.checkpoints ?? []
        if (entries.length === 0) {
          void vscode.window.showInformationMessage('暂无检查点（' + (list.workspace ?? '未知工作区') + '）')
          return
        }
        const pick = await vscode.window.showQuickPick(
          entries.map(e => ({ label: e.id + '  ' + e.label, description: new Date(e.time * 1000).toLocaleString(), id: e.id })),
          { placeHolder: '选择要恢复的检查点（工作区文件将回滚，恢复后新增文件会被删除）' },
        )
        if (pick === undefined) return
        const restoreRes = await fetch(status.url + '/dsh-cline/checkpoints', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: pick.id }),
        })
        const restored = await restoreRes.json() as { restored?: string, error?: string }
        if (restored.error !== undefined) throw new Error(restored.error)
        void vscode.window.showInformationMessage('已恢复检查点 ' + String(restored.restored))
      } catch (err: unknown) {
        void vscode.window.showErrorMessage('检查点操作失败：' + String(err))
      }
    }),
    vscode.commands.registerCommand('dsh-cline.restartSidecar', () => {
      void sidecar.restart().then(
        url => vscode.window.showInformationMessage('DSH 服务已就绪：' + url),
        (err: unknown) => vscode.window.showErrorMessage('DSH 服务启动失败：' + String(err)),
      )
    }),
    vscode.commands.registerCommand('dsh-cline.addToChat', () => runSelectionAction('add')),
    vscode.commands.registerCommand('dsh-cline.explainCode', () => runSelectionAction('explain')),
    vscode.commands.registerCommand('dsh-cline.improveCode', () => runSelectionAction('improve')),
    // Cline-style lightbulb: offer add/explain/improve as code actions on any
    // selection. Commands carry NO arguments (VS Code's CommandsConverter caches
    // argument-carrying commands and disposes them with the code-action list);
    // the handlers read the active editor's selection themselves.
    vscode.languages.registerCodeActionsProvider('*', new (class implements vscode.CodeActionProvider {
      provideCodeActions(): vscode.CodeAction[] {
        const mk = (title: string, kind: vscode.CodeActionKind, command: string): vscode.CodeAction => {
          const a = new vscode.CodeAction(title, kind)
          a.command = { command, title }
          return a
        }
        return [
          mk('添加到 DSH Cline', vscode.CodeActionKind.QuickFix, 'dsh-cline.addToChat'),
          mk('用 DSH Cline 解释', vscode.CodeActionKind.RefactorExtract, 'dsh-cline.explainCode'),
          mk('用 DSH Cline 优化', vscode.CodeActionKind.RefactorRewrite, 'dsh-cline.improveCode'),
        ]
      }
    })(), {
      providedCodeActionKinds: [
        vscode.CodeActionKind.QuickFix,
        vscode.CodeActionKind.RefactorExtract,
        vscode.CodeActionKind.RefactorRewrite,
      ],
    }),
    vscode.workspace.onDidChangeConfiguration(e => {
      // The pre-launch hook re-resolves config on every start, so a plain
      // restart picks up dshCommand/autoInstall edits.
      if (e.affectsConfiguration('dsh-cline') && sidecar.status().state !== 'stopped') {
        sidecar.restart().catch(() => { /* surfaced via status */ })
      }
    }),
    sidecar,
    view,
    status,
    channel,
    { dispose: () => { void bridge.dispose().then(unpublishBridgeUrl) } },
  )

  // Resolve the bridge URL before any sidecar launch can observe it; the dsh
  // runtime resolves lazily in the sidecar's pre-launch hook.
  return bridge.start().then(url => {
    bridgeUrl = url
    publishBridgeUrl(url)
  })
}

function portOf(url: string): string {
  try {
    return ':' + new URL(url).port
  } catch {
    return url
  }
}