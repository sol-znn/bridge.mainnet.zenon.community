<script setup lang="ts">
// The liquidity program, in its three steps:
//   1. add wZNN and ETH to the Uniswap V2 pool on Ethereum, for LP tokens;
//   2. bridge the LP token to Zenon (an unwrap, on the Bridge view);
//   3. stake it in Zenon's liquidity contract for 1 to 12 months, weighted 1x
//      to 12x, then revoke after expiry and collect rewards.
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { Plus, ArrowRight, Loader2, Lock, Unlock, Coins, SlidersHorizontal } from '@lucide/vue'
import TokenIcon from '../components/TokenIcon.vue'
import Amount from '../components/Amount.vue'
import StatusChip from '../components/StatusChip.vue'
import Terms from '../components/Terms.vue'
import { bridge, routeByZts, nodeContext, READ_TTL_MS } from '../state/bridge.ts'
import { api, node, syrius, sendBlock, connectSyrius, onBuildChain, wrongZenonChain, nodeIsCurrent } from '../state/zenon.ts'
import { evm, ensureChain, walletForReads } from '../state/evm.ts'
import { go, bridgePrefill } from '../state/router.ts'
import { accepted } from '../state/ack.ts'
import { toast, toastError } from '../state/toasts.ts'
import { readClient, writeClient } from '../evm/client.ts'
import { erc20Abi, pairAbi, routerAbi } from '../evm/abi.ts'
import {
  liquidityStakeBlock,
  cancelLiquidityStakeBlock,
  collectRewardBlock,
  MONTH_SECONDS,
  type LiquidityInfo,
  type StakeEntry,
} from '../znn/api.ts'
import { parseUnits, formatUnits, unitsToInput, duration } from '../core/format.ts'
import { config, evmChain, evmTxUrl } from '../config.ts'
import { allPages } from '../core/paging.ts'
import { operations, unresolvedOperation } from '../state/operations.ts'
import { submitTransaction, successfulReceipt, transactionPayload } from '../evm/transactions.ts'
import OperationRecovery from '../components/OperationRecovery.vue'

let mounted = true
const refreshTimers = new Set<ReturnType<typeof setTimeout>>()
onUnmounted(() => { mounted = false; for (const timer of refreshTimers) clearTimeout(timer) })
function refreshLater() {
  const timer = setTimeout(() => { refreshTimers.delete(timer); if (mounted) void loadZenon() }, 25_000)
  refreshTimers.add(timer)
}

const termsOpen = ref(false)
const pendingAction = ref<null | (() => Promise<void>)>(null)
function guarded(fn: () => Promise<void>) {
  if (!accepted.value) {
    pendingAction.value = fn
    termsOpen.value = true
    return
  }
  void fn()
}

// 1. Uniswap V2

// The pool is a mainnet fact; another chain's bridge has none configured here.
const poolChainId = computed(() => (onBuildChain() ? Number(Object.entries(config.evm).find(([, c]) => c.liquidity)?.[0] ?? 0) : 0))
const pool = computed(() => (poolChainId.value ? config.evm[poolChainId.value].liquidity! : null))
const wznn = computed(() => (poolChainId.value ? routeByZts(poolChainId.value, 'zts1znnxxxxxxxxxxxxx9z4ulx') : undefined))
const reserves = ref<{ znn: bigint; eth: bigint; lpSupply: bigint } | null>(null)
const balances = ref<{ znn: bigint; eth: bigint; lp: bigint; allowance: bigint } | null>(null)
const znnText = ref('')
const slippage = ref(1)
const slippageOpen = ref(false)
const adding = ref(false)
const poolError = ref('')
const poolReadAt = ref(0)
let poolRequest = 0
const poolContext = () => JSON.stringify([nodeContext(), poolChainId.value, pool.value, wznn.value?.key, evm.account, evm.chainId, evm.selected?.info.uuid])

async function loadPool() {
  const p = pool.value, selectedChain = poolChainId.value, account = evm.account
  const token = wznn.value?.pair.tokenAddress as `0x${string}` | undefined
  const context = poolContext(), request = ++poolRequest, provider = evm.selected?.provider
  const current = () => mounted && request === poolRequest && context === poolContext() && provider === evm.selected?.provider
  poolReadAt.value = 0
  if (!p || !token || !bridge.loaded) { reserves.value = null; balances.value = null; return }
  const c = readClient(selectedChain, walletForReads())
  try {
    const [r, t0, t1, supply, chain] = await Promise.all([
      c.readContract({ address: p.pair, abi: pairAbi, functionName: 'getReserves' }),
      c.readContract({ address: p.pair, abi: pairAbi, functionName: 'token0' }),
      c.readContract({ address: p.pair, abi: pairAbi, functionName: 'token1' }),
      c.readContract({ address: p.pair, abi: pairAbi, functionName: 'totalSupply' }),
      c.getChainId(),
    ])
    if (chain !== selectedChain || ![t0, t1].some((t) => t.toLowerCase() === token.toLowerCase()) || ![t0, t1].some((t) => t.toLowerCase() === p.weth.toLowerCase()) || t0.toLowerCase() === t1.toLowerCase()) throw new Error('Pool token or network identity does not match')
    if (r[0] <= 0n || r[1] <= 0n || supply <= 0n) throw new Error('Pool reserves are unavailable')
    const znnFirst = t0.toLowerCase() === token.toLowerCase()
    let nextBalances = null
    if (account) {
      const [z, e, lp, a] = await Promise.all([
        c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
        c.getBalance({ address: account }),
        c.readContract({ address: p.pair, abi: pairAbi, functionName: 'balanceOf', args: [account] }),
        c.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, p.router] }),
      ])
      nextBalances = { znn: z, eth: e, lp, allowance: a }
    }
    if (!current()) return
    reserves.value = { znn: znnFirst ? r[0] : r[1], eth: znnFirst ? r[1] : r[0], lpSupply: supply }
    balances.value = nextBalances
    poolReadAt.value = Date.now()
    poolError.value = ''
  } catch {
    if (current()) poolError.value = 'Pool data is unavailable. Refresh before adding liquidity.'
  }
}

const znnAmount = computed(() => parseUnits(znnText.value, wznn.value?.evm?.decimals ?? 8))
const ethAmount = computed(() => {
  const r = reserves.value
  if (!r || !znnAmount.value || !r.znn) return 0n
  return (znnAmount.value * r.eth) / r.znn
})
const lpOut = computed(() => {
  const r = reserves.value
  if (!r || !znnAmount.value || !r.znn) return 0n
  return (znnAmount.value * r.lpSupply) / r.znn
})
const needsApprove = computed(() => !!balances.value && !!znnAmount.value && balances.value.allowance < znnAmount.value)
const addBlocker = computed(() => {
  if (!evm.account) return 'Connect EVM wallet'
  if (evm.chainId !== poolChainId.value) return `Switch to ${evmChain(poolChainId.value).name}`
  if (operations.error) return 'Operation storage unavailable'
  if (unresolvedOperation('evm', poolChainId.value, evm.account)) return 'Reconcile original operation'
  if (!pool.value || !wznn.value || !bridge.loaded || !balances.value || !reserves.value || !poolReadAt.value || poolError.value || Date.now() - poolReadAt.value > READ_TTL_MS) return 'Pool data unavailable'
  if (!znnAmount.value) return 'Enter an amount'
  if (!ethAmount.value || !lpOut.value) return 'Amount too small'
  if (balances.value && znnAmount.value > balances.value.znn) return 'Not enough wZNN'
  if (balances.value && ethAmount.value > balances.value.eth) return 'Not enough ETH'
  return ''
})

async function addLiquidity() {
  const b = addBlocker.value
  if (b === 'Connect EVM wallet') return void (evm.pickerOpen = true)
  if (b.startsWith('Switch')) return void ensureChain(poolChainId.value).catch(toastError)
  if (b) return
  const p = pool.value!
  const token = wznn.value!.pair.tokenAddress as `0x${string}`
  const account = evm.account!, provider = evm.selected!.provider, chainId = poolChainId.value, context = poolContext()
  const amount = znnAmount.value!, ether = ethAmount.value, keep = BigInt(Math.round((100 - slippage.value) * 100)), approval = needsApprove.value
  const guard = () => {
    if (!mounted || context !== poolContext() || provider !== evm.selected?.provider || !bridge.loaded || Date.now() - poolReadAt.value > READ_TTL_MS) throw new Error('Pool or wallet changed before submission')
  }
  adding.value = true
  try {
    const w = writeClient(chainId, provider, account)
    const reader = readClient(chainId, { provider, chainId })
    const lpBefore = await reader.readContract({ address: p.pair, abi: pairAbi, functionName: 'balanceOf', args: [account] })
    guard()
    if (approval) {
      const args = [p.router, amount] as const
      const h = await submitTransaction({ chainId, account, kind: 'liquidity-approval', payload: transactionPayload(token, erc20Abi, 'approve', args) }, guard,
        () => w.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args, chain: w.chain, account }))
      toast('Approval sent', 'wait')
      await successfulReceipt(reader, chainId, h)
      const allowance = await reader.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, p.router] })
      if (allowance < amount) throw new Error('Approval receipt succeeded but allowance is insufficient')
    }
    // Deadline: latest block time + 90 s, as the original.
    const block = await reader.getBlock()
    const args = [token, amount, (amount * keep) / 10000n, (ether * keep) / 10000n, account, block.timestamp + 90n] as const
    guard()
    const hash = await submitTransaction({ chainId, account, kind: 'add-liquidity', payload: transactionPayload(p.router, routerAbi, 'addLiquidityETH', args, ether) }, guard, () => w.writeContract({
      address: p.router,
      abi: routerAbi,
      functionName: 'addLiquidityETH',
      args,
      value: ether,
      chain: w.chain,
      account,
    }))
    const url = evmTxUrl(chainId, hash)
    toast('Liquidity sent', 'wait', url ? { href: url, label: 'View' } : undefined)
    await successfulReceipt(reader, chainId, hash)
    const lpAfter = await reader.readContract({ address: p.pair, abi: pairAbi, functionName: 'balanceOf', args: [account] })
    if (lpAfter <= lpBefore) throw new Error('Receipt succeeded but LP balance increase is not established. Check the original transaction.')
    toast('LP tokens received. Bridge them to Zenon next.', 'ok')
    if (mounted && context === poolContext()) { znnText.value = ''; await loadPool() }
  } catch (err) {
    toastError(err)
  } finally {
    adding.value = false
  }
}

function bridgeLp() {
  const lp = bridge.routes.find((r) => r.chainId === poolChainId.value && pool.value && r.pair.tokenAddress.toLowerCase() === pool.value.pair.toLowerCase())
  if (lp) bridgePrefill.value = { dir: 'unwrap', chainId: lp.chainId, zts: lp.pair.tokenStandard }
  go('bridge')
}

// 2 and 3. Zenon liquidity contract

const info = ref<LiquidityInfo | null>(null)
const stakes = ref<StakeEntry[]>([])
const reward = ref<{ znn: bigint; qsr: bigint } | null>(null)
const lpBalances = ref<Record<string, bigint>>({})
const stakeZts = ref('')
const stakeText = ref('')
const months = ref(12)
const busy = ref<Record<string, boolean>>({})
const zenonError = ref('')
const zenonReadAt = ref(0)
let zenonRequest = 0
const zenonContext = () => JSON.stringify([nodeContext(), syrius.address, syrius.chainId])

async function loadZenon() {
  const a = api.value, account = syrius.address, context = zenonContext(), request = ++zenonRequest
  const current = () => mounted && request === zenonRequest && a === api.value && context === zenonContext()
  zenonReadAt.value = 0
  try {
    const nextInfo = await a.liquidityInfo()
    if (account) {
      const [s, r, b] = await Promise.all([allPages((index, size) => a.stakeEntries(account, index, size), current), a.uncollectedReward(account), a.balances(account)])
      if (!current()) return
      stakes.value = s
      reward.value = r
      lpBalances.value = b
    } else {
      if (!current()) return
      stakes.value = []
      reward.value = null
      lpBalances.value = {}
    }
    info.value = nextInfo
    if (!nextInfo.tokenTuples.some((t) => t.tokenStandard === stakeZts.value)) stakeZts.value = nextInfo.tokenTuples[0]?.tokenStandard ?? ''
    zenonReadAt.value = Date.now()
    zenonError.value = ''
  } catch {
    if (current()) zenonError.value = 'Liquidity program data is unavailable. Refresh before signing.'
  }
}

const tuple = computed(() => info.value?.tokenTuples.find((t) => t.tokenStandard === stakeZts.value))
const lpToken = (zts: string) => bridge.routes.find((r) => r.pair.tokenStandard === zts)?.zts
const stakeDecimals = computed(() => lpToken(stakeZts.value)?.decimals ?? 18)
const stakeAmount = computed(() => parseUnits(stakeText.value, stakeDecimals.value))
const stakeBalance = computed(() => lpBalances.value[stakeZts.value] ?? 0n)
const stakeBlocker = computed(() => {
  if (!syrius.address) return 'Connect Syrius'
  if (wrongZenonChain()) return 'Select the same Zenon network'
  if (operations.error || unresolvedOperation('zenon', node.chainId, syrius.address)) return 'Reconcile original operation'
  if (!info.value || !tuple.value || !lpToken(stakeZts.value) || !zenonReadAt.value || zenonError.value || !nodeIsCurrent() || Date.now() - zenonReadAt.value > READ_TTL_MS) return 'Program data unavailable'
  if (info.value?.isHalted) return 'Program halted'
  if (!info.value.znnReward && !info.value.qsrReward) return 'Rewards are currently zero'
  if (!Number.isInteger(months.value) || months.value < 1 || months.value > 12) return 'Invalid lock duration'
  if (!stakeAmount.value) return 'Enter an amount'
  if (tuple.value && stakeAmount.value < tuple.value.minAmount) return 'Below minimum'
  if (stakeAmount.value > stakeBalance.value) return 'Not enough LP'
  return ''
})

async function stake() {
  if (stakeBlocker.value === 'Connect Syrius') return void connectSyrius().catch(toastError)
  if (stakeBlocker.value) return
  const spec = liquidityStakeBlock(months.value, stakeZts.value, stakeAmount.value!), context = zenonContext()
  const program = () => JSON.stringify(info.value, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
  const selectedProgram = program()
  busy.value.stake = true
  try {
    const hash = await sendBlock(spec, () => { if (context !== zenonContext() || program() !== selectedProgram || !zenonActionReady(true) || !info.value || info.value.isHalted || !info.value.znnReward && !info.value.qsrReward) throw new Error('Staking context changed before submission') })
    toast('Stake submitted; awaiting confirmation', 'wait', { href: config.zenonExplorerTx(hash), label: 'View' })
    if (mounted && context === zenonContext()) { stakeText.value = ''; refreshLater() }
  } catch (err) {
    toastError(err)
  } finally {
    busy.value.stake = false
  }
}

async function cancel(e: StakeEntry) {
  if (!zenonActionReady() || e.revokeTime || node.timestamp < e.expirationTime || !stakes.value.some((s) => s.id === e.id)) return
  const spec = cancelLiquidityStakeBlock(e.id)
  const context = zenonContext()
  busy.value[e.id] = true
  try {
    const hash = await sendBlock(spec, () => { if (context !== zenonContext() || !zenonActionReady(true) || node.timestamp < e.expirationTime) throw new Error('Stake cancellation context changed before submission') })
    toast('Revoke submitted; awaiting confirmation', 'wait', { href: config.zenonExplorerTx(hash), label: 'View' })
    refreshLater()
  } catch (err) {
    toastError(err)
  } finally {
    busy.value[e.id] = false
  }
}

async function collect() {
  if (!zenonActionReady() || !reward.value || !reward.value.znn && !reward.value.qsr) return
  busy.value.collect = true
  const context = zenonContext()
  try {
    const hash = await sendBlock(collectRewardBlock(), () => { if (context !== zenonContext() || !zenonActionReady(true)) throw new Error('Reward collection context changed before submission') })
    toast('Collect submitted; awaiting confirmation', 'wait', { href: config.zenonExplorerTx(hash), label: 'View' })
    refreshLater()
  } catch (err) {
    toastError(err)
  } finally {
    busy.value.collect = false
  }
}

function zenonActionReady(ownJournal = false) {
  return mounted && !!syrius.address && !wrongZenonChain() && nodeIsCurrent() && !!zenonReadAt.value && !zenonError.value && Date.now() - zenonReadAt.value < READ_TTL_MS && !operations.error && (ownJournal || !unresolvedOperation('zenon', node.chainId, syrius.address))
}

const nowS = computed(() => node.timestamp)
function stakeStatus(e: StakeEntry) {
  if (e.revokeTime) return { tone: 'dim' as const, label: 'Revoked' }
  if (!nowS.value || !zenonReadAt.value || zenonError.value) return { tone: 'dim' as const, label: 'Status unavailable' }
  if (nowS.value < e.expirationTime) return { tone: 'wait' as const, label: `Locked ${duration(e.expirationTime - nowS.value)}` }
  return { tone: 'warn' as const, label: 'Unlocked' }
}

onMounted(() => {
  void loadPool()
  void loadZenon()
})
watch([() => evm.account, () => evm.chainId, () => evm.selected?.provider, () => node.epoch, () => bridge.loaded], () => { reserves.value = null; balances.value = null; void loadPool() }, { flush: 'sync' })
watch([() => syrius.address, () => syrius.chainId, () => node.epoch, () => api.value], () => { info.value = null; stakes.value = []; reward.value = null; lpBalances.value = {}; void loadZenon() }, { flush: 'sync' })
watch(
  () => node.tick,
  (t) => t % 6 === 0 && (loadPool(), loadZenon()),
)
</script>

<template>
  <section class="rise grid grid-cols-1 gap-5">
    <OperationRecovery />
    <div>
      <h1 class="text-2xl font-semibold">Liquidity</h1>
      <p class="mt-1 text-soft">Add to the wZNN pool, bridge the LP token to Zenon, stake it for rewards.</p>
    </div>

    <div class="grid gap-4 md:grid-cols-3">
      <!-- Step 1 -->
      <div v-if="pool" class="panel grid min-w-0 grid-cols-1 content-start gap-3 p-4 md:p-5">
        <div class="flex items-center gap-2">
          <span class="step">1</span><h2 class="flex-1 font-semibold">Add liquidity</h2>
          <button class="icon-btn !h-9 !w-9" aria-label="Slippage" :aria-expanded="slippageOpen" @click="slippageOpen = !slippageOpen"><SlidersHorizontal :size="15" /></button>
        </div>
        <div class="text-sm text-dim">Uniswap V2 · {{ evmChain(poolChainId).name }}</div>
        <p v-if="poolError" class="text-sm text-danger">{{ poolError }}</p>
        <div class="well grid grid-cols-1 gap-2 p-3">
          <div class="flex items-center gap-2">
            <input v-model="znnText" :disabled="adding" class="amount mono w-0 min-w-0 flex-1" inputmode="decimal" placeholder="0" aria-label="wZNN amount" />
            <span class="inline-flex items-center gap-2.5"><TokenIcon symbol="wZNN" :chain="evmChain(poolChainId).name" :size="28" />wZNN</span>
          </div>
          <div class="text-xs text-dim">
            Balance <Amount :value="balances?.znn ?? 0n" :decimals="8" />
            <button class="ml-1 text-ok" :disabled="adding || !poolReadAt || !balances" @click="znnText = unitsToInput(balances?.znn ?? 0n, 8)">Max</button>
          </div>
        </div>
        <div class="flex items-center justify-between text-sm">
          <span class="text-dim">With</span>
          <span class="inline-flex items-center gap-1.5"><Amount :value="ethAmount" :decimals="18" symbol="ETH" /></span>
        </div>
        <div class="flex items-center justify-between text-sm">
          <span class="text-dim">LP out</span>
          <Amount :value="lpOut" :decimals="18" :max="10" />
        </div>
        <div v-if="slippageOpen" class="slide-down flex items-center justify-between gap-2 text-sm">
          <span class="text-dim">Slippage</span>
          <span class="inline-flex gap-1">
            <button v-for="s in [0.5, 1, 3]" :key="s" :disabled="adding" class="chip !h-8 !px-3" :class="slippage === s ? 'chip-ok' : 'chip-dim'" @click="slippage = s">{{ s }}%</button>
          </span>
        </div>
        <button class="btn btn-block" :disabled="adding || (!!addBlocker && !addBlocker.startsWith('Switch') && addBlocker !== 'Connect EVM wallet')" @click="guarded(addLiquidity)">
          <Loader2 v-if="adding" :size="15" class="spin" /><Plus v-else :size="15" />
          {{ addBlocker || (needsApprove ? 'Approve and add' : 'Add liquidity') }}
        </button>
        <div v-if="balances?.lp" class="flex items-center justify-between text-sm">
          <span class="text-dim">You hold</span><Amount :value="balances.lp" :decimals="18" :max="10" symbol="LP" />
        </div>
        <a :href="pool.info" target="_blank" rel="noopener" class="text-sm text-dim hover:text-fg">Pool on Uniswap</a>
      </div>

      <!-- Step 2 -->
      <div class="panel grid min-w-0 grid-cols-1 content-start gap-3 p-4 md:p-5">
        <div class="flex items-center gap-2"><span class="step">2</span><h2 class="font-semibold">Bridge LP</h2></div>
        <p class="text-sm text-soft">Unwrap the LP token to Zenon, then redeem it from Activity.</p>
        <button class="btn btn-block" @click="bridgeLp">Open bridge<ArrowRight :size="15" /></button>
      </div>

      <!-- Step 3 -->
      <div class="panel grid min-w-0 grid-cols-1 content-start gap-3 p-4 md:p-5">
        <div class="flex items-center gap-2"><span class="step">3</span><h2 class="font-semibold">Stake on Zenon</h2></div>
        <div v-if="info && info.tokenTuples.length > 1" class="flex flex-wrap gap-1">
          <button v-for="t in info.tokenTuples" :key="t.tokenStandard" :disabled="busy.stake" class="chip !h-8 !px-3" :class="stakeZts === t.tokenStandard ? 'chip-ok' : 'chip-dim'" @click="stakeZts = t.tokenStandard">
            {{ lpToken(t.tokenStandard)?.symbol ?? t.tokenStandard.slice(0, 8) }}
          </button>
        </div>
        <div class="well grid grid-cols-1 gap-2 p-3">
          <div class="flex items-center gap-2">
            <input v-model="stakeText" :disabled="busy.stake" class="amount mono w-0 min-w-0 flex-1" inputmode="decimal" placeholder="0" aria-label="LP amount" />
            <span class="inline-flex items-center gap-2.5 text-sm"><TokenIcon :symbol="lpToken(stakeZts)?.symbol ?? 'LP'" chain="Zenon" :size="28" />{{ lpToken(stakeZts)?.symbol ?? 'LP' }}</span>
          </div>
          <div class="text-xs text-dim">
            Balance <Amount :value="stakeBalance" :decimals="stakeDecimals" :max="10" />
            <button class="ml-1 text-ok" :disabled="busy.stake || !zenonReadAt" @click="stakeText = unitsToInput(stakeBalance, stakeDecimals)">Max</button>
          </div>
        </div>
        <div>
          <div class="mb-1 flex justify-between text-sm"><span class="text-dim">Lock</span><span class="mono">{{ months }} mo · {{ months }}x</span></div>
          <input v-model.number="months" :disabled="busy.stake" type="range" min="1" max="12" step="1" class="w-full accent-[var(--znn)]" aria-label="Months" />
        </div>
        <button class="btn btn-plasma btn-block" :disabled="busy.stake || (!!stakeBlocker && stakeBlocker !== 'Connect Syrius')" @click="guarded(stake)">
          <Loader2 v-if="busy.stake" :size="15" class="spin" /><Lock v-else :size="15" />
          {{ stakeBlocker || 'Stake' }}
        </button>
        <div v-if="info" class="text-xs text-dim">
          Rewards per epoch: <Amount :value="info.znnReward" :decimals="8" symbol="ZNN" />, <Amount :value="info.qsrReward" :decimals="8" symbol="QSR" />
        </div>
        <p v-if="info && !info.znnReward && !info.qsrReward" class="text-sm text-warn">Rewards are currently zero. New stakes are paused in this interface.</p>
        <p v-if="zenonError" class="text-sm text-danger">{{ zenonError }}</p>
      </div>
    </div>

    <div class="panel p-4 md:p-5">
      <div class="mb-3 flex flex-wrap items-center gap-3">
        <h2 class="font-semibold">Your stakes</h2>
        <div class="flex-1" />
        <span v-if="reward" class="text-sm text-soft">
          Uncollected <Amount :value="reward.znn" :decimals="8" symbol="ZNN" /> · <Amount :value="reward.qsr" :decimals="8" symbol="QSR" />
        </span>
        <button class="btn btn-sm" :disabled="!zenonActionReady() || !reward || (!reward.znn && !reward.qsr) || busy.collect" @click="guarded(collect)">
          <Loader2 v-if="busy.collect" :size="14" class="spin" /><Coins v-else :size="14" />Collect
        </button>
      </div>
      <p v-if="!syrius.address" class="text-soft">Connect Syrius to see your stakes.</p>
      <p v-else-if="zenonError || !zenonReadAt" class="text-soft">Stake history is unavailable or being refreshed.</p>
      <p v-else-if="!stakes.length" class="text-soft">None yet</p>
      <div v-else class="grid gap-2">
        <div v-for="e in stakes" :key="e.id" class="flex flex-wrap items-center gap-3 border-t border-line pt-2 text-sm first:border-0 first:pt-0">
          <Amount :value="e.amount" :decimals="lpToken(e.tokenStandard)?.decimals ?? 18" :max="10" :symbol="lpToken(e.tokenStandard)?.symbol" />
          <span class="text-dim">{{ Math.round((e.expirationTime - e.startTime) / MONTH_SECONDS) }} mo · weight {{ formatUnits(e.weightedAmount * 100n / (e.amount || 1n), 2) }}x</span>
          <div class="flex-1" />
          <StatusChip v-bind="stakeStatus(e)" />
          <button v-if="stakeStatus(e).label === 'Unlocked'" class="btn btn-sm" :disabled="!zenonActionReady() || busy[e.id]" @click="guarded(() => cancel(e))">
            <Loader2 v-if="busy[e.id]" :size="14" class="spin" /><Unlock v-else :size="14" />Revoke
          </button>
        </div>
      </div>
    </div>

    <Terms :open="termsOpen" @close="termsOpen = false" @accepted="((termsOpen = false), pendingAction && pendingAction())" />
  </section>
</template>

<style scoped>
.step {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 999px;
  background: var(--raised);
  border: 1px solid var(--line-strong);
  font-family: var(--font-mono);
  font-size: 12px;
}
.amount {
  background: transparent;
  border: 0;
  outline: none;
  font-size: 22px;
  color: var(--fg);
}
.amount::placeholder {
  color: var(--dim);
}
</style>
