import fs from 'node:fs'
import http from 'node:http'
import puppeteer from 'puppeteer-core'
import { assertWalletLab, assertPageOrigin, createResultsDirectory, forwardEvmRead } from './lab-safety.mjs'
import { appAssetRoot, openAppAsset } from './app-assets.mjs'

const [label, appDir] = process.argv.slice(2)
const MNEMONIC = 'abstract affair idle position alien fluid board ordinary exist afraid chapter wood wood guide sun walnut crew perfect place firm poverty model side million'
const INDEX3 = 'z1qp3yph55qgresyytz83anynr2f4z39x2z3ej3e'
const NODE = 'ws://127.0.0.1:46998', NODE_HTTP = 'http://127.0.0.1:46997', CHAIN = 322
const PAGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:4174/'
const APP_PORT = Number(process.env.APP_PORT || 47110)
if (!Number.isSafeInteger(APP_PORT) || APP_PORT < 1 || APP_PORT > 65535) throw new Error('Invalid app lab port')
const assetRoot = appAssetRoot(appDir)
const EVM_USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Mobile Safari/537.36'
await assertWalletLab({ label, pageUrl: PAGE_URL })
const out = createResultsDirectory(label)
const log = (...a) => { const line = `${new Date().toISOString().slice(11, 19)} [${label}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(`${out}/log.txt`, line + '\n') }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const errors = []

const server = http.createServer((req, res) => {
  const asset = openAppAsset(assetRoot, req.url)
  if (!asset) { res.writeHead(404); res.end(); return }
  res.writeHead(200, { 'content-type': asset.type, 'content-length': asset.bytes, 'x-content-type-options': 'nosniff' })
  const stream = fs.createReadStream('', { fd: asset.fd, autoClose: true })
  res.once('close', () => stream.destroy())
  stream.on('error', () => res.destroy()).pipe(res)
})
await new Promise((resolve, reject) => {
  server.once('error', () => reject(new Error('App lab server could not bind')))
  server.listen(APP_PORT, '127.0.0.1', resolve)
})
const APP = `http://127.0.0.1:${APP_PORT}/index.html`

const browser = await puppeteer.launch({
  executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, pipe: true, protocolTimeout: 600_000,
  args: ['--no-sandbox', '--window-size=1280,900', '--screen-info={0,0 1920x1080}'],
}).catch((error) => { server.close(); throw error })
let step = 'start'
const textOf = (p) => p.evaluate(() => document.body.innerText)
const shot = (p, name) => p.screenshot({ path: `${out}/${name}.png` }).catch(() => {})
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
const typeInto = async (p, sel, value) => { await p.waitForSelector(sel, { visible: true, timeout: 15000 }); await p.$eval(sel, (e) => { e.focus(); e.select() }); await p.keyboard.press('Backspace'); await p.type(sel, value) }

try {
  step = 'onboard'
  const app = await browser.newPage()
  await app.setViewport({ width: 400, height: 800, isMobile: true, hasTouch: true })
  app.on('pageerror', (e) => log('app error:', String(e.message || e).slice(0, 200)))
  const route = async (hash) => { await app.evaluate((h) => { location.hash = h }, hash); await wait(1500) }
  await app.goto(APP, { waitUntil: 'networkidle2' }); await wait(2000)
  await clickText(app, /^Import a recovery phrase$/)
  await typeInto(app, 'textarea', MNEMONIC)
  await clickText(app, /^Continue$/)
  await typeInto(app, 'input[name=walletNameField]', 'lab')
  await typeInto(app, 'input[name=passwordField]', 'Lab-pass-2026!x')
  await typeInto(app, 'input[name=repeatPasswordField]', 'Lab-pass-2026!x')
  await clickText(app, /^Import wallet$/)
  for (let i = 0; i < 120 && !(await app.evaluate(() => location.hash.includes('/tabs/'))); i++) {
    if ((await textOf(app)).includes('Not now')) await clickText(app, /^Not now$/, 'button')
    await wait(500)
  }
  await wait(1500)
  log('imported')

  step = 'node'
  await route('/tabs/settings/change-node')
  await typeInto(app, 'input[placeholder^="wss://"]', NODE)
  await clickText(app, /^Add$/)
  await wait(1500)
  await clickText(app, new RegExp(`^${RegExp.escape(NODE)}$`))
  await wait(2500)
  await typeInto(app, 'input[placeholder^="Chain identifier"]', String(CHAIN))
  await clickText(app, /^Save$/)
  await wait(2500)
  log('node screen:', (await textOf(app)).replace(/\s+/g, ' ').slice(0, 160))

  step = 'account'
  await route('/tabs/change-address')
  for (let i = 0; i < 6; i++) {
    const n = await app.$$eval('.address-item-main', (e) => e.length)
    if (n > 3) break
    await clickText(app, /^Add address$/); await wait(1500)
  }
  await app.$$eval('.address-item-main', (e) => e[3].click())
  await wait(2000)
  if (!(await textOf(app)).includes(INDEX3.slice(0, 10))) throw new Error('index 3 not listed')
  await route('/tabs/dashboard')
  await app.waitForFunction(() => !!window.syriusAppLinks, { timeout: 20000 })
  await shot(app, '1-app-ready')
  log('app ready on account 4')

  step = 'page'
  const page = await browser.newPage()
  await page.setUserAgent(PHONE_UA)
  await page.setViewport({ width: 400, height: 860, isMobile: true, hasTouch: true })
  page.on('pageerror', (e) => errors.push(String(e.message || e)))
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
  await page.exposeFunction('__labEvmRequest', (json) => forwardEvmRead(json, page.url(), PAGE_URL))
  await page.evaluateOnNewDocument((evmAddress) => {
    window.__links = []
    navigation.addEventListener('navigate', (e) => {
      if (e.destination.url.startsWith('syrius:')) { window.__links.push(e.destination.url); e.preventDefault() }
    })
    const provider = {
      async request({ method, params }) {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [evmAddress]
        if (method === 'eth_chainId') return '0x7a69'
        if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
        if (method === 'wallet_watchAsset') return true
        const r = JSON.parse(await window.__labEvmRequest(JSON.stringify({ method, params: params ?? [] })))
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
  await page.waitForFunction(() => window.__bridge?.syrius.app === true, { timeout: 20000 })
  log('bridge in app mode', await page.evaluate(() => JSON.stringify(window.__bridge.syrius)))

  const click = async (sel) => {
    await page.waitForSelector(sel, { visible: true, timeout: 60000 })
    await page.waitForFunction((s) => { const e = document.querySelector(s); return !!e && !e.disabled }, { timeout: 60000 }, sel)
    await wait(400)
    await page.click(sel)
  }

  const roundTrip = async (what, approve) => {
    await page.waitForFunction(() => window.__links.length > 0, { timeout: 30000 })
    const link = await page.evaluate(() => window.__links.shift())
    const u = new URL(link)
    log(`${what} link:`, u.searchParams.get('method'), 'callback', u.searchParams.get('callback'))
    const opened = browser.waitForTarget((t) => t.type() === 'page' && t.url().includes('syrius=1'), { timeout: 720000 })
    await app.bringToFront()
    if (app.url().includes('/password')) {
      log(`${what}: the app had locked; unlocking`)
      await typeInto(app, 'input[type=password]', 'Lab-pass-2026!x')
      await clickText(app, /^Unlock$/)
      await app.waitForFunction(() => location.hash.includes('/tabs/'), { timeout: 60000 })
      await wait(1500)
    }
    await app.evaluate((l) => window.syriusAppLinks.receive(l), link)
    if (approve) {
      await app.waitForFunction(() => location.hash.startsWith('#/site-integration'), { timeout: 30000 })
      for (let i = 0; i < 60; i++) {
        const ready = await app.evaluate(() => [...document.querySelectorAll('button')].some((b) => /^(Connect|Approve|Confirm|Sign|Send|Allow)/.test(b.innerText.trim()) && !b.disabled))
        if (ready) break
        await wait(1000)
      }
      await shot(app, `2-${what}-asked`)
      log(`${what} asked:`, (await textOf(app)).replace(/\s+/g, ' ').slice(0, 200))
      if (what === 'send') {
        assertPageOrigin(page.url(), PAGE_URL)
        await assertWalletLab({ label, pageUrl: PAGE_URL })
      }
      await clickText(app, /^(Connect|Approve|Confirm|Sign|Send|Allow)/, 'button')
    }
    const asked = Date.now()
    const t = await opened
    log(`${what} answered after ${Math.round((Date.now() - asked) / 1000)} s`)
    const answer = new URL(t.url())
    log(`${what} answer:`, answer.searchParams.has('result') ? `result ${Buffer.from(answer.searchParams.get('result'), 'base64url').toString().slice(0, 120)}` : `error ${Buffer.from(answer.searchParams.get('error') || '', 'base64url').toString()}`)
    const tab = await t.page()
    await tab.waitForFunction(() => !!window.__bridge && !location.search.includes('syrius='), { timeout: 60000 })
    await wait(1500)
    await shot(tab, `3-${what}-callback-tab`)
    await tab.close()
    await page.bringToFront()
  }

  step = 'connect'
  await click('[data-testid="wallet-menu"]')
  await click('[data-testid="wallet-zenon-connect"]')
  await roundTrip('connect', true)
  await page.waitForFunction((a) => window.__bridge.syrius.address === a, { timeout: 30000 }, INDEX3)
  log('first tab connected', await page.evaluate(() => JSON.stringify(window.__bridge.syrius)))
  await page.keyboard.press('Escape')
  await page.evaluate(() => document.querySelector('[data-testid="wallet-backdrop"]')?.click())
  await wait(500)

  step = 'chain'
  await page.waitForSelector('[data-testid="app-network"] button', { visible: true, timeout: 20000 })
  await shot(page, '4-check-network-banner')
  await page.click('[data-testid="app-network"] button')
  await roundTrip('chainId', false)
  await page.waitForFunction((c) => window.__bridge.syrius.chainId === c, { timeout: 30000 }, CHAIN)
  log('first tab chain', await page.evaluate(() => window.__bridge.syrius.chainId))

  step = 'evm'
  await click('[data-testid="wallet-menu"]')
  await click('[data-testid="wallet-evm-connect"]')
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid="wallet-option"]')].some((b) => b.textContent?.includes('Lab Wallet')))
  await click('[data-testid="wallet-option"]')
  await page.waitForFunction(() => !!window.__bridge.evm.account)
  await page.waitForFunction(() => !document.querySelector('[role="dialog"]'))

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
  await roundTrip('send', true)
  let op = null
  for (let i = 0; i < 30; i++) {
    op = await page.evaluate(() => JSON.parse(localStorage.getItem('bridge.operations.v1') || '[]').at(-1))
    if (op?.state === 'submitted' && op.hash) break
    await wait(1000)
  }
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
  await page.goto(`${PAGE_URL}#/activity`, { waitUntil: 'domcontentloaded' })
  await page.waitForSelector('[data-testid="activity-row"][data-kind="wrap"]', { timeout: 120000 })
  await wait(1500)
  await shot(page, '5-activity')
  log('PASS', errors.length ? `page errors: ${errors.join(' | ').slice(0, 300)}` : 'no page errors')
} catch (e) {
  log('FAIL at', step, String(e.message || e).slice(0, 1500))
  for (const p of await browser.pages()) await p.screenshot({ path: `${out}/fail-${p.url().replace(/[^a-z0-9]+/gi, '_').slice(-40)}.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
  server.close()
}
