import { describe, expect, it, vi } from 'vitest'
import { wrapFee, wrapReceive, unwrapReceive, wrapEstimate } from '../../src/core/fees.ts'
import { formatUnits, parseUnits, unitsToInput, duration, clock, shorten } from '../../src/core/format.ts'
import { wrapStatus, wrapStateFromRevert, unwrapStatus, UINT256_MAX, isAffiliateEntry } from '../../src/core/status.ts'
import { requestPlasma, canRequest, hasNoPlasma } from '../../src/core/plasmaBot.ts'
import { parseJsonSafe } from '../../src/znn/client.ts'
import { affiliateActive, parseMetadata } from '../../src/znn/api.ts'

describe('fees', () => {
  it('takes feePercentage / 10000, rounded down like go-zenon', () => {
    expect(wrapFee(100_000_000n, 300)).toBe(3_000_000n)
    expect(wrapReceive(100_000_000n, 300)).toBe(97_000_000n)
    expect(wrapFee(33n, 300)).toBe(0n)
    expect(wrapFee(10n ** 18n, 0)).toBe(0n)
  })
  it('matches a real mainnet wrap: amount 299953212506, fee 8998596375', () => {
    expect(wrapFee(299953212506n, 300)).toBe(8998596375n)
  })
  it('pays 1% extra on unwrap with a referral', () => {
    expect(unwrapReceive(1000n, true)).toBe(1010n)
    expect(unwrapReceive(1000n, false)).toBe(1000n)
  })
  it('estimates wrap time from finality, signing and the EVM delay', () => {
    expect(wrapEstimate({ confirmationsToFinality: 90, momentumSeconds: 10, evmRedeemDelayBlocks: 150, evmBlockSeconds: 12, signingSeconds: 0 }).seconds).toBe(900 + 1800)
  })
})

describe('format', () => {
  it('parses and prints base units without floats', () => {
    expect(parseUnits('1.5', 8)).toBe(150_000_000n)
    expect(parseUnits('0.00000001', 8)).toBe(1n)
    expect(parseUnits('0.000000001', 8)).toBeNull()
    expect(parseUnits('1,000', 8)).toBeNull()
    expect(parseUnits('abc', 8)).toBeNull()
    expect(parseUnits('.', 8)).toBeNull()
    expect(formatUnits(123456789012n, 8)).toBe('1,234.56789')
    expect(formatUnits(123456789012n, 8, 2)).toBe('1,234.56')
    expect(unitsToInput(150_000_000n, 8)).toBe('1.5')
    expect(formatUnits(0n, 18)).toBe('0')
  })
  it('durations and clocks', () => {
    expect(duration(45)).toBe('45s')
    expect(duration(4800)).toBe('1h 20m')
    expect(duration(3 * 86400 + 4 * 3600)).toBe('3d 4h')
    expect(clock(65)).toBe('1:05')
    expect(clock(3661)).toBe('1:01:01')
    expect(shorten('z1qr9vtwsfr2n0nsxl2nfh6l5esqjh2wfj85cfq9')).toBe('z1qr9v…cfq9')
  })
})

describe('wrap status', () => {
  const base = { signature: 'x', confirmationsToFinality: 0, momentumSeconds: 10, redeemBlock: 0n, evmBlock: 1000n, redeemDelay: 150n, evmBlockSeconds: 12 }
  it('walks confirming, signing, redeem, waiting, finish, done', () => {
    expect(wrapStatus({ ...base, signature: '', confirmationsToFinality: 30 })).toMatchObject({ state: 'confirming', eta: 300 })
    expect(wrapStatus({ ...base, signature: '' }).state).toBe('signing')
    expect(wrapStatus(base)).toMatchObject({ state: 'redeem', step: '1/2' })
    expect(wrapStatus({ ...base, redeemBlock: 900n })).toMatchObject({ state: 'delay', eta: (1050 - 1000) * 12 })
    // bridge.sol: (blockNumber + redeemDelay) < block.number, and the redeem
    // lands in latest + 1 at best. Checked on anvil by e2e/bridge.e2e.test.ts.
    expect(wrapStatus({ ...base, redeemBlock: 851n }).state).toBe('delay')
    expect(wrapStatus({ ...base, redeemBlock: 850n }).state).toBe('finish')
    expect(wrapStatus({ ...base, redeemBlock: UINT256_MAX }).state).toBe('done')
  })
  it('maps bridge.sol revert reasons', () => {
    expect(wrapStateFromRevert('execution reverted: redeem: Nonce already redeemed')).toBe('done')
    expect(wrapStateFromRevert('redeem: Not redeemable yet')).toBe('delay')
    expect(wrapStateFromRevert('redeem: Wrong signature')).toBe('failed')
    expect(wrapStateFromRevert('something else')).toBeNull()
  })
})

describe('unwrap status', () => {
  const u = { signature: 'x', redeemed: 0, revoked: 0, redeemableIn: 0, momentumSeconds: 10 }
  it('covers every state', () => {
    expect(unwrapStatus({ ...u, signature: '' }).state).toBe('signing')
    expect(unwrapStatus({ ...u, redeemableIn: 6 })).toMatchObject({ state: 'delay', eta: 60 })
    expect(unwrapStatus(u).state).toBe('redeem')
    expect(unwrapStatus({ ...u, redeemed: 1 }).state).toBe('done')
    expect(unwrapStatus({ ...u, revoked: 1, redeemed: 1 }).state).toBe('revoked')
  })
  it('spots affiliate entries', () => {
    expect(isAffiliateEntry(4_000_000_074)).toBe(true)
    expect(isAffiliateEntry(74)).toBe(false)
  })
})

describe('affiliate program metadata', () => {
  const meta = parseMetadata(
    '{"affiliateProgram":{"networks":{"1":{"startingHeight":17678862,"ZNN":true,"QSR":true,"wZNN":true,"wQSR":false}}}}',
  )
  it('is keyed by the EVM token paired with ZNN or QSR', () => {
    expect(affiliateActive(meta, 1, 'zts1znnxxxxxxxxxxxxx9z4ulx', 17678862n)).toBe(true)
    expect(affiliateActive(meta, 1, 'zts1znnxxxxxxxxxxxxx9z4ulx', 17678861n)).toBe(false)
    expect(affiliateActive(meta, 1, 'zts1znnxxxxxxxxxxxxx9z4ulx')).toBe(false)
    expect(affiliateActive(meta, 1, 'zts1qsrxxxxxxxxxxxxxmrhjll')).toBe(false)
    expect(affiliateActive(meta, 56, 'zts1znnxxxxxxxxxxxxx9z4ulx')).toBe(false)
    expect(affiliateActive(meta, 1, 'zts17d6yr02kh0r9qr566p7tg6')).toBe(false)
    expect(affiliateActive(parseMetadata('not json'), 1, 'zts1znnxxxxxxxxxxxxx9z4ulx')).toBe(false)
  })
})

describe('plasma', () => {
  const cfg = { url: 'https://zenonhub.io/api/utilities/plasma-bot/fuse', token: '', page: 'https://zenonhub.io/tools/plasma-bot' }
  it('detects zero plasma only', () => {
    expect(hasNoPlasma(0)).toBe(true)
    expect(hasNoPlasma(21000)).toBe(false)
    expect(hasNoPlasma(null)).toBe(false)
  })
  it('without a token, points to the zenonhub page and sends nothing', async () => {
    const f = vi.fn()
    expect(canRequest(cfg)).toBe(false)
    const r = await requestPlasma('z1qr9vtwsfr2n0nsxl2nfh6l5esqjh2wfj85cfq9', cfg, f as unknown as typeof fetch)
    expect(r).toMatchObject({ ok: false, reason: 'no-token', page: cfg.page })
    expect(f).not.toHaveBeenCalled()
  })
  it('with a token, posts the address with a bearer token', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ message: 'Fused' }), { status: 200 }))
    const r = await requestPlasma('z1qr9vtwsfr2n0nsxl2nfh6l5esqjh2wfj85cfq9', { ...cfg, token: 't0k' }, f as unknown as typeof fetch)
    expect(r).toEqual({ ok: true, message: 'Fused' })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(cfg.url)
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t0k')
    expect(JSON.parse(init.body as string)).toEqual({ address: 'z1qr9vtwsfr2n0nsxl2nfh6l5esqjh2wfj85cfq9' })
  })
  it('reports a refusal', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ message: 'Unauthenticated.' }), { status: 401 }))
    expect(await requestPlasma('z1x', { ...cfg, token: 'bad' }, f as unknown as typeof fetch)).toMatchObject({ ok: false, reason: 'rejected', message: 'Unauthenticated.' })
  })
})

describe('parseJsonSafe', () => {
  it('keeps big integers exact and leaves strings alone', () => {
    const v = parseJsonSafe('{"amount":69648350815046123456,"small":42,"neg":-12345678901234567,"meta":"{\\"h\\":12345678901234567890}","f":1.5}') as Record<string, unknown>
    expect(v.amount).toBe('69648350815046123456')
    expect(v.small).toBe(42)
    expect(v.neg).toBe('-12345678901234567')
    expect(v.meta).toBe('{"h":12345678901234567890}')
    expect(v.f).toBe(1.5)
  })
})
