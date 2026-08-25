// Gate 2 e2e bridge simulator: serves the same {service,method,args}->{ok,result} envelope.
// Usage: node test/bridge-simulator.mjs  -> prints BRIDGE_URL=<url> and stays up.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'

const token = randomBytes(24).toString('base64url')
const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname !== '/' + token || req.method !== 'POST') {
    res.writeHead(404).end()
    return
  }
  let body = ''
  for await (const chunk of req) body += chunk
  const request = JSON.parse(body)
  if (request.service === 'vscode.host' && request.method === 'ping') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, result: { pong: true, extensionVersion: 'simulator-0.1.0' } }))
    return
  }
  res.writeHead(404, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ ok: false, error: 'no handler' }))
})
server.listen(0, '127.0.0.1', () => {
  const a = server.address()
  console.log('BRIDGE_URL=http://127.0.0.1:' + a.port + '/' + token)
})
