const url = process.argv[2]
try {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ service: 'vscode.host', method: 'ping', args: [] }), signal: AbortSignal.timeout(8000) })
  console.log('PROBE_STATUS=' + res.status)
  console.log('PROBE_BODY=' + await res.text())
} catch (err) {
  console.log('PROBE_FAIL=' + String(err))
  if (err.cause) console.log('PROBE_CAUSE=' + String(err.cause))
}