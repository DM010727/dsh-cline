export interface InstallLock {
  readonly pid: number
  readonly token: string
  readonly ownerPath: string
  /** False when already released or replaced; replacement data is preserved. */
  release(): boolean
}
export class InstallLockBusyError extends Error { readonly code: 'ELOCKED' }
export function acquireInstallLockSync(path: string): InstallLock
export function acquireInstallLock(path: string, options?: { timeoutMs?: number; pollMs?: number }): Promise<InstallLock>
