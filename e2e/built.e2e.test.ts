// Read-only smoke qualification of compiled assets and the actual HTML CSP.
// No wallet is injected and the only RPC endpoints are the isolated lab.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { build, preview, type PreviewServer } from 'vite'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { assertLab } from './lib/lab.ts'

const outDir='e2e/.state/browser-build', origin='http://127.0.0.1:5195'
let server: PreviewServer, browser: Browser, page: Page
const errors:string[]=[], outbound:string[]=[], scripts=new Set<string>(), violations:string[]=[]
let initialScripts:string[]=[]
const sha=(data:Buffer)=>crypto.createHash('sha256').update(data).digest('hex')
beforeAll(async()=>{
  await assertLab()
  if(!process.env.CHROME_PATH)throw new Error('Set CHROME_PATH to the pinned browser')
  process.env.VITE_NETWORK='devnet'
  // Vitest sets NODE_ENV=test; that would otherwise retain development stores.
  const previousNodeEnv=process.env.NODE_ENV
  process.env.NODE_ENV='production'
  try { await build({envDir:false,logLevel:'error',mode:'production',build:{outDir,emptyOutDir:true}}) }
  finally { if(previousNodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousNodeEnv }
  server=await preview({envDir:false,logLevel:'error',build:{outDir},preview:{host:'127.0.0.1',port:5195,strictPort:true}})
  browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH,headless:true})
  if(process.env.EXPECTED_BROWSER_VERSION)expect((await browser.version()).endsWith(process.env.EXPECTED_BROWSER_VERSION)).toBe(true)
  page=await browser.newPage()
  page.on('pageerror',(error)=>errors.push(String(error)))
  page.on('console',(message)=>{if(message.type()==='error')errors.push(message.text())})
  await page.exposeFunction('__labPolicyViolation',(directive:string)=>violations.push(directive))
  await page.evaluateOnNewDocument(()=>document.addEventListener('securitypolicyviolation',(event)=>(window as any).__labPolicyViolation(event.effectiveDirective)))
  await page.setRequestInterception(true)
  page.on('request',(request)=>{
    const url=new URL(request.url())
    if(url.hostname==='127.0.0.1'||url.protocol==='data:')void request.continue()
    else{outbound.push(url.origin);void request.abort()}
  })
  page.on('response',(response)=>{const url=new URL(response.url());if(url.origin===origin&&url.pathname.endsWith('.js'))scripts.add(url.pathname)})
  await page.goto(origin,{waitUntil:'networkidle0'})
  await page.waitForFunction(()=>document.body.innerText.includes('Anvil'),{timeout:60_000})
  initialScripts=[...scripts].sort()
})
afterAll(async()=>{
  const report={mode:'isolated read-only production bundle',network:'devnet',sourceCommit:execFileSync('git',['rev-parse','HEAD']).toString().trim(),
    sourceTree:execFileSync('git',['rev-parse','HEAD^{tree}']).toString().trim(),lockfileHash:sha(fs.readFileSync('package-lock.json')),
    sourceDirty:execFileSync('git',['status','--porcelain']).toString().trim().length>0,browserVersion:await browser?.version(),errors,outbound,violations,
    initialScripts:initialScripts.map((name)=>{const bytes=fs.readFileSync(path.join(outDir,name));return {name,bytes:bytes.length,gzipBytes:gzipSync(bytes).length,sha256:sha(bytes)}}),loadedScriptNames:[...scripts].sort()}
  fs.mkdirSync('.browser-results',{recursive:true});fs.writeFileSync('.browser-results/built-report.json',JSON.stringify(report,null,2)+'\n')
  await browser?.close();await new Promise<void>((resolve)=>server?.httpServer.close(()=>resolve())??resolve())
})

it('loads compiled routes under the declared CSP without development stores or an external request',async()=>{
  expect(await page.evaluate(()=>(window as any).__bridge)).toBeUndefined()
  expect(await page.$eval('meta[http-equiv="Content-Security-Policy"]',(element)=>element.getAttribute('content'))).toContain("script-src 'self'")
  expect(errors).toEqual([]);expect(outbound).toEqual([]);expect(violations).toEqual([])
})

it('keeps compiled views within a mobile viewport with disconnected wallets',async()=>{
  await page.setViewport({width:375,height:900})
  for(const route of ['','activity','liquidity','stats','affiliate']) {
    await page.evaluate((value)=>{location.hash='#/'+value},route)
    await page.waitForFunction((value)=>document.querySelector('h1')?.textContent?.trim()===value,{},route?route[0].toUpperCase()+route.slice(1):'Bridge')
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBe(0)
  }
  expect(errors).toEqual([]);expect(outbound).toEqual([]);expect(violations).toEqual([])
})
