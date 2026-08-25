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
const ACTIONS = ['open_file', 'open_diff', 'open_external', 'reveal_in_explorer', 'active_editor', 'apply_selection'];
/** Bridge (service, method) per action. */
const BRIDGE_METHOD = {
    open_file: ['vscode.editor', 'open'],
    open_diff: ['vscode.diff', 'show'],
    open_external: ['vscode.browser', 'openExternal'],
    reveal_in_explorer: ['vscode.explorer', 'reveal'],
    active_editor: ['vscode.editor', 'getActive'],
    apply_selection: ['vscode.editor', 'applySelection'],
};
/**
 * Register the vscode tool and its system-prompt section.
 * @param ctx - plugin context whose tools/systemPrompt registries receive the
 *   effect-scoped registrations.
 * @param vscodeHost - the bridge-provided service executing the calls.
 */
export function registerVscodeTool(ctx, vscodeHost) {
    ctx.systemPrompt.section({
        name: 'tool:vscode',
        order: 112,
        text: 'You are embedded in VS Code via the DSH Cline extension. The vscode tool actuates the user\'s editor window: open_file (with optional 1-based line), open_diff (leftText/rightText/language/title), open_external (http(s) URL in the system browser), reveal_in_explorer (path), active_editor (read the user\'s current file and selection), apply_selection (replace the current selection with generated text, e.g. an explanation or completion). Use it to show the user files, changes, and links directly in their editor instead of describing them.',
    });
    ctx.tools.register({
        name: 'vscode',
        description: 'Actuate the user\'s VS Code window: open a file (optionally at a line), open a diff view, open an external http(s) link, reveal a path in the explorer, read the active editor/selection, or replace the current selection with text. Available only when DSH runs inside the DSH Cline VS Code extension.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                action: { type: 'string', enum: [...ACTIONS], description: 'Which VS Code actuation to run.' },
                path: { type: 'string', description: 'open_file / reveal_in_explorer: absolute or workspace-relative file path.' },
                line: { type: 'integer', minimum: 1, description: 'open_file: 1-based line to reveal.' },
                url: { type: 'string', description: 'open_external: the http(s) URL to open in the system browser.' },
                leftText: { type: 'string', description: 'open_diff: left (before) text.' },
                rightText: { type: 'string', description: 'open_diff: right (after) text.' },
                language: { type: 'string', description: 'open_diff: language id for both sides (default plaintext).' },
                title: { type: 'string', description: 'open_diff: diff tab title.' },
                text: { type: 'string', description: 'apply_selection: the text to replace the current editor selection with.' },
            },
            required: ['action'],
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    done: { type: 'boolean' },
                    action: { type: 'string' },
                    detail: { type: 'string' },
                },
                required: ['done', 'action'],
            },
            render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
        },
        isConcurrencySafe: () => true,
        async execute(args) {
            const a = (args ?? {});
            if (typeof a.action !== 'string' || !ACTIONS.includes(a.action)) {
                throw new Error('vscode: action must be one of ' + ACTIONS.join(', '));
            }
            const action = a.action;
            const [service, method] = BRIDGE_METHOD[action];
            const payload = buildPayload(action, a);
            const result = await vscodeHost.call(service, method, payload);
            return { done: true, action, detail: detailOf(result) };
        },
    });
}
/** Validate and shape the per-action payload sent over the bridge. */
function buildPayload(action, a) {
    if (action === 'open_file' || action === 'reveal_in_explorer') {
        if (typeof a.path !== 'string' || a.path === '')
            throw new Error('vscode ' + action + ': path is required');
        return [{ path: a.path, ...(action === 'open_file' && typeof a.line === 'number' ? { line: a.line } : {}) }];
    }
    if (action === 'open_external') {
        if (typeof a.url !== 'string' || !/^https?:\/\//.test(a.url)) {
            throw new Error('vscode open_external: url must be http(s)');
        }
        return [{ url: a.url }];
    }
    if (action === 'open_diff') {
        if (typeof a.leftText !== 'string' || typeof a.rightText !== 'string') {
            throw new Error('vscode open_diff: leftText and rightText are required');
        }
        return [{
                title: typeof a.title === 'string' ? a.title : 'DSH diff',
                fileName: '',
                language: typeof a.language === 'string' ? a.language : 'plaintext',
                leftText: a.leftText,
                rightText: a.rightText,
            }];
    }
    if (action === 'apply_selection') {
        if (typeof a.text !== 'string')
            throw new Error('vscode apply_selection: text is required');
        return [{ text: a.text }];
    }
    return [];
}
function detailOf(result) {
    if (result === null || typeof result !== 'object')
        return String(result);
    const parts = [];
    for (const [key, value] of Object.entries(result)) {
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
            parts.push(key + '=' + String(value));
        }
    }
    return parts.length === 0 ? undefined : parts.join(' ');
}
