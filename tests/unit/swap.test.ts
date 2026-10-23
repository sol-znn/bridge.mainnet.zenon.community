import { describe, expect, it, vi } from 'vitest'
import {
  NATIVE,
  acrossUrl,
  checkRouters,
  fetchPrice,
  fetchQuote,
  fetchStatus,
  isNative,
  kyberRouteUrl,
  lifiUrl,
  parseAcross,
  parseKyber,
  parseLifi,
  sameAsset,
  swapEstimate,
  usdValue,
  type QuoteRequest,
  type SwapConfig,
} from '../../src/core/swap.ts'
import { formatUsd } from '../../src/core/format.ts'

const cfg: SwapConfig = {
  chains: [1, 56],
  kyber: { api: 'https://aggregator-api.kyberswap.com', router: '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5', slugs: { 1: 'ethereum', 56: 'bsc' } },
  across: { api: 'https://app.across.to/api', router: '0x97CCDBea4632140639aD5eA9b944aa034eb15fD4' },
  lifi: { api: 'https://li.quest/v1', router: '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE', scan: 'https://scan.li.fi/tx/' },
}
const eth = { chainId: 1, address: NATIVE, symbol: 'ETH', decimals: 18 }
const bnb = { chainId: 56, address: NATIVE, symbol: 'BNB', decimals: 18 }
const wznn = { chainId: 1, address: '0xb2e96a63479C2Edd2FD62b382c89D5CA79f572d3', symbol: 'wZNN', decimals: 8 }
const me = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const them = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const req = (o: Partial<QuoteRequest> = {}): QuoteRequest => ({ from: eth, to: wznn, amount: 10n ** 17n, fromAddress: me, toAddress: me, ...o })
const sell = req({ from: wznn, to: eth, amount: 100n })

// The shapes the three routers answered with on 2026-10-13, cut to what the page reads.
const kyber = (o: { router?: string; value?: string } = {}) => ({
  data: { amountOut: '156875519751', data: '0xe21fd0e9', routerAddress: o.router ?? cfg.kyber.router, transactionValue: o.value ?? '100000000000000000' },
})
const across = (o: { to?: string; spender?: string; value?: string; input?: string; expiry?: number } = {}) => ({
  inputAmount: o.input ?? '100000000000000000',
  expectedOutputAmount: '335430467700791872',
  minOutputAmount: '333753315362287912',
  expectedFillTime: 3,
  quoteExpiryTimestamp: o.expiry ?? Math.floor(Date.now() / 1000) + 32,
  checks: { allowance: { spender: o.spender ?? cfg.across.router } },
  fees: { total: { amountUsd: '0.4559' } },
  swapTx: { to: o.to ?? cfg.across.router, data: '0x609ea081', value: o.value ?? '100000000000000000' },
})
const lifi = (o: { to?: string; approval?: string; value?: string } = {}) => ({
  tool: 'symbiosis',
  toolDetails: { name: 'Symbiosis' },
  estimate: {
    toAmount: '332673729943847285',
    toAmountMin: '328427326380666983',
    executionDuration: 36,
    approvalAddress: o.approval ?? cfg.lifi.router,
    feeCosts: [{ amountUSD: '0.6162' }, { amountUSD: '1.2321' }],
  },
  transactionRequest: { to: o.to ?? cfg.lifi.router, data: '0xabcdef00', value: o.value ?? '0x16345785d8a0000' },
})
const respond = (routes: Record<string, { status?: number; body: unknown }>) =>
  vi.fn(async (url: string, _init?: RequestInit) => {
    const hit = Object.keys(routes).find((k) => String(url).includes(k))
    if (!hit) throw new Error(`unexpected ${url}`)
    return new Response(JSON.stringify(routes[hit].body), { status: routes[hit].status ?? 200 })
  })
const as = (f: unknown) => f as typeof fetch

describe('swap requests', () => {
  it('asks KyberSwap with its own name for the chain coin', () => {
    const u = new URL(kyberRouteUrl(cfg, req()))
    expect(u.pathname).toBe('/ethereum/api/v1/routes')
    expect(Object.fromEntries(u.searchParams)).toEqual({ tokenIn: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', tokenOut: wznn.address, amountIn: '100000000000000000' })
    expect(new URL(kyberRouteUrl(cfg, req({ from: bnb, to: bnb }))).pathname).toBe('/bsc/api/v1/routes')
  })
  it('asks Across for the entered amount, to the recipient', () => {
    const p = Object.fromEntries(new URL(acrossUrl(cfg, req({ to: bnb, toAddress: them }))).searchParams)
    expect(p).toEqual({
      tradeType: 'exactInput',
      strictTradeType: 'false',
      amount: '100000000000000000',
      inputToken: NATIVE,
      outputToken: NATIVE,
      originChainId: '1',
      destinationChainId: '56',
      depositor: me,
      recipient: them,
    })
  })
  it('asks LI.FI with the recipient as toAddress', () => {
    const p = Object.fromEntries(new URL(lifiUrl(cfg, req({ to: bnb, toAddress: them }))).searchParams)
    expect(p).toMatchObject({ fromChain: '1', toChain: '56', fromAmount: '100000000000000000', fromAddress: me, toAddress: them })
  })
})

describe('swap quotes', () => {
  it('never extends an expired, missing or malformed Across expiry', () => {
    for (const expiry of [0, 1, NaN, Infinity]) {
      expect(parseAcross(cfg, req({ to: bnb }), across({ expiry }), 100_000).ok).toBe(false)
    }
    expect(parseAcross(cfg, req({ to: bnb }), across({ expiry: 104 }), 100_000).ok).toBe(false)
  })
  it('refuses malformed calldata and a malformed token transaction value', () => {
    expect(parseKyber(cfg, req({ amount: -1n }), kyber({ value: 'not an integer' })).ok).toBe(false)
    expect(parseKyber(cfg, req(), { data: { ...kyber().data, data: 'not calldata' } }).ok).toBe(false)
    expect(parseKyber(cfg, sell, kyber({ value: 'not an integer' })).ok).toBe(false)
    expect(parseLifi(cfg, req(), { ...lifi(), transactionRequest: { ...lifi().transactionRequest, data: '0x1' } }).ok).toBe(false)
  })
  it('rejects zero, negative, unsafe numeric and inverted output amounts', () => {
    for (const amountOut of ['0', '-1', Number.MAX_SAFE_INTEGER + 1, (2n ** 256n).toString()]) {
      expect(parseKyber(cfg, req(), { data: { ...kyber().data, amountOut } }).ok).toBe(false)
    }
    expect(parseAcross(cfg, req({ to: bnb }), { ...across(), minOutputAmount: '99999999999999999999999' }).ok).toBe(false)
  })
  it('reads KyberSwap: no fee, half a percent of slippage', () => {
    const r = parseKyber(cfg, req(), kyber(), 1000)
    expect(r).toMatchObject({ ok: true, quote: { provider: 'kyber', via: 'KyberSwap', spender: cfg.kyber.router, toAmount: 156875519751n, toAmountMin: 156091142152n, seconds: 0, feeUsd: null, expires: 61_000 } })
    if (!r.ok) throw new Error('unreachable')
    expect(r.quote.tx).toEqual({ to: cfg.kyber.router, data: '0xe21fd0e9', value: 10n ** 17n })
  })
  it('reads Across: its own minimum, fill time, fee and expiry', () => {
    const r = parseAcross(cfg, req({ to: bnb }), across({ expiry: 1_791_858_532 }), 1_791_858_500_000)
    expect(r).toMatchObject({ ok: true, quote: { provider: 'across', via: 'Across', toAmount: 335430467700791872n, toAmountMin: 333753315362287912n, seconds: 3, feeUsd: 0.4559, expires: 1_791_858_527_000 } })
  })
  it('reads LI.FI: the bridge under it and the summed fees', () => {
    const r = parseLifi(cfg, req({ to: bnb }), lifi(), 0)
    expect(r).toMatchObject({ ok: true, quote: { provider: 'lifi', via: 'LI.FI, Symbiosis', seconds: 36, toAmount: 332673729943847285n } })
    if (!r.ok) throw new Error('unreachable')
    expect(r.quote.feeUsd).toBeCloseTo(1.8483)
  })
  it('refuses a transaction or an approval to any contract but the router', () => {
    const unknown = { ok: false, message: 'Quote names an unknown contract' }
    expect(parseKyber(cfg, req(), kyber({ router: them }))).toEqual(unknown)
    expect(parseAcross(cfg, req({ to: bnb }), across({ to: them }))).toEqual(unknown)
    expect(parseAcross(cfg, { ...sell, to: bnb }, across({ spender: them, value: '0', input: '100' }))).toEqual(unknown)
    expect(parseLifi(cfg, req(), lifi({ to: them }))).toEqual(unknown)
    expect(parseLifi(cfg, sell, lifi({ approval: them, value: '0x0' }))).toEqual(unknown)
    // One router's contract is not another's.
    expect(parseLifi(cfg, req(), lifi({ to: cfg.across.router }))).toEqual(unknown)
  })
  it('refuses a value other than the amount, and any value for a token', () => {
    const other = { ok: false, message: 'Quote asks for another amount' }
    expect(parseKyber(cfg, req(), kyber({ value: '1' }))).toEqual(other)
    expect(parseKyber(cfg, sell, kyber())).toEqual(other)
    expect(parseAcross(cfg, req({ to: bnb }), across({ value: '200000000000000000' }))).toEqual(other)
    expect(parseAcross(cfg, req({ to: bnb }), across({ input: '90000000000000000' }))).toEqual(other)
    expect(parseLifi(cfg, sell, lifi())).toEqual(other)
    expect(parseLifi(cfg, sell, lifi({ value: '0x0' })).ok).toBe(true)
  })
  it('says no route for an answer with no transaction, and passes on a message', () => {
    expect(parseKyber(cfg, req(), {})).toEqual({ ok: false, message: 'No route' })
    expect(parseAcross(cfg, req(), { message: 'No bridge routes found' })).toEqual({ ok: false, message: 'No bridge routes found' })
    expect(parseLifi(cfg, req(), {})).toEqual({ ok: false, message: 'No route' })
  })
})

describe('swap routing', () => {
  it('bounds an oversized router response and does not use it or shop it elsewhere', async () => {
    const f = respond({ '/routes?': { body: { data: { routeSummary: 'x'.repeat(300_000) } } } })
    expect(await fetchQuote(cfg, req(), as(f))).toEqual({ ok: false, message: 'Quote response exceeds size limit' })
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('uses KyberSwap on one chain: route, then build with sender and recipient', async () => {
    const f = respond({ '/routes?': { body: { data: { routeSummary: { amountOut: '1' } } } }, '/route/build': { body: kyber() } })
    const r = await fetchQuote(cfg, req({ toAddress: them }), as(f))
    expect(r).toMatchObject({ ok: true, quote: { provider: 'kyber' } })
    expect(f).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(f.mock.calls[1][1]?.body))).toEqual({ routeSummary: { amountOut: '1' }, sender: me, recipient: them, slippageTolerance: 50 })
  })
  it('uses Across across two chains, and does not ask LI.FI', async () => {
    const f = respond({ 'across.to': { body: across() } })
    expect(await fetchQuote(cfg, req({ to: bnb }), as(f))).toMatchObject({ ok: true, quote: { provider: 'across' } })
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('falls back to LI.FI when the first router has no route or is unreachable', async () => {
    const none = respond({ 'across.to': { status: 400, body: { message: 'No bridge routes found' } }, 'li.quest': { body: lifi() } })
    expect(await fetchQuote(cfg, req({ to: bnb }), as(none))).toMatchObject({ ok: true, quote: { provider: 'lifi' } })
    const down = vi.fn(async (url: string) => {
      if (String(url).includes('kyberswap')) throw new Error('offline')
      return new Response(JSON.stringify(lifi()), { status: 200 })
    })
    expect(await fetchQuote(cfg, req(), as(down))).toMatchObject({ ok: true, quote: { provider: 'lifi' } })
  })
  it('does not shop a refused quote to another router', async () => {
    const f = respond({ 'across.to': { body: across({ to: them }) }, 'li.quest': { body: lifi() } })
    expect(await fetchQuote(cfg, req({ to: bnb }), as(f))).toEqual({ ok: false, message: 'Quote names an unknown contract' })
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('names the rate limit and a missing route when both fail', async () => {
    const limited = respond({ 'across.to': { status: 400, body: {} }, 'li.quest': { status: 429, body: {} } })
    expect(await fetchQuote(cfg, req({ to: bnb }), as(limited))).toEqual({ ok: false, message: 'Too many quotes. Try again later.' })
    const none = respond({ kyberswap: { status: 400, body: {} }, 'li.quest': { status: 404, body: { message: 'x' } } })
    expect(await fetchQuote(cfg, req(), as(none))).toEqual({ ok: false, message: 'No route' })
  })
})

describe('swap availability', () => {
  const up = { kyberswap: { body: { data: { routeSummary: {} } } }, 'available-routes': { body: [{ originChainId: 1 }] }, '/chains': { body: { chains: [{ id: 1 }] } } }
  const down = { status: 503, body: {} }
  it('asks each router something cheap', async () => {
    const f = respond(up)
    expect(await checkRouters(cfg, { from: eth, to: wznn }, as(f))).toEqual({ sameChain: true, crossChain: true })
    const urls = f.mock.calls.map((c) => String(c[0]))
    expect(urls.some((u) => u.includes('/ethereum/api/v1/routes?') && u.includes('amountIn=10000000000000000'))).toBe(true)
    expect(urls).toContain('https://app.across.to/api/available-routes?originChainId=1&destinationChainId=56')
    expect(urls).toContain('https://li.quest/v1/chains')
    expect(urls.some((u) => u.includes('/quote') || u.includes('/build'))).toBe(false)
  })
  it('counts LI.FI for both kinds, so one router down is not an outage', async () => {
    expect(await checkRouters(cfg, { from: eth, to: wznn }, as(respond({ ...up, kyberswap: down })))).toEqual({ sameChain: true, crossChain: true })
    expect(await checkRouters(cfg, { from: eth, to: wznn }, as(respond({ ...up, 'available-routes': { body: [] } })))).toEqual({ sameChain: true, crossChain: true })
  })
  it('says which kind has no route, and that nothing has', async () => {
    expect(await checkRouters(cfg, { from: eth, to: wznn }, as(respond({ ...up, 'available-routes': down, '/chains': down })))).toEqual({ sameChain: true, crossChain: false })
    expect(await checkRouters(cfg, { from: eth, to: wznn }, as(respond({ ...up, kyberswap: down, '/chains': down })))).toEqual({ sameChain: false, crossChain: true })
    const dead = vi.fn(async () => {
      throw new Error('offline')
    })
    expect(await checkRouters(cfg, { from: eth, to: wznn }, as(dead))).toEqual({ sameChain: false, crossChain: false })
  })
})

describe('swap status, time and price', () => {
  it('follows a transfer with the router that took it, and holds an unknown hash as pending', async () => {
    const f = (status: number, s?: string) => vi.fn(async (_url: string) => new Response(JSON.stringify({ status: s }), { status }))
    const a = f(200, 'filled')
    expect(await fetchStatus(cfg, 'across', '0x1', 1, 56, as(a))).toBe('done')
    expect(String(a.mock.calls[0][0])).toBe('https://app.across.to/api/deposit/status?originChainId=1&depositTxnRef=0x1')
    expect(await fetchStatus(cfg, 'across', '0x1', 1, 56, as(f(200, 'refunded')))).toBe('failed')
    expect(await fetchStatus(cfg, 'across', '0x1', 1, 56, as(f(404)))).toBe('pending')
    const l = f(200, 'DONE')
    expect(await fetchStatus(cfg, 'lifi', '0x1', 1, 56, as(l))).toBe('done')
    expect(String(l.mock.calls[0][0])).toContain('https://li.quest/v1/status?txHash=0x1')
    expect(await fetchStatus(cfg, 'lifi', '0x1', 1, 56, as(f(200, 'FAILED')))).toBe('failed')
    expect(await fetchStatus(cfg, 'lifi', '0x1', 1, 56, as(f(200, 'PENDING')))).toBe('pending')
  })
  it('estimates one block on one chain, and the fill time on top across two', () => {
    expect(swapEstimate(eth, wznn, 12, null)).toBe(12)
    expect(swapEstimate(eth, bnb, 12, null)).toBe(22)
    const r = parseAcross(cfg, req({ to: bnb }), across())
    if (!r.ok) throw new Error('unreachable')
    expect(swapEstimate(eth, bnb, 12, r.quote)).toBe(15)
  })
  it('reads a price, and none from a bad answer', async () => {
    const f = vi.fn(async (_url: string) => new Response(JSON.stringify({ priceUSD: '0.158077871' }), { status: 200 }))
    expect(await fetchPrice(cfg, wznn, as(f))).toBeCloseTo(0.158077871)
    expect(String(f.mock.calls[0][0])).toBe(`https://li.quest/v1/token?chain=1&token=${wznn.address}`)
    expect(await fetchPrice(cfg, wznn, as(vi.fn(async () => new Response('{}', { status: 200 }))))).toBeNull()
    expect(await fetchPrice(cfg, wznn, as(vi.fn(async () => new Response('', { status: 500 }))))).toBeNull()
  })
  it('values an amount and prints dollars', () => {
    expect(usdValue(100_000_000_000n, 8, 0.158)).toBeCloseTo(158)
    expect(formatUsd(1234.5)).toBe('$1,234.50')
    expect(formatUsd(0.158077871)).toBe('$0.1581')
    expect(formatUsd(0)).toBe('$0')
  })
  it('tells assets apart by chain and address, not by case', () => {
    expect(isNative(eth)).toBe(true)
    expect(isNative(wznn)).toBe(false)
    expect(sameAsset(wznn, { ...wznn, address: wznn.address.toLowerCase() })).toBe(true)
    expect(sameAsset(eth, bnb)).toBe(false)
    expect(sameAsset(eth, null)).toBe(false)
  })
})
