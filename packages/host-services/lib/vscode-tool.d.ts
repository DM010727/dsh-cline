/**
 * The `vscode` tool: gives the DSH agent direct actuation of the VS Code
 * window it is embedded in (open files/lines, open diffs, open external
 * links, reveal in explorer, read the active editor). Registered only when
 * the bridge is live; the extension host executes the real VS Code API and
 * returns a JSON result that the registry renders and logs like any tool.
 *
 * The definition is hand-built (no `defineTool` import) so this package
 * keeps zero runtime dependencies on the harness installation.
 *
 * @module @dsh-cline/host-services/vscode-tool
 */
import type { Context } from '@deepseek-ai/cordis';
import type { VscodeHostService } from './index.js';
/**
 * Register the vscode tool and its system-prompt section.
 * @param ctx - plugin context whose tools/systemPrompt registries receive the
 *   effect-scoped registrations.
 * @param vscodeHost - the bridge-provided service executing the calls.
 */
export declare function registerVscodeTool(ctx: Context, vscodeHost: VscodeHostService): void;
