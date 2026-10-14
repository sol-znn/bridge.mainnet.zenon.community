import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatAddress } from '../../src/znn/primitives.ts'
const m = vi.hoisted(() => ({ send: vi.fn(), unsigned: vi.fn(), unwrap: vi.fn(), logs: vi.fn(), block: vi.fn() }))
vi.mock('../../e2e/lib/lab.ts', () => ({ EVM_CHAIN_ID:31337, NETWORK_CLASS:2, TSS_KEY:new Uint8Array(32).fill(1), sleep:vi.fn(), send:m.send,
  zapi:{ unsignedWraps:m.unsigned, unwrapByHashAndLog:m.unwrap }, evmPublic:{getBlockNumber:async()=>100n,getLogs:m.logs,getBlock:m.block} }))
import { TestOrchestrator } from '../../e2e/orchestrator.ts'
const recipient = formatAddress(Uint8Array.from([0,...Array(19).fill(7)]))
const tx = '0x' + 'ab'.repeat(32), bridge = '0x' + '12'.repeat(20) as `0x${string}`
const log = () => ({ removed:false,blockNumber:90n,blockHash:'0x'+'cd'.repeat(32),transactionHash:tx,logIndex:5,args:{to:recipient,token:bridge,amount:100n} })
beforeEach(() => { vi.resetAllMocks(); m.unsigned.mockResolvedValue({count:0,list:[]});m.logs.mockResolvedValue([]);m.block.mockResolvedValue({hash:log().blockHash});m.unwrap.mockResolvedValue(null);m.send.mockResolvedValue('ef'.repeat(32)) })
describe('lab orchestrator retry and source identity', () => {
  it('waits for the original active pass on stop and coalesces concurrent ticks', async () => {
    m.unsigned.mockResolvedValue({count:1,list:[{id:'ab'.repeat(32),confirmationsToFinality:0,networkClass:2,chainId:31337,toAddress:bridge,tokenAddress:bridge,amount:100n,fee:3n}]})
    let release!: (hash: string) => void
    m.send.mockImplementationOnce(() => new Promise<string>((resolve) => { release = resolve }))
    const o = new TestOrchestrator({bridge,evmConfirmations:2,affiliate:true})
    o.start()
    await vi.waitFor(() => expect(m.send).toHaveBeenCalledTimes(1))
    const joined = o.tick()
    let stopped = false
    const stopping = o.stop().then(() => { stopped = true })
    await Promise.resolve()
    expect(stopped).toBe(false)
    release('ef'.repeat(32))
    await Promise.all([stopping, joined])
    expect(stopped).toBe(true)
    expect(o.signedWraps).toBe(1)
    expect(m.send).toHaveBeenCalledTimes(1)
  })
  it('does not mark a failed wrap update complete', async () => {
    m.unsigned.mockResolvedValue({count:1,list:[{id:'ab'.repeat(32),confirmationsToFinality:0,networkClass:2,chainId:31337,toAddress:bridge,tokenAddress:bridge,amount:100n,fee:3n}]})
    m.send.mockRejectedValueOnce(new Error('publication failed'))
    const o = new TestOrchestrator({bridge,evmConfirmations:2,affiliate:true})
    await expect(o.tick()).rejects.toThrow('publication failed'); expect(o.signedWraps).toBe(0)
    await o.tick();expect(o.signedWraps).toBe(1);expect(m.send).toHaveBeenCalledTimes(2)
  })
  it('retries a failed registration and never interprets an RPC outage as absence', async () => {
    m.logs.mockResolvedValue([log()]);m.unwrap.mockRejectedValueOnce(new Error('RPC unavailable'))
    const o = new TestOrchestrator({bridge,evmConfirmations:2,affiliate:true})
    await expect(o.tick()).rejects.toThrow('RPC unavailable');expect(m.send).not.toHaveBeenCalled()
    m.send.mockRejectedValueOnce(new Error('publication failed'));await expect(o.tick()).rejects.toThrow('publication failed')
    await o.tick();expect(o.registeredUnwraps).toBe(1)
  })
  it('rejects embedded recipients and self-referral bonuses', async () => {
    m.logs.mockResolvedValue([{...log(),args:{...log().args,to:formatAddress(Uint8Array.from([1,...Array(19).fill(7)]))}}])
    const o = new TestOrchestrator({bridge,evmConfirmations:2,affiliate:true});await o.tick();expect(m.send).not.toHaveBeenCalled()
    m.logs.mockResolvedValue([{...log(),logIndex:6,args:{...log().args,to:recipient+'&'+recipient}}]);await o.tick()
    expect(m.send).toHaveBeenCalledTimes(1);expect(o.registeredUnwraps).toBe(1)
  })
  it('stops when the original log is no longer canonical', async () => {
    m.logs.mockResolvedValue([log()]);m.block.mockResolvedValue({hash:'0x'+'ef'.repeat(32)})
    const o = new TestOrchestrator({bridge,evmConfirmations:2,affiliate:true})
    await expect(o.tick()).rejects.toThrow('canonical');expect(m.send).not.toHaveBeenCalled()
  })
})
