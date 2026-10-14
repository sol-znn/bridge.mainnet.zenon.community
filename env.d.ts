/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<object, object, unknown>
  export default component
}

interface ImportMetaEnv {
  /** `mainnet` (default) or `devnet`. Picks the network set in src/config.ts. */
  readonly VITE_NETWORK?: string
  /** Overrides the Zenon node used when the wallet's node cannot be reached. */
  readonly VITE_ZNN_NODE?: string
  /** JSON object of chain id to EVM RPC URL, for reads with no wallet connected. */
  readonly VITE_EVM_RPCS?: string
  readonly VITE_PLASMA_BOT_URL?: string
  readonly VITE_BASE?: string
}
