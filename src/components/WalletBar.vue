<script setup lang="ts">
// One button for both wallets: Syrius for Zenon, any EIP-6963 wallet for EVM.
// The menu behind it holds each wallet's address and its controls, and, one
// level further in, which node the page reads from.
import { computed, ref, watch } from 'vue'
import { Wallet, LogOut, Repeat, Download, Loader2, ChevronDown, Server } from '@lucide/vue'
import Modal from './Modal.vue'
import Address from './Address.vue'
import TokenIcon from './TokenIcon.vue'
import syriusLogo from '../assets/syrius-logo.svg'
import {
  syrius,
  connectSyrius,
  disconnectSyrius,
  node,
  hostOf,
  chainId,
  networkLabel,
  walletNode,
  requestWalletNode,
  confirmWalletNode,
  cancelWalletNode,
  useDefaultNode,
} from '../state/zenon.ts'
import { evm, connectEvm, disconnectEvm } from '../state/evm.ts'
import { evmChain, zenonNetworkName } from '../config.ts'
import { shorten } from '../core/format.ts'
import { toastError } from '../state/toasts.ts'
import type { DiscoveredWallet } from '../wallet/eip6963.ts'

const open = ref(false)
const nodeOpen = ref(false)

async function onSyrius() {
  if (!syrius.present) return window.open('https://github.com/DexterLabZ/syrius-extension/releases', '_blank', 'noopener')
  try {
    await connectSyrius()
  } catch (err) {
    toastError(err)
  }
}

async function pick(w: DiscoveredWallet) {
  try {
    await connectEvm(w)
    evm.pickerOpen = false
  } catch (err) {
    toastError(err)
  }
}

function openPicker() {
  open.value = false
  evm.pickerOpen = true
}

function toggleNode() {
  if (node.source === 'wallet') useDefaultNode()
  else void requestWalletNode()
}
// The confirmation is a dialog of its own; the menu steps aside for it.
watch(
  () => walletNode.pending,
  (p) => p && (open.value = false),
)

const chainName = computed(() => (evm.chainId ? evmChain(evm.chainId).name : ''))
const count = computed(() => Number(!!syrius.address) + Number(!!evm.account))
const label = computed(() => {
  if (syrius.hold) return `${syrius.hold}s`
  if (count.value === 1) return shorten(syrius.address ?? evm.account ?? '', 5, 4)
  return ''
})
</script>

<template>
  <div class="relative">
    <button
      data-testid="wallet-menu"
      class="btn btn-sm !min-h-[44px]"
      :class="count ? 'connected' : 'btn-fg'"
      :aria-expanded="open"
      :aria-label="count ? 'Wallets' : 'Connect wallet'"
      @click="open = !open"
    >
      <template v-if="count">
        <span class="stack">
          <img v-if="syrius.address" :src="syriusLogo" width="20" height="20" alt="" class="rounded-md" />
          <template v-if="evm.account">
            <img v-if="evm.selected?.info.icon" :src="evm.selected.info.icon" width="20" height="20" alt="" class="rounded-md" />
            <TokenIcon v-else :network="chainName" :size="20" />
          </template>
        </span>
        <span v-if="label" class="mono hidden md:inline">{{ label }}</span>
        <ChevronDown :size="14" class="chev text-dim" :class="{ up: open }" />
      </template>
      <template v-else><span class="md:hidden">Connect</span><span class="hidden md:inline">Connect wallet</span></template>
    </button>

    <div v-if="open" class="backdrop" data-testid="wallet-backdrop" @click="open = false" />
    <Transition name="pop">
      <div v-if="open" class="popover menu">
        <div data-testid="wallet-zenon" class="wallet-row">
          <img :src="syriusLogo" width="32" height="32" alt="" class="rounded-lg" />
          <div class="min-w-0 flex-1">
            <div class="label">Zenon</div>
            <Address v-if="syrius.address" :value="syrius.address" class="text-sm" />
            <div v-else class="text-sm text-soft">Syrius</div>
          </div>
          <button v-if="syrius.address" class="icon-btn sm" aria-label="Disconnect Syrius" @click="disconnectSyrius"><LogOut :size="15" /></button>
          <button v-else data-testid="wallet-zenon-connect" class="btn btn-sm" :disabled="syrius.busy" @click="onSyrius">
            <Loader2 v-if="syrius.busy" :size="14" class="spin" /><Download v-else-if="!syrius.present" :size="14" />
            {{ syrius.hold ? syrius.hold + 's' : syrius.present ? 'Connect' : 'Install' }}
          </button>
        </div>

        <div data-testid="wallet-evm" class="wallet-row">
          <img v-if="evm.selected?.info.icon" :src="evm.selected.info.icon" width="32" height="32" alt="" class="rounded-lg" />
          <span v-else class="grid h-8 w-8 place-items-center rounded-lg bg-raised text-soft"><Wallet :size="16" /></span>
          <div class="min-w-0 flex-1">
            <div class="label truncate">{{ evm.account ? chainName || 'EVM' : 'EVM' }}</div>
            <Address v-if="evm.account" :value="evm.account" class="text-sm" />
            <div v-else class="text-sm text-soft">MetaMask, Rabby, Phantom</div>
          </div>
          <template v-if="evm.account">
            <button class="icon-btn sm" aria-label="Switch wallet" @click="openPicker"><Repeat :size="15" /></button>
            <button class="icon-btn sm" aria-label="Disconnect EVM wallet" @click="disconnectEvm"><LogOut :size="15" /></button>
          </template>
          <button v-else data-testid="wallet-evm-connect" class="btn btn-sm" :disabled="evm.busy" @click="openPicker">Connect</button>
        </div>

        <div class="my-1 border-t border-line" />
        <button class="menu-row" data-testid="node-toggle" :aria-expanded="nodeOpen" @click="nodeOpen = !nodeOpen">
          <Server :size="15" /><span class="flex-1">Node</span>
          <span class="chip chip-dim mono">{{ networkLabel() }} {{ chainId() }}</span>
          <ChevronDown :size="14" class="chev" :class="{ up: nodeOpen }" />
        </button>
        <div v-if="nodeOpen" class="slide-down px-2.5 pb-1">
          <div class="mono truncate text-sm text-soft" :title="node.url">{{ hostOf(node.url) }}</div>
          <button class="node-switch" data-testid="node-switch" :disabled="walletNode.checking || !syrius.address" @click="toggleNode">
            <span class="flex-1 text-left">Use Syrius node</span>
            <Loader2 v-if="walletNode.checking" :size="15" class="spin text-dim" />
            <span class="switch" role="switch" :aria-checked="node.source === 'wallet'" />
          </button>
          <div v-if="walletNode.problem" class="pb-2 text-sm text-warn">{{ walletNode.problem }}</div>
        </div>
      </div>
    </Transition>

    <Modal :open="!!walletNode.pending" title="Confirm network" @close="cancelWalletNode">
      <div v-if="walletNode.pending" class="grid grid-cols-1 gap-4">
        <div class="well grid grid-cols-1 gap-3 p-4">
          <div>
            <div class="label">Network</div>
            <div class="text-2xl font-semibold" data-testid="node-network">{{ zenonNetworkName(walletNode.pending.chainId) }}</div>
          </div>
          <div class="flex gap-6">
            <div>
              <div class="label">Chain</div>
              <div class="mono">{{ walletNode.pending.chainId }}</div>
            </div>
            <div class="min-w-0">
              <div class="label">Syrius node</div>
              <div class="mono truncate" :title="walletNode.pending.url">{{ hostOf(walletNode.pending.url) }}</div>
            </div>
          </div>
        </div>
        <p v-if="walletNode.pending.chainId !== 1" class="text-sm text-warn">Not Mainnet. Tokens here are test tokens.</p>
        <div class="grid grid-cols-2 gap-2">
          <button class="btn" @click="cancelWalletNode">Cancel</button>
          <button class="btn btn-plasma" data-testid="node-confirm" @click="confirmWalletNode">Use {{ zenonNetworkName(walletNode.pending.chainId) }}</button>
        </div>
      </div>
    </Modal>

    <Modal :open="evm.pickerOpen" title="Connect a wallet" @close="evm.pickerOpen = false">
      <div v-if="evm.wallets.length" class="grid gap-2">
        <button v-for="w in evm.wallets" :key="w.info.uuid" data-testid="wallet-option" class="pick" @click="pick(w)">
          <img v-if="w.info.icon" :src="w.info.icon" width="32" height="32" alt="" class="rounded-lg" />
          <Wallet v-else :size="22" />
          {{ w.info.name }}
        </button>
      </div>
      <p v-else class="text-soft">No EVM wallet found. Install MetaMask, Rabby or Phantom and reload.</p>
    </Modal>
  </div>
</template>

<style scoped>
.connected {
  --btn-line: color-mix(in srgb, var(--znn) 35%, var(--line-strong));
  padding: 0 12px 0 8px;
}
.stack {
  display: inline-flex;
}
.stack > * + * {
  margin-left: -6px;
  box-shadow: 0 0 0 2px var(--raised);
}
.chev {
  transition: transform 220ms var(--spring);
}
.chev.up {
  transform: rotate(180deg);
}
/* On a phone the button is not at the screen's edge, so the menu is placed
   against the screen instead of against the button. */
.menu {
  position: fixed;
  top: 68px;
  right: 16px;
  left: 16px;
}
@media (min-width: 700px) {
  .menu {
    position: absolute;
    top: calc(100% + 10px);
    right: 0;
    left: auto;
    width: 340px;
  }
}
.wallet-row {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 60px;
  padding: 8px 10px;
  border-radius: var(--radius);
}
.icon-btn.sm {
  width: 36px;
  height: 36px;
}
.node-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  font-size: 14px;
  color: var(--soft);
}
.node-switch:hover:not(:disabled) {
  color: var(--fg);
}
.node-switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.pick {
  display: flex;
  align-items: center;
  gap: 14px;
  min-height: 60px;
  padding: 0 14px;
  border-radius: var(--radius);
  border: 1px solid var(--line);
  font-size: 16px;
  font-weight: 500;
  transition:
    background 180ms var(--ease),
    border-color 180ms var(--ease),
    transform 220ms var(--spring);
}
.pick:hover {
  background: var(--raised);
  border-color: var(--line-strong);
  transform: translateY(-1px);
}
.pick:active {
  transform: scale(0.98);
}
</style>
