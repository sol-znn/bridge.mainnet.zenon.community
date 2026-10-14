import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { assertEthereumFork, forkRpc, localForkUrl } from '../../e2e/lib/swap-fork.mjs'

afterEach(() => vi.useRealTimers())

describe('swap fork publication preflight', () => {
  it('accepts explicit literal loopback endpoints', () => {
    expect(localForkUrl('http://127.0.0.1:46599')).toBe('http://127.0.0.1:46599/')
    expect(localForkUrl('http://[::1]:46599')).toBe('http://[::1]:46599/')
  })
  it('refuses remote endpoints and credential/routing ambiguity before contacting anything', () => {
    const fetcher = vi.fn()
    for (const url of ['https://example.invalid:8545', 'http://localhost:8545', 'http://127.0.0.1',
      'http://127.0.0.1:8545/path', 'http://127.0.0.1:8545/?token=private',
      'http://user:private@127.0.0.1:8545', 'http://127.0.0.1:8545/#fragment']) {
      expect(() => forkRpc(url, fetcher)).toThrow()
    }
    expect(fetcher).not.toHaveBeenCalled()
  })
  it('requires the pinned client, Ethereum chain and actual fork metadata using reads only', async () => {
    // Pinned Anvil v1.8.5 uses NodeInfo.environment and a separate Metadata reply.
    const replies: Record<string, unknown> = { web3_clientVersion:'anvil/v1.8.5', eth_chainId:'0x1',
      anvil_nodeInfo:{environment:{chainId:1},network:'ethereum',forkConfig:{forkBlockNumber:22000000,forkUrl:'private'}},
      anvil_metadata:{chainId:1,forkedNetwork:{chainId:1,forkBlockNumber:22000000,forkBlockHash:'0x'+'ab'.repeat(32)}} }
    const rpc = vi.fn(async (method: string) => replies[method])
    await expect(assertEthereumFork(rpc, '1.8.5')).resolves.toEqual({clientVersion:'anvil/v1.8.5',forkBlockNumber:22000000})
    expect(rpc.mock.calls.map(([method]) => method)).toEqual(['web3_clientVersion','eth_chainId','anvil_nodeInfo','anvil_metadata'])
  })
  it('does not accept a live client or a different Anvil version', async () => {
    for (const client of ['Geth/v1.8.5', 'anvil/v1.8.50', 'anvil/v1.7.0']) {
      const rpc = vi.fn().mockResolvedValue(client)
      await expect(assertEthereumFork(rpc, '1.8.5')).rejects.toThrow('pinned Anvil')
      expect(rpc).toHaveBeenCalledTimes(1)
    }
  })
  it('refuses the isolated devnet chain instead of using it as an Ethereum fork', async () => {
    const rpc = vi.fn().mockResolvedValueOnce('anvil/v1.8.5').mockResolvedValueOnce('0x7a69')
    await expect(assertEthereumFork(rpc, '1.8.5')).rejects.toThrow('chain 1')
    expect(rpc).toHaveBeenCalledTimes(2)
  })
  it('refuses non-forked, malformed or mismatching fork metadata', async () => {
    for (const info of [{environment:{chainId:1}}, {environment:{chainId:1},forkConfig:{forkBlockNumber:0}},
      {environment:{chainId:1},forkConfig:{forkBlockNumber:'22000000'}}, {environment:{chainId:31337},forkConfig:{forkBlockNumber:22000000}},
      {chainId:1,forkConfig:{forkBlockNumber:22000000}}, {environment:{chainId:1},network:'base',forkConfig:{forkBlockNumber:22000000}}]) {
      const rpc = vi.fn().mockResolvedValueOnce('anvil/v1.8.5').mockResolvedValueOnce('0x1').mockResolvedValueOnce(info)
      await expect(assertEthereumFork(rpc, '1.8.5')).rejects.toThrow('forked Ethereum')
      expect(rpc).toHaveBeenCalledTimes(3)
    }
  })
  it('refuses a different source chain hidden by a local chain override', async () => {
    const rpc = vi.fn().mockResolvedValueOnce('anvil/v1.8.5').mockResolvedValueOnce('0x1')
      .mockResolvedValueOnce({environment:{chainId:1},forkConfig:{forkBlockNumber:22000000}})
      .mockResolvedValueOnce({chainId:1,forkedNetwork:{chainId:56,forkBlockNumber:22000000,forkBlockHash:'0x'+'ab'.repeat(32)}})
    await expect(assertEthereumFork(rpc,'1.8.5')).rejects.toThrow('source identity')
    expect(rpc).toHaveBeenCalledTimes(4)
  })
  it('refuses incomplete or mismatching source block identity', async () => {
    for (const fork of [undefined,{chainId:1,forkBlockNumber:21999999,forkBlockHash:'0x'+'ab'.repeat(32)},
      {chainId:1,forkBlockNumber:22000000,forkBlockHash:'not-a-hash'}]) {
      const rpc = vi.fn().mockResolvedValueOnce('anvil/v1.8.5').mockResolvedValueOnce('0x1')
        .mockResolvedValueOnce({environment:{chainId:1},forkConfig:{forkBlockNumber:22000000}})
        .mockResolvedValueOnce({chainId:1,forkedNetwork:fork})
      await expect(assertEthereumFork(rpc,'1.8.5')).rejects.toThrow('source identity')
    }
  })
  it('the actual CLI sends no fixture writes to a rejected client', async () => {
    const methods: string[] = []
    const server = createServer(async (request, response) => {
      let raw = ''
      for await (const part of request) raw += part
      const message = JSON.parse(raw)
      methods.push(message.method)
      response.setHeader('content-type','application/json')
      response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,
        ...(message.method==='web3_clientVersion' ? {result:'Geth/v1.8.5'} : {error:{code:-32000,message:'Fixture writes refused'}})}))
    })
    await new Promise<void>((resolve) => server.listen(0,'127.0.0.1',resolve))
    try {
      const port = (server.address() as {port:number}).port
      const script = fileURLToPath(new URL('../../e2e/swap.fork.mjs',import.meta.url))
      const exit = await new Promise<number | null>((resolve,reject) => {
        const child = spawn(process.execPath,[script], {timeout:10000,stdio:'ignore',
          env:{...process.env,SWAP_FORK:`http://127.0.0.1:${port}`,CHROME_PATH:'not-used-for-preflight'}})
        child.on('error',reject);child.on('close',resolve)
      })
      expect(exit).toBe(1)
      expect(methods).toEqual(['web3_clientVersion'])
    } finally {
      await new Promise<void>((resolve,reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  },15000)
})

describe('bounded fork RPC', () => {
  it('preserves a correctly paired unresolved response without a retry', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({jsonrpc:'2.0',id:1,result:null})))
    await expect(forkRpc('http://127.0.0.1:46599',fetcher)('eth_getTransactionReceipt',['original-hash'])).resolves.toBeNull()
    expect(fetcher).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({jsonrpc:'2.0',id:1,method:'eth_getTransactionReceipt',params:['original-hash']})
  })
  it('refuses redirects and pairs responses to the original request', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({jsonrpc:'2.0',id:2,result:'0x1'})))
    await expect(forkRpc('http://127.0.0.1:46599',fetcher)('eth_chainId')).rejects.toThrow('invalid or failed')
    expect(fetcher.mock.calls[0][1].redirect).toBe('error')
  })
  it('the native transport never follows a redirect to another service', async () => {
    let destinationRequests = 0
    const destination = createServer((_request,response) => {destinationRequests++;response.end('{}')})
    await new Promise<void>((resolve) => destination.listen(0,'127.0.0.1',resolve))
    const targetPort = (destination.address() as {port:number}).port
    const redirect = createServer((_request,response) => {
      response.writeHead(302,{location:`http://127.0.0.1:${targetPort}/`});response.end()
    })
    await new Promise<void>((resolve) => redirect.listen(0,'127.0.0.1',resolve))
    try {
      const port = (redirect.address() as {port:number}).port
      await expect(forkRpc(`http://127.0.0.1:${port}`)('eth_chainId')).rejects.toThrow('Fork RPC request failed')
      expect(destinationRequests).toBe(0)
    } finally {
      await Promise.all([redirect,destination].map((server) => new Promise<void>((resolve,reject) => {
        server.close((error) => error ? reject(error) : resolve())
      })))
    }
  })
  it('does not export private server error text', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({jsonrpc:'2.0',id:1,error:{message:'private fork URL'}})))
    await expect(forkRpc('http://127.0.0.1:46599',fetcher)('eth_chainId')).rejects.toThrow('Fork RPC returned an invalid or failed response')
  })
  it('does not export malformed body or transport details', async () => {
    const malformed = vi.fn().mockResolvedValue(new Response('private fork URL'))
    await expect(forkRpc('http://127.0.0.1:46599',malformed)('eth_chainId')).rejects.toThrow('Fork RPC request failed')
    const unavailable = vi.fn().mockRejectedValue(new Error('private endpoint detail'))
    await expect(forkRpc('http://127.0.0.1:46599',unavailable)('eth_chainId')).rejects.toThrow('Fork RPC request failed')
  })
  it('cancels oversized response bodies', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream({start(controller) {controller.enqueue(new Uint8Array(256*1024+1))},cancel})
    const fetcher = vi.fn().mockResolvedValue(new Response(body))
    await expect(forkRpc('http://127.0.0.1:46599',fetcher)('eth_chainId')).rejects.toThrow('byte limit')
    expect(cancel).toHaveBeenCalledTimes(1)
  })
  it('aborts an unavailable endpoint without retrying the original request', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('aborted')))
    }))
    const result = forkRpc('http://127.0.0.1:46599',fetcher as typeof fetch)('eth_chainId')
    const rejected = expect(result).rejects.toThrow('deadline exceeded')
    await vi.advanceTimersByTimeAsync(8000)
    await rejected
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
})
