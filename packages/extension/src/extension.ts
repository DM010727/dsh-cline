import * as vscode from 'vscode'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import * as crypto from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import * as os from 'node:os'
import { SidecarManager } from './sidecar'
import { WebProxy } from './web-proxy'
import { DshClineView } from './view'
import { BridgeServer } from './bridge'
import { registerHandlers, SSY_CALLBACK_AUTHORITY } from './handlers'
import { editPreviewContentProvider, EDIT_URI_SCHEME, reopenLastEditPreview } from './edit-preview'
import { getSelectionContext, buildTaskPrompt, sendTask } from './selection-actions'
import { ensurePluginInstalled, dshClineHome } from './plugin-install'
import { DSH_RUNTIME_REVISION, checkManagedRuntime, managedInstallLine, launchLine, supportsNode, workspaceKey, servicePort } from './runtime'
import type { RuntimeStatus, DshVia } from '@dsh-cline/protocol'

const execFile = promisify(execFileCb)

/** Env var carrying the bridge URL from extension host to the DSH plugin. */
const BRIDGE_ENV = 'DSH_CLINE_BRIDGE'

/**
 * Bridge locator file ($DSH_CLINE_HOME/bridge-<workspace-key>.json), rewritten at EVERY
 * activation with the live bridge URL plus this activation's nonce. The
 * terminal-resident dsh web outlives any one extension host (persistent
 * terminal sessions survive window reloads), so the env var it was launched
 * with goes stale on every reload — the running plugin then posts to a dead
 * port ("bridge unreachable: fetch failed"). The plugin reads this file per
 * bridge call, keeping it glued to the current window's bridge with no DSH
 * restart. Deactivation leaves the locator for the next activation to replace,
 * so an old host cannot race a new window by deleting its locator.
 */
function bridgeFile(): string {
  return join(dshClineHome(), 'bridge-' + workspaceKey(workspaceRoot()) + '.json')
}

function workspaceRoot(): string { return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir() }

const terminalShell = process.platform === 'win32'
  ? { shellPath: join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), shellArgs: ['-NoLogo', '-NoProfile'] }
  : { shellPath: '/bin/sh' }

/** Only the extension's locked, dependency-verified runtime can start a service. */
async function detectRuntime(assets: string): Promise<RuntimeStatus> {
  let node = false
  try { node = supportsNode((await execFile('node', ['--version'], { windowsHide: true, timeout: 5_000 })).stdout) } catch { /* missing Node */ }
  if (!node) return { node: false, via: 'none', cmd: 'dsh', compatible: false }
  const verified = await checkManagedRuntime(assets, dshClineHome())
  return {
    node, via: verified.ok ? 'managed' : 'none', cmd: verified.command ?? 'dsh',
    installedVersion: verified.version, compatible: verified.ok, issue: verified.reason,
  }
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
  if (!vscode.workspace.isTrusted) return Promise.resolve()
  const runtimeAssets = join(context.extensionUri.fsPath, 'dist', 'runtime')
  const getRuntimeStatus = (): Promise<RuntimeStatus> => detectRuntime(runtimeAssets)
  const bridge = new BridgeServer()
  const webProxy = new WebProxy()
  // Cline-style pre-write edit preview: virtual documents whose right side DSH
  // animates as it applies an edit (see edit-preview.ts).
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(EDIT_URI_SCHEME, editPreviewContentProvider),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme === EDIT_URI_SCHEME) editPreviewContentProvider.delete(document.uri)
    }),
    editPreviewContentProvider,
  )
  // The sidecar is created further down; the restart handler reads through
  // this indirection so registration order never matters.
  let restartSidecar = (): void => { /* wired below once the sidecar exists */ }
  let pendingLogin: { state: string; callbackUrl: string; expires: number } | undefined
  registerHandlers(bridge, String(context.extension.packageJSON.version ?? '0.0.0'), {
    restartDsh: () => restartSidecar(),
    createSsyCallback: () => {
      const state = crypto.randomBytes(24).toString('base64url')
      const callbackUrl = `${vscode.env.uriScheme}://${SSY_CALLBACK_AUTHORITY}/ssy?state=${state}`
      pendingLogin = { state, callbackUrl, expires: Date.now() + 10 * 60_000 }
      return callbackUrl
    },
  })

  let bridgeUrl: string | undefined
  /** This activation's identity in the locator file (see bridgeFile). */
  const bridgeNonce = crypto.randomBytes(8).toString('hex')
  /**
   * Publish the live bridge URL for the DSH-side plugin, which re-reads it per
   * bridge call. Best-effort: a write failure only means the plugin keeps
   * using its (possibly stale) env value.
   */
  const publishBridgeUrl = async (url: string): Promise<void> => {
    await mkdir(dshClineHome(), { recursive: true })
    const temp = bridgeFile() + '.' + bridgeNonce + '.tmp'
    await writeFile(temp, JSON.stringify({ url, nonce: bridgeNonce }) + '\n', { encoding: 'utf8', mode: 0o600 })
    await rename(temp, bridgeFile())
  }
  let dsh = { cmd: 'dsh', via: 'none' as DshVia }
  // Terminal handles are session-scoped variables, never workspaceState: a
  // Terminal object does not survive a window reload (it serializes to an
  // empty object whose exitStatus stays undefined, and sendText on it fails).
  let installTerminal: vscode.Terminal | undefined
  const serviceTerminalName = 'DSH Cline 服务 · ' + workspaceKey(workspaceRoot()).slice(0, 8)
  let serviceTerminalRef = vscode.window.terminals.find(terminal => terminal.name === serviceTerminalName && terminal.exitStatus === undefined)
  const channel = vscode.window.createOutputChannel('DSH Cline')
  /**
   * Revalidate the managed runtime before every launch, then install/heal the
   * plugin. Missing or altered dependencies return to the explicit repair flow.
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
    if (rt.compatible !== true) throw new Error(rt.issue ?? '请先安装／修复扩展专用 DSH 运行时')
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
      throw err
    }
  }

  /**
   * Run the pinned isolated install in a visible VS Code terminal. Stop this
   * workspace's previous service before replacing runtime files; no global npm
   * settings or original DSH configuration are changed.
   */
  const runGuidedInstall = (lines: string[]): void => {
    if (installTerminal === undefined || installTerminal.exitStatus !== undefined) {
      installTerminal = vscode.window.createTerminal({ name: 'DSH Cline 安装', ...terminalShell })
    }
    // An explicit runtime repair also stops the service from the previous install.
    if (serviceTerminalRef !== undefined && serviceTerminalRef.exitStatus === undefined) serviceTerminalRef.sendText(String.fromCharCode(3))
    sidecar.stop()
    installTerminal.show(true)
    const terminal = installTerminal
    void waitShellReady(terminal).then(() => { for (const line of lines) terminal.sendText(line) })
  }

  /** The (reused) terminal the DSH service lives in; recreated when closed. */
  const serviceTerminal = (): vscode.Terminal => {
    if (serviceTerminalRef === undefined || serviceTerminalRef.exitStatus !== undefined) {
      serviceTerminalRef = vscode.window.createTerminal({
        name: serviceTerminalName,
        ...terminalShell,
        // The workspace folder as cwd (checkpoints key on it) and the bridge
        // URL injected at creation, so whatever shell the user runs still
        // passes it to the DSH-side host-services plugin. DSH_HOME isolates
        // this instance's whole config tree (settings/credentials/profiles/
        // sessions) into ~/.dsh-cline - the user's own ~/.dsh stays untouched.
        cwd: workspaceRoot(),
        env: {
          DSH_HOME: dshClineHome(),
          DSH_CLINE_RUNTIME_REVISION: DSH_RUNTIME_REVISION,
          DSH_CLINE_BRIDGE_FILE: bridgeFile(),
          ...(bridgeUrl === undefined ? {} : { [BRIDGE_ENV]: bridgeUrl }),
        },
      })
    }
    return serviceTerminalRef
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
    if (bridgeUrl === undefined) throw new Error('DSH Cline 本机桥尚未就绪，请重试。')
    const cfg = vscode.workspace.getConfiguration('dsh-cline')
    const host = cfg.get<string>('host') ?? '127.0.0.1'
    if (host !== '127.0.0.1' && host !== 'localhost') throw new Error('DSH Cline 仅允许绑定本机回环地址')
    const inspect = cfg.inspect<number>('port')
    const port = servicePort(inspect?.workspaceFolderValue ?? inspect?.workspaceValue ?? inspect?.globalValue, workspaceRoot())
    return {
      cmd: dsh.cmd,
      args: ['web', '--no-open', '--host', host, '--port', String(port)],
      host,
      port,
      workspaceRoot: workspaceRoot(),
      runtimeRevision: DSH_RUNTIME_REVISION,
      bootstrapKey: bridgeUrl,
    }
  }, ensureRuntime, {
    launch: async (cmd, signal) => {
      const fresh = serviceTerminalRef === undefined || serviceTerminalRef.exitStatus !== undefined
      const terminal = serviceTerminal()
      terminal.show(true)
      if (fresh) await waitShellReady(terminal)
      else await new Promise(resolve => { setTimeout(resolve, 300) })
      if (signal?.aborted) throw new Error('superseded')
      const revisionEnv = process.platform === 'win32'
        ? "$env:DSH_CLINE_RUNTIME_REVISION = '" + DSH_RUNTIME_REVISION + "'; "
        : "export DSH_CLINE_RUNTIME_REVISION='" + DSH_RUNTIME_REVISION + "'; "
      terminal.sendText(revisionEnv + launchLine(cmd.cmd, cmd.args))
    },
    alive: () => serviceTerminalRef !== undefined && serviceTerminalRef.exitStatus === undefined,
    discoverUrls: discoverDshWebUrls,
    interrupt: () => {
      // Ctrl+C (ETX) in the service terminal; restart() waits for the probe to die.
      if (serviceTerminalRef === undefined || serviceTerminalRef.exitStatus !== undefined) return false
      serviceTerminalRef.sendText(String.fromCharCode(3))
      return true
    },
  }, (origin, authenticatedUrl) => webProxy.connect(origin, authenticatedUrl))
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
    installDsh: (useMirror: boolean) => runGuidedInstall([managedInstallLine(runtimeAssets, dshClineHome(), useMirror)]),
    installNode: () => runGuidedInstall(['winget install OpenJS.NodeJS.LTS']),
    openNodePage: () => void vscode.env.openExternal(vscode.Uri.parse('https://nodejs.org/')),
    showTerminal: () => serviceTerminal().show(true),
  }, String(context.extension.packageJSON.version ?? '0.0.0'))

  // Shengsuanyun OAuth callback (ported from cline-Chinese): the login button
  // opens router.shengsuanyun.com/auth with a vscode:// callback; the browser
  // lands here with ?code=, which is exchanged for an API key and relayed into
  // the DSH iframe so the key field fills itself (manual paste still works).
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri: vscode.Uri) => {
        const query = new URLSearchParams(uri.query)
        if (!pendingLogin || pendingLogin.expires < Date.now() || query.get('state') !== pendingLogin.state) {
          void vscode.window.showErrorMessage('登录回调已过期或不是由本窗口发起，请重新登录。')
          return
        }
        const callbackUrl = pendingLogin.callbackUrl
        pendingLogin = undefined
        void handleSsyCallback(uri, view, channel, callbackUrl)
      },
    }),
  )

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
  // and navigates the panel to the new session returned by that workspace.
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
    // Create the surface before sending, so navigation can wait for hydration.
    try { view.openPanel() } catch { /* best-effort: panel open is cosmetic */ }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    try {
      const prompt = await buildTaskPrompt(action, ctx)
      const result = await sendTask(prompt, dshUrl, cwd)
      if (!result.ok) {
        void vscode.window.showErrorMessage('DSH Cline 任务发送失败：' + (result.error ?? '未知错误'))
        return
      }
      if (result.sessionId) view.broadcastToFrame({ channel: 'dsh-cline.open-session', sessionId: result.sessionId })
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
    vscode.commands.registerCommand('dsh-cline.updateRuntime', () => runGuidedInstall([managedInstallLine(runtimeAssets, dshClineHome())])),
    vscode.commands.registerCommand('dsh-cline.restoreCheckpoint', async () => {
      const status = sidecar.status()
      if (status.state !== 'ready' || status.url === undefined) {
        void vscode.window.showWarningMessage('DSH Sidecar 未就绪，无法读取检查点')
        return
      }
      try {
        const listRes = await fetch(status.url + '/dsh-cline/checkpoints', { signal: AbortSignal.timeout(15_000) })
        if (!listRes.ok) throw new Error('读取检查点 HTTP ' + listRes.status)
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
          signal: AbortSignal.timeout(60_000),
        })
        const restored = await restoreRes.json() as { restored?: string, error?: string }
        if (!restoreRes.ok || restored.error !== undefined || typeof restored.restored !== 'string') throw new Error(restored.error ?? '恢复检查点失败')
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
    vscode.commands.registerCommand('dsh-cline.showLastDiff', () => {
      void reopenLastEditPreview().then(shown => {
        if (!shown) void vscode.window.showInformationMessage('还没有可显示的 DSH 变更')
      })
    }),
    vscode.commands.registerCommand('dsh-cline.cleanupDshProcesses', async () => {
      // Recovery for EADDRINUSE-bricked machines: bare `dsh web` defaults to
      // port 3080 and Windows keeps the process alive after its terminal
      // closes, so a leftover instance blocks every later launch (DSH Cline's
      // own port can be squatted the same way). Enumerate the live `dsh web`
      // node processes, let the user pick, kill, then revive our sidecar.
      let stdout = ''
      try {
        if (process.platform === 'win32') {
          const result = await execFile('powershell.exe', ['-NoProfile', '-Command',
            "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'dsh.+web' } | ForEach-Object { \"$($_.ProcessId)|$($_.CommandLine)\" }"],
            { windowsHide: true, timeout: 8_000 })
          stdout = result.stdout
        } else {
          const result = await execFile('sh', ['-lc',
            "ps -eo pid,command | grep -E 'dsh.+web' | grep -v grep || true"])
          stdout = result.stdout
        }
      } catch (err: unknown) {
        void vscode.window.showErrorMessage('枚举 DSH 进程失败：' + String(err))
        return
      }
      const entries: Array<{ pid: number, port: string, detail: string }> = []
      for (const line of stdout.split(/\r?\n/)) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        const [pidRaw, ...rest] = process.platform === 'win32' ? trimmed.split('|') : trimmed.split(/\s+/)
        const pid = Number(pidRaw)
        const cmd = rest.join(' ')
        if (!Number.isInteger(pid) || pid <= 0 || !/dsh.+web/.test(cmd)) continue
        const port = /--port[= ](\d+)/.exec(cmd)?.[1] ?? '3080(默认)'
        entries.push({ pid, port, detail: cmd.replace(/^.*bin\.js\s*/, '') })
      }
      if (entries.length === 0) {
        void vscode.window.showInformationMessage('没有发现运行中的 dsh web 进程。')
        return
      }
      const picks = await vscode.window.showQuickPick(
        entries.map(e => ({
          label: `PID ${String(e.pid)} · 端口 ${e.port}`,
          description: e.detail,
          pid: e.pid,
        })),
        { canPickMany: true, placeHolder: '选择要结束的残留 dsh web 进程（可多选；本扩展自己的服务也会被结束并自动重启）' },
      )
      if (picks === undefined || picks.length === 0) return
      let killed = 0
      for (const pick of picks) {
        try {
          if (process.platform === 'win32') await execFile('taskkill', ['/F', '/PID', String(pick.pid)], { windowsHide: true })
          else await execFile('kill', ['-9', String(pick.pid)])
          killed++
        } catch (err: unknown) {
          channel.appendLine('[cleanup] kill ' + String(pick.pid) + ' failed: ' + String(err))
        }
      }
      void vscode.window.showInformationMessage('已结束 ' + String(killed) + '/' + String(picks.length) + ' 个 DSH 进程，正在重启 DSH 服务…')
      sidecar.stop()
      void sidecar.restart().then(
        url => vscode.window.showInformationMessage('DSH 服务已就绪：' + url),
        (err: unknown) => vscode.window.showErrorMessage('DSH 服务重启失败：' + String(err)),
      )
    }),
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
      // restart picks up the listener settings.
      if (['dsh-cline.host', 'dsh-cline.port'].some(key => e.affectsConfiguration(key)) && sidecar.status().state !== 'stopped') {
        sidecar.restart().catch(() => { /* surfaced via status */ })
      }
    }),
    sidecar,
    view,
    status,
    channel,
    { dispose: () => { void bridge.dispose() } },
    { dispose: () => { void webProxy.dispose() } },
  )

  // Resolve the bridge URL before any sidecar launch can observe it; the dsh
  // runtime resolves lazily in the sidecar's pre-launch hook.
  return bridge.start().then(async url => {
    bridgeUrl = url
    await publishBridgeUrl(url)
  })
}

function portOf(url: string): string {
  try {
    return ':' + new URL(url).port
  } catch {
    return url
  }
}

/**
 * Exchange a Shengsuanyun OAuth callback code for an API key (ported from
 * cline-Chinese's handleShengSuanYunCallback) and deliver it to the DSH client
 * so the key field fills itself; the user still picks the model and saves.
 */
async function handleSsyCallback(uri: vscode.Uri, view: DshClineView, channel: vscode.OutputChannel, callbackUrl: string): Promise<void> {
  const path = uri.path.replace(/\/+$/, '')
  if (path !== '/ssy' && path !== '/shengsuanyun') return
  // vscode.Uri.query has NO leading '?': without prepending one, URL() parses
  // 'code=...' as a PATH and searchParams.get('code') is always null - which
  // is exactly the「回调缺少 code 参数」users hit.
  const code = new URL('?' + (uri.query ?? ''), 'https://x').searchParams.get('code')
  if (code === null || code === '') {
    void vscode.window.showErrorMessage('胜算云登录回调缺少 code 参数')
    return
  }
  let apiKey: string | undefined
  try {
    const response = await fetch('https://api.shengsuanyun.com/auth/keys', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Mark every Shengsuanyun-bound request as coming from DSH Cline.
        'X-title': 'DSH-Cline',
      },
      body: JSON.stringify({ code, callback_url: callbackUrl }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error('Key exchange HTTP ' + response.status)
    const body = await response.json() as { data?: { api_key?: unknown } }
    const key = body.data?.api_key
    if (typeof key === 'string' && key !== '') apiKey = key
  } catch (err: unknown) {
    channel.appendLine('[ssy-login] code exchange failed: ' + String(err))
  }
  if (apiKey === undefined) {
    void vscode.window.showErrorMessage('登录胜算云成功，但未获取到 API Key，请前往控制台手动创建。')
    return
  }
  view.broadcastToFrame({ channel: 'dsh-cline.ssy-key', apiKey })
  void vscode.window.showInformationMessage('胜算云授权已返回，请在「模型」页确认登录结果；首次添加需选择模型并保存。')
}
