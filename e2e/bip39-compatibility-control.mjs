import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { loadEnglishWordlist } from './lib/bip39-wordlist.mjs'

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const fixture = process.env.BIP39_FIXTURE_ROOT
const version = process.env.EXPECTED_BIP39_VERSION
assert(fixture && path.isAbsolute(fixture) && fs.lstatSync(fixture).isDirectory() && !fs.lstatSync(fixture).isSymbolicLink())
assert(['1.6.0', '2.4.0'].includes(version))
const load = createRequire(path.join(fixture, 'package.json'))
const installed = JSON.parse(fs.readFileSync(path.join(fixture, 'node_modules/@scure/bip39/package.json')))
const lockBytes = fs.readFileSync(path.join(fixture, 'package-lock.json'))
const fixturePackages = Object.entries(JSON.parse(lockBytes).packages).filter(([name]) => name).map(([name, entry]) => {
  assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/=]+$/)
  return { packagePath: name, version: entry.version, integrity: entry.integrity }
})
const locked = fixturePackages.find(entry => entry.packagePath === 'node_modules/@scure/bip39')
assert.equal(installed.version, version)
assert.equal(locked.version, version)
assert.match(locked.integrity, /^sha512-[A-Za-z0-9+/=]+$/)
let legacyExportRejected = false
try { load('@scure/bip39/wordlists/english') } catch (error) {
  assert.equal(error.code, 'ERR_PACKAGE_PATH_NOT_EXPORTED')
  legacyExportRejected = true
}
assert.equal(legacyExportRejected, version === '2.4.0')
const words = loadEnglishWordlist(load)
const bip39 = load('@scure/bip39')
// Published Trezor BIP39 vectors, using their fixed synthetic test passphrase.
// Keep phrases and seeds out of the report.
const vectors = [
  { entropy: '00'.repeat(16), seedSha256: 'c08dda51da02e763c64e8978ca31647b6b29cb0c28ef29c2633fad02bf3eb9a0' },
  { entropy: '7f'.repeat(16), seedSha256: 'ef627689ebfaea17d3b367d63cda71b59bd333462163aa2e4e98a54c1999886e' },
]
const outcomes = vectors.map(vector => {
  const entropy = Buffer.from(vector.entropy, 'hex')
  const phrase = bip39.entropyToMnemonic(entropy, words)
  assert.equal(bip39.validateMnemonic(phrase, words), true)
  assert.equal(Buffer.from(bip39.mnemonicToEntropy(phrase, words)).toString('hex'), vector.entropy)
  const seed = bip39.mnemonicToSeedSync(phrase, 'TREZOR')
  assert.equal(seed.byteLength, 64)
  assert.equal(sha(seed), vector.seedSha256)
  return { entropyBits: entropy.byteLength * 8, seedSha256: sha(seed), valid: true, roundTrip: true }
})
assert.equal(bip39.validateMnemonic('invalid fixture', words), false)
const root = fileURLToPath(new URL('..', import.meta.url))
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
const dirty = spawnSync('git', ['diff', '--quiet'], { cwd: root }).status !== 0
if (dirty) assert(process.env.GITHUB_ACTIONS !== 'true' && process.env.BIP39_ALLOW_DIRTY_SOURCE === '1')
const inputs = ['e2e/bip39-compatibility-control.mjs', 'e2e/lib/bip39-wordlist.mjs', 'e2e/lib/bip39-wordlist.d.mts', 'e2e/lib/wallet.ts', '.github/workflows/qualification.yml']
const report = {
  schema: 1, status: 'PASS', scope: 'ISOLATED_PUBLISHED_BIP39_PACKAGE_COMPATIBILITY_ONLY',
  sourceCommit: git(['rev-parse', 'HEAD']), sourceTree: git(['rev-parse', 'HEAD^{tree}']), sourceDirty: dirty,
  sourceFiles: Object.fromEntries(inputs.map(name => [name, sha(fs.readFileSync(path.join(root, name)))])),
  sourceLockfileSha256: sha(fs.readFileSync(path.join(root, 'package-lock.json'))),
  nodeVersion: process.versions.node, packageVersion: version, packageIntegrity: locked.integrity,
  fixtureAssembly: process.env.GITHUB_ACTIONS === 'true' ? 'NPM_EXACT_INSTALL' : 'EXPLICIT_SRI_VERIFIED_ARCHIVE_FIXTURE',
  fixtureLockfileSha256: sha(lockBytes), legacyExportRejected, wordCount: words.length,
  fixturePackages,
  wordlistSha256: sha(words.join('\n') + '\n'), vectorSource: 'https://github.com/trezor/python-mnemonic/blob/master/vectors.json',
  vectors: outcomes, invalidPhraseRejected: true, rawPhrasesOrSeedsPublished: false,
  realWalletExecutions: 0, fullNativeExecutions: 0, liveChainWrites: 0,
}
const reportPath = process.env.BIP39_REPORT_PATH ?? path.join(root, '.browser-results/bip39-compatibility.json')
assert(path.isAbsolute(reportPath))
if (dirty) assert(process.env.BIP39_REPORT_PATH)
fs.mkdirSync(path.dirname(reportPath), { recursive: true })
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
console.log(`BIP39 ${version}: export compatibility, English wordlist and two published seed vectors passed.`)
