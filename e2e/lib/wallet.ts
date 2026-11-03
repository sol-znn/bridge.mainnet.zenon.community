// A Zenon account this page can sign for.
//
// The lab's own keys come from the devnet mnemonic the go-zenon branch
// commits. Anyone who loads the page has them, which is the point: they fund
// nothing outside a devnet, and they let every contract call be made without
// a wallet extension in the way. Derivation is zenon-faucet's, checked there
// against the addresses the devnet README lists.

import { ed25519 } from '@noble/curves/ed25519.js'
import { hmac } from '@noble/hashes/hmac.js'
import { sha512 } from '@noble/hashes/sha2.js'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { loadEnglishWordlist } from './bip39-wordlist.mjs'

import { addressFromPublicKey, concat, formatAddress } from '../../src/znn/primitives.ts'

/** Zenon's BIP-44 coin type. The path is `m/44'/73404'/account'`. */
export const COIN_TYPE = 73404

const HARDENED = 0x80000000
const wordlist = loadEnglishWordlist()

/**
 * SLIP-0010 ed25519 derivation.
 *
 * ed25519 has no public-parent derivation, so every level is hardened: an
 * unhardened index is not a different result, it is undefined. This mirrors
 * `ed25519-hd-key`, which is what znn-ts-sdk and Syrius derive with.
 */
function derivePath(pathIndices: number[], seed: Uint8Array): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode('ed25519 seed'), seed)
  let key = I.subarray(0, 32)
  let chainCode = I.subarray(32, 64)

  for (const index of pathIndices) {
    const indexBytes = new Uint8Array(4)
    new DataView(indexBytes.buffer).setUint32(0, (index | 0) + HARDENED, false)
    I = hmac(sha512, chainCode, concat(new Uint8Array([0]), key, indexBytes))
    key = I.subarray(0, 32)
    chainCode = I.subarray(32, 64)
  }
  return key.slice()
}

export class Account {
  readonly privateKey: Uint8Array
  readonly publicKey: Uint8Array
  readonly address: string

  private constructor(privateKey: Uint8Array) {
    this.privateKey = privateKey
    this.publicKey = ed25519.getPublicKey(privateKey)
    this.address = formatAddress(addressFromPublicKey(this.publicKey))
  }

  /**
   * The BIP-39 passphrase is empty. A Zenon "password" is the keystore file's
   * encryption password and never reaches the seed: deriving with it produces
   * a different, entirely valid, entirely wrong wallet.
   */
  static fromMnemonic(mnemonic: string, index = 0): Account {
    const phrase = mnemonic.trim().replace(/\s+/g, ' ')
    if (!validateMnemonic(phrase, wordlist)) throw new Error('the mnemonic is not valid BIP-39')
    const seed = mnemonicToSeedSync(phrase)
    return new Account(derivePath([44, COIN_TYPE, index], seed))
  }

  static fromSeed(raw: Uint8Array): Account {
    if (raw.length !== 32) throw new Error(`a seed is 32 bytes, got ${raw.length}`)
    return new Account(raw.slice())
  }

  /** An account-block hash, or the unlock message of an Ed25519 lock. */
  sign(message: Uint8Array): Uint8Array {
    return ed25519.sign(message, this.privateKey)
  }
}
