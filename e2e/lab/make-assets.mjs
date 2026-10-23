#!/usr/bin/env node
// The lab's /devnet directory: go-zenon's committed devnet assets with three
// things changed.
//
//   node make-assets.mjs <go-zenon>/docker/devnet <out dir>
//
// - ChainIdentifier 322. It is signed into every block and is the p2p network
//   id, so nothing signed for the lab is valid on another devnet on this host.
// - The bridge-liq spork is active from genesis, as az and htlc already are.
// - The node addresses in each config.json move to the lab's subnet.
//
// The index-1 fixture has 10,000 ZNN and 70,000 spendable QSR. The other
// 30,000 QSR back the declared genesis fusions in the Plasma contract.
// After syrius-extension/tools/devnet/lab/make-assets.js.
import fs from 'node:fs'
import path from 'node:path'

const chainIdentifier = 322
const subnet = { from: '172.30.0.', to: '172.38.0.' }
const roles = ['pillar', 'pillar2', 'pillar3', 'observer', 'rpc']
const BRIDGE_SPORK = 'ddd43466769461c5b5d109c639da0f50a7eeb96ad6e7274b1928a35c431d7b1b'

const [source, out] = process.argv.slice(2)
if (!source || !out) {
  console.error('usage: make-assets.mjs <go-zenon/docker/devnet> <out dir>')
  process.exit(2)
}
if (fs.existsSync(path.join(out, 'genesis.json'))) {
  console.error(`${out} already holds a genesis. Volumes made from it need it unchanged: wipe first.`)
  process.exit(1)
}

const copy = (from, to) => {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name)
    const b = path.join(to, entry.name)
    if (entry.isDirectory()) copy(a, b)
    else fs.copyFileSync(a, b)
  }
}

const genesis = JSON.parse(fs.readFileSync(path.join(source, 'genesis.json'), 'utf8'))
genesis.ChainIdentifier = chainIdentifier
genesis.ExtraData = 'BRIDGE LAB'
// Back every genesis fusion with the Plasma contract balance while preserving
// total QSR supply. The pinned fixture previously declared fusions without
// putting their QSR in Plasma; current genesis validation rejects that state.
const QSR = 'zts1qsrxxxxxxxxxxxxxmrhjll'
const PLASMA = 'z1qxemdeddedxplasmaxxxxxxxxxxxxxxxxsctrp'
const sums = new Map()
for (const fusion of genesis.PlasmaConfig.Fusions) {
  if (!Number.isSafeInteger(fusion.amount) || fusion.amount < 0) throw new Error('Unsafe fixture fusion amount')
  sums.set(fusion.owner, (sums.get(fusion.owner) ?? 0n) + BigInt(fusion.amount))
}
const totalFusion = [...sums.values()].reduce((a, b) => a + b, 0n)
if (totalFusion > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Unsafe fixture fusion total')
let plasma = genesis.GenesisBlocks.Blocks.find((block) => block.Address === PLASMA)
if (!plasma) { plasma = { Address: PLASMA, BalanceList: {} }; genesis.GenesisBlocks.Blocks.push(plasma) }
const existing = BigInt(plasma.BalanceList[QSR] ?? 0)
if (existing === 0n && totalFusion > 0n) {
  for (const [owner, amount] of sums) {
    const block = genesis.GenesisBlocks.Blocks.find((block) => block.Address === owner)
    const balance = BigInt(block?.BalanceList[QSR] ?? 0)
    if (!block || balance < amount || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Fixture fusion owner cannot back its QSR')
    block.BalanceList[QSR] = Number(balance - amount)
  }
  plasma.BalanceList[QSR] = Number(totalFusion)
} else if (existing !== totalFusion) throw new Error('Fixture Plasma balance does not match declared fusions')
const spork = genesis.SporkConfig.Sporks.find((s) => s.id === BRIDGE_SPORK)
if (!spork) throw new Error('the source genesis has no bridge-liq spork')
spork.activated = true
spork.enforcementHeight = 0
fs.mkdirSync(out, { recursive: true })
fs.writeFileSync(path.join(out, 'genesis.json'), `${JSON.stringify(genesis, null, 4)}\n`)

for (const role of roles) {
  copy(path.join(source, role), path.join(out, role))
  const file = path.join(out, role, 'config.json')
  const text = fs.readFileSync(file, 'utf8')
  const moved = text.split(subnet.from).join(subnet.to)
  if (moved === text) throw new Error(`${role}/config.json names no ${subnet.from} address`)
  fs.writeFileSync(file, moved)
}

console.log(`lab assets in ${out}: chain ${chainIdentifier}, bridge-liq active, ${roles.length} roles on ${subnet.to}0/24`)
