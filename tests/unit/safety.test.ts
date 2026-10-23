import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseUnits } from '../../src/core/format.ts'
import { formatAddress, isUserAddress } from '../../src/znn/primitives.ts'
import { isEvmRecipient } from '../../src/core/recipient.ts'
import { mangle, referrerFromCode, usableReferrer } from '../../src/core/referral.ts'
import { wrapStatus } from '../../src/core/status.ts'
import { requestPlasma } from '../../src/core/plasmaBot.ts'
import { ZenonClient } from '../../src/znn/client.ts'
import { mapLimit } from '../../src/core/paging.ts'

const account = formatAddress(Uint8Array.from([0, ...Array(19).fill(7)]))
const embedded = formatAddress(Uint8Array.from([1, ...Array(19).fill(7)]))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('amount and beneficiary safety', () => {
  it.each(['1,5', '1,000', '1,23,4', '1 000', '1e3', '-1', '0x10'])('rejects ambiguous or unsupported input %s', (input) => {
    expect(parseUnits(input, 8)).toBeNull()
  })
  it('keeps decimal precision and uint256 bounds exact', () => {
    expect(parseUnits('.5', 8)).toBe(50_000_000n)
    expect(parseUnits('1.000000001', 8)).toBeNull()
    expect(parseUnits(((1n << 256n) - 1n).toString(), 0)).toBe((1n << 256n) - 1n)
    expect(parseUnits((1n << 256n).toString(), 0)).toBeNull()
    expect(parseUnits('1', -1)).toBeNull()
  })
  it('allows account recipients but never embedded or zero addresses', () => {
    expect(isUserAddress(account)).toBe(true)
    expect(isUserAddress(embedded)).toBe(false)
    expect(isUserAddress(formatAddress(new Uint8Array(20)))).toBe(false)
    expect(isEvmRecipient('0x' + '00'.repeat(20))).toBe(false)
    expect(isEvmRecipient('0x' + '12'.repeat(20))).toBe(true)
    expect(referrerFromCode(mangle(embedded))).toBeNull()
    expect(usableReferrer(account, account)).toBeNull()
    expect(usableReferrer(account, embedded)).toBeNull()
  })
  it('does not turn missing redemption reads into action readiness', () => {
    const base = { signature: 'signed', confirmationsToFinality: 0, momentumSeconds: 10, redeemBlock: 10n, evmBlock: 100n, redeemDelay: 20n, evmBlockSeconds: 12 }
    expect(wrapStatus({ ...base, redeemBlock: null }).state).toBe('unavailable')
    expect(wrapStatus({ ...base, evmBlock: null }).state).toBe('unavailable')
    expect(wrapStatus({ ...base, redeemDelay: null }).state).toBe('unavailable')
  })
  it('calls a tokenless proxy without exposing an Authorization header', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }))
    expect(await requestPlasma(account, { url: 'https://proxy.example/fuse', token: '', page: '', mode: 'proxy' }, fetcher as typeof fetch)).toMatchObject({ ok: true })
    const options = fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(options[1].headers).not.toHaveProperty('Authorization')
    expect(options[1].signal).toBeInstanceOf(AbortSignal)
  })
})

class Socket {
  static OPEN = 1
  static latest: Socket
  readyState = 0
  onopen?: () => void
  onclose?: () => void
  onmessage?: (event: { data: string }) => void
  send = vi.fn()
  constructor(_url: string) { Socket.latest = this }
  close() { this.readyState = 3; this.onclose?.() }
  open() { this.readyState = 1; this.onopen?.() }
}

describe('RPC ownership and deadlines', () => {
  it('bounds independent history work and preserves result ordering and failures', async () => {
    let active=0,peak=0
    const result=await mapLimit([1,2,3,4,5],async(value)=>{
      peak=Math.max(peak,++active)
      await new Promise((resolve)=>setTimeout(resolve,6-value))
      active--;return value*2
    },2)
    expect(peak).toBe(2);expect(result).toEqual([2,4,6,8,10])
    await expect(mapLimit([1,2],async()=>{throw new Error('read failure')})).rejects.toThrow('read failure')
    await expect(mapLimit([1],async()=>1,0)).rejects.toThrow('concurrency')
  })
  it('rejects connecting callers immediately when closed and releases their timers', async () => {
    vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket)
    const c = new ZenonClient('ws://offline.example')
    const call = c.call('ledger.getFrontierMomentum')
    const assertion = expect(call).rejects.toThrow('closed')
    c.close()
    await assertion
    expect(vi.getTimerCount()).toBe(0)
    await expect(c.call('ledger.getFrontierMomentum')).rejects.toThrow('closed')
  })
  it('shares one deadline between connecting and awaiting a response', async () => {
    vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket)
    const c = new ZenonClient('ws://slow.example')
    const call = c.call('method')
    const assertion = expect(call).rejects.toThrow('no answer')
    await vi.advanceTimersByTimeAsync(15_000)
    Socket.latest.open()
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
    c.close()
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects an HTTP error and a response belonging to another request', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    const c = new ZenonClient('https://rpc.example')
    await expect(c.call('method')).rejects.toThrow('HTTP 503')
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 99, result: null }))))
    await expect(c.call('method')).rejects.toThrow('identity')
    c.close()
  })
})
