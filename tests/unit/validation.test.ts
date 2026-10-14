import { describe, expect, it } from 'vitest'
import * as v from '../../src/znn/validation.ts'
import { ZenonApi, parseMetadata } from '../../src/znn/api.ts'
import { formatAddress } from '../../src/znn/primitives.ts'

const account = formatAddress(Uint8Array.from([0, ...Array(19).fill(7)]))
const zts = 'zts1znnxxxxxxxxxxxxx9z4ulx'
describe('RPC payload boundaries', () => {
  it('keeps valid typed values exact', () => {
    expect(v.record({ x: 1 })).toEqual({ x: 1 }); expect(v.list(null, true)).toEqual([])
    expect(v.amount('123456789012345678901')).toBe(123456789012345678901n)
    expect(v.amount(3)).toBe(3n); expect(v.integer(3)).toBe(3); expect(v.flag(false)).toBe(false)
    expect(v.zenonAddress(account)).toBe(account); expect(v.evmAddress('0x' + '12'.repeat(20))).toHaveLength(42)
    expect(v.tokenStandard(zts)).toBe(zts); expect(v.hash('AB'.repeat(32))).toBe('ab'.repeat(32))
    expect(v.momentum({ hash: 'ab'.repeat(32), height: 1, timestamp: 1, chainIdentifier: 322, producer: account })).toMatchObject({ height: 1, chainIdentifier: 322 })
  })
  it('rejects unsafe numbers, shape confusion, oversized text and unsupported identities', () => {
    for (const read of [() => v.record([]), () => v.record(null), () => v.list({}), () => v.list(Array(10_001)),
      () => v.integer(-1), () => v.integer('1'), () => v.amount(2 ** 54), () => v.amount('-1'), () => v.amount((2n ** 256n).toString()),
      () => v.text('a'.repeat(65), 64), () => v.flag('false'), () => v.hash('x'), () => v.tokenStandard('ztsbad'),
      () => v.zenonAddress('z1bad'), () => v.evmAddress('0x0'), () => v.momentum({ hash: 'ab'.repeat(32), height: 0, timestamp: 1, chainIdentifier: 322 })]) expect(read).toThrow()
  })
  it('does not accept an invalid history container as an empty page', async () => {
    const a = new ZenonApi({ call: async () => ({ count: 1, list: {} }) } as any)
    await expect(a.allWraps()).rejects.toThrow('list')
  })
  it('does not promise a bonus from malformed metadata', () => {
    expect(parseMetadata('{"affiliateProgram":{"networks":{"1":{"startingHeight":"100","wZNN":true}}}}')).toEqual({})
    expect(parseMetadata('[]')).toEqual({})
  })
})
