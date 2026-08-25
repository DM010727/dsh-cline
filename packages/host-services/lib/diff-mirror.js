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
/** Tools whose input lets the extension compute the proposed file content. */
const PREVIEWABLE = new Set(['write', 'edit', 'str_replace_editor']);
/**
 * Register the pre-write diff mirror. Every file-editing tool call opens a diff
 * preview that sweeps the change in as the write is applied; a failed preview
 * never fails the write.
 * @param ctx - plugin context (event + logging).
 * @param vscodeHost - the bridge-provided service executing the show.
 */
export function registerDiffMirror(ctx, vscodeHost) {
    // `tools/pre-execute` is a DSH runtime event not present in the cordis
    // typings; subscribe through a minimal untyped event surface.
    const events = ctx;
    const hookPreExecute = (exec, next) => {
        begin(exec, vscodeHost, ctx);
        return typeof next === 'function' ? next() : undefined;
    };
    // prepend so the begin side effect always fires before any earlier-registered
    // pre-execute listener; without it, that listener returning first would shut
    // the chain off before we ever ran.
    events.on('tools/pre-execute', hookPreExecute, { prepend: true });
}
/** Forward an edit-tool execution to the extension to open a pre-write preview. */
function begin(exec, vscodeHost, ctx) {
    const tool = exec === null || typeof exec !== 'object' ? undefined : exec.name;
    const args = exec === null || typeof exec !== 'object' ? undefined : exec.arguments;
    if (typeof tool !== 'string' || !PREVIEWABLE.has(tool))
        return;
    if (args === null || typeof args !== 'object')
        return;
    const rawPath = args.file_path ?? args.path;
    if (typeof rawPath !== 'string' || rawPath === '')
        return;
    vscodeHost.call('vscode.diff', 'begin', [{ tool, args }]).catch((err) => {
        ctx.logger.warn('diff-mirror begin skipped: ' + String(err));
    });
}
