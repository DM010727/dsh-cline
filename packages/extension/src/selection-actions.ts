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

const MAX_MENTION_FILE_BYTES = 512 * 1024

/**
 * Cline-style @-mention expansion: replace each `@file` mention in the prompt
 * with `'file'(见下)` and append a `<file_content>` block carrying the file's
 * text, so the model has the referenced file as context. Bounded (skips binary
 * and oversized files).
 */
export async function expandMentions(prompt: string): Promise<string> {
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (cwd === undefined) return prompt
  const injectable: Array<{ token: string; path: string; content: string }> = []
  const seen = new Set<string>()
  let out = prompt.replace(/@(")?([^\s"'@]+)\1/g, (match, _quote: string, raw: string) => {
    const token = raw
    if (seen.has(token)) return match
    seen.add(token)
    const abs = path.isAbsolute(token) ? token : path.resolve(cwd, token)
    let content: string
    try {
      const st = fs.statSync(abs)
      if (!st.isFile() || st.size > MAX_MENTION_FILE_BYTES) return match
      const buf = fs.readFileSync(abs)
      if (buf.includes(0)) return match // binary
      content = buf.toString('utf8')
    } catch {
      return match
    }
    const rel = path.relative(cwd, abs).split(path.sep).join('/')
    injectable.push({ token: rel, path: '/' + rel, content })
    return `'/${rel}'(见下)`
  })
  for (const item of injectable) {
    out += `\n\n<file_content path="${item.path}">\n${item.content}\n</file_content>`
  }
  return out
}

/** POST a prompt to the DSH-side task route and return its result. */
export async function sendTask(prompt: string, dshUrl: string, cwd?: string): Promise<{ ok: boolean; error?: string }> {
  const base = dshUrl.replace(/\/+$/, '')
  try {
    const res = await fetch(base + '/dsh-cline/task', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: prompt, cwd }),
    })
    const data = await res.json() as { ok?: boolean; error?: string; sessionId?: string }
    return { ok: data.ok === true, error: data.error }
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
