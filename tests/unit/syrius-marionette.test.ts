import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { EventEmitter } from 'node:events'
import { connectMarionette, launchFirefox, readMarionettePort } from '../../e2e/syrius/marionette.mjs'

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
const roots: string[] = [], servers: net.Server[] = [], sockets: net.Socket[] = []
const frame = (value: unknown) => { const body = Buffer.from(JSON.stringify(value)); return Buffer.concat([Buffer.from(`${body.length}:`), body]) }
const root = () => { const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'syrius-marionette-')); roots.push(dir); return dir }
async function server(handler: (socket: net.Socket) => void) {
  const peer = net.createServer((socket) => { sockets.push(socket); socket.on('error', () => {}); handler(socket) })
  servers.push(peer)
  await new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', resolve))
  return (peer.address() as net.AddressInfo).port
}
function processStub() {
  return Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null, kill: vi.fn() })
}
afterEach(async () => {
  vi.useRealTimers(); vi.restoreAllMocks(); mocks.spawn.mockReset()
  for (const socket of sockets.splice(0)) socket.destroy()
  for (const peer of servers.splice(0)) await new Promise<void>((resolve) => peer.close(() => resolve()))
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('Firefox profile and Marionette connection ownership', () => {
  it('reads only a bounded regular decimal port file', () => {
    const dir = root(), file = path.join(dir, 'MarionetteActivePort')
    expect(readMarionettePort(dir)).toBeNull()
    for (const value of ['1', '2828', '65535']) { fs.writeFileSync(file, value); expect(readMarionettePort(dir)).toBe(Number(value)) }
    for (const value of ['0', '65536', '-1', '2828\n', '02828', '{}', '1'.repeat(6), '', '\u00b1']) { fs.writeFileSync(file, value); expect(() => readMarionettePort(dir)).toThrow('owned Marionette port file') }
  })

  it('refuses linked port files', () => {
    const dir = root(), target = path.join(dir, 'target'), file = path.join(dir, 'MarionetteActivePort')
    fs.writeFileSync(target, '2828'); fs.symlinkSync(target, file)
    expect(() => readMarionettePort(dir)).toThrow()
    fs.unlinkSync(file); fs.linkSync(target, file)
    expect(() => readMarionettePort(dir)).toThrow()
  })

  it('refuses existing profiles and explicit fixed-port overrides before spawning', async () => {
    const dir = root(), profile = path.join(dir, 'profile')
    fs.mkdirSync(profile); fs.writeFileSync(path.join(profile, 'retained.txt'), 'fixture')
    await expect(launchFirefox({ profile })).rejects.toThrow('fresh label')
    await expect(launchFirefox({ profile: path.join(dir, 'new'), port: 2828 })).rejects.toThrow('profile-assigned')
    await expect(launchFirefox({ profile: path.join(dir, 'new'), prefs: { 'marionette.port': 2828 } })).rejects.toThrow('profile-assigned')
    expect(mocks.spawn).not.toHaveBeenCalled()
    expect(fs.readFileSync(path.join(profile, 'retained.txt'), 'utf8')).toBe('fixture')
  })

  it('uses the port published in its own fresh profile and requires a Gecko greeting', async () => {
    const port = await server((socket) => socket.write(frame({ applicationType: 'gecko', marionetteProtocol: 3 })))
    const profile = path.join(root(), 'profile'), proc = processStub()
    mocks.spawn.mockImplementation(() => { fs.writeFileSync(path.join(profile, 'MarionetteActivePort'), String(port)); return proc })
    const launched = await launchFirefox({ profile })
    try {
      expect(launched.proc).toBe(proc)
      expect(fs.readFileSync(path.join(profile, 'user.js'), 'utf8')).toContain('user_pref("marionette.port", 0);')
      expect(mocks.spawn).toHaveBeenCalledTimes(1)
    } finally { launched.client.close() }
  })

  it('does not connect to the default port when its owned child exits without publishing one', async () => {
    vi.useFakeTimers()
    const connect = vi.spyOn(net, 'connect'), proc = processStub()
    mocks.spawn.mockImplementation(() => { queueMicrotask(() => { proc.exitCode = 1; proc.emit('exit', 1) }); return proc })
    const checked = expect(launchFirefox({ profile: path.join(root(), 'profile') })).rejects.toThrow('did not start')
    await vi.advanceTimersByTimeAsync(500); await checked
    expect(connect).not.toHaveBeenCalled()
    connect.mockRestore()
  })

  it('bounds a child that stays alive without publishing a port and kills only that child', async () => {
    vi.useFakeTimers()
    const connect = vi.spyOn(net, 'connect'), proc = processStub()
    mocks.spawn.mockReturnValue(proc)
    const checked = expect(launchFirefox({ profile: path.join(root(), 'profile') })).rejects.toThrow('did not start')
    await vi.advanceTimersByTimeAsync(30000); await checked
    expect(proc.kill).toHaveBeenCalledTimes(1); expect(connect).not.toHaveBeenCalled()
    connect.mockRestore()
  })

  it('rejects malformed greetings and oversized or invalid frame headers', async () => {
    for (const bytes of [frame({ applicationType: 'other', marionetteProtocol: 3 }), frame({ applicationType: 'gecko', marionetteProtocol: 2 }), Buffer.from('x:{}'), Buffer.from('16777217:'), Buffer.from('999999999')]) {
      const port = await server((socket) => socket.write(bytes))
      await expect(connectMarionette(port)).rejects.toThrow('connection closed')
    }
  })

  it('handles fragmented replies and rejects pending requests when the peer closes', async () => {
    const port = await server((socket) => {
      const greeting = frame({ applicationType: 'gecko', marionetteProtocol: 3 })
      socket.write(greeting.subarray(0, 2)); setImmediate(() => socket.write(greeting.subarray(2)))
      let requests = 0
      socket.on('data', () => { if (++requests === 1) socket.write(frame([1, 1, null, { value: 'fixture' }])); else socket.end() })
    })
    const client = await connectMarionette(port)
    try {
      await expect(client.send('WebDriver:GetCurrentURL')).resolves.toEqual({ value: 'fixture' })
      await expect(client.send('WebDriver:GetCurrentURL')).rejects.toThrow('connection closed')
      await expect(client.send('WebDriver:GetCurrentURL')).rejects.toThrow('connection closed')
    } finally { client.close() }
  })
})
