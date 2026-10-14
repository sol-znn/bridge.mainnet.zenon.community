import { TransactionExecutionError, UserRejectedRequestError } from 'viem'

/** Evidence from the same failed publication promise, never from display text. */
export function publicationFailure(error: unknown): { code?: number; hasReportedHash: boolean; reportedHashes: string[] } {
  const reportedHashes: string[] = []
  const seen = new Set<object>()
  let current = error
  let complete = false
  let hasReportedHash = false
  let code: number | undefined
  try {
    for (let depth = 0; depth < 8; depth++) {
      if (!current || typeof current !== 'object') { complete = true; break }
      if (seen.has(current)) break
      seen.add(current)
      const layer = current as { reportedHash?: unknown; cause?: unknown }
      const reported = layer.reportedHash
      if (reported !== undefined) {
        hasReportedHash = true
        if (typeof reported === 'string') reportedHashes.push(reported)
      }
      current = layer.cause
      if (!current || typeof current !== 'object') { complete = true; break }
    }
    // viem wraps an explicit EIP-1193 rejection in a transaction error. Other
    // nested codes, message matches and incomplete cause chains stay unknown.
    const rootCode = (error as { code?: unknown } | null)?.code
    if (typeof rootCode === 'number') code = rootCode
    if (complete && rootCode === undefined && error instanceof TransactionExecutionError && error.cause instanceof UserRejectedRequestError) code = 4001
  } catch { complete = false }
  return { code: complete ? code : undefined, hasReportedHash, reportedHashes }
}
