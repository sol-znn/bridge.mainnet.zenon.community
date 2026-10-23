// Only the pinned lab node's explicit pre-publication validation failures may
// release a prepared fixture. Transport/internal errors keep the original hash.
import fs from 'node:fs'
import path from 'node:path'
import { RpcError } from '../../src/znn/client.ts'
import type { BlockJson } from '../../src/znn/block.ts'

export function archiveRejectedPublication(file: string, identity: string, block: BlockJson, error: unknown): boolean {
  if (!(error instanceof RpcError)) return false
  const missingCache = `can't find cacheStore for {${block.momentumAcknowledged.hash} ${block.momentumAcknowledged.height}}`
  const validationErrors = [
    missingCache,
    'supervisor - VM panic',
    'account-block momentum-acknowledged points to missing momentum',
    'account-block momentum-acknowledged points to an older momentum than previous',
    'not enough plasma on account',
    'not enough TotalPlasma provided for account-block (PoW + Fused)',
    'plasma limit for account-block reached',
  ]
  // RPC protocol/parameter rejection happens before execution. The listed
  // -32000 errors are returned by VM/verifier checks before insertion/broadcast
  // in the pinned go-zenon source. An arbitrary -32000 is not that evidence.
  // ApplyBlock returns a nil transaction on its explicit supervisor panic;
  // LedgerApi returns that error before calling the broadcaster.
  if (![-32600, -32601, -32602].includes(error.code) && !(error.code === -32000 && validationErrors.includes(error.message))) return false
  if (!/^[0-9a-f]{64}$/i.test(block.hash)) throw new Error('Invalid prepared fixture hash')
  const original = fs.readFileSync(file, 'utf8')
  const pending = JSON.parse(original)
  if (pending.identity !== identity || JSON.stringify(pending.block) !== JSON.stringify(block)) throw new Error('Prepared fixture changed; preserve its evidence')
  const directory = path.join(path.dirname(file), 'rejected')
  fs.mkdirSync(directory, { recursive: true })
  const receipt = path.join(directory, `${block.hash}.json`)
  const content = JSON.stringify({ ...pending, outcome: 'REJECTED_BEFORE_PUBLICATION', error: { code: error.code, message: error.message } }, null, 2)
  if (!fs.existsSync(receipt)) fs.writeFileSync(receipt, content, { flag: 'wx' })
  if (fs.readFileSync(receipt, 'utf8') !== content || fs.readFileSync(file, 'utf8') !== original) throw new Error('Fixture rejection evidence changed; keep the pending record')
  fs.unlinkSync(file)
  return true
}
