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
import type { Context } from '@deepseek-ai/cordis';
/** One checkpoint as listed to callers. */
export interface CheckpointEntry {
    id: string;
    label: string;
    /** Unix seconds of the commit. */
    time: number;
}
/** Shadow-git checkpoint store bound to one workspace root. */
export declare class CheckpointStore {
    private readonly workspaceRoot;
    private readonly dir;
    private chain;
    private initialized;
    /**
     * @param workspaceRoot - absolute path bound as the shadow repo's worktree.
     */
    constructor(workspaceRoot: string);
    /** Ensure the shadow repo exists (idempotent; lazy first use). */
    private ensure;
    /** Serialize every git invocation; callers get ordered semantics. */
    private queue;
    private git;
    /**
     * Snapshot the workspace now.
     * @param label - commit subject describing the trigger.
     * @returns the short commit hash, or undefined when nothing changed.
     */
    snapshot(label: string): Promise<string | undefined>;
    /**
     * List recent checkpoints.
     * @param limit - maximum entries to return.
     * @returns newest-first checkpoint entries; empty before the first snapshot.
     */
    list(limit: number): Promise<CheckpointEntry[]>;
    /**
     * Restore the workspace to a checkpoint's committed state: reset tracked
     * files and remove files created after the snapshot (untracked-and-not-
     * excluded only - ignored files always survive).
     * @param id - short or full commit hash from {@link CheckpointStore.list}.
     */
    restore(id: string): Promise<void>;
}
/**
 * Register the checkpoint half: auto-snapshot waterfall plus the model-facing
 * `checkpoint` tool plus the loopback diagnostic routes.
 * @param ctx - plugin context (tools, webServer).
 * @param auto - live thunk of which tools trigger pre-execution snapshots
 *   (the settings scope; re-read per dispatch so web edits apply at once).
 */
export declare function registerCheckpoint(ctx: Context, auto: () => 'off' | 'edit-only' | 'all'): void;
