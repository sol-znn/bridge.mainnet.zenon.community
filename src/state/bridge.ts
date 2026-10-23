// Everything about the bridge that is the same for every user: its switches,
// the networks and token pairs, the EVM side of each pair, and whether the
// orchestrators are moving. Read from the chain on load and refreshed on the
// momentum beat.

import { reactive, watch } from 'vue'
import { api, node, nodeIsCurrent } from './zenon.ts'
import { walletForReads } from './evm.ts'
import { readClient } from '../evm/client.ts'
import { bridgeAbi, erc20Abi } from '../evm/abi.ts'
import {
  parseMetadata,
  type BridgeInfo,
  type BridgeMetadata,
  type NetworkInfo,
  type OrchestratorInfo,
  type TokenPair,
  type ZtsToken,
} from '../znn/api.ts'
import { assessHealth, isDown, type Health } from '../core/orchestrators.ts'
import { mapLimit } from '../core/paging.ts'
import { evmChain } from '../config.ts'
import { publicKeyToAddress } from 'viem/accounts'
import { fromBase64, toHex } from '../znn/primitives.ts'
import type { ZenonApi } from '../znn/api.ts'

export interface EvmToken {
  symbol: string
  name: string
  decimals: number
}

/** The EVM bridge's view of a token (bridge.sol `tokensInfo`). */
export interface EvmTokenInfo {
  minAmount: bigint
  redeemDelay: bigint
  bridgeable: boolean
  redeemable: boolean
  owned: boolean
}

export interface Route {
  key: string
  chainId: number
  networkClass: number
  networkName: string
  /** The EVM bridge contract. */
  contract: `0x${string}`
  pair: TokenPair
  zts: ZtsToken | null
  evm: EvmToken | null
  evmInfo: EvmTokenInfo | null
  /** Zenon to EVM is open: Zenon side bridgeable, EVM side redeemable. */
  canWrap: boolean
  /** EVM to Zenon is open. */
  canUnwrap: boolean
}

export interface EvmNetworkInfo {
  height: bigint | null
  blockTime: number
  confirmations: number
  halted: boolean | null
  error: string
  tssMatches: boolean
}

export const bridge = reactive({
  loaded: false,
  error: '',
  info: null as BridgeInfo | null,
  meta: {} as BridgeMetadata,
  orch: null as OrchestratorInfo | null,
  networks: [] as NetworkInfo[],
  routes: [] as Route[],
  evmNetworks: {} as Record<number, EvmNetworkInfo>,
  health: null as Health | null,
  healthLoading: false,
  readAt: 0,
  healthAt: 0,
  context: '',
  healthError: '',
  unsignedCount: 0,
  healthSampled: false,
})

export const READ_TTL_MS = 180_000
export const nodeContext = () => JSON.stringify([node.epoch, node.url, node.chainId])

async function ztsToken(a: ZenonApi, zts: string): Promise<ZtsToken | null> {
  // A failed read is retryable; do not cache null as a permanent token absence.
  return a.token(zts).catch(() => null)
}

async function evmSide(chainId: number, contract: `0x${string}`, token: `0x${string}`) {
  const c = readClient(chainId, walletForReads())
  const [meta, info] = await Promise.all([
    Promise.all([
      c.readContract({ address: token, abi: erc20Abi, functionName: 'symbol' }),
      c.readContract({ address: token, abi: erc20Abi, functionName: 'name' }),
      c.readContract({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    ]).then(([symbol, name, decimals]) => ({ symbol, name, decimals: Number(decimals) }) as EvmToken).catch(() => null),
    c
      .readContract({ address: contract, abi: bridgeAbi, functionName: 'tokensInfo', args: [token] })
      .then(([minAmount, redeemDelay, bridgeable, redeemable, owned]) => ({ minAmount, redeemDelay, bridgeable, redeemable, owned }))
      .catch(() => null),
  ])
  return { meta, info }
}

async function evmNetwork(chainId: number, contract: `0x${string}`, expectedTss: string): Promise<EvmNetworkInfo> {
  const c = readClient(chainId, walletForReads())
  try {
    const [bt, conf, halted, tss, reportedChain, height] = await Promise.all([
      c.readContract({ address: contract, abi: bridgeAbi, functionName: 'estimatedBlockTime' }),
      c.readContract({ address: contract, abi: bridgeAbi, functionName: 'confirmationsToFinality' }),
      c.readContract({ address: contract, abi: bridgeAbi, functionName: 'isHalted' }),
      c.readContract({ address: contract, abi: bridgeAbi, functionName: 'tss' }),
      c.getChainId(),
      c.getBlockNumber(),
    ])
    if (reportedChain !== chainId || !expectedTss || tss.toLowerCase() !== expectedTss.toLowerCase()) throw new Error('Bridge chain or signing key does not match')
    if (bt <= 0n || conf <= 0n || bt > BigInt(Number.MAX_SAFE_INTEGER) || conf > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Bridge timing metadata is invalid')
    return { blockTime: Number(bt), confirmations: Number(conf), halted, error: '', tssMatches: true, height }
  } catch (err) {
    return { blockTime: chainId === 56 ? 3 : 12, confirmations: 0, halted: null, tssMatches: false, height: null, error: (err as Error).message.split('\n')[0] }
  }
}

let bridgeRequest = 0
let healthRequest = 0
let active: { api: ZenonApi; key: string; promise: Promise<void> } | null = null

export function invalidateBridge() {
  bridgeRequest++
  healthRequest++
  active = null
  Object.assign(bridge, { loaded: false, readAt: 0, healthAt: 0, context: '', health: null,
    info: null, orch: null, meta: {}, routes: [], networks: [], evmNetworks: {}, healthError: '', healthLoading: false })
}

export function loadBridge(): Promise<void> {
  const a = api.value
  const key = nodeContext()
  if (active?.api === a && active.key === key) return active.promise
  const request = ++bridgeRequest
  healthRequest++
  bridge.healthLoading = false
  bridge.loaded = false
  bridge.healthAt = 0
  const current = () => request === bridgeRequest && api.value === a && nodeContext() === key
  const promise = (async () => {
    try {
      if (!a) throw new Error('Node is not connected')
      const [info, orch, networks] = await Promise.all([a.bridgeInfo(), a.orchestratorInfo(), a.networks()])
      let expectedTss = ''
      try { expectedTss = publicKeyToAddress(('0x' + toHex(fromBase64(info.decompressedTssECDSAPubKey))) as `0x${string}`) } catch { /* unavailable key closes routes */ }
      const nets: Record<number, EvmNetworkInfo> = {}
      const routes: Route[] = []
      await mapLimit(networks, async (n) => {
        const contract = n.contractAddress as `0x${string}`
        const net = await evmNetwork(n.chainId, contract, expectedTss)
        nets[n.chainId] = net
        await mapLimit(n.tokenPairs, async (pair) => {
          const [zts, side] = await Promise.all([ztsToken(a, pair.tokenStandard), evmSide(n.chainId, contract, pair.tokenAddress as `0x${string}`)])
          const valid = !!zts && !!side.meta && zts.decimals === side.meta.decimals && net.halted === false && net.tssMatches
          routes.push({ key: `${n.networkClass}:${n.chainId}:${contract.toLowerCase()}:${pair.tokenStandard}:${pair.tokenAddress.toLowerCase()}`,
            chainId: n.chainId, networkClass: n.networkClass, networkName: n.name || evmChain(n.chainId).name,
            contract, pair, zts, evm: side.meta, evmInfo: side.info,
            canWrap: valid && pair.bridgeable && side.info?.redeemable === true,
            canUnwrap: valid && pair.redeemable && side.info?.bridgeable === true })
        }, 2)
      }, 2)
      if (!current()) return
      const rank = (r: Route) => r.zts?.symbol === 'ZNN' ? 0 : r.zts?.symbol === 'QSR' ? 1 : 2
      routes.sort((x, y) => x.chainId - y.chainId || rank(x) - rank(y) || (x.zts?.symbol ?? '').localeCompare(y.zts?.symbol ?? ''))
      Object.assign(bridge, { info, orch, networks, routes, meta: parseMetadata(info.metadata), evmNetworks: nets,
        loaded: true, readAt: Date.now(), context: key, error: '' })
    } catch (err) {
      if (current()) { bridge.loaded = false; bridge.error = err instanceof Error ? err.message : 'Bridge read failed' }
    } finally {
      if (current()) active = null
    }
  })()
  active = { api: a, key, promise }
  return promise
}

export async function loadHealth() {
  if (!bridge.loaded || !bridge.info || !bridge.orch) return
  const a = api.value, key = nodeContext(), info = bridge.info, orch = bridge.orch
  const request = ++healthRequest
  bridge.healthLoading = true
  const current = () => request === healthRequest && api.value === a && nodeContext() === key && bridge.info === info
  try {
    const [unsigned, blocks, pillars] = await Promise.all([a.unsignedWraps(0, 100), a.bridgeBlocks(3), a.pillarsByProducer()])
    if (!current()) return
    bridge.health = assessHealth({ now: Date.now() / 1000, frontierHeight: node.height,
      momentumSeconds: orch.estimatedMomentumTime || node.rate, halted: info.halted, allowKeyGen: info.allowKeyGen,
      unsigned: unsigned.list.map((w) => ({ id: w.id, creationMomentumHeight: w.creationMomentumHeight,
        confirmationsToFinality: w.confirmationsToFinality, amount: w.amount.toString(), symbol: w.token?.symbol ?? '', decimals: w.token?.decimals ?? 8, chainId: w.chainId })),
      blocks, pillarsByProducer: pillars })
    bridge.healthAt = Date.now()
    bridge.healthError = ''
    bridge.unsignedCount = unsigned.count
    bridge.healthSampled = unsigned.count > unsigned.list.length
  } catch (err) {
    if (current()) { bridge.healthAt = 0; bridge.healthError = err instanceof Error ? err.message : 'Health read unavailable' }
  } finally {
    if (current()) bridge.healthLoading = false
  }
}

export function transferHealthWarning(): string {
  void node.tick
  if (!bridge.health || !bridge.healthAt || Date.now() - bridge.healthAt > READ_TTL_MS || bridge.healthError) return 'Bridge health unavailable'
  return bridge.health.state === 'unknown' || isDown(bridge.health.state) ? 'Bridge is unavailable' : ''
}

/** The explicit health opt-in never overrides configuration, identity or halt checks. */
export function transferBlocker(route?: Route, direction?: 'wrap' | 'unwrap', sendWhileDown = false): string {
  void node.tick
  if (!bridge.loaded || bridge.context !== nodeContext() || !bridge.readAt || Date.now() - bridge.readAt > READ_TTL_MS) return 'Bridge configuration unavailable'
  if (!nodeIsCurrent()) return 'Node is not current'
  if (bridge.info?.halted || bridge.info?.allowKeyGen) return 'Bridge is paused'
  if (route) {
    const net = bridge.evmNetworks[route.chainId]
    if (!net || net.error || net.halted !== false || !net.tssMatches || !route.zts || !route.evm || !route.evmInfo) return 'Destination configuration unavailable'
    if (direction === 'wrap' && !route.canWrap || direction === 'unwrap' && !route.canUnwrap) return 'Route is closed'
  }
  return sendWhileDown ? '' : transferHealthWarning()
}

export const bridgeDown = () => Boolean(transferBlocker())

export function startBridge() {
  const first = async () => { await loadBridge(); if (bridge.loaded && node.height) await loadHealth() }
  watch(() => [api.value, node.epoch, node.url, node.chainId], () => {
    invalidateBridge()
    if (api.value) void first()
  }, { immediate: true, flush: 'sync' })
  let lastFull = 0, healthAt = 0
  watch(() => node.tick, () => {
    const now = Date.now()
    if ((!bridge.loaded || now - lastFull > 90_000) && !active) { lastFull = now; void first() }
    else if (bridge.loaded && !bridge.healthLoading && (!bridge.healthAt || now - healthAt > 120_000)) { healthAt = now; void loadHealth() }
  })
}

export function routesFor(chainId: number) {
  return bridge.routes.filter((r) => r.chainId === chainId)
}

export function routeByZts(chainId: number, zts: string) {
  return bridge.routes.find((r) => r.chainId === chainId && r.pair.tokenStandard === zts)
}

export function routeByEvmToken(chainId: number, token: string) {
  return bridge.routes.find((r) => r.chainId === chainId && r.pair.tokenAddress.toLowerCase() === token.toLowerCase())
}
