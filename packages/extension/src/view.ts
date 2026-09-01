import * as vscode from 'vscode'
import type { SidecarManager } from './sidecar'
import type { RuntimeStatus } from '@dsh-cline/protocol'
import { buildShellHtml, buildGuideHtml, buildStartingHtml } from './shell'

/** Terminal-backed actions the onboarding guide page can trigger. */
export interface GuideActions {
  getRuntime(): Promise<RuntimeStatus>
  /** Open a visible terminal and run the global dsh install commands (npmmirror when useMirror). */
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
  private readonly disposables: vscode.Disposable[] = []

  constructor(
    private readonly sidecar: SidecarManager,
    private readonly actions: GuideActions,
    private readonly version = '',
  ) {
    this.disposables.push(
      sidecar.on('change', () => this.renderAll()),
    )
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view
    view.webview.options = { enableScripts: true }
    this.attach(view.webview)
    this.render(view.webview)
    void this.ensureStarted()
  }

  /** Open (or reveal) the editor panel hosting the same shell. */
  openPanel(): void {
    if (this.panel !== undefined) {
      this.panel.reveal()
      return
    }
    const panel = vscode.window.createWebviewPanel(
      'dsh-cline.panel',
      'DSH Cline',
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    )
    this.panel = panel
    this.attach(panel.webview)
    this.render(panel.webview)
    panel.onDidDispose(() => { this.panel = undefined })
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
    if (this.view !== undefined) void this.view.webview.postMessage(message)
    if (this.panel !== undefined) void this.panel.webview.postMessage(message)
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
    if (!rt.node || rt.via === 'none' || rt.via === 'npx-cache') {
      this.guide = rt
      this.renderAll()
      return
    }
    this.guide = undefined
    this.renderAll()
    void this.sidecar.start().catch(() => { /* state broadcast already surfaced */ })
  }

  private attach(webview: vscode.Webview): void {
    webview.onDidReceiveMessage(
      (msg: unknown) => {
        if (isGuideMessage(msg)) {
          if (msg.type === 'install' || msg.type === 'install-mirror') this.actions.installDsh(msg.type === 'install-mirror')
          else if (msg.type === 'install-node') this.actions.installNode()
          else if (msg.type === 'open-node-page') this.actions.openNodePage()
          else if (msg.type === 'show-terminal') this.actions.showTerminal()
          else if (msg.type === 'recheck') void this.ensureStarted()
          else if (msg.type === 'continue-anyway') {
            this.guide = undefined
            this.renderAll()
            void this.sidecar.restart().catch(() => { /* surfaced via status */ })
          }
          return
        }
        // Clipboard bridge from the DSH iframe (relayed on dsh-cline.host-service).
        // copy/cut write the captured text to the OS clipboard; paste reads it and
        // the payload is relayed back down via the shell's `bridge` channel so the
        // iframe client inserts it into the focused input.
        const c = msg as { channel?: string; type?: string; op?: string; text?: string }
        if (c.channel === 'dsh-cline.host-service' && c.type === 'clipboard') {
          if (c.op === 'paste') {
            void vscode.env.clipboard.readText().then(text => {
              webview.postMessage({ channel: 'dsh-cline.shell', type: 'bridge', payload: { channel: 'clipboard-result', op: 'paste', text } })
            })
          } else if (c.op === 'copy' || c.op === 'cut') {
            void vscode.env.clipboard.writeText(c.text ?? '')
          }
          return
        }
        if (!isShellMessage(msg)) return
        if (msg.type === 'shell-ready') {
          // Push the latest status in case the shell booted between renders.
          this.render(webview)
        }
        if (msg.type === 'retry') void this.sidecar.restart().catch(() => {})
      },
      undefined,
      this.disposables,
    )
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
