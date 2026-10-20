import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export interface AgentContext {
  session: { header: { cwd?: string; id?: unknown } }
}

/** Resolve symlinks, including an existing ancestor of a not-yet-created file. */
export function canonicalPath(path: string): string {
  const absolute = resolve(path)
  let ancestor = absolute
  for (;;) {
    try { return resolve(realpathSync.native(ancestor), relative(ancestor, absolute)) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const parent = dirname(ancestor)
      if (parent === ancestor) throw error
      ancestor = parent
    }
  }
}

export function isWithinWorkspace(path: string, root = process.cwd()): boolean {
  const rel = relative(canonicalPath(root), canonicalPath(path))
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith('..\\') && !rel.startsWith('../'))
}

export function sameWorkspace(path: string, root = process.cwd()): boolean {
  return relative(canonicalPath(root), canonicalPath(path)) === ''
}

/** rc.2 owns mutable cwd in workingDirectory; the session header is its origin. */
export function executionCwd(ctx: Context, agent?: AgentContext): string {
  const service = ctx.get('workingDirectory') as { get(session: AgentContext['session']): string } | undefined
  return agent === undefined ? process.cwd() : service?.get(agent.session) ?? agent.session.header.cwd ?? process.cwd()
}
