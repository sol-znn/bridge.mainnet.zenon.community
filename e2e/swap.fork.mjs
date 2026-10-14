// Swaps, for real, on an anvil fork of Ethereum mainnet (docs/TESTING.md).
//
// The page runs in headless Chrome with a mock EIP-6963 wallet that forwards
// every request to the fork, so a quote from the live routers is signed "by the
// wallet" and executed against mainnet state. Start the fork first; the
// command is in docs/TESTING.md. Screenshots go to the directory given as the
// first argument, if any.
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'
import { readFileSync } from 'node:fs'
import { assertEthereumFork, forkRpc } from './lib/swap-fork.mjs'

const pins = JSON.parse(readFileSync(new URL('./lab/pins.json', import.meta.url), 'utf8'))

const out = process.argv[2]
const FORK = process.env.SWAP_FORK
const CHROME = process.env.CHROME_PATH
const ME = '0x5a3c9e1b7d24f6a8c0e2b4d6f8a1c3e5b7d9f024'
const THEM = '0x1111111111111111111111111111111111111111'
const WZNN = '0xb2e96a63479C2Edd2FD62b382c89D5CA79f572d3'
process.env.VITE_EVM_RPCS = JSON.stringify({ 1: FORK })

let rpc
const ethOf = async (a) => BigInt(await rpc('eth_getBalance', [a, 'latest']))
const wznnOf = async (a) => BigInt(await rpc('eth_call', [{ to: WZNN, data: '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0') }, 'latest']))

function installWallet(cfg) {
  window.__sent = []
  window.__reject = false
  const provider = {
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [cfg.account]
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
      if (method === 'eth_sendTransaction' && window.__reject) {
        window.__reject = false
        throw Object.assign(new Error('MetaMask Tx Signature: User denied transaction signature.'), { code: 4001 })
      }
      const result = await window.__swapForkRpc(method, params ?? [])
      if (method === 'eth_sendTransaction') window.__sent.push({ to: params[0].to, value: params[0].value, hash: result })
      return result
    },
    on() {},
    removeListener() {},
  }
  const announce = () =>
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'fork-wallet', name: 'Fork Wallet', icon: '', rdns: 'fork.wallet' }, provider }) }))
  window.addEventListener('eip6963:requestProvider', announce)
  announce()
}

let server, b
let failed = false
const check = (name, ok, detail = '') => {
  if (!ok) failed = true
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`)
}
try {
  if (!CHROME) throw new Error('Set CHROME_PATH to the pinned fixture browser')
  rpc = forkRpc(FORK)
  await assertEthereumFork(rpc, pins.anvilVersion)
  server = await createServer({ envDir: false, cacheDir: process.env.QUALIFICATION_CACHE_DIR, server: { host: '127.0.0.1', port: 5231, strictPort: true }, logLevel: 'error' })
  await server.listen()
  b = await puppeteer.launch({ executablePath: CHROME, userDataDir: process.env.BROWSER_PROFILE_DIR, headless: true })
  if (!(await b.version()).endsWith('/' + pins.browserVersion)) throw new Error('The swap fixture requires the pinned browser version')
  // Public fixture state on the caller's isolated fork, never a live wallet.
  await rpc('anvil_setBalance', [ME, '0x21e19e0c9bab2400000'])
  await rpc('anvil_impersonateAccount', [ME])
  const p = await b.newPage()
  await p.exposeFunction('__swapForkRpc', (method, params) => rpc(method, params))
  await p.setViewport({ width: 1280, height: 1000 })
  const errs = []
  p.on('pageerror', (e) => errs.push(e.message))
  await p.evaluateOnNewDocument(installWallet, { account: ME })
  await p.goto(server.resolvedUrls.local[0])
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const text = (sel) => p.$eval(sel, (e) => e.innerText.replace(/\s*\n\s*/g, ' / ').trim())
  const maybe = (sel) => text(sel).catch(() => '')
  const closed = () => p.waitForFunction(() => !document.querySelector('[role="dialog"]'))
  const action = () => text('[data-testid="bridge-action"]')
  const waitAction = (want, ms = 60000) =>
    p.waitForFunction((w) => document.querySelector('[data-testid="bridge-action"]')?.innerText.trim() === w, { timeout: ms }, want).catch(async () => {
      throw new Error(`button reads "${await action()}", wanted "${want}"`)
    })
  const opts = () => p.$$eval('[data-testid="bridge-option"]', (l) => l.map((e) => e.innerText.replace(/\n/g, '/')))
  const choose = async (side, symbol, network) => {
    await p.click(`[data-testid="bridge-${side}"]`)
    await p.waitForSelector('[role="dialog"]')
    const seen = { pills: await p.$$eval('.net-pill', (l) => l.length), options: await opts() }
    for (const h of await p.$$('[data-testid="bridge-option"]')) {
      const [s, n] = await h.evaluate((e) => e.innerText.split('\n').map((x) => x.trim()).filter((x) => x.length > 1))
      if (s === symbol && n === network) {
        await h.click()
        await closed()
        return seen
      }
    }
    throw new Error(`no ${symbol} on ${network}: ${JSON.stringify(seen)}`)
  }
  const legs = async () => `${await text('[data-testid="bridge-from"]')} -> ${await text('[data-testid="bridge-to"]')}`
  const setAmount = async (v) => {
    await p.click('input[aria-label="Amount"]', { clickCount: 3 })
    await p.keyboard.press('Backspace')
    await p.type('input[aria-label="Amount"]', v)
  }
  const usd = async () => `${await maybe('[data-testid="bridge-from-usd"]')} -> ${await maybe('[data-testid="bridge-to-usd"]')}`
  const sent = () => p.evaluate(() => window.__sent)
  const mined = async (n) => {
    await p.waitForFunction((k) => window.__sent.length >= k, { timeout: 90000 }, n)
    const s = (await sent())[n - 1]
    for (let i = 0; i < 40; i++) {
      const r = await rpc('eth_getTransactionReceipt', [s.hash])
      if (r) {
        await p.waitForFunction((hash) => {
          const records = JSON.parse(localStorage.getItem('bridge.operations.v1') ?? '[]')
          return records.some((record) => record.hash === hash && record.state === 'confirmed')
        }, { timeout: 90000 }, s.hash)
        return { ...s, status: r.status }
      }
      await sleep(500)
    }
    throw new Error('no receipt')
  }

  await p.waitForFunction(() => { const e = document.querySelector('[data-testid="bridge-from"]'); return e && !e.disabled }, { timeout: 60000 })

  // Bridge mode: a dollar estimate beside both amounts.
  await setAmount('100')
  await p.waitForSelector('[data-testid="bridge-from-usd"]', { timeout: 20000 })
  check('bridge shows dollar estimates', /\$/.test(await usd()), `100 ZNN: ${await usd()}`)

  // Bridge is the default mode: Zenon on one side, always.
  const banner = () => p.evaluate(() => [...document.querySelectorAll('strong')].map((e) => e.parentElement.innerText.trim()).filter((t) => /is down|unavailable/i.test(t)))
  const bridged = await choose('from', 'ZNN', 'Zenon')
  check('Bridge mode offers no swap-only asset', bridged.pills === 0 && !bridged.options.some((o) => /^(ETH|BNB)\//.test(o)), JSON.stringify(bridged.options))
  console.log('bridge banner  ', JSON.stringify(await banner()))

  await p.click('[data-testid="mode-swap"]')
  await sleep(2500)
  check('Swap mode starts on a valid pair', (await legs()) === 'ETH / Ethereum -> wZNN / Ethereum', await legs())
  const said0 = await banner()
  check('Swap mode hides the bridge banner, and the routers answer', said0.length === 0, JSON.stringify(said0))
  const from = await choose('from', 'ETH', 'Ethereum')
  check('Swap mode offers EVM assets only, with no filter', from.pills === 0 && !from.options.some((o) => o.includes('Zenon')) && from.options.some((o) => o.includes('BNB Chain')), JSON.stringify(from.options))
  await setAmount('0.05')
  await waitAction('Connect EVM wallet')
  await p.waitForFunction(() => document.querySelector('[data-testid="bridge-receive"]').innerText.trim() !== '0.00', { timeout: 30000 })
  await p.waitForSelector('[data-testid="bridge-to-usd"]', { timeout: 20000 })
  check('quotes with no wallet', true, `receive ${await text('[data-testid="bridge-receive"]')} wZNN, ${await text('[data-testid="swap-via"]')}, ${await usd()}`)

  await p.click('[data-testid="wallet-menu"]')
  await p.click('[data-testid="wallet-evm-connect"]')
  await p.waitForSelector('[data-testid="wallet-option"]')
  await p.click('[data-testid="wallet-option"]')
  await closed()
  await waitAction('Swap')

  // A refusal in the wallet reads as one.
  await p.evaluate(() => (window.__reject = true))
  await p.click('[data-testid="bridge-action"]')
  await sleep(1500)
  const said = await p.evaluate(() => [...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /declin|reject|denied|viem|Request Arguments/i.test(e.textContent)).map((e) => e.textContent.trim()))
  check('a wallet refusal is three words', said.length === 1 && said[0] === 'Declined in wallet', JSON.stringify(said))
  check('no terms prompt before a swap', !(await p.$('[role="dialog"]')))

  await waitAction('Swap')
  let before = await wznnOf(ME)
  await p.click('[data-testid="bridge-action"]')
  let tx = await mined(1)
  let got = (await wznnOf(ME)) - before
  check('ETH to wZNN through KyberSwap', tx.status === '0x1' && got > 0n, `router ${tx.to}, +${Number(got) / 1e8} wZNN`)

  await p.click('[data-testid="bridge-flip"]')
  await p.click('[data-testid="bridge-advanced"]')
  await p.click('[data-testid="custom-recipient"]')
  await p.$eval('input[aria-label="Recipient"]', (e) => { e.focus(); e.select() })
  await p.keyboard.press('Backspace')
  await p.type('input[aria-label="Recipient"]', THEM)
  if (await p.$eval('input[aria-label="Recipient"]', (e) => e.value) !== THEM) throw new Error('Fixture recipient input did not retain the intended address')
  await p.click('[role="dialog"] [aria-label="Close"]')
  await closed()
  await setAmount((Number(got / 2n) / 1e8).toFixed(4))
  await waitAction('Approve wZNN')
  await p.click('[data-testid="bridge-action"]')
  tx = await mined(2)
  check('approves the quoted router for the amount', tx.status === '0x1' && tx.to.toLowerCase() === WZNN.toLowerCase())
  await waitAction('Swap')
  await p.click('.details-row')
  await sleep(400)
  console.log('details        ', await text('dl.summary'))
  before = await ethOf(THEM)
  await p.click('[data-testid="bridge-action"]')
  tx = await mined(3)
  got = (await ethOf(THEM)) - before
  check('wZNN to ETH lands at the custom recipient', tx.status === '0x1' && got > 0n, `router ${tx.to}, +${Number(got) / 1e18} ETH`)

  await choose('from', 'ETH', 'Ethereum')
  const to = await choose('to', 'BNB', 'BNB Chain')
  check('To lists everything with no filter', to.pills === 0, JSON.stringify(to.options))
  await setAmount('0.05')
  await waitAction('Swap to BNB Chain')
  console.log('cross quote    ', `receive ${await text('[data-testid="bridge-receive"]')} BNB, ${await text('section .text-dim')}, ${await text('[data-testid="swap-via"]')}, ${await usd()}`)
  console.log('details        ', await text('dl.summary'))
  if (out) await p.screenshot({ path: out + '/swap-cross.png' })
  before = await ethOf(ME)
  await p.click('[data-testid="bridge-action"]')
  tx = await mined(4)
  check('ETH to BNB through Across: sending transaction succeeds', tx.status === '0x1' && before - (await ethOf(ME)) >= 5n * 10n ** 16n, `router ${tx.to}`)

  // wZNN on Ethereum to BNB: a token source across chains.
  await choose('from', 'wZNN', 'Ethereum')
  await choose('to', 'BNB', 'BNB Chain')
  await setAmount('100')
  await p.waitForFunction(() => /Approve wZNN|Swap to BNB Chain/.test(document.querySelector('[data-testid="bridge-action"]').innerText), { timeout: 60000 }).catch(() => {})
  console.log('wZNN to BNB    ', await action(), '|', await maybe('[data-testid="swap-via"]'), '|', await text('[data-testid="bridge-receive"]'))

  await p.click('[data-testid="mode-bridge"]')
  await sleep(300)
  check('Bridge mode comes back to its own pair', (await legs()) === 'ZNN / Zenon -> wZNN / Ethereum', await legs())
  check('no page errors', errs.length === 0, errs.join(' | '))
} catch (e) {
  failed = true
  console.log('ERROR', e.message)
} finally {
  const cleanup = await Promise.allSettled([b?.close(), server?.close()])
  if (cleanup.some((result) => result.status === 'rejected')) {
    failed = true
    console.log('ERROR fixture cleanup did not complete')
  }
}
process.exit(failed ? 1 : 0)
