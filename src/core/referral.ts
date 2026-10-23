// Affiliate links, in the original deployment's format so that links already
// shared keep working:
//
//   ?referral=<hex(address XOR "UjFpyVLBUHC")>
//
// The XOR is obfuscation, not secrecy. The stored value is the mangled code
// (localStorage "znn-referral-code"), which public/affiliate.html also writes,
// and the first referral a browser sees wins until it is cleared.
//
// On unwrap the decoded z1 address goes after "&" in the recipient string. The
// orchestrator parses that part as an address (HyperCore orchestrator,
// network/evm.go), so it must never be the mangled code: the original app sent
// the code on a first visit, and those referrals earned nothing.

import { isUserAddress } from '../znn/primitives.ts'

const KEY = 'UjFpyVLBUHC'
export const STORAGE_KEY = 'znn-referral-code'
export const SEPARATOR = '&'

export function mangle(input: string, key = KEY): string {
  let out = ''
  for (let i = 0; i < input.length; i++) {
    out += (input.charCodeAt(i) ^ key.charCodeAt(i % key.length)).toString(16).padStart(2, '0')
  }
  return out
}

export function unmangle(hex: string, key = KEY): string {
  if (!/^([0-9a-fA-F]{2})+$/.test(hex)) return ''
  let out = ''
  for (let i = 0; i < hex.length / 2; i++) {
    out += String.fromCharCode(parseInt(hex.slice(i * 2, i * 2 + 2), 16) ^ key.charCodeAt(i % key.length))
  }
  return out
}

/** The referrer's address for a code, or null when the code does not decode to one. */
export function referrerFromCode(code: string | null | undefined): string | null {
  if (!code || code.length > 128) return null
  const a = unmangle(code.trim())
  return isUserAddress(a) ? a : null
}

export function linkFor(address: string, origin: string): string {
  if (!isUserAddress(address)) throw new Error('Use a supported Zenon account address')
  return `${origin}?referral=${mangle(address)}`
}

/** The unwrap recipient string: "z1recipient" or "z1recipient&z1referrer". */
export function recipientString(recipient: string, referrer: string | null): string {
  if (!usableReferrer(recipient, referrer)) return recipient
  return `${recipient}${SEPARATOR}${referrer}`
}

export function usableReferrer(recipient: string, referrer: string | null): string | null {
  return isUserAddress(recipient) && referrer && isUserAddress(referrer) && referrer !== recipient ? referrer : null
}

export interface ReferralStore {
  get(): string | null
  set(code: string): void
  clear(): void
}

export const localReferralStore: ReferralStore = {
  get() {
    try {
      return localStorage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  },
  set(code) {
    try {
      localStorage.setItem(STORAGE_KEY, code)
    } catch {
      /* blocked storage: the referral lasts for this page only */
    }
  },
  clear() {
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch {
      /* nothing stored */
    }
  },
}

/**
 * Applies a code from the URL. First referral wins, as in the original: a new
 * code is ignored while a valid one is stored. Returns the referrer in effect.
 */
export function applyReferral(code: string | null, store: ReferralStore = localReferralStore): string | null {
  const current = referrerFromCode(store.get())
  if (current) return current
  const incoming = referrerFromCode(code)
  if (incoming && code) store.set(code.trim().toLowerCase())
  return incoming
}
