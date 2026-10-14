// Uses the actual application components with offline fixtures. No production
// node, EVM RPC, real extension, key or account is accessed.
import { createApp, markRaw, ref, h } from 'vue'
import { encodeFunctionResult, decodeFunctionData } from 'viem'
import Modal from '../../src/components/Modal.vue'
import App from '../../src/App.vue'
import '../../src/style.css'
import { api, node, syrius } from '../../src/state/zenon.ts'
import { bridge, nodeContext } from '../../src/state/bridge.ts'
import { evm } from '../../src/state/evm.ts'
import { activity } from '../../src/state/activity.ts'
import { toasts } from '../../src/state/toasts.ts'
import { accepted } from '../../src/state/ack.ts'
import { bridgeAbi, erc20Abi, pairAbi } from '../../src/evm/abi.ts'
import { BRIDGE, config } from '../../src/config.ts'
import { operations, journalSubmission } from '../../src/state/operations.ts'
import * as wallet from '../../src/wallet/syrius.ts'

const zAddress = 'z1qq6eg8n43g032hanpsfp02qcdmv7zfj3y2lt5d'
const eAddress = '0x1212121212121212121212121212121212121212'
const eContract = '0x3434343434343434343434343434343434343434'
const zts = 'zts1znnxxxxxxxxxxxxx9z4ulx'
const token = { name: 'Zenon', symbol: 'ZNN', decimals: 8, tokenStandard: zts }
const sent: any[] = []
const evmRequests: any[] = []
let pending: { resolve: (x: unknown) => void; template: any } | null = null
const receiptHash = '0x' + 'cd'.repeat(32)
const w = window as any
const swapEnabled = new URLSearchParams(location.search).has('swap')
if (!swapEnabled) config.swap = undefined
const originalFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = String(input)
  if (/^https:\/\/(aggregator-api\.kyberswap\.com|app\.across\.to|li\.quest)\//.test(url)) {
    const body = url.includes('/route/build') ? { data: { amountOut: '100000000', data: '0xe21fd0e9', routerAddress: config.swap!.kyber.router, transactionValue: '100000000000000000' } } :
      url.includes('/routes?') ? { data: { routeSummary: {} } } : url.includes('/token?') ? { priceUSD: '1' } :
      url.includes('/chains') ? { chains: [{ id: 1 }] } : url.includes('/available-routes') ? [{ originChainId: 1 }] : { status: 'pending' }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return originalFetch(input, init)
}
config.evm[1].rpc='http://127.0.0.1:5195/fixture-rpc'
const knobs = { failBalances: false, receiptReverted: false, delayWallet: false, delayConnect:false, allowance: 0n, failPool:false, wrongPool:false,
  lpIncrease: false, lpBalance: 1000n, failProgram:false, haltedProgram:false, programRewards:false, stakeCount:0, reward:0n, delayEvmWallet:false }
const provider = {
  request: async (req: any): Promise<any> => {
    evmRequests.push(req)
    if (req.method === 'eth_chainId') return '0x1'
    if (req.method === 'eth_accounts' || req.method === 'eth_requestAccounts') return [eAddress]
    if (req.method === 'eth_sendTransaction') {
      if (knobs.delayEvmWallet) return new Promise((resolve) => { w.__fixture.finishEvmWallet = () => resolve(receiptHash) })
      if (req.params[0].data?.startsWith('0x095ea7b3') && !knobs.receiptReverted) knobs.allowance=1000_00000000n
      if (req.params[0].data?.startsWith('0xf305d719') && knobs.lpIncrease && !knobs.receiptReverted) knobs.lpBalance+=100n
      return receiptHash
    }
    if (req.method === 'eth_blockNumber') return '0x102'
    if (req.method === 'eth_getTransactionByHash') {
      const tx = [...evmRequests].reverse().find((r: any) => r.method === 'eth_sendTransaction')?.params[0]
      return tx ? { ...tx, input: tx.data, value: tx.value || '0x0', hash: receiptHash, from: eAddress, blockNumber: '0x100', blockHash: '0x' + 'ef'.repeat(32), transactionIndex: '0x0', nonce: '0x0', gas: '0x100000', gasPrice: '0x1', v: '0x1b', r: '0x'+'01'.repeat(32), s: '0x'+'02'.repeat(32), type: '0x0' } : null
    }
    if (req.method === 'eth_getBalance') return '0x8ac7230489e80000'
    if (req.method === 'eth_getTransactionReceipt') return {
      transactionHash: receiptHash, transactionIndex: '0x0', blockHash: '0x' + 'ef'.repeat(32), blockNumber: '0x100',
      from: eAddress, to: [...evmRequests].reverse().find((r:any)=>r.method==='eth_sendTransaction')?.params[0].to ?? eContract, cumulativeGasUsed: '0x5208', gasUsed: '0x5208', contractAddress: null,
      logs: [], logsBloom: '0x' + '00'.repeat(256), status: knobs.receiptReverted ? '0x0' : '0x1',
      effectiveGasPrice: '0x1', type: '0x0',
    }
    if (req.method === 'eth_getBlockByNumber') return {
      number:'0x100', hash:'0x'+'ef'.repeat(32), parentHash:'0x'+'ee'.repeat(32), timestamp:'0x6acd1221',
      nonce:'0x0000000000000000', sha3Uncles:'0x'+'00'.repeat(32), logsBloom:'0x'+'00'.repeat(256),
      transactionsRoot:'0x'+'00'.repeat(32), stateRoot:'0x'+'00'.repeat(32), receiptsRoot:'0x'+'00'.repeat(32),
      miner:eAddress, difficulty:'0x0', totalDifficulty:'0x0', extraData:'0x', size:'0x1', gasLimit:'0x1000000',gasUsed:'0x0',transactions:[],uncles:[],baseFeePerGas:'0x1',
    }
    if (req.method === 'eth_getCode') return '0x01'
    if (req.method === 'eth_call') {
      if (knobs.failPool && req.params[0].to.toLowerCase() === config.evm[1].liquidity!.pair.toLowerCase()) throw new Error('Pool RPC unavailable')
      for (const abi of [bridgeAbi, pairAbi, erc20Abi]) {
        try {
          const d = decodeFunctionData({ abi, data: req.params[0].data })
          const f = d.functionName
          const values: Record<string, any> = {
            symbol:'wZNN', name:'Wrapped Zenon', decimals:8, balanceOf:1000_00000000n, allowance:knobs.allowance,
            totalSupply:1000_000000000000000000n, token0:knobs.wrongPool ? '0x'+'56'.repeat(20) : eAddress, token1:config.evm[1].liquidity!.weth,
            getReserves:[1000_00000000n, 10_000000000000000000n, 0],
            tokensInfo:[1n,90n,true,true,true], estimatedBlockTime:12n,confirmationsToFinality:90n,
            isHalted:false, redeemsInfo:[0n,'0x'+'00'.repeat(32)],
          }
          if (f === 'balanceOf' && req.params[0].to.toLowerCase() === config.evm[1].liquidity!.pair.toLowerCase()) values.balanceOf=knobs.lpBalance
          if (f === 'redeem') return '0x'
          if (f && f in values) return encodeFunctionResult({ abi:abi as any, functionName:f as any, result:values[f] })
        } catch { /* try the next ABI */ }
      }
      throw new Error('unexpected fixture eth_call')
    }
    throw new Error('unexpected fixture method '+req.method)
  }, on(){}, removeListener(){},
}
w.zenon = {
  version:2, connect:async()=> knobs.delayConnect ? new Promise((resolve)=>{w.__fixture.releaseConnect=()=>resolve(true)}) : true, disconnect:async()=>true, getAccounts:async()=>[zAddress],
  getChainId:async()=>1, getNodeUrl:async()=>'wss://offline.fixture.invalid',
  sendAccountBlock:async(template:any)=>{
    sent.push(JSON.parse(JSON.stringify(template)))
    if (knobs.delayWallet) return new Promise(resolve=>{pending={resolve,template}})
    return {hash:'ab'.repeat(32),block:{...template,hash:'ab'.repeat(32),address:zAddress}}
  }, on(){}, removeListener(){},
}
Object.assign(node, {url:'wss://offline.fixture.invalid',source:'default',chainId:1,height:100000,timestamp:Math.floor(Date.now()/1000),conn:'open'})
Object.assign(syrius, {present:true,address:zAddress,chainId:1,nodeUrl:'wss://offline.fixture.invalid'})
Object.assign(evm,{account:eAddress,chainId:1,selected:markRaw({info:{uuid:'audit',name:'Offline audit wallet',rdns:'audit.invalid',icon:''},provider})})
const pair = { tokenStandard:zts,tokenAddress:eAddress,bridgeable:true,redeemable:true,owned:true,minAmount:100000000n,feePercentage:300,redeemDelay:90,metadata:'' }
Object.assign(bridge,{
  loaded:true, info:{halted:false,allowKeyGen:false,metadata:'{}'}, meta:{},
  orch:{estimatedMomentumTime:10,confirmationsToFinality:90,keyGenThreshold:3},
  networks:[{networkClass:2,chainId:1,name:'Ethereum',contractAddress:eContract,tokenPairs:[pair]}],
  routes:[{key:'1:ZNN',chainId:1,networkClass:2,networkName:'Ethereum',contract:eContract,pair,zts:token,
    evm:{name:'Wrapped Zenon',symbol:'wZNN',decimals:8},evmInfo:{minAmount:100000000n,redeemDelay:90n,bridgeable:true,redeemable:true,owned:true},canWrap:true,canUnwrap:true}],
  context:nodeContext(), readAt:Date.now(), healthAt:Date.now(),
  evmNetworks:{1:{blockTime:12,confirmations:90,halted:false,tssMatches:true,height:256n,error:''}},
  health:{state:'idle',label:'Idle',tone:'dim',message:'',waiting:[],oldestWaitSeconds:0,lastAction:null,orchestrators:[],scannedSince:null},
})
api.value = {
  balances:async()=>{if(knobs.failBalances)throw new Error('balance fixture failure');return {[zts]:1000_00000000n}},
  plasma:async()=>({currentPlasma:100000,maxPlasma:100000,qsrAmount:0n}),
  wrapsTo:async()=>({count:0,list:[]}),unwrapsTo:async()=>({count:0,list:[]}),
  allWraps:async()=>({count:0,list:[]}),allUnwraps:async()=>({count:0,list:[]}),
  wrapById:async()=>null,unwrapByHashAndLog:async()=>null,
  c:{callOrNull:async()=>null}, feeTokenPair:async()=>0n, securityInfo:async()=>({guardians:[],administratorDelay:1,softDelay:1}),
  liquidityInfo:async()=>{if(knobs.failProgram)throw new Error('Program unavailable');return {isHalted:knobs.haltedProgram,znnReward:knobs.programRewards?1n:0n,qsrReward:0n,tokenTuples:[{tokenStandard:zts,minAmount:1n,znnPercentage:10000,qsrPercentage:10000}]}},
  stakeEntries:async(_address:string,index=0,size=100)=>({count:knobs.stakeCount,list:Array.from({length:knobs.stakeCount},(_,i)=>({id:i.toString(16).padStart(64,'0'),tokenStandard:zts,amount:100000000n,weightedAmount:100000000n,startTime:node.timestamp-1000,expirationTime:node.timestamp+(i===0?100:-10),revokeTime:0})).slice(index*size,(index+1)*size),totalAmount:0n,totalWeightedAmount:0n}),uncollectedReward:async()=>({znn:knobs.reward,qsr:0n}),
} as any
accepted.value=true
Object.assign(w,{__fixture:{bridge,node,syrius,evm,activity,toasts,sent,evmRequests,knobs,BRIDGE,operations,journalSubmission,provider,
  holdWalletQueue:()=>{knobs.delayConnect=true;w.__fixture.connection=wallet.connect()},
  openNested:()=>{
    const outer=ref(true),inner=ref(false),host=document.createElement('div');document.body.append(host)
    createApp({setup:()=>()=>[
      h(Modal,{open:outer.value,title:'Outer fixture',onClose:()=>outer.value=false},{default:()=>h('button',{onClick:()=>inner.value=true},'Open inner')}),
      h(Modal,{open:inner.value,title:'Inner fixture',onClose:()=>inner.value=false},{default:()=>h('button',{},'Inner action')}),
    ]}).mount(host)
  },
  finishWallet:()=>{ if(pending){pending.resolve({hash:'ab'.repeat(32),block:{...pending.template,hash:'ab'.repeat(32),address:zAddress}});pending=null} },
}})
createApp(App).mount('#app')
