/**
 * Diff mirror: drives a Cline-style PRE-WRITE edit preview in VS Code.
 *
 * It hooks the `tools/pre-execute` waterfall — the gateway every DSH tool call
 * passes through BEFORE its body runs. When the tool is a file-editing tool
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
 * `tools/pre-execute` is a CORDIS WATERFALL: each listener is called as
 * `(exec, next)` and a listener that does NOT call `next()` VETOES the rest of
 * the chain (including the native allow gate). So the begin side effect must be
 * registered with `prepend: true` (always runs before earlier-registered
 * listeners regardless of plugin load order) and must return `next()`.
 *
 * Purely presentational - nothing here reaches a model request or the session
 * log, and a failed preview never fails the write.
 *
 * @module @dsh-cline/host-services/diff-mirror
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import type { VscodeHostService } from './index.ts'

/** Tools whose input lets the extension compute the proposed file content. */
const PREVIEWABLE = new Set(['write', 'edit', 'str_replace_editor'])

/** The `ctx.on` surface we use; waterfall listeners get `next` as the last arg. */
type On = (name: string, listener: (...args: any[]) => any, options?: unknown) => unknown

interface ExecLike {
  name?: unknown
  arguments?: unknown
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
  // `tools/pre-execute` is a DSH runtime event not present in the cordis
  // typings; subscribe through a minimal untyped event surface.
  const events = ctx as unknown as { on: On }

  const hookPreExecute = (exec: ExecLike | undefined, next: (() => unknown) | undefined): unknown => {
    begin(exec, vscodeHost, ctx)
    return typeof next === 'function' ? next() : undefined
  }
  // prepend so the begin side effect always fires before any earlier-registered
  // pre-execute listener; without it, that listener returning first would shut
  // the chain off before we ever ran.
  events.on('tools/pre-execute', hookPreExecute as (...args: any[]) => any, { prepend: true })
}

/** Snapshot the pre-write content synchronously, then forward the edit-tool
 * execution (with that snapshot) to the extension to open a pre-write preview. */
function begin(exec: ExecLike | undefined, vscodeHost: VscodeHostService, ctx: Context): void {
  const tool = exec === null || typeof exec !== 'object' ? undefined : exec.name
  const args = exec === null || typeof exec !== 'object' ? undefined : exec.arguments
  if (typeof tool !== 'string' || !PREVIEWABLE.has(tool)) return
  if (args === null || typeof args !== 'object') return
  const rawPath = (args as Record<string, unknown>).file_path ?? (args as Record<string, unknown>).path
  if (typeof rawPath !== 'string' || rawPath === '') return

  // Capture the ORIGINAL content now, before next() releases the write. This
  // must be synchronous: an async read (or an extension-side read over the
  // bridge) races the tool's own write and can observe post-write content.
  // `original: undefined` tells the extension to read the disk itself (the
  // legacy path, kept for resolutions this process cannot see); '' means a
  // genuinely new file — only the create-style tools may treat ENOENT as new,
  // an `edit` hitting ENOENT here means the path resolved elsewhere.
  const mayCreate = tool === 'write' || (tool === 'str_replace_editor' && (args as Record<string, unknown>).command === 'create')
  let original: string | undefined
  try {
    const buf = readFileSync(rawPath)
    original = buf.length <= MAX_SNAPSHOT_BYTES ? buf.toString('utf8') : undefined
  } catch (err: unknown) {
    const code = (err as { code?: unknown }).code
    if (code === 'ENOENT' && mayCreate) original = ''
  }

  vscodeHost.call('vscode.diff', 'begin', [{ tool, args, original }]).catch((err: unknown) => {
    ctx.logger.warn('diff-mirror begin skipped: ' + String(err))
  })
}
