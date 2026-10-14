// Durable publication journal. A missing response is never permission to sign
// a replacement. Only the original promise or an exact, verified transaction
// can resolve a publication whose outcome is unknown.
import { reactive } from 'vue'
import { isAddress, isUserAddress, isZts } from '../znn/primitives.ts'
import { isEvmRecipient } from '../core/recipient.ts'
import { NotSubmittedError } from '../core/errors.ts'
import { publicationFailure } from '../core/publication-error.ts'

const KEY = 'bridge.operations.v1'
export type OperationState = 'awaiting-wallet' | 'unknown' | 'submitted' | 'confirmed' | 'reverted' | 'rejected' | 'mismatch'
export interface OperationIntent {
  source: 'zenon' | 'evm'
  chainId: number
  account: string
  kind: string
  /** Canonical JSON of the chosen transaction fields; excludes keys and signatures. */
  payload: string
}
export interface Operation extends OperationIntent {
  id: string
  state: OperationState
  createdAt: number
  hash?: string
  /** Conflicting failure reports stay private and require independent review. */
  reportedHashes?: string[]
}
const states = ['awaiting-wallet', 'unknown', 'submitted', 'confirmed', 'reverted', 'rejected', 'mismatch']
const terminal = (state: OperationState) => ['confirmed', 'reverted', 'rejected'].includes(state)
export const operations = reactive({ entries: [] as Operation[], error: '' })

function validPayload(intent: OperationIntent): boolean {
  try {
    const p = JSON.parse(intent.payload)
    if (!p || typeof p !== 'object' || Array.isArray(p)) return false
    const amount = (value: unknown) => typeof value === 'string' && /^\d{1,78}$/.test(value) && BigInt(value) < 2n ** 256n
    if (intent.source === 'evm') return isEvmRecipient(intent.account) && isEvmRecipient(p.to) &&
      typeof p.data === 'string' && /^0x([0-9a-f]{2})*$/i.test(p.data) && amount(p.value)
    return isUserAddress(intent.account) && typeof p.toAddress === 'string' && isAddress(p.toAddress) &&
      isZts(p.tokenStandard) && amount(p.amount) && typeof p.data === 'string' &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(p.data) && typeof p.fromBlockHash === 'string' && /^[0-9a-f]{64}$/i.test(p.fromBlockHash) && [2,3].includes(p.blockType)
  } catch { return false }
}

function valid(value: unknown): value is Operation {
  if (!value || typeof value !== 'object') return false
  const r = value as Operation
  return typeof r.id === 'string' && r.id.length <= 128 && ['zenon', 'evm'].includes(r.source) &&
    Number.isSafeInteger(r.chainId) && r.chainId > 0 && typeof r.account === 'string' && r.account.length <= 64 &&
    typeof r.kind === 'string' && r.kind.length <= 64 && typeof r.payload === 'string' && r.payload.length <= 32_768 &&
    Number.isSafeInteger(r.createdAt) && r.createdAt >= 0 && states.includes(r.state) && validPayload(r) && (r.hash === undefined || validHash(r.source, r.hash)) &&
    (r.reportedHashes === undefined || r.state === 'mismatch' && Array.isArray(r.reportedHashes) && r.reportedHashes.length > 0 && r.reportedHashes.length <= 8 && r.reportedHashes.every((hash: unknown) => validHash(r.source, hash)) && (r.hash === undefined || r.reportedHashes.length === 1 && r.reportedHashes[0].toLowerCase() === r.hash.toLowerCase()))
}

export function validHash(source: OperationIntent['source'], hash: unknown): hash is string {
  return typeof hash === 'string' && (source === 'evm' ? /^0x[0-9a-f]{64}$/i : /^[0-9a-f]{64}$/i).test(hash)
}

export function restoreOperations() {
  operations.entries = []
  operations.error = ''
  try {
    const text = localStorage.getItem(KEY)
    if (!text) return
    const raw: unknown = JSON.parse(text)
    if (!Array.isArray(raw) || raw.length > 10_000 || !raw.every(valid)) throw new Error('Operation history is unreadable')
    operations.entries = raw.map((r) => ({ ...r, state: r.state === 'awaiting-wallet' ? 'unknown' : r.state }))
  } catch {
    operations.error = 'Operation history is unavailable. Restore the original transaction evidence before sending again.'
  }
}
restoreOperations()

function mergeStored() {
  const text = localStorage.getItem(KEY)
  const raw: unknown = text ? JSON.parse(text) : []
  if (!Array.isArray(raw) || raw.length > 10_000 || !raw.every(valid)) throw new Error('Stored operation evidence is unreadable')
  for (const stored of raw) {
    const local = operations.entries.find((r) => r.id === stored.id)
    if (!local) operations.entries.push({ ...stored, state: stored.state === 'awaiting-wallet' ? 'unknown' : stored.state })
    else {
      if (local.source !== stored.source || local.chainId !== stored.chainId || local.account !== stored.account || local.payload !== stored.payload || local.hash && stored.hash && local.hash !== stored.hash) throw new Error('Stored operation identity changed')
      if (local.state === 'mismatch' && terminal(stored.state)) throw new Error('Mismatched publication cannot be resolved by another tab')
      if (local.reportedHashes && stored.reportedHashes && JSON.stringify(local.reportedHashes) !== JSON.stringify(stored.reportedHashes)) throw new Error('Stored reported transaction evidence changed')
      if (!local.hash && stored.hash) local.hash = stored.hash
      if (!local.reportedHashes && stored.reportedHashes) local.reportedHashes = [...stored.reportedHashes]
      if (stored.state === 'mismatch' || terminal(stored.state)) Object.assign(local, stored)
    }
  }
}

function persist() {
  try {
    mergeStored()
    // Never evict a nonterminal identity. Only old terminal records are bounded.
    const retained = operations.entries.filter((r) => !terminal(r.state))
      .concat(operations.entries.filter((r) => terminal(r.state)).slice(-200))
    localStorage.setItem(KEY, JSON.stringify(retained))
    if (localStorage.getItem(KEY) !== JSON.stringify(retained)) throw new Error('Storage did not retain the journal')
    operations.error = ''
  } catch {
    operations.error = 'Cannot save operation history. Sending is paused; keep the original transaction hash.'
    throw new Error(operations.error)
  }
}

export function unresolvedOperation(source: OperationIntent['source'], chainId: number, account: string): Operation | undefined {
  return operations.entries.find((r) => r.source === source && r.chainId === chainId && r.account.toLowerCase() === account.toLowerCase() && !terminal(r.state))
}

export function beginOperation(intent: OperationIntent): Operation {
  if (operations.error) throw new Error(operations.error)
  try { mergeStored() } catch { operations.error = 'Stored operation evidence is unavailable. Preserve it before sending again.'; throw new Error(operations.error) }
  if (unresolvedOperation(intent.source, intent.chainId, intent.account)) throw new Error('An earlier operation is unresolved. Reconcile its original hash before sending again.')
  const entry: Operation = { ...intent, id: crypto.randomUUID(), state: 'awaiting-wallet', createdAt: Math.floor(Date.now() / 1000) }
  if (!valid(entry)) throw new Error('Invalid operation intent')
  operations.entries.push(entry)
  try { persist() } catch (err) { operations.entries.pop(); throw err }
  return entry
}

export function updateOperation(id: string, update: Pick<Operation, 'state'> & { hash?: string; reportedHashes?: string[] }) {
  const record = operations.entries.find((r) => r.id === id)
  if (!record) throw new Error('Original operation is missing')
  if (record.state === 'mismatch' && update.state !== 'mismatch') throw new Error('Mismatched wallet evidence requires independent review')
  if (terminal(record.state) && update.state !== record.state) throw new Error('A resolved operation cannot be reopened automatically')
  if (['submitted', 'confirmed', 'reverted'].includes(update.state) && !update.hash && !record.hash) throw new Error('A transaction hash is required to resolve publication')
  if (update.hash && (!validHash(record.source, update.hash) || record.hash && record.hash.toLowerCase() !== update.hash.toLowerCase())) throw new Error('Original operation hash cannot be replaced')
  if (Object.hasOwn(update, 'reportedHashes') && record.reportedHashes && JSON.stringify(record.reportedHashes) !== JSON.stringify(update.reportedHashes)) throw new Error('Reported transaction evidence cannot be replaced')
  if (update.reportedHashes && (update.state !== 'mismatch' || !update.reportedHashes.length || update.reportedHashes.length > 8 || !update.reportedHashes.every((hash) => validHash(record.source, hash)))) throw new Error('Invalid reported transaction evidence')
  const reports = update.reportedHashes ?? record.reportedHashes
  if (update.hash && reports && (reports.length !== 1 || reports[0].toLowerCase() !== update.hash.toLowerCase())) throw new Error('Conflicting reported hashes require independent review')
  Object.assign(record, update, update.hash ? { hash: update.hash.toLowerCase() } : {})
  try { persist() } catch { /* retain exact result in memory and stop subsequent writes */ }
}

async function ownedSubmission(intent: OperationIntent, beforeSend: () => void, send: () => Promise<string>): Promise<{ hash: string; operationId: string }> {
  beforeSend()
  const operation = beginOperation(intent)
  let invoked = false
  try {
    beforeSend()
    invoked = true
    const hash = await send()
    if (!validHash(intent.source, hash)) throw new Error('Wallet response did not contain a valid transaction hash')
    updateOperation(operation.id, { state: 'submitted', hash })
    return { hash: hash.toLowerCase(), operationId: operation.id }
  } catch (error) {
    const failure = publicationFailure(error)
    const reports = [...new Set(failure.reportedHashes.filter((hash) => validHash(intent.source, hash)).map((hash) => hash.toLowerCase()))]
    const rejected = !invoked || error instanceof NotSubmittedError || [4001, 4100, 4200].includes(failure.code ?? 0)
    updateOperation(operation.id, {
      state: failure.hasReportedHash ? 'mismatch' : rejected ? 'rejected' : 'unknown',
      ...(reports.length === 1 ? { hash: reports[0] } : {}),
      ...(reports.length ? { reportedHashes: reports } : {}),
    })
    throw error
  }
}

export async function journalSubmission(intent: OperationIntent, beforeSend: () => void, send: () => Promise<string>): Promise<{ hash: string; operationId: string }> {
  // Secure-context Web Locks serialize wallet invocation across tabs. Durable
  // records still block replacements after a tab closes and releases its lock.
  if (typeof window === 'undefined') return ownedSubmission(intent, beforeSend, send)
  if (!navigator.locks) throw new NotSubmittedError('This browser cannot establish exclusive publication ownership')
  return navigator.locks.request('bridge.publication-journal', { ifAvailable: true }, async (lock) => {
    if (!lock) throw new NotSubmittedError('Another tab is publishing an operation. Keep its original result before sending again.')
    return ownedSubmission(intent, beforeSend, send)
  })
}

if (typeof window !== 'undefined') window.addEventListener?.('storage', (event) => {
  if (event.key !== KEY) return
  try { mergeStored() } catch { operations.error = 'Operation evidence changed in another tab. Preserve the original journal before sending again.' }
})

export function operationForHash(source: OperationIntent['source'], chainId: number, hash: string) {
  return operations.entries.find((r) => r.source === source && r.chainId === chainId && r.hash?.toLowerCase() === hash.toLowerCase())
}
