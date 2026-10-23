// Compiles e2e/contracts with solc-js. Imports resolve from node_modules, so
// OpenZeppelin comes from the pinned npm package. The result is cached in
// e2e/.cache by compiler, settings, direct sources and imported package tree.

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { Abi } from 'viem'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const contractsDir = path.join(here, '..', 'contracts')
const cacheDir = path.join(here, '..', '.cache')
const nodeModules = path.join(here, '..', '..', 'node_modules')

export interface Artifact {
  abi: Abi
  bytecode: `0x${string}`
}

export function compilerKey(inputs: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(inputs)).digest('hex')
}

export function compileContracts(): { Bridge: Artifact; TestToken: Artifact } {
  const sources: Record<string, { content: string }> = {}
  for (const f of ['Bridge.sol', 'TestToken.sol']) sources[f] = { content: fs.readFileSync(path.join(contractsDir, f), 'utf8') }
  const solc = require('solc')
  const input = {
    language: 'Solidity',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } },
    },
  }
  const imports: Record<string, string> = {}
  const collect = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name)
      if (entry.isDirectory()) collect(file)
      else if (entry.name.endsWith('.sol')) imports[path.relative(nodeModules, file).split(path.sep).join('/')] = fs.readFileSync(file, 'utf8')
    }
  }
  collect(path.join(nodeModules, '@openzeppelin', 'contracts'))
  const inputs = { compiler: solc.version(), input, imports }
  const key = compilerKey(inputs), cached = path.join(cacheDir, `contracts-${key}.json`)
  if (fs.existsSync(cached)) {
    const saved = JSON.parse(fs.readFileSync(cached, 'utf8'))
    if (saved.key === key && saved.artifacts?.Bridge && saved.artifacts?.TestToken) return saved.artifacts
    throw new Error('Solidity cache provenance is invalid')
  }
  const findImports = (p: string) => {
    try {
      if (!(p in imports)) throw new Error('Import is outside the pinned contract tree')
      return { contents: imports[p] }
    } catch {
      return { error: `not found: ${p}` }
    }
  }
  const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }))
  const errors = (out.errors ?? []).filter((e: { severity: string }) => e.severity === 'error')
  if (errors.length) throw new Error(errors.map((e: { formattedMessage: string }) => e.formattedMessage).join('\n'))
  const pick = (file: string, name: string): Artifact => ({
    abi: out.contracts[file][name].abi,
    bytecode: `0x${out.contracts[file][name].evm.bytecode.object}`,
  })
  const result = { Bridge: pick('Bridge.sol', 'Bridge'), TestToken: pick('TestToken.sol', 'TestToken') }
  fs.mkdirSync(cacheDir, { recursive: true })
  const manifest = { compiler: inputs.compiler, key, settings: input.settings,
    sourceHashes: Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, compilerKey(source.content)])),
    importHashes: Object.fromEntries(Object.entries(imports).map(([name, content]) => [name, compilerKey(content)])) }
  fs.writeFileSync(cached, JSON.stringify({ key, manifest, artifacts: result }))
  fs.writeFileSync(path.join(cacheDir, 'compile-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  return result
}
