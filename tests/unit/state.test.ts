import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, nextTick } from 'vue'
import { secp256k1 } from '@noble/curves/secp256k1'
import { publicKeyToAddress } from 'viem/accounts'
import { formatAddress, toBase64, toHex } from '../../src/znn/primitives.ts'

const mock = vi.hoisted(() => ({ reader: {} as any }))
vi.mock('../../src/evm/client.ts', () => ({ readClient: () => mock.reader }))
const zts = 'zts1znnxxxxxxxxxxxxx9z4ulx', eth = '0x' + '12'.repeat(20), contract = '0x' + '34'.repeat(20)
const zAccount = formatAddress(Uint8Array.from([0, ...Array(19).fill(7)]))
const pub = secp256k1.getPublicKey(Uint8Array.from([...Array(31).fill(0), 1]), false)
const tss = publicKeyToAddress(('0x' + toHex(pub)) as `0x${string}`)
const token = { name: 'Zenon', symbol: 'ZNN', tokenStandard: zts, decimals: 8 }
const network = (name = 'fixture') => ({ networkClass: 2, chainId: 1, name, contractAddress: contract, metadata: '{}', tokenPairs: [
  { tokenStandard: zts, tokenAddress: eth, bridgeable: true, redeemable: true, owned: true, feePercentage: 300, redeemDelay: 90, minAmount: 1n, metadata: '{}' },
] })
const fixture = (name = 'fixture') => ({
  bridgeInfo: vi.fn(async () => ({ halted: false, allowKeyGen: false, metadata: '{}', decompressedTssECDSAPubKey: toBase64(pub) })),
  orchestratorInfo: vi.fn(async () => ({ estimatedMomentumTime: 10, confirmationsToFinality: 90 })), networks: vi.fn(async () => [network(name)]),
  token: vi.fn(async () => token), wrapsTo: vi.fn(async () => ({ count: 0, list: [] as any[] })), unwrapsTo: vi.fn(async () => ({ count: 0, list: [] as any[] })),
  wrapById: vi.fn(async () => null), unwrapByHashAndLog: vi.fn(async () => null),
  unsignedWraps: vi.fn(async () => ({ count: 0, list: [] })), bridgeBlocks: vi.fn(async () => []), pillarsByProducer: vi.fn(async () => ({})),
})
const wrap = (index = 1) => ({ id: index.toString(16).padStart(64, '0'), networkClass: 2, chainId: 1, toAddress: eth, tokenStandard: zts, tokenAddress: eth,
  amount: 100n, fee: 3n, signature: '', creationMomentumHeight: 50, confirmationsToFinality: 0, token })
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
let scope: ReturnType<typeof effectScope> | undefined
beforeEach(() => {
  vi.resetModules()
  const storage = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v), removeItem: (k: string) => storage.delete(k) })
  vi.stubGlobal('location', { protocol: 'https:', origin: 'https://fixture.invalid' })
  mock.reader = { getChainId: vi.fn(async () => 1), getBlockNumber: vi.fn(async () => 100n), readContract: vi.fn(async ({ functionName }: any) => {
    if (functionName === 'symbol') return 'wZNN'
    if (functionName === 'name') return 'Wrapped Zenon'
    if (functionName === 'decimals') return 8
    if (functionName === 'tokensInfo') return [1n, 90n, true, true, true]
    if (functionName === 'isHalted') return false
    if (functionName === 'tss') return tss
    if (functionName === 'redeemsInfo') return [0n, '0x' + '00'.repeat(32)]
    return 12n
  }) }
})
afterEach(() => { scope?.stop(); scope = undefined; vi.unstubAllGlobals() })
async function prepare(a = fixture()) {
  const { api, node } = await import('../../src/state/zenon.ts')
  api.value = a as any; node.chainId = 1; node.conn = 'open'; node.timestamp = Math.floor(Date.now() / 1000); node.height = 100
  const state = await import('../../src/state/bridge.ts')
  await state.loadBridge()
  return { api, node, ...state }
}

describe('current route and health authority', () => {
  it('refuses stale or future node evidence before invoking a Zenon wallet', async () => {
    const {node,syrius,sendBlock,nodeIsCurrent}=await import('../../src/state/zenon.ts')
    node.chainId=1;node.conn='open';syrius.address=zAccount;syrius.chainId=1
    node.timestamp=Math.floor(Date.now()/1000)-121
    expect(nodeIsCurrent()).toBe(false)
    await expect(sendBlock({toAddress:zAccount})).rejects.toThrow('freshness')
    node.timestamp=Math.floor(Date.now()/1000)+61
    expect(nodeIsCurrent()).toBe(false)
    await expect(sendBlock({toAddress:zAccount})).rejects.toThrow('freshness')
    node.timestamp=Math.floor(Date.now()/1000)
    expect(nodeIsCurrent()).toBe(true)
  })
  it('closes both directions when EVM metadata is unavailable', async () => {
    mock.reader.readContract.mockRejectedValue(new Error('RPC unavailable'))
    const { bridge, transferBlocker } = await prepare()
    expect(bridge.routes[0]).toMatchObject({ canWrap: false, canUnwrap: false, evmInfo: null })
    expect(transferBlocker(bridge.routes[0], 'wrap')).not.toBe('')
  })
  it.each(['halt', 'chain', 'key', 'decimals'])('closes a route on %s mismatch', async (field) => {
    const original = mock.reader.readContract.getMockImplementation()!
    mock.reader.readContract.mockImplementation((args: any) => {
      if (field === 'halt' && args.functionName === 'isHalted') return Promise.resolve(true)
      if (field === 'key' && args.functionName === 'tss') return Promise.resolve(eth)
      if (field === 'decimals' && args.functionName === 'decimals') return Promise.resolve(18)
      return original(args)
    })
    if (field === 'chain') mock.reader.getChainId.mockResolvedValue(56)
    const { bridge } = await prepare()
    expect(bridge.routes[0].canWrap).toBe(false); expect(bridge.routes[0].canUnwrap).toBe(false)
  })
  it('requires fresh configuration and health even with valid open contracts', async () => {
    const { bridge, transferBlocker, node, nodeContext } = await prepare()
    expect(bridge.routes[0].canWrap).toBe(true)
    expect(transferBlocker()).toContain('health')
    bridge.health = { state: 'online' } as any; bridge.healthAt = Date.now(); bridge.context = nodeContext()
    expect(transferBlocker(bridge.routes[0], 'wrap')).toBe('')
    bridge.readAt = Date.now() - 180_001
    expect(transferBlocker()).toContain('configuration')
    bridge.readAt = Date.now(); node.timestamp -= 121
    expect(transferBlocker()).toContain('Node')
  })
  it('discards old-node routes and lets the new node load while the old read is pending', async () => {
    const { api, node } = await import('../../src/state/zenon.ts')
    const old = fixture('old'), gate = deferred<any[]>()
    old.networks.mockImplementation(() => gate.promise)
    api.value = old as any; node.chainId = 1
    const { bridge, startBridge } = await import('../../src/state/bridge.ts')
    scope = effectScope(); scope.run(startBridge)
    await nextTick()
    const fresh = fixture('new'); api.value = fresh as any; node.epoch++
    await vi.waitFor(() => expect(bridge.routes[0]?.networkName).toBe('new'))
    gate.resolve([network('old')]); await new Promise((r) => setTimeout(r, 10))
    expect(fresh.networks).toHaveBeenCalled(); expect(bridge.routes[0].networkName).toBe('new')
  })
  it('does not retain loaded authority after a failed refresh on another node', async () => {
    const { api, node, bridge, loadBridge, transferBlocker } = await prepare()
    const failed = fixture('new'); failed.bridgeInfo.mockRejectedValue(new Error('new node unavailable'))
    api.value = failed as any; node.epoch++
    await loadBridge()
    expect(bridge.loaded).toBe(false); expect(transferBlocker()).toContain('configuration')
  })
})

describe('scoped complete activity', () => {
  it('excludes local transfers from another Zenon chain', async () => {
    const { node } = await prepare(); node.chainId = 322
    const { activity, refreshActivity } = await import('../../src/state/activity.ts')
    activity.local.push({ kind: 'wrap', znn: 1, id: 'ab'.repeat(32), chainId: 1, from: zAccount, toAddress: eth, amount: '97', tokenStandard: zts, createdAt: 1 })
    await refreshActivity()
    expect(activity.items).toEqual([])
  })
  it('does not import a previous completed redeem cache into a fresh network read', async () => {
    const a = fixture(); a.wrapsTo.mockResolvedValue({ count: 1, list: [{ ...wrap(), signature: 'signed' }] })
    await prepare(a)
    const { evm } = await import('../../src/state/evm.ts'); evm.account = eth as `0x${string}`
    const { activity, refreshActivity } = await import('../../src/state/activity.ts')
    activity.redeemBlocks[wrap().id] = ((1n << 256n) - 1n).toString()
    await refreshActivity()
    expect(activity.items[0].status.state).toBe('redeem')
    expect(mock.reader.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'redeemsInfo' }))
  })
  it('never restores disconnected-account rows from a deferred read', async () => {
    const a = fixture(), gate = deferred<any>(); a.wrapsTo.mockImplementation(() => gate.promise)
    await prepare(a)
    const { evm } = await import('../../src/state/evm.ts'); evm.account = eth as `0x${string}`
    const { activity, refreshActivity } = await import('../../src/state/activity.ts')
    const pending = refreshActivity(); evm.account = null; await refreshActivity()
    gate.resolve({ count: 1, list: [wrap()] }); await pending
    expect(activity.items).toEqual([])
  })
  it('retrieves an old request beyond the first 100 history entries', async () => {
    const a = fixture(), rows = Array.from({ length: 151 }, (_, index) => wrap(index + 1))
    a.wrapsTo.mockImplementation(async (_address?: string, index = 0, size = 100) => ({ count: rows.length, list: rows.slice(index * size, (index + 1) * size) }))
    await prepare(a)
    const { evm } = await import('../../src/state/evm.ts'); evm.account = eth as `0x${string}`
    const { activity, refreshActivity } = await import('../../src/state/activity.ts')
    await refreshActivity()
    expect(activity.items).toHaveLength(151); expect(activity.items.some((i) => i.sourceTx === wrap(151).id)).toBe(true)
    expect(a.wrapsTo).toHaveBeenCalledWith(eth, 1, 100)
  })
  it('retains dated scoped rows with an explicit error on an RPC outage', async () => {
    const a = fixture(); a.wrapsTo.mockResolvedValue({ count: 1, list: [wrap()] }); await prepare(a)
    const { evm } = await import('../../src/state/evm.ts'); evm.account = eth as `0x${string}`
    const { activity, refreshActivity } = await import('../../src/state/activity.ts')
    await refreshActivity(); a.wrapsTo.mockRejectedValue(new Error('RPC down')); await refreshActivity()
    expect(activity.items).toHaveLength(1); expect(activity.error).toBe('RPC down'); expect(activity.readAt).toBe(0)
  })
  it('preserves malformed storage with a controlled recovery message', async () => {
    localStorage.setItem('bridge.activity.v2', '{}'); await prepare()
    const { activity, refreshActivity } = await import('../../src/state/activity.ts')
    await expect(refreshActivity()).resolves.toBeUndefined()
    expect(activity.storageError).toContain('unavailable'); expect(localStorage.getItem('bridge.activity.v2')).toBe('{}')
  })
})

describe('EVM connection ownership', () => {
  it('does not resurrect an account after disconnect while approval is pending', async () => {
    const gate = deferred<unknown>(), provider = { request: vi.fn(() => gate.promise) }
    const { connectEvm, disconnectEvm, evm } = await import('../../src/state/evm.ts')
    const pending = connectEvm({ info: { name: 'Fixture', uuid: 'fixture', rdns: 'fixture', icon: '' }, provider })
    disconnectEvm(); gate.resolve([eth]); await pending
    expect(evm.account).toBeNull(); expect(evm.selected).toBeNull()
  })
  it('does not apply a deferred chain result after disconnect', async () => {
    const gate = deferred<unknown>(), provider = { request: vi.fn(async ({ method }: { method: string }) => method === 'eth_requestAccounts' ? [eth] : gate.promise) }
    const { connectEvm, disconnectEvm, evm } = await import('../../src/state/evm.ts')
    const pending = connectEvm({ info: { name: 'Fixture', uuid: 'fixture', rdns: 'fixture', icon: '' }, provider })
    await vi.waitFor(() => expect(evm.selected).not.toBeNull())
    disconnectEvm(); gate.resolve('0x1'); await pending
    expect(evm.account).toBeNull(); expect(evm.chainId).toBeNull()
  })
})
