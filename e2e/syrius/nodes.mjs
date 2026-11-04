import puppeteer from 'puppeteer-core'
import { validateBridgeUrl, assertPageOrigin, createResultsDirectory } from './lab-safety.mjs'

const PAGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:4174/'
const MINE = 'ws://localhost:46998'
validateBridgeUrl(PAGE_URL)
const out = createResultsDirectory('nodes')
const log = (...a) => console.log('[nodes]', ...a)
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const browser = await puppeteer.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] })
const errors = []
let step = 'start'
try {
  const page = await browser.newPage()
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true })
  page.on('pageerror', (e) => errors.push(String(e.message || e)))
  const state = () => page.evaluate(() => ({ source: window.__bridge.node.source, url: window.__bridge.node.url, chainId: window.__bridge.node.chainId }))
  const open = async () => {
    for (let i = 0; i < 3 && !(await page.$('[data-testid="node-toggle"]')); i++) {
      await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), { timeout: 10000 })
      await page.click('[data-testid="wallet-menu"]')
      await page.waitForSelector('[data-testid="node-toggle"]', { visible: true, timeout: 3000 }).catch(() => {})
    }
    if (!(await page.$('[data-testid="node-add"]'))) { await page.click('[data-testid="node-toggle"]'); await wait(400) }
  }
  const add = async (text) => {
    await page.$eval('[data-testid="node-add"] input', (e) => { e.focus(); e.select() })
    await page.keyboard.press('Backspace')
    await page.type('[data-testid="node-add"] input', text)
    await page.click('[data-testid="node-add"] button')
  }
  const problem = () => page.$eval('[data-testid="node-problem"]', (e) => e.textContent.trim()).catch(() => '')

  await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded' })
  assertPageOrigin(page.url(), PAGE_URL)
  await page.waitForFunction(() => window.__bridge?.node.chainId, { timeout: 60000 })
  const start = await state()
  log('default', JSON.stringify(start))
  if (start.source !== 'default') throw new Error('not on the default node')

  step = 'refuse'
  await open()
  await add('ws://node.example.com:35998')
  await wait(300)
  log('plain ws remote:', await problem())
  if ((await problem()) !== 'Use wss:// for a remote node') throw new Error('plain ws remote not refused')
  await add('not a node')
  await wait(300)
  log('garbage:', await problem())
  if ((await problem()) !== 'Not a node address') throw new Error('garbage not refused')

  step = 'unreachable'
  await add('ws://localhost:1')
  await page.waitForFunction(() => document.querySelector('[data-testid="node-problem"]')?.textContent.includes('unreachable'), { timeout: 20000 })
  log('dead port:', await problem())

  step = 'add'
  await add(MINE)
  await page.waitForSelector('[data-testid="node-confirm"]', { visible: true, timeout: 20000 })
  log('confirm asks:', await page.$eval('[data-testid="node-network"]', (e) => e.textContent.trim()))
  await wait(900); await page.screenshot({ path: `${out}/1-confirm.png` })
  await page.click('[data-testid="node-confirm"]')
  await page.waitForFunction((u) => window.__bridge.node.source === 'custom' && window.__bridge.node.url === u, { timeout: 20000 }, MINE)
  log('using', JSON.stringify(await state()))
  await open()
  await wait(900); await page.screenshot({ path: `${out}/2-menu.png` })

  step = 'reload'
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.waitForFunction((u) => window.__bridge?.node.source === 'custom' && window.__bridge.node.url === u, { timeout: 30000 }, MINE)
  log('after reload', JSON.stringify(await state()))

  step = 'default'
  await open()
  await page.click('[data-testid="node-default"]')
  await page.waitForFunction(() => window.__bridge.node.source === 'default', { timeout: 20000 })
  log('back to default', JSON.stringify(await state()))
  step = 'pick'
  await page.click('[data-testid="node-custom"] .node-pick')
  await page.waitForFunction((u) => window.__bridge.node.source === 'custom' && window.__bridge.node.url === u, { timeout: 20000 }, MINE)
  log('picked from the list without asking again', JSON.stringify(await state()))

  step = 'remove'
  await page.click('[data-testid="node-custom"] button[aria-label^="Remove"]')
  await page.waitForFunction(() => window.__bridge.node.source === 'default' && !document.querySelector('[data-testid="node-custom"]'), { timeout: 20000 })
  log('removed', JSON.stringify(await state()))
  const stored = await page.evaluate(() => [localStorage.getItem('bridge.nodes'), localStorage.getItem('bridge.node.custom')])
  log('storage', JSON.stringify(stored))
  log('PASS', errors.length ? `errors: ${errors.join(' | ')}` : 'no page errors')
} catch (e) {
  log('FAIL at', step, String(e.message || e).slice(0, 800))
  for (const p of await browser.pages()) await p.screenshot({ path: `${out}/fail.png` }).catch(() => {})
  process.exitCode = 1
} finally {
  await browser.close()
}
