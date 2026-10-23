import { describe, expect, it } from 'vitest'
import { userMessage } from '../../src/core/errors.ts'

// viem's text for a wallet rejection, as a toast used to show it.
const viemRejected = Object.assign(
  new Error(
    'User rejected the request.\n\nRequest Arguments:\n  from:  0xf39F…2266\n  to:    0x1231…4EaE\n  value: 0.05 ETH\n\nDetails: MetaMask Tx Signature: User denied transaction signature.\nVersion: viem@2.21.0',
  ),
  { name: 'TransactionExecutionError', shortMessage: 'User rejected the request.', cause: Object.assign(new Error('User denied transaction signature.'), { name: 'UserRejectedRequestError', code: 4001 }) },
)

describe('user messages', () => {
  it('calls every kind of refusal the same quiet thing', () => {
    const declined = { text: 'Declined in wallet', declined: true }
    expect(userMessage(viemRejected)).toEqual(declined)
    expect(userMessage({ code: 4001, message: 'whatever' })).toEqual(declined)
    expect(userMessage(Object.assign(new Error('declined in Syrius'), { declined: true }))).toEqual(declined)
    expect(userMessage(new Error('MetaMask Tx Signature: User denied transaction signature.'))).toEqual(declined)
  })
  it('names what the user can do about a wallet state', () => {
    expect(userMessage({ code: -32005, message: 'Syrius would not open a window: it holds a site off for 30 s…' }).text).toBe('Syrius is busy. Try again in 30 seconds.')
    expect(userMessage({ code: -32002, message: 'Request of type wallet_switchEthereumChain already pending' }).text).toBe('Open your wallet to continue')
    expect(userMessage({ code: 4902, message: 'Unrecognized chain ID "0x38"' }).text).toBe('Add this network in your wallet')
    expect(userMessage({ cause: { code: 4100 } }).text).toBe('Reconnect your wallet')
    expect(userMessage({ code: 4900 }).text).toBe('Wallet is disconnected')
  })
  it('shortens the common chain failures', () => {
    expect(userMessage(new Error('The total cost (gas * gas fee + value) of executing this transaction exceeds the balance of the account.')).text).toBe('Not enough funds for gas')
    expect(userMessage({ details: 'insufficient funds for gas * price + value' }).text).toBe('Not enough funds for gas')
    expect(userMessage(new Error('replacement transaction underpriced')).text).toBe('A transaction is already pending')
    expect(userMessage(new TypeError('Failed to fetch')).text).toBe('Network error. Check the original operation before retrying.')
    expect(userMessage(new Error('The request took too long to respond.')).text).toBe('Timed out. Check the original operation before retrying.')
  })
  it('shows a contract its own reason, and no more', () => {
    expect(userMessage({ message: 'The contract function "redeem" reverted with the following reason:\nredeem: not redeemable yet\n\nContract Call:\n  address: 0xa987…', cause: { reason: 'redeem: not redeemable yet' } }).text).toBe('Redeem: not redeemable yet')
    expect(userMessage(new Error('The contract function "unwrap" reverted with the following reason:\ntoken not bridgeable\n\nVersion: viem@2')).text).toBe('Token not bridgeable')
    expect(userMessage(new Error('execution reverted')).text).toBe('Transaction would fail')
  })
  it('keeps one short line of anything else', () => {
    expect(userMessage(new Error('No route')).text).toBe('No route')
    expect(userMessage(new Error('first line\nsecond line')).text).toBe('First line')
    expect(userMessage(new Error('x'.repeat(200))).text).toHaveLength(80)
    expect(userMessage(undefined).text).toBe('Something went wrong')
    expect(userMessage('plain text').text).toBe('Plain text')
  })
})
