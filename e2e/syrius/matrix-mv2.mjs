import fs from 'node:fs'
import puppeteer from 'puppeteer-core'
import { assertWalletLab, assertPageOrigin, createResultsDirectory, forwardEvmRead } from './lab-safety.mjs'

const [label, extDir] = process.argv.slice(2)
if (!extDir) throw new Error('Set an isolated extension directory')
const CHROME = process.env.CHROME_MV2_PATH
if (!CHROME) throw new Error('set CHROME_MV2_PATH to a Chrome that still loads MV2 extensions (Chrome for Testing 130)')
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
  executablePath: CHROME, headless: true, protocolTimeout: 600_000, ignoreDefaultArgs: ['--disable-extensions'],
  args: ['--no-sandbox', `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--window-size=1280,900', '--screen-info={0,0 1920x1080}',
    '--disable-features=ExtensionManifestV2Disabled,ExtensionManifestV2Unsupported,ExtensionManifestV2DeprecationWarning'],
})
let step = 'start'
const textOf = (p) => p.evaluate(() => document.body ? document.body.innerText : '')
const clickText = async (p, text, exact = true) => {
  const ok = await p.evaluate((t, exact) => {
    const all = [...document.querySelectorAll('button,a,div,span,p,label,li,h4,input[type=submit]')]
    const m = (e) => { const v = (e.innerText || e.value || '').trim(); return exact ? v === t : v.includes(t) }
    const el = all.filter(m).pop(); if (!el) return false; el.scrollIntoView(); el.click(); return true
  }, text, exact)
  if (!ok) throw new Error(`nothing reading ${text} on ${p.url()}:\n${(await textOf(p)).slice(0, 500)}`)
}
const fill = (p, sel, value) => p.evaluate((sel, value) => {
  const el = document.querySelector(sel); if (!el) return false; el.focus()
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true
}, sel, value)
const until = async (p, fn, ms = 30000, what = 'condition') => { for (let t = 0; t < ms; t += 500) { if (await fn().catch(() => false)) return; await wait(500) } throw new Error(`timed out waiting for ${what} on ${p.url()}:\n${(await textOf(p).catch(() => '')).slice(0, 500)}`) }

try {
  const bg = await browser.waitForTarget((t) => t.url().startsWith('chrome-extension://'), { timeout: 15000 })
  const ext = `chrome-extension://${new URL(bg.url()).host}`
  const popup = await browser.newPage()
  await popup.setViewport({ width: 400, height: 640 })
  step = 'onboard'
  await popup.goto(`${ext}/popup.html`, { waitUntil: 'networkidle2' })
  await until(popup, async () => (await textOf(popup)).includes('Import recovery phrase'), 20000, 'onboarding')
  await clickText(popup, 'Import recovery phrase'); await wait(800)
  await fill(popup, 'textarea', MNEMONIC); await wait(300); await clickText(popup, 'Import')
  await until(popup, () => popup.evaluate(() => !!document.querySelector('input[name=walletNameField]')), 10000, 'name form')
  await fill(popup, 'input[name=walletNameField]', 'lab'); await fill(popup, 'input[name=passwordField]', 'Lab-pass-2026!x'); await fill(popup, 'input[name=repeatPasswordField]', 'Lab-pass-2026!x')
  await popup.evaluate(() => document.querySelector('input[name=submitButton]').click())
  await until(popup, async () => (await textOf(popup)).includes('Done'), 60000, 'import done')
  await clickText(popup, 'Done')
  log('imported')

  step = 'node'
  await until(popup, () => popup.evaluate(() => !!document.querySelector('input[name=nodeToBeAddedField]')), 20000, 'node selection')
  await fill(popup, 'input[name=nodeToBeAddedField]', NODE); await wait(300)
  await popup.evaluate(() => document.querySelector('input[value="Add node"]').click())
  await until(popup, async () => (await textOf(popup)).includes(NODE), 10000, 'node listed')
  await clickText(popup, NODE); await wait(500)
  await clickText(popup, 'Save')
  await until(popup, async () => popup.url().includes('/password'), 30000, 'password page')
  log('node selected')

  step = 'unlock'
  await wait(1000)
  await clickText(popup, 'lab'); await wait(600); await clickText(popup, 'lab'); await wait(400)
  await fill(popup, 'input[name=passwordField]', 'Lab-pass-2026!x')
  await popup.evaluate(() => document.querySelector('input[name=submitButton]').click())
  await until(popup, async () => !popup.url().includes('/password'), 60000, 'unlock')
  await wait(2500)
  log('unlocked at', popup.url())

  const spa = (path) => popup.evaluate((path) => { history.pushState({}, '', path); dispatchEvent(new PopStateEvent('popstate', { state: {} })) }, path)
  step = 'chain'
  await spa('/tabs/settings/change-chainId'); await wait(1500)
  await fill(popup, 'input[name=chainIdToBeAddedField]', String(CHAIN)); await wait(300)
  await popup.evaluate(() => document.querySelector('input[value="Add chainId"]').click())
  await until(popup, () => popup.evaluate((c) => [...document.querySelectorAll('*')].some((e) => e.children.length === 0 && e.textContent.trim() === c), String(CHAIN)), 10000, 'chain listed')
  await clickText(popup, String(CHAIN)); await wait(1500)
  log('chain screen:', (await textOf(popup)).replace(/\s+/g, ' ').slice(0, 200))

  step = 'account'
  await spa('/tabs/change-address'); await wait(2000)
  for (let i = 0; i < 6 && !(await textOf(popup)).includes(INDEX3.slice(0, 12)); i++) { await clickText(popup, 'Add address'); await wait(2500) }
  await clickText(popup, INDEX3.slice(0, 12), false); await wait(1500)
  await popup.screenshot({ path: `${out}/1-account.png` })
  log('account selected')

  step = 'page'
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 900 })
  page.on('pageerror', (e) => errors.push(String(e.message || e)))
  page.on('console', (m) => m.type() === 'error' && !/Content Security Policy/.test(m.text()) && errors.push(m.text()))
  await page.exposeFunction('__labEvmRequest', (json) => forwardEvmRead(json, page.url(), PAGE_URL))
  await page.evaluateOnNewDocument((evmAddress) => {
    const provider = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [evmAddress]
        if (method === 'eth_chainId') return '0x7a69'
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
        const r = JSON.parse(await window.__labEvmRequest(JSON.stringify({ method, params: params ?? [] })))
        if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code })
        return r.result
      }, on() {}, removeListener() {},
    }
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'lab-evm', name: 'Lab Wallet', icon: '', rdns: 'lab.wallet' }, provider }) }))
    window.addEventListener('eip6963:requestProvider', announce); announce()
  }, EVM_USER)
  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  assertPageOrigin(page.url(), PAGE_URL)
  await page.waitForFunction(() => document.body.innerText.includes('Anvil'), { timeout: 90000 })
  await page.waitForFunction(() => window.__bridge?.syrius.present === true, { timeout: 20000 })
  log('detected', await page.evaluate(() => JSON.stringify({ zenon: Object.keys(window.zenon || {}), mark: [...document.querySelectorAll('script:not([src])')].some((e) => e.textContent.includes('isSyriusExtension')) })))

  const approve = async (what) => {
    const t = await browser.waitForTarget((t) => t.type() === 'page' && t.url().startsWith(ext) && !t.url().includes('/tabs/'), { timeout: 90000 })
    const w = await t.page()
    await until(w, async () => (await textOf(w)).includes('Yes'), 60000, `${what} prompt`)
    await w.screenshot({ path: `${out}/2-${what}-asked.png` }).catch(() => {})
    log(`${what} window:`, (await textOf(w)).replace(/\s+/g, ' ').slice(0, 300))
    w.on('console', (m) => log(`${what} console:`, m.type(), m.text().slice(0, 200)))
    w.on('pageerror', (e) => log(`${what} error:`, String(e.message || e).slice(0, 200)))
    const yes = await w.$$('button, input[type=submit]').then(async (bs) => { for (const b of bs) if (((await b.evaluate((e) => (e.innerText || e.value || '').trim())) === 'Yes')) return b })
    if (what === 'send') {
      assertPageOrigin(page.url(), PAGE_URL)
      await assertWalletLab({ label, pageUrl: PAGE_URL })
    }
    if (yes) await yes.click(); else await clickText(w, 'Yes')
    for (let t = 0; t < 600; t += 30) {
      const txt = (await textOf(w).catch(() => '(closed)')).replace(/\s+/g, ' ')
      if (txt.includes('Done') || txt === '(closed)') break
      if (t % 60 === 0) { log(`${what} t+${t}s:`, txt.slice(0, 160)); await w.screenshot({ path: `${out}/2-${what}-t${t}.png` }).catch(() => {}) }
      await wait(30000)
    }
    log(`${what} approved:`, (await textOf(w).catch(() => '(closed)')).replace(/\s+/g, ' ').slice(0, 200))
    await w.close().catch(() => {})
  }
  const click = async (sel) => { await page.waitForSelector(sel, { visible: true, timeout: 60000 }); await page.waitForFunction((s) => { const e = document.querySelector(s); return !!e && !e.disabled }, { timeout: 60000 }, sel); await wait(400); await page.click(sel) }

  step = 'connect'
  await click('[data-testid="wallet-menu"]')
  await click('[data-testid="wallet-zenon-connect"]')
  await approve('connect')
  await page.waitForFunction((a) => window.__bridge.syrius.address === a, { timeout: 60000 }, INDEX3)
  log('connected', await page.evaluate(() => JSON.stringify(window.__bridge.syrius)))
  await page.evaluate(() => document.querySelector('[data-testid="wallet-backdrop"]')?.click()); await wait(500)
  await click('[data-testid="wallet-menu"]')
  await click('[data-testid="wallet-evm-connect"]')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="wallet-option"]')].some((b) => b.textContent?.includes('Lab Wallet')))
  await click('[data-testid="wallet-option"]')
  await page.waitForFunction(() => !!window.__bridge.evm.account)
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))

  step = 'wrap'
  await page.type('input[aria-label="Amount"]', '2')
  await page.waitForFunction(() => document.querySelector('[data-testid="bridge-action"]')?.textContent?.includes('Bridge to Anvil'), { timeout: 60000 })
  await click('[data-testid="bridge-action"]')
  await click('[data-testid="terms-all"]')
  assertPageOrigin(page.url(), PAGE_URL)
  await assertWalletLab({ label, pageUrl: PAGE_URL })
  await click('[data-testid="terms-continue"]')
  await approve('send')
  await page.waitForFunction(() => location.hash === '#/activity', { timeout: 660000 })
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
  await page.screenshot({ path: `${out}/3-activity.png` })
  log('PASS', errors.length ? `page errors: ${errors.join(' | ').slice(0, 300)}` : 'no page errors')
} catch (e) {
  log('FAIL at', step, String(e.message || e).slice(0, 1500))
  for (const p of await browser.pages()) await p.screenshot({ path: `${out}/fail-${p.url().replace(/[^a-z0-9]+/gi, '_').slice(-40)}.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
