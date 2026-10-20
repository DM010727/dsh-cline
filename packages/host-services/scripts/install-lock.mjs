/**
 * Cross-process installer mutex. A persistent directory holds unique PID/token
 * records. Lamport choosing/ticket ordering avoids a shared stale-file unlink:
 * reclaimers only remove an immutable dead owner's uniquely named record.
 */
import {
  closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'

const OWNER_NAME = /^owner-([1-9][0-9]*)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/
const MAX_RECORD_BYTES = 16_384
const HOST = hostname()

export class InstallLockBusyError extends Error {
  code = 'ELOCKED'
  constructor(message) { super(message); this.name = 'InstallLockBusyError' }
}
function busy(message = 'Another DSH Cline installer is active; retry after it completes') {
  return new InstallLockBusyError(message)
}
function dead(pid) {
  try { process.kill(pid, 0); return false } catch (error) {
    // EPERM and unknown failures never prove death. PID reuse is conservative:
    // an unrelated live process can delay recovery, never authorize deletion.
    return error?.code === 'ESRCH'
  }
}
function identity(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs
}
function validOwner(value, name) {
  const match = OWNER_NAME.exec(name)
  return match !== null && value?.version === 1
    && Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 2_147_483_647
    && String(value.pid) === match[1] && value.token === match[2] && typeof value.host === 'string' && value.host !== ''
    && ((value.phase === 'choosing' && value.ticket === 0)
      || (value.phase === 'waiting' && Number.isSafeInteger(value.ticket) && value.ticket > 0))
}
/** Every visible record is complete JSON; a changing read is treated as busy. */
function snapshot(path, name) {
  try {
    const before = lstatSync(path)
    if (before.isSymbolicLink() || !before.isFile() || before.size > MAX_RECORD_BYTES) throw busy('Installer lock contains an unsafe owner record; it was preserved')
    let owner
    try { owner = JSON.parse(readFileSync(path, 'utf8')) } catch (error) {
      if (error?.code === 'ENOENT') return undefined
      throw busy('Installer owner record is incomplete or unrecognized; its owner cannot be safely reclaimed')
    }
    const after = lstatSync(path)
    if (!identity(before, after)) throw busy('Installer owner record is being published; retry')
    if (!validOwner(owner, name)) throw busy('Installer owner record is unrecognized; its owner cannot be safely reclaimed')
    return { owner, stat: after, path, name }
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}
function sameRecord(a, b) {
  return a !== undefined && b !== undefined && identity(a.stat, b.stat)
    && a.owner.pid === b.owner.pid && a.owner.token === b.owner.token && a.owner.host === b.owner.host
    && a.owner.phase === b.owner.phase && a.owner.ticket === b.owner.ticket
}
function removeOwned(expected) {
  if (expected === undefined) return false
  let current
  try { current = snapshot(expected.path, expected.name) } catch (error) {
    // Replacement/partial data is never permission to remove another file.
    if (error instanceof InstallLockBusyError) return false
    throw error
  }
  if (!sameRecord(expected, current)) return false
  try { unlinkSync(expected.path); return true } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }
}
function removeToken(path, name, pid, token) {
  let current
  try { current = snapshot(path, name) } catch (error) {
    if (error instanceof InstallLockBusyError) return false
    throw error
  }
  return current?.owner.pid === pid && current.owner.token === token ? removeOwned(current) : false
}
function ensureDirectory(path) {
  try { mkdirSync(path, { mode: 0o700 }) } catch (error) {
    if (error?.code !== 'EEXIST') throw error
  }
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) throw new Error('Refusing a redirected installer lock directory')
  if (!stat.isDirectory()) {
    // Old versions created empty files without PID metadata. No age heuristic
    // can prove an old installer is dead, so preserve this ambiguous legacy lock.
    throw busy('Legacy installer lock has no verifiable owner; confirm no old installer is running before removing that legacy file')
  }
}
function publish(directory, path, name, owner, initial) {
  const temporary = join(directory, '.prepare-' + process.pid + '-' + randomUUID())
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    writeFileSync(descriptor, JSON.stringify(owner) + '\n', 'utf8')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    if (initial) {
      // Exclusive hard-link publication never exposes an empty/partial owner.
      linkSync(temporary, path)
    } else {
      const current = snapshot(path, name)
      if (current?.owner.pid !== owner.pid || current.owner.token !== owner.token) throw busy('Installer lost its owner record while choosing a ticket')
      renameSync(temporary, path)
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch (error) { if (error?.code !== 'ENOENT') throw error }
  }
}
function livingOwners(directory) {
  const owners = []
  for (const name of readdirSync(directory)) {
    if (!OWNER_NAME.test(name)) continue
    const current = snapshot(join(directory, name), name)
    if (current === undefined) continue
    if (current.owner.host === HOST && dead(current.owner.pid)) {
      // Each UUID path is never reused by this protocol. Two reapers cannot
      // touch a later owner's different UUID record. Recheck ownership first.
      if (dead(current.owner.pid) && !removeOwned(current) && snapshot(current.path, current.name) !== undefined) {
        throw busy('Installer owner changed during recovery; preserved')
      }
      continue
    }
    owners.push(current)
  }
  return owners
}
function attempt(path) {
  const directory = resolve(path)
  ensureDirectory(directory)
  const token = randomUUID()
  const name = 'owner-' + process.pid + '-' + token + '.json'
  const ownerPath = join(directory, name)
  let owned
  let published = false
  let acquired = false
  try {
    const choosing = { version: 1, host: HOST, pid: process.pid, token, phase: 'choosing', ticket: 0 }
    // Critical bakery invariant: publish choosing BEFORE reading max ticket.
    publish(directory, ownerPath, name, choosing, true)
    published = true
    owned = snapshot(ownerPath, name)
    const maximum = livingOwners(directory).reduce((max, item) => Math.max(max, item.owner.ticket), 0)
    if (maximum >= Number.MAX_SAFE_INTEGER) throw busy('Installer ticket space exhausted; active owners were preserved')
    const waiting = { ...choosing, phase: 'waiting', ticket: maximum + 1 }
    publish(directory, ownerPath, name, waiting, false)
    owned = snapshot(ownerPath, name)
    if (owned === undefined) throw busy('Installer owner record disappeared')
    for (const other of livingOwners(directory)) {
      if (other.name === name) continue
      if (other.owner.host !== HOST || other.owner.phase === 'choosing'
        || other.owner.ticket < waiting.ticket
        || (other.owner.ticket === waiting.ticket && other.name < name)) throw busy()
    }
    const acquiredRecord = owned
    acquired = true
    let released = false
    return {
      pid: process.pid, token, ownerPath,
      release() {
        if (released) return false
        released = true
        return removeOwned(acquiredRecord)
      },
    }
  } finally {
    // Failed attempts withdraw only their own visible record; the directory
    // itself is never deleted while another participant could be using it.
    if (published && !acquired) removeToken(ownerPath, name, process.pid, token)
  }
}

/** Immediate acquire for the synchronous development installer. */
export function acquireInstallLockSync(path) { return attempt(path) }

/** Bounded async retries for extension/runtime installers, with no age-based deletion. */
export async function acquireInstallLock(path, { timeoutMs = 10_000, pollMs = 50 } = {}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || !Number.isFinite(pollMs) || pollMs < 1) throw new Error('Invalid installer lock timeout')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { return attempt(path) } catch (error) {
      if (!(error instanceof InstallLockBusyError) || Date.now() >= deadline) throw error
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))))
    }
  }
}
