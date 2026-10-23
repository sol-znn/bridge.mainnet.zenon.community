// Per-network settings. Only what the chain cannot tell us lives here:
// networks, token pairs, fees and delays are read from
// `embedded.bridge.getAllNetworks` at run time, so a pair added on chain shows
// up without a release.
//
// VITE_NETWORK picks the set at build time. `mainnet` is the default and the
// deployment; `devnet` is what the e2e harness runs against (e2e/README.md).

import type { SwapConfig } from './core/swap.ts'

export interface EvmChainConfig {
  name: string
  short: string
  nativeSymbol: string
  explorer: string
  /** Read-only fallback when no wallet is connected or it is on another chain. */
  rpc: string
  icon: 'eth' | 'bnb' | 'generic'
  /** Uniswap V2 pool for the liquidity program, where there is one. */
  liquidity?: { router: `0x${string}`; pair: `0x${string}`; weth: `0x${string}`; info: string }
  testnet?: boolean
}

export interface NetworkConfig {
  name: 'mainnet' | 'devnet'
  label: string
  zenonChainId: number
  /**
   * What the page reads from unless the user switches to the wallet's node:
   * the first that answers, so the ones after the first are only a fallback.
   * The original's syrius-mainnet.zenon.community answers 404 since 2026 and
   * is not in the list.
   */
  defaultNodes: string[]
  /** The one in use; set at run time from defaultNodes. */
  defaultNode: string
  zenonExplorerTx: (hash: string) => string
  zenonExplorerAddress: (address: string) => string
  evm: Record<number, EvmChainConfig>
  plasmaBot: { url: string; token: string; page: string; mode?: 'direct' | 'proxy' }
  buyZnn: string
  /** EVM-to-EVM swaps that do not use the bridge, where a router serves the chains. */
  swap?: SwapConfig
}

// The chain the node in use is on, set by state/zenon.ts. The explorers below
// index one chain; on any other they have nothing to show, so no link is made.
let activeChain = 0
export function setActiveChain(id: number) {
  activeChain = id
}
const onOwnChain = () => !activeChain || activeChain === config.zenonChainId

// Vite fills import.meta.env; under plain Node (the e2e scripts) there is none.
const env: Partial<ImportMetaEnv> = import.meta.env ?? {}

function evmRpcOverrides(): Record<number, string> {
  try {
    return env.VITE_EVM_RPCS ? (JSON.parse(env.VITE_EVM_RPCS) as Record<number, string>) : {}
  } catch {
    return {}
  }
}

const mainnet: NetworkConfig = {
  name: 'mainnet',
  label: 'Mainnet',
  zenonChainId: 1,
  defaultNodes: ['wss://my.hc1node.com:35998', 'wss://node.zenonhub.io:35998'],
  defaultNode: 'wss://my.hc1node.com:35998',
  zenonExplorerTx: (h) => (onOwnChain() ? `https://zenonhub.io/explorer/transaction/${h}` : ''),
  zenonExplorerAddress: (a) => (onOwnChain() ? `https://zenonhub.io/explorer/account/${a}` : ''),
  evm: {
    1: {
      name: 'Ethereum',
      short: 'ETH',
      nativeSymbol: 'ETH',
      explorer: 'https://etherscan.io',
      rpc: 'https://ethereum-rpc.publicnode.com',
      icon: 'eth',
      liquidity: {
        router: '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D',
        pair: '0xdac866A3796F85Cb84A914d98fAeC052E3b5596D',
        weth: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
        info: 'https://app.uniswap.org/explore/pools/ethereum/0xdac866A3796F85Cb84A914d98fAeC052E3b5596D',
      },
    },
    56: {
      name: 'BNB Chain',
      short: 'BSC',
      nativeSymbol: 'BNB',
      explorer: 'https://bscscan.com',
      rpc: 'https://bsc-rpc.publicnode.com',
      icon: 'bnb',
    },
  },
  plasmaBot: {
    url: env.VITE_PLASMA_BOT_URL || 'https://zenonhub.io/api/utilities/plasma-bot/fuse',
    mode: env.VITE_PLASMA_BOT_URL ? 'proxy' : 'direct',
    token: env.VITE_PLASMA_BOT_TOKEN || '',
    page: 'https://zenonhub.io/tools/plasma-bot',
  },
  buyZnn: 'https://app.uniswap.org/swap?outputCurrency=0xb2e96a63479C2Edd2FD62b382c89D5CA79f572d3',
  // Each router's contract is the same address on both chains.
  swap: {
    chains: [1, 56],
    kyber: { api: 'https://aggregator-api.kyberswap.com', router: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5', slugs: { 1: 'ethereum', 56: 'bsc' } },
    across: { api: 'https://app.across.to/api', router: '0x97CCDBea4632140639aD5eA9b944aa034eb15fD4' },
    lifi: { api: 'https://li.quest/v1', router: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', scan: 'https://scan.li.fi/tx/' },
  },
}

// The bridge lab (e2e/lab): go-zenon's devnet with the bridge spork active,
// chain 322, and anvil. Ports are the lab's own.
const devnet: NetworkConfig = {
  name: 'devnet',
  label: 'Devnet',
  zenonChainId: 322,
  defaultNodes: [env.VITE_ZNN_NODE || 'ws://127.0.0.1:46998'],
  defaultNode: env.VITE_ZNN_NODE || 'ws://127.0.0.1:46998',
  zenonExplorerTx: () => '',
  zenonExplorerAddress: () => '',
  evm: {
    31337: {
      name: 'Anvil',
      short: 'ANV',
      nativeSymbol: 'ETH',
      explorer: '',
      rpc: 'http://127.0.0.1:46545',
      icon: 'eth',
      testnet: true,
    },
  },
  plasmaBot: { url: env.VITE_PLASMA_BOT_URL || '', token: env.VITE_PLASMA_BOT_TOKEN || '', page: '', mode: env.VITE_PLASMA_BOT_URL ? 'proxy' : 'direct' },
  buyZnn: '',
}

function pick(): NetworkConfig {
  const c = env.VITE_NETWORK === 'devnet' ? devnet : mainnet
  if (env.VITE_ZNN_NODE) c.defaultNodes = env.VITE_ZNN_NODE.split(',').map((s) => s.trim())
  c.defaultNode = c.defaultNodes[0]
  for (const [id, url] of Object.entries(evmRpcOverrides())) if (c.evm[Number(id)]) c.evm[Number(id)].rpc = url
  return c
}

export const config: NetworkConfig = pick()

/**
 * A name for a Zenon chain identifier. 1 and 3 are the public networks; every
 * other identifier is somebody's devnet (go-zenon's default is 321, Syrius
 * ships one on 69), told apart by the number shown next to the name.
 */
export function zenonNetworkName(chainId: number): string {
  return chainId === 1 ? 'Mainnet' : chainId === 3 ? 'Testnet' : 'Devnet'
}

// Every EVM chain either build knows. The wallet's node may put a mainnet
// build on the lab's chain, whose bridge then names anvil.
const knownEvm: Record<number, EvmChainConfig> = { ...mainnet.evm, ...devnet.evm }

export function evmChain(chainId: number): EvmChainConfig {
  return (
    config.evm[chainId] ??
    knownEvm[chainId] ?? {
      name: `Chain ${chainId}`,
      short: String(chainId),
      nativeSymbol: 'ETH',
      explorer: '',
      rpc: '',
      icon: 'generic',
    }
  )
}

export function evmTxUrl(chainId: number, hash: string): string {
  const e = evmChain(chainId).explorer
  return e ? `${e}/tx/${hash}` : ''
}

export function evmAddressUrl(chainId: number, address: string): string {
  const e = evmChain(chainId).explorer
  return e ? `${e}/address/${address}` : ''
}

// Embedded contracts, the same on every network.
export const BRIDGE = 'z1qxemdeddedxdrydgexxxxxxxxxxxxxxxmqgr0d'
export const LIQUIDITY = 'z1qxemdeddedxlyquydytyxxxxxxxxxxxxflaaae'
export const NETWORK_CLASS_EVM = 2
