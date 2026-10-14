import { isAddress, parseZts } from './primitives.ts'

export type Raw = Record<string, unknown>
export function record(value: unknown): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed RPC object')
  return value as Raw
}
export function list(value: unknown, nullable = false): unknown[] {
  if (nullable && value === null) return []
  if (!Array.isArray(value) || value.length > 10_000) throw new Error('Malformed RPC list')
  return value
}
export function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error('Malformed RPC integer')
  return value
}
export function amount(value: unknown): bigint {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) throw new Error('Unsafe RPC amount')
  if (typeof value !== 'number' && typeof value !== 'string' || !/^\d{1,78}$/.test(String(value))) throw new Error('Malformed RPC amount')
  const result = BigInt(String(value))
  if (result >= (1n << 256n)) throw new Error('RPC amount exceeds uint256')
  return result
}
export function text(value: unknown, maximum = 32_768): string {
  if (typeof value !== 'string' || value.length > maximum) throw new Error('Malformed RPC text')
  return value
}
export function flag(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Malformed RPC flag')
  return value
}
export function zenonAddress(value: unknown): string {
  const result = text(value, 64)
  if (!isAddress(result)) throw new Error('Malformed Zenon address')
  return result
}
export function evmAddress(value: unknown): string {
  const result = text(value, 42)
  if (!/^0x[0-9a-f]{40}$/i.test(result)) throw new Error('Malformed EVM address')
  return result
}
export function tokenStandard(value: unknown): string {
  const result = text(value, 64)
  parseZts(result)
  return result
}
export function hash(value: unknown): string {
  const result = text(value, 64)
  if (!/^[0-9a-f]{64}$/i.test(result)) throw new Error('Malformed RPC hash')
  return result.toLowerCase()
}
export function momentum(value: unknown) {
  const r = record(value)
  const height = integer(r.height), chainIdentifier = integer(r.chainIdentifier, 0xffffffff), timestamp = integer(r.timestamp)
  if (!height || !chainIdentifier || !timestamp) throw new Error('Momentum identity is unavailable')
  return { hash: hash(r.hash), height, chainIdentifier, timestamp,
    ...(r.producer === undefined ? {} : { producer: zenonAddress(r.producer) }) }
}
