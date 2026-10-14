// The page itself, on the lab, in headless Chrome: connect both wallets, wrap
// from the Bridge view, redeem both steps from Activity, unwrap back, redeem
// on Zenon, and read the Stats page.
//
// The two wallets are stand-ins injected before the page loads:
//
//   window.zenon   the Syrius v0.3.4 provider shape. sendAccountBlock hands
//                  the page's template to this process, which fills it in,
//                  signs it with the lab key and publishes it: what the
//                  extension does after the user approves.
//   EIP-6963       a provider announced as "Lab Wallet". Its requests are
//                  forwarded to anvil, which signs for its own accounts.
//
// So everything the page does is real: its node connection, its reads, the
// blocks and transactions it builds, and what it shows for each state.
//
// Needs `e2e/lab/lab.sh up` and Chrome (CHROME_PATH to override).

import fs from 'node:fs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { createServer, type ViteDevServer } from 'vite'
import { setup, PARAMS, type Deployment } from './setup.ts'
import { TestOrchestrator } from './orchestrator.ts'
import { EVM_CHAIN_ID, EVM_RPC, ZNN_CHAIN_ID, ZNN_WS, evmUser, mine, receiveAll, send, drainPublications, until, zAdmin, evmPublic } from './lib/lab.ts'
import { fromBase64 } from '../src/znn/primitives.ts'
import { erc20Abi } from '../src/evm/abi.ts'
import type { BlockJson } from '../src/znn/block.ts'

const PORT = 5191
const URL = `http://127.0.0.1:${PORT}/`

function chromePath(): string {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean) as string[]
  const found = candidates.find((p) => fs.existsSync(p))
  if (!found) throw new Error('Chrome not found: set CHROME_PATH')
  return found
}

let d: Deployment
let orchestrator: TestOrchestrator
let server: ViteDevServer
let browser: Browser
let page: Page
const errors: string[] = []
/** Every block the mock Syrius was asked to sign, for a failure report. */
const sentLog: string[] = []

/** Runs in the page before any of its scripts. */
function installWallets(cfg: { zAddress: string; zChainId: number; zNode: string; evmAddress: string }) {
  const w = window as unknown as Record<string, any>
  w.zenon = {
    version: 2,
    isSyriusExtension: true,
    connect: async () => true,
    disconnect: async () => true,
    getAccounts: async () => [cfg.zAddress],
    getChainId: async () => cfg.zChainId,
    getNodeUrl: async () => cfg.zNode,
    sendAccountBlock: (block: unknown) => w.__labZenonSend(JSON.stringify(block)).then((r: string) => JSON.parse(r)),
    on() {},
    removeListener() {},
  }
  const provider = {
    request: async ({ method, params }: { method: string; params?: unknown }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [cfg.evmAddress]
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
      if (method === 'wallet_watchAsset') return true
      const r = JSON.parse(await w.__labEvmRequest(JSON.stringify({ method, params: params ?? [] })))
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code, data: r.error.data })
      return r.result
    },
    on() {},
    removeListener() {},
  }
  const announce = () =>
    window.dispatchEvent(
      new CustomEvent('eip6963:announceProvider', {
        detail: Object.freeze({ info: { uuid: '7d3d1d4c-lab', name: 'Lab Wallet', icon: '', rdns: 'lab.wallet' }, provider }),
      }),
    )
  window.addEventListener('eip6963:requestProvider', announce)
  announce()
}

const text = (sel: string) => page.$eval(sel, (e) => (e as HTMLElement).innerText.trim())
const click = async (sel: string) => {
  await page.waitForSelector(sel, { visible: true })
  // Dispatch once in the same browser turn that observes an enabled control.
  // A momentum refresh can disable/move a row during a mouse's scroll/hover.
  await page.waitForFunction((selector)=>{
    const e=document.querySelector(selector) as HTMLButtonElement|null
    if(!e||e.disabled)return false
    if(e.hasAttribute('data-testid')&&e.dataset.testid==='activity-action') {
      const a=(window as any).__bridge.activity
      if(a.loading||!a.readAt||a.error)return false
    }
    e.click()
    return true
  },{timeout:120_000},sel)
}
// The list also holds requests from earlier runs, so a row is addressed by the
// request it shows: `w:<id>` for a wrap, `u:<evm tx>` for an unwrap.
const row = (key: string) => `[data-testid="activity-row"][data-kind="${key.startsWith('w:') ? 'wrap' : 'unwrap'}"][data-source-tx="${key.slice(2)}"]`
/** Waits for that row to reach one of `states`; returns the one it is in. */
async function rowState(keyPrefix: string, states: string[], timeout = 240_000): Promise<string> {
  const el = await page.waitForSelector(states.map((s) => `${row(keyPrefix)}[data-state="${s}"]`).join(','), { timeout }).catch(async (err) => {
    // What the page shows instead: its rows, its toasts and its wallet state.
    const seen = await page.evaluate(() => ({
      rows: [...document.querySelectorAll('[data-testid="activity-row"]')].map((r) => `${r.getAttribute('data-key')?.slice(0, 14)}=${r.getAttribute('data-state')}`),
      toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent),
      syrius: JSON.stringify((window as any).__bridge.syrius),
      activity: (()=>{const a=(window as any).__bridge.activity;return {loading:a.loading,error:a.error,readAt:a.readAt,busy:a.busy}})(),
      originalOperations: localStorage.getItem('bridge.operations.v1'),
    }))
    throw new Error(`${keyPrefix.slice(0, 14)} never reached ${states.join('/')}: ${err.message.slice(0, 120)}
${JSON.stringify(seen)}
errors: ${errors.join(' | ')}
sent: ${sentLog.join(' | ')}`)
  })
  return (await el!.evaluate((e) => e.getAttribute('data-state')))!
}
const actOn = (keyPrefix: string, state: string) => click(`${row(keyPrefix)}[data-state="${state}"] [data-testid="activity-action"]`)
/** The request the page just sent, from its own local history. */
// Serialised in the page: a Vue proxy does not survive the DevTools protocol.
const lastLocal = async () => JSON.parse(await page.evaluate(() => JSON.stringify((window as any).__bridge.activity.local[0]))) as { id?: string; txHash?: string }
let wrapKey = ''
let unwrapKey = ''
const wznn = () => evmPublic.readContract({ address: d.token, abi: erc20Abi, functionName: 'balanceOf', args: [evmUser.address] })

beforeAll(async () => {
  d = await setup()
  await receiveAll()
  orchestrator = new TestOrchestrator({ bridge: d.bridge, evmConfirmations: Number(PARAMS.evm.confirmations), affiliate: true, log: console.log })
  orchestrator.start()

  process.env.VITE_NETWORK = 'devnet'
  server = await createServer({ server: { port: PORT, strictPort: true, host: '127.0.0.1' }, logLevel: 'error' })
  await server.listen()

  // A wait here can outlast puppeteer's default 3 min protocol timeout.
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, protocolTimeout: 600_000 })
  page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  page.on('pageerror', (e) => errors.push(e instanceof Error ? e.message : String(e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))

  // Syrius, after approval: fill in the template, sign, publish.
  await page.exposeFunction('__labZenonSend', async (json: string) => {
    const t = JSON.parse(json) as BlockJson
    sentLog.push(`${t.toAddress.slice(0, 12)} ${Buffer.from(fromBase64(t.data).subarray(0, 4)).toString('hex')}`)
    const hash = await send({
      blockType: t.blockType,
      toAddress: t.toAddress,
      amount: BigInt(t.amount),
      tokenStandard: t.tokenStandard,
      data: fromBase64(t.data),
      fromBlockHash: t.fromBlockHash,
    })
    return JSON.stringify({ hash, block: { ...t, hash, address: zAdmin.address } })
  })
  // The EVM wallet: anvil signs for its own accounts.
  await page.exposeFunction('__labEvmRequest', async (json: string) => {
    const { method, params } = JSON.parse(json)
    if (['eth_sendTransaction', 'eth_sendRawTransaction'].includes(method)) {
      const { assertLab } = await import('./lib/lab.ts')
      await assertLab()
    }
    const res = await fetch(EVM_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    return JSON.stringify(await res.json())
  })
  await page.evaluateOnNewDocument(installWallets, { zAddress: zAdmin.address, zChainId: ZNN_CHAIN_ID, zNode: ZNN_WS, evmAddress: evmUser.address })
  await page.goto(URL, { waitUntil: 'domcontentloaded' })
})

afterAll(async () => {
  try { await orchestrator?.stop(); await drainPublications() }
  finally { await browser?.close(); await server?.close() }
})

describe('the page on the lab', () => {
  it('loads the devnet route and finds both wallets', async () => {
    await page.waitForFunction(() => document.body.innerText.includes('Anvil'), { timeout: 60_000 }).catch(async (err) => {
      // Say what the page did show: a wrong network or a script error reads the same as slowness otherwise.
      throw new Error(`${err.message}
page: ${(await page.evaluate(() => document.body.innerText)).slice(0, 600)}
errors: ${errors.join(' | ')}
state: ${await page.evaluate(() => { const b = (window as any).__bridge; return JSON.stringify({ error: b?.bridge.error, loaded: b?.bridge.loaded, nets: b?.bridge.networks.length, conn: b?.node.conn, src: b?.node.source }) })}`)
    })
    expect(await text('header')).toContain('Devnet')
    // Syrius was "approved" for this origin, so the page reads it without a prompt.
    await page.waitForFunction((a) => (window as any).__bridge.syrius.address === a, { timeout: 20_000 }, zAdmin.address)
    // Both wallets live behind one button.
    await click('[data-testid="wallet-menu"]')
    expect(await text('[data-testid="wallet-zenon"]')).toContain(zAdmin.address.slice(0, 5))
    await click('[data-testid="wallet-evm-connect"]')
    await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="wallet-option"]')].some((b) => b.textContent?.includes('Lab Wallet')))
    await click('[data-testid="wallet-option"]')
    await page.waitForFunction((a) => (window as any).__bridge.evm.account?.toLowerCase() === a, {}, evmUser.address.toLowerCase())
    // The picker fades out; a click before it is gone lands on its backdrop.
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
  })

  it('moves to the Syrius node only after its network is confirmed', async () => {
    const source = () => page.evaluate(() => (window as any).__bridge.node.source as string)
    expect(await source()).toBe('default')
    await click('[data-testid="wallet-menu"]')
    await click('[data-testid="node-toggle"]')
    await click('[data-testid="node-switch"]')
    await page.waitForFunction(() => document.querySelector('[data-testid="node-network"]')?.textContent?.trim() === 'Devnet')
    // Asked, not yet answered: still the default node.
    expect(await source()).toBe('default')
    await click('[data-testid="node-confirm"]')
    await page.waitForFunction(() => (window as any).__bridge.node.source === 'wallet')
    expect(await page.evaluate(() => (window as any).__bridge.node.chainId as number)).toBe(322)
    await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
    // The menu steps aside for the dialog.
    await page.waitForFunction(() => !document.querySelector('[data-testid="node-switch"]'))
  })

  it('wraps 2 ZNN from the Bridge view, after the terms', async () => {
    await page.type('input[aria-label="Amount"]', '2')
    await page.waitForFunction(() => document.querySelector('[data-testid="bridge-receive"]')?.textContent?.trim() === '1.94')
    await page.waitForFunction(() => document.querySelector('[data-testid="bridge-action"]')?.textContent?.includes('Bridge to Anvil'))
    await click('[data-testid="bridge-action"]')
    await click('[data-testid="terms-all"]')
    await click('[data-testid="terms-continue"]')
    // Sent: the page moves to Activity and shows the request at once.
    await page.waitForFunction(() => location.hash === '#/activity', { timeout: 120_000 })
    wrapKey = `w:${(await lastLocal()).id}`
    expect(['confirming', 'signing', 'redeem']).toContain(await rowState(wrapKey, ['confirming', 'signing', 'redeem']))
  })

  it('redeems the wrap in two steps from Activity', async () => {
    const before = await wznn()
    await rowState(wrapKey, ['redeem'])
    await actOn(wrapKey, 'redeem')
    await rowState(wrapKey, ['delay', 'finish'])
    await mine(d.evmRedeemDelay + 1)
    await rowState(wrapKey, ['finish'])
    await actOn(wrapKey, 'finish')
    await rowState(wrapKey, ['done'])
    expect(await wznn()).toBe(before + 1_94000000n)
  })

  it('unwraps 1 wZNN back: approve, send, then redeem on Zenon', async () => {
    await page.goto(URL + '#/', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.body.innerText.includes('Anvil'), { timeout: 60_000 })
    await page.waitForFunction(() => !!(window as any).__bridge.evm.account, { timeout: 20_000 })
    await click('[data-testid="bridge-flip"]')
    await page.type('input[aria-label="Amount"]', '1')
    await page.waitForFunction(() => document.querySelector('[data-testid="bridge-action"]')?.textContent?.includes('Approve'), { timeout: 30_000 })
    await click('[data-testid="bridge-action"]')
    await page.waitForFunction(() => document.querySelector('[data-testid="bridge-action"]')?.textContent?.includes('Bridge to Zenon'), { timeout: 60_000 })
    const before = await wznn()
    await click('[data-testid="bridge-action"]')
    await page.waitForFunction(() => location.hash === '#/activity', { timeout: 60_000 })
    expect(await wznn()).toBe(before - 1_00000000n)

    unwrapKey = `u:${(await lastLocal()).txHash!.slice(2).toLowerCase()}`
    // Shown at once, before any orchestrator has seen it.
    await page.waitForSelector(row(unwrapKey), { timeout: 30_000 })
    await mine(Number(PARAMS.evm.confirmations) + 1)
    await rowState(unwrapKey, ['redeem'])
    const promptsBefore=sentLog.length
    await actOn(unwrapKey, 'redeem')
    await until('the original Zenon redeem wallet invocation',async()=>sentLog.length>promptsBefore,30_000,250)
    expect(sentLog.at(-1)).toContain('d4e06c79')
    // The page re-reads 25 s after sending.
    expect(await rowState(unwrapKey, ['done'])).toBe('done')
    expect(sentLog.at(-1)).toContain('d4e06c79') // Redeem, signed by "Syrius"
  })

  it('shows the orchestrator online on Stats, with no page errors and no overflow', async () => {
    await page.goto(URL + '#/stats', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="orchestrator-state"]', { timeout: 120_000 })
    expect(await text('[data-testid="orchestrator-state"]')).toBe('Online')
    expect(await page.evaluate(() => document.body.innerText)).toContain(zAdmin.address.slice(0, 6))
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBe(0)
    expect(errors).toEqual([])
    expect(EVM_CHAIN_ID).toBe(31337)
  })
})
