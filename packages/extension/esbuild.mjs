import { build, context } from 'esbuild'
import { cp, mkdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

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
 * activation — fresh machines get the DSH-side plugin (bridge, Shengsuanyun
 * onboarding, settings UI) without any manual install step.
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
}

if (watch) {
  const ctx = await context(options)
  await ctx.watch()
} else {
  await rm('dist', { recursive: true, force: true })
  await build(options)
  await vendorPlugin()
}
