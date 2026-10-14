import { describe, expect, it } from 'vitest'
import { agreesAtHeight } from '../../e2e/lab/readiness.mjs'
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
