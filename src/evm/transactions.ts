import { encodeFunctionData, type Abi, type PublicClient } from 'viem'
import { journalSubmission, operationForHash, updateOperation } from '../state/operations.ts'

export function transactionPayload(contract: `0x${string}`, abi: Abi, functionName: string, args: readonly unknown[], value = 0n): string {
  return JSON.stringify({ to: contract.toLowerCase(), data: encodeFunctionData({ abi, functionName, args }).toLowerCase(), value: value.toString() })
}

export async function submitTransaction(intent: { chainId: number; account: string; kind: string; payload: string }, guard: () => void, send: () => Promise<`0x${string}`>): Promise<`0x${string}`> {
  const result = await journalSubmission({ ...intent, source: 'evm' }, guard, send)
  return result.hash as `0x${string}`
}

export async function successfulReceipt(reader: PublicClient, chainId: number, hash: `0x${string}`, confirmations = 2) {
  const { reconcileEvm } = await import('../state/reconcile.ts')
  const operation = operationForHash('evm', chainId, hash)
  try {
    if (await reader.getChainId() !== chainId) throw new Error('Receipt reader is on a different network')
    const receipt = await reader.waitForTransactionReceipt({ hash, confirmations: Math.max(1, confirmations) })
    if (receipt.transactionHash.toLowerCase() !== hash.toLowerCase()) throw new Error('Receipt does not belong to the original transaction')
    if (!operation) throw new Error('Original transaction intent is missing')
    if (!await reconcileEvm(reader, operation, hash, () => true, confirmations)) throw new Error('Original receipt is not yet confirmed on the canonical chain')
    if (receipt.status !== 'success' || operation.state !== 'confirmed') {
      throw new Error('Transaction reverted. The original hash has been retained.')
    }
    return receipt
  } catch (err) {
    if (operation && operation.state === 'submitted') updateOperation(operation.id, { state: 'unknown' })
    throw err
  }
}
