import * as vscode from 'vscode'
import type { BridgeServer } from './bridge'
import { openEditPreview } from './edit-preview'

/** Diff payload the DSH diff mirror forwards (`vscode.diff.show`). */
interface DiffShowPayload {
  title: string
  fileName: string
  language: string
  leftText: string
  rightText: string
}

/** open/reveal payload (`vscode.editor.open`, `vscode.explorer.reveal`). */
interface PathPayload {
  path: string
  line?: number
}

/** Resolve a model-supplied path against the workspace; absolute paths pass through. */
function resolvePath(path: string): vscode.Uri {
  if (/^([a-zA-Z]:[\\/]|\\\\|\/)/.test(path)) return vscode.Uri.file(path)
  const root = vscode.workspace.workspaceFolders?.[0]?.uri
  if (root === undefined) throw new Error('no workspace folder open; pass an absolute path')
  return vscode.Uri.joinPath(root, path)
}

/** Optional host actions the web「DSH Cline」section can trigger. */
export interface HostActions {
  /** Restart the terminal-resident DSH service (sidecar manager). */
  restartDsh?(): void
}

/**
 * Registers every vscode.* handler the DSH side can call this gate. Grows per
 * gate; unknown keys stay a 404 on the bridge by design.
 * @param bridge - the bridge server to register handlers on.
 * @param extensionVersion - version reported by the ping probe.
 * @param actions - late-wired host actions (the sidecar is created after the
 *   bridge starts, so callers pass a getter-style indirection when needed).
 */
export function registerHandlers(bridge: BridgeServer, extensionVersion: string, actions?: HostActions): void {
  bridge.handle('vscode.host.ping', async () => ({ pong: true, extensionVersion }))

  // Cline-style pre-write edit preview. DSH intercepts the edit tool call in
  // `tools/pre-execute` and sends `vscode.diff.begin {tool, args}` BEFORE the write
  // lands; the extension reads the on-disk original, computes the proposed content
  // from the tool input, and opens a diff whose right side sweeps the change in — so
  // the user sees it "written" as DSH is about to apply it, not after the fact.
  bridge.handle('vscode.diff.begin', async args => {
    const [payload] = args as [{ tool?: unknown; args?: unknown; original?: unknown }]
    const tool = payload === null || typeof payload !== 'object' ? undefined : payload.tool
    const toolArgs = payload === null || typeof payload !== 'object' ? undefined : payload.args
    if (typeof tool !== 'string' || tool === '') throw new Error('tool is required')
    const target = toolArgs === null || typeof toolArgs !== 'object' ? undefined : toolArgs as Record<string, unknown>
    const rawPath = target === undefined ? undefined : (target.file_path ?? target.path)
    if (typeof rawPath !== 'string' || rawPath === '') throw new Error('file path is required')
    const uri = resolvePath(rawPath)
    // The host side snapshots the PRE-WRITE content synchronously before the
    // write is released (racing the write extension-side can observe post-write
    // content: a blank diff for `write`, a failed compute for `edit`). An
    // undefined snapshot falls back to reading the disk here.
    let original: string
    if (typeof payload?.original === 'string') {
      original = payload.original
    } else {
      original = ''
      try {
        original = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')
      } catch { /* new file: diff against empty */ }
    }
    const computed = computeNewContent(tool, original, target ?? {})
    if (!computed.ok) throw new Error(computed.error ?? 'cannot preview this edit')
    await openEditPreview({ path: uri.fsPath, leftContent: original, rightContent: computed.content })
    return { begun: uri.fsPath, tool }
  })

  // In-GUI「重启 DSH 服务」button: the DSH side answers the browser first, so
  // this call may arrive just before its own process is interrupted - do the
  // restart asynchronously and return at once.
  bridge.handle('vscode.dsh.restart', async () => {
    if (actions?.restartDsh === undefined) throw new Error('sidecar manager not wired')
    actions.restartDsh()
    return { restarting: true }
  })

  bridge.handle('vscode.window.info', async args => {
    const [message] = args as [string]
    void vscode.window.showInformationMessage(String(message))
    return { shown: true }
  })

  bridge.handle('vscode.window.warn', async args => {
    const [message] = args as [string]
    void vscode.window.showWarningMessage(String(message))
    return { shown: true }
  })

  bridge.handle('vscode.diff.show', async args => {
    const [payload] = args as [DiffShowPayload]
    const cfg = vscode.workspace.getConfiguration('dsh-cline')
    if (cfg.get<boolean>('diffOnEdit') === false) return { shown: false, reason: 'disabled' }
    if (payload === undefined || typeof payload.leftText !== 'string' || typeof payload.rightText !== 'string') {
      throw new Error('invalid diff payload')
    }
    const language = typeof payload.language === 'string' && payload.language !== '' ? payload.language : 'plaintext'
    const left = await vscode.workspace.openTextDocument({ language, content: payload.leftText })
    const right = await vscode.workspace.openTextDocument({ language, content: payload.rightText })
    await vscode.commands.executeCommand('vscode.diff', left.uri, right.uri, payload.title ?? 'DSH diff', {
      preview: true,
      preserveFocus: true,
    })
    return { shown: true }
  })

  bridge.handle('vscode.editor.open', async args => {
    const [payload] = args as [PathPayload]
    if (payload === undefined || typeof payload.path !== 'string' || payload.path === '') {
      throw new Error('path is required')
    }
    const uri = resolvePath(payload.path)
    const line = typeof payload.line === 'number' && payload.line >= 1 ? payload.line - 1 : undefined
    await vscode.window.showTextDocument(uri, {
      preview: true,
      preserveFocus: false,
      selection: line === undefined ? undefined : new vscode.Range(line, 0, line, 0),
    })
    return { opened: uri.fsPath }
  })

  bridge.handle('vscode.explorer.reveal', async args => {
    const [payload] = args as [PathPayload]
    if (payload === undefined || typeof payload.path !== 'string' || payload.path === '') {
      throw new Error('path is required')
    }
    const uri = resolvePath(payload.path)
    await vscode.commands.executeCommand('revealInExplorer', uri)
    return { revealed: uri.fsPath }
  })

  bridge.handle('vscode.browser.openExternal', async args => {
    const [payload] = args as [{ url?: unknown }]
    if (payload === undefined || typeof payload.url !== 'string' || !/^https?:\/\//.test(payload.url)) {
      throw new Error('url must be http(s)')
    }
    const ok = await vscode.env.openExternal(vscode.Uri.parse(payload.url))
    return { opened: ok }
  })

  bridge.handle('vscode.editor.getActive', async () => {
    const editor = vscode.window.activeTextEditor
    if (editor === undefined) return { active: false }
    const selection = editor.selection
    return {
      active: true,
      file: editor.document.uri.fsPath,
      language: editor.document.languageId,
      line: selection.active.line + 1,
      column: selection.active.character + 1,
      selectionText: editor.document.getText(selection).slice(0, 2000),
    }
  })

  // P1 selection integration: DSH reads the current selection (getActive) and can
  // write generated text (explanation / completion) back into it. The replace lands
  // in the active editor's current selection if present.
  bridge.handle('vscode.editor.applySelection', async args => {
    const [payload] = args as [{ text?: unknown }]
    const text = payload === null || typeof payload !== 'object' ? undefined : payload.text
    if (typeof text !== 'string') throw new Error('text is required')
    const editor = vscode.window.activeTextEditor
    if (editor === undefined) return { applied: false, reason: 'no active editor' }
    await editor.edit(edit => edit.replace(editor.selection, text))
    return { applied: true, file: editor.document.uri.fsPath }
  })

  // Settings page in the DSH web UI reads/writes dsh-cline.* configuration
  // through these; keys stay restricted to the extension's own namespace.
  bridge.handle('vscode.config.get', async args => {
    const [key] = args as [string]
    if (typeof key !== 'string' || !/^[\w.-]+$/.test(key)) throw new Error('invalid config key')
    return { key, value: vscode.workspace.getConfiguration('dsh-cline').get(key) }
  })

  bridge.handle('vscode.config.update', async args => {
    const [key, value] = args as [string, unknown]
    if (typeof key !== 'string' || !/^[\w.-]+$/.test(key)) throw new Error('invalid config key')
    // The inspection default is treated as "unset" so the UI round-trips the
    // shipped default instead of baking it in as a user override.
    const inspect = vscode.workspace.getConfiguration('dsh-cline').inspect(key)
    const equalsDefault = value === (inspect?.defaultValue as unknown)
      || (value === undefined && inspect?.defaultValue === undefined)
    const target = vscode.ConfigurationTarget.Global
    await vscode.workspace.getConfiguration('dsh-cline').update(key, equalsDefault ? undefined : value, target)
    return { key, value: equalsDefault ? inspect?.defaultValue : value }
  })
}

/** Mirrors the SDK editor executor's line-ending normalization. */
function normalizeLineEndings(text: string, eol: '\r\n' | '\n'): string {
  return text.split(/\r\n|\n/).join(eol)
}

/** Detects the file's EOL: "\r\n" if it appears anywhere, else "\n". */
function detectLineEnding(content: string): '\r\n' | '\n' {
  return content.includes('\r\n') ? '\r\n' : '\n'
}

/**
 * Compute the full post-edit file content for the DSH write/edit tools from the
 * raw tool input, mirroring each tool's own semantics so the preview shows exactly
 * what the write will produce. Unsupported tools / inputs return `ok: false` (the
 * preview call then skips instead of guessing).
 */
function computeNewContent(
  tool: string,
  original: string,
  args: Record<string, unknown>,
): { ok: true; content: string } | { ok: false; error?: string } {
  // fs `write`: full content replaces the file.
  if (tool === 'write') {
    if (typeof args.content !== 'string') return { ok: false, error: 'write requires content' }
    return { ok: true, content: args.content }
  }
  // fs `edit`: literal old_string -> new_string (replace_all optional).
  if (tool === 'edit') {
    const oldText = args.old_string
    const newText = args.new_string
    if (typeof oldText !== 'string' || typeof newText !== 'string') {
      return { ok: false, error: 'edit requires old_string and new_string' }
    }
    const eol = detectLineEnding(original)
    const oldN = normalizeLineEndings(oldText, eol)
    const newN = normalizeLineEndings(newText, eol)
    const occurrences = original.split(oldN).length - 1
    const replaceAll = args.replace_all === true
    if (occurrences === 0) return { ok: false, error: 'edit: text not found' }
    if (occurrences > 1 && !replaceAll) return { ok: false, error: 'edit: multiple matches (set replace_all)' }
    return { ok: true, content: replaceAll ? original.split(oldN).join(newN) : original.replace(oldN, () => newN) }
  }
  // str_replace_editor: create / str_replace / insert.
  if (tool === 'str_replace_editor') {
    const command = args.command
    if (command === 'create') {
      if (typeof args.new_str !== 'string') return { ok: false, error: 'create requires new_str' }
      return { ok: true, content: args.new_str }
    }
    if (command === 'str_replace') {
      const oldStr = args.old_str
      const newStr = args.new_str
      if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
        return { ok: false, error: 'str_replace requires old_str and new_str' }
      }
      const occurrences = original.split(oldStr).length - 1
      if (occurrences === 0 || occurrences > 1) return { ok: false, error: 'str_replace: not found or ambiguous' }
      return { ok: true, content: original.replace(oldStr, () => newStr) }
    }
    if (command === 'insert') {
      const insertLine = args.insert_line
      const newStr = args.new_str
      if (typeof insertLine !== 'number' || typeof newStr !== 'string') {
        return { ok: false, error: 'insert requires insert_line and new_str' }
      }
      const eol = detectLineEnding(original)
      const lines = original.split(/\r\n|\n/)
      const boundary = lines.length + 1
      if (insertLine < 1 || insertLine > boundary) return { ok: false, error: 'insert_line out of range' }
      lines.splice(insertLine - 1, 0, ...newStr.split(/\r\n|\n/))
      return { ok: true, content: lines.join(eol) }
    }
    return { ok: false, error: 'str_replace_editor command not previewable: ' + String(command) }
  }
  return { ok: false, error: 'tool not previewable: ' + tool }
}
