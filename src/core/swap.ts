// Swaps between EVM assets, on one chain or across two, that do not touch the
// Zenon bridge or its orchestrators: they keep working, in seconds, while the
// orchestrators are not signing.
//
// Three routers, each answering a browser with no key:
//
//   one chain    KyberSwap's aggregator. It takes no fee, and for wZNN it
//                returns exactly what the Uniswap pool pays.
//   two chains   Across. Its relayers fill in seconds, and on 2026-10-13 it
//                paid 0.2% to 0.9% more than LI.FI on every pair tried.
//   either       LI.FI, asked only when the first has no route. It reaches
//                the most tokens and takes 0.25% for it.
//
// Each answers with one transaction for the user's wallet to send. A quote is
// refused unless that transaction, and the approval before it, name the
// router's known contract and carry the amount that was entered: a wrong or
// tampered answer cannot point an approval at a stranger.

export const NATIVE = '0x0000000000000000000000000000000000000000'
const KYBER_NATIVE = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'
/** What a same-chain swap may lose to price movement before it reverts, in basis points. */
export const SLIPPAGE_BPS = 50

export interface SwapAsset {
  chainId: number
  /** NATIVE for the chain's own coin. */
  address: string
  symbol: string
  decimals: number
}

export type Provider = 'kyber' | 'across' | 'lifi'

export interface SwapConfig {
  chains: number[]
  /** `slugs` are KyberSwap's path names for the chains. */
  kyber: { api: string; router: string; slugs: Record<number, string> }
  across: { api: string; router: string }
  /** `scan` is where a LI.FI transfer can be followed. */
  lifi: { api: string; router: string; scan: string }
}

export interface QuoteRequest {
  from: SwapAsset
  to: SwapAsset
  amount: bigint
  fromAddress: string
  toAddress: string
}

export interface Quote {
  request: QuoteRequest
  provider: Provider
  /** The router, and the DEX or bridge under it where it says. */
  via: string
  /** The contract the transaction goes to, and the one a token source approves. */
  spender: `0x${string}`
  toAmount: bigint
  toAmountMin: bigint
  /** Seconds after the sending transaction confirms. */
  seconds: number
  /** What the router and its bridge take, where they say. */
  feeUsd: number | null
  tx: { to: `0x${string}`; data: `0x${string}`; value: bigint }
  /** After this the quote is asked for again before it is sent. */
  expires: number
}

export type QuoteResult = { ok: true; quote: Quote } | { ok: false; message: string }

export const isNative = (a: SwapAsset) => a.address.toLowerCase() === NATIVE
export const sameAsset = (a: SwapAsset | null, b: SwapAsset | null) =>
  !!a && !!b && a.chainId === b.chainId && a.address.toLowerCase() === b.address.toLowerCase()
export const assetKey = (a: SwapAsset) => `${a.chainId}:${a.address.toLowerCase()}`

interface ApiBody {
  message?: string
  data?: { amountOut?: unknown; data?: unknown; routerAddress?: unknown; transactionValue?: unknown; routeSummary?: unknown }
  swapTx?: { to?: unknown; data?: unknown; value?: unknown }
  inputAmount?: unknown; expectedOutputAmount?: unknown; minOutputAmount?: unknown; expectedFillTime?: unknown; quoteExpiryTimestamp?: unknown
  checks?: { allowance?: { spender?: unknown } }; fees?: { total?: { amountUsd?: unknown } }
  estimate?: { toAmount?: unknown; toAmountMin?: unknown; approvalAddress?: unknown; executionDuration?: unknown; feeCosts?: { amountUSD?: unknown }[] }
  transactionRequest?: { to?: unknown; data?: unknown; value?: unknown }
  toolDetails?: { name?: unknown }; tool?: unknown; chains?: unknown[]
  status?: unknown; priceUSD?: unknown
}
const transactionData = (data: unknown): data is `0x${string}` => typeof data === 'string' && data.length <= 30_000 && /^0x(?:[a-fA-F0-9]{2}){4,}$/.test(data)
const positiveOutput = (output: bigint, minimum: bigint) => output > 0n && minimum > 0n && minimum <= output
const routerFetch = (fetcher: typeof fetch): typeof fetch => (url, init) => fetcher(url, { ...init, signal: AbortSignal.timeout(8000) })

const big = (v: unknown): bigint | null => {
  try {
    if (!(typeof v === 'string' && /^(?:0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/.test(v) || typeof v === 'number' && Number.isSafeInteger(v) && v >= 0)) return null
    const value = BigInt(v)
    return value < 2n ** 256n ? value : null
  } catch {
    return null
  }
}
const no = (body: ApiBody | null, fallback = 'No route'): QuoteResult => ({ ok: false, message: typeof body?.message === 'string' ? body.message : fallback })

/** The checks every router's answer passes before it becomes a quote. */
function guard(q: QuoteRequest, router: string, to: unknown, approval: unknown, value: bigint): string {
  if (q.amount <= 0n || q.amount >= 2n ** 256n) return 'Quote requests an invalid amount'
  const r = router.toLowerCase()
  if (typeof to !== 'string' || to.toLowerCase() !== r) return 'Quote names an unknown contract'
  if (!isNative(q.from) && String(approval ?? '').toLowerCase() !== r) return 'Quote names an unknown contract'
  // The value sent is the amount for a native source and nothing otherwise.
  if (value !== (isNative(q.from) ? q.amount : 0n)) return 'Quote asks for another amount'
  return ''
}

// ---- KyberSwap: one chain ----

const kyberToken = (a: SwapAsset) => (isNative(a) ? KYBER_NATIVE : a.address)

export function kyberRouteUrl(c: SwapConfig, q: QuoteRequest): string {
  const p = new URLSearchParams({ tokenIn: kyberToken(q.from), tokenOut: kyberToken(q.to), amountIn: q.amount.toString() })
  return `${c.kyber.api}/${c.kyber.slugs[q.from.chainId]}/api/v1/routes?${p}`
}

/** Reads the built transaction. KyberSwap approves and sends to the same router. */
export function parseKyber(c: SwapConfig, q: QuoteRequest, body: ApiBody | null, now = Date.now()): QuoteResult {
  const d = body?.data
  const toAmount = big(d?.amountOut)
  if (!d || toAmount === null) return no(body)
  if (!transactionData(d.data)) return { ok: false, message: 'Quote contains invalid transaction data' }
  if (!positiveOutput(toAmount, (toAmount * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n)) return { ok: false, message: 'Quote has invalid output amounts' }
  const value = big(d.transactionValue ?? '0') ?? -1n
  const bad = guard(q, c.kyber.router, d.routerAddress, d.routerAddress, value)
  if (bad) return { ok: false, message: bad }
  return {
    ok: true,
    quote: {
      request: q,
      provider: 'kyber',
      via: 'KyberSwap',
      spender: d.routerAddress as `0x${string}`,
      toAmount,
      toAmountMin: (toAmount * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n,
      seconds: 0,
      feeUsd: null,
      tx: { to: d.routerAddress as `0x${string}`, data: d.data, value },
      expires: now + 60_000,
    },
  }
}

async function quoteKyber(c: SwapConfig, q: QuoteRequest, fetcher: typeof fetch): Promise<QuoteResult> {
  const headers = { Accept: 'application/json', 'x-client-id': 'zenon-bridge' }
  const res = await fetcher(kyberRouteUrl(c, q), { headers })
  const route = await json(res)
  const summary = route?.data?.routeSummary
  if (!res.ok || !summary) return no(route)
  const built = await fetcher(`${c.kyber.api}/${c.kyber.slugs[q.from.chainId]}/api/v1/route/build`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ routeSummary: summary, sender: q.fromAddress, recipient: q.toAddress, slippageTolerance: SLIPPAGE_BPS }),
  })
  const body = await json(built)
  return built.ok ? parseKyber(c, q, body) : no(body)
}

// ---- Across: two chains ----

export function acrossUrl(c: SwapConfig, q: QuoteRequest): string {
  const p = new URLSearchParams({
    tradeType: 'exactInput',
    // Lets Across swap into the token it bridges, which is how wZNN and WBTC get a route.
    strictTradeType: 'false',
    amount: q.amount.toString(),
    inputToken: q.from.address,
    outputToken: q.to.address,
    originChainId: String(q.from.chainId),
    destinationChainId: String(q.to.chainId),
    depositor: q.fromAddress,
    recipient: q.toAddress,
  })
  return `${c.across.api}/swap/approval?${p}`
}

export function parseAcross(c: SwapConfig, q: QuoteRequest, body: ApiBody | null, now = Date.now()): QuoteResult {
  const t = body?.swapTx
  const toAmount = big(body?.expectedOutputAmount)
  const toAmountMin = big(body?.minOutputAmount)
  if (!t || toAmount === null || toAmountMin === null) return no(body)
  if (!transactionData(t.data)) return { ok: false, message: 'Quote contains invalid transaction data' }
  if (!positiveOutput(toAmount, toAmountMin)) return { ok: false, message: 'Quote has invalid output amounts' }
  // Without strictTradeType the amount taken may differ from the one asked for.
  if (big(body.inputAmount) !== q.amount) return { ok: false, message: 'Quote asks for another amount' }
  const bad = guard(q, c.across.router, t.to, body.checks?.allowance?.spender, big(t.value ?? '0') ?? -1n)
  if (bad) return { ok: false, message: bad }
  const expiry = Number(body?.quoteExpiryTimestamp) * 1000
  if (!Number.isSafeInteger(expiry) || expiry <= now + 5000) return { ok: false, message: 'Quote expired. Request a fresh quote.' }
  const fee = Number(body.fees?.total?.amountUsd)
  return {
    ok: true,
    quote: {
      request: q,
      provider: 'across',
      via: 'Across',
      spender: t.to as `0x${string}`,
      toAmount,
      toAmountMin,
      seconds: Number(body.expectedFillTime) || 0,
      feeUsd: Number.isFinite(fee) ? fee : null,
      tx: { to: t.to as `0x${string}`, data: t.data, value: big(t.value ?? '0') ?? -1n },
      // Across signs a quote for about half a minute.
      expires: expiry - 5_000,
    },
  }
}

async function quoteAcross(c: SwapConfig, q: QuoteRequest, fetcher: typeof fetch): Promise<QuoteResult> {
  const res = await fetcher(acrossUrl(c, q), { headers: { Accept: 'application/json' } })
  const body = await json(res)
  return res.ok ? parseAcross(c, q, body) : no(body)
}

// ---- LI.FI: the fallback ----

export function lifiUrl(c: SwapConfig, q: QuoteRequest): string {
  const p = new URLSearchParams({
    fromChain: String(q.from.chainId),
    toChain: String(q.to.chainId),
    fromToken: q.from.address,
    toToken: q.to.address,
    fromAmount: q.amount.toString(),
    fromAddress: q.fromAddress,
    toAddress: q.toAddress,
  })
  return `${c.lifi.api}/quote?${p}`
}

export function parseLifi(c: SwapConfig, q: QuoteRequest, body: ApiBody | null, now = Date.now()): QuoteResult {
  const e = body?.estimate
  const t = body?.transactionRequest
  const toAmount = big(e?.toAmount)
  const toAmountMin = big(e?.toAmountMin)
  if (!e || !t || toAmount === null || toAmountMin === null) return no(body)
  if (!transactionData(t.data)) return { ok: false, message: 'Quote contains invalid transaction data' }
  if (!positiveOutput(toAmount, toAmountMin)) return { ok: false, message: 'Quote has invalid output amounts' }
  const value = big(t.value ?? '0') ?? -1n
  const bad = guard(q, c.lifi.router, t.to, e.approvalAddress, value)
  if (bad) return { ok: false, message: bad }
  const tool = String(body.toolDetails?.name || body.tool || '')
  return {
    ok: true,
    quote: {
      request: q,
      provider: 'lifi',
      via: tool ? `LI.FI, ${tool}` : 'LI.FI',
      spender: t.to as `0x${string}`,
      toAmount,
      toAmountMin,
      seconds: Number(e.executionDuration) || 0,
      feeUsd: (Array.isArray(e.feeCosts) ? e.feeCosts : []).reduce((s: number, f: { amountUSD?: unknown }) => s + (Number(f?.amountUSD) || 0), 0),
      tx: { to: t.to as `0x${string}`, data: t.data, value },
      expires: now + 60_000,
    },
  }
}

async function quoteLifi(c: SwapConfig, q: QuoteRequest, fetcher: typeof fetch): Promise<QuoteResult> {
  const res = await fetcher(lifiUrl(c, q), { headers: { Accept: 'application/json' } })
  // Unkeyed, LI.FI allows 75 quotes per two hours.
  if (res.status === 429) return { ok: false, message: 'Too many quotes. Try again later.' }
  const body = await json(res)
  if (!res.ok) return res.status === 404 ? { ok: false, message: 'No route' } : no(body, `HTTP ${res.status}`)
  return parseLifi(c, q, body)
}

async function json(res: Response): Promise<ApiBody | null> {
  if (!res.body) return null
  const reader = res.body.getReader(), decoder = new TextDecoder()
  let size = 0, text = ''
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 256 * 1024) { await reader.cancel(); throw new Error('Quote response exceeds size limit') }
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
    try { return JSON.parse(text) as ApiBody } catch { return null }
  } finally { reader.releaseLock() }
}

const safely = (f: () => Promise<QuoteResult>): Promise<QuoteResult> =>
  f().catch((err) => ({ ok: false, message: err instanceof Error ? err.message : String(err) }))

/** The cheaper router for the pair first; LI.FI only when that one has no route. */
export async function fetchQuote(c: SwapConfig, q: QuoteRequest, fetcher: typeof fetch = fetch): Promise<QuoteResult> {
  fetcher = routerFetch(fetcher)
  const first = q.from.chainId === q.to.chainId ? quoteKyber : quoteAcross
  const a = await safely(() => first(c, q, fetcher))
  if (a.ok) return a
  // An answer that failed a check is not replaced by another router's: it is shown.
  if (a.message.startsWith('Quote ')) return a
  return safely(() => quoteLifi(c, q, fetcher))
}

export type SwapState = 'pending' | 'done' | 'failed'

/** Where a cross-chain transfer stands. An unknown hash is pending: the routers learn of it late. */
export async function fetchStatus(c: SwapConfig, provider: Provider, txHash: string, fromChain: number, toChain: number, fetcher: typeof fetch = fetch): Promise<SwapState> {
  fetcher = routerFetch(fetcher)
  try {
    const url =
      provider === 'across'
        ? `${c.across.api}/deposit/status?${new URLSearchParams({ originChainId: String(fromChain), depositTxnRef: txHash })}`
        : `${c.lifi.api}/status?${new URLSearchParams({ txHash, fromChain: String(fromChain), toChain: String(toChain) })}`
    const res = await fetcher(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return 'pending'
    const s = String((await json(res))?.status ?? '').toLowerCase()
    if (s === 'done' || s === 'filled') return 'done'
    return s === 'failed' || s === 'expired' || s === 'refunded' ? 'failed' : 'pending'
  } catch {
    return 'pending'
  }
}

export interface RouterHealth {
  /** A router that swaps on one chain answered. */
  sameChain: boolean
  /** A router that moves between the chains answered. */
  crossChain: boolean
}

/**
 * Whether the routers can be reached and have routes, asked before the user
 * has typed anything: KyberSwap for a route on `sample`, Across for its routes
 * between the two chains, LI.FI for its chain list. None of these builds a
 * transaction or counts against a quote limit.
 */
export async function checkRouters(c: SwapConfig, sample: { from: SwapAsset; to: SwapAsset } | null, fetcher: typeof fetch = fetch): Promise<RouterHealth> {
  const ask = async (url: string, good: (body: ApiBody | null) => boolean): Promise<boolean> => {
    try {
      const res = await fetcher(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) })
      return res.ok && good(await json(res))
    } catch {
      return false
    }
  }
  const [a, b] = c.chains
  const [kyber, across, lifi] = await Promise.all([
    sample
      ? ask(kyberRouteUrl(c, { ...sample, amount: 10n ** BigInt(Math.max(sample.from.decimals - 2, 0)), fromAddress: '', toAddress: '' }), (x) => !!x?.data?.routeSummary)
      : Promise.resolve(false),
    ask(`${c.across.api}/available-routes?${new URLSearchParams({ originChainId: String(a), destinationChainId: String(b) })}`, (x) => Array.isArray(x) && x.length > 0),
    ask(`${c.lifi.api}/chains`, (x) => Array.isArray(x?.chains) && x.chains.length > 0),
  ])
  return { sameChain: kyber || lifi, crossChain: across || lifi }
}

/** Time shown before a quote arrives, and added to one for the sending block. */
export function swapEstimate(from: SwapAsset, to: SwapAsset, sourceBlockSeconds: number, quote: Quote | null): number {
  const settle = quote ? quote.seconds : from.chainId === to.chainId ? 0 : 10
  return Math.ceil(sourceBlockSeconds + settle)
}

/**
 * A token's price in dollars, from LI.FI's token list (100 lookups a minute
 * unkeyed). An estimate for display: nothing is priced or sent by it.
 */
export async function fetchPrice(c: SwapConfig, a: SwapAsset, fetcher: typeof fetch = fetch): Promise<number | null> {
  fetcher = routerFetch(fetcher)
  try {
    const res = await fetcher(`${c.lifi.api}/token?${new URLSearchParams({ chain: String(a.chainId), token: a.address })}`, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const p = Number((await json(res))?.priceUSD)
    return Number.isFinite(p) && p > 0 ? p : null
  } catch {
    return null
  }
}

/** Dollars for an amount in base units. Floats are fine here: it is an estimate on screen. */
export function usdValue(amount: bigint, decimals: number, price: number): number {
  return (Number(amount) / 10 ** decimals) * price
}
