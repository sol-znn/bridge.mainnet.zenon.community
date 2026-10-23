import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const account = '0x' + '12'.repeat(20), contract = '0x' + '34'.repeat(20), hash = '0x' + 'ab'.repeat(32), blockHash = '0x' + 'cd'.repeat(32)
beforeEach(() => {
  vi.resetModules()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) })
  vi.stubGlobal('window', {})
  vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_name, _options, job) => job({ name: 'fixture-owned-lock' })) } })
})
afterEach(() => vi.unstubAllGlobals())
async function submitted() {
  const tx = await import('../../src/evm/transactions.ts'), journal = await import('../../src/state/operations.ts')
  const payload = JSON.stringify({ to: contract, data: '0x1234', value: '0' })
  const send = vi.fn(async () => hash as `0x${string}`), guard = vi.fn()
  await tx.submitTransaction({ chainId: 1, account, kind: 'fixture', payload }, guard, send)
  const receipt = { transactionHash: hash, status: 'success', from: account, to: contract, blockNumber: 10n, blockHash }
  const reader: any = { getChainId: vi.fn(async () => 1), waitForTransactionReceipt: vi.fn(async () => receipt),
    getTransactionReceipt: vi.fn(async () => receipt), getTransaction: vi.fn(async () => ({ hash, from: account, to: contract, input: '0x1234', value: 0n, blockNumber: 10n, blockHash })),
    getBlockNumber: vi.fn(async () => 11n), getBlock: vi.fn(async () => ({ hash: blockHash })),
  }
  return { ...tx, ...journal, send, guard, receipt, reader }
}
describe('original EVM transaction and confirmation orchestration', () => {
  it('encodes the exact contract/data/value and authenticates the original canonical receipt', async () => {
    const x = await submitted()
    expect(x.transactionPayload(contract as `0x${string}`, [{ name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }], 'approve', [account, 7n], 5n)).toContain('"value":"5"')
    await expect(x.successfulReceipt(x.reader, 1, hash as `0x${string}`)).resolves.toEqual(x.receipt)
    expect(x.operations.entries[0].state).toBe('confirmed'); expect(x.send).toHaveBeenCalledTimes(1)
  })
  it.each(['chain', 'hash', 'missing', 'transport'])('retains the original operation after a %s receipt failure', async (failure) => {
    const x = await submitted()
    if (failure === 'chain') x.reader.getChainId.mockResolvedValue(56)
    if (failure === 'hash') x.reader.waitForTransactionReceipt.mockResolvedValue({ ...x.receipt, transactionHash: '0x' + 'ee'.repeat(32) })
    if (failure === 'missing') x.operations.entries.splice(0)
    if (failure === 'transport') x.reader.waitForTransactionReceipt.mockRejectedValue(new Error('connection lost'))
    await expect(x.successfulReceipt(x.reader, 1, hash as `0x${string}`)).rejects.toThrow()
    if (failure !== 'missing') expect(x.operations.entries[0]).toMatchObject({ hash, state: 'unknown' })
    expect(x.send).toHaveBeenCalledTimes(1)
  })
  it('does not accept an orphaned receipt or fabricate success from a reverted original', async () => {
    const x = await submitted(); x.reader.getBlock.mockResolvedValue({ hash: '0x' + 'ef'.repeat(32) })
    await expect(x.successfulReceipt(x.reader, 1, hash as `0x${string}`)).rejects.toThrow('canonical')
    expect(x.operations.entries[0].state).toBe('unknown')
    x.reader.getBlock.mockResolvedValue({ hash: blockHash }); x.receipt.status = 'reverted'
    await expect(x.successfulReceipt(x.reader, 1, hash as `0x${string}`)).rejects.toThrow('reverted')
    expect(x.operations.entries[0]).toMatchObject({ hash, state: 'reverted' }); expect(x.send).toHaveBeenCalledTimes(1)
  })
})
