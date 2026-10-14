import { afterEach, expect, it, vi } from 'vitest'
import { acknowledgedMomentum, publishBlock } from '../../e2e/lib/publish.ts'
import type { ZenonClient } from '../../src/znn/client.ts'
import type { Account } from '../../e2e/lib/wallet.ts'
import { EMPTY_ADDRESS } from '../../src/znn/primitives.ts'
const momentum = (height: number, chainIdentifier = 322) => ({hash:'ab'.repeat(32),height,chainIdentifier,timestamp:100})
afterEach(() => vi.useRealTimers())

it('waits for the incoming source confirmation before choosing a deep acknowledgement', async () => {
  vi.useFakeTimers()
  const call = vi.fn(async (_method, [height]) => ({list:[momentum(height)]}))
  const client = {frontierMomentum:vi.fn().mockResolvedValueOnce(momentum(64)).mockResolvedValue(momentum(67)),call} as unknown as ZenonClient
  const pending = acknowledgedMomentum(client,322,64)
  await vi.advanceTimersByTimeAsync(1000)
  expect(await pending).toEqual(momentum(64))
  expect(call).toHaveBeenCalledExactlyOnceWith('ledger.getMomentumsByHeight',[64,1])
})

it('refuses a different chain or a substituted acknowledged height before signing', async () => {
  const client = {frontierMomentum:async()=>momentum(70,1)} as unknown as ZenonClient
  await expect(acknowledgedMomentum(client,322,64)).rejects.toThrow('chain identity')
  const wrong = {frontierMomentum:async()=>momentum(70),call:async()=>({list:[momentum(68)]})} as unknown as ZenonClient
  await expect(acknowledgedMomentum(wrong,322,64)).rejects.toThrow('identity changed')
})

it('never prepares or signs a receive whose source belongs to another account', async () => {
  const sign = vi.fn(), prepared = vi.fn(), sourceHash='cd'.repeat(32)
  const client = {callOrNull:async()=>null,call:async()=>({hash:sourceHash,toAddress:'other',chainIdentifier:322,confirmationDetail:{momentumHeight:64,numConfirmations:1}})} as unknown as ZenonClient
  await expect(publishBlock(client,{address:'recipient',sign} as unknown as Account,322,{blockType:3,toAddress:EMPTY_ADDRESS,fromBlockHash:sourceHash}, {},prepared)).rejects.toThrow('source identity')
  expect(sign).not.toHaveBeenCalled();expect(prepared).not.toHaveBeenCalled()
})
