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
import type { Context } from '@deepseek-ai/cordis';
import type { VscodeHostService } from './index.ts';
/**
 * Register the pre-write diff mirror. Every file-editing tool call opens a diff
 * preview that sweeps the change in as the write is applied; a failed preview
 * never fails the write.
 * @param ctx - plugin context (event + logging).
 * @param vscodeHost - the bridge-provided service executing the show.
 */
export declare function registerDiffMirror(ctx: Context, vscodeHost: VscodeHostService): void;
