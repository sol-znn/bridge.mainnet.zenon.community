import fs from 'node:fs'
import path from 'node:path'

export const LAB_ZNN_HTTP = 'http://127.0.0.1:46997'
export const LAB_EVM_HTTP = 'http://127.0.0.1:46545'
export const EVM_READ_METHODS = Object.freeze([
  'eth_blockNumber', 'eth_call', 'eth_estimateGas', 'eth_feeHistory', 'eth_gasPrice',
  'eth_getBalance', 'eth_getBlockByHash', 'eth_getBlockByNumber', 'eth_getCode',
  'eth_getLogs', 'eth_getTransactionByHash', 'eth_getTransactionCount',
  'eth_getTransactionReceipt', 'eth_maxPriorityFeePerGas',
])
const MAX_REPLY = 16 * 1024
const refuse = () => new Error('Isolated wallet lab refused')

export function validateLabLabel(label) {
  if (typeof label !== 'string' || !/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9_-])?$/i.test(label) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(label)) throw refuse()
  return label
}

function loopbackUrl(value, navigation = false) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\]/.test(value)) throw refuse()
  let url
  try { url = new URL(value) } catch { throw refuse() }
  const authority = value.match(/^http:\/\/([^/?#]+)(?:[/?#]|$)/)?.[1]
  if (!authority || !/^(127\.0\.0\.1|localhost|\[::1\])(?::[1-9][0-9]{0,4})?$/.test(authority) ||
      url.protocol !== 'http:' || url.username || url.password || (!navigation && (url.search || url.hash))) throw refuse()
  return url.href
}

export function validateBridgeUrl(value) { return loopbackUrl(value) }

export function assertPageOrigin(actual, expected) {
  if (new URL(loopbackUrl(actual, true)).origin !== new URL(validateBridgeUrl(expected)).origin) throw refuse()
}

async function rpc(method, params, endpoint, fetchImpl, allowError = false) {
  const controller = new AbortController()
  let timer
  let reader
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(endpoint, {
          method: 'POST', redirect: 'error', signal: controller.signal,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        })
        if (response.status !== 200 || !response.body) throw refuse()
        const length = response.headers.get('content-length')
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_REPLY)) throw refuse()
        reader = response.body.getReader()
        const decoder = new TextDecoder('utf-8', { fatal: true })
        let text = '', size = 0
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > MAX_REPLY) throw refuse()
          text += decoder.decode(value, { stream: true })
        }
        text += decoder.decode()
        const reply = JSON.parse(text)
        if (reply?.jsonrpc !== '2.0' || reply.id !== 1 ||
            Object.hasOwn(reply, 'result') === Object.hasOwn(reply, 'error') ||
            (Object.hasOwn(reply, 'error') && (!allowError || !Number.isInteger(reply.error?.code) || typeof reply.error?.message !== 'string'))) throw refuse()
        return reply
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(refuse()) }, 5000) }),
    ])
  } catch { throw refuse() } finally {
    clearTimeout(timer)
    controller.abort()
    void reader?.cancel().catch(() => {})
  }
}

export async function assertWalletLab({ label, pageUrl }, fetchImpl = globalThis.fetch) {
  validateLabLabel(label)
  validateBridgeUrl(pageUrl)
  const { result: frontier } = await rpc('ledger.getFrontierMomentum', [], LAB_ZNN_HTTP, fetchImpl)
  if (frontier?.chainIdentifier !== 322 || !Number.isSafeInteger(frontier.height) || frontier.height < 1 ||
      typeof frontier.hash !== 'string' || !/^[0-9a-f]{64}$/i.test(frontier.hash)) throw refuse()
  const { result: evm } = await rpc('eth_chainId', [], LAB_EVM_HTTP, fetchImpl)
  if (evm !== '0x7a69') throw refuse()
}

export async function forwardEvmRead(json, actualPage, expectedPage, fetchImpl = globalThis.fetch) {
  assertPageOrigin(actualPage, expectedPage)
  if (typeof json !== 'string' || json.length > 64 * 1024) throw refuse()
  let request
  try { request = JSON.parse(json) } catch { throw refuse() }
  if (!EVM_READ_METHODS.includes(request?.method) || !Array.isArray(request.params)) throw refuse()
  const { result: chain } = await rpc('eth_chainId', [], LAB_EVM_HTTP, fetchImpl)
  if (chain !== '0x7a69') throw refuse()
  return JSON.stringify(await rpc(request.method, request.params, LAB_EVM_HTTP, fetchImpl, true))
}

function checkDirectoryAncestors(directory) {
  let current = directory
  for (;;) {
    try { if (!fs.lstatSync(current).isDirectory()) throw refuse() } catch (error) {
      if (error.code !== 'ENOENT') throw refuse()
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

export function createResultsDirectory(label, root = process.env.RESULTS_DIR || 'e2e/.state/syrius') {
  validateLabLabel(label)
  if (typeof root !== 'string' || !root) throw refuse()
  const directory = path.resolve(root)
  checkDirectoryAncestors(directory)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  checkDirectoryAncestors(directory)
  const before = fs.lstatSync(directory)
  const output = path.join(directory, label)
  try { fs.mkdirSync(output, { mode: 0o700 }) } catch { throw new Error('Wallet lab results require a fresh label') }
  const after = fs.lstatSync(directory)
  if (!after.isDirectory() || before.dev !== after.dev || before.ino !== after.ino) throw refuse()
  return output
}
