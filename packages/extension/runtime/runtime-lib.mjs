import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

export const ASSETS = fileURLToPath(new URL('.', import.meta.url))
export const REVISION = '0.2.1-rc.2-r1'
export const DSH_VERSION = '0.2.1-rc.2'
export const FFLATE_VERSION = '0.8.3'
export const STAMP = 'runtime-install.json'
export const sha256 = value => createHash('sha256').update(value).digest('hex')
const key = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
export const samePath = (a, b) => key(a) === key(b)
export const within = (child, parent) => {
  const rel = relative(key(parent), key(child))
  return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}
export async function json(file) { return JSON.parse(await readFile(file, 'utf8')) }

/** Reject symlinks and junctions before a caller creates, traverses, renames, or removes a runtime path. */
export async function cleanPath(path) {
  const absolute = resolve(path)
  let current = parse(absolute).root
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part)
    let entry
    try { entry = await lstat(current) } catch (error) {
      if (error.code === 'ENOENT') return
      throw error
    }
    if (entry.isSymbolicLink()) throw new Error('Runtime path contains a symbolic link or junction: ' + current)
  }
}

export async function pathsFor(home) {
  if (typeof home !== 'string' || !home || !isAbsolute(home) || /[\0\r\n]/.test(home)) throw new Error('--home must be an absolute isolated DSH Cline directory')
  const absolute = resolve(home)
  if (samePath(absolute, parse(absolute).root) || samePath(absolute, homedir())) throw new Error('The filesystem root or user home cannot be the runtime home')
  if (process.platform === 'win32' && relative(parse(absolute).root, absolute).split(sep).some(part => /[. ]$|:/.test(part))) throw new Error('Runtime home contains an ambiguous Windows path component')
  if (absolute.split(/[\\/]/).some(part => part.toLowerCase() === '.dsh')) throw new Error('The original .dsh directory must never be used for DSH Cline runtime installation')
  await cleanPath(absolute)
  const runtime = join(absolute, 'runtime')
  const target = join(runtime, REVISION)
  await cleanPath(target)
  return { home: absolute, runtime, target, command: join(target, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh') }
}

export function argumentsOf(argv, allowed = ['--home']) {
  const result = {}
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    if (!allowed.includes(flag) || Object.hasOwn(result, flag)) throw new Error('Unknown or repeated argument: ' + flag)
    if (flag === '--ignore-scripts') result[flag] = true
    else {
      const value = argv[++i]
      if (value === undefined || value.startsWith('--')) throw new Error('Missing value for ' + flag)
      result[flag] = value
    }
  }
  return result
}

export async function assetIdentity() {
  const [manifestBytes, lockBytes, fflate] = await Promise.all([
    readFile(join(ASSETS, 'package.json')), readFile(join(ASSETS, 'npm-lock.json')), json(join(ASSETS, 'fflate-integrity.json')),
  ])
  const manifest = JSON.parse(manifestBytes)
  const lock = JSON.parse(lockBytes)
  if (manifest.version !== REVISION || manifest.dependencies?.['@deepseek-ai/dsh'] !== DSH_VERSION
    || manifest.overrides?.['@deepseek-ai/libreoffice-kit']?.fflate !== FFLATE_VERSION
    || lock.packages?.['']?.dependencies?.['@deepseek-ai/dsh'] !== DSH_VERSION
    || fflate.version !== FFLATE_VERSION) throw new Error('Invalid bundled runtime manifest or security patch metadata')
  return { manifestBytes, lockBytes, lock, fflate, manifestSha256: sha256(manifestBytes), lockSha256: sha256(lockBytes) }
}

/** Inspect installed files and the kit's real dependency resolution; a stamp alone never establishes compatibility. */
export async function inspectRuntime(root, identity, requireStamp = true) {
  await cleanPath(root)
  const [manifestBytes, lockBytes] = await Promise.all([readFile(join(root, 'package.json')), readFile(join(root, 'package-lock.json'))])
  if (sha256(manifestBytes) !== identity.manifestSha256 || sha256(lockBytes) !== identity.lockSha256) throw new Error('Installed manifest or lock differs from the bundled audited runtime')
  if (requireStamp) {
    const stamp = await json(join(root, STAMP))
    if (stamp.revision !== REVISION || stamp.lockSha256 !== identity.lockSha256 || stamp.manifestSha256 !== identity.manifestSha256
      || stamp.platform !== process.platform || stamp.arch !== process.arch) throw new Error('Runtime installation metadata does not match this platform and audited lock')
    if (stamp.scriptsIgnored !== false) throw new Error('Runtime native installation scripts were skipped; run the normal managed installer before starting DSH')
  }
  const dshRoot = join(root, 'node_modules', '@deepseek-ai', 'dsh')
  await cleanPath(dshRoot)
  const dsh = await json(join(dshRoot, 'package.json'))
  if (dsh.name !== '@deepseek-ai/dsh' || dsh.version !== DSH_VERSION) throw new Error('The actual DSH runtime version is not ' + DSH_VERSION)
  const bin = join(dshRoot, 'lib', 'bin.js')
  await cleanPath(bin)
  if (!(await lstat(bin)).isFile()) throw new Error('The DSH CLI entry is missing')
  const kits = Object.keys(identity.lock.packages).filter(path => path.endsWith('/@deepseek-ai/libreoffice-kit'))
  if (kits.length === 0) throw new Error('The audited lock has no Office dependency to verify')
  const checked = new Set()
  for (const kit of kits) {
    const kitRoot = resolve(root, kit)
    if (!within(kitRoot, root)) throw new Error('Unexpected kit path in runtime lock')
    await cleanPath(kitRoot)
    const anchor = join(kitRoot, 'package.json')
    const actualKit = await json(anchor)
    if (actualKit.name !== '@deepseek-ai/libreoffice-kit' || actualKit.version !== identity.lock.packages[kit].version) throw new Error('Office package version differs from the audited lock')
    const fflateManifest = createRequire(anchor).resolve('fflate/package.json')
    const fflateRoot = dirname(fflateManifest)
    if (!within(await realpath(fflateRoot), await realpath(root))) throw new Error('Office resolved fflate outside the managed runtime')
    await cleanPath(fflateRoot)
    const actual = await json(fflateManifest)
    if (actual.version !== FFLATE_VERSION || actual.name !== 'fflate') throw new Error('Office still resolves vulnerable fflate instead of ' + FFLATE_VERSION)
    for (const [file, expected] of Object.entries(identity.fflate.sha256)) {
      const actualFile = join(fflateRoot, file)
      await cleanPath(actualFile)
      if (sha256(await readFile(actualFile)) !== expected) throw new Error('Patched fflate file integrity check failed: ' + file)
    }
    checked.add(fflateRoot)
  }
  const command = join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  const commandInfo = await lstat(command)
  if (process.platform === 'win32') {
    await cleanPath(command)
    if (!commandInfo.isFile() || !(await readFile(command, 'utf8')).includes('..\\@deepseek-ai\\dsh\\lib\\bin.js')) throw new Error('The managed DSH command shim is invalid')
  } else if (!samePath(await realpath(command), await realpath(bin))) throw new Error('The managed DSH command resolves outside its CLI entry')
  return { ok: true, version: DSH_VERSION, revision: REVISION, command, lockSha256: identity.lockSha256, fflate: FFLATE_VERSION, patchedPackages: checked.size }
}

export async function verifyHome(home) {
  const paths = await pathsFor(home)
  return inspectRuntime(paths.target, await assetIdentity())
}
