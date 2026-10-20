import assert from 'node:assert/strict'
import * as http from 'node:http'
import httpMutable from 'node:http'
import * as net from 'node:net'
import dns from 'node:dns'
import { syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const compiled = await build({ entryPoints: [fileURLToPath(new URL('../src/web-proxy.ts', import.meta.url))], bundle: true, write: false, platform: 'node', format: 'esm', logLevel: 'silent' })
const { WebProxy } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text + '\n//# sourceURL=web-proxy-regression.js').toString('base64'))
let assertions = 0
const check = (value, message) => { assert.ok(value, message); assertions++ }
const TOKEN = 'synthetic_launch_token_for_proxy_regression'
const COOKIE = 'dsh-auth-synthetic=v1.synthetic.signature'
const seen = []
const sockets = new Set()
let exchanges = 0
let authenticatedRoots = 0
let nativeOrigin
const textFrame = text => { const bytes = Buffer.from(text); return Buffer.concat([Buffer.from([0x81, bytes.length]), bytes]) }
const maskFrame = text => {
  const bytes = Buffer.from(text), mask = Buffer.from([3, 7, 11, 13])
  return Buffer.concat([Buffer.from([0x81, bytes.length | 0x80]), mask, Buffer.from(bytes.map((value, i) => value ^ mask[i % 4]))])
}
const native = http.createServer(async (req, res) => {
  seen.push({ url: req.url, headers: { ...req.headers } })
  const url = new URL(req.url, nativeOrigin)
  if (url.pathname === '/' && url.searchParams.has('token')) {
    exchanges++
    if (url.searchParams.get('token') !== TOKEN) { res.writeHead(401).end(); return }
    res.writeHead(303, { location: './', 'set-cookie': COOKIE + '; Path=/; HttpOnly; SameSite=Strict' }).end()
    return
  }
  if (req.headers.cookie !== COOKIE) { res.writeHead(401).end('unauthorized'); return }
  if (url.pathname === '/') {
    authenticatedRoots++
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<!doctype html><base href="./"><script src="assets/client.js"></script>')
  } else if (url.pathname === '/assets/client.js') {
    res.writeHead(200, { 'content-type': 'text/javascript', 'set-cookie': 'must-not-reach-browser=secret; Path=/' }).end('window.syntheticAsset = true')
  } else if (url.pathname === '/dsh-cline/task') {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ body: Buffer.concat(chunks).toString(), query: url.search }))
  } else if (url.pathname === '/redirect-local') {
    res.writeHead(302, { location: '/assets/client.js?kept=yes', 'set-cookie': 'hidden=secret' }).end()
  } else if (url.pathname === '/redirect-external') {
    res.writeHead(302, { location: 'https://never-contact.invalid/?token=' + TOKEN }).end()
  } else if (url.pathname === '/redirect-token') {
    res.writeHead(303, { location: '/?token=' + TOKEN }).end()
  } else if (url.pathname === '/reflect-headers') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(req.headers))
  } else res.writeHead(404).end()
})
native.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
native.on('upgrade', (req, socket, head) => {
  seen.push({ url: req.url, headers: { ...req.headers }, upgrade: true })
  if (req.url !== '/api/remote.mux?fixture=1' || req.headers.cookie !== COOKIE || req.headers.origin !== nativeOrigin) { socket.destroy(); return }
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
  socket.write(Buffer.concat([Buffer.from('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ' + accept + '\r\nSet-Cookie: forbidden=secret\r\n\r\n'), textFrame('welcome')]))
  let pending = Buffer.alloc(0)
  const receive = chunk => {
    pending = Buffer.concat([pending, chunk])
    while (pending.length >= 6) {
      const length = pending[1] & 0x7f
      if (pending.length < 6 + length) return
      const mask = pending.subarray(2, 6), payload = pending.subarray(6, 6 + length)
      const text = Buffer.from(payload.map((value, i) => value ^ mask[i % 4])).toString()
      socket.write(textFrame('echo:' + text))
      if (text === 'native-close') setTimeout(() => socket.end(), 30)
      pending = pending.subarray(6 + length)
    }
  }
  socket.on('data', receive)
  socket.on('end', () => socket.destroy())
  socket.on('error', () => {})
  if (head.length) receive(head)
})
await new Promise(resolve => native.listen(0, '127.0.0.1', resolve))
nativeOrigin = 'http://127.0.0.1:' + native.address().port
const auth = nativeOrigin + '/?token=' + TOKEN
const proxy = new WebProxy()
const clients = new Set()

const request = (url, options = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { ...options, agent: false }, res => {
    const chunks = []
    res.on('data', chunk => chunks.push(chunk))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
    res.on('error', reject)
  })
  req.on('error', reject)
  req.setTimeout(4_000, () => req.destroy(new Error('synthetic request timeout')))
  req.end(options.body)
})

const websocket = (base, extra = {}, initial = 'head') => new Promise((resolve, reject) => {
  const url = new URL('api/remote.mux?fixture=1', base)
  const socket = net.connect(Number(url.port), url.hostname)
  clients.add(socket)
  socket.on('close', () => clients.delete(socket))
  const timer = setTimeout(() => { socket.destroy(); reject(new Error('synthetic websocket timeout')) }, 4_000)
  let buffer = Buffer.alloc(0), headers, messages = [], settled = false
  const finish = () => {
    if (settled) return
    settled = true; clearTimeout(timer)
    resolve({ socket, headers, messages })
  }
  socket.on('error', error => { clearTimeout(timer); if (!settled) reject(error) })
  socket.on('connect', () => {
    const values = { host: url.host, origin: url.origin, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', ...extra }
    const lines = ['GET ' + url.pathname + url.search + ' HTTP/1.1', ...Object.entries(values).map(([key, value]) => key + ': ' + value), '', '']
    socket.write(Buffer.concat([Buffer.from(lines.join('\r\n')), maskFrame(initial)]))
  })
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    if (headers === undefined) {
      const end = buffer.indexOf('\r\n\r\n')
      if (end < 0) return
      headers = buffer.subarray(0, end).toString(); buffer = buffer.subarray(end + 4)
      if (!headers.startsWith('HTTP/1.1 101 ')) { finish(); return }
    }
    while (buffer.length >= 2 && buffer.length >= 2 + (buffer[1] & 0x7f)) {
      const length = buffer[1] & 0x7f
      messages.push(buffer.subarray(2, 2 + length).toString()); buffer = buffer.subarray(2 + length)
    }
    if (messages.includes('welcome') && messages.includes('echo:' + initial)) finish()
  })
})

try {
  const before = await request(nativeOrigin)
  check(before.status === 401, 'native root genuinely requires authentication')
  const [base, same] = await Promise.all([proxy.connect(nativeOrigin, auth), proxy.connect(nativeOrigin, auth)])
  check(base === same && exchanges === 1 && authenticatedRoots === 1, 'concurrent identical connect exchanges one cookie and confirms HTML once')
  check(await proxy.connect(nativeOrigin, auth) === base && exchanges === 1, 'repeated identical connect reuses capability and native cookie')
  const parsed = new URL(base)
  check(parsed.hostname === '127.0.0.1' && /^\/[A-Za-z0-9_-]{43}\/$/.test(parsed.pathname) && !base.includes(TOKEN), 'browser URL is a 256-bit loopback capability without native token')
  const root = await request(base, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' } })
  check(root.status === 200 && root.body.includes('<base href="./">'), 'cross-site iframe bootstrap serves original prefix-compatible index HTML')
  check(root.headers['set-cookie'] === undefined && root.headers['referrer-policy'] === 'no-referrer' && root.headers['cache-control'] === 'no-store', 'HTML sends no cookie and suppresses capability referrer/cache persistence')
  const asset = await request(new URL('assets/client.js?q=1', base))
  check(asset.status === 200 && asset.body.includes('syntheticAsset') && seen.at(-1).url === '/assets/client.js?q=1', 'relative assets strip capability prefix and preserve query')
  check(asset.headers['set-cookie'] === undefined && seen.at(-1).headers.cookie === COOKIE, 'native asset cookie remains server-side')
  const body = JSON.stringify({ content: 'synthetic task' })
  const task = await request(new URL('dsh-cline/task?mode=fixture', base), { method: 'POST', body, headers: { origin: parsed.origin, 'content-type': 'application/json' } })
  check(task.status === 200 && JSON.parse(task.body).body === body && JSON.parse(task.body).query === '?mode=fixture', 'relative custom gateway POST preserves body and query')
  check(seen.at(-1).headers.host === new URL(nativeOrigin).host && seen.at(-1).headers.origin === nativeOrigin, 'native Host and Origin match the authenticated native authority')
  const reflected = await request(new URL('reflect-headers', base), { headers: {
    cookie: 'browser-secret=must-not-forward', authorization: 'Bearer must-not-forward', origin: parsed.origin,
    forwarded: 'host=evil.invalid', 'x-forwarded-host': 'evil.invalid', 'x-forwarded-for': '203.0.113.1', via: 'evil', referer: base,
    connection: 'close, x-remove-me', 'x-remove-me': 'must-not-forward', 'sec-fetch-site': 'same-origin',
  } })
  const headers = JSON.parse(reflected.body)
  check(headers.cookie === COOKIE && headers.authorization === undefined && headers.referer === undefined, 'browser credentials and capability referrer never reach native service')
  check(!['forwarded', 'x-forwarded-host', 'x-forwarded-for', 'via', 'x-remove-me', 'sec-fetch-site'].some(key => key in headers), 'forwarded metadata and hop-nominated headers are stripped')
  const nativeCount = seen.length
  check((await request(base, { headers: { host: 'localhost:' + parsed.port } })).status === 403, 'noncanonical proxy authority is rejected')
  check((await request(base, { headers: { origin: 'https://foreign.invalid' } })).status === 403, 'foreign Origin is rejected')
  check((await request(base, { headers: { origin: 'null' } })).status === 403, 'opaque Origin is rejected')
  check((await request(parsed.origin + '/assets/client.js')).status === 403, 'root-relative requests cannot bypass the capability')
  check((await request(parsed.origin + '/wrong-capability/')).status === 403, 'wrong capability is rejected')
  check((await request(base + '%2e%2e/assets/client.js')).status === 403, 'normalized path traversal cannot escape capability')
  check((await request(new URL('assets/client.js', base), { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'script' } })).status === 403, 'cross-site subresource cannot consume a leaked capability')
  check((await request(base, { method: 'POST', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-dest': 'iframe' } })).status === 403, 'cross-site iframe POST is rejected')
  check(seen.length === nativeCount, 'rejected requests never contact native service')
  const redirect = await request(new URL('redirect-local', base))
  check(redirect.status === 302 && redirect.headers.location === new URL('assets/client.js?kept=yes', base).href && !redirect.headers['set-cookie'], 'same-native redirect is mapped back beneath capability without cookies')
  const external = await request(new URL('redirect-external', base))
  check(external.status === 502 && external.headers.location === undefined && !external.body.includes(TOKEN), 'external redirect is blocked without exposing native token')
  const tokenRedirect = await request(new URL('redirect-token', base))
  check(tokenRedirect.status === 502 && !JSON.stringify(tokenRedirect).includes(TOKEN), 'token-bearing native redirect never reaches browser')
  const ws = await websocket(base)
  check(ws.headers.startsWith('HTTP/1.1 101 ') && !/set-cookie/i.test(ws.headers), 'native WebSocket upgrade succeeds without sending native cookies')
  check(ws.messages.includes('welcome') && ws.messages.includes('echo:head'), 'both upstream and client upgrade head bytes reach their peers')
  const upgraded = seen.at(-1)
  check(upgraded.upgrade && upgraded.url === '/api/remote.mux?fixture=1' && upgraded.headers.cookie === COOKIE && upgraded.headers.origin === nativeOrigin, 'native mux receives mapped path and authenticated server-side headers')
  const wsBad = await websocket(base, { origin: 'https://foreign.invalid' })
  check(wsBad.headers.startsWith('HTTP/1.1 403 '), 'foreign-origin WebSocket is rejected before native upgrade')
  wsBad.socket.destroy()
  const nativeSocketCount = sockets.size
  ws.socket.destroy()
  await new Promise(resolve => setTimeout(resolve, 30))
  check(sockets.size < nativeSocketCount, 'client WebSocket close releases native tunnel')
  const wsNativeClose = await websocket(base, {}, 'native-close')
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('synthetic native-close timeout')), 2_000)
    wsNativeClose.socket.once('close', () => { clearTimeout(timer); resolve() })
  })
  check(wsNativeClose.socket.destroyed, 'native WebSocket close releases the browser tunnel')
  const wsDisposed = await websocket(base, {}, 'dispose')
  const closed = new Promise(resolve => wsDisposed.socket.once('close', resolve))
  await proxy.dispose(); await closed
  check(wsDisposed.socket.destroyed, 'dispose closes upgraded client connections')
  await assert.rejects(() => request(base)); assertions++
  await assert.rejects(() => proxy.connect(nativeOrigin, auth), /proxy is closed/); assertions++
  const invalid = new WebProxy()
  try {
    for (const [target, authenticated] of [
      ['https://127.0.0.1:1', auth], ['http://remote.invalid:1', 'http://remote.invalid:1/?token=' + TOKEN],
      [nativeOrigin, nativeOrigin + '/wrong?token=' + TOKEN], [nativeOrigin, auth + '&token=duplicate'],
      [nativeOrigin, auth + '&other=value'], [nativeOrigin, 'http://localhost:' + new URL(nativeOrigin).port + '/?token=' + TOKEN],
    ]) {
      await assert.rejects(() => invalid.connect(target, authenticated), error => !String(error).includes(TOKEN) && /Invalid DSH/.test(String(error)))
      assertions++
    }
    await assert.rejects(() => invalid.connect(nativeOrigin, nativeOrigin + '/?token=invalid'), error => !String(error).includes('token=') && /authentication failed/.test(String(error)))
    assertions++
  } finally { await invalid.dispose() }
  // localhost must reach either single-family listener without consulting DNS/hosts aliases.
  const ipv6 = http.createServer(native.listeners('request')[0])
  const ipv6Sockets = new Set()
  ipv6.on('connection', socket => { ipv6Sockets.add(socket); socket.on('close', () => ipv6Sockets.delete(socket)) })
  let ipv6Blocked
  try {
    await new Promise((resolve, reject) => {
      ipv6.once('error', reject)
      ipv6.listen({ host: '::1', port: 0, ipv6Only: true }, resolve)
    })
    // Probe bare TCP first: an OS policy denial is distinct from proxy behavior.
    await new Promise((resolve, reject) => {
      const socket = net.connect({ host: '::1', port: ipv6.address().port, family: 6 })
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('synthetic IPv6 capability probe timeout')) }, 2_000)
      socket.once('error', error => { clearTimeout(timer); reject(error) })
      socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve() })
    })
  } catch (error) {
    if (!['EACCES', 'EAFNOSUPPORT', 'ENETUNREACH'].includes(error.code)) {
      for (const socket of ipv6Sockets) socket.destroy()
      if (ipv6.listening) await new Promise(resolve => ipv6.close(resolve))
      throw error
    }
    ipv6Blocked = error.code
  }
  const originalLookup = dns.lookup
  const originalRequest = httpMutable.request
  const localhostOptions = []
  httpMutable.request = function (url, options, ...rest) {
    if (new URL(url).hostname === 'localhost') localhostOptions.push(options)
    return originalRequest.call(this, url, options, ...rest)
  }
  syncBuiltinESMExports()
  let dnsCalls = 0
  dns.lookup = (hostname, ...args) => {
    // Server.listen also invokes this API for literal bind addresses; those are not aliases.
    if (net.isIP(hostname)) return originalLookup(hostname, ...args)
    dnsCalls++; throw new Error('synthetic DNS alias must never be consulted')
  }
  try {
    const targets = [
      ['http://localhost:' + native.address().port, 'IPv4-only listener through localhost'],
      ...(ipv6Blocked ? [] : [
        ['http://localhost:' + ipv6.address().port, 'IPv6-only listener through localhost'],
        ['http://[::1]:' + ipv6.address().port, 'IPv6 loopback literal'],
      ]),
    ]
    for (const [target, label] of targets) {
      const familyProxy = new WebProxy()
      try {
        const familyBase = await familyProxy.connect(target, target + '/?token=' + TOKEN)
          .catch(error => { throw new Error(label + ': ' + error.message) })
        check((await request(familyBase)).status === 200, label + ' completes cookie bootstrap and serves HTML')
        const familyAsset = await request(new URL('assets/client.js', familyBase))
        check(familyAsset.status === 200 && seen.at(-1).headers.host === new URL(target).host, label + ' forwards assets while preserving native cookie authority')
      } finally { await familyProxy.dispose() }
    }
    check(localhostOptions.length >= 4 && localhostOptions.every(options => options.autoSelectFamily === true && typeof options.lookup === 'function'), 'all localhost bootstrap and forwarding requests explicitly enable fixed-address family selection')
    const candidates = await new Promise((resolve, reject) => {
      localhostOptions[0].lookup('localhost', { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses))
    })
    check(JSON.stringify(candidates) === JSON.stringify([{ address: '::1', family: 6 }, { address: '127.0.0.1', family: 4 }]), 'localhost lookup offers IPv6 and IPv4 loopback candidates without hardcoding one family')
    check(dnsCalls === 0, 'localhost fallback uses only fixed loopback addresses without DNS alias resolution')
  } finally {
    dns.lookup = originalLookup
    httpMutable.request = originalRequest
    syncBuiltinESMExports()
    for (const socket of ipv6Sockets) socket.destroy()
    if (ipv6.listening) await new Promise(resolve => ipv6.close(resolve))
  }
  console.log(assertions + ' Web proxy assertions passed (synthetic loopback HTTP/WS only; no DSH)')
  if (ipv6Blocked) console.log('2 IPv6 real-listener cases skipped: bare ::1 TCP capability probe returned ' + ipv6Blocked + '; fixed IPv6/IPv4 lookup and IPv4 localhost fallback were verified')
} finally {
  await proxy.dispose()
  for (const socket of clients) socket.destroy()
  for (const socket of sockets) socket.destroy()
  await new Promise(resolve => native.close(resolve))
}
