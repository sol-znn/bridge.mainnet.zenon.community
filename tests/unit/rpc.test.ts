import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ZenonClient, RpcError, parseJsonSafe } from '../../src/znn/client.ts'

class Socket {
  static OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  onopen?: () => void
  onclose?: () => void
  onmessage?: (event: { data: string }) => void
  sent: Array<{ id: number; method: string }> = []
  send(value: string) { this.sent.push(JSON.parse(value)) }
  constructor(_url: string) { Socket.instances.push(this) }
  open() { this.readyState = 1; this.onopen?.() }
  close() { this.readyState = 3; this.onclose?.() }
  message(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }) }
}
const front = { hash: 'ab'.repeat(32), height: 10, timestamp: 100, chainIdentifier: 322 }
beforeEach(() => { Socket.instances = []; vi.useFakeTimers(); vi.stubGlobal('WebSocket', Socket) })
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const flush = () => vi.advanceTimersByTimeAsync(0)

describe('RPC lifecycle and protocol failures', () => {
  it('preserves large integers and escaped metadata while classifying only missing data as null', async () => {
    expect(parseJsonSafe('{"a":9007199254740993,"s":"9007199254740993\\\"","negative":-9007199254740993}')).toEqual({ a: '9007199254740993', s: '9007199254740993"', negative: '-9007199254740993' })
    const c = new ZenonClient('http://rpc.example')
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
      const { id, method } = JSON.parse(options.body)
      return new Response(JSON.stringify({ id, error: { code: method === 'missing' ? -32000 : -32601, message: method === 'missing' ? 'data non existent' : 'method not found' } }))
    }))
    expect(await c.callOrNull('missing')).toBeNull()
    await expect(c.callOrNull('unsupported')).rejects.toBeInstanceOf(RpcError)
    c.close()
  })
  it('discards retired sockets and cancels reconnection when closed', async () => {
    const c = new ZenonClient('ws://rpc.example'), first = Socket.instances[0]!
    const pending = c.call('waiting'), failed = expect(pending).rejects.toThrow('closed')
    first.close(); await failed
    await vi.advanceTimersByTimeAsync(500)
    const second = Socket.instances[1]!
    first.open(); expect(c.state).toBe('connecting')
    second.open(); expect(c.state).toBe('open')
    second.close(); c.close()
    await vi.advanceTimersByTimeAsync(30_000)
    expect(Socket.instances).toHaveLength(2)
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects in-flight requests on unexpected disconnect and releases send errors', async () => {
    const c = new ZenonClient('ws://rpc.example'), s = Socket.instances[0]!
    s.open()
    const call = c.call('in-flight'), failed = expect(call).rejects.toThrow('closed')
    await flush(); s.close(); await failed
    c.close()
    const d = new ZenonClient('ws://rpc.example'), t = Socket.instances[1]!
    t.open(); t.send = () => { throw new Error('send failed') }
    await expect(d.call('send')).rejects.toThrow('send failed')
    d.close(); expect(vi.getTimerCount()).toBe(0)
  })
  it('matches response identities and rejects malformed or contradictory envelopes', async () => {
    const c = new ZenonClient('ws://rpc.example'), s = Socket.instances[0]!
    s.open()
    const good = c.call('good'); await flush()
    s.onmessage?.({ data: 'not-json' }); s.message([]); s.message({ id: 999, result: 1 })
    s.message({ id: s.sent[0]!.id, result: 42 }); expect(await good).toBe(42)
    for (const envelope of [{}, { error: { code: 'bad', message: 'bad' } }, { error: { code: -1, message: 'bad' }, result: null }]) {
      const bad = c.call('bad'), failed = expect(bad).rejects.toThrow('Malformed')
      await flush(); s.message({ id: s.sent.at(-1)!.id, ...envelope }); await failed
    }
    const missing = c.callOrNull('missing'); await flush()
    s.message({ id: s.sent.at(-1)!.id, error: { code: -32000, message: 'data non existent' } })
    expect(await missing).toBeNull(); c.close()
  })
  it('validates subscribed momentums and never emits after disposal', async () => {
    const c = new ZenonClient('ws://rpc.example'), s = Socket.instances[0]!, seen = vi.fn()
    const off = c.onMomentum(seen); s.open(); await flush()
    expect(s.sent.filter((r) => r.method === 'ledger.subscribe')).toHaveLength(1)
    s.message({ id: s.sent[0]!.id, result: 'sub-1' }); await flush()
    s.message({ method: 'ledger.subscription', params: { subscription: 'other', result: front } })
    s.message({ method: 'ledger.subscription', params: { subscription: 'sub-1', result: [{ ...front, height: -1 }, front] } })
    expect(seen).toHaveBeenCalledExactlyOnceWith(front)
    s.message({ method: 'ledger.subscription', params: { subscription: 'sub-1', result: { hash:front.hash,height:11 } } })
    expect(seen).toHaveBeenLastCalledWith({hash:front.hash,height:11,timestamp:0,chainIdentifier:0})
    off(); s.message({ method: 'ledger.subscription', params: { subscription: 'sub-1', result: front } })
    expect(seen).toHaveBeenCalledTimes(2); c.close()
    expect(() => c.onMomentum(seen)).toThrow('closed')
  })
  it('falls back to polling on refused subscription without overlapping slow reads', async () => {
    const c = new ZenonClient('ws://rpc.example'), s = Socket.instances[0]!, seen = vi.fn()
    s.open(); const off = c.onMomentum(seen); await flush()
    s.message({ id: s.sent[0]!.id, error: { code: -32601, message: 'subscriptions disabled' } }); await flush()
    expect(s.sent.at(-1)!.method).toBe('ledger.getFrontierMomentum')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(s.sent.filter((r) => r.method === 'ledger.getFrontierMomentum')).toHaveLength(1)
    s.message({ id: s.sent.at(-1)!.id, result: front }); await flush()
    expect(seen).toHaveBeenCalledExactlyOnceWith(front)
    off(); c.close(); expect(vi.getTimerCount()).toBe(0)
  })
  it('aborts HTTP requests at disposal and rejects unsafe frontiers', async () => {
    const c = new ZenonClient('http://rpc.example')
    vi.stubGlobal('fetch', vi.fn((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))))))
    const request = c.call('slow'), failed = expect(request).rejects.toThrow('aborted')
    c.close(); await failed; expect(vi.getTimerCount()).toBe(0)
    vi.stubGlobal('fetch', vi.fn(async (_url, options) => new Response(JSON.stringify({ id: JSON.parse(options.body).id, result: { ...front, height: '9007199254740993' } }))))
    const d = new ZenonClient('http://rpc.example')
    await expect(d.frontierMomentum()).rejects.toThrow('integer'); d.close()
  })
})
