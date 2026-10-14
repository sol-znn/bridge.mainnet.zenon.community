<script setup lang="ts">
// Every transfer this browser knows of, with where it is and what to do next.
// Redeem is open to anyone: on EVM the tokens go to the request's recipient
// whoever sends the call, and on Zenon the same holds for `Redeem`.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ArrowRight, RefreshCw, Search, X, Loader2 } from '@lucide/vue'
import TokenIcon from '../components/TokenIcon.vue'
import Modal from '../components/Modal.vue'
import Amount from '../components/Amount.vue'
import Address from '../components/Address.vue'
import StatusChip from '../components/StatusChip.vue'
import OperationRecovery from '../components/OperationRecovery.vue'
import { activity, refreshActivity, setWatched, type Item } from '../state/activity.ts'
import { bridge, bridgeDown, nodeContext, routeByZts } from '../state/bridge.ts'
import { evm, ensureChain } from '../state/evm.ts'
import { syrius, sendBlock, connectSyrius } from '../state/zenon.ts'
import { toast, toastError } from '../state/toasts.ts'
import { userMessage } from '../core/errors.ts'
import { readClient, writeClient } from '../evm/client.ts'
import { bridgeAbi } from '../evm/abi.ts'
import { redeemBlock } from '../znn/api.ts'
import { isAddress } from '../znn/primitives.ts'
import { evmSignature, wrapStateFromRevert } from '../core/status.ts'
import { clock, ago } from '../core/format.ts'
import { config, evmChain, evmTxUrl, evmAddressUrl } from '../config.ts'
import { submitTransaction, successfulReceipt, transactionPayload } from '../evm/transactions.ts'

type Filter = 'all' | 'action' | 'pending' | 'done'
const filter = ref<Filter>('all')
const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'action', label: 'Needs you' },
  { id: 'pending', label: 'In progress' },
  { id: 'done', label: 'Done' },
]
const isAction = (i: Item) => i.status.state === 'redeem' || i.status.state === 'finish'
const isDone = (i: Item) => ['done', 'revoked', 'failed'].includes(i.status.state)
const shown = computed(() =>
  activity.items.filter((i) =>
    filter.value === 'all' ? true : filter.value === 'action' ? isAction(i) : filter.value === 'done' ? isDone(i) : !isDone(i) && !isAction(i),
  ),
)
const counts = computed(() => ({
  all: activity.items.length,
  action: activity.items.filter(isAction).length,
  pending: activity.items.filter((i) => !isDone(i) && !isAction(i)).length,
  done: activity.items.filter(isDone).length,
}))

const now = ref(Date.now() / 1000)
let mounted = true
let timer: ReturnType<typeof setInterval>
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now() / 1000), 1000)
  void refreshActivity()
})
onUnmounted(() => { mounted = false; clearInterval(timer) })
const freshHistory = () => mounted && activity.readAt > 0 && Date.now() - activity.readAt < 120_000 && !activity.error
const left = (i: Item) => (i.status.eta ? activity.builtAt + i.status.eta - now.value : 0)

const trackOpen = ref(false)
const watchText = ref('')
const watchValid = computed(() => isAddress(watchText.value.trim()) || /^0x[0-9a-fA-F]{40}$/.test(watchText.value.trim()))
function addWatch() {
  if (!watchValid.value) return
  setWatched([...activity.watched, watchText.value.trim()])
  watchText.value = ''
}

async function redeemWrap(i: Item) {
  const w = i.wrap!
  const net = bridge.networks.find((n) => n.chainId === w.chainId)
  if (!net || !evm.selected || !evm.account) return void (evm.pickerOpen = true)
  activity.busy[i.key] = true
  try {
    if (i.context !== activity.context || !freshHistory()) throw new Error('Refresh this request on its original network before redeeming')
    const context = nodeContext(), account = evm.account, provider = evm.selected.provider, step = i.status.state
    const guard = () => {
      if (context !== nodeContext() || account !== evm.account || provider !== evm.selected?.provider || evm.chainId !== w.chainId || activity.context !== i.context || !freshHistory()) throw new Error('Wallet or request context changed before redemption')
    }
    await ensureChain(w.chainId)
    guard()
    const contract = net.contractAddress as `0x${string}`
    const args = [w.toAddress as `0x${string}`, w.tokenAddress as `0x${string}`, w.amount - w.fee, BigInt('0x' + w.id), evmSignature(w.signature)] as const
    const reader = readClient(w.chainId, { provider, chainId: w.chainId })
    // Simulate first: bridge.sol's revert reason says exactly why it cannot go yet.
    try {
      await reader.simulateContract({ address: contract, abi: bridgeAbi, functionName: 'redeem', args, account })
    } catch (err) {
      const msg = (err as Error).message
      const shown = userMessage(err)
      const state = wrapStateFromRevert(msg)
      toast(state === 'done' ? 'Already redeemed' : state === 'delay' ? 'Not redeemable yet' : shown.text, state === 'done' ? 'ok' : shown.declined ? 'dim' : 'warn')
      return void (await refreshActivity())
    }
    guard()
    const wc = writeClient(w.chainId, provider, account)
    const hash = await submitTransaction({ chainId: w.chainId, account, kind: 'redeem', payload: transactionPayload(contract, bridgeAbi, 'redeem', args) }, guard,
      () => wc.writeContract({ address: contract, abi: bridgeAbi, functionName: 'redeem', args, chain: wc.chain, account }))
    const url = evmTxUrl(w.chainId, hash)
    toast(step === 'redeem' ? 'Redeem 1 of 2 submitted' : 'Redeem 2 of 2 submitted', 'wait', url ? { href: url, label: 'View' } : undefined)
    await successfulReceipt(reader, w.chainId, hash)
    const [redeemedAt] = await reader.readContract({ address: contract, abi: bridgeAbi, functionName: 'redeemsInfo', args: [BigInt('0x' + w.id)] })
    if (step === 'redeem' && redeemedAt === 0n || step === 'finish' && redeemedAt !== (1n << 256n) - 1n) throw new Error('Receipt succeeded but the expected redemption state is not established')
    toast(step === 'redeem' ? 'Step 1 confirmed. Finish after the delay.' : 'Redeem confirmed', 'ok')
    await refreshActivity()
  } catch (err) {
    toastError(err)
  } finally {
    activity.busy[i.key] = false
  }
}

async function redeemUnwrap(i: Item) {
  const u = i.unwrap!
  if (!syrius.address) {
    try {
      await connectSyrius()
    } catch (err) {
      return toastError(err)
    }
  }
  activity.busy[i.key] = true
  try {
    const guard = () => { if (i.context !== activity.context || !freshHistory()) throw new Error('Refresh this request on its original network before redeeming') }
    const hash = await sendBlock(redeemBlock(u.transactionHash, u.logIndex), guard)
    toast('Redeem submitted. Waiting for confirmation.', 'wait', { href: config.zenonExplorerTx(hash), label: 'View' })
    setTimeout(refreshActivity, 25_000)
  } catch (err) {
    toastError(err)
  } finally {
    activity.busy[i.key] = false
  }
}

function act(i: Item) {
  return i.kind === 'wrap' ? redeemWrap(i) : redeemUnwrap(i)
}

const sourceUrl = (i: Item) => (i.kind === 'wrap' ? config.zenonExplorerTx(i.sourceTx) : evmTxUrl(i.chainId, i.sourceTx.startsWith('0x') ? i.sourceTx : '0x' + i.sourceTx))
const toUrl = (i: Item) => (i.kind === 'wrap' ? evmAddressUrl(i.chainId, i.toAddress) : config.zenonExplorerAddress(i.toAddress))
const symbolFor = (i: Item) => (i.kind === 'wrap' ? (routeByZts(i.chainId, i.wrap?.tokenStandard ?? '')?.evm?.symbol ?? i.symbol) : i.symbol)
// While the bridge is down a request waiting for signers is not progressing,
// so it says so instead of spinning.
function shownStatus(i: Item) {
  const s = i.status
  if (bridgeDown() && (s.state === 'signing' || s.state === 'confirming')) return { tone: 'danger' as const, label: 'Stalled', spin: false }
  return { tone: s.tone, label: s.step ? `${s.label} ${s.step}` : s.label, spin: s.state === 'signing' || s.state === 'confirming' }
}
// The plasma fill appears once per view (RULES.md section 3): on the first
// request that needs the user. The others get a plain button.
const firstAction = computed(() => shown.value.find(isAction)?.key)
const connectedNothing = computed(() => !evm.account && !syrius.address && !activity.local.length && !activity.watched.length)
</script>

<template>
  <section class="rise grid grid-cols-1 gap-5">
    <OperationRecovery />
    <p v-if="activity.error || activity.storageError" class="note warn" role="status">{{ activity.error || activity.storageError }}. Previously observed rows may be stale.</p>
    <div class="flex flex-wrap items-center gap-3">
      <h1 class="text-2xl font-semibold">Activity</h1>
      <button class="btn btn-ghost btn-sm" :disabled="activity.loading" aria-label="Refresh" @click="refreshActivity">
        <RefreshCw :size="15" :class="{ spin: activity.loading }" />
      </button>
      <div class="flex-1" />
      <button class="btn btn-sm" data-testid="track-open" @click="trackOpen = true">
        <Search :size="14" />Track<span v-if="activity.watched.length" class="mono text-dim">{{ activity.watched.length }}</span>
      </button>
    </div>

    <!-- Following an address without a wallet: wanted rarely, so one tap away. -->
    <Modal :open="trackOpen" title="Track an address" @close="trackOpen = false">
      <form class="flex gap-2" @submit.prevent="addWatch">
        <input v-model="watchText" class="field mono text-sm" placeholder="z1… or 0x…" aria-label="Track an address" spellcheck="false" />
        <button class="btn" :disabled="!watchValid">Track</button>
      </form>
      <div v-if="activity.watched.length" class="mt-3 grid gap-1">
        <div v-for="a in activity.watched" :key="a" class="menu-row !px-0">
          <span class="mono min-w-0 flex-1 truncate" :title="a">{{ a.slice(0, 12) }}…{{ a.slice(-6) }}</span>
          <button class="icon-btn !h-9 !w-9" :aria-label="'Stop tracking ' + a" @click="setWatched(activity.watched.filter((x) => x !== a))"><X :size="14" /></button>
        </div>
      </div>
    </Modal>

    <div class="tabs flex gap-1 overflow-x-auto">
      <button v-for="f in FILTERS" :key="f.id" class="tab" :class="{ active: filter === f.id }" @click="filter = f.id">
        {{ f.label }} <span class="mono text-dim">{{ counts[f.id] }}</span>
      </button>
    </div>

    <div v-if="connectedNothing" class="panel grid place-items-center gap-2 p-10 text-center text-soft">
      <p>Connect a wallet or track an address.</p>
    </div>
    <div v-else-if="!activity.loadedOnce && activity.error" class="panel p-10 text-center text-soft">History unavailable. Retry the original network.</div>
    <div v-else-if="!activity.loadedOnce" class="grid gap-2">
      <div v-for="n in 3" :key="n" class="skeleton h-[76px]" />
    </div>
    <div v-else-if="!shown.length" class="panel p-10 text-center text-soft">None yet</div>

    <TransitionGroup v-else name="row" tag="div" class="grid gap-2">
      <article v-for="i in shown" :key="i.key" class="row panel" data-testid="activity-row" :data-kind="i.kind" :data-state="i.status.state" :data-key="i.key" :data-source-tx="i.sourceTx.replace(/^0x/, '')">
        <div class="flex min-w-0 items-center gap-3">
          <!-- What arrives, on the chain it arrives on. -->
          <TokenIcon :symbol="symbolFor(i)" :chain="i.kind === 'wrap' ? evmChain(i.chainId).name : 'Zenon'" :size="40" />
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-x-2 text-[15px]">
              <Amount :value="i.amount" :decimals="i.decimals" :symbol="symbolFor(i)" />
              <span v-if="i.bonus" class="chip chip-new">Referral</span>
            </div>
            <div class="flex flex-wrap items-center gap-x-1.5 text-sm text-dim">
              <span>{{ i.kind === 'wrap' ? 'Zenon' : evmChain(i.chainId).name }}</span>
              <ArrowRight :size="12" />
              <span>{{ i.kind === 'wrap' ? evmChain(i.chainId).name : 'Zenon' }}</span>
              <span class="mx-1">·</span>
              <Address :value="i.toAddress" :href="toUrl(i)" :copy="false" />
              <span class="mx-1 hidden md:inline">·</span>
              <span class="hidden md:inline">{{ ago(i.createdAt, now) }}</span>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-3 md:justify-end">
          <span v-if="left(i) > 0 && !bridgeDown()" class="mono text-sm text-soft" title="Estimated time left">{{ clock(left(i)) }}</span>
          <StatusChip v-bind="shownStatus(i)" />
          <Address v-if="sourceUrl(i)" :value="i.sourceTx" :href="sourceUrl(i)" :head="4" :tail="4" :copy="false" class="hidden text-xs text-dim md:inline-flex" />
          <button v-if="isAction(i)" data-testid="activity-action" class="btn btn-sm min-w-[96px]" :class="{ 'btn-plasma': i.key === firstAction }" :disabled="activity.busy[i.key] || !!activity.error || !activity.readAt" @click="act(i)">
            <Loader2 v-if="activity.busy[i.key]" :size="14" class="spin" />
            {{ i.status.state === 'finish' ? 'Finish' : 'Redeem' }}
          </button>
        </div>
      </article>
    </TransitionGroup>
  </section>
</template>

<style scoped>
/* Rows fade in. A leaving row goes at once: one that lingers holds its place,
   and the rows under it jump when it lets go, right where a button was. */
.row-enter-active {
  transition:
    opacity 220ms var(--ease),
    transform 220ms var(--spring);
}
.row-enter-from {
  opacity: 0;
  transform: translateY(6px);
}
.row-leave-active {
  display: none;
}
.row {
  display: grid;
  gap: 12px;
  padding: 16px 18px;
  transition:
    border-color 150ms var(--ease),
    transform 150ms var(--ease);
}
.row:hover {
  border-color: var(--line-strong);
  transform: translateY(-1px);
}
@media (min-width: 700px) {
  .row {
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
  }
}
.tabs {
  scrollbar-width: none;
}
.tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 14px;
  border-radius: 999px;
  border: 1px solid var(--line);
  color: var(--soft);
  font-size: 14px;
  white-space: nowrap;
  transition:
    background 150ms var(--ease),
    color 150ms var(--ease),
    border-color 150ms var(--ease);
}
.tab:hover {
  color: var(--fg);
  border-color: var(--line-strong);
}
.tab.active {
  color: var(--fg);
  background: var(--raised);
  border-color: var(--line-strong);
}
</style>
