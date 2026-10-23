// A foreground supervisor for five isolated nodes and Anvil. SIGTERM/SIGINT
// stop only this supervisor's children. All keys are committed devnet fixtures.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn, execFileSync } from 'node:child_process'
import { here, digest, verifiedBuild } from './verify-build.mjs'
const manifest = verifiedBuild('native'), pins = manifest.pins
const root = path.join(here, '.build/native'), assets = path.join(root, 'assets')
const anvil = process.env.ANVIL_BIN
if (!anvil) throw new Error('Set ANVIL_BIN to the pinned Anvil executable')
const anvilVersion = execFileSync(anvil, ['--version']).toString().trim()
if (anvilVersion.split('\n')[0] !== `anvil Version: ${pins.anvilVersion}`) throw new Error('Anvil version does not match the lab pin')
const ports = { pillar: 47010, pillar2: 47012, pillar3: 47013, observer: 47014, rpc: 47011 }
for (const port of [...Object.values(ports), 46997, 46998, 46545, 47100, 47101, 47102, 47103, 47200, 47201, 47202, 47203]) {
  await new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject)
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}
fs.mkdirSync(root, { recursive: true })
const identityFile = path.join(root, 'identity')
if (fs.existsSync(identityFile) && fs.readFileSync(identityFile, 'utf8') !== manifest.key) throw new Error('Existing native chain uses different inputs; archive it and create a fresh lab')
if (!fs.existsSync(path.join(assets, 'genesis.json'))) execFileSync(process.execPath, [path.join(here, 'make-assets.mjs'), path.join(here, '.build/src/docker/devnet'), assets], { stdio: 'inherit' })
fs.writeFileSync(identityFile, manifest.key)
const children = []
let stopping = false, failed = false
const stop = () => {
  if (stopping) return
  stopping = true
  for (const child of children) child.kill('SIGTERM')
  setTimeout(() => { for (const child of children) if (child.exitCode === null) child.kill('SIGKILL') }, 2000).unref()
}
process.on('SIGINT', stop); process.on('SIGTERM', stop)
function start(binary, args, log, env = {}) {
  const fd = fs.openSync(path.join(root, log), 'a')
  const child = spawn(binary, args, { stdio: ['ignore', fd, fd], env: { ...process.env, ...env } })
  fs.closeSync(fd); children.push(child)
  child.on('error', () => { failed = true; stop() })
  child.on('exit', () => { if (!stopping) { failed = true; console.error('A lab process exited; stopping the isolated lab'); stop() } })
}
const ipPorts = { 10: 47010, 12: 47012, 13: 47013, 14: 47014, 11: 47011 }
const configHashes = {}
let index = 0
for (const [role, port] of Object.entries(ports)) {
  const data = path.join(root, role), configFile = path.join(data, 'config.json')
  fs.mkdirSync(data, { recursive: true }); fs.cpSync(path.join(assets, role), data, { recursive: true })
  if (fs.existsSync(path.join(data, 'wallet'))) for (const name of fs.readdirSync(path.join(data, 'wallet'))) {
    const file = path.join(data, 'wallet', name), fixture = JSON.parse(fs.readFileSync(file))
    fixture.Path = file; fs.writeFileSync(file, JSON.stringify(fixture))
  }
  const cfg = JSON.parse(fs.readFileSync(configFile))
  cfg.DataPath = data; cfg.GenesisFile = path.join(assets, 'genesis.json'); cfg.WalletPath = path.join(data, 'wallet'); cfg.LogLevel = 'error'
  cfg.Net.ListenHost = '127.0.0.1'; cfg.Net.ListenPort = port
  // Use the pinned source's libp2p backend and an explicit five-node capacity.
  // Legacy discovery on one loopback IP can leave a fixture producer isolated.
  cfg.Net.P2PBackend = 'libp2p'; cfg.Net.MaxPeers = 8; cfg.Net.MinConnectedPeers = 4
  cfg.Net.BootstrapPeers = cfg.Net.BootstrapPeers.map((peer) => peer.replace(/172\.38\.0\.(\d+)\/tcp\/35995/, (_, ip) => `127.0.0.1/tcp/${ipPorts[ip]}`))
  cfg.Net.Seeders = cfg.Net.Seeders.map((peer) => peer.replace(/172\.38\.0\.(\d+):35995/, (_, ip) => `127.0.0.1:${ipPorts[ip]}`))
  cfg.RPC.HTTPHost = '127.0.0.1'; cfg.RPC.WSHost = '127.0.0.1'
  cfg.RPC.HTTPVirtualHosts = ['127.0.0.1', 'localhost']
  cfg.RPC.HTTPCors = ['http://127.0.0.1:5191', 'http://127.0.0.1:5195']
  cfg.RPC.WSOrigins = cfg.RPC.HTTPCors
  cfg.RPC.HTTPPort = role === 'rpc' ? 46997 : 47100 + index
  cfg.RPC.WSPort = role === 'rpc' ? 46998 : 47200 + index++
  fs.writeFileSync(configFile, JSON.stringify(cfg)); configHashes[role] = digest(fs.readFileSync(configFile))
  start(path.join(here, '.build/znnd'), ['--data', data, '--config', configFile], `${role}.log`, { ZNN_DEVNET_BRIDGE: '1', ZNN_BRIDGE_ADMIN: 'z1qq6eg8n43g032hanpsfp02qcdmv7zfj3y2lt5d', GOMAXPROCS: '2', GOMEMLIMIT: '256MiB' })
}
start(anvil, ['--host', '127.0.0.1', '--port', '46545', '--chain-id', String(pins.chainIds.evm), '--block-time', '1', '--silent'], 'anvil.log')
fs.writeFileSync(path.join(root, 'run-manifest.json'), JSON.stringify({ sourceCommit: manifest.sourceCommit, sourceTree: manifest.sourceTree, buildKey: manifest.key, znndHash: manifest.binaryHash, anvilHash: digest(fs.readFileSync(anvil)), anvilVersion, genesisHash: digest(fs.readFileSync(path.join(assets, 'genesis.json'))), configHashes, startedAt: new Date().toISOString(), chainIds: pins.chainIds }, null, 2))
console.log('Pinned native bridge lab started on loopback; verify chain readiness before fixture writes.')
await Promise.all(children.map((child) => new Promise((resolve) => child.once('exit', resolve))))
process.exitCode = failed ? 1 : 0
