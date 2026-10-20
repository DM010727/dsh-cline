import { build, context } from 'esbuild'
import { cp, mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const watch = process.argv.includes('--watch')

const options = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  logLevel: 'info',
}

/**
 * Vendor the built host-services plugin (both halves) into dist/vendor so the
 * vsix ships it and the extension can auto-install it into $DSH_HOME at
 * activation — fresh machines get the DSH-side plugin and recommended-provider
 * settings without a separate plugin installation step.
 */
async function vendorPlugin() {
  const source = join('..', 'host-services')
  const target = join('dist', 'vendor', 'host-services')
  if (!existsSync(join(source, 'lib', 'client.js')) || !existsSync(join(source, 'lib', 'index.js'))) {
    throw new Error('host-services build missing (lib/client.js or lib/index.js); run pnpm --filter @dsh-cline/host-services build first')
  }
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  for (const item of ['lib', 'package.json', 'README.md']) {
    await cp(join(source, item), join(target, item), { recursive: true })
  }
  await mkdir(join(target, 'scripts'), { recursive: true })
  await cp(join(source, 'scripts', 'install-lock.mjs'), join(target, 'scripts', 'install-lock.mjs'))
}

async function vendorRuntime() {
  const metadata = JSON.parse(await readFile(join('..', '..', 'dsh-runtime.json'), 'utf8'))
  const manifest = JSON.parse(await readFile(join('runtime', 'package.json'), 'utf8'))
  const lock = await readFile(join('runtime', 'npm-lock.json'))
  if (manifest.version !== metadata.runtimeRevision || manifest.dependencies['@deepseek-ai/dsh'] !== metadata.version
    || manifest.overrides['@deepseek-ai/libreoffice-kit'].fflate !== metadata.fflateOverride
    || createHash('sha256').update(lock).digest('hex') !== metadata.runtimeLockSha256) {
    throw new Error('Runtime metadata, security override and lock must match before packaging')
  }
  const target = join('dist', 'runtime')
  await mkdir(target, { recursive: true })
  for (const item of ['package.json', 'npm-lock.json', 'fflate-integrity.json', 'runtime-lib.mjs', 'install.mjs', 'verify.mjs']) {
    await cp(join('runtime', item), join(target, item))
  }
  await cp(join('..', 'host-services', 'scripts', 'install-lock.mjs'), join(target, 'install-lock.mjs'))
}

if (watch) {
  await vendorPlugin()
  await vendorRuntime()
  const ctx = await context(options)
  await ctx.watch()
} else {
  await rm('dist', { recursive: true, force: true })
  await build(options)
  await vendorPlugin()
  await vendorRuntime()
}
