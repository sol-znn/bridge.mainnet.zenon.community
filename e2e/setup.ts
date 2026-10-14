// Brings the bridge up on the lab, both ends, the way an administrator would:
//
//   anvil:  deploy Bridge and a wrapped test token, give the bridge mint
//           rights, register the token (setTokenInfo) and the TSS key
//           (setTss). Both setters are time challenged: call, wait softDelay
//           blocks, call again.
//   Zenon:  SetOrchestratorInfo, ChangeTssECDSAPubKey, SetNetwork,
//           SetTokenPair, from the administrator (devnet index 1). The key
//           and the pair are time challenged in momentums.
//
// Every step first reads the chain and is skipped when already done, so it
// can be run again after `lab.sh down` and `up`: anvil starts empty and gets
// the same addresses (same deployer, same nonces), and the Zenon chain keeps
// what it had.
//
//   npx vitest run --config e2e/vitest.config.ts   (runs this first)
//   node --experimental-strip-types e2e/setup.ts   (on its own)

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getContractAddress } from 'viem'
import { compileContracts } from './lib/compile.ts'
import {
  EVM_CHAIN_ID,
  LAB_ADMIN_ADDRESS,
  NETWORK_CLASS,
  TSS_EVM_ADDRESS,
  TSS_PUBKEY_COMPRESSED,
  anvil,
  evmAdmin,
  evmAdminWallet,
  evmPublic,
  mine,
  send,
  until,
  waitMomentums,
  zAdmin,
  zapi,
  height,
  assertLab,
} from './lib/lab.ts'
import { encodeCall } from '../src/znn/abi.ts'
import { BRIDGE } from '../src/config.ts'
import { ZNN_ZTS } from '../src/znn/primitives.ts'

const here = path.dirname(fileURLToPath(import.meta.url))
const stateFile = path.join(here, '.state', 'deploy.json')

export interface Deployment {
  bridge: `0x${string}`
  token: `0x${string}`
  tss: `0x${string}`
  zenonAdmin: string
  feePercentage: number
  minAmount: string
  evmRedeemDelay: number
  zenonRedeemDelay: number
  confirmationsToFinality: number
}

export const PARAMS = {
  feePercentage: 300,
  minAmount: 1000n,
  evmRedeemDelay: 3, // bridge.sol requires more than 2
  zenonRedeemDelay: 2,
  confirmationsToFinality: 2,
  // EVM constructor: unhaltDuration, administratorDelay, softDelay, blockTime, confirmations
  evm: { unhaltDuration: 1n, administratorDelay: 2n, softDelay: 1n, blockTime: 1n, confirmations: 2n },
}

const log = (m: string) => console.log(`[setup] ${m}`)

async function setupEvm(): Promise<{ bridge: `0x${string}`; token: `0x${string}` }> {
  const { Bridge, TestToken } = compileContracts()
  // Deterministic: the deployer's first two contracts.
  const bridge = getContractAddress({ from: evmAdmin.address, nonce: 0n })
  const token = getContractAddress({ from: evmAdmin.address, nonce: 1n })

  const code = await evmPublic.getCode({ address: bridge })
  if (!code || code === '0x') {
    const nonce = await evmPublic.getTransactionCount({ address: evmAdmin.address })
    if (nonce !== 0) throw new Error(`anvil is not fresh (deployer nonce ${nonce}) but has no bridge: restart it (lab.sh down, up)`)
    const guardians = Array.from({ length: 5 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}` as `0x${string}`)
    const h1 = await evmAdminWallet.deployContract({
      abi: Bridge.abi,
      bytecode: Bridge.bytecode,
      args: [PARAMS.evm.unhaltDuration, PARAMS.evm.administratorDelay, PARAMS.evm.softDelay, PARAMS.evm.blockTime, PARAMS.evm.confirmations, guardians],
      chain: anvil,
      account: evmAdmin,
    })
    await evmPublic.waitForTransactionReceipt({ hash: h1 })
    const h2 = await evmAdminWallet.deployContract({ abi: TestToken.abi, bytecode: TestToken.bytecode, args: ['Wrapped ZNN', 'wZNN'], chain: anvil, account: evmAdmin })
    await evmPublic.waitForTransactionReceipt({ hash: h2 })
    const h3 = await evmAdminWallet.writeContract({ address: token, abi: TestToken.abi, functionName: 'setMinter', args: [bridge], chain: anvil, account: evmAdmin })
    await evmPublic.waitForTransactionReceipt({ hash: h3 })
    log(`deployed Bridge ${bridge} and wZNN ${token}`)
  }

  const write = async (functionName: string, args: unknown[]) => {
    const hash = await evmAdminWallet.writeContract({ address: bridge, abi: Bridge.abi, functionName, args, chain: anvil, account: evmAdmin })
    await evmPublic.waitForTransactionReceipt({ hash })
  }
  // A time-challenged setter: the first call starts the challenge, the second,
  // more than softDelay blocks later, applies it.
  const challenged = async (functionName: string, args: unknown[]) => {
    await write(functionName, args)
    await mine(Number(PARAMS.evm.softDelay) + 2)
    await write(functionName, args)
  }

  const info = (await evmPublic.readContract({ address: bridge, abi: Bridge.abi, functionName: 'tokensInfo', args: [token] })) as readonly [bigint, bigint, boolean, boolean, boolean]
  if (!info[2]) {
    await challenged('setTokenInfo', [token, PARAMS.minAmount, BigInt(PARAMS.evmRedeemDelay), true, true, true])
    log('EVM token registered')
  }
  const tss = (await evmPublic.readContract({ address: bridge, abi: Bridge.abi, functionName: 'tss' })) as string
  if (tss.toLowerCase() !== TSS_EVM_ADDRESS) {
    await challenged('setTss', [TSS_EVM_ADDRESS, '0x', '0x'])
    log(`EVM tss set to ${TSS_EVM_ADDRESS}`)
  }
  // isHalted() holds for unhaltDuration blocks after deployment.
  await mine(3)
  if (await evmPublic.readContract({ address: bridge, abi: Bridge.abi, functionName: 'isHalted' })) throw new Error('EVM bridge is halted')
  return { bridge, token }
}

async function setupZenon(bridge: `0x${string}`, token: `0x${string}`): Promise<void> {
  const call = (name: string, types: Parameters<typeof encodeCall>[1], values: Parameters<typeof encodeCall>[2]) =>
    send({ toAddress: BRIDGE, data: encodeCall(name, types, values) })

  const info = await zapi.bridgeInfo()
  if (info.administrator !== zAdmin.address) {
    throw new Error(`bridge administrator is ${info.administrator}, not the lab key ${zAdmin.address}: the znnd image lacks devnet_bridge.go or its env`)
  }
  const sec = await zapi.securityInfo()
  log(`Zenon bridge: admin ok, softDelay ${sec.softDelay}, height ${await height()}`)

  const orch = await zapi.orchestratorInfo()
  if (!orch.windowSize) {
    await call('SetOrchestratorInfo', ['uint64', 'uint32', 'uint32', 'uint32'], [10, 1, PARAMS.confirmationsToFinality, 10])
    await until('orchestrator info', async () => (await zapi.orchestratorInfo()).windowSize)
    log('orchestrator info set')
  }

  // A time-challenged call on Zenon: send, wait softDelay momentums, send again.
  const challenged = async (what: string, sendOnce: () => Promise<string>, done: () => Promise<boolean>) => {
    if (await done()) return
    await sendOnce()
    await waitMomentums(sec.softDelay + 2)
    await sendOnce()
    await until(what, done)
    log(what)
  }

  await challenged(
    'TSS key set',
    () => call('ChangeTssECDSAPubKey', ['string', 'string', 'string'], [TSS_PUBKEY_COMPRESSED, '', '']),
    async () => (await zapi.bridgeInfo()).compressedTssECDSAPubKey === TSS_PUBKEY_COMPRESSED,
  )

  const hasNetwork = async () => (await zapi.networks()).some((n) => n.chainId === EVM_CHAIN_ID && n.contractAddress.toLowerCase() === bridge.toLowerCase())
  if (!(await hasNetwork())) {
    await call('SetNetwork', ['uint32', 'uint32', 'string', 'string', 'string'], [NETWORK_CLASS, EVM_CHAIN_ID, 'Anvil', bridge.toLowerCase(), '{}'])
    await until('network', hasNetwork)
    log('network set')
  }

  await challenged(
    'token pair set',
    () =>
      call(
        'SetTokenPair',
        ['uint32', 'uint32', 'tokenStandard', 'string', 'bool', 'bool', 'bool', 'uint256', 'uint32', 'uint32', 'string'],
        [NETWORK_CLASS, EVM_CHAIN_ID, ZNN_ZTS, token.toLowerCase(), true, true, false, PARAMS.minAmount, PARAMS.feePercentage, PARAMS.zenonRedeemDelay, '{}'],
      ),
    async () => (await zapi.networks()).some((n) => n.chainId === EVM_CHAIN_ID && n.tokenPairs.some((p) => p.tokenAddress === token.toLowerCase())),
  )

  // CheckBridgeHalted: unhaltedAt + unhaltDuration must be below the frontier.
  const b = await zapi.bridgeInfo()
  if (b.halted) throw new Error('Zenon bridge is halted')
}

export async function setup(): Promise<Deployment> {
  await assertLab()
  if (zAdmin.address !== LAB_ADMIN_ADDRESS) throw new Error(`devnet index 1 derives to ${zAdmin.address}, expected ${LAB_ADMIN_ADDRESS}`)
  const { bridge, token } = await setupEvm()
  await setupZenon(bridge, token)
  const d: Deployment = {
    bridge,
    token,
    tss: TSS_EVM_ADDRESS,
    zenonAdmin: zAdmin.address,
    feePercentage: PARAMS.feePercentage,
    minAmount: PARAMS.minAmount.toString(),
    evmRedeemDelay: PARAMS.evmRedeemDelay,
    zenonRedeemDelay: PARAMS.zenonRedeemDelay,
    confirmationsToFinality: PARAMS.confirmationsToFinality,
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify(d, null, 2))
  log('ready')
  return d
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup().then(
    (d) => {
      console.log(JSON.stringify(d, null, 2))
      process.exit(0)
    },
    (err) => {
      console.error(err)
      process.exit(1)
    },
  )
}
