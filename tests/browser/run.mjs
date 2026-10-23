// Actual Vue components with offline providers. No production RPC or wallet.
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import puppeteer from 'puppeteer-core'
import { createServer } from 'vite'
if (!process.env.CHROME_PATH) throw new Error('Set CHROME_PATH to a compatible Chromium executable')
const server = await createServer({ envDir: false, cacheDir: process.env.QUALIFICATION_CACHE_DIR, server: { host: '127.0.0.1', port: 5195, strictPort: true }, logLevel: 'error' })
await server.listen()
let browser
const git = (args) => execFileSync('git', args).toString().trim()
const report = { mode: 'offline Vue component qualification', startedAt: new Date().toISOString(),
  sourceCommit: git(['rev-parse','HEAD']), sourceTree: git(['rev-parse','HEAD^{tree}']),
  sourceDirty: git(['status','--porcelain']).length > 0,
  lockfileHash: createHash('sha256').update(fs.readFileSync('package-lock.json')).digest('hex'),
  browserVersion: '', checks: [], errors: [] }
const resultsDir = process.env.BROWSER_RESULTS_DIR || '.browser-results'
fs.mkdirSync(resultsDir, { recursive: true })
try {
  browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH, userDataDir: process.env.BROWSER_PROFILE_DIR, headless: true })
  report.browserVersion = await browser.version()
  if (process.env.EXPECTED_BROWSER_VERSION) assert(report.browserVersion.endsWith(process.env.EXPECTED_BROWSER_VERSION), 'Browser version differs from qualification pin')
  const page = await browser.newPage()
  page.on('pageerror', (e) => report.errors.push(String(e)))
  await page.setRequestInterception(true)
  page.on('request', async (r) => {
    if(r.url()==='http://127.0.0.1:5195/fixture-rpc') {
      const body=await page.evaluate(async(json)=>{
        const raw=JSON.parse(json)
        const reply=async(q)=>{try{return {jsonrpc:'2.0',id:q.id,result:await window.__fixture.provider.request(q)}}catch(error){return {jsonrpc:'2.0',id:q.id,error:{code:-32000,message:error.message}}}}
        return JSON.stringify(Array.isArray(raw)?await Promise.all(raw.map(reply)):await reply(raw),(_key,value)=>typeof value==='bigint'?value.toString():value)
      },r.postData())
      await r.respond({status:200,contentType:'application/json',body})
    }
    else if (r.url().startsWith('http://127.0.0.1:5195/') || r.url().startsWith('data:')) void r.continue()
    else { report.errors.push('Unexpected outbound request'); void r.abort() }
  })
  const fresh = async () => { await page.goto('http://127.0.0.1:5195/tests/browser/harness.html'); await page.waitForSelector('input[aria-label="Amount"]') }
  const input = (selector, value) => page.$eval(selector, (e, v) => { e.value = v; e.dispatchEvent(new Event('input', { bubbles: true })) }, value)
  const amount = (v) => input('input[aria-label="Amount"]', v)
  const editRecipient = async () => {await page.click('[data-testid="bridge-advanced"]');await page.click('[data-testid="custom-recipient"]')}
  const action = () => page.$eval('[data-testid="bridge-action"]', (e) => ({ disabled: e.disabled, label: e.textContent.trim() }))
  const check = (name) => report.checks.push({ name })
  await fresh()
  for (const theme of ['dark', 'light']) {
    await page.evaluate((v) => document.documentElement.setAttribute('data-theme', v), theme)
    for (const width of [320, 375, 768, 1024, 1440]) {
      await page.setViewport({ width, height: 900 })
      for (const route of ['', 'activity', 'liquidity', 'stats', 'affiliate']) {
        await page.evaluate((v) => { location.hash = '#/' + v }, route)
        await page.waitForFunction((v) => document.querySelector('h1')?.textContent?.trim() === v, {}, route ? route[0].toUpperCase() + route.slice(1) : 'Bridge')
        const size = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }))
        assert(size.scrollWidth <= size.width, `Overflow: ${theme}/${width}/${route || 'bridge'}`)
        report.checks.push({ name: 'responsive layout', theme, route: route || 'bridge', ...size })
      }
    }
  }
  await fresh(); await page.setViewport({ width: 768, height: 900 });await page.waitForFunction(()=>Number(getComputedStyle(document.querySelector('main section')).opacity)>=0.99); await page.screenshot({ path: `${resultsDir}/tablet.png`, fullPage: true })
  await page.setViewport({ width: 375, height: 900 }); await page.screenshot({ path: `${resultsDir}/mobile.png`, fullPage: true })
  await amount('1,000'); assert((await action()).disabled); check('ambiguous amount blocked')
  await amount('2'); await editRecipient()
  await input('input[aria-label="Recipient"]', '0x' + '00'.repeat(20)); assert((await action()).disabled)
  await fresh(); await page.click('[data-testid="bridge-flip"]'); await editRecipient()
  await input('input[aria-label="Recipient"]', await page.evaluate(() => window.__fixture.BRIDGE)); await amount('2')
  assert((await action()).disabled); check('zero and embedded recipients blocked')
  await fresh(); await amount('2'); await page.evaluate(() => { window.__fixture.bridge.health.state = 'unknown' })
  assert((await action()).disabled)
  await page.evaluate(() => { location.hash = '#/stats' }); await page.waitForSelector('[data-testid="orchestrator-state"]')
  assert(!(await page.evaluate(() => document.querySelector('main').textContent)).includes('Signing normally.')); check('unknown signing health blocks sends')
  await fresh(); await amount('2'); await page.evaluate(() => { window.__fixture.knobs.delayWallet = true })
  await page.click('[data-testid="bridge-action"]'); await page.waitForFunction(() => window.__fixture.sent.length === 1)
  assert(await page.$eval('input[aria-label="Amount"]', (e) => e.disabled), 'Amount must be frozen during wallet approval')
  assert(await page.$eval('[data-testid="bridge-flip"]', (e) => e.disabled)); await amount('9')
  await page.evaluate(() => { window.__fixture.node.chainId = 322; window.__fixture.finishWallet() })
  await page.waitForFunction(() => window.__fixture.activity.local.length === 1)
  const original = await page.evaluate(() => JSON.parse(JSON.stringify({ sent: window.__fixture.sent[0], local: window.__fixture.activity.local[0], operation: window.__fixture.operations.entries[0] })))
  assert.equal(original.sent.amount, '200000000'); assert.equal(original.local.amount, '194000000'); assert.equal(original.local.znn, 1)
  assert.equal(original.operation.chainId, 1); assert.equal(original.operation.hash, 'ab'.repeat(32)); check('late response retains original amount, account, chain and hash')
  await fresh(); await page.evaluate(() => { window.__fixture.knobs.receiptReverted = true; location.hash = '#/activity' })
  await page.waitForFunction(() => document.querySelector('h1')?.textContent?.trim() === 'Activity')
  await page.waitForFunction(()=>window.__fixture.activity.loadedOnce&&!window.__fixture.activity.loading)
  await page.evaluate(() => {
    const a = window.__fixture; a.activity.readAt = Date.now(); a.activity.error = ''
    a.activity.items = [{ key: 'reverted-fixture', context: a.activity.context, kind: 'wrap', chainId: 1, toAddress: a.evm.account, amount: 97n, symbol: 'wZNN', decimals: 8, createdAt: 1, bonus: false, sourceTx: 'ab'.repeat(32), status: { state: 'finish', label: 'Finish', tone: 'warn' },
      wrap: { id: 'ab'.repeat(32), networkClass: 2, chainId: 1, toAddress: a.evm.account, tokenStandard: 'zts1znnxxxxxxxxxxxxx9z4ulx', tokenAddress: a.evm.account, amount: 100n, fee: 3n, signature: btoa(String.fromCharCode(...new Uint8Array(65))), confirmationsToFinality: 0, creationMomentumHeight: 1 } }]
  })
  await page.waitForSelector('[data-testid="activity-action"]');await page.click('[data-testid="activity-action"]')
  await page.waitForFunction(() => window.__fixture.toasts.some((t) => t.tone === 'danger'), { timeout: 15_000 })
  const failed = await page.evaluate(() => ({ state: window.__fixture.operations.entries.at(-1)?.state, success: window.__fixture.toasts.some((t) => t.tone === 'ok') }))
  assert.equal(failed.state, 'reverted'); assert.equal(failed.success, false); check('reverted receipt never shows success')
  await fresh(); await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }])
  await page.focus('[data-testid="wallet-menu"]'); await page.evaluate(() => window.__fixture.openNested())
  await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"]')?.getAttribute('aria-label') === 'Outer fixture')
  await page.click('button::-p-text(Open inner)')
  await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"]')?.getAttribute('aria-label') === 'Inner fixture')
  for (let i = 0; i < 6; i++) await page.keyboard.press('Tab')
  assert.equal(await page.evaluate(() => document.activeElement.closest('[role="dialog"]').getAttribute('aria-label')), 'Inner fixture')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.activeElement?.closest('[role="dialog"]')?.getAttribute('aria-label') === 'Outer fixture')
  assert.equal(await page.evaluate(() => document.querySelector('[role="dialog"]').getAttribute('aria-modal')), 'true')
  await page.keyboard.press('Escape')
  await page.waitForFunction(() => document.activeElement?.getAttribute('data-testid') === 'wallet-menu')
  assert.equal(await page.evaluate(() => document.querySelector('#app').inert), false)
  assert.equal(await page.evaluate(() => document.body.style.overflow), ''); check('nested focus trap, Escape ownership, background inertness and focus restoration')
  const frame=await page.$eval('canvas.starfield',(c)=>c.toDataURL())
  await new Promise((resolve)=>setTimeout(resolve,120))
  assert.notEqual(await page.$eval('canvas.starfield',(c)=>c.toDataURL()),frame);check('canvas chain indicator stays animated with OS animation effects disabled')
  await fresh()
  const second = await browser.newPage()
  await second.goto('http://127.0.0.1:5195/tests/browser/harness.html'); await second.waitForSelector('input[aria-label="Amount"]')
  await page.evaluate(() => {
    const f = window.__fixture
    f.ownership = f.journalSubmission({source:'evm',chainId:1,account:f.evm.account,kind:'ownership-fixture',payload:JSON.stringify({to:'0x'+'34'.repeat(20),data:'0x1234',value:'0'})},()=>{},()=>new Promise((resolve)=>{f.releaseOwned=()=>resolve('0x'+'56'.repeat(32))}))
  })
  await page.waitForFunction(() => !!window.__fixture.releaseOwned)
  const attempt = () => second.evaluate(async () => {
    const f=window.__fixture
    try { await f.journalSubmission({source:'evm',chainId:1,account:f.evm.account,kind:'ownership-fixture',payload:JSON.stringify({to:'0x'+'34'.repeat(20),data:'0x1234',value:'0'})},()=>{},async()=>{throw new Error('Second wallet was invoked')});return 'unexpected success' }
    catch(error){return error.message}
  })
  assert.match(await attempt(), /Another tab/)
  await page.evaluate(async () => { window.__fixture.releaseOwned(); await window.__fixture.ownership })
  assert.match(await attempt(), /unresolved/);await second.close();check('real cross-tab Web Lock and durable ownership prevent a second wallet invocation')
  const landing = await browser.newPage()
  await landing.setRequestInterception(true)
  landing.on('request',(r)=>{
    if (r.isNavigationRequest() && !r.url().includes('/affiliate.html')) void r.respond({status:200,contentType:'text/html',body:'<title>Isolated landing</title>'})
    else if(r.url().startsWith('http://127.0.0.1:5195/'))void r.continue()
    else {report.errors.push('Affiliate attempted an external request');void r.abort()}
  })
  for (const target of ['https://unrelated.invalid/wallet','javascript:alert(1)','https://user@unrelated.invalid/']) {
    await landing.goto('http://127.0.0.1:5195/affiliate.html?originURL='+encodeURIComponent(target))
    await landing.waitForFunction(()=>document.title==='Isolated landing')
    assert.equal(landing.url(),'http://127.0.0.1:5195/')
  }
  await landing.goto('http://127.0.0.1:5195/affiliate.html?originURL='+encodeURIComponent('/safe-path'))
  await landing.waitForFunction(()=>document.title==='Isolated landing');assert.equal(landing.url(),'http://127.0.0.1:5195/safe-path')
  await landing.close();check('legacy redirect rejects unrelated origins, userinfo and unsupported schemes')
  await fresh()
  await editRecipient()
  const fixtureRecipient='0x1111111111111111111111111111111111111111'
  await page.$eval('input[aria-label="Recipient"]',(e)=>{e.focus();e.select()})
  await page.keyboard.press('Backspace')
  await page.type('input[aria-label="Recipient"]',fixtureRecipient)
  assert.equal(await page.$eval('input[aria-label="Recipient"]',(e)=>e.value),fixtureRecipient)
  assert.equal((await action()).label.includes('Invalid recipient'),false)
  check('keyboard editing replaces the existing fixture recipient exactly')
  await page.evaluate(()=>localStorage.clear());await fresh();await amount('2')
  await page.evaluate(()=>window.__fixture.holdWalletQueue());await page.waitForFunction(()=>!!window.__fixture.releaseConnect)
  await page.click('[data-testid="bridge-action"]');await page.waitForFunction(()=>window.__fixture.operations.entries.length===1)
  await page.evaluate(()=>{window.__fixture.bridge.routes[0].pair.feePercentage=3000;window.__fixture.releaseConnect()})
  await page.waitForFunction(()=>window.__fixture.toasts.some((t)=>t.tone==='danger'))
  assert.equal(await page.evaluate(()=>window.__fixture.sent.length),0)
  assert.equal(await page.evaluate(()=>window.__fixture.operations.entries[0].state),'rejected');check('economic configuration changes abort a queued wallet prompt')
  const clean = async () => { await page.evaluate(()=>localStorage.clear());await fresh() }
  await clean(); await amount('2')
  await page.evaluate(() => { window.__fixture.bridge.health.state = 'unknown' })
  assert((await action()).disabled)
  await page.click('[data-testid="bridge-advanced"]'); await page.click('[data-testid="send-while-down"]')
  await page.waitForSelector('[data-testid="bridge-advanced"] .adv-dot')
  await page.waitForFunction(() => !document.querySelector('[data-testid="bridge-action"]').disabled)
  await page.evaluate(() => { window.__fixture.node.tick++ })
  assert(!(await action()).disabled, 'A normal node tick must retain consent for the same health warning')
  await page.evaluate(() => { window.__fixture.bridge.evmNetworks[1].tssMatches = false })
  assert((await action()).disabled)
  await page.evaluate(() => { window.__fixture.bridge.evmNetworks[1].tssMatches = true; window.__fixture.bridge.info.halted = true })
  assert((await action()).disabled)
  await page.evaluate(() => { window.__fixture.bridge.info.halted = false; window.__fixture.bridge.healthError = 'Changed fixture health observation' })
  await page.waitForFunction(() => document.querySelector('[data-testid="send-while-down"] [role="switch"]').getAttribute('aria-checked') === 'false')
  assert.equal(await page.$('[data-testid="bridge-advanced"] .adv-dot'), null)
  assert((await action()).disabled)
  assert.equal(await page.evaluate(() => window.__fixture.sent.length + window.__fixture.evmRequests.filter((r) => r.method === 'eth_sendTransaction').length), 0)
  check('explicit health opt-in retains halt and TSS guards and resets on changed health evidence')
  await clean()
  await page.evaluate(() => {
    const f = window.__fixture
    localStorage.setItem('bridge.operations.v1', JSON.stringify([{ id: 'hashless-browser-fixture', source: 'evm', chainId: 1, account: f.evm.account, kind: 'lost-fixture',
      payload: JSON.stringify({ to: '0x'+'34'.repeat(20), data: '0x1234', value: '0' }), state: 'unknown', createdAt: Math.floor(Date.now()/1000)-61 }]))
    f.restoreOperations(); location.hash = '#/activity'
  })
  await page.waitForSelector('[data-testid="hashless-review-ack"]')
  assert(await page.$eval('[data-testid="hashless-review-action"]', (e) => e.disabled))
  const reviewerPeer = await browser.newPage()
  await reviewerPeer.goto('http://127.0.0.1:5195/tests/browser/harness.html'); await reviewerPeer.waitForSelector('input[aria-label="Amount"]')
  await reviewerPeer.evaluate(() => {
    const f = window.__fixture
    f.ownedReviewRequest = f.journalSubmission({ source: 'evm', chainId: 1, account: '0x'+'56'.repeat(20), kind: 'review-lock-fixture', payload: JSON.stringify({ to: '0x'+'34'.repeat(20), data: '0x1234', value: '0' }) }, () => {}, () => new Promise((resolve) => { f.releaseReviewRequest = () => resolve('0x'+'cd'.repeat(32)) }))
  })
  await reviewerPeer.waitForFunction(() => !!window.__fixture.releaseReviewRequest)
  await page.click('[data-testid="hashless-review-ack"]'); await page.click('[data-testid="hashless-review-action"]')
  await page.waitForFunction(() => document.body.textContent.includes('Another tab still owns'))
  assert.equal(await page.evaluate(() => window.__fixture.operations.entries.find((r) => r.id === 'hashless-browser-fixture').reviewedAt), undefined)
  await reviewerPeer.evaluate(async () => { window.__fixture.releaseReviewRequest(); await window.__fixture.ownedReviewRequest }); await reviewerPeer.close()
  await page.click('[data-testid="hashless-review-action"]')
  await page.waitForFunction(() => window.__fixture.operations.entries.find((r) => r.id === 'hashless-browser-fixture').reviewedAt)
  await fresh()
  const reviewed = await page.evaluate(async () => {
    const f = window.__fixture, original = f.operations.entries.find((r) => r.id === 'hashless-browser-fixture')
    let duplicateCalls = 0, differentCalls = 0, duplicateBlocked = false
    try { await f.journalSubmission({ source: original.source, chainId: original.chainId, account: original.account, kind: 'new-label', payload: JSON.stringify({ value:'0',data:'0x1234',to:'0x'+'34'.repeat(20) }) }, () => {}, async () => { duplicateCalls++; return '0x'+'ef'.repeat(32) }) }
    catch { duplicateBlocked = true }
    await f.journalSubmission({ source: original.source, chainId: original.chainId, account: original.account, kind: 'different-fixture', payload: JSON.stringify({ to:'0x'+'78'.repeat(20),data:'0x1234',value:'1' }) }, () => {}, async () => { differentCalls++; return '0x'+'ef'.repeat(32) })
    return { original: { state: original.state, hash: original.hash, reviewedAt: original.reviewedAt }, duplicateBlocked, duplicateCalls, differentCalls }
  })
  assert.equal(reviewed.original.state, 'unknown'); assert.equal(reviewed.original.hash, undefined); assert(reviewed.original.reviewedAt)
  assert.equal(reviewed.duplicateBlocked, true); assert.equal(reviewed.duplicateCalls, 0); assert.equal(reviewed.differentCalls, 1)
  check('hashless review uses the real cross-tab lock and retains unknown evidence across reload without repeating its request')
  await clean()
  const liquidity = async (settings={}) => {
    await page.evaluate((json)=>{const values=JSON.parse(json);for(const key of ['allowance','reward'])if(key in values)values[key]=BigInt(values[key]);Object.assign(window.__fixture.knobs,values);location.hash='#/liquidity'},JSON.stringify(settings,(_key,value)=>typeof value==='bigint'?value.toString():value))
    await page.waitForSelector('input[aria-label="wZNN amount"]')
  }
  const add = 'main button::-p-text(Add liquidity)'
  for(const settings of [{failPool:true},{wrongPool:true}]) {
    await clean();await liquidity(settings);await input('input[aria-label="wZNN amount"]','2')
    await page.waitForFunction(()=>[...document.querySelectorAll('main button')].some((b)=>b.textContent.includes('Pool data unavailable') && b.disabled))
    assert.equal(await page.evaluate(()=>window.__fixture.evmRequests.filter((r)=>r.method==='eth_sendTransaction').length),0)
  }
  check('unavailable or substituted pool identities prevent liquidity writes')
  await clean();await liquidity({receiptReverted:true});await input('input[aria-label="wZNN amount"]','2')
  await page.waitForSelector('main button::-p-text(Approve and add)');await page.click('main button::-p-text(Approve and add)')
  await page.waitForFunction(()=>window.__fixture.toasts.some((t)=>t.tone==='danger'))
  assert.equal(await page.evaluate(()=>window.__fixture.evmRequests.filter((r)=>r.method==='eth_sendTransaction').length),1)
  assert.equal(await page.evaluate(()=>window.__fixture.toasts.some((t)=>t.tone==='ok')),false);check('reverted pool approval prevents the add transaction')
  for(const increase of [false,true]) {
    await clean();await liquidity({allowance:100000000000n,lpIncrease:increase});await input('input[aria-label="wZNN amount"]','2')
    await page.waitForSelector(add);await page.click(add)
    await page.waitForFunction(()=>window.__fixture.toasts.some((t)=>t.tone==='danger'||t.tone==='ok'))
    assert.equal(await page.evaluate(()=>window.__fixture.toasts.some((t)=>t.tone==='ok')),increase)
  }
  check('LP completion requires both a successful original receipt and an increased balance')
  for(const settings of [{programRewards:false},{programRewards:true,haltedProgram:true},{programRewards:true,failProgram:true}]) {
    await clean();await liquidity(settings);await input('input[aria-label="LP amount"]','2')
    await page.waitForFunction(()=>document.querySelector('input[aria-label="LP amount"]').closest('.panel').querySelector('.btn').disabled)
    assert.equal(await page.evaluate(()=>window.__fixture.sent.length),0)
  }
  check('zero-reward, halted and unavailable staking programs prevent new locks')
  await clean();await liquidity({programRewards:true});await input('input[aria-label="LP amount"]','2')
  await page.waitForFunction(()=>!document.querySelector('input[aria-label="LP amount"]').closest('.panel').querySelector('.btn').disabled)
  await page.evaluate(()=>window.__fixture.holdWalletQueue());await page.waitForFunction(()=>!!window.__fixture.releaseConnect)
  await page.click('main button::-p-text(Stake)');await page.waitForFunction(()=>window.__fixture.operations.entries.length===1)
  await page.evaluate(()=>{window.__fixture.node.chainId=322;window.__fixture.releaseConnect()})
  await page.waitForFunction(()=>window.__fixture.toasts.some((t)=>t.tone==='danger'))
  assert.equal(await page.evaluate(()=>window.__fixture.sent.length),0);check('queued stake refuses a changed Zenon source before prompting')
  await clean();await liquidity({programRewards:true});await input('input[aria-label="LP amount"]','2')
  await page.waitForFunction(()=>!document.querySelector('input[aria-label="LP amount"]').closest('.panel').querySelector('.btn').disabled)
  await page.click('main button::-p-text(Stake)');await page.waitForFunction(()=>window.__fixture.sent.length===1)
  assert.equal(await page.evaluate(()=>window.__fixture.sent[0].amount),'200000000')
  assert.equal(await page.evaluate(()=>window.__fixture.toasts.some((t)=>t.tone==='ok')),false);check('stake preserves exact intent and reports submission without claiming completion')
  await clean();await liquidity({programRewards:true,stakeCount:151,reward:1n})
  await page.waitForFunction(()=>[...document.querySelectorAll('main button')].filter((b)=>b.textContent.includes('Revoke')).length===150)
  check('all 151 stake records are loaded and only expired entries offer revoke')
  await page.click('main button::-p-text(Revoke)');await page.waitForFunction(()=>window.__fixture.sent.length===1)
  assert.equal(await page.evaluate(()=>atob(window.__fixture.sent[0].data).slice(0,4).split('').map((x)=>x.charCodeAt(0).toString(16).padStart(2,'0')).join('')),'b8efc37c')
  await clean();await liquidity({reward:1n});await page.waitForFunction(()=>[...document.querySelectorAll('main button')].some((b)=>b.textContent.trim()==='Collect'&&!b.disabled))
  await page.click('main button::-p-text(Collect)');await page.waitForFunction(()=>window.__fixture.sent.length===1)
  assert.equal(await page.evaluate(()=>window.__fixture.toasts.some((t)=>t.tone==='ok')),false);check('expiry cancellation and reward collection preserve submitted-only status')
  await clean();await page.evaluate(()=>{window.__fixture.syrius.address='';window.__fixture.evm.account='';window.__fixture.evm.selected=null})
  for (const theme of ['dark','light']) for (const width of [320,375,768,1024,1440]) {
    await page.setViewport({width,height:900});await page.evaluate((v)=>document.documentElement.setAttribute('data-theme',v),theme)
    for(const route of ['','activity','liquidity','stats','affiliate']) {
      await page.evaluate((v)=>{location.hash='#/'+v},route)
      await page.waitForFunction((v)=>document.querySelector('h1')?.textContent?.trim()===v,{},route?route[0].toUpperCase()+route.slice(1):'Bridge')
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth),0)
      report.checks.push({name:'responsive layout with disconnected wallets',theme,width,route:route||'bridge'})
    }
  }
  await page.evaluate(() => localStorage.clear())
  await page.goto('http://127.0.0.1:5195/tests/browser/harness.html?swap=1')
  await page.waitForSelector('[data-testid="mode-swap"]')
  await page.click('[data-testid="mode-swap"]')
  await amount('0.1')
  await page.waitForFunction(() => { const b = document.querySelector('[data-testid="bridge-action"]'); return b && !b.disabled && b.textContent.trim() === 'Swap' })
  await page.evaluate(() => { window.__fixture.knobs.delayEvmWallet = true })
  await page.click('[data-testid="bridge-action"]')
  await page.waitForFunction(() => window.__fixture.evmRequests.some((r) => r.method === 'eth_sendTransaction'))
  assert(await page.$eval('input[aria-label="Amount"]', (e) => e.disabled))
  assert(await page.$eval('[data-testid="mode-bridge"]', (e) => e.disabled))
  const swapOriginal = await page.evaluate(() => {
    window.__fixture.evm.account = '0x' + '56'.repeat(20)
    window.__fixture.finishEvmWallet()
    return window.__fixture.evmRequests.find((r) => r.method === 'eth_sendTransaction').params[0]
  })
  await page.waitForFunction(() => window.__fixture.operations.entries.some((r) => r.kind === 'swap' && r.hash))
  const swapRecord = await page.evaluate(() => JSON.parse(JSON.stringify(window.__fixture.operations.entries.find((r) => r.kind === 'swap'))))
  assert.equal(swapRecord.account.toLowerCase(), swapOriginal.from.toLowerCase())
  assert.equal(JSON.parse(swapRecord.payload).value, BigInt(swapOriginal.value).toString())
  const storedQuote = JSON.parse(swapRecord.payload).quote
  assert.equal(storedQuote.recipient.toLowerCase(), swapOriginal.from.toLowerCase())
  assert.equal(storedQuote.fromAmount, BigInt(swapOriginal.value).toString())
  assert.equal(storedQuote.fromChainId, 1)
  assert.equal(swapRecord.hash, '0x' + 'cd'.repeat(32))
  const durableSwap = await page.evaluate(() => JSON.parse(localStorage.getItem('bridge.operations.v1')).find((r) => r.kind === 'swap'))
  assert.equal(durableSwap.payload, swapRecord.payload)
  assert.equal(durableSwap.hash, swapRecord.hash)
  check('swap late wallet response preserves the original account, value, payload and hash')
  assert.deepEqual(report.errors, []); console.log(`${report.checks.length} browser checks passed with ${report.browserVersion}`)
} catch (error) { report.errors.push(error.stack || String(error)); process.exitCode = 1 }
finally {
  await browser?.close(); await server.close()
  fs.writeFileSync(`${resultsDir}/report.json`, JSON.stringify(report, null, 2) + '\n')
  if (report.errors.length) console.error(report.errors.join('\n'))
}
