import { afterEach, beforeEach, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { archiveRejectedPublication } from '../../e2e/lib/publication-journal.ts'
import { blockTemplate } from '../../src/znn/block.ts'
import { RpcError } from '../../src/znn/client.ts'
import { EMPTY_ADDRESS } from '../../src/znn/primitives.ts'
let directory: string, file: string
const block = { ...blockTemplate({ blockType: 2, toAddress: EMPTY_ADDRESS }, 322), hash: 'ab'.repeat(32), momentumAcknowledged: { hash: 'cd'.repeat(32), height: 1 } }
const identity = 'original-fixture-intent'
const pending = () => JSON.stringify({ identity, block })
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(process.env.SPV_TASK_SCRATCH || os.tmpdir(), 'bridge-journal-'))
  file = path.join(directory, 'publication.json'); fs.writeFileSync(file, pending())
})
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }))

it('archives a cold-start cache rejection and releases only its matching pending block', () => {
  const error = new RpcError(-32000, `can't find cacheStore for {${block.momentumAcknowledged.hash} 1}`)
  expect(archiveRejectedPublication(file, identity, block, error)).toBe(true)
  expect(fs.existsSync(file)).toBe(false)
  expect(JSON.parse(fs.readFileSync(path.join(directory, 'rejected', block.hash+'.json'), 'utf8'))).toEqual({ identity, block, outcome:'REJECTED_BEFORE_PUBLICATION', error:{code:error.code,message:error.message} })
  fs.writeFileSync(file, pending(), {flag:'wx'}) // A later explicit attempt can prepare; no automatic resend.
})

it('retains the original signed block after transport, malformed, internal or unclassified RPC errors', () => {
  for (const error of [new Error('connection closed'), new Error('RPC HTTP 500'), new Error('Malformed RPC response'), new Error('no answer within 20 s'), new RpcError(-32603, 'internal error'), new RpcError(-32000, 'unknown insertion failure'), {code:-32000,message:'not enough plasma on account'}]) {
    expect(archiveRejectedPublication(file, identity, block, error)).toBe(false)
    expect(fs.readFileSync(file, 'utf8')).toBe(pending())
    expect(fs.existsSync(path.join(directory,'rejected'))).toBe(false)
  }
})

it('archives the pinned supervisor rejection before a transaction can be inserted or broadcast', () => {
  expect(archiveRejectedPublication(file, identity, block, new RpcError(-32000, 'supervisor - VM panic'))).toBe(true)
  expect(fs.existsSync(file)).toBe(false)
  expect(JSON.parse(fs.readFileSync(path.join(directory,'rejected',block.hash+'.json'),'utf8')).block.hash).toBe(block.hash)
})

it('requires the exact acknowledged momentum in a cache rejection', () => {
  expect(archiveRejectedPublication(file, identity, block, new RpcError(-32000, `can't find cacheStore for {${'ef'.repeat(32)} 1}`))).toBe(false)
  expect(archiveRejectedPublication(file, identity, block, new RpcError(-32000, `can't find cacheStore for {${block.momentumAcknowledged.hash} 2}`))).toBe(false)
  expect(fs.readFileSync(file,'utf8')).toBe(pending())
})

it('retains conflicting journal or rejection evidence without overwriting it', () => {
  const error = new RpcError(-32602, 'invalid params')
  expect(() => archiveRejectedPublication(file, 'other-intent', block, error)).toThrow('changed')
  fs.mkdirSync(path.join(directory,'rejected')); const receipt=path.join(directory,'rejected',block.hash+'.json');fs.writeFileSync(receipt,'existing evidence')
  expect(() => archiveRejectedPublication(file, identity, block, error)).toThrow('evidence changed')
  expect(fs.readFileSync(file,'utf8')).toBe(pending());expect(fs.readFileSync(receipt,'utf8')).toBe('existing evidence')
})

it('archives explicit protocol rejection but does not create a replacement transaction', () => {
  expect(archiveRejectedPublication(file, identity, block, new RpcError(-32602, 'invalid params'))).toBe(true)
  expect(fs.readdirSync(directory)).toEqual(['rejected'])
})
