/** Guard the exact Git publication index, including deletions of old bundles. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
const git = (...args) => execFileSync('git', args)
const files = git('ls-files', '-z').toString().split('\0').filter(Boolean)
const forbidden = /(?:^|\/)(?:lib|dist|node_modules|\.codex|\.claude|claude-history|research)(?:\/|$)|\.(?:map|vsix|zip|jsonl)$/i
for (const file of files) {
  assert.ok(!forbidden.test(file), `Generated/private file in publication index: ${file}`)
  assert.ok(!/(?:^|\/)rsi[^/]*\.(?:tsx?|[cm]?js|md)$/i.test(file) || file.startsWith('docs/'), `Private RSI file: ${file}`)
  assert.ok(!file.endsWith('workspace-entry.tsx') && !file.includes('RSI-SPEC'), `Private RSI integration: ${file}`)
  if (/\.(?:tsx?|[cm]?js)$/.test(file) && file !== 'scripts/check-public-source.mjs') {
    const text = git('show', ':' + file).toString()
    assert.ok(!/(?:from\s*|import\s*\()["'][^"']*\brsi[^"']*["']|\b(?:class|function)\s+(?:Rsi|rsi)[A-Z]|\/dsh-cline\/rsi(?:[/'"])/.test(text), `Private RSI dependency: ${file}`)
  }
}
const prefix = 'https://raw.githubusercontent.com/DM010727/dsh-cline/main/packages/extension/media/readme/'
for (const name of ['README.md', 'packages/extension/README.md']) {
  const text = git('show', ':' + name).toString()
  const images = [...text.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(match => match[1])
  assert.equal(images.length, 5, name + ': expected five published images')
  for (const url of images) {
    assert.ok(url.startsWith(prefix), name + ': use a complete GitHub raw image URL')
    const path = 'packages/extension/media/readme/' + url.slice(prefix.length)
    assert.ok(files.includes(path), name + ': missing image in publication index')
  }
  assert.ok(text.includes('RSI 仍处于试验阶段，暂不开源'), name + ': missing source availability notice')
  assert.ok(!text.includes('RSI-SPEC-v1.md'), name + ': link to withheld specification')
}
console.log(JSON.stringify({ publicFiles: files.length, readmes: 2, images: 5, privateSourceAndBundlesExcluded: true }))
