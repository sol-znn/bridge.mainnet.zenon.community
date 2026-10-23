import { describe, expect, it } from 'vitest'
import { compilerKey } from '../../e2e/lib/compile.ts'

describe('compiler cache provenance', () => {
  it('changes when the compiler, settings, direct source or imported source changes', () => {
    const inputs = { compiler: 'fixture-compiler-1', settings: { optimizer: true }, sources: { direct: 'A' }, imports: { imported: 'B' } }
    const original = compilerKey(inputs)
    for (const changed of [
      { ...inputs, compiler: 'fixture-compiler-2' }, { ...inputs, settings: { optimizer: false } },
      { ...inputs, sources: { direct: 'C' } }, { ...inputs, imports: { imported: 'D' } },
    ]) expect(compilerKey(changed)).not.toBe(original)
    expect(compilerKey({ ...inputs })).toBe(original)
  })
})
