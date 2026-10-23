import { isAddress } from 'viem'

/** Accept ordinary accounts and supported smart wallets, with a valid checksum when mixed-case. */
export function isEvmRecipient(value: string): value is `0x${string}` {
  return isAddress(value, { strict: true }) && !/^0x0{40}$/i.test(value)
}
