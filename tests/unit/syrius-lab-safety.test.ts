import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  assertWalletLab, assertPageOrigin, createResultsDirectory, forwardEvmRead,
  LAB_EVM_HTTP, LAB_ZNN_HTTP, validateBridgeUrl, validateLabLabel,
} from '../../e2e/syrius/lab-safety.mjs'

const pageUrl = 'http://127.0.0.1:4174/'
const frontier = { chainIdentifier: 322, height: 8, hash: 'ab'.repeat(32) }
const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
const roots: string[] = []
const root = () => { const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'syrius-guard-')); roots.push(dir); return dir }
afterEach(() => { vi.useRealTimers(); for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('isolated wallet lab preflight', () => {
  it('accepts literal loopback HTTP URLs and flat run labels', () => {
    for (const value of [pageUrl, 'http://localhost:4174/bridge/', 'http://[::1]:4174/']) expect(validateBridgeUrl(value)).toBe(new URL(value).href)
    for (const value of ['run-1', 'mv2.019', 'a', 'a'.repeat(64)]) expect(validateLabLabel(value)).toBe(value)
  })

  it('refuses remote, aliased, credentialed and ambiguous bridge URLs', () => {
    for (const value of ['https://127.0.0.1/', 'http://example.invalid/', 'http://127.0.0.2/', 'http://127.1/', 'http://2130706433/', 'http://0177.0.0.1/', 'http://localhost./', 'http://localhost.example.invalid/', 'http://user@localhost/', 'http://localhost:0/', 'http://localhost:65536/', 'http://localhost/?secret=x', 'http://localhost/#x', 'http:\\localhost/', ' http://localhost/', 'file:///app', undefined]) {
      expect(() => validateBridgeUrl(value)).toThrow('Isolated wallet lab refused')
    }
  })

  it('refuses traversal, reserved and invalid labels', () => {
    for (const value of [undefined, '', '.', '..', '../run', 'a/b', 'a\\b', '/absolute', '.hidden', 'a.', 'a b', 'a'.repeat(65), 'CON', 'lpt1.log']) expect(() => validateLabLabel(value)).toThrow()
  })

  it('checks only fixed local endpoints with bounded, redirect-refusing requests', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(frontier)).mockResolvedValueOnce(reply('0x7a69'))
    await assertWalletLab({ label: 'run', pageUrl }, fetcher)
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([LAB_ZNN_HTTP, LAB_EVM_HTTP])
    expect(fetcher.mock.calls.map(([, options]) => JSON.parse(String(options?.body)))).toEqual([
      { jsonrpc: '2.0', id: 1, method: 'ledger.getFrontierMomentum', params: [] },
      { jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] },
    ])
    for (const [, options] of fetcher.mock.calls) { expect(options?.redirect).toBe('error'); expect(options?.signal).toBeInstanceOf(AbortSignal) }
  })

  it('rejects unsafe configuration before making any RPC request', async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(assertWalletLab({ label: '../run', pageUrl }, fetcher)).rejects.toThrow()
    await expect(assertWalletLab({ label: 'run', pageUrl: 'http://example.invalid/' }, fetcher)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('rejects wrong chains, missing frontier identities and invalid heights', async () => {
    for (const value of [{ ...frontier, chainIdentifier: 1 }, { ...frontier, chainIdentifier: '322' }, { ...frontier, hash: '' }, { ...frontier, height: 0 }, { ...frontier, height: 1.5 }, null]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(value))
      await expect(assertWalletLab({ label: 'run', pageUrl }, fetcher)).rejects.toThrow('Isolated wallet lab refused')
      expect(fetcher).toHaveBeenCalledTimes(1)
    }
    for (const chain of ['0x1', '0x7a6a', 31337, null]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(frontier)).mockResolvedValueOnce(reply(chain))
      await expect(assertWalletLab({ label: 'run', pageUrl }, fetcher)).rejects.toThrow()
    }
  })

  it('rejects malformed, mismatched and error RPC replies', async () => {
    for (const body of ['{', 'null', '{}', JSON.stringify({ jsonrpc: '2.0', id: 2, result: frontier }), JSON.stringify({ jsonrpc: '1.0', id: 1, result: frontier }), JSON.stringify({ jsonrpc: '2.0', id: 1, result: frontier, error: null }), JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'fixture' } })]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(body))
      await expect(assertWalletLab({ label: 'run', pageUrl }, fetcher)).rejects.toThrow('Isolated wallet lab refused')
    }
  })

  it('bounds response bodies and refuses non-successful or truncated transport', async () => {
    const broken = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([123])); controller.error(new Error('fixture stream failure')) } })
    for (const response of [new Response('', { status: 503 }), new Response('x', { headers: { 'content-length': '16385' } }), new Response('x'.repeat(16385)), new Response(new Uint8Array([0xff])), new Response(broken)]) {
      await expect(assertWalletLab({ label: 'run', pageUrl }, vi.fn<typeof fetch>().mockResolvedValueOnce(response))).rejects.toThrow('Isolated wallet lab refused')
    }
  })

  it('enforces a deadline even if the fetch implementation never settles', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}))
    const checked = expect(assertWalletLab({ label: 'run', pageUrl }, fetcher)).rejects.toThrow('Isolated wallet lab refused')
    await vi.advanceTimersByTimeAsync(5000)
    await checked
    expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true)
  })

  it('rechecks endpoints rather than caching an earlier chain match', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply(frontier)).mockResolvedValueOnce(reply('0x7a69')).mockResolvedValueOnce(reply({ ...frontier, chainIdentifier: 1 }))
    await assertWalletLab({ label: 'run', pageUrl }, fetcher)
    await expect(assertWalletLab({ label: 'run', pageUrl }, fetcher)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(3)
  })
})

describe('mock EVM wallet relay', () => {
  it('forwards a read only after checking the actual lab chain', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('0x7a69')).mockResolvedValueOnce(reply('0x0'))
    const result = await forwardEvmRead(JSON.stringify({ method: 'eth_getBalance', params: ['0x' + '12'.repeat(20), 'latest'] }), pageUrl, pageUrl, fetcher)
    expect(JSON.parse(result).result).toBe('0x0')
    expect(fetcher.mock.calls.map(([, options]) => JSON.parse(String(options?.body)).method)).toEqual(['eth_chainId', 'eth_getBalance'])
  })

  it('preserves a valid contract revert without allowing malformed RPC errors', async () => {
    const error = { code: -32000, message: 'fixture revert' }
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('0x7a69')).mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error })))
    expect(JSON.parse(await forwardEvmRead('{"method":"eth_call","params":[]}', pageUrl, pageUrl, fetcher)).error).toEqual(error)
    const malformed = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('0x7a69')).mockResolvedValueOnce(new Response('{"jsonrpc":"2.0","id":1,"error":null}'))
    await expect(forwardEvmRead('{"method":"eth_call","params":[]}', pageUrl, pageUrl, malformed)).rejects.toThrow()
  })

  it('refuses signing, submission, administration, batches and malformed requests before forwarding', async () => {
    const fetcher = vi.fn<typeof fetch>()
    for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'eth_sign', 'personal_sign', 'eth_signTypedData_v4', 'anvil_setBalance', 'debug_traceTransaction']) {
      await expect(forwardEvmRead(JSON.stringify({ method, params: [] }), pageUrl, pageUrl, fetcher)).rejects.toThrow()
    }
    for (const json of ['[]', 'null', '{', '{"method":"eth_call","params":{}}', 'x'.repeat(65537)]) await expect(forwardEvmRead(json, pageUrl, pageUrl, fetcher)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('refuses origin drift and a changed local chain', async () => {
    expect(() => assertPageOrigin('http://127.0.0.1:4175/', pageUrl)).toThrow()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(reply('0x1'))
    await expect(forwardEvmRead('{"method":"eth_call","params":[]}', 'http://localhost:4174/', pageUrl, fetcher)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
    await expect(forwardEvmRead('{"method":"eth_call","params":[]}', pageUrl, pageUrl, fetcher)).rejects.toThrow()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})

describe('wallet lab evidence isolation', () => {
  it('creates a fresh private child and preserves earlier run evidence', () => {
    const dir = root(), output = createResultsDirectory('run', dir)
    fs.writeFileSync(path.join(output, 'evidence.txt'), 'retained fixture')
    expect(() => createResultsDirectory('run', dir)).toThrow('fresh label')
    expect(fs.readFileSync(path.join(output, 'evidence.txt'), 'utf8')).toBe('retained fixture')
    expect(fs.statSync(output).mode & 0o777).toBe(0o700)
    expect(() => createResultsDirectory('../escape', dir)).toThrow()
    expect(fs.readdirSync(dir)).toEqual(['run'])
  })

  it('refuses symlinked output roots and ancestors without changing their targets', () => {
    const dir = root(), target = path.join(dir, 'target'), link = path.join(dir, 'link')
    fs.mkdirSync(target); fs.symlinkSync(target, link, 'dir')
    for (const output of [link, path.join(link, 'nested')]) expect(() => createResultsDirectory('run', output)).toThrow()
    expect(fs.readdirSync(target)).toEqual([])
  })
})
