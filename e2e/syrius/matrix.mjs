import fs from 'node:fs'
import puppeteer from 'puppeteer-core'
import { assertWalletLab, assertPageOrigin, createResultsDirectory, forwardEvmRead } from './lab-safety.mjs'

const [label, extDir] = process.argv.slice(2)
if (!extDir) throw new Error('Set an isolated extension directory')
const MNEMONIC = 'abstract affair idle position alien fluid board ordinary exist afraid chapter wood wood guide sun walnut crew perfect place firm poverty model side million'
const INDEX3 = 'z1qp3yph55qgresyytz83anynr2f4z39x2z3ej3e'
const NODE = 'ws://127.0.0.1:46998', NODE_HTTP = 'http://127.0.0.1:46997', CHAIN = 322
const PAGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:4174/'
const EVM_USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
await assertWalletLab({ label, pageUrl: PAGE_URL })
const out = createResultsDirectory(label)
const log = (...a) => { const line = `[${label}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(`${out}/log.txt`, line + '\n') }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const errors = []

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, pipe: true, enableExtensions: [extDir], protocolTimeout: 600_000,
  args: ['--no-sandbox', '--window-size=1280,900', '--screen-info={0,0 1920x1080}'],
})
let step = 'start'
try {
  const worker = await browser.waitForTarget((t) => t.url().startsWith('chrome-extension://'), { timeout: 15000 })
  const id = new URL(worker.url()).host
  const ext = `chrome-extension://${id}`
  const popup = await browser.newPage()
  await popup.setViewport({ width: 400, height: 640 })
  const shot = (p, name) => p.screenshot({ path: `${out}/${name}.png` }).catch(() => {})
  const textOf = (p) => p.evaluate(() => document.body.innerText)
  const clickText = async (p, re, scope = 'button,a,[role=button],div,span,label') => {
    const ok = await p.evaluate((src, scope) => {
      const re = new RegExp(src)
      const els = [...document.querySelectorAll(scope)].filter((e) => e.offsetParent !== null && re.test((e.innerText || '').trim()))
      const el = els.find((e) => e.tagName === 'BUTTON' && !e.disabled) || els.pop()
      if (!el) return false
      el.scrollIntoView(); el.click(); return true
    }, re.source, scope)
    if (!ok) throw new Error(`nothing matching ${re} on ${p.url()}:\n${(await textOf(p)).slice(0, 600)}`)
  }
  const typeInto = async (p, sel, value) => { await p.waitForSelector(sel, { visible: true, timeout: 15000 }); await p.click(sel, { clickCount: 3 }); await p.keyboard.press('Backspace'); await p.type(sel, value) }
  const route = async (hash) => { await popup.goto(`${ext}/popup.html#${hash}`, { waitUntil: 'networkidle2' }); await wait(1200) }

  step = 'onboard'
  await popup.goto(`${ext}/popup.html`, { waitUntil: 'networkidle2' }); await wait(1500)
  await clickText(popup, /^Import a recovery phrase$/)
  await typeInto(popup, 'textarea', MNEMONIC)
  await clickText(popup, /^Continue$/)
  await typeInto(popup, 'input[name=walletNameField]', 'lab')
  await typeInto(popup, 'input[name=passwordField]', 'Lab-pass-2026!x')
  await typeInto(popup, 'input[name=repeatPasswordField]', 'Lab-pass-2026!x')
  await clickText(popup, /^Import wallet$/)
  await popup.waitForFunction(() => location.hash.includes('/tabs/'), { timeout: 60000 })
  await wait(1500)
  log('imported')

  step = 'node'
  await route('/tabs/settings/change-node')
  await typeInto(popup, 'input[placeholder^="wss://"]', NODE)
  await clickText(popup, /^Add$/)
  await wait(1500)
  await clickText(popup, new RegExp(`^${RegExp.escape(NODE)}$`))
  await wait(2500)
  await typeInto(popup, 'input[placeholder^="Chain identifier"]', String(CHAIN))
  await clickText(popup, /^Save$/)
  await wait(2500)
  await shot(popup, '1-node')
  const nodeText = await textOf(popup)
  log('node screen:', nodeText.replace(/\s+/g, ' ').slice(0, 200))

  step = 'account'
  await route('/tabs/change-address')
  for (let i = 0; i < 6; i++) {
    const n = await popup.$$eval('.address-item-main', (e) => e.length)
    if (n > 3) break
    await clickText(popup, /^Add address$/); await wait(1500)
  }
  await popup.$$eval('.address-item-main', (e) => e[3].click())
  await wait(2000)
  await shot(popup, '2-account')
  const acct = await textOf(popup)
  if (!acct.includes(INDEX3.slice(0, 10))) throw new Error(`index 3 not listed: ${acct.slice(0, 400)}`)
  log('account 4 selected')

  step = 'page'
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  page.on('pageerror', (e) => errors.push(String(e.message || e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.exposeFunction('__labEvmRequest', (json) => forwardEvmRead(json, page.url(), PAGE_URL))
  await page.evaluateOnNewDocument((evmAddress) => {
    const w = window
    const provider = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [evmAddress]
        if (method === 'eth_chainId') return '0x7a69'
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
        if (method === 'wallet_watchAsset') return true
        const r = JSON.parse(await w.__labEvmRequest(JSON.stringify({ method, params: params ?? [] })))
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code })
        return r.result
      },
      on() {}, removeListener() {},
    }
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'lab-evm', name: 'Lab Wallet', icon: '', rdns: 'lab.wallet' }, provider }) }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
  }, EVM_USER)
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  assertPageOrigin(page.url(), PAGE_URL)
  await page.waitForFunction(() => document.body.innerText.includes('Anvil'), { timeout: 90000 })
  await page.waitForFunction(() => window.__bridge?.syrius.present === true, { timeout: 20000 })
  const provider = await page.evaluate(() => ({ version: window.zenon?.version ?? null, keys: Object.keys(window.zenon || {}).sort().join(','), legacy: !window.zenon?.sendAccountBlock }))
  log('provider', JSON.stringify(provider))

  const click = async (sel) => {
    await page.waitForSelector(sel, { visible: true, timeout: 60000 })
    await page.waitForFunction((s) => { const e = document.querySelector(s); return !!e && !e.disabled }, { timeout: 60000 }, sel)
    await wait(400)
    await page.click(sel)
  }
  const approve = async (what, action = /^(Connect|Approve|Confirm|Sign|Send|Allow)/) => {
    const t = await browser.waitForTarget((t) => t.type() === 'page' && t.url().startsWith(ext) && !t.url().includes('#/tabs/settings') && t.url() !== popup.url(), { timeout: 90000 }).catch(async (e) => {
      const ts = browser.targets().map((t) => `${t.type()} ${t.url()}`).join(' ; ')
      const st = await page.evaluate(() => JSON.stringify({ s: window.__bridge.syrius, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) }))
      throw new Error(`${e.message}
targets: ${ts}
page: ${st}
popup: ${(await textOf(popup)).replace(/\s+/g, ' ').slice(0, 300)}`)
    })
    const w = await t.page()
    await w.setViewport({ width: 400, height: 640 }).catch(() => {})
    await wait(2500)
    await shot(w, `3-${what}-asked`)
    log(`${what} window:`, (await textOf(w)).replace(/\s+/g, ' ').slice(0, 300))
    for (let i = 0; i < 60; i++) {
      const ready = await w.evaluate((src) => [...document.querySelectorAll('button')].some((b) => new RegExp(src).test(b.innerText.trim()) && !b.disabled), action.source).catch(() => false)
      if (ready) break
      await wait(1000)
    }
    if (what === 'send') {
      assertPageOrigin(page.url(), PAGE_URL)
      await assertWalletLab({ label, pageUrl: PAGE_URL })
    }
    await clickText(w, action, 'button')
    log(`${what} approved`)
  }

  step = 'connect'
  await click('[data-testid="wallet-menu"]')
  await click('[data-testid="wallet-zenon-connect"]')
  for (const ms of [300, 1500]) { await wait(ms); log('after connect click', await page.evaluate(() => JSON.stringify({ s: window.__bridge.syrius, toasts: [...document.querySelectorAll('.toast')].map((t) => t.textContent) })), 'errors:', errors.join(' | ').slice(0, 400)) }
  await approve('connect')
  await page.waitForFunction((a) => window.__bridge.syrius.address === a, { timeout: 60000 }, INDEX3)
  const sy = await page.evaluate(() => JSON.stringify(window.__bridge.syrius))
  log('connected', sy)
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.querySelector('[data-testid="wallet-backdrop"]')?.click())
  await wait(500)
  await click('[data-testid="wallet-menu"]')
  await click('[data-testid="wallet-evm-connect"]')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="wallet-option"]')].some((b) => b.textContent?.includes('Lab Wallet')))
  await click('[data-testid="wallet-option"]')
  await page.waitForFunction(() => !!window.__bridge.evm.account)
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))
  await page.screenshot({ path: `${out}/4-connected.png` })

  step = 'wrap'
  await page.type('input[aria-label="Amount"]', '2')
  await page.waitForFunction(() => document.querySelector('[data-testid="bridge-action"]')?.textContent?.includes('Bridge to Anvil'), { timeout: 60000 }).catch(async (e) => {
    throw new Error(`${e.message}: action reads ${await page.$eval('[data-testid="bridge-action"]', (b) => b.textContent)}`)
  })
  await click('[data-testid="bridge-action"]')
  await click('[data-testid="terms-all"]')
  assertPageOrigin(page.url(), PAGE_URL)
  await assertWalletLab({ label, pageUrl: PAGE_URL })
  await click('[data-testid="terms-continue"]')
  await approve('send')
  await page.waitForFunction(() => location.hash === '#/activity', { timeout: 300000 })
  const op = await page.evaluate(() => JSON.parse(localStorage.getItem('bridge.operations.v1') || '[]').at(-1))
  log('journal', JSON.stringify({ state: op?.state, hash: op?.hash, account: op?.account }))
  if (op?.state !== 'submitted' || !op.hash) throw new Error('journal did not record the send as submitted')
  let block = null
  for (let i = 0; i < 30 && !block; i++) {
    const r = await fetch(NODE_HTTP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ledger.getAccountBlockByHash', params: [op.hash] }) }).then((r) => r.json())
    block = r.result
    if (!block) await wait(2000)
  }
  if (!block) throw new Error(`block ${op.hash} not on the lab node`)
  log('on chain', JSON.stringify({ address: block.address, toAddress: block.toAddress, amount: block.amount, chain: block.chainIdentifier, momentum: block.confirmationDetail?.momentumHeight ?? null }))
  if (block.address !== INDEX3 || block.chainIdentifier !== CHAIN) throw new Error('block from the wrong account or chain')
  await page.waitForSelector('[data-testid="activity-row"][data-kind="wrap"]', { timeout: 120000 })
  await wait(1500)
  await page.screenshot({ path: `${out}/5-activity.png` })
  log('PASS', errors.length ? `page errors: ${errors.join(' | ').slice(0, 300)}` : 'no page errors')
} catch (e) {
  log('FAIL at', step, String(e.message || e).slice(0, 1500))
  for (const p of await browser.pages()) await p.screenshot({ path: `${out}/fail-${p.url().replace(/[^a-z0-9]+/gi, '_').slice(-40)}.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
