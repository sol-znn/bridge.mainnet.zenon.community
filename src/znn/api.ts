// The node calls the bridge front end makes, typed from what go-zenon returns
// (rpc/api/embedded/bridge.go, liquidity.go; shapes sampled from mainnet on
// 2026-10-12). Amounts arrive as decimal strings and are converted to bigint
// here, at the edge, so nothing downstream handles a numeric amount.

import { encodeCall } from './abi.ts'
import type { ZenonClient, Momentum } from './client.ts'
import { BRIDGE, LIQUIDITY } from '../config.ts'
import type { BlockSpec } from './block.ts'
import { selectorOf } from './abi.ts'
import * as v from './validation.ts'

export interface ZtsToken {
  name: string
  symbol: string
  domain: string
  decimals: number
  tokenStandard: string
  totalSupply: string
  maxSupply: string
  owner: string
}

export interface BridgeInfo {
  administrator: string
  compressedTssECDSAPubKey: string
  decompressedTssECDSAPubKey: string
  allowKeyGen: boolean
  halted: boolean
  unhaltedAt: number
  unhaltDurationInMomentums: number
  tssNonce: number
  metadata: string
}

export interface BridgeMetadata {
  affiliateProgram?: {
    networks?: Record<string, { startingHeight?: number; [symbol: string]: boolean | number | undefined }>
  }
  resignState?: { active: boolean; networkClass: number; chainId: number }
  signCeremonyPoolSize?: number
  keyGenVersion?: string
}

export interface OrchestratorInfo {
  windowSize: number
  keyGenThreshold: number
  confirmationsToFinality: number
  estimatedMomentumTime: number
  allowKeyGenHeight: number
}

export interface TokenPair {
  tokenStandard: string
  tokenAddress: string
  bridgeable: boolean
  redeemable: boolean
  owned: boolean
  minAmount: bigint
  feePercentage: number
  redeemDelay: number
  metadata: string
}

export interface NetworkInfo {
  networkClass: number
  chainId: number
  name: string
  contractAddress: string
  metadata: string
  tokenPairs: TokenPair[]
}

export interface WrapRequest {
  networkClass: number
  chainId: number
  id: string
  toAddress: string
  tokenStandard: string
  tokenAddress: string
  amount: bigint
  fee: bigint
  signature: string
  creationMomentumHeight: number
  token: ZtsToken | null
  confirmationsToFinality: number
}

export interface UnwrapRequest {
  registrationMomentumHeight: number
  networkClass: number
  chainId: number
  transactionHash: string
  logIndex: number
  toAddress: string
  tokenAddress: string
  tokenStandard: string
  amount: bigint
  signature: string
  redeemed: number
  revoked: number
  token: ZtsToken | null
  redeemableIn: number
}

export interface LiquidityInfo {
  administrator: string
  isHalted: boolean
  znnReward: bigint
  qsrReward: bigint
  tokenTuples: Array<{ tokenStandard: string; znnPercentage: number; qsrPercentage: number; minAmount: bigint }>
}

export interface StakeEntry {
  id: string
  amount: bigint
  weightedAmount: bigint
  tokenStandard: string
  startTime: number
  revokeTime: number
  expirationTime: number
  stakeAddress: string
}

export interface Plasma {
  currentPlasma: number
  maxPlasma: number
  qsrAmount: bigint
}

export interface Page<T> {
  count: number
  list: T[]
}

type Raw = Record<string, unknown>
const big = v.amount
function token(value: unknown): ZtsToken | null {
  if (value === null) return null
  const r = v.record(value)
  return { name: v.text(r.name, 256), symbol: v.text(r.symbol, 64), domain: v.text(r.domain, 256), decimals: v.integer(r.decimals, 255),
    tokenStandard: v.tokenStandard(r.tokenStandard), totalSupply: big(r.totalSupply).toString(), maxSupply: big(r.maxSupply).toString(), owner: v.zenonAddress(r.owner) }
}
function pair(value: unknown): TokenPair {
  const r = v.record(value)
  return { tokenStandard: v.tokenStandard(r.tokenStandard), tokenAddress: v.evmAddress(r.tokenAddress), bridgeable: v.flag(r.bridgeable),
    redeemable: v.flag(r.redeemable), owned: v.flag(r.owned), minAmount: big(r.minAmount), feePercentage: v.integer(r.feePercentage, 10_000),
    redeemDelay: v.integer(r.redeemDelay), metadata: v.text(r.metadata) }
}
function wrap(value: unknown): WrapRequest {
  const r = v.record(value)
  const amount = big(r.amount), fee = big(r.fee)
  if (fee > amount) throw new Error('RPC fee exceeds amount')
  return { networkClass: v.integer(r.networkClass, 0xffffffff), chainId: v.integer(r.chainId, 0xffffffff), id: v.hash(r.id),
    toAddress: v.evmAddress(r.toAddress), tokenStandard: v.tokenStandard(r.tokenStandard), tokenAddress: v.evmAddress(r.tokenAddress),
    amount, fee, signature: v.text(r.signature, 256), creationMomentumHeight: v.integer(r.creationMomentumHeight), token: token(r.token),
    confirmationsToFinality: v.integer(r.confirmationsToFinality) }
}
function unwrap(value: unknown): UnwrapRequest {
  const r = v.record(value)
  return { registrationMomentumHeight: v.integer(r.registrationMomentumHeight), networkClass: v.integer(r.networkClass, 0xffffffff), chainId: v.integer(r.chainId, 0xffffffff),
    transactionHash: v.hash(r.transactionHash), logIndex: v.integer(r.logIndex, 0xffffffff), toAddress: v.zenonAddress(r.toAddress),
    tokenAddress: v.evmAddress(r.tokenAddress), tokenStandard: v.tokenStandard(r.tokenStandard), amount: big(r.amount), signature: v.text(r.signature, 256),
    redeemed: v.integer(r.redeemed, 1), revoked: v.integer(r.revoked, 1), token: token(r.token), redeemableIn: v.integer(r.redeemableIn) }
}
function page<T>(value: unknown, map: (x: unknown) => T): Page<T> {
  const r = v.record(value), count = v.integer(r.count), rows = v.list(r.list, true)
  if (rows.length > count) throw new Error('RPC page count is inconsistent')
  return { count, list: rows.map(map) }
}

export class ZenonApi {
  readonly c: ZenonClient
  constructor(client: ZenonClient) {
    this.c = client
  }

  frontierMomentum(): Promise<Momentum> {
    return this.c.frontierMomentum()
  }

  async momentumAt(height: number): Promise<Momentum | null> {
    const r = await this.c.call<{ list: Momentum[] | null }>('ledger.getMomentumsByHeight', [height, 1])
    const rows = v.list(r.list, true)
    return rows.length ? v.momentum(rows[0]) : null
  }

  async momentums(count: number): Promise<Momentum[]> {
    const r = await this.c.call<{ list: Momentum[] | null }>('ledger.getMomentumsByPage', [0, count])
    return v.list(r.list, true).map(v.momentum)
  }

  async balances(address: string): Promise<Record<string, bigint>> {
    const r = await this.c.call<{ balanceInfoMap: Record<string, { balance: string }> | null }>(
      'ledger.getAccountInfoByAddress',
      [address],
    )
    const out: Record<string, bigint> = {}
    for (const [zts, b] of Object.entries(r.balanceInfoMap ?? {})) out[v.tokenStandard(zts)] = big(v.record(b).balance)
    return out
  }

  async plasma(address: string): Promise<Plasma> {
    const r = await this.c.call<Raw>('embedded.plasma.get', [address])
    return { currentPlasma: v.integer(r.currentPlasma), maxPlasma: v.integer(r.maxPlasma), qsrAmount: big(r.qsrAmount) }
  }

  async token(zts: string): Promise<ZtsToken | null> {
    return token(await this.c.callOrNull('embedded.token.getByZts', [zts]))
  }

  async pillarsByProducer(): Promise<Record<string, string>> {
    const r = await this.c.call<{ list: Array<{ name: string; producerAddress: string }> | null }>(
      'embedded.pillar.getAll',
      [0, 1000],
    )
    const out: Record<string, string> = {}
    for (const value of v.list(r.list, true)) { const p = v.record(value); out[v.zenonAddress(p.producerAddress)] = v.text(p.name, 256) }
    return out
  }

  async bridgeInfo(): Promise<BridgeInfo> {
    const r = v.record(await this.c.call('embedded.bridge.getBridgeInfo'))
    return { administrator: v.zenonAddress(r.administrator), compressedTssECDSAPubKey: v.text(r.compressedTssECDSAPubKey, 128),
      decompressedTssECDSAPubKey: v.text(r.decompressedTssECDSAPubKey, 128), allowKeyGen: v.flag(r.allowKeyGen), halted: v.flag(r.halted),
      unhaltedAt: v.integer(r.unhaltedAt), unhaltDurationInMomentums: v.integer(r.unhaltDurationInMomentums), tssNonce: v.integer(r.tssNonce), metadata: v.text(r.metadata) }
  }

  async orchestratorInfo(): Promise<OrchestratorInfo> {
    const r = v.record(await this.c.call('embedded.bridge.getOrchestratorInfo'))
    return { windowSize: v.integer(r.windowSize), keyGenThreshold: v.integer(r.keyGenThreshold), confirmationsToFinality: v.integer(r.confirmationsToFinality),
      estimatedMomentumTime: v.integer(r.estimatedMomentumTime), allowKeyGenHeight: v.integer(r.allowKeyGenHeight) }
  }

  async securityInfo(): Promise<{ guardians: string[]; administratorDelay: number; softDelay: number }> {
    const r = v.record(await this.c.call('embedded.bridge.getSecurityInfo'))
    return { guardians: v.list(r.guardians, true).map(v.zenonAddress), administratorDelay: v.integer(r.administratorDelay), softDelay: v.integer(r.softDelay) }
  }

  async networks(): Promise<NetworkInfo[]> {
    const r = await this.c.call<{ list: Raw[] | null }>('embedded.bridge.getAllNetworks', [0, 100])
    return v.list(r.list, true).map((value) => {
      const n = v.record(value)
      return { networkClass: v.integer(n.networkClass, 0xffffffff), chainId: v.integer(n.chainId, 0xffffffff), name: v.text(n.name, 256),
        contractAddress: v.evmAddress(n.contractAddress), metadata: v.text(n.metadata), tokenPairs: v.list(n.tokenPairs, true).map(pair) }
    })
  }

  async feeTokenPair(zts: string): Promise<bigint> {
    const r = await this.c.callOrNull<Raw>('embedded.bridge.getFeeTokenPair', [zts])
    return r ? big(r.accumulatedFee) : 0n
  }

  async wrapsTo(address: string, pageIndex = 0, pageSize = 50): Promise<Page<WrapRequest>> {
    return page(await this.c.call('embedded.bridge.getAllWrapTokenRequestsByToAddress', [address, pageIndex, pageSize]), wrap)
  }

  async wrapById(id: string): Promise<WrapRequest | null> {
    const r = await this.c.callOrNull<Raw>('embedded.bridge.getWrapTokenRequestById', [id])
    return r ? wrap(r) : null
  }

  async allWraps(pageIndex = 0, pageSize = 1): Promise<Page<WrapRequest>> {
    return page(await this.c.call('embedded.bridge.getAllWrapTokenRequests', [pageIndex, pageSize]), wrap)
  }

  async unsignedWraps(pageIndex = 0, pageSize = 100): Promise<Page<WrapRequest>> {
    return page(await this.c.call('embedded.bridge.getAllUnsignedWrapTokenRequests', [pageIndex, pageSize]), wrap)
  }

  async unwrapsTo(address: string, pageIndex = 0, pageSize = 50): Promise<Page<UnwrapRequest>> {
    return page(await this.c.call('embedded.bridge.getAllUnwrapTokenRequestsByToAddress', [address, pageIndex, pageSize]), unwrap)
  }

  async unwrapByHashAndLog(txHash: string, logIndex: number): Promise<UnwrapRequest | null> {
    const r = await this.c.callOrNull<Raw>('embedded.bridge.getUnwrapTokenRequestByHashAndLog', [txHash.replace(/^0x/, ''), logIndex])
    return r ? unwrap(r) : null
  }

  async allUnwraps(pageIndex = 0, pageSize = 1): Promise<Page<UnwrapRequest>> {
    return page(await this.c.call('embedded.bridge.getAllUnwrapTokenRequests', [pageIndex, pageSize]), unwrap)
  }

  /**
   * The bridge contract's own chain, newest first: receive blocks, each paired
   * with the send that called the contract. `pages` × 100 blocks.
   */
  async bridgeBlocks(pages = 2): Promise<
    Array<{ address: string; selector: string; momentumHeight: number; momentumTimestamp: number }>
  > {
    const out: Array<{ address: string; selector: string; momentumHeight: number; momentumTimestamp: number }> = []
    for (let p = 0; p < pages; p++) {
      const r = await this.c.call<{ list: Raw[] | null; count: number }>('ledger.getAccountBlocksByPage', [BRIDGE, p, 100])
      const rows = v.list(r.list, true)
      for (const value of rows) {
        const b = v.record(value), send = b.pairedAccountBlock === null ? null : v.record(b.pairedAccountBlock), conf = b.confirmationDetail === null ? null : v.record(b.confirmationDetail)
        if (!send || !conf) continue
        out.push({
          address: v.zenonAddress(send.address),
          selector: selectorOf(v.text(send.data)),
          momentumHeight: v.integer(conf.momentumHeight),
          momentumTimestamp: v.integer(conf.momentumTimestamp),
        })
      }
      if (rows.length < 100) break
    }
    return out
  }

  async liquidityInfo(): Promise<LiquidityInfo> {
    const r = await this.c.call<Raw>('embedded.liquidity.getLiquidityInfo')
    return {
      administrator: v.zenonAddress(r.administrator), isHalted: v.flag(r.isHalted),
      znnReward: big(r.znnReward),
      qsrReward: big(r.qsrReward),
      tokenTuples: v.list(r.tokenTuples, true).map((value) => { const t = v.record(value); return { tokenStandard: v.tokenStandard(t.tokenStandard),
        znnPercentage: v.integer(t.znnPercentage, 10_000), qsrPercentage: v.integer(t.qsrPercentage, 10_000), minAmount: big(t.minAmount) } }),
    }
  }

  async stakeEntries(address: string, index = 0, size = 100): Promise<{ count: number; totalAmount: bigint; totalWeightedAmount: bigint; list: StakeEntry[] }> {
    const r = await this.c.call<Raw>('embedded.liquidity.getLiquidityStakeEntriesByAddress', [address, index, size])
    return {
      count: v.integer(r.count),
      totalAmount: big(r.totalAmount),
      totalWeightedAmount: big(r.totalWeightedAmount),
      list: v.list(r.list, true).map((value) => { const e = v.record(value); return { id: v.hash(e.id), amount: big(e.amount), weightedAmount: big(e.weightedAmount),
        tokenStandard: v.tokenStandard(e.tokenStandard), startTime: v.integer(e.startTime), revokeTime: v.integer(e.revokeTime), expirationTime: v.integer(e.expirationTime), stakeAddress: v.zenonAddress(e.stakeAddress) } }),
    }
  }

  async uncollectedReward(address: string): Promise<{ znn: bigint; qsr: bigint }> {
    const r = await this.c.call<Raw>('embedded.liquidity.getUncollectedReward', [address])
    return { znn: big(r.znnAmount), qsr: big(r.qsrAmount) }
  }
}

// The blocks a user signs in Syrius. Each is a send to an embedded contract.

export function wrapTokenBlock(o: {
  networkClass: number
  chainId: number
  toAddress: string
  tokenStandard: string
  amount: bigint
}): BlockSpec {
  return {
    toAddress: BRIDGE,
    tokenStandard: o.tokenStandard,
    amount: o.amount,
    data: encodeCall('WrapToken', ['uint32', 'uint32', 'string'], [o.networkClass, o.chainId, o.toAddress.toLowerCase()]),
  }
}

export function redeemBlock(transactionHash: string, logIndex: number): BlockSpec {
  return {
    toAddress: BRIDGE,
    data: encodeCall('Redeem', ['hash', 'uint32'], [transactionHash.replace(/^0x/, ''), logIndex]),
  }
}

export const MONTH_SECONDS = 30 * 24 * 60 * 60

export function liquidityStakeBlock(months: number, tokenStandard: string, amount: bigint): BlockSpec {
  return {
    toAddress: LIQUIDITY,
    tokenStandard,
    amount,
    data: encodeCall('LiquidityStake', ['int64'], [months * MONTH_SECONDS]),
  }
}

export function cancelLiquidityStakeBlock(id: string): BlockSpec {
  return { toAddress: LIQUIDITY, data: encodeCall('CancelLiquidityStake', ['hash'], [id]) }
}

export function collectRewardBlock(): BlockSpec {
  return { toAddress: LIQUIDITY, data: encodeCall('CollectReward', [], []) }
}

export function parseMetadata(raw: string): BridgeMetadata {
  try {
    const source = v.record(JSON.parse(v.text(raw, 32_768)))
    const meta: BridgeMetadata = {}
    if (source.affiliateProgram !== undefined) {
      const program = v.record(source.affiliateProgram), networks = v.record(program.networks)
      const clean: NonNullable<NonNullable<BridgeMetadata['affiliateProgram']>['networks']> = {}
      if (Object.keys(networks).length > 100) throw new Error('Too many affiliate networks')
      for (const [key, value] of Object.entries(networks)) {
        if (!/^\d{1,10}$/.test(key) || Number(key) < 1 || Number(key) > 0xffffffff) throw new Error('Invalid affiliate network')
        const n = v.record(value)
        clean[key] = { startingHeight: n.startingHeight === undefined ? 0 : v.integer(n.startingHeight),
          wZNN: n.wZNN === undefined ? false : v.flag(n.wZNN), wQSR: n.wQSR === undefined ? false : v.flag(n.wQSR) }
      }
      meta.affiliateProgram = { networks: clean }
    }
    if (source.resignState !== undefined) { const r = v.record(source.resignState); meta.resignState = { active: v.flag(r.active), networkClass: v.integer(r.networkClass, 0xffffffff), chainId: v.integer(r.chainId, 0xffffffff) } }
    if (source.signCeremonyPoolSize !== undefined) meta.signCeremonyPoolSize = v.integer(source.signCeremonyPoolSize, 1000)
    if (source.keyGenVersion !== undefined) meta.keyGenVersion = v.text(source.keyGenVersion, 128)
    return meta
  } catch {
    return {}
  }
}

/**
 * Whether the affiliate bonus applies to an unwrap of the token paired with
 * `tokenStandard` on `chainId`. The orchestrator keys the program by the EVM
 * token paired with ZNN (flag "wZNN") and with QSR ("wQSR"), from
 * `startingHeight` (HyperCore orchestrator, common/global_state.go).
 */
export function affiliateActive(meta: BridgeMetadata, chainId: number, tokenStandard: string, height?: bigint): boolean {
  const n = meta.affiliateProgram?.networks?.[String(chainId)]
  if (!n || !((n.startingHeight ?? 0) > 0)) return false
  if (height === undefined || height < BigInt(n.startingHeight!)) return false
  if (tokenStandard === 'zts1znnxxxxxxxxxxxxx9z4ulx') return n.wZNN === true
  if (tokenStandard === 'zts1qsrxxxxxxxxxxxxxmrhjll') return n.wQSR === true
  return false
}
