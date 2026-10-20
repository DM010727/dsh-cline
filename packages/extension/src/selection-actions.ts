/**
 * Selection actions: the VS Code half of "用 DSH Cline 解释 / 优化 / 添加到
 * DSH Cline". These are the editor context-menu commands Cline ships
 * (`addToChat` / `explainCode` / `improveCode`), adapted to DSH.
 *
 * Each command captures the active selection, builds a prompt (selected code +
 * an @-file mention + the selection's diagnostics), expands @-mentions into real
 * file content (Cline's `parseMentions` behavior: `@path` -> `'path'(见下)` in
 * the prompt + a trailing `<file_content>` block), and POSTs it to the DSH-side
 * `/dsh-cline/task` route, which injects it into the conversation the user is
 * currently viewing. The reply streams into that DSH chat.
 *
 * @module @dsh-cline/extension/selection-actions
 */

import * as vscode from 'vscode'
import * as fs from 'node:fs'
import * as path from 'node:path'

/** A captured editor selection for one action. */
export interface SelectionContext {
  selectedText: string
  filePath: string
  language: string
}

export type SelectionAction = 'explain' | 'improve' | 'add'

/** Capture the active editor's selection. Undefined when nothing is selected. */
export function getSelectionContext(): SelectionContext | undefined {
  const editor = vscode.window.activeTextEditor
  if (editor === undefined) return undefined
  const selectedText = editor.document.getText(editor.selection)
  if (selectedText.trim() === '') return undefined
  return {
    selectedText,
    filePath: editor.document.uri.fsPath,
    language: editor.document.languageId,
  }
}

/** Cline-style `@/relative/path` file mention from an absolute path. */
function fileMention(filePath: string): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  const rel = root === undefined ? filePath : path.relative(root, filePath)
  const posix = rel.split(path.sep).join('/')
  const mention = '/' + posix
  return mention.includes(' ') ? `@"${mention}"` : `@${mention}`
}

/** Build the prompt Cline's three commands compose. */
export function buildPrompt(action: SelectionAction, ctx: SelectionContext): string {
  const mention = fileMention(ctx.filePath)
  const lang = ctx.language || 'plaintext'
  if (action === 'explain') {
    return `Explain the following code from ${mention}:\n\`\`\`${lang}\n${ctx.selectedText}\n\`\`\``
  }
  if (action === 'improve') {
    return `Improve the following code from ${mention} (e.g., suggest refactorings, optimizations, or better practices):\n\`\`\`${lang}\n${ctx.selectedText}\n\`\`\``
  }
  // add: just put the selection (with its file mention) into the DSH chat.
  return `${mention}\n\`\`\`\n${ctx.selectedText}\n\`\`\``
}

/** Diagnostics intersecting the current selection, as a "Problems:" block. */
function selectionProblems(): string | undefined {
  const editor = vscode.window.activeTextEditor
  if (editor === undefined) return undefined
  const uri = editor.document.uri
  const diags = vscode.languages.getDiagnostics(uri)
    .filter(d => d.range.intersection(editor.selection) !== undefined)
  if (diags.length === 0) return undefined
  const lines = diags.map(d => `- ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`)
  return 'Problems:\n' + lines.join('\n')
}

const MAX_MENTION_FILE_BYTES = 48 * 1024
const MAX_PROMPT_BYTES = 60 * 1024

/**
 * Cline-style @-mention expansion: replace each `@file` mention in the prompt
 * with `'file'(见下)` and append a `<file_content>` block carrying the file's
 * text, so the model has the referenced file as context. Bounded (skips binary
 * and oversized files).
 */
export async function expandMentions(prompt: string): Promise<string> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (cwd === undefined) return prompt
  const root = await fs.promises.realpath(cwd)
  const seen = new Set<string>()
  const replacements: Array<{ start: number; end: number; text: string }> = []
  const injected: string[] = []
  let bytes = Buffer.byteLength(prompt)
  for (const match of prompt.matchAll(/(?<![\w.])@(?:"([^"\r\n]+)"|([^\s"'@`<>]+))/g)) {
    const token = match[1] ?? match[2]
    // Cline's @/foo means workspace-relative, including on Windows.
    const candidate = path.resolve(cwd, token.startsWith('/') ? token.slice(1) : token)
    try {
      const abs = await fs.promises.realpath(candidate)
      const relative = path.relative(root, abs)
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || seen.has(abs)) continue
      const st = await fs.promises.stat(abs)
      if (!st.isFile() || st.size > MAX_MENTION_FILE_BYTES || bytes + st.size > MAX_PROMPT_BYTES) continue
      const buf = await fs.promises.readFile(abs)
      if (buf.includes(0)) continue
      const rel = relative.split(path.sep).join('/')
      const block = `\n\n<file_content path=${JSON.stringify('/' + rel)}>\n${buf.toString('utf8')}\n</file_content>`
      if (bytes + Buffer.byteLength(block) > MAX_PROMPT_BYTES) continue
      bytes += Buffer.byteLength(block)
      seen.add(abs)
      replacements.push({ start: match.index!, end: match.index! + match[0].length, text: `'/${rel}'(见下)` })
      injected.push(block)
    } catch { /* absent, unreadable, or outside workspace: keep the mention */ }
  }
  let out = prompt
  for (const replacement of replacements.reverse()) {
    out = out.slice(0, replacement.start) + replacement.text + out.slice(replacement.end)
  }
  return out + injected.join('')
}

/** POST a prompt to the DSH-side task route and return its result. */
export async function sendTask(prompt: string, dshUrl: string, cwd?: string): Promise<{ ok: boolean; error?: string; sessionId?: string }> {
  const base = dshUrl.replace(/\/+$/, '')
  if (Buffer.byteLength(JSON.stringify({ content: prompt, cwd })) > 64 * 1024) return { ok: false, error: '所选内容超过 64 KiB，请缩小选择范围。' }
  try {
    const res = await fetch(base + '/dsh-cline/task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: prompt, cwd }),
      signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) return { ok: false, error: 'DSH task HTTP ' + res.status }
    const data = await res.json() as { ok?: boolean; error?: string; sessionId?: string }
    return { ok: data.ok === true, error: data.error, sessionId: data.sessionId }
  } catch (err: unknown) {
    return { ok: false, error: String(err) }
  }
}

/** Compose the full request for one action: prompt + mention expansion + problems. */
export async function buildTaskPrompt(action: SelectionAction, ctx: SelectionContext): Promise<string> {
  let prompt = buildPrompt(action, ctx)
  prompt = await expandMentions(prompt)
  const problems = selectionProblems()
  if (problems !== undefined) prompt += `\n${problems}`
  return prompt
}
