import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { allPages } from '../../src/core/paging.ts'

const account = '0x' + '12'.repeat(20), contract = '0x' + '34'.repeat(20)
const hash = '0x' + 'ab'.repeat(32)
const intent = { source: 'evm' as const, chainId: 1, account, kind: 'fixture-send', payload: JSON.stringify({ to: contract, data: '0x1234', value: '7' }) }
let storage: Map<string, string>
beforeEach(() => {
  vi.resetModules()
  storage = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) })
})
afterEach(() => vi.unstubAllGlobals())

describe('durable original-operation ownership', () => {
  it('refuses a wallet request when another browser tab owns publication', async () => {
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, callback) => callback(null)) } })
    const { journalSubmission } = await import('../../src/state/operations.ts')
    const send = vi.fn(async () => hash)
    await expect(journalSubmission(intent, () => {}, send)).rejects.toThrow('Another tab')
    expect(send).not.toHaveBeenCalled(); expect(storage.size).toBe(0)
  })
  it('fails closed without exclusive browser ownership and retains another tab\'s pending identity', async () => {
    const { beginOperation, operations } = await import('../../src/state/operations.ts')
    const first = beginOperation(intent)
    operations.entries = []
    expect(() => beginOperation(intent)).toThrow('unresolved')
    expect(operations.entries[0].id).toBe(first.id)
    vi.stubGlobal('window', {}); vi.stubGlobal('navigator', {})
    const { journalSubmission } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, async () => hash)).rejects.toThrow('exclusive')
  })
  it('persists the exact intent before invoking the wallet and accepts its late original hash', async () => {
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    let resolve!: (hash: string) => void
    const send = vi.fn(() => {
      expect(JSON.parse(storage.get('bridge.operations.v1')!)[0]).toMatchObject({ ...intent, state: 'awaiting-wallet' })
      return new Promise<string>((r) => { resolve = r })
    })
    const pending = journalSubmission(intent, () => {}, send)
    await expect(journalSubmission(intent, () => {}, send)).rejects.toThrow('unresolved')
    expect(send).toHaveBeenCalledTimes(1)
    resolve(hash)
    expect(await pending).toMatchObject({ hash })
    expect(operations.entries[0]).toMatchObject({ ...intent, hash, state: 'submitted' })
  })
  it('does not invoke a wallet when storage cannot retain the intent', async () => {
    const { journalSubmission } = await import('../../src/state/operations.ts')
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} })
    const send = vi.fn(async () => hash)
    await expect(journalSubmission(intent, () => {}, send)).rejects.toThrow('Cannot save')
    expect(send).not.toHaveBeenCalled()
  })
  it.each([new Error('transport closed'), { code: -1 }, 'timeout'])('retains an unknown outcome and refuses a replacement after %s', async (failure) => {
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, async () => { throw failure })).rejects.toBe(failure)
    expect(operations.entries[0].state).toBe('unknown')
    await expect(journalSubmission(intent, () => {}, async () => hash)).rejects.toThrow('unresolved')
  })
  it('keeps invalid hashes unresolved and mismatching responses retain the reported exact hash', async () => {
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, async () => 'not-a-hash')).rejects.toThrow('valid transaction hash')
    expect(operations.entries[0]).toMatchObject({ state: 'unknown' })
    await expect(journalSubmission({ ...intent, account: '0x' + '56'.repeat(20) }, () => {}, async () => { throw { reportedHash: hash } })).rejects.toMatchObject({ reportedHash: hash })
    expect(operations.entries[1]).toMatchObject({ state: 'mismatch', hash })
  })
  it('resolves a local pre-prompt refusal without treating it as a publication', async () => {
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    const { NotSubmittedError } = await import('../../src/core/errors.ts')
    await expect(journalSubmission(intent, () => {}, async () => { throw new NotSubmittedError('context changed') })).rejects.toThrow('context changed')
    expect(operations.entries[0].state).toBe('rejected')
  })
  it('restores awaiting-wallet as unknown and never replaces a recorded hash', async () => {
    const { beginOperation, restoreOperations, operations, updateOperation } = await import('../../src/state/operations.ts')
    const entry = beginOperation(intent)
    restoreOperations()
    expect(operations.entries[0].state).toBe('unknown')
    updateOperation(entry.id, { state: 'submitted', hash })
    expect(() => updateOperation(entry.id, { state: 'submitted', hash: '0x' + 'cd'.repeat(32) })).toThrow('cannot be replaced')
    expect(operations.entries[0].hash).toBe(hash)
  })
  // Exercise all 205 durable write/readbacks; instrumented shared CI runners
  // can exceed the default five-second budget without an assertion failure.
  it('retains nonterminal records when terminal history is bounded', async () => {
    const { beginOperation, updateOperation } = await import('../../src/state/operations.ts')
    const pending = beginOperation(intent)
    updateOperation(pending.id, { state: 'unknown' })
    for (let index = 0; index < 205; index++) {
      const entry = beginOperation({ ...intent, account: '0x' + '56'.repeat(20) })
      updateOperation(entry.id, { state: 'rejected' })
    }
    const records = JSON.parse(storage.get('bridge.operations.v1')!)
    expect(records).toHaveLength(201)
    expect(records.find((r: { id: string }) => r.id === pending.id)?.state).toBe('unknown')
  }, 20_000)
  it('fails closed on malformed storage and intent fields', async () => {
    storage.set('bridge.operations.v1', '{}')
    const { operations, beginOperation, restoreOperations } = await import('../../src/state/operations.ts')
    expect(operations.error).toContain('unavailable')
    expect(() => beginOperation(intent)).toThrow('unavailable')
    storage.delete('bridge.operations.v1'); restoreOperations()
    expect(() => beginOperation({ ...intent, payload: '{}' })).toThrow('Invalid operation intent')
  })
})

function reader(status: 'success' | 'reverted' = 'success') {
  const receipt = { transactionHash: hash, status, blockNumber: 10n, blockHash: '0x' + 'ef'.repeat(32),from:account,to:contract }
  return {
    getChainId: vi.fn(async () => 1), waitForTransactionReceipt: vi.fn(async () => receipt),
    getTransactionReceipt: vi.fn(async () => receipt),
    getTransaction: vi.fn(async () => ({ hash, from: account, to: contract, input: '0x1234', value: 7n,blockNumber:receipt.blockNumber,blockHash:receipt.blockHash })),
    getBlock: vi.fn(async () => ({ hash: receipt.blockHash })), getBlockNumber: vi.fn(async () => 11n),
  }
}
describe('original EVM receipt evidence', () => {
  it('accepts only the original matching transaction and canonical confirmed receipt', async () => {
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await journalSubmission(intent, () => {}, async () => hash)
    const { successfulReceipt } = await import('../../src/evm/transactions.ts')
    await expect(successfulReceipt(reader() as any, 1, hash as `0x${string}`)).resolves.toMatchObject({ status: 'success' })
    expect(operations.entries[0].state).toBe('confirmed')
  })
  it('records reversion and never reports completion', async () => {
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await journalSubmission(intent, () => {}, async () => hash)
    const { successfulReceipt } = await import('../../src/evm/transactions.ts')
    await expect(successfulReceipt(reader('reverted') as any, 1, hash as `0x${string}`)).rejects.toThrow('reverted')
    expect(operations.entries[0].state).toBe('reverted')
  })
  it.each(['replacement', 'wrong-chain', 'wrong-payload', 'reorg', 'missing-receipt','inclusion-mismatch','receipt-account-mismatch'])('keeps %s unresolved without changing the hash', async (scenario) => {
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await journalSubmission(intent, () => {}, async () => hash)
    const c = reader()
    if (scenario === 'replacement') c.waitForTransactionReceipt.mockResolvedValue({ ...await c.getTransactionReceipt(), transactionHash: '0x' + 'cd'.repeat(32) })
    if (scenario === 'wrong-chain') c.getChainId.mockResolvedValue(56)
    if (scenario === 'wrong-payload') c.getTransaction.mockResolvedValue({ ...await c.getTransaction(), value: 8n })
    if (scenario === 'reorg') c.getBlock.mockResolvedValue({ hash: '0x' + '00'.repeat(32) })
    if (scenario === 'missing-receipt') c.waitForTransactionReceipt.mockRejectedValue(new Error('timeout'))
    if (scenario === 'inclusion-mismatch') c.getTransaction.mockResolvedValue({...await c.getTransaction(),blockNumber:9n})
    if (scenario === 'receipt-account-mismatch') c.getTransactionReceipt.mockResolvedValue({...await c.getTransactionReceipt(),from:'0x'+'78'.repeat(20)})
    const { successfulReceipt } = await import('../../src/evm/transactions.ts')
    await expect(successfulReceipt(c as any, 1, hash as `0x${string}`)).rejects.toThrow()
    expect(operations.entries[0]).toMatchObject({ state: 'unknown', hash })
  })
})

describe('complete bounded history', () => {
  it('reads entries beyond the first page', async () => {
    const rows = Array.from({ length: 151 }, (_, id) => id)
    const read = vi.fn(async (index: number, size: number) => ({ count: rows.length, list: rows.slice(index * size, (index + 1) * size) }))
    expect(await allPages(read)).toEqual(rows)
    expect(read.mock.calls).toEqual([[0, 100], [1, 100]])
  })
  it('rejects partial and changing counts instead of claiming a complete history', async () => {
    await expect(allPages(async () => ({ count: 51, list: [] }))).rejects.toThrow('incomplete')
    await expect(allPages(async (index) => ({ count: index ? 101 : 102, list: Array(index ? 1 : 100).fill(0) }))).rejects.toThrow('changed while paging')
  })
  it('discards a deferred page when the owning context changes', async () => {
    let current = true
    await expect(allPages(async () => { current = false; return { count: 0, list: [] } }, () => current)).rejects.toThrow('context changed')
  })
})
