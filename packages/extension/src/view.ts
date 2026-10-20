import * as vscode from 'vscode'
import type { SidecarManager } from './sidecar'
import type { RuntimeStatus } from '@dsh-cline/protocol'
import { buildShellHtml, buildGuideHtml, buildStartingHtml } from './shell'

/** Terminal-backed actions the onboarding guide page can trigger. */
export interface GuideActions {
  getRuntime(): Promise<RuntimeStatus>
  /** Install the dependency-pinned isolated runtime in a visible terminal. */
  installDsh(useMirror: boolean): void
  /** Open a visible terminal and install Node.js via winget. */
  installNode(): void
  /** Open the Node.js download page in the browser. */
  openNodePage(): void
  /** Reveal the terminal the DSH service runs in. */
  showTerminal(): void
}

/**
 * Surfaces the DSH web client twice: the activity-bar sidebar webview and an
 * editor panel. Both share one SidecarManager; every state change re-renders
 * the live surfaces, and shell retry messages restart the sidecar. When the
 * dsh runtime is missing (or only present via the npx cache), the surfaces
 * show the onboarding guide instead of ever starting the sidecar.
 */
export class DshClineView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'dsh-cline.sidebar'

  private view?: vscode.WebviewView
  private panel?: vscode.WebviewPanel
  /** Set while a surface shows the onboarding guide; shell mode otherwise. */
  private guide?: RuntimeStatus
  /** Last html pushed per surface: identical content is skipped, so a webview
   * never reloads (and never restarts its iframe) for a no-op re-render. */
  private readonly lastHtml = new WeakMap<vscode.Webview, string>()
  private readonly readyFrames = new WeakSet<vscode.Webview>()
  private readonly pendingSessions = new WeakMap<vscode.Webview, string>()
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly sidecar: SidecarManager,
    private readonly actions: GuideActions,
    private readonly version = '',
  ) {
    const render = (): void => this.renderAll()
    sidecar.on('change', render)
    this.disposables.push({ dispose: () => { sidecar.off('change', render) } })
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    const messages = this.attach(view.webview)
    const visibility = view.onDidChangeVisibility?.(() => {
      if (view.visible) { this.activateWorkspace(view.webview); this.openPanel() }
    })
    view.onDidDispose(() => { messages.dispose(); visibility?.dispose(); if (this.view === view) this.view = undefined })
    this.render(view.webview)
    this.openPanel()
  }

  /** Launch beside the code; reuse the panel and preserve existing multi-group layouts. */
  openPanel(): void {
    if (this.panel !== undefined) {
      this.panel.reveal()
      this.activateWorkspace(this.panel.webview)
      return
    }
    const groupCount = vscode.window.tabGroups.all.length
    const panel = vscode.window.createWebviewPanel(
      'dsh-cline.panel',
      'DSH Cline',
      groupCount <= 1 ? vscode.ViewColumn.Two : vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    )
    this.panel = panel
    // Only the initial single-editor layout is ours to split. A later reveal
    // must not resize groups the user has adjusted, or create another panel.
    if (groupCount <= 1) {
      void vscode.commands.executeCommand('vscode.setEditorLayout', {
        orientation: 0, groups: [{ size: 0.5 }, { size: 0.5 }],
      }).then(undefined, () => { /* panel remains usable if layout is unavailable */ })
    }
    const messages = this.attach(panel.webview)
    let visible = panel.visible
    const visibility = panel.onDidChangeViewState?.(event => {
      if (event.webviewPanel.visible && !visible) this.activateWorkspace(panel.webview)
      visible = event.webviewPanel.visible
    })
    this.render(panel.webview)
    panel.onDidDispose(() => { messages.dispose(); visibility?.dispose(); this.panel = undefined })
    void this.ensureStarted()
  }

  /**
   * Push one payload down into the DSH iframe on every live surface (the shell
   * relays `dsh-cline.shell/bridge` messages into the frame). Used by the
   * Shengsuanyun OAuth flow to deliver a freshly exchanged API key to the
   * client plugin, which fills it into the key field like a manual paste.
   */
  broadcastToFrame(payload: Record<string, unknown>): void {
    const message = { channel: 'dsh-cline.shell', type: 'bridge', payload }
    const send = (webview: vscode.Webview): void => {
      if (payload.channel === 'dsh-cline.open-session' && typeof payload.sessionId === 'string' && !this.readyFrames.has(webview)) {
        this.pendingSessions.set(webview, payload.sessionId)
        return
      }
      void webview.postMessage(message)
    }
    if (this.view !== undefined) send(this.view.webview)
    if (this.panel !== undefined) send(this.panel.webview)
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose()
    this.panel?.dispose()
    this.view = undefined
  }

  /**
   * Decide between guide and shell: detect the runtime, show the guide when
   * Node is missing, dsh is nowhere, or dsh is only in the npx cache; start
   * the sidecar only once a runtime is actually usable.
   */
  private async ensureStarted(): Promise<void> {
    const rt = await this.actions.getRuntime()
    if (!rt.node || rt.via === 'none' || rt.via === 'npx-cache' || rt.compatible === false) {
      this.guide = rt
      this.renderAll()
      return
    }
    this.guide = undefined
    this.renderAll()
    void this.sidecar.start().catch(() => { /* state broadcast already surfaced */ })
  }

  private attach(webview: vscode.Webview): vscode.Disposable {
    return webview.onDidReceiveMessage(
      (msg: unknown) => {
        if (msg === null || typeof msg !== 'object') return
        if (isGuideMessage(msg)) {
          if (msg.type === 'install' || msg.type === 'install-mirror') this.actions.installDsh(msg.type === 'install-mirror')
          else if (msg.type === 'install-node') this.actions.installNode()
          else if (msg.type === 'open-node-page') this.actions.openNodePage()
          else if (msg.type === 'show-terminal') this.actions.showTerminal()
          else if (msg.type === 'recheck') void this.ensureStarted()
          return
        }
        // Clipboard bridge from the DSH iframe (relayed on dsh-cline.host-service).
        // copy/cut write the captured text to the OS clipboard; paste reads it and
        // the payload is relayed back down via the shell's `bridge` channel so the
        // iframe client inserts it into the focused input.
        const c = msg as { channel?: string; type?: string; op?: string; text?: unknown; requestId?: unknown }
        if (c.channel === 'dsh-cline.host-service' && c.type === 'client-ready') {
          if (this.readyFrames.has(webview)) return
          this.readyFrames.add(webview)
          const sessionId = this.pendingSessions.get(webview)
          if (sessionId !== undefined) {
            this.pendingSessions.delete(webview)
            void webview.postMessage({ channel: 'dsh-cline.shell', type: 'bridge', payload: { channel: 'dsh-cline.open-session', sessionId } })
          } else this.activateWorkspace(webview)
          return
        }
        if (c.channel === 'dsh-cline.host-service' && c.type === 'clipboard') {
          if (typeof c.requestId !== 'string' || c.requestId.length > 128 || !['paste', 'copy', 'cut'].includes(c.op ?? '')) return
          const reply = (ok: boolean, text?: string): void => {
            void webview.postMessage({ channel: 'dsh-cline.shell', type: 'bridge', payload: {
              channel: 'clipboard-result', op: c.op, requestId: c.requestId, ok, ...(text === undefined ? {} : { text }),
            } })
          }
          if (c.op === 'paste') void vscode.env.clipboard.readText().then(text => reply(true, text), () => reply(false))
          else if (typeof c.text === 'string' && c.text.length <= 4 * 1024 * 1024) {
            void vscode.env.clipboard.writeText(c.text).then(() => reply(true), () => reply(false))
          } else reply(false)
          return
        }
        if (!isShellMessage(msg)) return
        if (msg.type === 'shell-ready') {
          // Push the latest status in case the shell booted between renders.
          this.render(webview)
        }
        if (msg.type === 'retry') void this.sidecar.restart().catch(() => {})
      },
    )
  }

  /** Reopening a retained surface selects this window's project, not another recent project. */
  private activateWorkspace(webview: vscode.Webview): void {
    if (!this.readyFrames.has(webview)) return
    void webview.postMessage({ channel: 'dsh-cline.shell', type: 'bridge', payload: { channel: 'dsh-cline.open-workspace' } })
  }

  private renderAll(): void {
    if (this.view !== undefined) this.render(this.view.webview)
    if (this.panel !== undefined) this.render(this.panel.webview)
  }

  private render(webview: vscode.Webview): void {
    let html: string
    if (this.guide !== undefined) {
      html = buildGuideHtml(this.guide, this.version)
    } else {
      // Startup (and post-death auto-revive) gets its own guide-style page: the
      // first boot can take a minute or two, and the user must know it happens
      // in a visible terminal they should not close.
      const status = this.sidecar.status()
      html = status.state === 'starting'
        ? buildStartingHtml(status, this.version)
        : buildShellHtml(status, this.version)
    }
    if (this.lastHtml.get(webview) === html) return
    this.lastHtml.set(webview, html)
    this.readyFrames.delete(webview)
    webview.html = html
  }
}

interface ShellMessage {
  channel: string
  type: string
}

function isShellMessage(msg: unknown): msg is ShellMessage {
  if (typeof msg !== 'object' || msg === null) return false
  const m = msg as { channel?: unknown; type?: unknown }
  return m.channel === 'dsh-cline.shell' && typeof m.type === 'string'
}

function isGuideMessage(msg: unknown): msg is ShellMessage {
  if (typeof msg !== 'object' || msg === null) return false
  const m = msg as { channel?: unknown; type?: unknown }
  return m.channel === 'dsh-cline.guide' && typeof m.type === 'string'
}
