// The bridge lab as the tests see it: endpoints, keys, and the helpers that
// send a Zenon block and wait for it to be confirmed.
//
// Every key here is public and worthless outside the lab: go-zenon's devnet
// mnemonic, anvil's default accounts, and a fixed secp256k1 key standing in
// for the orchestrators' TSS key.

import { createPublicClient, createWalletClient, http, defineChain, type PublicClient, type WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { keccak256, toBytes } from 'viem'
import { Account } from './wallet.ts'
import { publishBlock } from './publish.ts'
import { archiveRejectedPublication } from './publication-journal.ts'
import { ZenonClient } from '../../src/znn/client.ts'
import { ZenonApi } from '../../src/znn/api.ts'
import type { BlockSpec } from '../../src/znn/block.ts'
import { evmAddressOfPublicKey, tssPublicKey } from './messages.ts'
import { EMPTY_ADDRESS } from '../../src/znn/primitives.ts'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { blockTemplate, type BlockJson } from '../../src/znn/block.ts'

export const ZNN_HTTP = process.env.LAB_RPC || 'http://127.0.0.1:46997'
export const ZNN_WS = process.env.LAB_WS || 'ws://127.0.0.1:46998'
export const EVM_RPC = process.env.LAB_EVM || 'http://127.0.0.1:46545'
for (const endpoint of [ZNN_HTTP, ZNN_WS, EVM_RPC]) {
  const url = new URL(endpoint)
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Lab endpoints must be isolated loopback addresses')
}
export const ZNN_CHAIN_ID = 322
export const EVM_CHAIN_ID = 31337
export const NETWORK_CLASS = 2

/** go-zenon cmd/devnet-keygen/main.go. */
export const DEV_MNEMONIC =
  'abstract affair idle position alien fluid board ordinary exist afraid chapter wood wood guide sun walnut crew perfect place firm poverty model side million'

/** Index 1: funded and fused in genesis. Administrator, orchestrator sender and user. */
export const zAdmin = Account.fromMnemonic(DEV_MNEMONIC, 1)
export const LAB_ADMIN_ADDRESS = 'z1qq6eg8n43g032hanpsfp02qcdmv7zfj3y2lt5d'

/** The stand-in for the TSS key. */
export const TSS_KEY = toBytes(keccak256(toBytes('bridge-lab-tss-key')))
export const TSS_PUBKEY_COMPRESSED = tssPublicKey(TSS_KEY, true)
export const TSS_PUBKEY = tssPublicKey(TSS_KEY, false)
export const TSS_EVM_ADDRESS = evmAddressOfPublicKey(TSS_PUBKEY)

/** anvil's default accounts 0 (deployer and EVM administrator) and 1 (user). */
export const evmAdmin = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
export const evmUser = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d')

export const anvil = defineChain({
  id: EVM_CHAIN_ID,
  name: 'Anvil',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [EVM_RPC] } },
})

export const evmPublic: PublicClient = createPublicClient({ chain: anvil, transport: http(EVM_RPC) }) as PublicClient
export const evmAdminWallet: WalletClient = createWalletClient({ chain: anvil, transport: http(EVM_RPC), account: evmAdmin })
export const evmUserWallet: WalletClient = createWalletClient({ chain: anvil, transport: http(EVM_RPC), account: evmUser })

export async function mine(blocks: number): Promise<void> {
  await assertLab()
  await evmPublic.request({ method: 'anvil_mine' as never, params: [`0x${blocks.toString(16)}`] as never })
}

/** Deterministic protocol delay boundaries; UI receipt waits use interval mining. */
export async function evmClock(intervalSeconds: number): Promise<void> {
  await assertLab()
  await evmPublic.request({ method: 'evm_setIntervalMining' as never, params: [intervalSeconds] as never })
  await evmPublic.request({ method: 'evm_setAutomine' as never, params: [intervalSeconds === 0] as never })
}

export const znn = new ZenonClient(ZNN_HTTP)
export const zapi = new ZenonApi(znn)

export async function assertLab(): Promise<void> {
  const [evmChain, momentum] = await Promise.all([evmPublic.getChainId(), znn.frontierMomentum()])
  if (evmChain !== EVM_CHAIN_ID || momentum.chainIdentifier !== ZNN_CHAIN_ID) throw new Error('Lab chain identity does not match; refusing fixture writes')
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function height(): Promise<number> {
  return (await znn.frontierMomentum()).height
}

export async function waitMomentums(n: number): Promise<void> {
  const target = (await height()) + n
  while ((await height()) < target) await sleep(2000)
}

/** Polls until `read` returns something truthy, or throws after `timeoutMs`. */
export async function until<T>(what: string, read: () => Promise<T | null | undefined | false>, timeoutMs = 300_000, everyMs = 3000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = await read().catch(() => null)
    if (v) return v
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(everyMs)
  }
}

interface ConfirmedBlock {
  hash: string
  confirmationDetail?: { momentumHeight: number } | null
}

// One account sends everything, so sends are serialised: a second block built
// before the first is confirmed would reuse its height.
let chain: Promise<unknown> = Promise.resolve()
const publicationFile = fileURLToPath(new URL('../.state/publication.json', import.meta.url))
function publicationIdentity(spec: BlockSpec, account: Account) {
  const b = blockTemplate(spec, ZNN_CHAIN_ID)
  return JSON.stringify([account.address, b.blockType, b.toAddress, b.amount, b.tokenStandard, b.data, b.fromBlockHash])
}

/** Signs, publishes and waits for a momentum to confirm the block. */
export function send(spec: BlockSpec, account: Account = zAdmin): Promise<string> {
  const job = async () => {
    await assertLab()
    const identity = publicationIdentity(spec, account)
    let block: BlockJson
    if (fs.existsSync(publicationFile)) {
      const pending = JSON.parse(fs.readFileSync(publicationFile, 'utf8')) as { identity: string; block: BlockJson }
      if (pending.identity !== identity || pending.block.chainIdentifier !== ZNN_CHAIN_ID || pending.block.address !== account.address) throw new Error('Earlier fixture publication is unresolved; retain and reconcile its exact hash')
      block = pending.block
    } else {
      let preparedBlock: BlockJson | undefined
      try {
        block = await publishBlock(znn, account, ZNN_CHAIN_ID, spec, {}, (prepared) => {
          fs.mkdirSync(fileURLToPath(new URL('../.state/', import.meta.url)), { recursive: true })
          fs.writeFileSync(publicationFile, JSON.stringify({ identity, block: prepared }), { flag: 'wx' })
          preparedBlock = prepared
        })
      } catch (error) {
        if (preparedBlock) archiveRejectedPublication(publicationFile, identity, preparedBlock, error)
        throw error
      }
    }
    await until(`block ${block.hash.slice(0, 8)} to confirm`, async () => {
      const b = await znn.callOrNull<ConfirmedBlock>('ledger.getAccountBlockByHash', [block.hash])
      return b?.confirmationDetail?.momentumHeight ? b : null
    })
    fs.unlinkSync(publicationFile)
    return block.hash
  }
  const next = chain.then(job, job)
  chain = next.catch(() => undefined)
  return next
}

/** Drain original fixture jobs before closing a browser or retiring a worker. */
export async function drainPublications(): Promise<void> {
  await chain
  if (fs.existsSync(publicationFile)) throw new Error('Fixture publication remains unresolved; preserve its original hash')
}

/** Receives everything waiting for `account` (a redeem's ZNN arrives as an unreceived block). */
export async function receiveAll(account: Account = zAdmin): Promise<number> {
  const page = await znn.call<{ list: Array<{ hash: string }> | null }>('ledger.getUnreceivedBlocksByAddress', [account.address, 0, 50])
  let n = 0
  for (const b of page.list ?? []) {
    await send({ blockType: 3, toAddress: EMPTY_ADDRESS, fromBlockHash: b.hash }, account)
    n++
  }
  return n
}
