import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { ed25519 } from '@noble/curves/ed25519'
import { blockTemplate, computeBlockHash } from '../../src/znn/block.ts'
import { addressFromPublicKey, formatAddress, toBase64, toHex, ZNN_ZTS } from '../../src/znn/primitives.ts'
import { BRIDGE } from '../../src/config.ts'

beforeEach(() => { vi.resetModules(); const storage = new Map(); vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) }) })
afterEach(() => vi.unstubAllGlobals())
function fixture(confirmations = 1) {
  // Public deterministic test seed, unrelated to any user or funded account.
  const seed = new Uint8Array(32).fill(1), pub = ed25519.getPublicKey(seed)
  const block = blockTemplate({ toAddress: BRIDGE, amount: 7n, tokenStandard: ZNN_ZTS }, 322)
  block.address = formatAddress(addressFromPublicKey(pub)); block.height = 1
  block.momentumAcknowledged = { hash: 'cd'.repeat(32), height: 10 }
  block.hash = toHex(computeBlockHash(block)); block.publicKey = toBase64(pub); block.signature = toBase64(ed25519.sign(computeBlockHash(block), seed))
  const payload = JSON.stringify({ toAddress: block.toAddress, amount: block.amount, tokenStandard: block.tokenStandard, data: block.data, fromBlockHash: block.fromBlockHash, blockType: block.blockType })
  return { block: { ...block, confirmationDetail: { numConfirmations: confirmations } }, intent: { source: 'zenon' as const, chainId: 322, account: block.address, kind: 'fixture-send', payload } }
}
describe('exact Zenon evidence reconciliation', () => {
  it('validates hash, signature, account, chain and the original chosen fields', async () => {
    const { block, intent } = fixture()
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await journalSubmission(intent, () => {}, async () => block.hash)
    const { reconcileZenon } = await import('../../src/state/reconcile.ts')
    const read = vi.fn(async () => block)
    expect(await reconcileZenon({ c: { callOrNull: read } } as any, operations.entries[0])).toBe(true)
    expect(read).toHaveBeenCalledWith('ledger.getAccountBlockByHash', [block.hash])
    expect(operations.entries[0]).toMatchObject({ state: 'confirmed', hash: block.hash })
  })
  it('keeps an unconfirmed matching block submitted without enabling a replacement', async () => {
    const { block, intent } = fixture(0)
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await journalSubmission(intent, () => {}, async () => block.hash)
    const { reconcileZenon } = await import('../../src/state/reconcile.ts')
    expect(await reconcileZenon({ c: { callOrNull: async () => block } } as any, operations.entries[0])).toBe(false)
    expect(operations.entries[0].state).toBe('submitted')
  })
  it.each(['hash', 'signature', 'amount', 'chain', 'mismatch-state'])('rejects %s evidence without clearing the original operation', async (field) => {
    const { block, intent } = fixture()
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await journalSubmission(intent, () => {}, async () => block.hash)
    const original = block.hash
    if (field === 'hash') block.hash = 'ef'.repeat(32)
    if (field === 'signature') block.signature = toBase64(new Uint8Array(64))
    if (field === 'amount') block.amount = '8'
    if (field === 'chain') block.chainIdentifier = 1
    if (field === 'mismatch-state') operations.entries[0].state = 'mismatch'
    const { reconcileZenon } = await import('../../src/state/reconcile.ts')
    await expect(reconcileZenon({ c: { callOrNull: async () => block } } as any, operations.entries[0])).rejects.toThrow()
    expect(operations.entries[0].hash).toBe(original); expect(operations.entries[0].state).not.toBe('confirmed')
  })
  it('ignores missing or obsolete reads', async () => {
    const { block, intent } = fixture()
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await journalSubmission(intent, () => {}, async () => block.hash)
    const { reconcileZenon } = await import('../../src/state/reconcile.ts')
    expect(await reconcileZenon({ c: { callOrNull: async () => null } } as any, operations.entries[0])).toBe(false)
    expect(await reconcileZenon({ c: { callOrNull: async () => block } } as any, operations.entries[0], block.hash, () => false)).toBe(false)
    expect(operations.entries[0].state).toBe('submitted')
  })
})
