// Only the caller's fresh local Anvil fork may receive fixture writes.
class ForkRpcError extends Error {}

export function localForkUrl(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('Set SWAP_FORK to a literal loopback HTTP endpoint') }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname) ||
      !url.port || Number(url.port) < 1024 || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('SWAP_FORK requires a literal loopback HTTP endpoint without credentials or routing data')
  }
  return url.href
}

export function forkRpc(endpoint, fetchImpl = fetch) {
  const url = localForkUrl(endpoint)
  let id = 0
  return async (method, params = []) => {
    const requestId = ++id
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    let reader
    try {
      const response = await fetchImpl(url, {
        method: 'POST', redirect: 'error', signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
      })
      if (!response.ok || !response.body) throw new ForkRpcError('Fork RPC is unavailable')
      reader = response.body.getReader()
      const parts = []; let bytes = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        bytes += value.byteLength
        if (bytes > 256 * 1024) throw new ForkRpcError('Fork RPC response exceeds its byte limit')
        parts.push(value)
      }
      const payload = new Uint8Array(bytes); let offset = 0
      for (const part of parts) { payload.set(part, offset); offset += part.byteLength }
      const reply = JSON.parse(new TextDecoder().decode(payload))
      if (reply?.jsonrpc !== '2.0' || reply.id !== requestId || reply.error || !Object.hasOwn(reply, 'result')) {
        throw new ForkRpcError('Fork RPC returned an invalid or failed response')
      }
      return reply.result
    } catch (error) {
      if (error instanceof ForkRpcError) throw error
      throw new ForkRpcError(controller.signal.aborted ? 'Fork RPC deadline exceeded' : 'Fork RPC request failed')
    } finally {
      clearTimeout(timer)
      await reader?.cancel().catch(() => {})
    }
  }
}

export async function assertEthereumFork(rpc, version) {
  const client = await rpc('web3_clientVersion')
  const escaped = version.replaceAll('.', '\\.')
  if (typeof client !== 'string' || !new RegExp(`^anvil/v${escaped}(?:$|[-+\\s])`, 'i').test(client)) {
    throw new Error('The swap fixture requires the pinned Anvil version')
  }
  if (await rpc('eth_chainId') !== '0x1') throw new Error('The swap fixture requires Ethereum chain 1')
  const info = await rpc('anvil_nodeInfo')
  if (info?.environment?.chainId !== 1 || (info.network && info.network !== 'ethereum') ||
      !Number.isSafeInteger(info.forkConfig?.forkBlockNumber) || info.forkConfig.forkBlockNumber < 1) {
    throw new Error('Anvil must identify a forked Ethereum state before fixture writes')
  }
  const metadata = await rpc('anvil_metadata')
  const fork = metadata?.forkedNetwork
  if (metadata?.chainId !== 1 || fork?.chainId !== 1 || fork.forkBlockNumber !== info.forkConfig.forkBlockNumber ||
      typeof fork.forkBlockHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(fork.forkBlockHash)) {
    throw new Error('Anvil fork source identity is missing or mismatching')
  }
  return { clientVersion: client, forkBlockNumber: info.forkConfig.forkBlockNumber }
}
