import { createRequire } from 'node:module'

// Node-only lab support for both published BIP39 export layouts.
export function loadEnglishWordlist(load = createRequire(import.meta.url)) {
  let exported
  try {
    exported = load('@scure/bip39/wordlists/english.js')
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error
    exported = load('@scure/bip39/wordlists/english')
  }
  const words = exported?.wordlist
  if (!Array.isArray(words) || words.length !== 2048 ||
      !words.every(word => typeof word === 'string' && word.length > 0) ||
      new Set(words).size !== 2048) {
    throw new Error('Invalid English BIP39 wordlist export')
  }
  return words
}
