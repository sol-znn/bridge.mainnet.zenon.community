import { describe, expect, it, vi } from 'vitest'
import { loadEnglishWordlist } from '../../e2e/lib/bip39-wordlist.mjs'

describe('Node lab BIP39 export compatibility', () => {
  it('loads the installed English list', () => {
    const words = loadEnglishWordlist()
    expect(words).toHaveLength(2048)
    expect(words[0]).toBe('abandon')
    expect(words.at(-1)).toBe('zoo')
  })

  it('uses the current export directly', () => {
    const words = loadEnglishWordlist(), load = vi.fn(() => ({ wordlist: words }))
    expect(loadEnglishWordlist(load)).toBe(words)
    expect(load.mock.calls).toEqual([['@scure/bip39/wordlists/english.js']])
  })

  it('supports the legacy layout only when the new subpath is not exported', () => {
    const words = loadEnglishWordlist()
    const load = vi.fn().mockImplementationOnce(() => {
      throw Object.assign(new Error('Subpath unavailable'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' })
    }).mockReturnValueOnce({ wordlist: words })
    expect(loadEnglishWordlist(load)).toBe(words)
    expect(load.mock.calls).toEqual([['@scure/bip39/wordlists/english.js'], ['@scure/bip39/wordlists/english']])
  })

  it('preserves missing packages and inner module failures', () => {
    for (const code of ['MODULE_NOT_FOUND', 'ERR_REQUIRE_ESM', undefined]) {
      const error = Object.assign(new Error('Fixture module failure'), { code })
      const load = vi.fn(() => { throw error })
      expect(() => loadEnglishWordlist(load)).toThrow(error)
      expect(load).toHaveBeenCalledTimes(1)
    }
  })

  it('rejects missing, incomplete, duplicated and malformed lists', () => {
    for (const wordlist of [undefined, [], Array(2048).fill('duplicate'), loadEnglishWordlist().slice(1), [...loadEnglishWordlist().slice(1), 7]]) {
      expect(() => loadEnglishWordlist(() => ({ wordlist }))).toThrow('Invalid English BIP39 wordlist export')
    }
  })
})
