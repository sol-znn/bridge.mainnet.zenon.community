// The Zenon side: which node the page reads from, the live momentum, and the
// Syrius wallet.
//
// The page reads from the configured default node. The node Syrius reports is
// used only when the user turns that on and confirms the network the node says
// it is on (its chain identifier), because that node decides everything the
// page shows: a devnet node shows that devnet's bridge. The choice is
// remembered with the chain identifier it was confirmed for, and dropped when
// either changes.
//
// Nothing here is tied to chain 1. The bridge's networks, contracts and token
// pairs are read from the embedded bridge contract of whichever chain the node
// is on, and blocks are built for that chain.
//
// Since v0.3.4 Syrius reports only `ws://host:port`. A node the page cannot
// use is refused with the reason:
//
//   - "embedded" or none: the wallet's internal node has no address.
//   - ws:// from an https page: the browser blocks mixed content. A node on
//     127.0.0.1 or localhost is the exception browsers make, and it is the
//     user's own machine, so a local devnet works from the deployed page.
//   - unreachable within 5 s.

import { reactive, shallowRef, watch } from 'vue'
import { config, setActiveChain, zenonNetworkName } from '../config.ts'
import { ZenonClient, type Momentum } from '../znn/client.ts'
import { ZenonApi } from '../znn/api.ts'
import { blockTemplate, type BlockSpec } from '../znn/block.ts'
import * as syriusWallet from '../wallet/syrius.ts'
import { journalSubmission } from './operations.ts'

export const node = reactive({
  url: config.defaultNode,
  source: 'default' as 'default' | 'wallet',
  /** The chain identifier the node reports; 0 until it has answered. */
  chainId: 0,
  notice: '',
  conn: 'connecting' as 'connecting' | 'open' | 'closed',
  height: 0,
  timestamp: 0,
  /** Seconds per momentum, measured over the recent ones. */
  rate: 10,
  /** Bumped on every momentum, for anything that refreshes on the chain's beat. */
  tick: 0,
  /** Invalidates all reads and operation drafts when the selected client changes. */
  epoch: 0,
})

watch(() => node.chainId, setActiveChain)

/** The chain the page is on: the node's, or the build's until it answers. */
export const chainId = () => node.chainId || config.zenonChainId
export const networkLabel = () => zenonNetworkName(chainId())
/** The explorers, the plasma bot and the liquidity pool belong to the build's chain only. */
export const onBuildChain = () => chainId() === config.zenonChainId

export const api = shallowRef<ZenonApi>(null as unknown as ZenonApi)
let client: ZenonClient | null = null
let stopMomentums: (() => void) | null = null
const recent: number[] = []

function attach(c: ZenonClient, knownChainId = 0) {
  node.epoch++
  stopMomentums?.()
  client?.close()
  client = c
  api.value = new ZenonApi(c)
  node.url = c.url
  c.onState = (s) => { if (client === c) node.conn = s }
  node.conn = c.state
  recent.length = 0
  // Another node may be on another chain, with a lower height.
  node.height = 0
  node.timestamp = 0
  node.chainId = knownChainId
  if (!knownChainId) {
    void c
      .frontierMomentum()
      .then((m) => client === c && (node.chainId = m.chainIdentifier))
      .catch(() => undefined)
  }
  const selectedApi = api.value
  void seedMomentums(c, selectedApi)
  stopMomentums = c.onMomentum((m) => onMomentum(m, c, selectedApi))
}

function onMomentum(m: Momentum, owner: ZenonClient, selectedApi: ZenonApi) {
  if (client !== owner) return
  if (m.height <= node.height) return
  // A subscription event carries only hash and height (go-zenon
  // rpc/api/subscribe/api.go), so the timestamp is read once per momentum.
  if (!m.timestamp) {
    void selectedApi
      .momentumAt(m.height)
      .then((full) => full && onMomentum(full, owner, selectedApi))
      .catch(() => undefined)
    return
  }
  node.height = m.height
  node.timestamp = m.timestamp
  recent.push(m.timestamp)
  if (recent.length > 30) recent.shift()
  if (recent.length > 2) node.rate = (recent[recent.length - 1] - recent[0]) / (recent.length - 1)
  node.tick++
}

async function seedMomentums(owner: ZenonClient, selectedApi: ZenonApi) {
  try {
    const list = await selectedApi.momentums(30)
    if (client !== owner || !list.length) return
    const ts = list.map((m) => m.timestamp).sort((a, b) => a - b)
    if (ts.length > 2) {
      recent.splice(0, recent.length, ...ts)
      node.rate = (ts[ts.length - 1] - ts[0]) / (ts.length - 1)
    }
    const top = list.reduce((a, b) => (b.height > a.height ? b : a), list[0])
    if (top) onMomentum(top, owner, selectedApi)
  } catch {
    /* the subscription fills it in */
  }
}

/** Opens the first default node that answers within 5 s, in config order. */
export async function startNode() {
  for (const url of config.defaultNodes) {
    const c = new ZenonClient(url)
    try {
      const m = await Promise.race([c.frontierMomentum(), new Promise<never>((_, r) => setTimeout(() => r(new Error('timeout')), 5000))])
      config.defaultNode = url
      // A remembered wallet node may have been restored first. Keep that one;
      // otherwise this is the page's connection.
      if (client && node.source === 'wallet') c.close()
      else attach(c, m.chainIdentifier)
      return
    } catch {
      c.close()
    }
  }
  // None answered: keep the first and let the client keep retrying.
  if (!client) attach(new ZenonClient(config.defaultNodes[0]))
}

/** Why the wallet's node cannot be used from this page, or '' if it can be tried. */
export function nodeProblem(url: string | null): string {
  if (!url || url === 'embedded' || !/^(wss?|https?):\/\//i.test(url)) return 'Syrius uses its embedded node'
  let u: URL
  try { u = new URL(url.replace(/^http/i, 'ws')) } catch { return 'Syrius node address is invalid' }
  if (!u.hostname || u.username || u.password || u.hash || url.length > 2048) return 'Syrius node address is invalid'
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (location.protocol === 'https:' && u.protocol === 'ws:' && !local) return 'Syrius node is not secure (ws)'
  return ''
}

const PREF_KEY = 'bridge.node'

interface NodePref {
  url: string
  chainId: number
}

function readPref(): NodePref | null {
  try {
    const p = JSON.parse(localStorage.getItem(PREF_KEY) ?? 'null') as NodePref | null
    return p && typeof p.url === 'string' && !nodeProblem(p.url) && Number.isSafeInteger(p.chainId) && p.chainId > 0 ? p : null
  } catch {
    return null
  }
}

function writePref(p: NodePref | null) {
  try {
    if (p) localStorage.setItem(PREF_KEY, JSON.stringify(p))
    else localStorage.removeItem(PREF_KEY)
  } catch {
    /* storage blocked: the choice lasts for this visit */
  }
}

/** The switch to the wallet's node, and the confirmation it waits on. */
export const walletNode = reactive({
  checking: false,
  problem: '',
  /** Probed and waiting for the user to confirm its network. */
  pending: null as NodePref | null,
})
let pendingProbe: ZenonClient | null = null
let probeEpoch = 0
let walletEpoch = 0
let walletConnectionWanted = true

const wsUrlOf = (url: string) => url.replace(/^http/i, 'ws')

async function probeNode(url: string): Promise<{ probe: ZenonClient; chainId: number }> {
  const probe = new ZenonClient(url)
  try {
    const m = await Promise.race([
      probe.frontierMomentum(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000)),
    ])
    return { probe, chainId: m.chainIdentifier }
  } catch (err) {
    probe.close()
    throw err
  }
}

function useDefault(notice = '') {
  node.notice = notice
  if (node.source === 'default') return
  node.source = 'default'
  attach(new ZenonClient(config.defaultNode))
}

/** Asks the wallet's node which chain it is on, then waits for confirmWalletNode. */
export async function requestWalletNode() {
  cancelWalletNode()
  const request = probeEpoch, account = syrius.address, walletUrl = syrius.nodeUrl
  walletNode.problem = nodeProblem(syrius.nodeUrl)
  if (walletNode.problem) return
  const url = wsUrlOf(syrius.nodeUrl!)
  walletNode.checking = true
  try {
    const { probe, chainId } = await probeNode(url)
    if (request !== probeEpoch || account !== syrius.address || walletUrl !== syrius.nodeUrl) { probe.close(); return }
    pendingProbe = probe
    walletNode.pending = { url, chainId }
  } catch {
    if (request === probeEpoch) walletNode.problem = 'Syrius node is unreachable'
  } finally {
    if (request === probeEpoch) walletNode.checking = false
  }
}

export function confirmWalletNode() {
  const p = walletNode.pending
  if (!p || !pendingProbe) return
  // The page may already be on that very node (Syrius set to the default).
  if (client && client.url === p.url) {
    pendingProbe.close()
    node.chainId = p.chainId
  } else attach(pendingProbe, p.chainId)
  pendingProbe = null
  walletNode.pending = null
  node.source = 'wallet'
  node.notice = ''
  writePref(p)
}

export function cancelWalletNode() {
  probeEpoch++
  walletNode.checking = false
  pendingProbe?.close()
  pendingProbe = null
  walletNode.pending = null
}

export function useDefaultNode() {
  cancelWalletNode()
  walletNode.problem = ''
  writePref(null)
  useDefault()
}

/**
 * Called whenever Syrius reports its state. Restores a confirmed choice when
 * the wallet still names the same node and that node is still on the same
 * chain; anything else goes back to the default node and says so.
 */
async function syncWalletNode(url: string | null, request: number) {
  walletNode.problem = ''
  const pref = readPref()
  if (!pref) return node.source === 'wallet' ? useDefault() : undefined
  const back = `Reading from ${hostOf(config.defaultNode)}.`
  if (nodeProblem(url) || wsUrlOf(url!) !== pref.url) {
    writePref(null)
    return useDefault(node.source === 'wallet' ? `Syrius changed its node. ${back}` : '')
  }
  if (node.source === 'wallet' && client?.url === pref.url) return
  try {
    const { probe, chainId } = await probeNode(pref.url)
    if (request !== walletEpoch || syrius.nodeUrl !== url || !syrius.address) { probe.close(); return }
    if (chainId !== pref.chainId) {
      probe.close()
      writePref(null)
      return useDefault(`Syrius node changed chain. ${back}`)
    }
    if (client && client.url === pref.url) {
      probe.close()
      node.chainId = chainId
    } else attach(probe, chainId)
    node.source = 'wallet'
    node.notice = ''
  } catch {
    if (request === walletEpoch) useDefault(`Syrius node is unreachable. ${back}`)
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// Syrius

export const syrius = reactive({
  present: false,
  address: null as string | null,
  chainId: null as number | null,
  nodeUrl: null as string | null,
  busy: false,
  hold: 0,
})

export const wrongZenonChain = () => syrius.address !== null && (syrius.chainId === null || node.chainId === 0 || syrius.chainId !== node.chainId)

async function applyWalletState(s: syriusWallet.WalletState, request: number) {
  if (request !== walletEpoch) return
  cancelWalletNode()
  syrius.present = s.present
  syrius.address = s.address
  syrius.chainId = s.chainId
  syrius.nodeUrl = s.nodeUrl
  if (s.address) await syncWalletNode(s.nodeUrl, request)
  else if (node.source === 'wallet') useDefault()
}

export async function detectSyrius() {
  const request = walletEpoch
  syrius.present = await syriusWallet.whenProviderReady()
  if (request !== walletEpoch) return
  if (!syrius.present) return
  // An origin approved earlier answers without a prompt; a new one answers empty.
  try {
    const s = await syriusWallet.readState()
    if (s.address) await applyWalletState(s, request)
  } catch {
    /* not connected yet */
  }
  syriusWallet.onWalletChange(async () => {
    if (!walletConnectionWanted) return
    const event = ++walletEpoch
    try { await applyWalletState(await syriusWallet.readState(), event) } catch { /* current connection remains unavailable */ }
  })
}

export async function connectSyrius() {
  walletConnectionWanted = true
  const request = ++walletEpoch
  syrius.busy = true
  try {
    await applyWalletState(await syriusWallet.connect({ onHold: (s) => (syrius.hold = s) }), request)
  } finally {
    if (request === walletEpoch) { syrius.busy = false; syrius.hold = 0 }
  }
}

export async function disconnectSyrius() {
  walletConnectionWanted = false
  walletEpoch++
  syrius.address = null
  syrius.chainId = null
  syrius.nodeUrl = null
  syrius.busy = false
  syrius.hold = 0
  cancelWalletNode()
  walletNode.problem = ''
  // The choice is kept: the same wallet on the same node and chain restores it.
  useDefault()
  try { await syriusWallet.disconnect() } catch { /* local disconnect is authoritative */ }
}

/** Hands a block to Syrius to sign and publish. Resolves with its hash. */
export async function sendBlock(spec: BlockSpec, beforePrompt: () => void = () => {}): Promise<string> {
  if (!syrius.address) throw new Error('Connect Syrius first')
  if (wrongZenonChain()) throw new Error(`Syrius is on chain ${syrius.chainId}, the page on chain ${chainId()}`)
  const account = syrius.address, selectedChain = node.chainId, epoch = node.epoch, selectedApi = api.value
  if (!selectedChain || !nodeIsCurrent() || !selectedApi) throw new Error('Node identity or freshness is unavailable')
  const template = blockTemplate(spec, selectedChain)
  const payload = JSON.stringify({ toAddress: template.toAddress, amount: template.amount, tokenStandard: template.tokenStandard, data: template.data, fromBlockHash: template.fromBlockHash, blockType: template.blockType })
  const guard = () => {
    beforePrompt()
    if (syrius.address !== account || syrius.chainId !== selectedChain || node.chainId !== selectedChain || node.epoch !== epoch || api.value !== selectedApi || !nodeIsCurrent()) throw new Error('Wallet or node changed. The original operation was not replaced.')
  }
  syrius.busy = true
  try {
    const result = await journalSubmission({ source: 'zenon', chainId: selectedChain, account, kind: 'zenon-send', payload }, guard, async () => {
      const sent = await syriusWallet.sendAccountBlock(template, { onHold: (s) => (syrius.hold = s), beforePrompt: guard, account })
      return sent.hash
    })
    return result.hash
  } finally {
    syrius.busy = false
    syrius.hold = 0
  }
}

export function nodeIsCurrent() {
  const age = Date.now() / 1000 - node.timestamp
  return node.conn === 'open' && !!node.chainId && !!node.timestamp && age <= 120 && age >= -60
}
