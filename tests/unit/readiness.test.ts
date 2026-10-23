import { describe, expect, it } from 'vitest'
import { agreesAtHeight, readyAtFrontier } from '../../e2e/lab/readiness.mjs'
const hash = 'ab'.repeat(32)
const sample = () => ({ chainIdentifier: 322, height: 25, hash })
describe('five-node exact-height readiness', () => {
  it('requires all five responses at the requested recent height', () => {
    expect(agreesAtHeight(Array.from({ length: 5 }, sample), 25)).toBe(true)
    expect(agreesAtHeight(Array.from({ length: 4 }, sample), 25)).toBe(false)
  })
  it('rejects identical genesis replies when the RPC ignores the requested height', () => {
    expect(agreesAtHeight(Array.from({ length: 5 }, () => ({ ...sample(), height: 1 })), 25)).toBe(false)
  })
  it('rejects a missing, malformed, wrong-chain or divergent node', () => {
    for (const wrong of [null, {}, { ...sample(), chainIdentifier: 1 }, { ...sample(), hash: 'cd'.repeat(32) }, { ...sample(), hash: '' }]) {
      expect(agreesAtHeight([sample(), sample(), sample(), sample(), wrong], 25)).toBe(false)
    }
  })
})

describe('cold Docker and native readiness share the same write barrier', () => {
  const anchor = { chainIdentifier:322,height:28 }
  const node = () => ({chainId:322,height:28,momentum:sample(),error:null})
  it('refuses a moving chain at height two before the minimum height', () => {
    expect(readyAtFrontier({chainIdentifier:322,height:2},Array.from({length:5},()=>({...node(),height:2,momentum:{...sample(),height:1}})))).toBe(false)
    expect(readyAtFrontier(anchor,Array.from({length:5},node))).toBe(true)
  })
  it('requires fresh heads on the correct chain as well as exact recent hashes', () => {
    for (const wrong of [null,{...node(),chainId:1},{...node(),height:2},{...node(),height:20},{...node(),height:null},{...node(),error:'READ_UNAVAILABLE'},{...node(),momentum:{...sample(),height:1}}]) {
      expect(readyAtFrontier(anchor,[node(),node(),node(),node(),wrong])).toBe(false)
    }
    expect(readyAtFrontier({...anchor,chainIdentifier:1},Array.from({length:5},node))).toBe(false)
  })
})
