import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
export const here = path.dirname(fileURLToPath(import.meta.url))
export const digest = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')
export function verifiedBuild(mode) {
  const manifest = JSON.parse(fs.readFileSync(path.join(here, '.build/manifest.json')))
  const pins = JSON.parse(fs.readFileSync(path.join(here, 'pins.json')))
  if (manifest.mode !== mode || JSON.stringify(manifest.pins) !== JSON.stringify(pins)
    || manifest.sourceCommit !== pins.goZenonCommit || manifest.sourceTree !== pins.goZenonTree) throw new Error('Lab build identity changed; rebuild before starting')
  for (const [name, hash] of Object.entries(manifest.overlayHashes)) {
    if (digest(fs.readFileSync(path.join(here, name))) !== hash) throw new Error(`Lab input changed: ${name}; rebuild before starting`)
  }
  if (mode === 'native' && digest(fs.readFileSync(path.join(here, '.build/znnd'))) !== manifest.binaryHash) throw new Error('Lab binary does not match its build manifest')
  return manifest
}
if (process.argv[1] === fileURLToPath(import.meta.url)) verifiedBuild(process.argv[2] ?? 'docker')
