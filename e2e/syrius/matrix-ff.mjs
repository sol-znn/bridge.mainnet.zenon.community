import fs from 'node:fs'
import path from 'node:path'
import { launchFirefox, session } from './marionette.mjs'
import { assertWalletLab, assertPageOrigin, createResultsDirectory, EVM_READ_METHODS } from './lab-safety.mjs'

const [label, extDir, addonId] = process.argv.slice(2)
if (!extDir || !addonId) throw new Error('Set an isolated extension directory and add-on ID')
const MNEMONIC = 'abstract affair idle position alien fluid board ordinary exist afraid chapter wood wood guide sun walnut crew perfect place firm poverty model side million'
const INDEX3 = 'z1qp3yph55qgresyytz83anynr2f4z39x2z3ej3e'
const NODE = 'ws://127.0.0.1:46998', NODE_HTTP = 'http://127.0.0.1:46997', CHAIN = 322
const PAGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:4174/'
const EVM_USER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
const UUID = '5f0c9a39-1b7e-4a7a-9d2e-0b9f1e7c3a11'
await assertWalletLab({ label, pageUrl: PAGE_URL })
const out = createResultsDirectory(label)
const log = (...a) => { const line = `[${label}] ${a.join(' ')}`; console.log(line); fs.appendFileSync(`${out}/log.txt`, line + '\n') }
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

const { proc, client } = await launchFirefox({ profile: path.join(out, 'firefox-profile'), prefs: { 'extensions.webextensions.uuids': JSON.stringify({ [addonId]: UUID }), 'dom.disable_open_during_load': false } })
const s = session(client)
let step = 'start'
const clickText = async (text, exact = true) => {
  const ok = await s.exec(`const t = arguments[0], exact = arguments[1]; const all = [...document.querySelectorAll('button,a,div,span,p,label,li,h4,input[type=submit]')];
    const m = (e) => { const v = (e.innerText || e.value || '').trim(); return exact ? v === t : v.includes(t) };
    const el = all.filter(m).pop(); if (!el) return false; el.scrollIntoView(); el.click(); return true`, [text, exact])
  if (!ok) throw new Error(`nothing reading ${text} on ${await s.url()}:\n${String(await s.text()).slice(0, 500)}`)
}
const fill = (sel, value) => s.exec(`const el = document.querySelector(arguments[0]); if (!el) return false; el.focus();
  const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set; set.call(el, arguments[1]);
  el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true`, [sel, value])
const until = async (fn, ms = 30000, what = 'condition') => { for (let t = 0; t < ms; t += 500) { if (await fn().catch(() => false)) return; await wait(500) } throw new Error(`timed out waiting for ${what} on ${await s.url()}:\n${String(await s.text()).slice(0, 500)}`) }
const spa = (path) => s.exec(`history.pushState({}, '', arguments[0]); dispatchEvent(new PopStateEvent('popstate', { state: {} })); return true`, [path])

try {
  await s.start()
  const homeHandle = await s.handle()
  await s.install(extDir)
  step = 'onboard'
  await s.context('chrome')
  await s.exec('const w = Services.wm.getMostRecentWindow("navigator:browser"); const t = w.gBrowser.addTab(arguments[0], { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); w.gBrowser.selectedTab = t; return true', [`moz-extension://${UUID}/popup.html`])
  await s.context('content')
  await wait(1500)
  const popupHandle = (await s.handles()).at(-1)
  await s.switchTo(popupHandle)
  await until(async () => String(await s.text()).includes('Import recovery phrase'), 20000, 'onboarding')
  await clickText('Import recovery phrase')
  await wait(800); await fill('textarea', MNEMONIC); await wait(300); await clickText('Import')
  await until(async () => s.exec('return !!document.querySelector("input[name=walletNameField]")'), 10000, 'name form')
  await fill('input[name=walletNameField]', 'lab'); await fill('input[name=passwordField]', 'Lab-pass-2026!x'); await fill('input[name=repeatPasswordField]', 'Lab-pass-2026!x')
  await s.exec('document.querySelector("input[name=submitButton]").click(); return 1')
  await until(async () => String(await s.text()).includes('Done'), 60000, 'import done')
  await clickText('Done')
  log('imported')

  step = 'node'
  await until(async () => s.exec('return !!document.querySelector("input[name=nodeToBeAddedField]")'), 20000, 'node selection')
  await fill('input[name=nodeToBeAddedField]', NODE); await wait(300)
  await s.exec('document.querySelector("input[value=\\"Add node\\"]").click(); return 1')
  await until(async () => String(await s.text()).includes(NODE), 10000, 'node listed')
  await clickText(NODE); await wait(500)
  await clickText('Save')
  await until(async () => (await s.url()).includes('/password'), 30000, 'password page')
  log('node selected')

  step = 'unlock'
  await wait(1000)
  await clickText('lab'); await wait(600)
  await clickText('lab'); await wait(400)
  await fill('input[name=passwordField]', 'Lab-pass-2026!x')
  await s.exec('document.querySelector("input[name=submitButton]").click(); return 1')
  await until(async () => !(await s.url()).includes('/password'), 60000, 'unlock')
  await wait(2500)
  await s.shot(`${out}/1-unlocked.png`)
  log('unlocked at', await s.url())

  step = 'chain'
  await spa('/tabs/settings/change-chainId'); await wait(1500)
  await fill('input[name=chainIdToBeAddedField]', String(CHAIN)); await wait(300)
  await s.exec('document.querySelector("input[value=\\"Add chainId\\"]").click(); return 1')
  await until(async () => s.exec(`return [...document.querySelectorAll('*')].some((e) => e.children.length === 0 && e.textContent.trim() === arguments[0])`, [String(CHAIN)]), 10000, 'chain listed')
  await clickText(String(CHAIN)); await wait(1500)
  await s.shot(`${out}/2-chain.png`)
  log('chain screen:', String(await s.text()).replace(/\s+/g, ' ').slice(0, 200))

  step = 'account'
  await spa('/tabs/change-address'); await wait(2000)
  for (let i = 0; i < 6 && !String(await s.text()).includes(INDEX3.slice(0, 12)); i++) { await clickText('Add address'); await wait(2500) }
  await clickText(INDEX3.slice(0, 12), false); await wait(1500)
  await s.shot(`${out}/3-account.png`)
  log('account screen:', String(await s.text()).replace(/\s+/g, ' ').slice(0, 300))

  step = 'page'
  const pageHandle = await s.newTab()
  await s.switchTo(pageHandle)
  await s.go(PAGE_URL)
  assertPageOrigin(await s.url(), PAGE_URL)
  await s.exec(`const evmAddress = arguments[0], expectedOrigin = arguments[1], readMethods = arguments[2];
    const rpc = async (method, params) => {
      const response = await fetch('http://127.0.0.1:46545', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      if (response.status !== 200 || !response.body) throw new Error('Isolated wallet lab refused')
      const reader = response.body.getReader(), chunks = []; let size = 0
      try { for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 16384) throw new Error('Isolated wallet lab refused'); chunks.push(value) } }
      finally { await reader.cancel() }
      const bytes = new Uint8Array(size); let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
      const reply = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      if (reply?.jsonrpc !== '2.0' || reply.id !== 1 || Object.hasOwn(reply, 'result') === Object.hasOwn(reply, 'error')) throw new Error('Isolated wallet lab refused')
      return reply
    }
    const provider = { async request({ method, params }) {
      if (location.origin !== expectedOrigin) throw new Error('Isolated wallet lab refused')
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [evmAddress]
      if (method === 'eth_chainId') return '0x7a69'
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
      if (!readMethods.includes(method) || !Array.isArray(params ?? [])) throw new Error('Isolated wallet lab refused')
      if ((await rpc('eth_chainId', [])).result !== '0x7a69') throw new Error('Isolated wallet lab refused')
      const r = await rpc(method, params ?? [])
      if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code })
      return r.result }, on() {}, removeListener() {} }
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info: { uuid: 'lab-evm', name: 'Lab Wallet', icon: '', rdns: 'lab.wallet' }, provider }) }))
    window.addEventListener('eip6963:requestProvider', announce); announce(); return true`, [EVM_USER, new URL(PAGE_URL).origin, EVM_READ_METHODS])
  await until(async () => String(await s.text()).includes('Anvil'), 90000, 'bridge page')
  await until(async () => s.exec('return window.__bridge?.syrius.present === true'), 20000, 'Syrius detected')
  log('detected', await s.exec('return JSON.stringify({ zenon: Object.keys(window.zenon || {}), mark: [...document.querySelectorAll("script:not([src])")].some((e) => e.textContent.includes("isSyriusExtension")) })'))

  const approve = async (what) => {
    const known = [pageHandle, popupHandle, homeHandle]
    await until(async () => (await s.handles()).some((h) => !known.includes(h)), 90000, `${what} window`).catch(async (e) => {
      const hs = await s.handles(); const info = []
      for (const h of hs) { await s.switchTo(h); info.push(`${h}=${await s.url()} :: ${String(await s.text()).replace(/\s+/g, ' ').slice(0, 160)}`) }
      await s.switchTo(pageHandle)
      throw new Error(`${e.message.split('\n')[0]}\n${info.join('\n')}\nsyrius: ${await s.exec('return JSON.stringify(window.__bridge.syrius)')}`)
    })
    const w = (await s.handles()).find((h) => !known.includes(h))
    await s.switchTo(w)
    await until(async () => String(await s.text()).includes('Yes'), 60000, `${what} prompt`)
    await s.shot(`${out}/4-${what}-asked.png`)
    log(`${what} window:`, String(await s.text()).replace(/\s+/g, ' ').slice(0, 300))
    if (what === 'send') {
      await s.switchTo(pageHandle)
      assertPageOrigin(await s.url(), PAGE_URL)
      await assertWalletLab({ label, pageUrl: PAGE_URL })
      await s.switchTo(w)
    }
    await clickText('Yes')
    await until(async () => String(await s.text()).includes('Done'), 120000, `${what} done`).catch(() => {})
    log(`${what} approved:`, String(await s.text()).replace(/\s+/g, ' ').slice(0, 200))
    await s.switchTo(pageHandle)
  }

  step = 'connect'
  await s.exec('document.querySelector("[data-testid=wallet-menu]").click(); return 1'); await wait(600)
  await s.exec('document.querySelector("[data-testid=wallet-zenon-connect]").click(); return 1')
  await approve('connect')
  await until(async () => s.exec('return window.__bridge.syrius.address === arguments[0]', [INDEX3]), 60000, 'connected address')
  log('connected', await s.exec('return JSON.stringify(window.__bridge.syrius)'))
  await s.exec('document.querySelector("[data-testid=wallet-backdrop]")?.click(); return 1'); await wait(500)
  await s.exec('document.querySelector("[data-testid=wallet-menu]").click(); return 1'); await wait(600)
  await s.exec('document.querySelector("[data-testid=wallet-evm-connect]").click(); return 1'); await wait(800)
  await s.exec('document.querySelector("[data-testid=wallet-option]").click(); return 1')
  await until(async () => s.exec('return !!window.__bridge.evm.account'), 20000, 'EVM wallet')
  await until(async () => s.exec('return !document.querySelector("[role=dialog]")'), 10000, 'picker closed')

  step = 'wrap'
  await s.exec(`const el = document.querySelector('input[aria-label="Amount"]'); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '2'); el.dispatchEvent(new Event('input', { bubbles: true })); return 1`)
  await until(async () => s.exec('return document.querySelector("[data-testid=bridge-action]")?.textContent.includes("Bridge to Anvil") && !document.querySelector("[data-testid=bridge-action]").disabled'), 60000, 'bridge action')
  await s.exec('document.querySelector("[data-testid=bridge-action]").click(); return 1'); await wait(800)
  await s.exec('document.querySelector("[data-testid=terms-all]").click(); return 1'); await wait(300)
  assertPageOrigin(await s.url(), PAGE_URL)
  await assertWalletLab({ label, pageUrl: PAGE_URL })
  await s.exec('document.querySelector("[data-testid=terms-continue]").click(); return 1')
  await approve('send')
  await until(async () => s.exec('return location.hash === "#/activity"'), 300000, 'activity')
  const op = JSON.parse(await s.exec('return JSON.stringify(JSON.parse(localStorage.getItem("bridge.operations.v1") || "[]").at(-1))'))
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
  await wait(3000)
  await s.shot(`${out}/5-activity.png`)
  log('PASS')
} catch (e) {
  log('FAIL at', step, String(e.message || e).slice(0, 1500))
  await s.shot(`${out}/fail.png`).catch(() => {})
  process.exitCode = 1
} finally {
  client.close(); proc.kill()
}
