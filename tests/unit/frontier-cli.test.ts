import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }) })
function diagnostic(scenario: string, mode?: string) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'bridge-frontier-cli-')); roots.push(root)
  for (const name of ['frontier.mjs', 'readiness.mjs']) fs.copyFileSync(fileURLToPath(new URL('../../e2e/lab/' + name, import.meta.url)), path.join(root, name))
  // This is a fixture-only subprocess: no RPC listener, chain, wallet or real wait.
  fs.writeFileSync(path.join(root, 'fixture.mjs'), `
    let now=0, reads=0; const scenario=process.env.FRONTIER_FIXTURE;
    Date.now=()=>now;
    globalThis.setTimeout=(fn,ms,...args)=>{now+=ms;queueMicrotask(()=>fn(...args));return {unref(){}}};
    globalThis.fetch=async(input,options)=>{
      const url=new URL(input); if(url.hostname!=='127.0.0.1')throw Error('Unexpected fixture transport');
      const q=JSON.parse(options.body);let result;
      if(q.method==='ledger.getFrontierMomentum'){
        reads++;const height=scenario==='invalid'?'22':scenario==='stalled'?22:scenario==='moving'?(reads===1?2:22):(reads<=2?2:22);
        result={chainIdentifier:322,height};
      }else if(q.method==='ledger.getMomentumsByHeight'){
        result={list:[{height:q.params[0],chainIdentifier:322,hash:(scenario==='divergent'&&url.port==='47103'?'cd':'ab').repeat(32)}]};
      }else throw Error('Unexpected fixture method');
      return new Response(JSON.stringify({jsonrpc:'2.0',id:q.id,result}),{status:200});
    };
  `)
  const child = spawnSync(process.execPath, ['--import', path.join(root, 'fixture.mjs'), path.join(root, 'frontier.mjs'), '1', ...(mode ? ['--' + mode] : [])], {
    cwd: process.cwd(), env: { ...process.env, FRONTIER_FIXTURE: scenario, LAB_RPC: 'http://127.0.0.1:46997' }, encoding: 'utf8', timeout: 8000, maxBuffer: 256 * 1024,
  })
  const report = mode && path.join(root, '.build', mode, 'readiness-report.json')
  return { ...child, report: report && fs.existsSync(report) ? JSON.parse(fs.readFileSync(report, 'utf8')) : null }
}
describe('actual readiness CLI exits with synthetic bounded transport', () => {
  it.each(['native', 'docker'])('accepts a cold initial diagnostic only after full %s convergence and subsequent production', (mode) => {
    const result = diagnostic('cold', mode)
    expect(result.status, result.stderr).toBe(0)
    expect(result.report).toMatchObject({ status: 'SUCCESS', initialHeight: 2, warmupHeight: 2, minimumHeight: 20, requiredSamples: 3 })
    expect(result.report.rounds.at(-1)).toMatchObject({ anchorHeight: 22, agreed: 3 })
    expect(result.stdout).toContain('fixture writes may begin')
  })
  it('refuses a converged chain that never advances from its original frontier', () => {
    const result = diagnostic('stalled', 'native')
    expect(result.status).toBe(1); expect(result.report.status).toBe('FAILURE')
    expect(result.stdout).not.toContain('fixture writes may begin')
  })
  it('refuses production when the five exact recent hashes disagree', () => {
    const result = diagnostic('divergent', 'docker')
    expect(result.status).toBe(1); expect(result.report.status).toBe('FAILURE')
    expect(result.report.rounds.every((r: any) => r.agreed === 0)).toBe(true)
  })
  it('retains the simple production diagnostic without lab-mode qualification', () => {
    expect(diagnostic('moving').status).toBe(0)
    expect(diagnostic('stalled').status).toBe(1)
  })
  it('rejects a malformed original frontier before reporting readiness', () => {
    const result = diagnostic('invalid', 'native')
    expect(result.status).toBe(1); expect(Boolean(result.report)).toBe(false); expect(result.stderr).toContain('frontier identity')
  })
})
