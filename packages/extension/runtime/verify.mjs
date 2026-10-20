import { argumentsOf, DSH_VERSION, verifyHome } from './runtime-lib.mjs'

try {
  const args = argumentsOf(process.argv.slice(2))
  console.log(JSON.stringify(await verifyHome(args['--home'])))
} catch (error) {
  console.log(JSON.stringify({ ok: false, version: DSH_VERSION, reason: error instanceof Error ? error.message : String(error) }))
  process.exitCode = 1
}
