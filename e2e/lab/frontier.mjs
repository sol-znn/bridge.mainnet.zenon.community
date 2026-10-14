#!/usr/bin/env node
// Is the lab producing? Reads the frontier momentum, then again every five
// seconds until the height has moved or the time is up.
//
//   node frontier.mjs [seconds to give it, default 30] [--wait <seconds>]
//
// A chain that has stopped still answers, so one read proves nothing. `--wait`
// keeps trying until the node answers at all, for the minutes after `up`.
// Native qualification additionally requires five exact-height hash matches.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { agreesAtHeight } from './readiness.mjs'
const args = process.argv.slice(2)
const waitAt = args.indexOf('--wait')
const wait = waitAt >= 0 ? Number(args.splice(waitAt, 2)[1]) : 0
const patience = Number(args[0] || 30)
const url = process.env.LAB_RPC || 'http://127.0.0.1:46997'
const endpoint = new URL(url)
if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.username || endpoint.password) throw new Error('Readiness must use an isolated loopback endpoint')

async function frontier() {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ledger.getFrontierMomentum', params: [] }),
    signal: AbortSignal.timeout(5000),
  })
  const reply = await res.json()
  if (!res.ok) throw new Error(`Readiness HTTP ${res.status}`)
  if (reply.error) throw new Error(reply.error.message)
  if (reply.result?.chainIdentifier !== 322) throw new Error('Unexpected Zenon chain identity')
  return reply.result
}
const pause = (s) => new Promise((r) => setTimeout(r, s * 1000))

const deadline = Date.now() + wait * 1000
let first
for (;;) {
  try {
    first = await frontier()
    break
  } catch (error) {
    if (Date.now() >= deadline) {
      console.error(`${url}: ${error.message}`)
      process.exit(1)
    }
    await pause(3)
  }
}
const started = Date.now()
let second = first
while (second.height === first.height && Date.now() - started < patience * 1000) {
  await pause(5)
  second = await frontier().catch(() => second)
}
const moved = second.height - first.height
console.log(`chain ${second.chainIdentifier}: ${first.height} then ${second.height} after ${Math.round((Date.now() - started) / 1000)} s`)
console.log(moved > 0 ? 'producing' : 'NOT producing')
if (args.includes('--native')) {
  // Production is insufficient: require convergence across the five nodes at
  // an agreed recent height, after a startup window. Never skip this in CI.
  // The observed passing Linux warmup consumed 261 s of the old 300 s
  // budget. Allow bounded startup headroom while retaining every predicate.
  const end = Date.now() + 600_000
  const nativeStarted = Date.now()
  const report = { schema: 1, sourceCommit: execFileSync('git', ['rev-parse', 'HEAD']).toString().trim(), sourceTree: execFileSync('git', ['rev-parse', 'HEAD^{tree}']).toString().trim(), status: 'WAITING',
    minimumHeight: 20, depth: 3, requiredSamples: 3, windowSeconds: 600, rounds: [] }
  const record = () => fs.writeFileSync(new URL('./.build/native/readiness-report.json', import.meta.url), JSON.stringify(report, null, 2) + '\n')
  let agreed = 0
  while (agreed < 3) {
    const frontierNow = await frontier()
    const targetHeight = frontierNow.height - 3
    const nodes = await Promise.all([46997,47100,47101,47102,47103].map(async (port) => {
      const rpc = async (method, params) => {
        const r = await fetch(`http://127.0.0.1:${port}`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}), signal:AbortSignal.timeout(5000) })
        const p = await r.json()
        if (!r.ok || p.error) throw new Error('RPC unavailable')
        return p.result
      }
      try {
        const head = await rpc('ledger.getFrontierMomentum', [])
        const momentum = frontierNow.height >= 20 ? (await rpc('ledger.getMomentumsByHeight', [targetHeight,1]))?.list?.[0] : null
        return { port, height: Number.isSafeInteger(head?.height) ? head.height : null, chainId: Number.isSafeInteger(head?.chainIdentifier) ? head.chainIdentifier : null,
          momentum: momentum && { height: momentum.height, chainIdentifier: momentum.chainIdentifier, hash: momentum.hash }, error: null }
      } catch { return { port, height: null, chainId: null, momentum: null, error: 'READ_UNAVAILABLE' } }
    }))
    const matches = frontierNow.height >= 20 && agreesAtHeight(nodes.map((n) => n.momentum), targetHeight)
    agreed = matches ? agreed + 1 : 0
    report.rounds.push({ elapsedMs: Date.now() - nativeStarted, anchorHeight: frontierNow.height, targetHeight, agreed, nodes })
    record()
    if (Date.now() > end) { report.status = 'FAILURE'; record(); throw new Error('Native nodes did not converge within the qualification window; inspect readiness-report.json') }
    if (agreed < 3) await pause(10)
  }
  report.status = moved > 0 ? 'SUCCESS' : 'FAILURE'; record()
  console.log('Five native nodes agree on recent momentum hashes; fixture writes may begin.')
}
process.exit(moved > 0 ? 0 : 1)
