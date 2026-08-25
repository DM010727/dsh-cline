/**
 * Bundle the browser half (src/client) into lib/client.js in the DSH client
 * plugin format: a CJS body wrapped in window.__ModuleLoader__.load({ id,
 * factory: (require) => {...} }) whose externals resolve through the DSH web
 * boot's module table (platform modules). Mirrors the upstream
 * packages/client/tsdown.client.ts output contract without depending on the
 * harness's build toolchain.
 */
import { build } from 'esbuild'

/** The DSH web shell's frozen module-table words (platform.ts PLATFORM_MODULES). */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

const ID = '@dsh-cline/host-services'

await build({
  entryPoints: ['src/client/index.ts'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: 'lib/client.js',
  sourcemap: true,
  external: PLATFORM_MODULES,
  jsx: 'automatic',
  logLevel: 'info',
  banner: {
    js: [
      `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
      'var module = { exports: {} }; var exports = module.exports;',
    ].join('\n'),
  },
  footer: { js: 'return module.exports; } });' },
})
