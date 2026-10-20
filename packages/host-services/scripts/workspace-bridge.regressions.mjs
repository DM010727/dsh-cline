import { createHash } from 'node:crypto'
/** Quiet offline HTTP fixtures. --runtime <installed runtime directory> also exercises the real native registry. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { existsSync, mkdtempSync, mkdirSync, realpathSync, readFileSync, rmSync, symlinkSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
const require = createRequire(new URL('../package.json', import.meta.url)), { build } = require('esbuild')
const root = fileURLToPath(new URL('../', import.meta.url))
const compiled = await build({ entryPoints: [join(root, 'src/workspace-bridge.ts')], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { registerWorkspaceBridge } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'))
const projectId = path => { const resolved = realpathSync.native(path); return createHash('sha256').update(process.platform === 'win32' ? resolved.toLowerCase() : resolved).digest('hex').slice(0,32) }
const fixture = realpathSync.native(mkdtempSync(join(tmpdir(), 'dsh-cline-workspace-bridge-'))), a = join(fixture, 'a'), b = join(fixture, 'b')
mkdirSync(a); mkdirSync(b)
const initialCwd = process.cwd()
const initialHome = process.env.DSH_CLINE_HOME
process.env.DSH_CLINE_HOME = join(fixture, 'home')
let passed = 0
async function check(name, run) { await run(); passed++; console.log('PASS workspace bridge ' + name) }
function request({ method = 'POST', raw = '{}', headers = {}, url = '/dsh-cline/workspace', remote = '127.0.0.1' } = {}) {
  const req = Readable.from([Buffer.from(raw)]); req.method = method; req.url = url
  req.headers = { host: '127.0.0.1:52341', 'content-type': 'application/json', ...headers }; req.socket = { remoteAddress: remote, localPort: 52341 }; return req
}
function response() { return { status: 0, headers: {}, body: '', setHeader(k,v) { this.headers[k]=v }, writeHead(s,h) { this.status=s;Object.assign(this.headers,h) }, end(b) { this.body=b }, json() { return JSON.parse(this.body) } } }
function mount(directory, registry, initialAuth = { requestRejection() { return undefined } }, services = {}) {
  const handlers = new Map(); let connection = initialAuth
  const ctx = { get(key) { return key === 'connection' ? connection : key === 'workspaceRegistry' ? registry : services[key] }, effect(factory) { return factory() } }
  try { process.chdir(directory); registerWorkspaceBridge(ctx, { register(route) { assert.equal(route.kind, 'exact'); assert.ok(['/dsh-cline/workspace','/dsh-cline/workspace/session'].includes(route.path)); handlers.set(route.path, route.handler); return () => {} } }) }
  finally { process.chdir(initialCwd) }
  return { setAuth(value) { connection = value }, async call(options) { const res = response(), req = request(options); await handlers.get(req.url.split('?')[0])(req, res); return res } }
}
const rows = new Map(), calls = []
const registry = { async create(...args) { calls.push(args); const path = realpathSync.native(args[0]); if (!rows.has(path)) rows.set(path, { id: 'workspace-' + rows.size, path, title: '已有自定义标题' }); return rows.get(path) } }
try {
  const bridge = mount(a, registry)
  await check('authentication is mandatory before the registry can be touched', async () => {
    for (const [auth, expected] of [[undefined,503], [{},503], [{requestRejection(){return {status:401}}},401], [{requestRejection(){return {status:403}}},403]]) {
      bridge.setAuth(auth); const res = await bridge.call(); assert.equal(res.status, expected); assert.equal(calls.length, 0); assert.equal(res.json().workspace, undefined)
    }
    bridge.setAuth({requestRejection(){return undefined}})
  })
  await check('cross-origin, DNS rebinding and non-loopback requests are rejected', async () => {
    for (const options of [{headers:{origin:'https://outside.invalid'}}, {headers:{host:'evil.invalid:52341'}}, {headers:{host:'127.0.0.1:52342'}}, {headers:{'sec-fetch-site':'cross-site'}}, {remote:'192.0.2.1'}]) assert.equal((await bridge.call(options)).status, 403)
    assert.equal(calls.length, 0)
  })
  await check('GET and non-JSON mutation requests fail closed', async () => {
    assert.equal((await bridge.call({method:'GET'})).status,405); assert.equal((await bridge.call({headers:{'content-type':'text/plain'}})).status,415); assert.equal(calls.length,0)
  })
  await check('empty bytes, invalid JSON and non-object bodies are rejected', async () => {
    for (const raw of ['', '{', 'null', '[]', 'true']) assert.equal((await bridge.call({raw})).status,400)
    assert.equal(calls.length,0)
  })
  await check('arbitrary paths, titles, sessions and query parameters cannot steer registration', async () => {
    for (const body of [{path:b},{path:'../escape'},{cwd:b},{title:'overwrite'},{sessionId:'old-session'}]) assert.equal((await bridge.call({raw:JSON.stringify(body)})).status,400)
    assert.equal((await bridge.call({url:'/dsh-cline/workspace?path='+encodeURIComponent(b)})).status,400); assert.equal(calls.length,0)
  })
  await check('oversized payload is bounded before native mutation', async () => {
    assert.equal((await bridge.call({raw:JSON.stringify({data:'x'.repeat(1100)})})).status,413); assert.equal(calls.length,0)
  })
  await check('same-origin bootstrap returns the native identity and stable project ID', async () => {
    const res = await bridge.call({headers:{origin:'http://127.0.0.1:52341'}}); assert.equal(res.status,200)
    assert.equal(res.json().workspace.path,a); assert.equal(res.json().projectId,projectId(a)); assert.equal(res.headers['cache-control'],'no-store')
    assert.equal(calls[0].length,1); assert.equal(calls[0][0],a)
  })
  await check('repeated requests reuse the workspace and retain the existing custom title', async () => {
    const first = (await bridge.call()).json(), again = (await bridge.call()).json(); assert.deepEqual(again,first); assert.equal(rows.size,1); assert.equal(again.workspace.title,'已有自定义标题')
    assert.ok(calls.every(args => args.length===1))
  })
  await check('startup path stays pinned while another instance targets a different project', async () => {
    const other = mount(b,registry), current = (await bridge.call()).json(), different = (await other.call()).json()
    assert.equal(current.workspace.path,a); assert.equal(different.workspace.path,b); assert.notEqual(current.workspace.workspaceId,different.workspace.workspaceId); assert.notEqual(current.projectId,different.projectId)
  })
  await check('concurrent same-directory requests delegate to native idempotent registration', async () => {
    const replies = await Promise.all(Array.from({length:8},()=>bridge.call())); assert.ok(replies.every(res=>res.status===200)); assert.equal(new Set(replies.map(res=>res.json().workspace.workspaceId)).size,1); assert.equal(rows.size,2)
  })
  await check('missing native service and registry failure do not report false success or leak errors', async () => {
    assert.equal((await mount(a,undefined).call()).status,503)
    const failed = await mount(a,{async create(){throw new Error('sensitive internal diagnostic')}}).call(); assert.equal(failed.status,500); assert.equal(failed.body.includes('sensitive'),false)
  })
  await check('a native service returning a foreign path is rejected', async () => {
    const res = await mount(a,{async create(){return {id:'foreign',path:b,title:'wrong'}}}).call(); assert.equal(res.status,500); assert.equal(res.json().workspace,undefined)
  })
  const sessionRequest = sessionId => ({url:'/dsh-cline/workspace/session',raw:JSON.stringify({sessionId})})
  await check('session mapping is authenticated and same-origin before any Session read',async()=>{
    let reads=0
    const mapping=mount(a,registry,{}, {agents:{get(){reads++;return undefined}}})
    assert.equal((await mapping.call(sessionRequest('hidden'))).status,503)
    mapping.setAuth({requestRejection(){return {status:401}}}); assert.equal((await mapping.call(sessionRequest('hidden'))).status,401)
    mapping.setAuth({requestRejection(){return undefined}}); assert.equal((await mapping.call({...sessionRequest('hidden'),headers:{origin:'https://outside.invalid'}})).status,403); assert.equal(reads,0)
  })
  await check('session mapping requires exactly one valid sessionId and accepts no path override',async()=>{
    const mapping=mount(a,registry)
    for(const body of [{},{sessionId:''},{sessionId:'bad id'},{sessionId:42},{sessionId:'s',path:b},{sessionId:'s',cwd:b},{sessionId:'x'.repeat(201)}]) assert.equal((await mapping.call({url:'/dsh-cline/workspace/session',raw:JSON.stringify(body)})).status,400)
  })
  await check('live Session uses its mutable working directory and never stale origin or cold reads',async()=>{
    const session={header:{id:'live',cwd:a}};let cwd=b,coldReads=0
    const mapping=mount(a,registry,undefined,{agents:{get(id){return id==='live'?{session}:undefined}},workingDirectory:{get(value){assert.equal(value,session);return cwd}},sessionQuery:{observeSession(){coldReads++;throw new Error('live path must win')}}})
    let res=await mapping.call(sessionRequest('live'));assert.equal(res.status,200);assert.equal(res.json().workspace,b);assert.equal(res.json().projectId,projectId(b))
    cwd=a;res=await mapping.call(sessionRequest('live'));assert.equal(res.json().workspace,a);assert.equal(res.json().projectId,projectId(a));assert.equal(coldReads,0)
  })
  await check('cold Session observes current projected cwd, disposes the lease, without creating learning storage',async()=>{
    const path=join(fixture,'cold-project');mkdirSync(path);let disposed=0
    const mapping=mount(a,registry,undefined,{sessionQuery:{async observeSession(id){assert.equal(id,'cold');return {header:{cwd:a},projections:{values:{workingDirectory:path}},[Symbol.dispose](){disposed++}}}}})
    const res=await mapping.call(sessionRequest('cold'));assert.equal(res.status,200);assert.equal(res.json().workspace,path);assert.equal(disposed,1)
    assert.equal(existsSync(process.env.DSH_CLINE_HOME), false)
  })
  await check('cold Session falls back only to its own header when no projection is present',async()=>{
    let disposed=0
    const mapping=mount(a,registry,undefined,{sessionQuery:{async observeSession(){return {header:{cwd:b},[Symbol.dispose](){disposed++}}}}})
    const res=await mapping.call(sessionRequest('header-only'));assert.equal(res.status,200);assert.equal(res.json().workspace,b);assert.equal(disposed,1)
  })
  await check('loaded Session fallback consults workingDirectory even without a live Agent',async()=>{
    const session={header:{cwd:a}}
    const mapping=mount(a,registry,undefined,{sessions:{get(id){return id==='loaded'?session:undefined}},workingDirectory:{get(value){assert.equal(value,session);return b}}})
    const res=await mapping.call(sessionRequest('loaded'));assert.equal(res.status,200);assert.equal(res.json().workspace,b)
  })
  await check('unknown or cwd-less Sessions return 409 without guessing the startup project',async()=>{
    let disposed=0
    const missing=mount(a,registry),empty=mount(a,registry,undefined,{sessionQuery:{async observeSession(){return {header:{},projections:{values:{}},[Symbol.dispose](){disposed++}}}}})
    assert.equal((await missing.call(sessionRequest('unknown'))).status,409);const res=await empty.call(sessionRequest('empty'));assert.equal(res.status,409);assert.equal(res.json().workspace,undefined);assert.equal(res.json().projectId,undefined);assert.equal(disposed,1)
  })
  await check('relative Session directories and native observation faults fail closed',async()=>{
    const relative=mount(a,registry,undefined,{agents:{get(){return {session:{header:{cwd:'relative-path'}}}}}})
    assert.equal((await relative.call(sessionRequest('invalid-cwd'))).status,409)
    const failed=mount(a,registry,undefined,{sessionQuery:{async observeSession(){throw new Error('private native failure')}}}),res=await failed.call(sessionRequest('unreadable'))
    assert.equal(res.status,500);assert.equal(res.body.includes('private native failure'),false)
  })
  await check('native not-found observations may fall back to an already-loaded Session',async()=>{
    const mapping=mount(a,registry,undefined,{sessionQuery:{async observeSession(){throw Object.assign(new Error('missing'),{code:'SESSION_QUERY_SESSION_NOT_FOUND'})}},sessions:{get(id){return id==='loaded-later'?{header:{cwd:b}}:undefined}}})
    assert.equal((await mapping.call(sessionRequest('loaded-later'))).json().workspace,b);assert.equal((await mapping.call(sessionRequest('unknown'))).status,409)
  })
  const runtimeAt = process.argv.indexOf('--runtime')
  if (runtimeAt !== -1) {
    assert.ok(process.argv[runtimeAt+1], '--runtime requires a directory')
    const sdkRequire = createRequire(join(resolve(process.argv[runtimeAt+1]), 'package.json'))
    const load = name => import(pathToFileURL(sdkRequire.resolve(name)).href)
    const [{Context}, {default:Storage}, {DomainFacility}, {default:WorkspaceRegistry}] = await Promise.all([load('@deepseek-ai/cordis'), load('@deepseek-ai/dsh-storage'), load('@deepseek-ai/dsh-storage-domain'), load('@deepseek-ai/dsh-workspace')])
    // Real official storage/domain/registry over an isolated in-memory backend; no daemon or session bodies.
    const ctx = new Context(), media = new Map()
    await ctx.plugin(Storage)
    ctx.storage.backend.register('fixture-memory', {kv:{async open(descriptor) {
      let medium=media.get(descriptor.name); if(!medium){medium={tables:{},global:null};media.set(descriptor.name,medium)}
      return {async loadAll(){return {tables:Object.fromEntries(descriptor.tables.map(key=>[key,{...(medium.tables[key]??{})}])),global:medium.global}},async putRecord(table,key,value){(medium.tables[table]??={})[key]=structuredClone(value)},async deleteRecord(table,key){delete medium.tables[table]?.[key]},async setGlobal(value){medium.global=structuredClone(value)},async close(){}}
    }},async close(){}})
    const facility = new DomainFacility(ctx,{backend:'fixture-memory',routes:{}})
    ctx.storage.mount('domain',facility); ctx.provide('storageDomain',facility)
    let sessionOpens=0
    ctx.provide('sessionPersistence',{async list(){return []},async open(){sessionOpens++;throw new Error('must not open old sessions')},async stat(){throw new Error('must not stat old sessions')}})
    ctx.provide('sessions',{list(){return []}})
    try {
      await ctx.plugin(WorkspaceRegistry)
      const native=ctx.workspaceRegistry, nativeBridge=mount(a,native)
      const existing=await native.create(a,'用户保留标题')
      await check('official SDK registry reuses canonical native identity without renaming',async()=>{
        const res=await nativeBridge.call(); assert.equal(res.status,200); assert.equal(res.json().workspace.workspaceId,String(existing.id)); assert.equal(res.json().workspace.title,'用户保留标题'); assert.equal(native.list().length,1)
      })
      await check('official SDK registry serializes concurrent bridge calls to one record',async()=>{
        const replies=await Promise.all(Array.from({length:8},()=>nativeBridge.call())); assert.ok(replies.every(res=>res.status===200)); assert.equal(new Set(replies.map(res=>res.json().workspace.workspaceId)).size,1); assert.equal(native.list().length,1)
      })
      await check('official SDK registry creates a separate identity for another startup directory',async()=>{
        const res=await mount(b,native).call(); assert.equal(res.status,200); assert.notEqual(res.json().workspace.workspaceId,String(existing.id)); assert.equal(native.list().length,2)
      })
      await check('official SDK registry canonicalizes a directory alias without duplicate records',async()=>{
        const alias=join(fixture,'alias-a'); symlinkSync(a,alias,process.platform==='win32'?'junction':'dir')
        try { const res=await mount(alias,native).call(); assert.equal(res.status,200); assert.equal(res.json().workspace.workspaceId,String(existing.id)); assert.equal(res.json().projectId,projectId(a)); assert.equal(native.list().length,2) } finally { unlinkSync(alias) }
      })
      await check('official SDK bootstrap does not open or migrate any old session',async()=>{assert.equal(sessionOpens,0);assert.ok(native.list().every(workspace=>workspace.sessionIds.length===0))})
    } finally { await ctx.fiber.dispose() }
  }
} finally {
  process.chdir(initialCwd); if(initialHome===undefined)delete process.env.DSH_CLINE_HOME;else process.env.DSH_CLINE_HOME=initialHome
  assert.ok(resolve(fixture).startsWith(realpathSync.native(tmpdir())+sep)); rmSync(fixture,{recursive:true,force:true})
}
console.log(`Workspace bridge regressions: ${passed} passed.`)
