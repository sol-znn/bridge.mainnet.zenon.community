import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const account = '0x' + '12'.repeat(20), target = '0x' + '34'.repeat(20)
const hash = '0x' + 'ab'.repeat(32)
const intent = { source: 'evm' as const, chainId: 1, account, kind: 'fixture', payload: JSON.stringify({ to: target, data: '0x1234', value: '7' }) }
let storage: Map<string, string>
beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'))
  storage = new Map()
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

async function unknown() {
  const api = await import('../../src/state/operations.ts')
  await expect(api.journalSubmission(intent, () => {}, async () => { throw new Error('Lost wallet response') })).rejects.toThrow('Lost wallet response')
  return { ...api, operation: api.operations.entries[0] }
}

describe('explicit review of a lost, hashless wallet result', () => {
  it('does not unlock an account merely because time elapsed', async () => {
    const api = await unknown()
    vi.advanceTimersByTime(86_400_000)
    expect(() => api.beginOperation({ ...intent, payload: JSON.stringify({ to: target, data: '0x1234', value: '8' }) })).toThrow('unresolved')
    expect(api.operation.state).toBe('unknown')
  })
  it('requires both an explicit acknowledgement and the review delay', async () => {
    const api = await unknown()
    await expect(api.reviewHashlessOperation(api.operation.id, true)).rejects.toThrow('one minute')
    vi.advanceTimersByTime(60_000)
    await expect(api.reviewHashlessOperation(api.operation.id, false)).rejects.toThrow('original wallet prompt')
    expect(api.operation.reviewedAt).toBeUndefined()
    expect(api.operation.state).toBe('unknown')
  })
  it('retains the unresolved evidence across reload while allowing a different request', async () => {
    const api = await unknown()
    vi.advanceTimersByTime(60_000)
    await api.reviewHashlessOperation(api.operation.id, true)
    api.restoreOperations()
    expect(api.operations.entries[0]).toMatchObject({ ...intent, state: 'unknown', reviewedAt: Math.floor(Date.now() / 1000) })
    expect(api.operations.entries[0].hash).toBeUndefined()
    const reordered = { ...intent, kind: 'different-label', payload: JSON.stringify({ value: '07', data: '0x1234', to: target.toUpperCase().replace('0X', '0x') }) }
    expect(() => api.beginOperation(reordered)).toThrow('unresolved')
    expect(api.beginOperation({ ...intent, payload: JSON.stringify({ to: target, data: '0x1234', value: '8' }) }).state).toBe('awaiting-wallet')
    expect(api.operations.entries[0].state).toBe('unknown')
  })
  it('blocks a refreshed quote for the same economic request even when the router changes', async () => {
    const api = await import('../../src/state/operations.ts')
    const quote = { provider: 'first', fromChainId: 1, fromToken: target, toChainId: 56, toToken: target, recipient: account, fromAmount: '7', minimumOutput: '6', expiresAt: Date.now() }
    const previous = { ...intent, kind: 'swap', payload: JSON.stringify({ to: target, data: '0x1234', value: '7', quote }) }
    await expect(api.journalSubmission(previous, () => {}, async () => { throw new Error('Lost response') })).rejects.toThrow()
    vi.advanceTimersByTime(60_000)
    await api.reviewHashlessOperation(api.operations.entries[0].id, true)
    const refreshed = { ...intent, kind: 'swap', payload: JSON.stringify({ to: account, data: '0x5678', value: '7', quote: { ...quote, provider: 'other', expiresAt: Date.now() + 60_000, minimumOutput: '5' } }) }
    expect(() => api.beginOperation(refreshed)).toThrow('unresolved')
    expect(api.beginOperation({ ...refreshed, payload: JSON.stringify({ ...JSON.parse(refreshed.payload), quote: { ...quote, fromAmount: '9' } }) }).state).toBe('awaiting-wallet')
  })
  it('preserves a hashless Zenon send while distinguishing a new request from its exact intent', async () => {
    const api = await import('../../src/state/operations.ts')
    const { BRIDGE } = await import('../../src/config.ts')
    const payload = { toAddress: BRIDGE, amount: '7', tokenStandard: 'zts1znnxxxxxxxxxxxxx9z4ulx', data: '', fromBlockHash: '00'.repeat(32), blockType: 2 }
    const zenon = { source: 'zenon' as const, chainId: 1, account: 'z1qq6eg8n43g032hanpsfp02qcdmv7zfj3y2lt5d', kind: 'zenon-send', payload: JSON.stringify(payload) }
    await expect(api.journalSubmission(zenon, () => {}, async () => { throw new Error('Lost result') })).rejects.toThrow('Lost result')
    vi.advanceTimersByTime(60_000)
    await api.reviewHashlessOperation(api.operations.entries[0].id, true)
    expect(() => api.beginOperation({ ...zenon, payload: JSON.stringify({ ...payload, amount: '07' }) })).toThrow('unresolved')
    expect(api.beginOperation({ ...zenon, payload: JSON.stringify({ ...payload, amount: '8' }) }).state).toBe('awaiting-wallet')
    expect(api.operations.entries[0].state).toBe('unknown')
    expect(api.operations.entries[0].hash).toBeUndefined()
  })
  it.each(['submitted', 'mismatch'] as const)('cannot review a %s operation with a reported hash', async (state) => {
    const api = await unknown()
    api.updateOperation(api.operation.id, { state, hash })
    vi.advanceTimersByTime(60_000)
    await expect(api.reviewHashlessOperation(api.operation.id, true)).rejects.toThrow('without a reported hash')
    expect(api.operation.hash).toBe(hash)
    expect(api.operation.reviewedAt).toBeUndefined()
  })
  it('resumes the account pause if the original hash arrives after review', async () => {
    const api = await unknown()
    vi.advanceTimersByTime(60_000)
    await api.reviewHashlessOperation(api.operation.id, true)
    api.updateOperation(api.operation.id, { state: 'submitted', hash })
    expect(() => api.beginOperation({ ...intent, payload: JSON.stringify({ to: target, data: '0x1234', value: '8' }) })).toThrow('unresolved')
    expect(() => api.updateOperation(api.operation.id, { state: 'submitted', hash: '0x' + 'cd'.repeat(32) })).toThrow('cannot be replaced')
    expect(api.operation).toMatchObject({ state: 'submitted', hash })
  })
  it('cannot review while another tab still owns the original wallet request', async () => {
    const api = await unknown()
    vi.advanceTimersByTime(60_000)
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { locks: { request: vi.fn(async (_key, _options, callback) => callback(null)) } })
    await expect(api.reviewHashlessOperation(api.operation.id, true)).rejects.toThrow('Another tab still owns')
    expect(api.operation.reviewedAt).toBeUndefined()
  })
  it('keeps publication paused if the explicit review cannot be durably saved', async () => {
    const api = await unknown()
    vi.advanceTimersByTime(60_000)
    vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null, setItem: () => {} })
    await expect(api.reviewHashlessOperation(api.operation.id, true)).rejects.toThrow('Cannot save')
    expect(() => api.beginOperation({ ...intent, payload: JSON.stringify({ to: account, data: '0x1234', value: '8' }) })).toThrow('Cannot save')
    expect(JSON.parse(storage.values().next().value!)[0]).toMatchObject({ state: 'unknown' })
    expect(JSON.parse(storage.values().next().value!)[0].reviewedAt).toBeUndefined()
  })
  it('refuses changed review evidence from another tab', async () => {
    const api = await unknown()
    vi.advanceTimersByTime(60_000)
    await api.reviewHashlessOperation(api.operation.id, true)
    const [key, text] = storage.entries().next().value!
    const records = JSON.parse(text); records[0].reviewedAt++
    storage.set(key, JSON.stringify(records))
    expect(() => api.beginOperation({ ...intent, payload: JSON.stringify({ to: account, data: '0x1234', value: '8' }) })).toThrow('Stored operation evidence')
    expect(api.operations.entries).toHaveLength(1)
  })
})
