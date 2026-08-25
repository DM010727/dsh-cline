/**
 * Workspace checkpoints: a shadow git repository per workspace (under
 * `~/.dsh/dsh-cline/checkpoints/<key>/`, `core.worktree` bound to the
 * workspace root) snapshots file state with git plumbing, restores with
 * `read-tree -u --reset` plus `clean -fd`. Bridges nothing by itself - it
 * is workspace functionality, available to plain `dsh web` sessions.
 *
 * Concurrency: all git operations serialize through one promise chain; a
 * failed auto-snapshot warns and never blocks the wrapped tool.
 *
 * @module @dsh-cline/host-services/checkpoint
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
/** One git call budget. */
const GIT_TIMEOUT_MS = 15_000;
/** Dirs never snapshotted (written to the shadow repo's info/exclude). */
const DEFAULT_EXCLUDES = ['node_modules/', '.venv/', '__pycache__/', '.next/', 'target/'];
/** Shadow-git checkpoint store bound to one workspace root. */
export class CheckpointStore {
    workspaceRoot;
    dir;
    chain = Promise.resolve();
    initialized = false;
    /**
     * @param workspaceRoot - absolute path bound as the shadow repo's worktree.
     */
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
        const key = createHash('sha1').update(workspaceRoot).digest('hex').slice(0, 12);
        this.dir = join(dshClineHome(), 'checkpoints', key);
    }
    /** Ensure the shadow repo exists (idempotent; lazy first use). */
    async ensure() {
        if (this.initialized)
            return;
        if (!existsSync(this.dir))
            mkdirSync(this.dir, { recursive: true });
        if (!existsSync(join(this.dir, 'config'))) {
            await this.git('init', '--quiet');
            await this.git('config', 'core.worktree', this.workspaceRoot);
            await this.git('config', 'user.email', 'checkpoint@dsh-cline.local');
            await this.git('config', 'user.name', 'dsh-cline checkpoint');
            const exclude = join(this.dir, 'info');
            if (!existsSync(exclude))
                mkdirSync(exclude, { recursive: true });
            writeFileSync(join(exclude, 'exclude'), DEFAULT_EXCLUDES.join('\n') + '\n');
        }
        this.initialized = true;
    }
    /** Serialize every git invocation; callers get ordered semantics. */
    queue(task) {
        const next = this.chain.then(task, task);
        this.chain = next.catch(() => undefined);
        return next;
    }
    async git(...args) {
        const env = { ...process.env };
        delete env.GIT_DIR;
        delete env.GIT_WORK_TREE;
        delete env.GIT_INDEX_FILE;
        const { stdout } = await execFileAsync('git', ['-C', this.dir, ...args], {
            cwd: this.dir,
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 64 * 1024 * 1024,
            env: env,
            windowsHide: true,
        });
        return stdout;
    }
    /**
     * Snapshot the workspace now.
     * @param label - commit subject describing the trigger.
     * @returns the short commit hash, or undefined when nothing changed.
     */
    snapshot(label) {
        return this.queue(async () => {
            await this.ensure();
            await this.git('add', '-A');
            const diff = await this.git('diff', '--cached', '--name-only');
            if (diff.trim() === '')
                return undefined;
            await this.git('commit', '--quiet', '-m', label);
            return (await this.git('rev-parse', '--short', 'HEAD')).trim();
        });
    }
    /**
     * List recent checkpoints.
     * @param limit - maximum entries to return.
     * @returns newest-first checkpoint entries; empty before the first snapshot.
     */
    list(limit) {
        return this.queue(async () => {
            await this.ensure();
            let raw;
            try {
                raw = await this.git('log', '--max-count=' + String(limit), '--format=%h\u001f%s\u001f%ct');
            }
            catch {
                return [];
            }
            return raw.split('\n').filter(line => line !== '').map(line => {
                const [id, label, time] = line.split('\u001f');
                return { id, label, time: Number(time) };
            });
        });
    }
    /**
     * Restore the workspace to a checkpoint's committed state: reset tracked
     * files and remove files created after the snapshot (untracked-and-not-
     * excluded only - ignored files always survive).
     * @param id - short or full commit hash from {@link CheckpointStore.list}.
     */
    restore(id) {
        return this.queue(async () => {
            await this.ensure();
            await this.git('read-tree', '-u', '--reset', id);
            await this.git('clean', '-fd');
        });
    }
}
/**
 * Register the checkpoint half: auto-snapshot waterfall plus the model-facing
 * `checkpoint` tool plus the loopback diagnostic routes.
 * @param ctx - plugin context (tools, webServer).
 * @param auto - live thunk of which tools trigger pre-execution snapshots
 *   (the settings scope; re-read per dispatch so web edits apply at once).
 */
export function registerCheckpoint(ctx, auto) {
    const workspaceRoot = process.cwd();
    const store = new CheckpointStore(workspaceRoot);
    ctx.on('tools/execute', async (exec, next) => {
        const mode = auto();
        const mutating = mode === 'all'
            ? ['edit', 'write', 'bash', 'pwsh']
            : ['edit', 'write'];
        if (mode !== 'off' && mutating.includes(exec.name)) {
            await store.snapshot('auto before ' + exec.name).catch(err => {
                ctx.logger.warn('checkpoint snapshot failed: ' + String(err));
            });
        }
        return next();
    });
    ctx.systemPrompt.section({
        name: 'tool:checkpoint',
        order: 113,
        text: 'The checkpoint tool snapshots and restores the workspace (shadow git under ~/.dsh/dsh-cline/checkpoints). Create one before risky bulk changes; restore rolls files back to a snapshot (destructive: post-snapshot files are removed).',
    });
    ctx.tools.register({
        name: 'checkpoint',
        description: 'Snapshot or restore workspace file state. Actions: create (snapshot now, skipped when nothing changed), list (recent checkpoints), restore (roll the workspace back to a checkpoint - destructive).',
        parameters: {
            type: 'object',
            additionalProperties: false,
            properties: {
                action: { type: 'string', enum: ['create', 'list', 'restore'], description: 'Checkpoint operation.' },
                label: { type: 'string', description: 'create: a short label for the snapshot.' },
                id: { type: 'string', description: 'restore: checkpoint id from list.' },
                limit: { type: 'integer', minimum: 1, maximum: 50, description: 'list: maximum entries (default 10).' },
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
        async execute(args) {
            const a = (args ?? {});
            if (a.action === 'create') {
                const label = typeof a.label === 'string' && a.label !== '' ? a.label : 'manual';
                const hash = await store.snapshot(label);
                return { done: true, action: 'create', detail: hash === undefined ? 'unchanged since last checkpoint' : hash };
            }
            if (a.action === 'list') {
                const limit = typeof a.limit === 'number' ? Math.min(Math.max(Math.trunc(a.limit), 1), 50) : 10;
                const entries = await store.list(limit);
                return { done: true, action: 'list', detail: entries.length === 0 ? 'none' : JSON.stringify(entries) };
            }
            if (a.action === 'restore') {
                if (typeof a.id !== 'string' || a.id === '')
                    throw new Error('checkpoint restore: id is required');
                await store.restore(a.id);
                return { done: true, action: 'restore', detail: a.id };
            }
            throw new Error('checkpoint: action must be create, list, or restore');
        },
    });
    const webServer = ctx.get('webServer');
    if (webServer !== undefined) {
        ctx.effect(() => webServer.register({
            kind: 'exact',
            path: '/dsh-cline/checkpoints',
            handler: async (req, res) => {
                try {
                    if (req.method === 'GET') {
                        const entries = await store.list(20);
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ workspace: workspaceRoot, checkpoints: entries }));
                        return;
                    }
                    if (req.method === 'POST') {
                        const body = await readBody(req);
                        const parsed = JSON.parse(body);
                        if (typeof parsed.id !== 'string' || parsed.id === '')
                            throw new Error('id required');
                        await store.restore(parsed.id);
                        res.writeHead(200, { 'content-type': 'application/json' });
                        res.end(JSON.stringify({ restored: parsed.id }));
                        return;
                    }
                    res.writeHead(405).end();
                }
                catch (err) {
                    res.writeHead(500, { 'content-type': 'application/json' });
                    res.end(JSON.stringify({ error: String(err) }));
                }
            },
        }), 'dsh-cline-host-services: checkpoints route');
    }
}
/** Read one request body as text with a hard size cap. */
async function readBody(req) {
    let body = '';
    let bytes = 0;
    for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 64 * 1024)
            throw new Error('body too large');
        body += chunk.toString('utf8');
    }
    return body;
}
/** The dsh-cline home under DSH home. */
function dshClineHome() {
    const dsh = process.env.DSH_HOME ?? join(homedir(), '.dsh');
    return join(dsh, 'dsh-cline');
}
