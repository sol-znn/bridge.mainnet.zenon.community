import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWalletClient, custom, TransactionExecutionError, UserRejectedRequestError } from 'viem'
import { mainnet } from 'viem/chains'

const account = ('0x' + '12'.repeat(20)) as `0x${string}`
const to = ('0x' + '34'.repeat(20)) as `0x${string}`
const hash = '0x' + 'ab'.repeat(32), other = '0x' + 'cd'.repeat(32)
const intent = { source: 'evm' as const, chainId: 1, account, kind: 'fixture-send', payload: JSON.stringify({ to, data: '0x1234', value: '7' }) }
let storage: Map<string, string>
beforeEach(() => {
  vi.resetModules()
  storage = new Map()
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) })
})
afterEach(() => vi.unstubAllGlobals())

describe('actual wallet publication error boundaries', () => {
  it('records an actual viem-wrapped user rejection without another signature request', async () => {
    const provider = { request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1'
      if (method === 'eth_sendTransaction') throw Object.assign(new Error('User denied the request'), { code: 4001 })
      throw new Error('Unexpected fixture method')
    }) }
    const client = createWalletClient({ chain: mainnet, account, transport: custom(provider) })
    const { journalSubmission, operations, restoreOperations } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, () => client.sendTransaction({ to, data: '0x1234', value: 7n }))).rejects.toBeInstanceOf(TransactionExecutionError)
    expect(provider.request.mock.calls.filter(([r]) => r.method === 'eth_sendTransaction')).toHaveLength(1)
    expect(operations.entries[0]).toMatchObject({ ...intent, state: 'rejected' })
    expect(operations.entries[0].hash).toBeUndefined()
    restoreOperations()
    expect(operations.entries[0]).toMatchObject({ ...intent, state: 'rejected' })
  })
  it('keeps a wrapped transport failure unresolved and never invokes a replacement', async () => {
    const provider = { request: vi.fn(async ({ method }: { method: string }) => {
      if (method === 'eth_chainId') return '0x1'
      throw new Error('Transport closed after the request')
    }) }
    const client = createWalletClient({ chain: mainnet, account, transport: custom(provider) })
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, () => client.sendTransaction({ to, data: '0x1234', value: 7n }))).rejects.toBeInstanceOf(TransactionExecutionError)
    expect(operations.entries[0]).toMatchObject({ ...intent, state: 'unknown' })
    const replacement = vi.fn(async () => hash)
    await expect(journalSubmission(intent, () => {}, replacement)).rejects.toThrow('unresolved')
    expect(replacement).not.toHaveBeenCalled()
    expect(provider.request.mock.calls.filter(([r]) => r.method === 'eth_sendTransaction')).toHaveLength(1)
  })
  it.each([{ message: 'User rejected the request', cause: { code: 4001 } }, { code: '4001' }, { name: 'TransactionExecutionError', cause: { name: 'UserRejectedRequestError', code: 4001 } }])('does not infer refusal from display text or lookalike wrappers', async (failure) => {
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, async () => { throw failure })).rejects.toBe(failure)
    expect(operations.entries[0].state).toBe('unknown')
  })
  it('prioritizes a reported hash over a refusal code and retains it after reload', async () => {
    const failure = Object.assign(new UserRejectedRequestError(Object.assign(new Error('fixture'), { reportedHash: hash })), { code: 4001 })
    const wrapped = new TransactionExecutionError(failure, { account: { address: account, type: 'json-rpc' }, chain: mainnet, to, value: 7n })
    const { journalSubmission, operations, restoreOperations } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, async () => { throw wrapped })).rejects.toBe(wrapped)
    expect(operations.entries[0]).toMatchObject({ state: 'mismatch', hash, reportedHashes: [hash] })
    restoreOperations()
    expect(operations.entries[0]).toMatchObject({ state: 'mismatch', hash, reportedHashes: [hash] })
  })
  it('preserves conflicting exact reports without choosing a hash or reopening publication', async () => {
    const failure = { reportedHash: hash, cause: { reportedHash: other, code: 4001 } }
    const { journalSubmission, operations, restoreOperations } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, async () => { throw failure })).rejects.toBe(failure)
    expect(operations.entries[0]).toMatchObject({ state: 'mismatch', reportedHashes: [hash, other] })
    expect(operations.entries[0].hash).toBeUndefined()
    restoreOperations()
    const replacement = vi.fn(async () => hash)
    await expect(journalSubmission(intent, () => {}, replacement)).rejects.toThrow('unresolved')
    expect(replacement).not.toHaveBeenCalled()
  })
  it('leaves cyclic or unreadable error evidence unresolved', async () => {
    const cyclic: { code: number; cause?: unknown } = { code: 4001 }; cyclic.cause = cyclic
    const unreadable = Object.defineProperty({ code: 4001 }, 'cause', { get() { throw new Error('Unreadable fixture') } })
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    for (const [index, failure] of [cyclic, unreadable].entries()) {
      await expect(journalSubmission({ ...intent, account: ('0x' + (index ? '56' : '78').repeat(20)) }, () => {}, async () => { throw failure })).rejects.toBe(failure)
    }
    expect(operations.entries.map((r) => r.state)).toEqual(['unknown', 'unknown'])
  })
  it('does not treat a cause chain beyond the evidence bound as a refusal', async () => {
    let failure: { code?: number; cause?: unknown } = {}
    for (let depth = 0; depth < 9; depth++) failure = { cause: failure }
    failure.code = 4001
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, async () => { throw failure })).rejects.toBe(failure)
    expect(operations.entries[0].state).toBe('unknown')
  })
  it('holds malformed reported hash evidence despite a refusal code', async () => {
    const failure = { code: 4001, reportedHash: 'not-a-hash' }
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, async () => { throw failure })).rejects.toBe(failure)
    expect(operations.entries[0].state).toBe('mismatch')
    expect(operations.entries[0].hash).toBeUndefined()
  })
  it('refuses replacement or removal of original conflicting reports', async () => {
    const failure = { reportedHash: hash, cause: { reportedHash: other } }
    const { journalSubmission, operations, updateOperation } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, async () => { throw failure })).rejects.toBe(failure)
    const original = operations.entries[0]
    expect(() => updateOperation(original.id, { state: 'mismatch', reportedHashes: [hash] })).toThrow('cannot be replaced')
    expect(() => updateOperation(original.id, { state: 'mismatch', reportedHashes: undefined })).toThrow('cannot be replaced')
    expect(() => updateOperation(original.id, { state: 'mismatch', hash })).toThrow('independent review')
    expect(original.reportedHashes).toEqual([hash, other])
  })
  it('halts when another tab changes the original reported evidence', async () => {
    const failure = { reportedHash: hash, cause: { reportedHash: other } }
    const { journalSubmission, operations, beginOperation } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, async () => { throw failure })).rejects.toBe(failure)
    const changed = JSON.parse(storage.get('bridge.operations.v1')!)
    changed[0].reportedHashes = [hash]
    storage.set('bridge.operations.v1', JSON.stringify(changed))
    expect(() => beginOperation({ ...intent, account: '0x' + '56'.repeat(20) })).toThrow('Stored operation evidence')
    expect(operations.entries[0].reportedHashes).toEqual([hash, other])
  })
  it('does not let another tab resolve a mismatch or adopt an arbitrary hash', async () => {
    const failure = { reportedHash: hash, cause: { reportedHash: other } }
    const { journalSubmission, operations, beginOperation } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, async () => { throw failure })).rejects.toBe(failure)
    const changed = JSON.parse(storage.get('bridge.operations.v1')!)
    changed[0].state = 'confirmed'; changed[0].hash = hash
    delete changed[0].reportedHashes
    storage.set('bridge.operations.v1', JSON.stringify(changed))
    expect(() => beginOperation({ ...intent, account: '0x' + '56'.repeat(20) })).toThrow('Stored operation evidence')
    expect(operations.entries[0]).toMatchObject({ state: 'mismatch', reportedHashes: [hash, other] })
    expect(operations.entries[0].hash).toBeUndefined()
  })
  it('does not override an explicit pending code on a transaction wrapper', async () => {
    const failure = Object.assign(new TransactionExecutionError(new UserRejectedRequestError(new Error('fixture')), { account: { address: account, type: 'json-rpc' }, chain: mainnet, to }), { code: -32002 })
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, async () => { throw failure })).rejects.toBe(failure)
    expect(operations.entries[0].state).toBe('unknown')
  })
  it('retains a known reported hash when the error code cannot be read', async () => {
    const failure = Object.defineProperty({ reportedHash: hash }, 'code', { get() { throw new Error('Unreadable fixture') } })
    const { journalSubmission, operations } = await import('../../src/state/operations.ts')
    await expect(journalSubmission(intent, () => {}, async () => { throw failure })).rejects.toBe(failure)
    expect(operations.entries[0]).toMatchObject({ state: 'mismatch', hash, reportedHashes: [hash] })
  })
})
