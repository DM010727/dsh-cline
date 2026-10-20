import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { acquireInstallLock } from './install-lock.mjs'
import { argumentsOf, assetIdentity, cleanPath, inspectRuntime, pathsFor, REVISION, STAMP } from './runtime-lib.mjs'

async function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    resolve(dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js'),
  ]
  for (const directory of (process.env.PATH ?? process.env.Path ?? '').split(process.platform === 'win32' ? ';' : ':')) {
    const entry = directory.replace(/^"|"$/g, '')
    candidates.push(join(entry, 'node_modules', 'npm', 'bin', 'npm-cli.js'))
    if (process.platform !== 'win32') {
      try { candidates.push(await realpath(join(entry, 'npm'))) } catch { /* absent PATH entry */ }
    }
  }
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !candidate.endsWith('npm-cli.js')) continue
    try { await readFile(candidate); return candidate } catch { /* try the next installed npm location */ }
  }
  throw new Error('Cannot locate npm-cli.js beside Node or on PATH; install the supported Node distribution with npm')
}

async function runNpm(args, cwd) {
  const cli = await npmCli()
  await new Promise((accept, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, stdio: 'inherit', windowsHide: true })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? accept() : reject(new Error('npm ci failed (' + (signal ?? code) + ')')))
  })
}

async function main() {
  const args = argumentsOf(process.argv.slice(2), ['--home', '--registry', '--ignore-scripts'])
  const paths = await pathsFor(args['--home'])
  const identity = await assetIdentity()
  let registry = 'https://registry.npmjs.org'
  if (args['--registry'] !== undefined) {
    const url = new URL(args['--registry'])
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('--registry must be an HTTPS registry URL without credentials or query')
    registry = url.href
  }
  await mkdir(paths.runtime, { recursive: true })
  await cleanPath(paths.runtime)
  const lock = await acquireInstallLock(join(paths.runtime, 'install-lock'), { timeoutMs: 0 })
  const stage = join(paths.runtime, '.' + REVISION + '-stage-' + randomUUID())
  const previous = join(paths.runtime, '.' + REVISION + '-previous-' + randomUUID())
  let savedPrevious = false
  let published = false
  try {
    try {
      const current = await inspectRuntime(paths.target, identity)
      console.log(JSON.stringify({ ...current, alreadyInstalled: true }))
      return
    } catch { /* absent or invalid runtime is repaired by a complete staged installation */ }
    await mkdir(stage)
    await writeFile(join(stage, 'package.json'), identity.manifestBytes)
    await writeFile(join(stage, 'package-lock.json'), identity.lockBytes)
    const npmArgs = ['ci', '--prefix', stage, '--global=false', '--workspaces=false', '--no-audit', '--no-fund', '--registry=' + registry]
    if (args['--ignore-scripts']) npmArgs.push('--ignore-scripts')
    else npmArgs.push('--ignore-scripts=false')
    await runNpm(npmArgs, stage)
    await inspectRuntime(stage, identity, false)
    await writeFile(join(stage, STAMP), JSON.stringify({ revision: REVISION, lockSha256: identity.lockSha256, manifestSha256: identity.manifestSha256, platform: process.platform, arch: process.arch, scriptsIgnored: args['--ignore-scripts'] === true, installedAt: new Date().toISOString() }, null, 2) + '\n')
    await cleanPath(paths.target)
    try { await rename(paths.target, previous); savedPrevious = true } catch (error) { if (error.code !== 'ENOENT') throw error }
    let verified
    try {
      await rename(stage, paths.target)
      published = true
      verified = await inspectRuntime(paths.target, identity, args['--ignore-scripts'] !== true)
    } catch (error) {
      if (published) { await cleanPath(paths.target); await rename(paths.target, stage); published = false }
      if (savedPrevious) { await rename(previous, paths.target); savedPrevious = false }
      throw error
    }
    if (savedPrevious) {
      try { await cleanPath(previous); await rm(previous, { recursive: true, force: true }); savedPrevious = false }
      catch (error) { console.warn('Verified runtime installed; previous directory retained because cleanup failed: ' + error.message) }
    }
    console.log(JSON.stringify(args['--ignore-scripts'] ? { ...verified, ok: false, testOnly: true, reason: 'Native scripts skipped; this dependency-only installation cannot launch DSH' } : verified))
  } finally {
    try { if (!published) { await cleanPath(stage); await rm(stage, { recursive: true, force: true }) } }
    finally { lock.release() }
  }
}

main().catch(error => { console.error('DSH Cline runtime installation failed: ' + (error instanceof Error ? error.message : String(error))); process.exitCode = 1 })
