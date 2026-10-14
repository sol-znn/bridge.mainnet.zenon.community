import { ed25519 } from '@noble/curves/ed25519'
import type { PublicClient } from 'viem'
import type { ZenonApi } from '../znn/api.ts'
import { computeBlockHash } from '../znn/block.ts'
import { addressFromPublicKey, formatAddress, fromBase64, fromHex, toHex } from '../znn/primitives.ts'
import { updateOperation, validHash, type Operation } from './operations.ts'

/** Exact original hash only. No address-history search, nonce discovery or replacement signing. */
export async function reconcileZenon(a: ZenonApi, operation: Operation, hash = operation.hash, current: () => boolean = () => true): Promise<boolean> {
  if (operation.source !== 'zenon' || operation.state === 'mismatch') throw new Error('Operation requires manual evidence review')
  if (!validHash('zenon', hash)) throw new Error('Provide the exact hash from the original wallet operation')
  const block = await a.c.callOrNull<Parameters<typeof computeBlockHash>[0] & { hash: string; signature: string; publicKey: string; confirmationDetail?: { numConfirmations: number } }>('ledger.getAccountBlockByHash', [hash])
  if (!block || !current()) return false
  const payload = JSON.parse(operation.payload) as Record<string, unknown>
  const publicKey = fromBase64(block.publicKey)
  if (block.hash.toLowerCase() !== hash.toLowerCase() || toHex(computeBlockHash(block)) !== hash.toLowerCase() || block.chainIdentifier !== operation.chainId ||
    block.address !== operation.account || formatAddress(addressFromPublicKey(publicKey)) !== operation.account ||
    !ed25519.verify(fromBase64(block.signature), fromHex(hash), publicKey) ||
    Object.entries(payload).some(([key, value]) => String(block[key as keyof typeof block]) !== String(value))) throw new Error('Transaction does not match the original operation')
  if (!current()) return false
  updateOperation(operation.id, { hash, state: (block.confirmationDetail?.numConfirmations ?? 0) > 0 ? 'confirmed' : 'submitted' })
  return (block.confirmationDetail?.numConfirmations ?? 0) > 0
}

export async function reconcileEvm(reader: PublicClient, operation: Operation, hash = operation.hash, current: () => boolean = () => true, confirmations = 2): Promise<boolean> {
  if (operation.source !== 'evm' || operation.state === 'mismatch') throw new Error('Operation requires manual evidence review')
  if (!validHash('evm', hash)) throw new Error('Provide the exact hash from the original wallet operation')
  const [chainId, transaction, receipt] = await Promise.all([reader.getChainId(), reader.getTransaction({ hash: hash as `0x${string}` }), reader.getTransactionReceipt({ hash: hash as `0x${string}` })])
  if (!current()) return false
  const payload = JSON.parse(operation.payload) as { to: string; data: string; value: string }
  if (chainId !== operation.chainId || transaction.hash.toLowerCase() !== hash.toLowerCase() || transaction.from.toLowerCase() !== operation.account.toLowerCase() ||
    transaction.to?.toLowerCase() !== payload.to || transaction.input.toLowerCase() !== payload.data || transaction.value.toString() !== payload.value || receipt.transactionHash.toLowerCase() !== hash.toLowerCase() ||
    transaction.blockHash?.toLowerCase() !== receipt.blockHash.toLowerCase() || transaction.blockNumber !== receipt.blockNumber ||
    receipt.from.toLowerCase() !== operation.account.toLowerCase() || receipt.to?.toLowerCase() !== payload.to) throw new Error('Transaction does not match the original operation')
  const canonical = await reader.getBlock({ blockNumber: receipt.blockNumber })
  const height = await reader.getBlockNumber()
  if (!current() || canonical.hash?.toLowerCase() !== receipt.blockHash.toLowerCase() || height < receipt.blockNumber + BigInt(Math.max(1, confirmations) - 1)) return false
  if (await reader.getChainId() !== operation.chainId || !current()) throw new Error('Receipt network changed during verification')
  if (receipt.status !== 'success' && receipt.status !== 'reverted') throw new Error('Receipt status is unavailable')
  updateOperation(operation.id, { hash, state: receipt.status === 'success' ? 'confirmed' : 'reverted' })
  return true
}
