/** Dedicated bounded process fixtures; never starts DSH or touches a user home. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fork } from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { hostname, tmpdir } from 'node:os'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { acquireInstallLock, acquireInstallLockSync, InstallLockBusyError } from './install-lock.mjs'

const script = fileURLToPath(import.meta.url)
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
if (process.argv[2] === 'child') {
  const [mode, lockPath, work] = process.argv.slice(3)
  if (mode === 'hold') {
    const lock = await acquireInstallLock(lockPath)
    process.send({ kind: 'ready', pid: process.pid, ownerPath: lock.ownerPath })
    await new Promise(resolve => process.once('message', resolve))
    lock.release()
  } else if (mode === 'race') {
    process.send({ kind: 'ready', pid: process.pid })
    await new Promise(resolve => process.once('message', resolve))
    const originalLink = fs.linkSync
    let paused = false
    fs.linkSync = (from, to) => {
      originalLink(from, to)
      if (paused || !basename(to).startsWith('owner-')) return
      paused = true
      assert.equal(JSON.parse(fs.readFileSync(to, 'utf8')).phase, 'choosing')
      fs.writeFileSync(join(work, process.pid + '.choosing'), '')
      // Force both participants to publish choosing before either reads max.
      const deadline = Date.now() + 5_000
      while (fs.readdirSync(work).filter(name => name.endsWith('.choosing')).length < 2) {
        if (Date.now() > deadline) throw new Error('Choosing barrier timed out')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
      }
    }
    syncBuiltinESMExports()
    const lock = await acquireInstallLock(lockPath, { timeoutMs: 5_000, pollMs: 5 })
    const marker = join(work, 'critical-section')
    let descriptor
    try {
      descriptor = fs.openSync(marker, 'wx')
      fs.closeSync(descriptor)
      fs.appendFileSync(join(work, 'events.jsonl'), JSON.stringify({ kind: 'enter', pid: process.pid }) + '\n')
      await delay(100)
      fs.appendFileSync(join(work, 'events.jsonl'), JSON.stringify({ kind: 'exit', pid: process.pid }) + '\n')
      fs.unlinkSync(marker)
    } catch (error) {
      fs.appendFileSync(join(work, 'collisions'), String(error) + '\n')
      throw error
    } finally { lock.release() }
  } else throw new Error('Unknown fixture child mode')
  process.disconnect()
} else {
  let checks = 0
  const check = (value, message) => { assert.ok(value, message); checks++ }
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-cline-lock-audit-'))
  const children = []
  function child(mode, lockPath, work = root) {
    const instance = fork(script, ['child', mode, lockPath, work], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true, execArgv: [],
    })
    children.push(instance)
    let output = ''
    instance.stderr.on('data', data => { output += String(data) })
    return { instance, error: () => output }
  }
  function ready(instance) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Child readiness timed out')) }, 8_000)
      instance.once('message', value => { clearTimeout(timer); resolve(value) })
      instance.once('error', error => { clearTimeout(timer); reject(error) })
      instance.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error('Child exited before ready: ' + code + '/' + signal)) })
    })
  }
  function exited(instance) {
    if (instance.exitCode !== null || instance.signalCode !== null) return Promise.resolve({ code: instance.exitCode, signal: instance.signalCode })
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error('Fixture child exit timed out')) }, 10_000)
      instance.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
      instance.once('error', error => { clearTimeout(timer); reject(error) })
    })
  }
  const records = path => fs.readdirSync(path).filter(name => name.startsWith('owner-') && name.endsWith('.json'))
  try {
    const heldPath = join(root, 'held.lock')
    const held = child('hold', heldPath)
    const owner = await ready(held.instance)
    check(fs.existsSync(owner.ownerPath), 'a live process publishes verifiable PID/token ownership')
    let busy = false
    try { acquireInstallLockSync(heldPath) } catch (error) { busy = error instanceof InstallLockBusyError }
    check(busy && fs.existsSync(owner.ownerPath), 'live owner refused and preserved')
    await assert.rejects(acquireInstallLock(heldPath, { timeoutMs: 20, pollMs: 5 }), InstallLockBusyError); checks++
    check(records(heldPath).length === 1, 'failed acquisition withdraws its own choosing/ticket record')

    // Model a forced exit during choosing as well as ordinary held-lock death.
    const deadRecord = JSON.parse(fs.readFileSync(owner.ownerPath, 'utf8'))
    fs.writeFileSync(owner.ownerPath, JSON.stringify({ ...deadRecord, phase: 'choosing', ticket: 0 }))
    const death = exited(held.instance)
    held.instance.kill('SIGKILL')
    await death
    const recovered = acquireInstallLockSync(heldPath)
    check(!fs.existsSync(owner.ownerPath), 'confirmed-dead choosing owner recovered')
    check(fs.existsSync(recovered.ownerPath), 'recovery owns a new unique record')
    check(recovered.release() && !recovered.release(), 'release checks ownership and is idempotent')
    check(records(heldPath).length === 0, 'successful release leaves no blocking owner')

    const replacementPath = join(root, 'replacement.lock')
    const replaced = acquireInstallLockSync(replacementPath)
    const replacement = { version: 1, host: hostname(), pid: process.pid, token: randomUUID(), phase: 'waiting', ticket: 1 }
    fs.writeFileSync(replaced.ownerPath, JSON.stringify(replacement))
    check(!replaced.release() && fs.existsSync(replaced.ownerPath), 'release never removes replacement token/data')
    fs.unlinkSync(replaced.ownerPath)

    const partialPath = join(root, 'partial.lock')
    fs.mkdirSync(partialPath)
    fs.writeFileSync(join(partialPath, '.prepare-' + process.pid + '-fixture'), '{')
    const pastPartial = acquireInstallLockSync(partialPath)
    check(pastPartial.release(), 'incomplete unpublished owner/temp cannot block acquisition')

    const malformedName = 'owner-' + process.pid + '-' + randomUUID() + '.json'
    fs.writeFileSync(join(partialPath, malformedName), '{')
    assert.throws(() => acquireInstallLockSync(partialPath), InstallLockBusyError); checks++
    check(fs.readFileSync(join(partialPath, malformedName), 'utf8') === '{', 'unverifiable visible owner is preserved')
    fs.unlinkSync(join(partialPath, malformedName))

    const legacy = join(root, 'legacy.lock')
    fs.writeFileSync(legacy, '')
    assert.throws(() => acquireInstallLockSync(legacy), /Legacy installer lock/); checks++
    check(fs.readFileSync(legacy, 'utf8') === '', 'ambiguous legacy empty lock is not deleted by age')

    const remotePath = join(root, 'remote.lock')
    fs.mkdirSync(remotePath)
    const remoteToken = randomUUID()
    const remoteOwner = join(remotePath, 'owner-' + owner.pid + '-' + remoteToken + '.json')
    fs.writeFileSync(remoteOwner, JSON.stringify({ ...deadRecord, host: hostname() + '-different-host', token: remoteToken, phase: 'waiting', ticket: 1 }))
    assert.throws(() => acquireInstallLockSync(remotePath), InstallLockBusyError); checks++
    check(fs.existsSync(remoteOwner), 'local dead-PID probe never reclaims a different host owner')

    const racePath = join(root, 'race.lock')
    fs.mkdirSync(racePath)
    const staleToken = randomUUID()
    const staleRaceOwner = join(racePath, 'owner-' + owner.pid + '-' + staleToken + '.json')
    fs.writeFileSync(staleRaceOwner, JSON.stringify({ ...deadRecord, token: staleToken, phase: 'waiting', ticket: 7 }))
    const work = join(root, 'race')
    fs.mkdirSync(work)
    const first = child('race', racePath, work)
    const second = child('race', racePath, work)
    await Promise.all([ready(first.instance), ready(second.instance)])
    const completions = [exited(first.instance), exited(second.instance)]
    first.instance.send('go')
    second.instance.send('go')
    const outcomes = await Promise.all(completions)
    check(outcomes.every(value => value.code === 0), 'both concurrent processes complete: ' + first.error() + second.error())
    check(fs.readdirSync(work).filter(name => name.endsWith('.choosing')).length === 2, 'both choosing windows were forced visible before ticket reads')
    const events = fs.readFileSync(join(work, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
    let active = 0
    let maximum = 0
    for (const event of events) { active += event.kind === 'enter' ? 1 : -1; maximum = Math.max(maximum, active) }
    check(events.length === 4 && new Set(events.map(event => event.pid)).size === 2 && maximum === 1 && active === 0, 'cross-process critical-section counter never exceeds one')
    check(!fs.existsSync(join(work, 'collisions')) && records(racePath).length === 0, 'exclusive marker never collided and both owner records released')
    check(!fs.existsSync(staleRaceOwner), 'concurrent reapers clear dead waiting owner without deleting a new owner')
    console.log(checks + ' installer lock assertions passed (3 bounded temporary Node processes; no DSH)')
  } finally {
    for (const instance of children) {
      if (instance.exitCode === null && instance.signalCode === null) { instance.kill('SIGKILL'); await exited(instance) }
    }
    const cleanup = resolve(root)
    const part = relative(resolve(tmpdir()), cleanup)
    if (!basename(cleanup).startsWith('dsh-cline-lock-audit-') || isAbsolute(part) || part === '..' || part.startsWith('..' + sep)) throw new Error('Unsafe lock fixture cleanup')
    fs.rmSync(cleanup, { recursive: true, force: true })
  }
}
