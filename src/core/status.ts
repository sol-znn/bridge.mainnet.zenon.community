// Where a request is, in one word, the same word everywhere in the app.
//
// Wrap (Zenon to EVM): the Zenon request is final, then signed by the
// orchestrators, then redeemed on the EVM bridge in two calls separated by the
// token's redeemDelay blocks (HyperCore bridge.sol `redeem`).
//
// Unwrap (EVM to Zenon): the orchestrators register the EVM log on Zenon with
// a signature, then the recipient redeems after redeemDelay momentums, unless
// the administrator revoked it.

export type Tone = 'ok' | 'wait' | 'warn' | 'danger' | 'dim'

export type WrapState = 'unavailable' | 'confirming' | 'signing' | 'redeem' | 'delay' | 'finish' | 'done' | 'failed'
export type UnwrapState = 'signing' | 'delay' | 'redeem' | 'done' | 'revoked'

export interface Status<S extends string> {
  state: S
  label: string
  tone: Tone
  /** Seconds left in a wait the page can count down. */
  eta?: number
  /** "1/2", "2/2" for the two EVM redeems. */
  step?: string
}

export const UINT256_MAX = (1n << 256n) - 1n

export interface WrapInputs {
  signature: string
  /** Momentums left until Zenon finality, as the node reports it. */
  confirmationsToFinality: number
  momentumSeconds: number
  /** EVM `redeemsInfo(id).blockNumber`, or null when not read yet. */
  redeemBlock: bigint | null
  evmBlock: bigint | null
  /** EVM `tokensInfo(token).redeemDelay`, in blocks. */
  redeemDelay: bigint | null
  evmBlockSeconds: number
  failed?: boolean
}

export function wrapStatus(i: WrapInputs): Status<WrapState> {
  if (i.failed) return { state: 'failed', label: 'Failed', tone: 'danger' }
  if (i.confirmationsToFinality > 0 && !i.signature) {
    return {
      state: 'confirming',
      label: 'Confirming',
      tone: 'wait',
      eta: i.confirmationsToFinality * i.momentumSeconds,
    }
  }
  if (!i.signature) return { state: 'signing', label: 'Signing', tone: 'wait' }
  if (i.redeemBlock === null) return { state: 'unavailable', label: 'Status unavailable', tone: 'dim' }
  if (i.redeemBlock === UINT256_MAX) return { state: 'done', label: 'Done', tone: 'ok' }
  if (i.redeemBlock === 0n) return { state: 'redeem', label: 'Redeem', tone: 'warn', step: '1/2' }
  if (i.evmBlock === null || i.redeemDelay === null) return { state: 'unavailable', label: 'Status unavailable', tone: 'dim' }
  // bridge.sol: `(redeemInfo.blockNumber + redeemDelay) < block.number`, where
  // block.number is the block the second redeem lands in, at best latest + 1.
  // So it can be sent once the latest block is blockNumber + redeemDelay.
  if (i.evmBlock !== null && i.redeemDelay !== null) {
    const readyAt = i.redeemBlock + i.redeemDelay
    if (i.evmBlock < readyAt) {
      return {
        state: 'delay',
        label: 'Waiting',
        tone: 'wait',
        step: '2/2',
        eta: Number(readyAt - i.evmBlock) * i.evmBlockSeconds,
      }
    }
  }
  return { state: 'finish', label: 'Finish', tone: 'warn', step: '2/2' }
}

/** Revert reasons from bridge.sol, mapped to what they mean for the request. */
export function wrapStateFromRevert(message: string): WrapState | null {
  const m = message.toLowerCase()
  if (m.includes('nonce already redeemed')) return 'done'
  if (m.includes('not redeemable yet')) return 'delay'
  if (m.includes('wrong signature') || m.includes('invalid signature') || m.includes('signature length')) return 'failed'
  return null
}

export interface UnwrapInputs {
  signature: string
  redeemed: number | boolean
  revoked: number | boolean
  redeemableIn: number
  momentumSeconds: number
}

export function unwrapStatus(i: UnwrapInputs): Status<UnwrapState> {
  if (i.revoked) return { state: 'revoked', label: 'Revoked', tone: 'danger' }
  if (i.redeemed) return { state: 'done', label: 'Done', tone: 'ok' }
  if (!i.signature) return { state: 'signing', label: 'Signing', tone: 'wait' }
  if (i.redeemableIn > 0) {
    return { state: 'delay', label: 'Waiting', tone: 'wait', eta: i.redeemableIn * i.momentumSeconds }
  }
  return { state: 'redeem', label: 'Redeem', tone: 'warn' }
}

/** An affiliate bonus entry: the orchestrator adds 4e9 to the log index. */
export const AFFILIATE_LOG_INDEX = 4_000_000_000
export const isAffiliateEntry = (logIndex: number) => logIndex >= AFFILIATE_LOG_INDEX

/**
 * The wrap signature as the EVM bridge takes it. Zenon stores the TSS
 * signature base64 with v as 0 or 1; OpenZeppelin's ECDSA wants 27 or 28.
 */
export function evmSignature(base64: string): `0x${string}` {
  const raw = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
  if (raw.length !== 65) throw new Error(`signature is ${raw.length} bytes, expected 65`)
  if (raw[64] < 27) raw[64] += 27
  return `0x${Array.from(raw, (b) => b.toString(16).padStart(2, '0')).join('')}`
}
