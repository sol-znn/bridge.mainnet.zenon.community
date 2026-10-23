// Transfers: the ones sent from this browser (kept locally, so they show the
// moment they are sent) merged with what the chain holds for the connected
// addresses and every recipient used here. Each gets a status from
// core/status.ts, refreshed on the momentum beat.

import { reactive, watch } from 'vue'
import { api, node, syrius, chainId as zenonChain } from './zenon.ts'
import { config } from '../config.ts'
import { evm, walletForReads } from './evm.ts'
import { bridge, nodeContext, routeByEvmToken, routeByZts } from './bridge.ts'
import { readClient } from '../evm/client.ts'
import { bridgeAbi } from '../evm/abi.ts'
import { wrapStatus, unwrapStatus, isAffiliateEntry, type Status } from '../core/status.ts'
import type { UnwrapRequest, WrapRequest } from '../znn/api.ts'
import { allPages, mapLimit } from '../core/paging.ts'
import { isAddress, parseZts } from '../znn/primitives.ts'
import { isEvmRecipient } from '../core/recipient.ts'
import { parseEventLogs } from 'viem'
import { operations } from './operations.ts'

const KEY = 'bridge.activity.v2'
const WATCH_KEY = 'bridge.watch'
let localStorageProblem = ''

export interface LocalWrap {
  kind: 'wrap'
  id: string
  /** Zenon chain identifier; absent on records from before it was kept. */
  contract?: string
  terminal?: boolean
  znn?: number
  chainId: number
  toAddress: string
  from: string
  tokenStandard: string
  amount: string
  createdAt: number
}

export interface LocalUnwrap {
  kind: 'unwrap'
  txHash: string
  logIndex?: number
  contract?: string
  terminal?: boolean
  znn?: number
  chainId: number
  toAddress: string
  from: string
  tokenAddress: string
  amount: string
  createdAt: number
}

export type LocalRecord = LocalWrap | LocalUnwrap

export interface Item {
  key: string
  kind: 'wrap' | 'unwrap'
  chainId: number
  toAddress: string
  amount: bigint
  symbol: string
  decimals: number
  createdAt: number
  status: Status<string>
  bonus: boolean
  wrap?: WrapRequest
  unwrap?: UnwrapRequest
  /** Zenon tx of the wrap, or the EVM tx of the unwrap. */
  sourceTx: string
  context: string
}

export const activity = reactive({
  local: load(),
  items: [] as Item[],
  loading: false,
  loadedOnce: false,
  /** Node/chain/contract/request identity -> a current EVM redeem read. */
  redeemBlocks: {} as Record<string, string>,
  evmBlocks: {} as Record<number, string>,
  busy: {} as Record<string, boolean>,
  /** When items were last built: countdowns run from here. */
  builtAt: 0,
  readAt: 0,
  context: '',
  error: '',
  storageError: localStorageProblem,
  /** Addresses the user asked to follow without connecting a wallet. */
  watched: loadWatched(),
})

function loadWatched(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(WATCH_KEY) || '[]')
    return Array.isArray(value) ? value.filter((a): a is string => typeof a === 'string' && (isAddress(a) || isEvmRecipient(a))).slice(0, 20) : []
  } catch {
    return []
  }
}

export function setWatched(list: string[]) {
  activity.watched = [...new Set(list.filter((a) => isAddress(a) || isEvmRecipient(a)))].slice(0, 20)
  try {
    localStorage.setItem(WATCH_KEY, JSON.stringify(activity.watched))
  } catch {
    /* holds for this tab */
  }
  void refreshActivity()
}

function load(): LocalRecord[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || '[]')
    if (!Array.isArray(raw) || raw.length > 10_000) throw new Error('Malformed local history')
    const records = raw.filter(validLocal)
    if (records.length !== raw.length) {
      localStorageProblem = 'Some local history is unreadable. Original storage is retained; restore the original hashes before relying on this history.'
      try { localStorage.setItem(KEY + '.quarantine', JSON.stringify(raw)) } catch { /* original storage is retained */ }
    }
    return records
  } catch {
    localStorageProblem = 'Local history is unavailable. Original storage is retained; recover the original transaction identities.'
    return []
  }
}

function save() {
  if (localStorageProblem) { activity.storageError = localStorageProblem; return }
  try {
    const retained = activity.local.filter((r) => !r.terminal).concat(activity.local.filter((r) => r.terminal).slice(0, 200))
    localStorage.setItem(KEY, JSON.stringify(retained))
  } catch {
    activity.storageError = 'Cannot save local history. Keep the original transaction hashes.'
  }
}

/** The records sent on the chain the node in use is on. */
const localHere = () => activity.local.filter((r) => (r.znn ?? config.zenonChainId) === zenonChain())

export function remember(r: LocalRecord) {
  const record = { ...r, znn: r.znn ?? zenonChain() }
  if (!validLocal(record)) throw new Error('Invalid local transaction record')
  activity.local.unshift(record)
  save()
  void refreshActivity()
}

/** Addresses whose history is read: the connected ones and every recipient used here. */
function addresses() {
  const evmAddrs = new Set<string>()
  const zAddrs = new Set<string>()
  if (evm.account) evmAddrs.add(evm.account.toLowerCase())
  if (syrius.address) zAddrs.add(syrius.address)
  for (const r of localHere()) {
    if (r.kind === 'wrap') evmAddrs.add(r.toAddress.toLowerCase())
    else zAddrs.add(r.toAddress)
  }
  for (const a of activity.watched) {
    if (a.startsWith('0x')) evmAddrs.add(a.toLowerCase())
    else zAddrs.add(a)
  }
  return { evmAddrs: [...evmAddrs], zAddrs: [...zAddrs] }
}

function validLocal(value: unknown): value is LocalRecord {
  if (!value || typeof value !== 'object') return false
  const r = value as LocalRecord
  if (!['wrap', 'unwrap'].includes(r.kind) || !Number.isSafeInteger(r.chainId) || r.chainId <= 0 ||
    r.znn !== undefined && (!Number.isSafeInteger(r.znn) || r.znn <= 0) || typeof r.amount !== 'string' ||
    !/^\d{1,78}$/.test(r.amount) || BigInt(r.amount) >= (1n << 256n) || !Number.isSafeInteger(r.createdAt) ||
    typeof r.from !== 'string' || typeof r.toAddress !== 'string') return false
  if (r.contract !== undefined && !isEvmRecipient(r.contract)) return false
  if (r.kind === 'wrap') {
    try { parseZts(r.tokenStandard) } catch { return false }
    return /^[0-9a-f]{64}$/i.test(r.id) && isAddress(r.from) && isEvmRecipient(r.toAddress)
  }
  return /^0x[0-9a-f]{64}$/i.test(r.txHash) && isEvmRecipient(r.from) && isAddress(r.toAddress) && isEvmRecipient(r.tokenAddress) &&
    (r.logIndex === undefined || Number.isSafeInteger(r.logIndex) && r.logIndex >= 0 && r.logIndex < 4_000_000_000)
}

let requestId = 0
let active: { key: string; promise: Promise<void> } | null = null
const historyContext = () => JSON.stringify([nodeContext(), evm.account, evm.chainId, evm.selected?.info.uuid, syrius.address, activity.watched,
  localHere().map((r) => r.kind === 'wrap' ? r.id : r.txHash)])
const redeemKey = (w: WrapRequest) => JSON.stringify([nodeContext(), w.networkClass, w.chainId, bridge.networks.find((n) => n.chainId === w.chainId)?.contractAddress.toLowerCase(), w.id])

export function refreshActivity(): Promise<void> {
  const a = api.value, key = historyContext()
  if (!a || !bridge.orch || !bridge.loaded) return Promise.resolve()
  if (active?.key === key) return active.promise
  const request = ++requestId
  const current = () => request === requestId && a === api.value && historyContext() === key
  if (activity.context !== key) { activity.items = []; activity.redeemBlocks = {}; activity.evmBlocks = {}; activity.loadedOnce = false }
  activity.context = key
  activity.loading = true
  activity.readAt = 0
  const promise = (async () => {
    try {
      // Exact publication reconciliation does not depend on complete address
      // history, which may be unavailable or exceed the paging limit.
      for (const operation of operations.entries.filter((r) => r.hash && ['submitted', 'unknown'].includes(r.state))) {
        if (!current()) return
        const { reconcileZenon, reconcileEvm } = await import('./reconcile.ts')
        if (operation.source === 'zenon' && operation.chainId === zenonChain()) await reconcileZenon(a, operation, operation.hash, current).catch(() => false)
        else if (operation.source === 'evm') await reconcileEvm(readClient(operation.chainId, walletForReads()), operation, operation.hash, current).catch(() => false)
      }
      const { evmAddrs, zAddrs } = addresses()
      const local = localHere().map((r) => ({ ...r }))
      const [wrapLists, unwrapLists] = await Promise.all([
        mapLimit(evmAddrs, (address) => allPages((index, size) => a.wrapsTo(address, index, size), current)),
        mapLimit(zAddrs, (address) => allPages((index, size) => a.unwrapsTo(address, index, size), current)),
      ])
      const allWraps = dedupe(wrapLists.flat(), (w) => `${w.networkClass}:${w.chainId}:${w.id}`)
      const allUnwraps = dedupe(unwrapLists.flat(), (u) => `${u.networkClass}:${u.chainId}:${u.transactionHash}:${u.logIndex}`)
      for (const r of local) {
        if (!current()) return
        if (r.kind === 'wrap' && !allWraps.some((w) => w.id === r.id)) {
          const exact = await a.wrapById(r.id)
          if (exact && exact.chainId === r.chainId && exact.toAddress.toLowerCase() === r.toAddress.toLowerCase()) allWraps.push(exact)
        } else if (r.kind === 'unwrap') {
          let logIndex = r.logIndex
          if (logIndex === undefined) {
            const route = routeByEvmToken(r.chainId, r.tokenAddress)
            const contract = r.contract ?? route?.contract
            if (!contract) continue
            try {
              const reader = readClient(r.chainId, walletForReads())
              if (await reader.getChainId() !== r.chainId) throw new Error('RPC chain mismatch')
              const receipt = await reader.getTransactionReceipt({ hash: r.txHash as `0x${string}` })
              if (receipt.transactionHash.toLowerCase() !== r.txHash.toLowerCase() || receipt.status !== 'success') continue
              const logs = parseEventLogs({ abi: bridgeAbi, eventName: 'Unwrapped', logs: receipt.logs.filter((l) => l.address.toLowerCase() === contract.toLowerCase()) })
              if (logs.length !== 1 || logs[0].args.token.toLowerCase() !== r.tokenAddress.toLowerCase() || logs[0].args.to.split('&')[0] !== r.toAddress) continue
              logIndex = logs[0].logIndex
              const stored = activity.local.find((x) => x.kind === 'unwrap' && x.txHash === r.txHash && x.znn === r.znn) as LocalUnwrap | undefined
              if (current() && stored) { stored.logIndex = logIndex; stored.contract = contract; save() }
            } catch { continue /* pending exact receipt: never discover a hash from history */ }
          }
          if (!allUnwraps.some((u) => u.transactionHash.replace(/^0x/, '').toLowerCase() === r.txHash.slice(2).toLowerCase() && u.logIndex === logIndex && u.chainId === r.chainId)) {
            const exact = await a.unwrapByHashAndLog(r.txHash, logIndex)
            if (exact && exact.chainId === r.chainId && exact.toAddress === r.toAddress) allUnwraps.push(exact)
          }
        }
      }
      const [redeems, blocks] = await readEvmRedeems(allWraps, current)
      if (!current()) return
      activity.redeemBlocks = redeems
      activity.evmBlocks = blocks
      activity.items = build(allWraps, allUnwraps)
      activity.builtAt = Date.now() / 1000
      activity.readAt = Date.now()
      activity.loadedOnce = true
      activity.error = ''
      if (current()) {
        for (const record of activity.local) {
          const item = activity.items.find((i) => i.sourceTx.toLowerCase() === (record.kind === 'wrap' ? record.id : record.txHash.slice(2)).toLowerCase())
          if (item && ['done', 'revoked', 'failed'].includes(item.status.state)) record.terminal = true
        }
        save()
      }
    } catch (error) {
      if (current()) { activity.error = error instanceof Error ? error.message : 'History unavailable'; activity.readAt = 0 }
    } finally {
      if (current()) { active = null; activity.loading = false }
    }
  })()
  active = { key, promise }
  return promise
}

function dedupe<T>(list: T[], key: (x: T) => string): T[] {
  const m = new Map<string, T>()
  for (const x of list) m.set(key(x), x)
  return [...m.values()]
}

async function readEvmRedeems(wraps: WrapRequest[], current: () => boolean): Promise<[Record<string, string>, Record<number, string>]> {
  const redeemBlocks: Record<string, string> = {}, evmBlocks: Record<number, string> = {}
  for (const chainId of new Set(wraps.filter((w) => w.signature).map((w) => w.chainId))) {
    const net = bridge.networks.find((n) => n.chainId === chainId)
    if (!net || !current()) continue
    const c = readClient(chainId, walletForReads())
    try {
      if (await c.getChainId() !== chainId) continue
      await mapLimit(wraps.filter((r) => r.chainId === chainId && r.signature), async (w) => {
        if (!current()) return
        try {
          const [bn] = await c.readContract({ address: net.contractAddress as `0x${string}`, abi: bridgeAbi, functionName: 'redeemsInfo', args: [BigInt('0x' + w.id)] })
          redeemBlocks[redeemKey(w)] = bn.toString()
        } catch { /* unread is explicit; never reuse a completed cache after failure */ }
      })
      if (current() && await c.getChainId() === chainId) evmBlocks[chainId] = (await c.getBlockNumber({ cacheTime: 0 })).toString()
    } catch { /* no current EVM height */ }
  }
  return [redeemBlocks, evmBlocks]
}

function build(wraps: WrapRequest[], unwraps: UnwrapRequest[]): Item[] {
  const momentumSeconds = bridge.orch?.estimatedMomentumTime || node.rate
  const items: Item[] = []
  const now = Date.now() / 1000
  const ageOf = (height: number) => now - Math.max(0, node.height - height) * momentumSeconds
  // A request sent from this browser keeps the time it was sent, so its row
  // does not move when the chain's own (estimated) time takes over.
  const sentAt = new Map<string, number>()
  for (const r of localHere()) sentAt.set(r.kind === 'wrap' ? r.id : r.txHash.replace(/^0x/, '').toLowerCase(), r.createdAt)

  for (const w of wraps) {
    const route = routeByZts(w.chainId, w.tokenStandard)
    const rb = activity.redeemBlocks[redeemKey(w)]
    const eb = activity.evmBlocks[w.chainId]
    const net = bridge.evmNetworks[w.chainId]
    items.push({
      key: `w:${redeemKey(w)}`,
      kind: 'wrap',
      chainId: w.chainId,
      toAddress: w.toAddress,
      amount: w.amount - w.fee,
      symbol: route?.evm?.symbol ?? w.token?.symbol ?? '',
      decimals: route?.evm?.decimals ?? w.token?.decimals ?? 8,
      createdAt: sentAt.get(w.id) ?? ageOf(w.creationMomentumHeight),
      bonus: false,
      wrap: w,
      context: activity.context,
      sourceTx: w.id,
      status: wrapStatus({
        signature: w.signature,
        confirmationsToFinality: w.confirmationsToFinality,
        momentumSeconds,
        redeemBlock: rb === undefined ? null : BigInt(rb),
        evmBlock: eb === undefined ? null : BigInt(eb),
        redeemDelay: route?.evmInfo?.redeemDelay ?? null,
        evmBlockSeconds: net?.blockTime ?? 12,
      }),
    })
  }
  for (const u of [...unwraps].sort((a, b) => a.logIndex - b.logIndex)) {
    const route = routeByEvmToken(u.chainId, u.tokenAddress)
    items.push({
      key: `u:${nodeContext()}:${u.networkClass}:${u.chainId}:${u.transactionHash}:${u.logIndex}`,
      kind: 'unwrap',
      chainId: u.chainId,
      toAddress: u.toAddress,
      amount: u.amount,
      symbol: u.token?.symbol ?? route?.zts?.symbol ?? '',
      decimals: u.token?.decimals ?? 8,
      createdAt: sentAt.get(u.transactionHash) ?? ageOf(u.registrationMomentumHeight),
      bonus: isAffiliateEntry(u.logIndex),
      unwrap: u,
      context: activity.context,
      sourceTx: u.transactionHash,
      status: unwrapStatus({ ...u, momentumSeconds }),
    })
  }
  // Sent here, not on chain yet.
  for (const r of localHere()) {
    if (r.kind === 'wrap' && !wraps.some((w) => w.id === r.id)) {
      const route = routeByZts(r.chainId, r.tokenStandard)
      items.push({
        key: `w:${nodeContext()}:${r.chainId}:${r.contract ?? ''}:${r.id}`,
        kind: 'wrap',
        chainId: r.chainId,
        toAddress: r.toAddress,
        amount: BigInt(r.amount),
        symbol: route?.evm?.symbol ?? route?.zts?.symbol ?? '',
        decimals: route?.zts?.decimals ?? 8,
        createdAt: r.createdAt,
        bonus: false,
        context: activity.context,
      sourceTx: r.id,
        status: { state: 'confirming', label: 'Confirming', tone: 'wait' },
      })
    }
    if (r.kind === 'unwrap' && !unwraps.some((u) => u.transactionHash.replace(/^0x/, '') === r.txHash.replace(/^0x/, '').toLowerCase())) {
      const route = routeByEvmToken(r.chainId, r.tokenAddress)
      const net = bridge.evmNetworks[r.chainId]
      const wait = (net?.confirmations ?? 0) * (net?.blockTime ?? 12) - (now - r.createdAt)
      items.push({
        key: `u:${nodeContext()}:${r.chainId}:${r.contract ?? ''}:${r.txHash.toLowerCase()}`,
        kind: 'unwrap',
        chainId: r.chainId,
        toAddress: r.toAddress,
        amount: BigInt(r.amount),
        symbol: route?.zts?.symbol ?? '',
        decimals: route?.zts?.decimals ?? 8,
        createdAt: r.createdAt,
        bonus: false,
        context: activity.context,
      sourceTx: r.txHash,
        status: { state: 'signing', label: wait > 0 ? 'Confirming' : 'Signing', tone: 'wait', eta: wait > 0 ? wait : undefined },
      })
    }
  }
  return items.sort((a, b) => b.createdAt - a.createdAt)
}

/** Pending items need watching; done ones do not. */
export const pendingCount = () => activity.items.filter((i) => !['done', 'revoked', 'failed'].includes(i.status.state)).length
export const actionCount = () => activity.items.filter((i) => ['redeem', 'finish'].includes(i.status.state)).length

export function startActivity() {
  let last = 0
  watch(
    () => node.tick,
    () => {
      const now = Date.now()
      // Every ~30 s while something is pending, every 2 min otherwise.
      const every = pendingCount() ? 30_000 : 120_000
      if (now - last > every) {
        last = now
        void refreshActivity()
      }
    },
  )
  watch(
    () => [api.value, node.epoch, node.chainId, evm.account, evm.chainId, evm.selected, syrius.address, bridge.loaded],
    () => { requestId++; active = null; activity.readAt = 0; if (activity.context !== historyContext()) activity.items = []; void refreshActivity() },
    { flush: 'sync' },
  )
}
