/**
 * Selection-actions injector: turns a VS Code "用 DSH Cline 解释/优化" or
 * "添加到 DSH Cline" context-menu action into a DSH conversation turn.
 *
 * The extension builds a prompt (selected code + file mention + diagnostics),
 * expands @-mentions, and POSTs it to this plugin's `/dsh-cline/task` route.
 * The plugin injects the prompt into the DSH session the user is CURRENTLY
 * looking at (the frontend-subscribed session), so the reply streams into the
 * conversation they're viewing — Cline's "show result in the chat" behavior,
 * not a detached one-shot.
 *
 * To know which session is current, the plugin observes the DSH event bus with
 * `global: true` (bypassing agent-context filtering) and records the most recent
 * session id seen from session/turn/user activity. The frontend-subscribed
 * session is the one emitting these, so the last-seen id is the active
 * conversation. If none is known yet, the route answers a clear error instead
 * of guessing (an orphan session's reply would never be seen by the user).
 *
 * @module @dsh-cline/host-services/task-injector
 */
import type { Context } from '@deepseek-ai/cordis';
/** The web-carrier route-registration service (bridge-independent). */
interface WebServerService {
    register(route: unknown): () => unknown;
}
/**
 * Register the selection-action task route.
 * @param ctx - plugin context owning the web carrier and agent registry.
 * @param webServer - the web carrier the route mounts on.
 */
export declare function registerTaskInjector(ctx: Context, webServer: WebServerService): void;
export {};
