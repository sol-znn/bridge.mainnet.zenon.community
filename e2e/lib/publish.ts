// Signs and publishes a block with a key the test holds: the e2e harness's
// stand-in for Syrius and for the orchestrator's Zenon side. From
// zenon-ptlc/lab/web/src/znn/block.ts.

import type { Account } from './wallet.ts'
import { minePoWNonce, powDataHash, type MiningOptions } from './pow.ts'
import { ZERO_NONCE, blockTemplate, computeBlockHash, type BlockJson, type BlockSpec } from '../../src/znn/block.ts'
import { ZERO_HASH_HEX, toBase64, toHex } from '../../src/znn/primitives.ts'
import type { ZenonClient } from '../../src/znn/client.ts'
import { momentum as validateMomentum, record, integer, hash } from '../../src/znn/validation.ts'

/** The receive must acknowledge its source's confirmation, with reorg depth. */
export async function acknowledgedMomentum(client: ZenonClient, chainIdentifier: number, minimumHeight: number) {
  const deadline = Date.now() + 120_000
  for (;;) {
    const frontier = await client.frontierMomentum()
    if (frontier.chainIdentifier !== chainIdentifier) throw new Error('Publication chain identity changed')
    const height = Math.max(1, frontier.height - 3)
    if (height >= minimumHeight) {
      const page = record(await client.call('ledger.getMomentumsByHeight', [height, 1]))
      if (!Array.isArray(page.list) || page.list.length !== 1) throw new Error('Acknowledged momentum is unavailable')
      const acknowledged = validateMomentum(page.list[0])
      if (acknowledged.chainIdentifier !== chainIdentifier || acknowledged.height !== height) throw new Error('Acknowledged momentum identity changed')
      return acknowledged
    }
    if (Date.now() >= deadline) throw new Error('Timed out waiting for source confirmation depth before signing')
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}


/**
 * Completes, signs and publishes one block from `account`, and answers its
 * hash. A published `ptlc.Create` hash is also the entry's id, so the id is
 * known the moment the block is built, two momentums before the entry exists.
 */
export async function publishBlock(
  client: ZenonClient,
  account: Account,
  chainIdentifier: number,
  spec: BlockSpec,
  options: MiningOptions = {},
  prepared?: (block: BlockJson) => void,
): Promise<BlockJson> {
  const raw = await client.callOrNull('ledger.getFrontierAccountBlock', [account.address])
  const frontier = raw === null ? null : record(raw)
  let minimumHeight = frontier ? integer(record(frontier.momentumAcknowledged).height) : 1
  if (spec.blockType === 3) {
    const source = record(await client.call('ledger.getAccountBlockByHash', [spec.fromBlockHash]))
    if (hash(source.hash) !== spec.fromBlockHash || source.toAddress !== account.address || integer(source.chainIdentifier) !== chainIdentifier) throw new Error('Receive source identity changed')
    const confirmation = record(source.confirmationDetail)
    if (!integer(confirmation.numConfirmations)) throw new Error('Receive source is not confirmed')
    minimumHeight = Math.max(minimumHeight, integer(confirmation.momentumHeight))
  }
  // A lab head can be replaced while its five nodes converge. Acknowledge a
  // recent confirmed momentum, without ever rebuilding an unknown send.
  const acknowledged = await acknowledgedMomentum(client, chainIdentifier, minimumHeight)

  const block = blockTemplate(spec, chainIdentifier)
  block.previousHash = frontier ? hash(frontier.hash) : ZERO_HASH_HEX
  block.height = frontier ? integer(frontier.height) + 1 : 1
  block.momentumAcknowledged = { hash: acknowledged.hash, height: acknowledged.height }
  block.address = account.address
  block.nonce = ZERO_NONCE

  const pow = await client.requiredPow(account.address, block.blockType, block.toAddress, block.data)

  if (pow.requiredDifficulty > 0) {
    block.fusedPlasma = pow.availablePlasma
    block.difficulty = pow.requiredDifficulty
    block.nonce = toHex(
      await minePoWNonce(pow.requiredDifficulty, powDataHash(block.address, block.previousHash), options),
    )
  } else {
    block.fusedPlasma = pow.basePlasma
  }
  block.basePlasma = pow.basePlasma
  block.usedPlasma = pow.basePlasma

  const digest = computeBlockHash(block)
  block.hash = toHex(digest)
  block.publicKey = toBase64(account.publicKey)
  block.signature = toBase64(account.sign(digest))

  prepared?.(block)
  await client.publish(block)
  return block
}
