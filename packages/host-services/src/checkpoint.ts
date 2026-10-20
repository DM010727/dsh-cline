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

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative } from 'node:path'
import { promisify } from 'node:util'
import type { Context, ToolDispatchExecution, ToolExecutionResult } from '@deepseek-ai/cordis'
import { guardRequest, readJsonObject, requestErrorStatus, sendJson } from './request-guard.js'
import { canonicalPath, executionCwd, isWithinWorkspace } from './workspace-context.js'

const execFileAsync = promisify(execFile)

/** One git call budget. */
const GIT_TIMEOUT_MS = 15_000

/** Dirs never snapshotted (written to the shadow repo's info/exclude). */
const DEFAULT_EXCLUDES = ['node_modules/', '.venv/', '__pycache__/', '.next/', 'target/']
const storeChains = new Map<string, Promise<unknown>>()
const workspaceChains = new Map<string, Promise<unknown>>()

/** Keep restoration and mutating tools from rewriting the same tree concurrently. */
function serializeWorkspace<T>(root: string, task: () => Promise<T>): Promise<T> {
  const key = canonicalPath(root)
  const next = (workspaceChains.get(key) ?? Promise.resolve()).then(task, task)
  const settled = next.catch(() => undefined)
  workspaceChains.set(key, settled)
  void settled.then(() => { if (workspaceChains.get(key) === settled) workspaceChains.delete(key) })
  return next
}

/** One checkpoint as listed to callers. */
export interface CheckpointEntry {
  id: string
  label: string
  /** Unix seconds of the commit. */
  time: number
}

/** Shadow-git checkpoint store bound to one workspace root. */
export class CheckpointStore {
  private readonly dir: string
  private initialized = false

  /**
   * @param workspaceRoot - absolute path bound as the shadow repo's worktree.
   */
  constructor(private readonly workspaceRoot: string) {
    this.workspaceRoot = canonicalPath(workspaceRoot)
    const key = createHash('sha1').update(this.workspaceRoot).digest('hex').slice(0, 12)
    this.dir = join(dshClineHome(), 'checkpoints', key)
  }

  /** Ensure the shadow repo exists (idempotent; lazy first use). */
  private async ensure(): Promise<void> {
    if (this.initialized) return
    if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true })
    if (!existsSync(join(this.dir, '.git', 'config'))) {
      await this.git('init', '--quiet')
      await this.git('config', 'core.worktree', this.workspaceRoot)
      await this.git('config', 'user.email', 'checkpoint@dsh-cline.local')
      await this.git('config', 'user.name', 'dsh-cline checkpoint')
    }
    await this.git('config', 'core.worktree', this.workspaceRoot)
    const exclude = join(this.dir, '.git', 'info')
    mkdirSync(exclude, { recursive: true })
    const excludeFile = join(exclude, 'exclude')
    const previous = existsSync(excludeFile) ? readFileSync(excludeFile, 'utf8') : ''
    const ownDirectory = isWithinWorkspace(this.dir, this.workspaceRoot)
      ? ['/' + relative(this.workspaceRoot, this.dir).replaceAll('\\', '/') + '/'] : []
    const missing = [...DEFAULT_EXCLUDES, ...ownDirectory].filter(line => !previous.split(/\r?\n/).includes(line))
    if (missing.length > 0) writeFileSync(excludeFile, previous + '\n' + missing.join('\n') + '\n')
    this.initialized = true
  }

  /** Serialize every git invocation; callers get ordered semantics. */
  private queue<T>(task: () => Promise<T>): Promise<T> {
    const next = (storeChains.get(this.dir) ?? Promise.resolve()).then(task, task)
    const settled = next.catch(() => undefined)
    storeChains.set(this.dir, settled)
    void settled.then(() => { if (storeChains.get(this.dir) === settled) storeChains.delete(this.dir) })
    return next
  }

  private async git(...args: string[]): Promise<string> {
    const env = { ...process.env } as Record<string, string | undefined>
    for (const key of Object.keys(env)) if (key.startsWith('GIT_')) delete env[key]
    const { stdout } = await execFileAsync('git', [
      '-c', 'core.hooksPath=' + join(this.dir, 'disabled-hooks'),
      '-c', 'commit.gpgsign=false',
      '-C', this.dir, '--git-dir=' + join(this.dir, '.git'), '--work-tree=' + this.workspaceRoot,
      ...args,
    ], {
      cwd: this.dir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      env: env as Record<string, string>,
      windowsHide: true,
    })
    return stdout
  }

  /**
   * Snapshot the workspace now.
   * @param label - commit subject describing the trigger.
   * @returns the short commit hash, or undefined when nothing changed.
   */
  snapshot(label: string): Promise<string | undefined> {
    const subject = label.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 200).trim() || 'manual'
    return this.queue(async () => {
      await this.ensure()
      await this.git('add', '-A')
      const diff = await this.git('diff', '--cached', '--name-only')
      if (diff.trim() === '') {
        const hasHead = await this.git('rev-parse', '--verify', 'HEAD').then(() => true, () => false)
        if (hasHead) return undefined
      }
      await this.git('commit', '--quiet', '--allow-empty', '-m', subject)
      return (await this.git('rev-parse', '--short', 'HEAD')).trim()
    })
  }

  /**
   * List recent checkpoints.
   * @param limit - maximum entries to return.
   * @returns newest-first checkpoint entries; empty before the first snapshot.
   */
  list(limit: number): Promise<CheckpointEntry[]> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return Promise.reject(new Error('checkpoint limit must be between 1 and 50'))
    return this.queue(async () => {
      await this.ensure()
      let raw: string
      try {
        raw = await this.git('log', '--max-count=' + String(limit), '--format=%h\u001f%s\u001f%ct')
      } catch {
        return []
      }
      return raw.split('\n').filter(line => line !== '').map(line => {
        const [id, label, time] = line.split('\u001f')
        return { id, label, time: Number(time) }
      })
    })
  }

  /**
   * Restore the workspace to a checkpoint's committed state: reset tracked
   * files and remove files created after the snapshot (untracked-and-not-
   * excluded only - ignored files always survive).
   * @param id - short or full commit hash from {@link CheckpointStore.list}.
   */
  restore(id: string): Promise<void> {
    return this.queue(async () => {
      await this.ensure()
      if (!/^[a-fA-F0-9]{7,64}$/.test(id)) throw new Error('checkpoint id must be a commit hash returned by list')
      const commit = (await this.git('rev-parse', '--verify', id + '^{commit}')).trim()
      await this.git('merge-base', '--is-ancestor', commit, 'HEAD')
      // Checkpoint the current tree before destructive restoration so accidental
      // restores remain recoverable. This runs inside the same serialized job.
      await this.git('add', '-A')
      if ((await this.git('diff', '--cached', '--name-only')).trim() !== '') {
        await this.git('commit', '--quiet', '-m', 'before restore ' + id)
      }
      await this.git('read-tree', '-u', '--reset', commit)
      await this.git('clean', '-fd')
    })
  }
}

/**
 * Register the checkpoint half: auto-snapshot waterfall plus the model-facing
 * `checkpoint` tool plus the loopback diagnostic routes.
 * @param ctx - plugin context (tools, webServer).
 * @param auto - live thunk of which tools trigger pre-execution snapshots
 *   (the settings scope; re-read per dispatch so web edits apply at once).
 */
export function registerCheckpoint(ctx: Context, auto: () => 'off' | 'edit-only' | 'all'): void {
  const workspaceRoot = process.cwd()
  const stores = new Map<string, CheckpointStore>()
  const storeFor = (cwd: string): CheckpointStore => {
    if (!isWithinWorkspace(cwd, workspaceRoot)) throw new Error('checkpoint directory is outside this VS Code workspace')
    const key = canonicalPath(cwd)
    let store = stores.get(key)
    if (store === undefined) { store = new CheckpointStore(key); stores.set(key, store) }
    return store
  }
  const store = storeFor(workspaceRoot)

  ctx.on('tools/execute', async (exec: ToolDispatchExecution, next: () => Promise<ToolExecutionResult>) => {
    if (!['edit', 'write', 'str_replace_editor', 'apply_patch', 'bash', 'pwsh', 'checkpoint'].includes(exec.name)) return next()
    return serializeWorkspace(workspaceRoot, async () => {
      if (exec.signal.aborted) return next()
      const mode = auto()
      const mutating = mode === 'all'
        ? ['edit', 'write', 'str_replace_editor', 'apply_patch', 'bash', 'pwsh']
        : ['edit', 'write', 'str_replace_editor', 'apply_patch']
      if (mode !== 'off' && mutating.includes(exec.name)) {
        await Promise.resolve().then(() => storeFor(executionCwd(ctx, exec.agent)).snapshot('auto before ' + exec.name)).catch(err => {
          ctx.logger.warn('checkpoint snapshot failed: ' + String(err))
        })
      }
      return next()
    })
  })

  ctx.systemPrompt.section({
    name: 'tool:checkpoint',
    order: 113,
    text: 'The checkpoint tool snapshots and restores the current session directory within this VS Code workspace (shadow git under $DSH_HOME/dsh-cline/checkpoints). Create one before risky bulk changes; restore rolls files back to a snapshot (destructive: post-snapshot files are removed).',
  })

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
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, exec): Promise<unknown> {
      const store = storeFor(executionCwd(ctx, exec.agent))
      const a = (args ?? {}) as { action?: unknown, label?: unknown, id?: unknown, limit?: unknown }
      if (a.action === 'create') {
        const label = typeof a.label === 'string' && a.label !== '' ? a.label : 'manual'
        const hash = await store.snapshot(label)
        return { done: true, action: 'create', detail: hash === undefined ? 'unchanged since last checkpoint' : hash }
      }
      if (a.action === 'list') {
        const limit = typeof a.limit === 'number' && Number.isFinite(a.limit) ? Math.min(Math.max(Math.trunc(a.limit), 1), 50) : 10
        const entries = await store.list(limit)
        return { done: true, action: 'list', detail: entries.length === 0 ? 'none' : JSON.stringify(entries) }
      }
      if (a.action === 'restore') {
        if (typeof a.id !== 'string' || a.id === '') throw new Error('checkpoint restore: id is required')
        await store.restore(a.id)
        return { done: true, action: 'restore', detail: a.id }
      }
      throw new Error('checkpoint: action must be create, list, or restore')
    },
  })

  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/dsh-cline/checkpoints',
      handler: async (req, res) => {
        if (!guardRequest(req, res, ['GET', 'POST'], true)) return
        try {
          if (req.method === 'GET') {
            const entries = await serializeWorkspace(workspaceRoot, () => store.list(20))
            sendJson(res, 200, { workspace: workspaceRoot, checkpoints: entries })
            return
          }
          if (req.method === 'POST') {
            const parsed = await readJsonObject(req)
            if (typeof parsed.id !== 'string' || parsed.id === '') throw new Error('id required')
            await serializeWorkspace(workspaceRoot, () => store.restore(parsed.id as string))
            sendJson(res, 200, { restored: parsed.id })
            return
          }
          res.writeHead(405).end()
        } catch (err: unknown) {
          sendJson(res, requestErrorStatus(err), { error: String(err) })
        }
      },
    }), 'dsh-cline-host-services: checkpoints route')
  }
}

/** The dsh-cline home under DSH home. */
function dshClineHome(): string {
  const dsh = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return join(dsh, 'dsh-cline')
}
