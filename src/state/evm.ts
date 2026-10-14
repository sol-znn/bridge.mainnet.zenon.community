// The EVM wallet the user picked from the ones EIP-6963 found.

import { reactive, markRaw } from 'vue'
import {
  discoverWallets,
  requestAccounts,
  chainIdOf,
  switchChain,
  type DiscoveredWallet,
  type Eip1193Provider,
} from '../wallet/eip6963.ts'
import { evmChain } from '../config.ts'
import { isEvmRecipient } from '../core/recipient.ts'

const LAST = 'bridge.evmWallet'

export const evm = reactive({
  wallets: [] as DiscoveredWallet[],
  selected: null as DiscoveredWallet | null,
  account: null as `0x${string}` | null,
  chainId: null as number | null,
  busy: false,
  pickerOpen: false,
})

let detach: (() => void) | null = null
let epoch = 0
let reconnecting = false
const validAccount = (accounts: unknown): `0x${string}` | null => Array.isArray(accounts) && typeof accounts[0] === 'string' && isEvmRecipient(accounts[0]) ? accounts[0] as `0x${string}` : null

export function startEvmDiscovery() {
  discoverWallets((list) => {
    evm.wallets = list.map((w) => markRaw(w))
    // Reconnect silently to the wallet used last time, if it still authorises us.
    const last = safeGet(LAST)
    if (!evm.selected && last && !reconnecting && !evm.busy) {
      const w = list.find((x) => x.info.rdns === last)
      if (w) void reconnect(w)
    }
  })
}

async function reconnect(w: DiscoveredWallet) {
  const request = epoch
  reconnecting = true
  try {
    const accounts = await w.provider.request({ method: 'eth_accounts' })
    if (request === epoch && validAccount(accounts)) await bind(w, accounts, request)
  } catch {
    /* needs a prompt; wait for the user */
  } finally { reconnecting = false }
}

async function bind(w: DiscoveredWallet, accounts: unknown, request: number) {
  if (request !== epoch) return
  const account = validAccount(accounts)
  if (!account) throw new Error('Wallet did not return a valid account')
  detach?.()
  evm.selected = markRaw(w)
  evm.account = account
  evm.chainId = null
  safeSet(LAST, w.info.rdns)
  const current = () => request === epoch && evm.selected?.provider === w.provider
  let chainRevision = 0
  const onAccounts = (a: unknown) => {
    if (!current()) return
    if (!validAccount(a)) return disconnectEvm()
    evm.account = validAccount(a)
  }
  const onChain = (id: string) => {
    if (!current()) return
    chainRevision++
    const value = Number(id)
    evm.chainId = Number.isSafeInteger(value) && value > 0 ? value : null
  }
  const onDisconnect = () => { if (current()) disconnectEvm() }
  w.provider.on?.('accountsChanged', onAccounts as never)
  w.provider.on?.('chainChanged', onChain as never)
  w.provider.on?.('disconnect', onDisconnect as never)
  detach = () => {
    w.provider.removeListener?.('accountsChanged', onAccounts as never)
    w.provider.removeListener?.('chainChanged', onChain as never)
    w.provider.removeListener?.('disconnect', onDisconnect as never)
  }
  const revision = chainRevision
  const chain = await chainIdOf(w.provider)
  if (current() && revision === chainRevision) evm.chainId = chain
}

export async function connectEvm(w: DiscoveredWallet) {
  const request = ++epoch
  detach?.(); detach = null
  evm.selected = null; evm.account = null; evm.chainId = null
  evm.busy = true
  try {
    await bind(w, await requestAccounts(w.provider), request)
  } finally {
    if (request === epoch) evm.busy = false
  }
}

export function disconnectEvm() {
  epoch++
  detach?.()
  detach = null
  evm.selected = null
  evm.account = null
  evm.chainId = null
  evm.busy = false
  safeSet(LAST, '')
}

export async function ensureChain(chainId: number) {
  if (!evm.selected) throw new Error('Connect an EVM wallet first')
  if (evm.chainId === chainId) return
  const provider = evm.selected.provider, request = epoch
  const c = evmChain(chainId)
  await switchChain(provider, chainId, { name: c.name, rpc: c.rpc, nativeSymbol: c.nativeSymbol, explorer: c.explorer })
  const reported = await chainIdOf(provider)
  if (request !== epoch || evm.selected?.provider !== provider) throw new Error('Wallet changed during the network switch')
  evm.chainId = reported
  if (evm.chainId !== chainId) throw new Error(`Switch your wallet to ${c.name}`)
}

/** The wallet as readClient wants it, or null. */
export function walletForReads(): { provider: Eip1193Provider; chainId: number } | null {
  return evm.selected && evm.chainId ? { provider: evm.selected.provider, chainId: evm.chainId } : null
}

function safeGet(k: string) {
  try {
    return localStorage.getItem(k)
  } catch {
    return null
  }
}
function safeSet(k: string, v: string) {
  try {
    if (v) localStorage.setItem(k, v)
    else localStorage.removeItem(k)
  } catch {
    /* ignore */
  }
}
