/**
 * Diff mirror: drives a Cline-style PRE-WRITE edit preview in VS Code.
 *
 * It hooks `tools/execute` after native approval and before the tool body.
 * When the tool is a file-editing tool
 * (`write` / `edit` / `str_replace_editor`), it forwards the raw tool input to
 * `vscode.diff.begin`, and the extension opens a diff (original on the left,
 * a virtual doc on the right that sweeps the change in) BEFORE the write lands.
 * So the change is visible as DSH is about to apply it, not after it finished.
 *
 * The pre-write file content is captured HERE, synchronously, before `next()`
 * releases the tool body. The bridge call itself is fire-and-forget — if the
 * extension read the disk itself, the write could land first and the "original"
 * would be the post-write content, making the diff blank (write) or failing to
 * compute (edit: old_string already replaced). Shipping the snapshot with the
 * payload eliminates that race without blocking the tool.
 *
 * `tools/execute` is a CORDIS WATERFALL: each listener is called as
 * `(exec, next)` and a listener that does NOT call `next()` VETOES the rest of
 * the chain. The display side effect always delegates to `next()`.
 *
 * Purely presentational - nothing here reaches a model request or the session
 * log, and a failed preview never fails the write.
 *
 * @module @dsh-cline/host-services/diff-mirror
 */

import { closeSync, fstatSync, openSync, readSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { VscodeHostService } from './index.js'
import { executionCwd, isWithinWorkspace, type AgentContext } from './workspace-context.js'

/** Tools whose input lets the extension compute the proposed file content. */
const PREVIEWABLE = new Set(['write', 'edit', 'str_replace_editor'])

/** The `ctx.on` surface we use; waterfall listeners get `next` as the last arg. */
type On = (name: string, listener: (...args: any[]) => any, options?: unknown) => unknown

interface ExecLike {
  name?: unknown
  arguments?: unknown
  agent?: AgentContext
}

/** Cap the snapshot size forwarded over the bridge (oversized files skip the preview). */
const MAX_SNAPSHOT_BYTES = 4 * 1024 * 1024

/**
 * Register the pre-write diff mirror. Every file-editing tool call opens a diff
 * preview that sweeps the change in as the write is applied; a failed preview
 * never fails the write.
 * @param ctx - plugin context (event + logging).
 * @param vscodeHost - the bridge-provided service executing the show.
 */
export function registerDiffMirror(ctx: Context, vscodeHost: VscodeHostService): void {
  // Keep the observer independent of the concrete dispatch result schema.
  const events = ctx as unknown as { on: On }

  const hookExecute = (exec: ExecLike | undefined, next: (() => unknown) | undefined): unknown => {
    begin(exec, vscodeHost, ctx)
    return typeof next === 'function' ? next() : undefined
  }
  // Run after native approval has allowed execution, immediately before the
  // actual tool. Previewing in pre-execute also showed rejected tool calls.
  events.on('tools/execute', hookExecute as (...args: any[]) => any)
}

/** Snapshot the pre-write content synchronously, then forward the edit-tool
 * execution (with that snapshot) to the extension to open a pre-write preview. */
function begin(exec: ExecLike | undefined, vscodeHost: VscodeHostService, ctx: Context): void {
  const tool = exec === null || typeof exec !== 'object' ? undefined : exec.name
  const args = exec === null || typeof exec !== 'object' ? undefined : exec.arguments
  if (typeof tool !== 'string' || !PREVIEWABLE.has(tool)) return
  if (args === null || typeof args !== 'object') return
  const rawPath = (args as Record<string, unknown>).file_path ?? (args as Record<string, unknown>).filePath ?? (args as Record<string, unknown>).path
  if (typeof rawPath !== 'string' || rawPath === '') return
  let filePath: string
  try {
    const cwd = executionCwd(ctx, exec?.agent)
    if (!isWithinWorkspace(cwd)) return
    filePath = resolve(cwd, rawPath)
    if (!isWithinWorkspace(filePath)) return
  } catch { return }
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_SNAPSHOT_BYTES) return

  // Capture the ORIGINAL content now, before next() releases the write. This
  // must be synchronous: an async read (or an extension-side read over the
  // bridge) races the tool's own write and can observe post-write content.
  // '' means a genuinely new file; unreadable or oversized originals skip
  // preview instead of asking the extension to race a later disk read.
  const mayCreate = tool === 'write' || (tool === 'str_replace_editor' && (args as Record<string, unknown>).command === 'create')
  let original: string | undefined
  try {
    original = readSnapshot(filePath)
  } catch (err: unknown) {
    const code = (err as { code?: unknown }).code
    if (code === 'ENOENT' && mayCreate) original = ''
  }
  // Never fall back to a later disk read: it would race the dispatched write.
  if (original === undefined) return

  const normalized = { ...(args as Record<string, unknown>), file_path: filePath }
  vscodeHost.call('vscode.diff', 'begin', [{ tool, args: normalized, original }]).catch((err: unknown) => {
    ctx.logger.warn('diff-mirror begin skipped: ' + String(err))
  })
}

/** Limit the read itself, and skip binary/special files instead of blocking. */
function readSnapshot(path: string): string | undefined {
  const stat = statSync(path)
  if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) return undefined
  const fd = openSync(path, 'r')
  try {
    const current = fstatSync(fd)
    if (!current.isFile() || current.size > MAX_SNAPSHOT_BYTES) return undefined
    const buffer = Buffer.alloc(Math.min(current.size + 1, MAX_SNAPSHOT_BYTES + 1))
    let length = 0
    for (;;) {
      if (length === buffer.length) return undefined // file grew while being read
      const count = readSync(fd, buffer, length, buffer.length - length, null)
      if (count === 0) break
      length += count
    }
    const content = buffer.subarray(0, length)
    return content.includes(0) ? undefined : content.toString('utf8')
  } finally { closeSync(fd) }
}
