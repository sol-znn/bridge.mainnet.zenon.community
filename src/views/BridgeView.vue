<script setup lang="ts">
// Move a token between Zenon and an EVM network.
//
// Wrap (Zenon to EVM) is one Syrius send to the bridge contract; the EVM
// redeem happens later, from Activity. Unwrap (EVM to Zenon) is an ERC-20
// approve, if the allowance is short, then `unwrap` on the EVM bridge; the
// Zenon redeem happens later, from Activity.
//
// Swap (EVM to EVM, one chain or two) does not use the bridge at all: a
// router quotes a route through a DEX or a third-party bridge and the wallet
// sends one transaction (src/core/swap.ts). It needs an EVM wallet only, and
// it works while the orchestrators are not signing.
//
// A toggle at the top picks which of the two the form does. Bridge, the
// default, offers only Zenon to EVM and back; Swap offers only EVM assets.
import { computed, onUnmounted, ref, watch } from 'vue'
import { ArrowDownUp, ChevronDown, Clock, Fuel, Gift, Plus, Loader2, SlidersHorizontal, Zap } from '@lucide/vue'
import TokenIcon from '../components/TokenIcon.vue'
import Amount from '../components/Amount.vue'
import Modal from '../components/Modal.vue'
import Terms from '../components/Terms.vue'
import { bridge, transferBlocker, nodeContext, type Route } from '../state/bridge.ts'
import { api, node, syrius, sendBlock, connectSyrius, wrongZenonChain, onBuildChain } from '../state/zenon.ts'
import { evm, ensureChain, walletForReads } from '../state/evm.ts'
import { referrer } from '../state/referral.ts'
import { remember } from '../state/activity.ts'
import { accepted } from '../state/ack.ts'
import { go, bridgePrefill } from '../state/router.ts'
import { mode, checkSwap, type Mode } from '../state/swap.ts'
import { toast, toastError } from '../state/toasts.ts'
import { readClient, writeClient } from '../evm/client.ts'
import { bridgeAbi, erc20Abi } from '../evm/abi.ts'
import { wrapTokenBlock, affiliateActive } from '../znn/api.ts'
import { isUserAddress } from '../znn/primitives.ts'
import { isEvmRecipient } from '../core/recipient.ts'
import { operations, unresolvedOperation } from '../state/operations.ts'
import { submitTransaction, successfulReceipt, transactionPayload } from '../evm/transactions.ts'
import { parseUnits, unitsToInput, duration, formatUnits, formatUsd, shorten } from '../core/format.ts'
import { wrapFee, wrapReceive, unwrapReceive, wrapEstimate, unwrapEstimate, LOW_PLASMA } from '../core/fees.ts'
import { usableReferrer, recipientString } from '../core/referral.ts'
import { requestPlasma, canRequest } from '../core/plasmaBot.ts'
import { NATIVE, assetKey, fetchPrice, fetchQuote, fetchStatus, isNative, sameAsset, swapEstimate, usdValue, type Provider, type Quote, type SwapAsset } from '../core/swap.ts'
import { watchAsset } from '../wallet/eip6963.ts'
import { config, evmChain, evmTxUrl } from '../config.ts'

type Dir = 'wrap' | 'unwrap' | 'swap'
const dir = ref<Dir>('wrap')
let mounted = true
onUnmounted(() => { mounted = false; balanceRequest++; recipientRequest++; quoteSeq++; clearTimeout(quoteTimer) })
const chainId = ref<number | null>(null)
const routeKey = ref<string>('')
const swapFrom = ref<SwapAsset | null>(null)
const swapTo = ref<SwapAsset | null>(null)
const amountText = ref('')
const recipientText = ref('')
const editingRecipient = ref(false)
const picker = ref<'from' | 'to' | null>(null)
const advanced = ref(false)
const details = ref(false)
const termsOpen = ref(false)
const sending = ref(false)
const approving = ref(false)

// Opened from another view on a given route.
const prefill = bridgePrefill.value
bridgePrefill.value = null
if (prefill) {
  dir.value = prefill.dir
  chainId.value = prefill.chainId
}
watch(
  () => bridge.routes.length,
  () => {
    if (!prefill) return
    const r = bridge.routes.find((x) => x.chainId === prefill.chainId && x.pair.tokenStandard === prefill.zts)
    if (r) routeKey.value = r.key
  },
  { immediate: true },
)

const chains = computed(() => [...new Set(bridge.routes.map((r) => r.chainId))])
watch(
  chains,
  (list) => {
    if (!chainId.value || !list.includes(chainId.value)) chainId.value = list[0] ?? null
  },
  { immediate: true },
)

const routes = computed(() =>
  bridge.routes.filter((r) => r.chainId === chainId.value && (dir.value === 'wrap' ? r.canWrap : r.canUnwrap)),
)
watch(
  routes,
  (list) => {
    if (!list.some((r) => r.key === routeKey.value)) routeKey.value = list[0]?.key ?? ''
  },
  { immediate: true },
)
const route = computed<Route | undefined>(() => routes.value.find((r) => r.key === routeKey.value))

// What the router can swap: the bridge's own tokens on each chain, and the chain's coin.
const swapAssets = computed<SwapAsset[]>(() => {
  const out: SwapAsset[] = []
  for (const id of config.swap?.chains ?? []) {
    const c = config.evm[id]
    if (!c) continue
    for (const r of bridge.routes) {
      if (r.chainId !== id || !r.evm) continue
      // A pool share has no market to route through.
      if (r.pair.tokenAddress.toLowerCase() === c.liquidity?.pair.toLowerCase() || /LP$|-V2$/i.test(r.evm.symbol)) continue
      out.push({ chainId: id, address: r.pair.tokenAddress, symbol: r.evm.symbol, decimals: r.evm.decimals })
    }
    out.push({ chainId: id, address: NATIVE, symbol: c.nativeSymbol, decimals: 18 })
  }
  return out
})
function setBridge(d: 'wrap' | 'unwrap', r: Route) {
  dir.value = d
  chainId.value = r.chainId
  routeKey.value = r.key
}
function setSwap(from: SwapAsset, to: SwapAsset) {
  swapFrom.value = from
  swapTo.value = to
  chainId.value = from.chainId
  dir.value = 'swap'
}
/** Where a new source goes first: the destination already chosen, or the first other asset on its chain. */
function defaultSwapTarget(from: SwapAsset): SwapAsset | undefined {
  if (swapTo.value && !sameAsset(swapTo.value, from)) return swapTo.value
  return swapAssets.value.find((a) => a.chainId === from.chainId && !sameAsset(a, from)) ?? swapAssets.value.find((a) => !sameAsset(a, from))
}

// Each side is picked on its own. An option is one asset on one chain;
// choosing it sets the transfer. The first route stays the default pair, so
// the form is never empty.
interface Option {
  id: string
  symbol: string
  network: string
  active: boolean
  apply: () => void
}
const zenonSources = computed<Option[]>(() => {
  const seen = new Set<string>()
  const out: Option[] = []
  for (const r of bridge.routes) {
    if (!r.canWrap || seen.has(r.pair.tokenStandard)) continue
    seen.add(r.pair.tokenStandard)
    // Stay on the chosen chain when it carries this token.
    const same = bridge.routes.find((x) => x.canWrap && x.pair.tokenStandard === r.pair.tokenStandard && x.chainId === chainId.value)
    out.push({
      id: r.pair.tokenStandard,
      symbol: r.zts?.symbol ?? '',
      network: 'Zenon',
      active: dir.value === 'wrap' && route.value?.pair.tokenStandard === r.pair.tokenStandard,
      apply: () => setBridge('wrap', same ?? r),
    })
  }
  return out
})
const unwrapSources = computed<Option[]>(() =>
  bridge.routes
    .filter((r) => r.canUnwrap)
    .map((r) => ({
      id: r.key,
      symbol: r.evm?.symbol ?? '',
      network: r.networkName,
      active: dir.value === 'unwrap' && r.key === routeKey.value,
      apply: () => setBridge('unwrap', r),
    })),
)
const swapSources = computed<Option[]>(() => {
  const out: Option[] = []
  for (const a of swapAssets.value) {
    const to = defaultSwapTarget(a)
    if (to) out.push({ id: assetKey(a), symbol: a.symbol, network: evmChain(a.chainId).name, active: sameAsset(swapFrom.value, a), apply: () => setSwap(a, to) })
  }
  return out
})
// There are few enough assets that each side lists all it can take, with no filter.
const options = computed<Option[]>(() => {
  if (dir.value === 'swap') {
    if (picker.value === 'from') return swapSources.value
    const src = swapFrom.value
    return swapAssets.value
      .filter((a) => !sameAsset(a, src))
      .map((a) => ({ id: assetKey(a), symbol: a.symbol, network: evmChain(a.chainId).name, active: sameAsset(swapTo.value, a), apply: () => src && setSwap(src, a) }))
  }
  if (picker.value === 'from') return [...zenonSources.value, ...unwrapSources.value]
  const cur = route.value
  if (!cur) return []
  // A token crosses to its own counterpart only: one chain per route from Zenon, Zenon alone from an EVM chain.
  if (dir.value === 'unwrap') return [{ id: cur.key, symbol: cur.zts?.symbol ?? '', network: 'Zenon', active: true, apply: () => setBridge('unwrap', cur) }]
  return bridge.routes
    .filter((r) => r.canWrap && r.pair.tokenStandard === cur.pair.tokenStandard)
    .map((r) => ({ id: r.key, symbol: r.evm?.symbol ?? '', network: r.networkName, active: r.key === routeKey.value, apply: () => setBridge('wrap', r) }))
})

// The toggle. Each mode comes back to what it last showed.
let lastBridge: { dir: 'wrap' | 'unwrap'; key: string } | null = null
function setMode(m: Mode) {
  if (busy.value) return
  if (m === mode.value) return
  if (m === 'swap') {
    if (dir.value !== 'swap' && route.value) lastBridge = { dir: dir.value, key: route.value.key }
    const from = swapFrom.value ?? swapAssets.value.find(isNative)
    const to = from && (swapTo.value ?? defaultSwapTarget(from))
    if (from && to) setSwap(from, to)
    return
  }
  const r = lastBridge && bridge.routes.find((x) => x.key === lastBridge!.key)
  if (r) setBridge(lastBridge!.dir, r)
  else dir.value = 'wrap'
}
watch(
  dir,
  (d) => {
    mode.value = d === 'swap' ? 'swap' : 'bridge'
    if (d !== 'swap') return
    const from = swapAssets.value.find(isNative)
    const to = from && swapAssets.value.find((a) => a.chainId === from.chainId && !isNative(a))
    void checkSwap(from && to ? { from, to } : null)
  },
  { immediate: true },
)
function openPicker(side: 'from' | 'to') {
  picker.value = side
}
function pick(o: Option) {
  if (busy.value) return
  o.apply()
  picker.value = null
}
const net = computed(() => (chainId.value ? evmChain(chainId.value) : null))
const evmNet = computed(() => (chainId.value ? bridge.evmNetworks[chainId.value] : undefined))

// What the user holds on the sending side, and the token's units there.
const srcSymbol = computed(() => (dir.value === 'swap' ? swapFrom.value?.symbol : dir.value === 'wrap' ? route.value?.zts?.symbol : route.value?.evm?.symbol) ?? '')
const dstSymbol = computed(() => (dir.value === 'swap' ? swapTo.value?.symbol : dir.value === 'wrap' ? route.value?.evm?.symbol : route.value?.zts?.symbol) ?? '')
// Every asset is shown with the chain it is on.
const srcNet = computed(() => (dir.value === 'wrap' ? 'Zenon' : (net.value?.name ?? '')))
const dstNet = computed(() => (dir.value === 'swap' ? (swapTo.value ? evmChain(swapTo.value.chainId).name : '') : dir.value === 'wrap' ? (net.value?.name ?? '') : 'Zenon'))
const decimals = computed(() => (dir.value === 'swap' ? swapFrom.value?.decimals : dir.value === 'wrap' ? route.value?.zts?.decimals : route.value?.evm?.decimals) ?? 8)
// The bridge keeps a token's units on both sides; a swap does not.
const dstDecimals = computed(() => (dir.value === 'swap' ? (swapTo.value?.decimals ?? 18) : decimals.value))

const quote = ref<Quote | null>(null)
const quoteError = ref('')
const balance = ref<bigint | null>(null)
const allowance = ref<bigint | null>(null)
const plasma = ref<number | null>(null)
const recipientPlasma = ref<number | null>(null)

let balanceRequest = 0
const balanceContext = () => JSON.stringify([nodeContext(), route.value?.key, dir.value, swapFrom.value, quote.value?.spender, syrius.address, evm.account, evm.chainId, evm.selected?.info.uuid])
async function refreshBalances() {
  if (dir.value === 'swap') return refreshSwapBalance()
  const request = ++balanceRequest, key = balanceContext(), r = route.value, a = api.value
  const current = () => request === balanceRequest && key === balanceContext() && a === api.value
  balance.value = null; allowance.value = null; plasma.value = null
  if (!r || !a) return
  try {
    if (dir.value === 'wrap') {
      const account = syrius.address
      if (!account) return
      const [b, p] = await Promise.all([a.balances(account), a.plasma(account)])
      if (current()) { balance.value = b[r.pair.tokenStandard] ?? 0n; plasma.value = p.currentPlasma }
    } else {
      const account = evm.account
      if (!account || evm.chainId !== r.chainId) return
      const c = readClient(r.chainId, walletForReads()), token = r.pair.tokenAddress as `0x${string}`
      const [b, allowed] = await Promise.all([
        c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
        c.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, r.contract] }),
      ])
      if (current()) { balance.value = b; allowance.value = allowed }
    }
  } catch { /* unknown balances never authorize a send */ }
}
async function refreshSwapBalance() {
  const request = ++balanceRequest, key = balanceContext(), a = swapFrom.value, account = evm.account, provider = evm.selected?.provider
  const current = () => mounted && request === balanceRequest && key === balanceContext() && provider === evm.selected?.provider
  balance.value = null; allowance.value = null
  if (!a || !account || !config.swap || evm.chainId !== a.chainId) return
  try {
    const c = readClient(a.chainId, walletForReads())
    if (await c.getChainId() !== a.chainId) return
    if (isNative(a)) {
      const result = await c.getBalance({ address: account })
      if (current()) balance.value = result
      return
    }
    const token = a.address as `0x${string}`
    // Which router is approved depends on which one quoted, so the allowance is unknown until then.
    const spender = quote.value?.spender
    const [b, al] = await Promise.all([
      c.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
      spender ? c.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account, spender] }) : null,
    ])
    if (current()) { balance.value = b; allowance.value = al }
  } catch {
    /* unknown balances never authorize a swap */
  }
}
watch([route, dir, swapFrom, () => quote.value?.spender, () => api.value, () => node.epoch, () => syrius.address, () => evm.account, () => evm.chainId, () => evm.selected], refreshBalances, { immediate: true, flush: 'sync' })
watch(() => node.tick, (t) => t % 3 === 0 && refreshBalances())

// Recipient: the connected wallet on the receiving side, unless edited.
const defaultRecipient = computed(() => (dir.value === 'unwrap' ? (syrius.address ?? '') : (evm.account ?? '')))
const recipient = computed(() => (editingRecipient.value ? recipientText.value.trim() : defaultRecipient.value))
const recipientValid = computed(() =>
  dir.value === 'unwrap' ? isUserAddress(recipient.value) : isEvmRecipient(recipient.value),
)
// A wallet connected while the box is open and nothing valid is typed fills
// it: the box was opened only because there was no wallet to take it from.
watch(defaultRecipient, (now) => {
  if (now && editingRecipient.value && !recipientValid.value) {
    editingRecipient.value = false
    recipientText.value = ''
  }
})
function toggleCustomRecipient() {
  if (busy.value) return
  editingRecipient.value = !editingRecipient.value
  recipientText.value = editingRecipient.value ? defaultRecipient.value : ''
}
watch(dir, (_n, old) => {
  if (old === undefined) return
  editingRecipient.value = false
  recipientText.value = ''
  amountText.value = ''
})

let recipientRequest = 0
async function checkRecipientPlasma() {
  const request = ++recipientRequest, key = nodeContext(), address = recipient.value, a = api.value
  recipientPlasma.value = null
  if (dir.value !== 'unwrap' || !recipientValid.value) return
  try {
    const result = await a.plasma(address)
    if (request === recipientRequest && nodeContext() === key && recipient.value === address && api.value === a) recipientPlasma.value = result.currentPlasma
  } catch {
    /* unknown */
  }
}
watch([recipient, dir, () => api.value, () => node.epoch], checkRecipientPlasma, { immediate: true })

const amount = computed(() => parseUnits(amountText.value, decimals.value))

// A swap is priced by the router. The quote is asked for when an input
// settles, not on a timer: the routers are unkeyed and rate limited.
// With no wallet yet the quote is only a price; it is asked for again once there is an account to build the transaction for.
const NO_ACCOUNT = '0x000000000000000000000000000000000000dEaD'
const quoteRequest = computed(() => {
  if (dir.value !== 'swap' || !config.swap || !swapFrom.value || !swapTo.value || !amount.value) return null
  const fromAddress = evm.account ?? NO_ACCOUNT
  return { from: swapFrom.value, to: swapTo.value, amount: amount.value, fromAddress, toAddress: recipientValid.value ? recipient.value : fromAddress }
})
let quoteSeq = 0
let quoteTimer: ReturnType<typeof setTimeout> | undefined
watch(
  () => {
    const q = quoteRequest.value
    return q ? [assetKey(q.from), assetKey(q.to), q.amount, q.fromAddress, q.toAddress].join('|') : ''
  },
  () => {
    clearTimeout(quoteTimer)
    const seq = ++quoteSeq
    quote.value = null
    quoteError.value = ''
    const req = quoteRequest.value
    if (!req) return
    quoteTimer = setTimeout(async () => {
      const r = await fetchQuote(config.swap!, req)
      if (!mounted || seq !== quoteSeq) return
      if (r.ok) quote.value = r.quote
      else quoteError.value = r.message !== 'No route' && r.message.length <= 40 ? r.message : 'No route found'
    }, 700)
  },
)

const min = computed(() => {
  const r = route.value
  if (!r || dir.value === 'swap') return 0n
  return dir.value === 'wrap' ? r.pair.minAmount : (r.evmInfo?.minAmount ?? 0n)
})
const fee = computed(() => (dir.value === 'wrap' && amount.value && route.value ? wrapFee(amount.value, route.value.pair.feePercentage) : 0n))
const bonus = computed(
  () => dir.value === 'unwrap' && !!usableReferrer(recipient.value, referrer.value) && !!route.value && bridge.loaded && affiliateActive(bridge.meta, route.value.chainId, route.value.pair.tokenStandard, bridge.evmNetworks[route.value.chainId]?.height ?? undefined),
)
const receive = computed(() => {
  if (dir.value === 'swap') return quote.value?.toAmount ?? 0n
  if (!amount.value || !route.value) return 0n
  return dir.value === 'wrap' ? wrapReceive(amount.value, route.value.pair.feePercentage) : unwrapReceive(amount.value, bonus.value)
})
const estimate = computed(() => {
  if (dir.value === 'swap') {
    return swapFrom.value && swapTo.value ? swapEstimate(swapFrom.value, swapTo.value, evmNet.value?.blockTime ?? 12, quote.value) : null
  }
  const r = route.value
  const o = bridge.orch
  if (!r || !o) return null
  const momentumSeconds = Math.max(node.rate, o.estimatedMomentumTime || 10)
  const e =
    dir.value === 'wrap'
      ? wrapEstimate({
          confirmationsToFinality: o.confirmationsToFinality,
          momentumSeconds,
          evmRedeemDelayBlocks: Number(r.evmInfo?.redeemDelay ?? 0n),
          evmBlockSeconds: evmNet.value?.blockTime ?? 12,
        })
      : unwrapEstimate({
          evmConfirmations: evmNet.value?.confirmations ?? 0,
          evmBlockSeconds: evmNet.value?.blockTime ?? 12,
          redeemDelayMomentums: r.pair.redeemDelay,
          momentumSeconds,
        })
  return e.seconds
})

// Dollar estimates beside the amounts. A token is priced by its EVM form: ZNN
// on Zenon by the wZNN the bridge pairs it with. Nothing is sent by these.
const prices = ref<Record<string, { usd: number | null; at: number }>>({})
const routeAsset = (r: Route | undefined): SwapAsset | null => (r?.evm ? { chainId: r.chainId, address: r.pair.tokenAddress, symbol: r.evm.symbol, decimals: r.evm.decimals } : null)
const srcPriced = computed(() => (dir.value === 'swap' ? swapFrom.value : routeAsset(route.value)))
const dstPriced = computed(() => (dir.value === 'swap' ? swapTo.value : routeAsset(route.value)))
watch(
  [srcPriced, dstPriced],
  (list) => {
    if (!config.swap) return
    for (const a of list) {
      if (!a) continue
      const k = assetKey(a)
      if (prices.value[k] && Date.now() - prices.value[k].at < 300_000) continue
      prices.value[k] = { usd: prices.value[k]?.usd ?? null, at: Date.now() }
      void fetchPrice(config.swap, a).then((usd) => (prices.value[k] = { usd: usd ?? prices.value[k]?.usd ?? null, at: Date.now() }))
    }
  },
  { immediate: true },
)
const srcPrice = computed(() => (srcPriced.value ? (prices.value[assetKey(srcPriced.value)]?.usd ?? null) : null))
const dstPrice = computed(() => (dstPriced.value ? (prices.value[assetKey(dstPriced.value)]?.usd ?? null) : null))
const srcUsd = computed(() => (srcPrice.value && amount.value ? usdValue(amount.value, decimals.value, srcPrice.value) : null))
const dstUsd = computed(() => (dstPrice.value && receive.value ? usdValue(receive.value, dstDecimals.value, dstPrice.value) : null))

// A chain's coin also pays for the transaction, so Max leaves some behind.
const GAS_RESERVE = 5_000_000_000_000_000n
function setMax() {
  if (busy.value) return
  if (balance.value === null) return
  const native = dir.value === 'swap' && !!swapFrom.value && isNative(swapFrom.value)
  const max = native ? (balance.value > GAS_RESERVE ? balance.value - GAS_RESERVE : 0n) : balance.value
  amountText.value = unitsToInput(max, decimals.value)
}

function flip() {
  if (busy.value) return
  if (dir.value === 'swap') {
    if (swapFrom.value && swapTo.value) setSwap(swapTo.value, swapFrom.value)
    return
  }
  dir.value = dir.value === 'wrap' ? 'unwrap' : 'wrap'
}

const needsApproval = computed(
  () =>
    (dir.value === 'unwrap' || (dir.value === 'swap' && !!swapFrom.value && !isNative(swapFrom.value))) &&
    amount.value !== null &&
    allowance.value !== null &&
    allowance.value < amount.value,
)

// The button says what is missing, in the order the user meets it.
const blocker = computed<string>(() => {
  const swap = dir.value === 'swap'
  if (!swap && !bridge.loaded) return 'Loading'
  if (swap ? !swapFrom.value || !swapTo.value : !route.value) return 'No route found'
  if (dir.value === 'wrap' && !syrius.address) return syrius.present ? 'Connect Syrius' : 'Install Syrius'
  if (dir.value === 'wrap' && wrongZenonChain()) return 'Syrius is on another chain'
  if (dir.value !== 'wrap' && !evm.account) return 'Connect EVM wallet'
  if (dir.value !== 'wrap' && evm.chainId !== chainId.value) return `Switch to ${net.value?.name}`
  if (!amountText.value) return 'Enter an amount'
  if (amount.value === null) return 'Use a decimal dot; no grouping separators'
  if (amount.value === 0n) return 'Enter an amount'
  if (amount.value < min.value) return `Minimum ${formatUnits(min.value, decimals.value)} ${srcSymbol.value}`
  if (balance.value !== null && amount.value > balance.value) return `Not enough ${srcSymbol.value}`
  if (!recipient.value) return dir.value === 'unwrap' ? 'Connect Syrius or enter recipient' : 'Connect EVM wallet or enter recipient'
  if (!recipientValid.value) return 'Invalid recipient'
  if (operations.error) return 'Operation history unavailable'
  const source = dir.value === 'wrap' ? 'zenon' : 'evm'
  const account = dir.value === 'wrap' ? syrius.address : evm.account
  const sourceChain = dir.value === 'wrap' ? node.chainId : chainId.value!
  if (account && unresolvedOperation(source, sourceChain, account)) return 'Resolve the earlier operation in Activity'
  if (swap) {
    if (balance.value === null) return 'Balance unavailable'
    if (quote.value && Date.now() >= quote.value.expires) return 'Quote expired. Change the amount to refresh.'
    return quoteError.value || (quote.value && (isNative(swapFrom.value!) || allowance.value !== null) ? '' : 'Getting quote')
  }
  const safety = transferBlocker(route.value!, dir.value === 'wrap' ? 'wrap' : 'unwrap')
  if (safety) return safety
  if (balance.value === null || dir.value === 'unwrap' && allowance.value === null) return 'Balance or allowance unavailable'
  return ''
})

const actionLabel = computed(() => {
  if (blocker.value) return blocker.value
  if (needsApproval.value) return `Approve ${srcSymbol.value}`
  if (dir.value === 'swap') return swapFrom.value?.chainId === swapTo.value?.chainId ? 'Swap' : `Swap to ${dstNet.value}`
  return dir.value === 'wrap' ? `Bridge to ${net.value?.name}` : 'Bridge to Zenon'
})

const actionable = computed(() => {
  const b = blocker.value
  return !b || b === 'Connect Syrius' || b === 'Install Syrius' || b === 'Connect EVM wallet' || b.startsWith('Switch to')
})

async function onAction() {
  const b = blocker.value
  try {
    if (b === 'Connect Syrius') return await connectSyrius()
    if (b === 'Install Syrius') return void window.open('https://github.com/DexterLabZ/syrius-extension/releases', '_blank', 'noopener')
    if (b === 'Connect EVM wallet') return void (evm.pickerOpen = true)
    if (b.startsWith('Switch to') && chainId.value) return await ensureChain(chainId.value)
    if (b) return
    // The terms are the bridge's; a swap does not use it.
    if (dir.value !== 'swap' && !accepted.value) return void (termsOpen.value = true)
    if (needsApproval.value) return await approve()
    if (dir.value === 'swap') await sendSwap()
    else if (dir.value === 'wrap') await sendWrap()
    else await sendUnwrap()
  } catch (err) {
    toastError(err)
  }
}

function snapshot() {
  const direction = dir.value
  if (direction === 'swap') throw new Error('Use the captured swap quote')
  const selected = route.value
  if (!selected || !amount.value || !recipientValid.value) throw new Error('Transfer details are unavailable')
  const r = { ...selected, pair: { ...selected.pair } }
  const captured = { r, amount: amount.value, receive: receive.value, recipient: recipient.value, znn: node.chainId,
    account: dir.value === 'wrap' ? syrius.address! : evm.account!, provider: evm.selected?.provider,
    nodeKey: nodeContext(), bonus: bonus.value, referral: referrer.value, createdAt: Math.floor(Date.now() / 1000) }
  const economics = (value: Route | undefined) => JSON.stringify([value?.pair, value?.evmInfo, value?.zts?.decimals, value?.evm?.decimals, bridge.info?.compressedTssECDSAPubKey, bridge.info?.metadata], (_key, value) => typeof value === 'bigint' ? value.toString() : value)
  const chosenEconomics = economics(r)
  const guard = () => {
    if (!mounted) throw new Error('Transfer view changed before submission')
    if (nodeContext() !== captured.nodeKey || direction !== dir.value || (direction === 'wrap' ? syrius.address : evm.account) !== captured.account ||
      direction === 'unwrap' && (evm.selected?.provider !== captured.provider || evm.chainId !== r.chainId)) throw new Error('Wallet or network changed before submission')
    const currentRoute = bridge.routes.find((x) => x.key === r.key)
    if (economics(currentRoute) !== chosenEconomics) throw new Error('Transfer configuration changed before submission. Review the current amount and limits.')
    const safety = transferBlocker(currentRoute, direction)
    if (safety || !bridge.routes.some((x) => x.key === r.key)) throw new Error(safety || 'Route changed before submission')
  }
  return { ...captured, guard }
}

async function sendWrap() {
  const s = snapshot()
  sending.value = true
  try {
    s.guard()
    const hash = await sendBlock(wrapTokenBlock({ networkClass: s.r.networkClass, chainId: s.r.chainId, toAddress: s.recipient, tokenStandard: s.r.pair.tokenStandard, amount: s.amount }), s.guard)
    remember({ kind: 'wrap', id: hash, znn: s.znn, contract: s.r.contract, chainId: s.r.chainId, toAddress: s.recipient.toLowerCase(),
      from: s.account, tokenStandard: s.r.pair.tokenStandard, amount: s.receive.toString(), createdAt: s.createdAt })
    toast(`Submitted. Redeem on ${s.r.networkName} once signed.`, 'wait', { href: s.znn === config.zenonChainId ? config.zenonExplorerTx(hash) : '', label: 'View' })
    if (mounted) { amountText.value = ''; go('activity') }
  } finally { sending.value = false }
}

async function approve() {
  if (dir.value === 'swap') return approveSwap()
  const s = snapshot()
  approving.value = true
  try {
    await ensureChain(s.r.chainId)
    s.guard()
    const w = writeClient(s.r.chainId, s.provider!, s.account as `0x${string}`)
    const token = s.r.pair.tokenAddress as `0x${string}`, args = [s.r.contract, s.amount] as const
    const hash = await submitTransaction({ chainId: s.r.chainId, account: s.account, kind: 'approve', payload: transactionPayload(token, erc20Abi, 'approve', args) }, s.guard,
      () => w.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args, chain: w.chain, account: s.account as `0x${string}` }))
    toast('Approval submitted', 'wait')
    await successfulReceipt(readClient(s.r.chainId, { provider: s.provider!, chainId: s.r.chainId }), s.r.chainId, hash)
    await refreshBalances()
  } finally { approving.value = false }
}

async function sendUnwrap() {
  const s = snapshot()
  sending.value = true
  try {
    await ensureChain(s.r.chainId)
    s.guard()
    const w = writeClient(s.r.chainId, s.provider!, s.account as `0x${string}`)
    const to = recipientString(s.recipient, s.bonus ? s.referral : null)
    const args = [s.r.pair.tokenAddress as `0x${string}`, s.amount, to] as const
    const hash = await submitTransaction({ chainId: s.r.chainId, account: s.account, kind: 'unwrap', payload: transactionPayload(s.r.contract, bridgeAbi, 'unwrap', args) }, s.guard,
      () => w.writeContract({ address: s.r.contract, abi: bridgeAbi, functionName: 'unwrap', args, chain: w.chain, account: s.account as `0x${string}` }))
    remember({ kind: 'unwrap', txHash: hash, znn: s.znn, contract: s.r.contract, chainId: s.r.chainId, toAddress: s.recipient,
      from: s.account, tokenAddress: s.r.pair.tokenAddress, amount: s.receive.toString(), createdAt: s.createdAt })
    toast('Submitted. Redeem on Zenon once signed.', 'wait', evmTxUrl(s.r.chainId, hash) ? { href: evmTxUrl(s.r.chainId, hash), label: 'View' } : undefined)
    await successfulReceipt(readClient(s.r.chainId, { provider: s.provider!, chainId: s.r.chainId }), s.r.chainId, hash)
    if (mounted) { amountText.value = ''; go('activity') }
  } finally { sending.value = false }
}

async function sendSwap() {
  const s = swapSnapshot()
  sending.value = true
  try {
    const q = s.quote
    const { from, to } = q.request
    await ensureChain(from.chainId)
    s.guard()
    const w = writeClient(from.chainId, s.provider, s.account)
    const payload = swapPayload(q, JSON.stringify({ to: q.tx.to.toLowerCase(), data: q.tx.data.toLowerCase(), value: q.tx.value.toString() }))
    const hash = await submitTransaction({ chainId: from.chainId, account: s.account, kind: 'swap', payload }, s.guard,
      () => w.sendTransaction({ ...q.tx, chain: w.chain, account: s.account }))
    if (mounted) amountText.value = ''
    void followSwap(hash, from, to, q.provider, s.provider)
  } finally {
    sending.value = false
  }
}

function swapSnapshot() {
  const q = quote.value, account = evm.account, provider = evm.selected?.provider
  if (!q || !account || !provider || q.request.fromAddress.toLowerCase() !== account.toLowerCase()) throw new Error('Swap details are unavailable')
  const chosen = JSON.stringify(q, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
  const guard = () => {
    if (!mounted || dir.value !== 'swap' || provider !== evm.selected?.provider || account !== evm.account || evm.chainId !== q.request.from.chainId ||
      amount.value !== q.request.amount || recipient.value.toLowerCase() !== q.request.toAddress.toLowerCase() ||
      !sameAsset(swapFrom.value, q.request.from) || !sameAsset(swapTo.value, q.request.to) || Date.now() >= q.expires ||
      JSON.stringify(quote.value, (_key, value) => typeof value === 'bigint' ? value.toString() : value) !== chosen) throw new Error('Swap or wallet changed. Review a fresh quote before submission.')
  }
  guard()
  return { quote: { ...q, request: { ...q.request, from: { ...q.request.from }, to: { ...q.request.to } }, tx: { ...q.tx } }, account, provider, guard }
}

function swapPayload(q: Quote, transaction: string): string {
  // Preserve the chosen economic context as private recovery evidence. These
  // quote fields do not authenticate opaque calldata or receiving-chain state.
  return JSON.stringify({ ...JSON.parse(transaction), quote: { provider: q.provider, fromChainId: q.request.from.chainId, fromToken: q.request.from.address,
    toChainId: q.request.to.chainId, toToken: q.request.to.address, recipient: q.request.toAddress, fromAmount: q.request.amount.toString(),
    minimumOutput: q.toAmountMin.toString(), expiresAt: q.expires } })
}

async function approveSwap() {
  const s = swapSnapshot(), q = s.quote, chainId = q.request.from.chainId
  const token = q.request.from.address as `0x${string}`, args = [q.spender, q.request.amount] as const
  approving.value = true
  try {
    s.guard()
    const w = writeClient(chainId, s.provider, s.account)
    const hash = await submitTransaction({ chainId, account: s.account, kind: 'swap-approval', payload: swapPayload(q, transactionPayload(token, erc20Abi, 'approve', args)) }, s.guard,
      () => w.writeContract({ address: token, abi: erc20Abi, functionName: 'approve', args, chain: w.chain, account: s.account }))
    await successfulReceipt(readClient(chainId, { provider: s.provider, chainId }), chainId, hash)
    if (mounted) await refreshBalances()
  } finally { approving.value = false }
}

// The durable journal in Activity retains the source hash. Router status is
// advisory; it does not authenticate a destination receipt or economic result.
async function followSwap(hash: `0x${string}`, from: SwapAsset, to: SwapAsset, provider: Provider, walletProvider: NonNullable<typeof evm.selected>['provider']) {
  const cross = from.chainId !== to.chainId
  const href = cross && provider === 'lifi' ? `${config.swap!.lifi.scan}${hash}` : evmTxUrl(from.chainId, hash)
  const link = href ? { href, label: 'View' } : undefined
  toast('Swap sent', 'wait', link)
  try {
    await successfulReceipt(readClient(from.chainId, { provider: walletProvider, chainId: from.chainId }), from.chainId, hash)
    if (!mounted) return
    if (cross) {
      let state = 'pending'
      for (let i = 0; i < 100 && state === 'pending' && mounted; i++) {
        await new Promise((r) => setTimeout(r, 6000))
        if (!mounted) return
        state = await fetchStatus(config.swap!, provider, hash, from.chainId, to.chainId)
      }
      if (state === 'failed') return toast('Swap failed', 'danger', link, 8000)
      if (state === 'pending') return toast('Swap still in transit', 'wait', link, 8000)
    }
    toast(cross ? `Router reports ${to.symbol} filled on ${evmChain(to.chainId).name}. Verify the receiving transaction.` : 'Swap source transaction confirmed. Verify the received amount.', 'wait', link, 8000)
    void refreshBalances()
  } catch (err) {
    toastError(err)
  }
}

// Plasma: a Zenon address with none cannot send without proof of work.
// zenonhub's bot fuses on the build's chain only.
const plasmaBot = computed(() => (onBuildChain() ? config.plasmaBot : { url: '', token: '', page: '' }))
const plasmaBusy = ref(false)
async function getPlasma(address: string) {
  plasmaBusy.value = true
  try {
    const r = await requestPlasma(address, plasmaBot.value)
    if (r.ok) {
      toast(r.message, 'ok')
      setTimeout(checkRecipientPlasma, 20_000)
    } else if (r.page) window.open(r.page, '_blank', 'noopener')
    else toast(r.message, 'danger')
  } finally {
    plasmaBusy.value = false
  }
}

async function addToken() {
  const r = route.value
  if (!r?.evm || !evm.selected) return
  try {
    await ensureChain(r.chainId)
    await watchAsset(evm.selected.provider, { address: r.pair.tokenAddress, symbol: r.evm.symbol, decimals: r.evm.decimals })
  } catch (err) {
    toastError(err)
  }
}

const busy = computed(() => sending.value || approving.value || syrius.busy || evm.busy)
</script>

<template>
  <section class="rise mx-auto grid max-w-[440px] grid-cols-1 gap-2">
    <h1 class="sr-only">Bridge</h1>
    <div v-if="config.swap" class="flex justify-center">
      <div class="seg" role="tablist" :class="{ swap: mode === 'swap' }">
        <span class="seg-thumb" aria-hidden="true" />
        <button role="tab" data-testid="mode-bridge" :aria-selected="mode === 'bridge'" :class="{ active: mode === 'bridge' }" :disabled="busy" @click="setMode('bridge')">Bridge</button>
        <button role="tab" data-testid="mode-swap" :aria-selected="mode === 'swap'" :class="{ active: mode === 'swap' }" :disabled="busy || !bridge.loaded" @click="setMode('swap')">Swap</button>
      </div>
    </div>
    <div class="flex items-center justify-between px-1">
      <span v-if="estimate" class="inline-flex items-center gap-1.5 text-sm text-dim"><Clock :size="14" />~{{ duration(estimate) }}</span>
      <span v-else />
      <button class="adv" data-testid="bridge-advanced" :disabled="busy" @click="advanced = true">
        Advanced<SlidersHorizontal :size="15" />
        <span v-if="editingRecipient" class="adv-dot" />
      </button>
    </div>

    <!-- From -->
    <div class="leg">
      <button class="asset" data-testid="bridge-from" :disabled="busy || !bridge.loaded" @click="openPicker('from')">
        <TokenIcon :key="`i-${srcSymbol}-${srcNet}`" class="val-in" :symbol="srcSymbol" :chain="srcNet" :size="44" />
        <span :key="`t-${srcSymbol}-${srcNet}`" class="val-in grid min-w-0 flex-1 text-left">
          <span class="text-lg leading-tight font-semibold">{{ srcSymbol || 'From' }}</span>
          <span class="text-sm text-dim">{{ srcNet }}</span>
        </span>
        <span class="chevron"><ChevronDown :size="16" /></span>
      </button>
      <div class="mt-4 flex items-center gap-3">
        <input v-model="amountText" :disabled="busy" class="amount-input mono w-0 min-w-0 flex-1" inputmode="decimal" placeholder="0.00" aria-label="Amount" autocomplete="off" />
        <button class="max-btn" :disabled="busy" @click="setMax">Max</button>
      </div>
      <div class="mt-1 flex h-5 items-center justify-between text-sm text-dim">
        <span>Balance <Amount :value="balance ?? 0n" :decimals="decimals" /></span>
        <span v-if="srcUsd" data-testid="bridge-from-usd" class="mono">{{ formatUsd(srcUsd) }}</span>
        <span v-else-if="min" class="text-xs">Min <Amount :value="min" :decimals="decimals" /></span>
      </div>
    </div>

    <div class="relative z-10 -my-5 flex justify-center">
      <button data-testid="bridge-flip" :disabled="busy" class="flip" :class="{ flipped: dir === 'unwrap' }" aria-label="Reverse direction" @click="flip"><ArrowDownUp :size="17" /></button>
    </div>

    <!-- To -->
    <div class="leg">
      <button class="asset" data-testid="bridge-to" :disabled="busy || !bridge.loaded" @click="openPicker('to')">
        <TokenIcon :key="`i-${dstSymbol}-${dstNet}`" class="val-in" :symbol="dstSymbol" :chain="dstNet" :size="44" />
        <span :key="`t-${dstSymbol}-${dstNet}`" class="val-in grid min-w-0 flex-1 text-left">
          <span class="text-lg leading-tight font-semibold">{{ dstSymbol || 'To' }}</span>
          <span class="text-sm text-dim">{{ dstNet }}</span>
        </span>
        <span class="chevron"><ChevronDown :size="16" /></span>
      </button>
      <div data-testid="bridge-receive" class="mono mt-4 truncate text-[30px] leading-[1.25]" :class="receive ? 'text-fg' : 'text-dim'">
        {{ receive ? formatUnits(receive, dstDecimals) : '0.00' }}
      </div>
      <div class="mt-1 flex h-5 items-center gap-1.5 text-sm text-dim">
        <template v-if="recipient">
          <span>To</span><span class="mono truncate" :class="recipientValid ? 'text-soft' : 'text-danger'" :title="recipient">{{ shorten(recipient, 8, 6) }}</span>
          <span v-if="editingRecipient" class="chip chip-dim !h-5">Custom</span>
        </template>
        <span v-else>Connect a wallet to receive</span>
        <span v-if="dstUsd" data-testid="bridge-to-usd" class="mono ml-auto shrink-0">{{ formatUsd(dstUsd) }}</span>
      </div>
    </div>

    <!-- Notes that matter for this transfer -->
    <div v-if="dir === 'wrap' && syrius.address && plasma === 0" class="note warn">
      <Fuel :size="15" /><span class="flex-1">No plasma. Syrius will compute proof of work, which is slow.</span>
      <button v-if="plasmaBot.url || plasmaBot.page" class="btn btn-sm" :disabled="plasmaBusy" @click="getPlasma(syrius.address!)">
        <Loader2 v-if="plasmaBusy" :size="14" class="spin" /><Zap v-else :size="14" />Get plasma
      </button>
    </div>
    <div v-if="dir === 'unwrap' && recipientValid && recipientPlasma === 0" class="note warn">
      <Fuel :size="15" /><span class="flex-1">Recipient has no plasma, needed to redeem on Zenon.</span>
      <button v-if="plasmaBot.url || plasmaBot.page" class="btn btn-sm" :disabled="plasmaBusy" @click="getPlasma(recipient)">
        <Loader2 v-if="plasmaBusy" :size="14" class="spin" /><Zap v-else :size="14" />{{ canRequest(plasmaBot) ? 'Get plasma' : 'Plasma bot' }}
      </button>
    </div>
    <div v-if="bonus" class="note new"><Gift :size="15" />Referral bonus: +1% on arrival.</div>

    <button data-testid="bridge-action" class="btn btn-plasma btn-block mt-2 !min-h-[58px] text-[17px]" :disabled="!actionable || busy" @click="onAction">
      <Loader2 v-if="busy" :size="18" class="spin" />
      <span v-if="syrius.hold">Syrius is busy, retrying in {{ syrius.hold }}s</span>
      <span v-else>{{ actionLabel }}</span>
    </button>

    <!-- The cost and the steps, one tap away. -->
    <div v-if="dir === 'swap'" class="mt-1 px-1">
      <button class="details-row" :aria-expanded="details" @click="details = !details">
        <span data-testid="swap-via">{{ quote ? `Via ${quote.via}` : 'No bridge wait' }}</span>
        <span class="flex-1" />
        <span>Details</span><ChevronDown :size="14" class="chev" :class="{ up: details }" />
      </button>
      <dl v-if="details" class="summary slide-down">
        <div v-if="quote">
          <dt>Minimum</dt>
          <dd><Amount :value="quote.toAmountMin" :decimals="dstDecimals" :symbol="dstSymbol" /></dd>
        </div>
        <div v-if="quote && quote.feeUsd">
          <dt>Fee</dt>
          <dd class="mono">{{ formatUsd(quote.feeUsd) }}</dd>
        </div>
        <div v-if="srcPrice">
          <dt>{{ srcSymbol }}</dt>
          <dd class="mono">{{ formatUsd(srcPrice) }}</dd>
        </div>
        <div v-if="dstPrice">
          <dt>{{ dstSymbol }}</dt>
          <dd class="mono">{{ formatUsd(dstPrice) }}</dd>
        </div>
        <div v-if="estimate">
          <dt>Time</dt>
          <dd>~{{ duration(estimate) }}</dd>
        </div>
        <div>
          <dt>Steps</dt>
          <dd>{{ needsApproval ? 'Approve, then swap' : 'One transaction' }}</dd>
        </div>
      </dl>
    </div>
    <div v-else-if="route" class="mt-1 px-1">
      <button class="details-row" :aria-expanded="details" @click="details = !details">
        <span>{{ dir === 'wrap' ? `Fee ${route.pair.feePercentage / 100}%` : 'No bridge fee' }}</span>
        <span class="flex-1" />
        <span>Details</span><ChevronDown :size="14" class="chev" :class="{ up: details }" />
      </button>
      <dl v-if="details" class="summary slide-down">
        <div v-if="dir === 'wrap'">
          <dt>Fee</dt>
          <dd><Amount :value="fee" :decimals="decimals" :symbol="srcSymbol" /></dd>
        </div>
        <div v-if="estimate">
          <dt>Time</dt>
          <dd>~{{ duration(estimate) }}</dd>
        </div>
        <div>
          <dt>Steps</dt>
          <dd>{{ dir === 'wrap' ? `Send on Zenon, then redeem twice on ${route.networkName}` : (needsApproval ? 'Approve, send, then redeem on Zenon' : 'Send, then redeem on Zenon') }}</dd>
        </div>
        <div v-if="srcPrice">
          <dt>{{ srcSymbol }}</dt>
          <dd class="mono">{{ formatUsd(srcPrice) }}</dd>
        </div>
        <div v-if="dir === 'wrap' && plasma !== null && plasma > 0 && plasma < LOW_PLASMA">
          <dt>Plasma</dt>
          <dd>Low. Fuse QSR for faster sends.</dd>
        </div>
      </dl>
    </div>

    <!-- One side at a time: the source from every chain, then where it can go. -->
    <Modal :open="picker !== null" :title="picker === 'to' ? 'To' : 'From'" @close="picker = null">
      <div class="grid gap-1">
        <button v-for="o in options" :key="o.id" data-testid="bridge-option" :disabled="busy" class="pick-row" :class="{ active: o.active }" @click="pick(o)">
          <TokenIcon :symbol="o.symbol" :chain="o.network" :size="36" />
          <span class="grid text-left">
            <span class="font-medium">{{ o.symbol }}</span>
            <span class="text-xs text-dim">{{ o.network }}</span>
          </span>
        </button>
        <p v-if="!options.length" class="text-soft">None yet</p>
      </div>
    </Modal>

    <Modal :open="advanced" title="Advanced" @close="advanced = false">
      <div class="grid grid-cols-1 gap-1">
        <button class="menu-row !px-0" data-testid="custom-recipient" :disabled="busy" @click="toggleCustomRecipient">
          <span class="flex-1 text-left">Custom recipient</span>
          <span class="switch" role="switch" :aria-checked="editingRecipient" />
        </button>
        <input
          v-if="editingRecipient"
          v-model="recipientText" :disabled="busy"
          class="field mono slide-down mb-2 text-sm"
          :placeholder="dir === 'unwrap' ? 'z1…' : '0x…'"
          aria-label="Recipient"
          autocomplete="off"
          spellcheck="false"
        />
        <div v-if="editingRecipient && recipientText && !recipientValid" class="mb-2 text-sm text-danger">Not {{ dir === 'unwrap' ? 'a Zenon' : 'an EVM' }} address</div>
        <button v-if="dir !== 'swap' && route?.evm && evm.selected" class="menu-row !px-0" @click="addToken">
          <span class="flex-1 text-left">Add {{ route.evm.symbol }} to wallet</span><Plus :size="16" />
        </button>
      </div>
    </Modal>

    <Terms :open="termsOpen" @close="termsOpen = false" @accepted="((termsOpen = false), onAction())" />
  </section>
</template>

<style scoped>
/* The mode toggle: one thumb slides between two equal halves, and the labels
   change colour as it passes. */
.seg {
  position: relative;
  display: inline-grid;
  grid-template-columns: 1fr 1fr;
  padding: 4px;
  border: 1px solid var(--line);
  border-radius: 999px;
  background: var(--card-glass);
  backdrop-filter: blur(10px);
}
.seg-thumb {
  position: absolute;
  top: 4px;
  bottom: 4px;
  left: 4px;
  width: calc(50% - 4px);
  border-radius: 999px;
  background: var(--raised);
  box-shadow: var(--edge), var(--shadow-panel);
  transition: transform 360ms cubic-bezier(0.65, 0, 0.35, 1);
}
.seg.swap .seg-thumb {
  transform: translateX(100%);
}
.seg button {
  position: relative;
  min-height: 44px;
  min-width: 96px;
  padding: 0 22px;
  border-radius: 999px;
  color: var(--dim);
  font-size: 15px;
  font-weight: 500;
  transition: color 240ms var(--ease);
}
.seg button:hover,
.seg button.active {
  color: var(--fg);
}
.seg button:active {
  transform: scale(0.97);
}
/* The form stays where it is when the mode or an asset changes. Only what
   changed is replaced: the new token and its name fade in, in place. */
@keyframes val-in {
  from {
    opacity: 0;
    transform: translateY(3px);
  }
}
.val-in {
  animation: val-in 260ms var(--ease) both;
}
.adv {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 44px;
  padding: 0 4px;
  font-size: 13px;
  color: var(--dim);
  transition: color 180ms var(--ease);
}
.adv:hover {
  color: var(--fg);
}
.adv svg {
  transition: transform 320ms var(--spring);
}
.adv:hover svg {
  transform: rotate(90deg);
}
.adv-dot {
  position: absolute;
  top: 10px;
  right: -2px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
}
.leg {
  padding: 18px 20px 16px;
  border-radius: var(--radius-card);
  background: var(--card-glass);
  backdrop-filter: blur(10px);
  border: 1px solid var(--line);
  box-shadow: var(--edge), var(--shadow-panel);
  --icon-ring: var(--surface);
  transition:
    border-color 180ms var(--ease),
    box-shadow 180ms var(--ease);
}
.leg:focus-within {
  border-color: var(--line-strong);
}
.asset {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  min-height: 48px;
}
.chevron {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--line-strong);
  color: var(--soft);
  transition:
    background 180ms var(--ease),
    color 180ms var(--ease),
    transform 260ms var(--spring);
}
.asset:hover:not(:disabled) .chevron {
  background: var(--raised);
  color: var(--fg);
  transform: translateY(2px);
}
.asset:active:not(:disabled) .chevron {
  transform: scale(0.92);
}
.amount-input {
  background: transparent;
  border: 0;
  outline: none;
  font-size: 30px;
  line-height: 1.25;
  color: var(--fg);
  padding: 0;
}
.amount-input::placeholder {
  color: var(--dim);
}
.max-btn {
  min-height: 30px;
  padding: 0 12px;
  border-radius: 999px;
  border: 1px solid var(--line-strong);
  font-size: 13px;
  font-weight: 600;
  color: var(--fg);
  transition:
    background 180ms var(--ease),
    border-color 180ms var(--ease),
    transform 220ms var(--spring);
}
.max-btn:hover {
  background: var(--raised);
  border-color: var(--dim);
  transform: translateY(-1px);
}
.max-btn:active {
  transform: scale(0.94);
}
.flip {
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--surface);
  border: 1px solid var(--line-strong);
  color: var(--soft);
  box-shadow: 0 0 0 4px var(--bg);
  transition:
    transform 420ms var(--spring),
    color 180ms var(--ease),
    border-color 180ms var(--ease);
}
.flip:hover {
  color: var(--znn-ink);
  border-color: var(--znn-ink);
  transform: rotate(180deg);
}
.flip.flipped {
  transform: rotate(180deg);
}
.flip.flipped:hover {
  transform: rotate(360deg);
}
.note {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: 16px;
  font-size: 14px;
  color: var(--soft);
  background: var(--sunk);
}
.note.warn {
  color: var(--warn);
  background: var(--warn-bg);
}
.note.new {
  color: var(--new-ink);
  background: var(--new-bg);
}
.details-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 44px;
  font-size: 13px;
  color: var(--dim);
  transition: color 180ms var(--ease);
}
.details-row:hover {
  color: var(--fg);
}
.chev {
  transition: transform 220ms var(--spring);
}
.chev.up {
  transform: rotate(180deg);
}
.summary {
  display: grid;
  gap: 8px;
  padding-bottom: 8px;
  font-size: 14px;
}
.summary > div {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.summary dt {
  color: var(--dim);
}
.summary dd {
  text-align: right;
  color: var(--soft);
}
.pick-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 64px;
  padding: 0 12px;
  border-radius: var(--radius);
  --icon-ring: var(--surface);
  transition:
    background 180ms var(--ease),
    transform 220ms var(--spring);
}
.pick-row:hover,
.pick-row.active {
  background: var(--raised);
  --icon-ring: var(--raised);
}
.pick-row:active {
  transform: scale(0.985);
}
</style>
