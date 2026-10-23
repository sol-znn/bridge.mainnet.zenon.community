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
  it('allows an explicit degraded-health opt-in without bypassing route, halt or node authority', async () => {
    const { bridge, transferBlocker, node } = await prepare()
    const route = bridge.routes[0]
    expect(transferBlocker(route, 'wrap')).toContain('health')
    expect(transferBlocker(route, 'wrap', true)).toBe('')
    bridge.health = { state: 'unknown' } as any; bridge.healthAt = Date.now()
    expect(transferBlocker(route, 'wrap')).toContain('unavailable')
    expect(transferBlocker(route, 'wrap', true)).toBe('')
    bridge.info!.halted = true
    expect(transferBlocker(route, 'wrap', true)).toContain('paused')
    bridge.info!.halted = false
    bridge.evmNetworks[route.chainId].tssMatches = false
    expect(transferBlocker(route, 'wrap', true)).toContain('configuration')
    bridge.evmNetworks[route.chainId].tssMatches = true
    node.timestamp -= 121
    expect(transferBlocker(route, 'wrap', true)).toContain('Node')
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

describe('health refresh and durable activity outcomes', () => {
  it('records sampled health and closes health authority after a failed refresh', async () => {
    const a = fixture(); a.unsignedWraps.mockResolvedValue({ count: 101, list: [wrap()] } as any)
    await prepare(a)
    const { bridge, loadHealth, transferHealthWarning } = await import('../../src/state/bridge.ts')
    await loadHealth(); expect(bridge.unsignedCount).toBe(101); expect(bridge.healthSampled).toBe(true); expect(bridge.healthAt).toBeGreaterThan(0)
    a.unsignedWraps.mockRejectedValue(new Error('current health unavailable')); await loadHealth()
    expect(bridge.healthAt).toBe(0); expect(transferHealthWarning()).toContain('unavailable')
  })
  it('does not apply a late old health response after invalidation', async () => {
    const a = fixture(), gate = deferred<any>(); a.unsignedWraps.mockImplementation(() => gate.promise)
    await prepare(a); const { bridge, loadHealth, invalidateBridge } = await import('../../src/state/bridge.ts')
    const pending = loadHealth(); invalidateBridge(); gate.resolve({ count: 0, list: [] }); await pending
    expect(bridge.loaded).toBe(false); expect(bridge.health).toBeNull(); expect(bridge.healthAt).toBe(0)
  })
  it('keeps an unindexed original wrap and rejects malformed local records without saving them', async () => {
    const a = fixture(); await prepare(a)
    const { remember, refreshActivity, activity, pendingCount } = await import('../../src/state/activity.ts')
    const record = { kind: 'wrap' as const, id: wrap().id, chainId: 1, from: zAccount, toAddress: eth, tokenStandard: zts, amount: '97', createdAt: 1 }
    remember(record); await refreshActivity()
    expect(a.wrapById).toHaveBeenCalledWith(record.id); expect(activity.items[0]).toMatchObject({ sourceTx: record.id, status: { state: 'confirming' } }); expect(pendingCount()).toBe(1)
    const saved = localStorage.getItem('bridge.activity.v2')
    expect(() => remember({ ...record, amount: '-1' })).toThrow('Invalid'); expect(localStorage.getItem('bridge.activity.v2')).toBe(saved)
  })
  it('recovers only the exact stored unwrap hash and log index', async () => {
    const a = fixture(), txHash = 'cd'.repeat(32)
    a.unwrapByHashAndLog.mockResolvedValue({ networkClass: 2, chainId: 1, transactionHash: txHash, logIndex: 7, toAddress: zAccount,
      tokenAddress: eth, tokenStandard: zts, amount: 97n, registrationMomentumHeight: 50, signature: 'fixture-signature', redeemableIn: 0, redeemed: 0, revoked: 0, token } as any)
    await prepare(a); const { remember, refreshActivity, activity, actionCount } = await import('../../src/state/activity.ts')
    remember({ kind: 'unwrap', txHash: '0x' + txHash, logIndex: 7, chainId: 1, from: eth, toAddress: zAccount, tokenAddress: eth, amount: '97', createdAt: 1 })
    await refreshActivity(); expect(a.unwrapByHashAndLog).toHaveBeenCalledWith('0x' + txHash, 7)
    expect(activity.items[0]).toMatchObject({ sourceTx: txHash, unwrap: { logIndex: 7 }, amount: 97n }); expect(actionCount()).toBe(1)
  })
  it('does not discover a replacement hash when the original unwrap receipt is unavailable', async () => {
    await prepare(); mock.reader.getTransactionReceipt = vi.fn(async () => { throw new Error('original receipt unavailable') })
    const { remember, refreshActivity, activity } = await import('../../src/state/activity.ts')
    const txHash = '0x' + 'cd'.repeat(32)
    remember({ kind: 'unwrap', txHash, chainId: 1, from: eth, toAddress: zAccount, tokenAddress: eth, amount: '97', createdAt: 1 })
    await refreshActivity(); expect(activity.items[0]).toMatchObject({ sourceTx: txHash, status: { state: 'signing' } }); expect(activity.local[0]).not.toHaveProperty('logIndex')
    expect(mock.reader.getTransactionReceipt).toHaveBeenCalledWith({ hash: txHash })
  })
  it('deduplicates watched addresses and clears rows when the selected history context changes', async () => {
    const a = fixture(); a.wrapsTo.mockResolvedValue({ count: 1, list: [wrap()] }); await prepare(a)
    const { activity, setWatched, refreshActivity, startActivity } = await import('../../src/state/activity.ts')
    setWatched([eth, eth, 'invalid']); await refreshActivity(); expect(activity.watched).toEqual([eth]); expect(activity.items).toHaveLength(1)
    scope = effectScope(); scope.run(startActivity); setWatched([]); await refreshActivity(); expect(activity.items).toEqual([])
    const { node } = await import('../../src/state/zenon.ts'); node.tick++; await nextTick(); await refreshActivity(); expect(activity.error).toBe('')
  })
  it('marks only the exact completed request terminal after a fresh destination read', async () => {
    const a = fixture(); a.wrapsTo.mockResolvedValue({ count: 1, list: [{ ...wrap(), signature: 'signed' }] })
    const original = mock.reader.readContract.getMockImplementation()!
    mock.reader.readContract.mockImplementation((args: any) => args.functionName === 'redeemsInfo' ? Promise.resolve([(1n << 256n) - 1n, '0x' + '00'.repeat(32)]) : original(args))
    await prepare(a); const { remember, activity, refreshActivity } = await import('../../src/state/activity.ts')
    remember({ kind: 'wrap', id: wrap().id, chainId: 1, from: zAccount, toAddress: eth, tokenStandard: zts, amount: '97', createdAt: 1 }); await refreshActivity()
    expect(activity.items[0].status.state).toBe('done'); expect(activity.local[0]).toMatchObject({ id: wrap().id, terminal: true })
    expect(JSON.parse(localStorage.getItem('bridge.activity.v2')!)[0].id).toBe(wrap().id)
  })
})
