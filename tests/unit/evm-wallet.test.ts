import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
const account = '0x' + '12'.repeat(20)
let surface: EventTarget & Record<string, any>
beforeEach(() => {
  vi.resetModules(); vi.useFakeTimers()
  surface = Object.assign(new EventTarget(), {})
  vi.stubGlobal('window', surface)
})
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals() })
describe('EIP-6963 discovery and EIP-1193 request boundaries', () => {
  it('deduplicates announcements and cancels legacy discovery when stopped', async () => {
    const w = await import('../../src/wallet/eip6963.ts'), change = vi.fn(), stop = w.discoverWallets(change)
    const provider = { request: vi.fn() }, info = { uuid: 'fixture', rdns: 'fixture.wallet', name: 'Fixture', icon: '' }
    const event = () => { const e = new Event('eip6963:announceProvider'); Object.defineProperty(e, 'detail', { value: { info, provider } }); surface.dispatchEvent(e) }
    event(); event(); expect(change.mock.lastCall![0]).toHaveLength(1)
    surface.ethereum = provider; await vi.advanceTimersByTimeAsync(600)
    expect(change).toHaveBeenCalledTimes(2); stop(); event(); expect(change).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('offers a legacy-only wallet without suppressing its account or error identity', async () => {
    const w = await import('../../src/wallet/eip6963.ts'), change = vi.fn()
    surface.ethereum = { request: vi.fn(async () => [account]), isRabby: true }
    const stop = w.discoverWallets(change); await vi.advanceTimersByTimeAsync(600)
    expect(change.mock.lastCall![0][0].info.name).toBe('Rabby')
    expect(await w.requestAccounts(surface.ethereum)).toEqual([account])
    surface.ethereum.request.mockRejectedValue({ code: 4001 })
    await expect(w.requestAccounts(surface.ethereum)).rejects.toMatchObject({ code: 4001, declined: true }); stop()
  })
  it.each([null, {}, '0x0', '0x20000000000000', -1])('rejects invalid wallet chain identity %s', async (chain) => {
    const w = await import('../../src/wallet/eip6963.ts')
    await expect(w.chainIdOf({ request: async () => chain })).rejects.toThrow('identity')
  })
  it('adds only the requested unknown network and preserves failed switch codes', async () => {
    const w = await import('../../src/wallet/eip6963.ts'), request = vi.fn().mockRejectedValueOnce({ code: 4902 }).mockResolvedValue(undefined)
    await w.switchChain({ request }, 56, { name: 'Fixture', rpc: 'https://fixture.invalid', nativeSymbol: 'TEST', explorer: '' })
    expect(request.mock.calls[1][0]).toMatchObject({ method: 'wallet_addEthereumChain', params: [{ chainId: '0x38', rpcUrls: ['https://fixture.invalid'] }] })
    request.mockRejectedValue({ code: 4001 }); await expect(w.switchChain({ request }, 1)).rejects.toMatchObject({ code: 4001 })
  })
  it('bounds watched symbols and retains watch-asset rejection', async () => {
    const w = await import('../../src/wallet/eip6963.ts'), request = vi.fn(async () => true)
    expect(await w.watchAsset({ request }, { address: account, symbol: 'long-fixture-symbol', decimals: 8 })).toBe(true)
    expect((request.mock.calls as any)[0][0].params.options.symbol).toHaveLength(11)
    request.mockRejectedValue(new Error('unavailable')); await expect(w.watchAsset({ request }, { address: account, symbol: 'T', decimals: 8 })).rejects.toThrow('unavailable')
  })
  it('uses the supplied wallet only on its chain, caches fallback readers and keeps writes on the requested provider', async () => {
    vi.useRealTimers()
    const { readClient, writeClient, chainDef } = await import('../../src/evm/client.ts')
    const provider = { request: vi.fn(async () => '0x1') }
    const onWallet = readClient(1, { provider, chainId: 1 })
    expect(await onWallet.getChainId()).toBe(1); expect(provider.request).toHaveBeenCalledTimes(1)
    expect(readClient(56, { provider, chainId: 1 })).toBe(readClient(56, null))
    expect(writeClient(1, provider, account as `0x${string}`).account?.address).toBe(account)
    expect(chainDef(31337).blockExplorers).toBeUndefined()
  })
})

describe('EVM session changes and pending chain ownership', () => {
  function fixture() {
    const storage = new Map<string, string>(), handlers: Record<string, (...a: any[]) => void> = {}
    vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) })
    const provider = { request: vi.fn(async ({ method }: any): Promise<any> => method === 'eth_chainId' ? '0x1' : [account]),
      on: vi.fn((event: string, handler: any) => { handlers[event] = handler }), removeListener: vi.fn(),
    }
    const wallet = { info: { uuid: 'fixture', rdns: 'fixture.wallet', name: 'Fixture', icon: '' }, provider }
    return { wallet, provider, handlers, storage }
  }
  it('applies valid account events and releases handlers after the account list becomes empty', async () => {
    const f = fixture(), s = await import('../../src/state/evm.ts'); await s.connectEvm(f.wallet)
    f.handlers.accountsChanged(['0x' + '34'.repeat(20)]); expect(s.evm.account).toBe('0x' + '34'.repeat(20))
    f.handlers.accountsChanged([]); expect(s.evm.selected).toBeNull(); expect(s.walletForReads()).toBeNull(); expect(f.provider.removeListener).toHaveBeenCalledTimes(3)
    f.handlers.chainChanged('0x38'); expect(s.evm.chainId).toBeNull()
  })
  it('does not overwrite a newer chain event with a delayed initial chain reply', async () => {
    const f = fixture(); let resolve!: (v: string) => void
    f.provider.request.mockImplementation(async ({ method }: any) => method === 'eth_chainId' ? new Promise((r) => { resolve = r }) : [account])
    const s = await import('../../src/state/evm.ts'), pending = s.connectEvm(f.wallet)
    await Promise.resolve(); await Promise.resolve(); f.handlers.chainChanged('0x38'); resolve('0x1'); await pending
    expect(s.evm.chainId).toBe(56); expect(s.evm.busy).toBe(false)
    f.handlers.chainChanged('invalid'); expect(s.evm.chainId).toBeNull()
  })
  it('confirms the requested network after switching and refuses a wallet that remains on another chain', async () => {
    const f = fixture(), s = await import('../../src/state/evm.ts')
    await expect(s.ensureChain(56)).rejects.toThrow('Connect')
    await s.connectEvm(f.wallet); await s.ensureChain(1)
    await expect(s.ensureChain(56)).rejects.toThrow('Switch your wallet')
    f.provider.request.mockImplementation(async ({ method }: any) => method === 'eth_chainId' ? '0x38' : undefined)
    await s.ensureChain(56); expect(s.evm.chainId).toBe(56); expect(s.walletForReads()?.provider).toBe(f.provider)
    f.handlers.disconnect(); expect(s.evm.account).toBeNull()
  })
  it('never binds a stale silent reconnect over a newer explicit connection', async () => {
    const f = fixture(); f.storage.set('bridge.evmWallet', 'fixture.wallet'); let resolve!: (v: string[]) => void
    f.provider.request.mockImplementation(async ({ method }: any) => method === 'eth_accounts' ? new Promise((r) => { resolve = r }) : method === 'eth_chainId' ? '0x1' : [account])
    const s = await import('../../src/state/evm.ts'); s.startEvmDiscovery()
    const event = new Event('eip6963:announceProvider'); Object.defineProperty(event, 'detail', { value: f.wallet }); surface.dispatchEvent(event)
    await s.connectEvm(f.wallet); resolve(['0x' + '56'.repeat(20)]); await Promise.resolve(); await Promise.resolve()
    expect(s.evm.account).toBe(account)
  })
  it('refuses invalid connected accounts and releases a rejected prompt', async () => {
    const f = fixture(), s = await import('../../src/state/evm.ts')
    f.provider.request.mockResolvedValue(['invalid']); await expect(s.connectEvm(f.wallet)).rejects.toThrow('valid account'); expect(s.evm.selected).toBeNull()
    f.provider.request.mockRejectedValue({ code: 4001 }); await expect(s.connectEvm(f.wallet)).rejects.toMatchObject({ code: 4001 }); expect(s.evm.busy).toBe(false)
  })
})
