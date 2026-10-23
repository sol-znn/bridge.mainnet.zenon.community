// The bridge, end to end, on the lab: go-zenon with the bridge contract live,
// HyperCore's bridge.sol on anvil, and a test orchestrator between them.
//
// Every block and transaction the user would sign is built by the app's own
// code (src/znn/api.ts builders, src/core/status.ts, src/core/referral.ts,
// src/evm/abi.ts), and every state the UI shows is computed by the app's own
// functions from what the chains answer. The test keys stand in for Syrius
// and the EVM wallet. ui.e2e.test.ts drives the page itself.
//
// Needs `e2e/lab/lab.sh up`. Momentums take ~15 s on Docker Desktop, so the
// whole file takes several minutes.

import { beforeAll, afterAll, describe, expect, it } from 'vitest'
import { setup, PARAMS, type Deployment } from './setup.ts'
import { TestOrchestrator } from './orchestrator.ts'
import {
  EVM_CHAIN_ID,
  NETWORK_CLASS,
  anvil,
  evmPublic,
  evmUser,
  evmUserWallet,
  mine,
  evmClock,
  receiveAll,
  send,
  drainPublications,
  until,
  zAdmin,
  zapi,
  height,
  DEV_MNEMONIC,
} from './lib/lab.ts'
import { Account } from './lib/wallet.ts'
import { wrapTokenBlock, redeemBlock } from '../src/znn/api.ts'
import { ZNN_ZTS } from '../src/znn/primitives.ts'
import { bridgeAbi, erc20Abi } from '../src/evm/abi.ts'
import { wrapFee, unwrapReceive } from '../src/core/fees.ts'
import { wrapStatus, unwrapStatus, evmSignature, isAffiliateEntry, AFFILIATE_LOG_INDEX, wrapStateFromRevert } from '../src/core/status.ts'
import { recipientString } from '../src/core/referral.ts'
import { assessHealth } from '../src/core/orchestrators.ts'

let d: Deployment
let orchestrator: TestOrchestrator
// An index no lab node holds: a pillar's own address receives incoming blocks by
// itself, and the test wants to see the bonus arrive.
const referrer = Account.fromMnemonic(DEV_MNEMONIC, 50).address

const balanceOf = (who: `0x${string}`) => evmPublic.readContract({ address: d.token, abi: erc20Abi, functionName: 'balanceOf', args: [who] })
const znnBalance = async (who: string) => (await zapi.balances(who))[ZNN_ZTS] ?? 0n

/** The wrap's status exactly as state/activity.ts computes it. */
async function statusOfWrap(id: string) {
  const w = (await zapi.wrapById(id))!
  const [[redeemBlockNumber], evmBlock, info] = await Promise.all([
    evmPublic.readContract({ address: d.bridge, abi: bridgeAbi, functionName: 'redeemsInfo', args: [BigInt('0x' + id)] }),
    // viem caches the block number for a few seconds; the test mines in between.
    evmPublic.getBlockNumber({ cacheTime: 0 }),
    evmPublic.readContract({ address: d.bridge, abi: bridgeAbi, functionName: 'tokensInfo', args: [d.token] }),
  ])
  return wrapStatus({
    signature: w.signature,
    confirmationsToFinality: w.confirmationsToFinality,
    momentumSeconds: 10,
    redeemBlock: w.signature ? redeemBlockNumber : null,
    evmBlock,
    redeemDelay: info[1],
    evmBlockSeconds: 1,
  })
}

beforeAll(async () => {
  d = await setup()
  await evmClock(0)
  orchestrator = new TestOrchestrator({ bridge: d.bridge, evmConfirmations: Number(PARAMS.evm.confirmations), affiliate: true, log: console.log })
})

afterAll(async () => {
  try { await orchestrator?.stop(); await drainPublications() }
  finally { await evmClock(1) }
})

describe('setup', () => {
  it('shows the app one network and one pair, as it reads mainnet', async () => {
    const nets = await zapi.networks()
    const net = nets.find((n) => n.chainId === EVM_CHAIN_ID)!
    expect(net.networkClass).toBe(NETWORK_CLASS)
    expect(net.contractAddress).toBe(d.bridge.toLowerCase())
    const pair = net.tokenPairs.find((p) => p.tokenStandard === ZNN_ZTS)!
    expect(pair).toMatchObject({ tokenAddress: d.token.toLowerCase(), bridgeable: true, redeemable: true, owned: false, feePercentage: 300, minAmount: PARAMS.minAmount })
    const info = await zapi.bridgeInfo()
    expect(info.halted).toBe(false)
    expect(info.compressedTssECDSAPubKey).not.toBe('')
  })

  it('has the EVM bridge the app expects: tokensInfo, tss, not halted', async () => {
    const info = await evmPublic.readContract({ address: d.bridge, abi: bridgeAbi, functionName: 'tokensInfo', args: [d.token] })
    expect(info).toEqual([PARAMS.minAmount, BigInt(PARAMS.evmRedeemDelay), true, true, true])
    expect((await evmPublic.readContract({ address: d.bridge, abi: bridgeAbi, functionName: 'tss' })).toLowerCase()).toBe(d.tss)
    expect(await evmPublic.readContract({ address: d.bridge, abi: bridgeAbi, functionName: 'isHalted' })).toBe(false)
  })
})

describe('wrap: Zenon to EVM', () => {
  const amount = 5_00000000n // 5 ZNN
  let id = ''
  let before = 0n

  it('sends WrapToken and the request appears under its block hash', async () => {
    before = await balanceOf(evmUser.address)
    const zBefore = await znnBalance(zAdmin.address)
    id = await send(wrapTokenBlock({ networkClass: NETWORK_CLASS, chainId: EVM_CHAIN_ID, toAddress: evmUser.address, tokenStandard: ZNN_ZTS, amount }))
    const w = await until('the wrap request', () => zapi.wrapById(id))
    expect(w.toAddress).toBe(evmUser.address.toLowerCase())
    expect(w.amount).toBe(amount)
    expect(w.fee).toBe(wrapFee(amount, d.feePercentage))
    expect(w.signature).toBe('')
    expect(await znnBalance(zAdmin.address)).toBe(zBefore - amount)
    // History by recipient, as the Activity view reads it.
    expect((await zapi.wrapsTo(evmUser.address.toLowerCase())).list.some((x) => x.id === id)).toBe(true)
    expect(['confirming', 'signing']).toContain((await statusOfWrap(id)).state)
  })

  it('is listed as unsigned until an orchestrator signs it', async () => {
    await until('finality', async () => (await zapi.wrapById(id))!.confirmationsToFinality === 0)
    expect((await zapi.unsignedWraps()).list.some((w) => w.id === id)).toBe(true)
    expect((await statusOfWrap(id)).state).toBe('signing')
    orchestrator.start()
    await until('the signature', async () => (await zapi.wrapById(id))!.signature)
    expect((await zapi.unsignedWraps()).list.some((w) => w.id === id)).toBe(false)
    expect(await statusOfWrap(id)).toMatchObject({ state: 'redeem', step: '1/2' })
  })

  it('redeems on EVM in two calls separated by the delay', async () => {
    const w = (await zapi.wrapById(id))!
    const args = [w.toAddress as `0x${string}`, w.tokenAddress as `0x${string}`, w.amount - w.fee, BigInt('0x' + w.id), evmSignature(w.signature)] as const
    const redeem = async () => {
      const hash = await evmUserWallet.writeContract({ address: d.bridge, abi: bridgeAbi, functionName: 'redeem', args, chain: anvil, account: evmUser })
      return evmPublic.waitForTransactionReceipt({ hash })
    }
    expect((await redeem()).status).toBe('success')
    expect(await statusOfWrap(id)).toMatchObject({ state: 'delay', step: '2/2' })
    expect(await balanceOf(evmUser.address)).toBe(before)

    // Too early: bridge.sol says so, and the app maps the reason.
    const early = await evmPublic.simulateContract({ address: d.bridge, abi: bridgeAbi, functionName: 'redeem', args, account: evmUser }).then(
      () => '',
      (e: Error) => e.message,
    )
    expect(wrapStateFromRevert(early)).toBe('delay')

    // The app's rule matches the contract to the block: one short is refused.
    await mine(d.evmRedeemDelay - 1)
    expect((await statusOfWrap(id)).state).toBe('delay')
    await mine(1)
    expect((await statusOfWrap(id)).state).toBe('finish')
    expect((await redeem()).status).toBe('success')
    expect((await statusOfWrap(id)).state).toBe('done')
    expect(await balanceOf(evmUser.address)).toBe(before + amount - wrapFee(amount, d.feePercentage))

    const again = await evmPublic.simulateContract({ address: d.bridge, abi: bridgeAbi, functionName: 'redeem', args, account: evmUser }).then(
      () => '',
      (e: Error) => e.message,
    )
    expect(wrapStateFromRevert(again)).toBe('done')
  })
})

describe('unwrap: EVM to Zenon, through a referral link', () => {
  const amount = 1_00000000n // 1 wZNN
  let tx: `0x${string}`
  let logIndex = 0

  it('approves and unwraps to "recipient&referrer"', async () => {
    const approve = await evmUserWallet.writeContract({ address: d.token, abi: erc20Abi, functionName: 'approve', args: [d.bridge, amount], chain: anvil, account: evmUser })
    await evmPublic.waitForTransactionReceipt({ hash: approve })
    const before = await balanceOf(evmUser.address)
    const to = recipientString(zAdmin.address, referrer)
    expect(to).toBe(`${zAdmin.address}&${referrer}`)
    tx = await evmUserWallet.writeContract({ address: d.bridge, abi: bridgeAbi, functionName: 'unwrap', args: [d.token, amount, to], chain: anvil, account: evmUser })
    const receipt = await evmPublic.waitForTransactionReceipt({ hash: tx })
    expect(receipt.status).toBe('success')
    logIndex = receipt.logs.find((l) => l.address.toLowerCase() === d.bridge.toLowerCase())!.logIndex
    // Owned on EVM: the bridge burned them.
    expect(await balanceOf(evmUser.address)).toBe(before - amount)
  })

  it('is registered on Zenon with the 1% bonus, and the referrer gets 2%', async () => {
    await mine(Number(PARAMS.evm.confirmations) + 1)
    const u = await until('the unwrap request', () => zapi.unwrapByHashAndLog(tx, logIndex))
    expect(u.toAddress).toBe(zAdmin.address)
    expect(u.amount).toBe(unwrapReceive(amount, true))
    expect(u.signature).not.toBe('')
    expect(isAffiliateEntry(u.logIndex)).toBe(false)

    const bonus = await until('the referrer entry', () => zapi.unwrapByHashAndLog(tx, logIndex + AFFILIATE_LOG_INDEX))
    expect(bonus.toAddress).toBe(referrer)
    expect(bonus.amount).toBe((amount * 2n) / 100n)
    expect(isAffiliateEntry(bonus.logIndex)).toBe(true)

    // History by recipient, as the Activity and Affiliate views read it.
    expect((await zapi.unwrapsTo(zAdmin.address)).list.some((x) => x.transactionHash === tx.slice(2) && x.logIndex === logIndex)).toBe(true)
    // This run's entry; the chain keeps earlier runs' too.
    const earned = (await zapi.unwrapsTo(referrer)).list.filter((x) => isAffiliateEntry(x.logIndex))
    expect(earned.some((x) => x.transactionHash === tx.slice(2))).toBe(true)
  })

  it('waits redeemDelay momentums, then redeems on Zenon', async () => {
    const ready = await until('the redeem delay', async () => {
      const u = (await zapi.unwrapByHashAndLog(tx, logIndex))!
      const s = unwrapStatus({ ...u, momentumSeconds: 10 })
      return s.state === 'redeem' ? u : null
    })
    expect(ready.redeemableIn).toBe(0)

    await receiveAll()
    const before = await znnBalance(zAdmin.address)
    await send(redeemBlock(tx, logIndex))
    const done = await until('redeemed', async () => {
      const u = (await zapi.unwrapByHashAndLog(tx, logIndex))!
      return u.redeemed ? u : null
    })
    expect(unwrapStatus({ ...done, momentumSeconds: 10 }).state).toBe('done')
    await until('the ZNN to arrive', async () => (await receiveAll()) > 0)
    expect(await znnBalance(zAdmin.address)).toBe(before + unwrapReceive(amount, true))
  })

  it('lets anyone redeem the referrer entry, to the referrer', async () => {
    await send(redeemBlock(tx, logIndex + AFFILIATE_LOG_INDEX))
    await until('the bonus redeemed', async () => (await zapi.unwrapByHashAndLog(tx, logIndex + AFFILIATE_LOG_INDEX))!.redeemed)
    // The ZNN reaches the referrer as a block waiting to be received, a
    // momentum or so after the request is flagged.
    const arrived = await until('the bonus to arrive', async () => {
      const waiting = await zapi.c.call<{ list: Array<{ amount: string }> | null }>('ledger.getUnreceivedBlocksByAddress', [referrer, 0, 10])
      const amounts = (waiting.list ?? []).map((b) => BigInt(b.amount))
      return amounts.includes((amount * 2n) / 100n) ? amounts : null
    })
    expect(arrived).toContain((amount * 2n) / 100n)
  })
})

describe('orchestrator status, as the Stats page derives it', () => {
  const read = async (momentumSeconds = 10) => {
    const [info, unsigned, blocks, pillars, h] = await Promise.all([zapi.bridgeInfo(), zapi.unsignedWraps(), zapi.bridgeBlocks(3), zapi.pillarsByProducer(), height()])
    return assessHealth({
      now: Date.now() / 1000,
      frontierHeight: h,
      momentumSeconds,
      halted: info.halted,
      allowKeyGen: info.allowKeyGen,
      unsigned: unsigned.list.map((w) => ({
        id: w.id,
        creationMomentumHeight: w.creationMomentumHeight,
        confirmationsToFinality: w.confirmationsToFinality,
        amount: w.amount.toString(),
        symbol: w.token?.symbol ?? '',
        decimals: w.token?.decimals ?? 8,
        chainId: w.chainId,
      })),
      blocks,
      pillarsByProducer: pillars,
    })
  }

  it('is online while the orchestrator signs, and names who signed', async () => {
    const h = await read()
    expect(h.state).toBe('online')
    const me = h.orchestrators.find((o) => o.producer === zAdmin.address)!
    expect(me.signs).toBeGreaterThanOrEqual(1)
    expect(me.unwraps).toBeGreaterThanOrEqual(2)
    expect(h.lastAction?.producer).toBe(zAdmin.address)
  })

  it('goes stalled when a wrap past finality stays unsigned', async () => {
    await orchestrator.stop()
    const id = await send(wrapTokenBlock({ networkClass: NETWORK_CLASS, chainId: EVM_CHAIN_ID, toAddress: evmUser.address, tokenStandard: ZNN_ZTS, amount: 1_00000000n }))
    await until('finality', async () => (await zapi.wrapById(id))?.confirmationsToFinality === 0)
    const soon = await read()
    expect(soon.waiting.map((w) => w.id)).toContain(id)
    expect(soon.state).toBe('online')
    // The same chain state read as if each momentum were a day: the wait is
    // now far past six hours, which is what mainnet looks like today.
    const late = await read(86_400)
    expect(late.state).toBe('down')
    expect(late.message).toMatch(/not signing/)

    // Back online once it is signed.
    orchestrator.start()
    await until('the late signature', async () => (await zapi.wrapById(id))!.signature)
    expect((await read(86_400)).state).toBe('online')
  })
})
