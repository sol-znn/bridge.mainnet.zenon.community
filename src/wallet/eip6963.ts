// EVM wallets, found by EIP-6963: each installed wallet announces itself
// (name, icon, rdns, provider) in answer to `eip6963:requestProvider`, so
// MetaMask, Rabby, Phantom, Coinbase and the rest can sit side by side
// without fighting over `window.ethereum`. A wallet that predates EIP-6963 is
// still offered through `window.ethereum`.

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>
  on?(event: string, handler: (...args: never[]) => void): void
  removeListener?(event: string, handler: (...args: never[]) => void): void
}

export interface WalletInfo {
  uuid: string
  name: string
  icon: string
  rdns: string
}

export interface DiscoveredWallet {
  info: WalletInfo
  provider: Eip1193Provider
}

interface AnnounceEvent extends Event {
  detail: DiscoveredWallet
}

/**
 * Starts listening and asks wallets to announce. `onChange` gets the full list
 * each time one arrives. Returns a stop function.
 */
export function discoverWallets(onChange: (wallets: DiscoveredWallet[]) => void): () => void {
  const found = new Map<string, DiscoveredWallet>()
  const onAnnounce = (e: Event) => {
    const d = (e as AnnounceEvent).detail
    if (!d?.info?.uuid || !d.provider) return
    // One entry per wallet even if it announces twice (some do on reload).
    found.set(d.info.rdns || d.info.uuid, d)
    onChange([...found.values()])
  }
  window.addEventListener('eip6963:announceProvider', onAnnounce)
  window.dispatchEvent(new Event('eip6963:requestProvider'))

  // A wallet without EIP-6963: offer window.ethereum once the others had a
  // moment to announce, unless one of them is that same provider.
  const legacy = setTimeout(() => {
    const eth = (window as unknown as { ethereum?: Eip1193Provider & Record<string, unknown> }).ethereum
    if (!eth || [...found.values()].some((w) => w.provider === eth)) return
    if (found.size) return
    const name = eth.isRabby ? 'Rabby' : eth.isPhantom ? 'Phantom' : eth.isMetaMask ? 'MetaMask' : 'Browser wallet'
    found.set('injected', { info: { uuid: 'injected', name, icon: '', rdns: 'injected' }, provider: eth })
    onChange([...found.values()])
  }, 600)

  return () => {
    clearTimeout(legacy)
    window.removeEventListener('eip6963:announceProvider', onAnnounce)
  }
}

export class EvmWalletError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
  }
  get declined() {
    return this.code === 4001
  }
}

export function translateEvmError(err: unknown): EvmWalletError {
  const e = err as { code?: number; message?: string; shortMessage?: string; details?: string; cause?: unknown }
  const code = typeof e?.code === 'number' ? e.code : 0
  if (code === 4001) return new EvmWalletError(code, 'Declined in wallet')
  const reason = (e?.details || e?.shortMessage || e?.message || String(err)).split('\n')[0]
  return new EvmWalletError(code, reason)
}

export async function requestAccounts(p: Eip1193Provider): Promise<string[]> {
  try {
    return (await p.request({ method: 'eth_requestAccounts' })) as string[]
  } catch (err) {
    throw translateEvmError(err)
  }
}

export async function chainIdOf(p: Eip1193Provider): Promise<number> {
  const value = await p.request({ method: 'eth_chainId' })
  if (!['string', 'number'].includes(typeof value)) throw new Error('Wallet chain identity is unavailable')
  const id = Number(value)
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Wallet chain identity is unavailable')
  return id
}

export async function switchChain(
  p: Eip1193Provider,
  chainId: number,
  add?: { name: string; rpc: string; nativeSymbol: string; explorer: string },
): Promise<void> {
  const hex = `0x${chainId.toString(16)}`
  try {
    await p.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  } catch (err) {
    // 4902: the wallet does not know the chain. Offer to add it.
    if ((err as { code?: number })?.code === 4902 && add?.rpc) {
      await p.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: hex,
            chainName: add.name,
            rpcUrls: [add.rpc],
            nativeCurrency: { name: add.nativeSymbol, symbol: add.nativeSymbol, decimals: 18 },
            blockExplorerUrls: add.explorer ? [add.explorer] : undefined,
          },
        ],
      })
      return
    }
    throw translateEvmError(err)
  }
}

export async function watchAsset(p: Eip1193Provider, token: { address: string; symbol: string; decimals: number }): Promise<boolean> {
  try {
    return Boolean(
      await p.request({
        method: 'wallet_watchAsset',
        params: { type: 'ERC20', options: { address: token.address, symbol: token.symbol.slice(0, 11), decimals: token.decimals } },
      }),
    )
  } catch (err) {
    throw translateEvmError(err)
  }
}
