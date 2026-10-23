import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { formatAddress } from '../../src/znn/primitives.ts'
import { blockTemplate } from '../../src/znn/block.ts'

const account = formatAddress(Uint8Array.from([0, ...Array(19).fill(7)])), hash = 'ab'.repeat(32)
let surface: EventTarget & Record<string, any>
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(100_000)
  surface = Object.assign(new EventTarget(), { location: { origin: 'https://fixture.invalid' }, postMessage: vi.fn() })
  vi.stubGlobal('window', surface)
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
function emit(type: string, value: Record<string, unknown>) {
  const event = new Event(type)
  for (const [key, data] of Object.entries(value)) Object.defineProperty(event, key, { value: data })
  surface.dispatchEvent(event)
}
function modern() {
  surface.zenon = { version: 2, connect: vi.fn(async () => true), disconnect: vi.fn(async () => true),
    getAccounts: vi.fn(async () => [account]), getChainId: vi.fn(async () => 1), getNodeUrl: vi.fn(async () => 'wss://fixture.invalid'),
    sendAccountBlock: vi.fn(async () => ({ hash })), on: vi.fn(), removeListener: vi.fn(),
  }
  return surface.zenon
}
const template = () => blockTemplate({ toAddress: account }, 1)
describe('Syrius original request boundaries', () => {
  it('waits for provider injection and removes its initialization timeout', async () => {
    const w = await import('../../src/wallet/syrius.ts'), pending = w.whenProviderReady()
    modern(); emit('zenon#initialized', {})
    await expect(pending).resolves.toBe(true); expect(vi.getTimerCount()).toBe(0)
    await expect(w.whenProviderReady()).resolves.toBe(true)
  })
  it('reports absence after the bounded initialization wait without prompting', async () => {
    const w = await import('../../src/wallet/syrius.ts'), pending = w.whenProviderReady(10)
    await vi.advanceTimersByTimeAsync(10); await expect(pending).resolves.toBe(false)
    await expect(w.connect()).rejects.toMatchObject({ code: w.WALLET_NOT_FOUND })
    await expect(w.sendAccountBlock(template())).rejects.toThrow('No Zenon wallet')
  })
  it('validates passive account, chain and node state while keeping denied reads empty', async () => {
    const p = modern(), w = await import('../../src/wallet/syrius.ts')
    expect(await w.readState()).toMatchObject({ present: true, address: account, chainId: 1 })
    p.getAccounts.mockResolvedValue(['invalid']); p.getChainId.mockResolvedValue('9007199254740993'); p.getNodeUrl.mockResolvedValue('x'.repeat(2049))
    expect(await w.readState()).toMatchObject({ address: null, chainId: null, nodeUrl: null })
    p.getAccounts.mockRejectedValue(new Error('denied')); p.getChainId.mockRejectedValue(new Error('denied')); p.getNodeUrl.mockRejectedValue(new Error('denied'))
    expect(await w.readState()).toMatchObject({ address: null, chainId: null, nodeUrl: null })
  })
  it.each([4001, 4100, 4200, 4900, -32603])('preserves explicit provider error code %s without another request', async (code) => {
    const p = modern(); p.connect.mockRejectedValue({ code, message: 'fixture failure' })
    const w = await import('../../src/wallet/syrius.ts')
    await expect(w.connect()).rejects.toMatchObject({ code }); expect(p.connect).toHaveBeenCalledTimes(1)
  })
  it('serializes prompts and lets a second job proceed after an explicit rejection', async () => {
    const p = modern(); let reject!: (error: unknown) => void
    p.connect.mockImplementationOnce(() => new Promise((_resolve, r) => { reject = r }))
    const w = await import('../../src/wallet/syrius.ts'), first = expect(w.connect()).rejects.toMatchObject({ code: 4001 }), second = w.sendAccountBlock(template())
    await Promise.resolve(); expect(p.sendAccountBlock).not.toHaveBeenCalled()
    reject({ code: 4001 }); await first; await expect(second).resolves.toMatchObject({ hash }); expect(p.connect).toHaveBeenCalledTimes(1)
  })
  it('retries only an explicit pre-prompt cooldown and rechecks the original guard', async () => {
    const p = modern(); p.sendAccountBlock.mockRejectedValueOnce({ code: -32005 }); const hold = vi.fn(), guard = vi.fn()
    const w = await import('../../src/wallet/syrius.ts'), pending = w.sendAccountBlock(template(), { beforePrompt: guard, onHold: hold })
    await vi.advanceTimersByTimeAsync(32_000); await expect(pending).resolves.toMatchObject({ hash })
    expect(p.sendAccountBlock).toHaveBeenCalledTimes(2); expect(guard).toHaveBeenCalledTimes(2); expect(hold).toHaveBeenLastCalledWith(0)
  })
  it('does not prompt after the original context becomes invalid during cooldown', async () => {
    const p = modern(); p.sendAccountBlock.mockRejectedValueOnce({ code: -32005 })
    const guard = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('context changed') })
    const w = await import('../../src/wallet/syrius.ts'), pending = expect(w.sendAccountBlock(template(), { beforePrompt: guard })).rejects.toThrow('context changed')
    await vi.advanceTimersByTimeAsync(32_000); await pending; expect(p.sendAccountBlock).toHaveBeenCalledTimes(1)
  })
  it('retains the reported hash on a mismatched or malformed original response', async () => {
    const p = modern(), w = await import('../../src/wallet/syrius.ts')
    p.sendAccountBlock.mockResolvedValue({ hash, block: { data: 'changed' } })
    await expect(w.sendAccountBlock(template())).rejects.toMatchObject({ reportedHash: hash })
    p.sendAccountBlock.mockResolvedValue({ hash, block: [] })
    await expect(w.sendAccountBlock(template())).rejects.toMatchObject({ reportedHash: hash })
    p.sendAccountBlock.mockResolvedValue({ hash: 'not-a-hash' })
    await expect(w.sendAccountBlock(template())).rejects.toThrow('unknown')
    expect(p.sendAccountBlock).toHaveBeenCalledTimes(3)
  })
  it('supports both response envelopes without letting a reported signed account change', async () => {
    const p = modern(), w = await import('../../src/wallet/syrius.ts')
    p.sendAccountBlock.mockResolvedValue({ signedTransaction: { ...template(), hash, address: account } })
    await expect(w.sendAccountBlock(template(), { account })).resolves.toMatchObject({ hash })
    p.sendAccountBlock.mockResolvedValue({ hash, block: { address: formatAddress(Uint8Array.from([0, ...Array(19).fill(8)])) } })
    await expect(w.sendAccountBlock(template(), { account })).rejects.toMatchObject({ reportedHash: hash })
  })
  it('handles message support and unregisters every wallet-change handler', async () => {
    const p = modern(), w = await import('../../src/wallet/syrius.ts'), changed = vi.fn()
    await expect(w.signMessage('fixture')).rejects.toMatchObject({ code: 4200 })
    p.signMessage = vi.fn(async () => ({ message: 'fixture', address: account, publicKey: '', signature: '' }))
    await expect(w.signMessage('fixture')).resolves.toMatchObject({ message: 'fixture' })
    const stop = w.onWalletChange(changed)
    for (const [, fn] of p.on.mock.calls) fn()
    expect(changed.mock.calls.flat()).toEqual(['accountsChanged', 'chainChanged', 'nodeChanged', 'disconnect'])
    stop(); expect(p.removeListener).toHaveBeenCalledTimes(4)
    await w.disconnect(); expect(p.disconnect).toHaveBeenCalledTimes(1)
  })
})
describe('legacy response ownership', () => {
  it('ignores foreign messages, retains the original signed result and removes timed-out listeners', async () => {
    surface.zenon = { isSyriusExtension: true }
    const w = await import('../../src/wallet/syriusLegacy.ts'), pending = w.legacySend(template())
    emit('message', { source: {}, data: { method: 'znn.accountBlockSent', data: { signedTransaction: { hash: 'wrong' } } } })
    emit('message', { source: surface, data: { method: 'unrelated' } })
    emit('message', { source: surface, data: { method: 'znn.accountBlockSent', data: { signedTransaction: JSON.stringify({ hash }) } } })
    await expect(pending).resolves.toEqual({ hash }); expect(vi.getTimerCount()).toBe(0)
    const timeout = expect(w.legacyConnect()).rejects.toMatchObject({ code: 4900 })
    await vi.advanceTimersByTimeAsync(300_000); await timeout; expect(vi.getTimerCount()).toBe(0)
  })
  it('validates legacy identity and retains explicit rejection without replacement', async () => {
    surface.zenon = { isSyriusExtension: true }
    const w = await import('../../src/wallet/syrius.ts'), pending = w.connect(); await Promise.resolve()
    emit('message', { source: surface, data: { method: 'znn.grantedWalletRead', data: { address: account, chainId: '1', nodeUrl: 'wss://fixture.invalid' } } })
    await expect(pending).resolves.toMatchObject({ protocol: '1', address: account, chainId: 1 })
    expect(await w.readState()).toMatchObject({ address: account })
    const denied = expect(w.sendAccountBlock(template())).rejects.toMatchObject({ code: 4001 }); await Promise.resolve()
    emit('message', { source: surface, data: { method: 'znn.deniedSendAccountBlock' } }); await denied
    await w.disconnect(); expect(await w.readState()).toMatchObject({ address: null })
  })
})
