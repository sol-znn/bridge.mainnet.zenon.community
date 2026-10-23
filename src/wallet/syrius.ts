// The Syrius browser extension. From the ptlc lab's adapter
// (zenon-ptlc/lab/web/src/wallet/syrius.ts), written for v0.3.4 and later;
// extensions older than v0.2.0 speak the postMessage protocol the original
// bridge used, handled in syriusLegacy.ts.
//
// Syrius signs any account block a page hands it:
//
//   - the page decides toAddress, amount, tokenStandard and data;
//   - the extension supplies the account, the public key, the chain position,
//     the plasma or proof of work, and the signature.
//
// What v0.3.4 changed for a page, and what this file does about each:
//
//   - A site sees no address, chain or node until it is approved, and after
//     that only the node's host (`ws://host:port`).
//   - An approval is single use, expires after 30 minutes, and belongs to the
//     document that asked: a navigation or a rewritten document cancels it.
//     The bridge is one document routed by its fragment, which is not a
//     navigation, and it never reloads itself.
//   - At most two approvals may wait per origin. Requests that prompt go
//     through one queue here, so a second is not sent while one is open.
//   - The wallet will not raise a second window for one site within 30 s of
//     the last, unless the last was approved (which buys one follow-up). A
//     request that arrives inside that time is refused at once with -32005
//     and no window. Nothing was shown and nothing was signed, so the request
//     is held here until the 30 s have passed and then made again.
//   - The wallet prepares the block once, shows it, and signs exactly that.
//     Other failures retain the original operation for exact reconciliation.

import type { BlockJson } from '../znn/block.ts'
import { NotSubmittedError } from '../core/errors.ts'
import { isUserAddress } from '../znn/primitives.ts'
import { legacyPresent, legacyConnect, legacySend } from './syriusLegacy.ts'

export interface ZenonProvider {
  version?: number | string
  isSyriusExtension?: boolean
  connect(): Promise<unknown>
  disconnect(): Promise<unknown>
  getAccounts(): Promise<string[]>
  getChainId(): Promise<number | string | null>
  getNodeUrl(): Promise<string | null>
  sendAccountBlock(block: unknown): Promise<SendAccountBlockResult>
  signMessage?(message: string): Promise<SignMessageResult>
  on?(event: string, handler: (...args: unknown[]) => void): void
  removeListener?(event: string, handler: (...args: unknown[]) => void): void
}

/**
 * v0.2.0 changed this from `{signedTransaction}` to `{hash, block}`. Both are
 * read, so that the hash is found whichever arrived.
 */
export interface SendAccountBlockResult {
  hash?: string
  block?: Partial<BlockJson>
  signedTransaction?: Partial<BlockJson>
}

export interface SignMessageResult {
  message: string
  address: string
  publicKey: string
  signature: string
}

declare global {
  interface Window {
    zenon?: ZenonProvider
    ethereum?: { syrius?: { version?: string; zvm?: number } }
  }
}

export class WalletError extends Error {
  readonly code: number
  constructor(code: number, message: string) {
    super(message)
    this.code = code
    this.name = 'WalletError'
  }
  get declined(): boolean {
    return this.code === 4001
  }
}

/** Thrown here, before any request reaches an extension; never a provider code. */
export const WALLET_NOT_FOUND = -1

/**
 * Rejections arrive as `{code, message}`, a plain object and not an Error. The
 * wallet's own sentence is kept whenever it has one: it names the cause (the
 * account changed, the approval expired, the page left) better than a code.
 */
function translate(err: unknown): WalletError {
  if (err instanceof WalletError) return err
  const raw = err as { code?: number; message?: string } | undefined
  const code = typeof raw?.code === 'number' ? raw.code : 0
  const detail = String(raw?.message ?? err).trim()
  switch (code) {
    case 4001:
      return new WalletError(code, 'declined in Syrius')
    case 4100:
      return new WalletError(code, 'Syrius is not connected to this page for the account it is on. Connect again.')
    case 4200:
      return new WalletError(code, 'this version of Syrius does not support that request')
    case 4900:
      return new WalletError(code, detail || 'Syrius did not answer')
    case -32005:
      return new WalletError(
        code,
        'Syrius would not open a window: it holds a site off for 30 s after an approval that was declined or closed, and it queues at most two requests per site. Wait half a minute and send it again.',
      )
    default:
      return new WalletError(code, detail || 'Syrius failed without saying why')
  }
}

/**
 * Presence is advisory. The honest test of whether a wallet is there is to ask
 * it and see whether it answers; this only decides what the page says.
 */
export function providerPresent(): boolean {
  return (typeof window !== 'undefined' && typeof window.zenon?.sendAccountBlock === 'function') || legacyPresent()
}

/** An extension older than v0.2.0: postMessage only (syriusLegacy.ts). */
const isLegacy = () => typeof window.zenon?.sendAccountBlock !== 'function' && legacyPresent()
let legacyState: WalletState | null = null

function provider(): ZenonProvider {
  const p = window.zenon
  if (!p) {
    throw new WalletError(
      WALLET_NOT_FOUND,
      'no Zenon wallet in this browser. Install the Syrius extension (v0.3.4 or later) and reload.',
    )
  }
  return p
}

/** Resolves when `window.zenon` exists, or after `ms` if it never does. */
export function whenProviderReady(ms = 1500): Promise<boolean> {
  if (providerPresent()) return Promise.resolve(true)
  return new Promise((resolve) => {
    const done = () => {
      window.removeEventListener('zenon#initialized', done)
      clearTimeout(timer)
      resolve(providerPresent())
    }
    // The provider is injected at document_start, so it is normally already
    // there. The event covers an extension enabled after the page loaded.
    window.addEventListener('zenon#initialized', done)
    const timer = setTimeout(done, ms)
  })
}

/**
 * A reactive object cannot cross `postMessage`: it is structured clone, and a
 * Proxy fails it with "could not be cloned", naming no field. Everything the
 * page holds lives in Vue state, so the round trip happens here, at the
 * transport boundary, for every request.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

// One prompting request at a time. The extension admits two per origin and
// answers a third with -32005; one is what a person can read anyway.
let queue: Promise<unknown> = Promise.resolve()
function exclusive<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job)
  queue = next.catch(() => undefined)
  return next
}

/** How long Syrius holds a site off after a window it did not get a yes in. */
const WINDOW_COOLDOWN_MS = 30_000
let lastAskedAt = 0

export interface PromptOptions {
  /** Called once a second while a request is being held back, with the seconds left. */
  onHold?: (secondsLeft: number) => void
  beforePrompt?: () => void
  account?: string
}

/**
 * Makes a request that raises a wallet window, and makes it again, once, if
 * the wallet refused to raise one because of its per-site cooldown.
 */
async function prompting<T>(ask: () => Promise<T>, options: PromptOptions = {}): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const previous = lastAskedAt
    lastAskedAt = Date.now()
    try {
      try { options.beforePrompt?.() } catch (error) { throw new NotSubmittedError(error instanceof Error ? error.message : 'Operation context changed before the wallet request') }
      return await ask()
    } catch (err) {
      if (err instanceof NotSubmittedError) throw err
      const code = (err as { code?: number } | undefined)?.code
      if (code !== -32005 || attempt >= 2) throw translate(err)
      // The cooldown runs from when the last window opened, which is when it
      // was last asked for; a second and a half on top covers the round trip.
      const since = previous ? Date.now() - previous : 0
      let wait = Math.max(2500, WINDOW_COOLDOWN_MS - since + 1500)
      if (attempt > 0) wait = WINDOW_COOLDOWN_MS + 1500
      const until = Date.now() + wait
      while (Date.now() < until) {
        options.onHold?.(Math.ceil((until - Date.now()) / 1000))
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
      options.onHold?.(0)
    }
  }
}

export interface WalletState {
  present: boolean
  /** The provider protocol, not the extension's release: 2 since v0.2.0. */
  protocol: string | null
  /** Only v0.4.0 and later say, through `window.ethereum.syrius`. */
  extensionVersion: string | null
  address: string | null
  chainId: number | null
  /** `ws://host:port` and nothing more, since v0.3.4. */
  nodeUrl: string | null
  canSignMessage: boolean
}

/**
 * Reads the wallet without prompting. Before this origin is connected, and
 * whenever the wallet is on an account this origin was not approved for, every
 * one of these is empty; that is the wallet declining to say, not a fault.
 */
export async function readState(): Promise<WalletState> {
  if (isLegacy()) return legacyState ?? { present: true, protocol: '1', extensionVersion: null, address: null, chainId: null, nodeUrl: null, canSignMessage: false }
  const p = window.zenon
  const state: WalletState = {
    present: providerPresent(),
    protocol: p?.version === undefined ? null : String(p.version),
    extensionVersion: window.ethereum?.syrius?.version ?? null,
    address: null,
    chainId: null,
    nodeUrl: null,
    canSignMessage: typeof p?.signMessage === 'function',
  }
  if (!p) return state
  const ask = async <T>(job: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await job()
    } catch {
      return fallback
    }
  }
  const [accounts, chainId, nodeUrl] = await Promise.all([
    ask(() => p.getAccounts(), [] as string[]),
    ask(() => p.getChainId(), null),
    ask(() => p.getNodeUrl(), null),
  ])
  state.address = Array.isArray(accounts) && typeof accounts[0] === 'string' && isUserAddress(accounts[0]) ? accounts[0] : null
  const id = chainId === null || chainId === undefined ? 0 : Number(chainId)
  state.chainId = Number.isSafeInteger(id) && id > 0 ? id : null
  state.nodeUrl = typeof nodeUrl === 'string' && nodeUrl.length <= 2048 ? nodeUrl : null
  return state
}

export function connect(options: PromptOptions = {}): Promise<WalletState> {
  return exclusive(async () => {
    if (isLegacy()) {
      const g = await legacyConnect()
      if (!isUserAddress(g.address) || !Number.isSafeInteger(g.chainId) || g.chainId <= 0 || typeof g.nodeUrl !== 'string' || g.nodeUrl.length > 2048) throw new WalletError(-32603, 'Legacy wallet identity is unavailable')
      legacyState = { present: true, protocol: '1', extensionVersion: null, address: g.address, chainId: g.chainId, nodeUrl: g.nodeUrl, canSignMessage: false }
      return legacyState
    }
    const p = provider()
    await prompting(() => p.connect(), options)
    return readState()
  })
}

export async function disconnect(): Promise<void> {
  if (isLegacy()) {
    legacyState = null
    return
  }
  try {
    await provider().disconnect()
  } catch (err) {
    throw translate(err)
  }
}

export interface SentBlock {
  hash: string
  /** The block as the wallet signed it, when it reported one. */
  block: Partial<BlockJson> | null
}

export class WalletOutcomeError extends WalletError {
  readonly reportedHash?: string
  constructor(message: string, hash?: string) {
    super(-32603, `${message}. The original operation must be reconciled before sending again.`)
    this.reportedHash = typeof hash === 'string' && /^[0-9a-f]{64}$/i.test(hash) ? hash.toLowerCase() : undefined
  }
}

function checkedResult(template: BlockJson, hash: unknown, block: Partial<BlockJson> | null, account?: string): SentBlock {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) throw new WalletOutcomeError('Wallet publication outcome is unknown')
  if (block !== null && (typeof block !== 'object' || Array.isArray(block) || block.hash !== undefined && typeof block.hash !== 'string')) throw new WalletOutcomeError('Wallet response contains a malformed block', hash)
  if (signedBlockDiffers(template, block).length || block?.address && account && block.address !== account || block?.hash && block.hash.toLowerCase() !== hash.toLowerCase()) {
    throw new WalletOutcomeError('Wallet response does not match the original operation', hash)
  }
  return { hash: hash.toLowerCase(), block }
}

/**
 * Hands a complete template to the extension to fill in, show, sign and
 * publish. Resolves when the wallet has published; the block is then on its
 * node and one or two momentums from being readable.
 */
export function sendAccountBlock(template: BlockJson, options: PromptOptions = {}): Promise<SentBlock> {
  return exclusive(async () => {
    if (isLegacy()) {
      try { options.beforePrompt?.() } catch (error) { throw new NotSubmittedError(error instanceof Error ? error.message : 'Operation context changed before the wallet request') }
      const signed = (await legacySend(plain(template))) as Partial<BlockJson>
      return checkedResult(template, signed?.hash, signed, options.account)
    }
    let p: ZenonProvider
    try { p = provider() } catch { throw new NotSubmittedError('No Zenon wallet is available') }
    const result: SendAccountBlockResult = await prompting(() => p.sendAccountBlock(plain(template)), options)
    const block = result?.block ?? result?.signedTransaction ?? null
    const hash = result?.hash ?? block?.hash
    return checkedResult(template, hash, block, options.account)
  })
}

/**
 * The fields the page chose, compared with what the wallet says it signed. The
 * wallet fills in height, plasma, nonce and signature, and those are not
 * compared. A field the wallet did not report is not judged; a `data` reported
 * empty is a contract call stripped of its arguments, and is.
 */
export function signedBlockDiffers(template: BlockJson, signed: Partial<BlockJson> | null): string[] {
  if (!signed) return []
  const differences: string[] = []
  const fields = ['chainIdentifier', 'blockType', 'toAddress', 'amount', 'tokenStandard', 'data', 'fromBlockHash'] as const
  for (const field of fields) {
    if (signed[field] === undefined || signed[field] === null) continue
    if (String(signed[field]) !== String(template[field])) {
      differences.push(`${field}: asked for ${String(template[field]) || '(empty)'}, signed ${String(signed[field]) || '(empty)'}`)
    }
  }
  return differences
}

export function signMessage(message: string, options: PromptOptions = {}): Promise<SignMessageResult> {
  return exclusive(async () => {
    const p = provider()
    if (typeof p.signMessage !== 'function') {
      throw new WalletError(4200, 'this version of Syrius has no signMessage; it arrived in v0.3.1')
    }
    return prompting(() => p.signMessage!(message), options)
  })
}

/** The extension announces these. Anything the page prepared is stale after each. */
export function onWalletChange(handler: (event: string) => void): () => void {
  const events = ['accountsChanged', 'chainChanged', 'nodeChanged', 'disconnect']
  const p = window.zenon
  if (!p?.on) return () => {}
  const handlers = events.map((event) => {
    const h = () => handler(event)
    p.on!(event, h)
    return [event, h] as const
  })
  return () => {
    for (const [event, h] of handlers) p.removeListener?.(event, h)
  }
}

