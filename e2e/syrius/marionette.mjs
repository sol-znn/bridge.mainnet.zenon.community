import net from 'node:net'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createResultsDirectory } from './lab-safety.mjs'

// Firefox publishes the system-assigned port inside its newly created profile.
// Never probe the default port: another browser may own it.
export function readMarionettePort(profile) {
  const file = path.join(profile, 'MarionetteActivePort')
  let fd
  try {
    const expected = fs.lstatSync(file)
    if (!expected.isFile() || expected.nlink !== 1 || expected.size < 1 || expected.size > 5) throw new Error()
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0))
    const stat = fs.fstatSync(fd)
    if (stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error()
    const bytes = Buffer.alloc(6)
    const count = fs.readSync(fd, bytes, 0, 6, 0)
    const value = bytes.subarray(0, count).toString('utf8')
    if (!/^[1-9][0-9]{0,4}$/.test(value) || Number(value) > 65535) throw new Error()
    return Number(value)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw new Error('Invalid owned Marionette port file')
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}

export async function launchFirefox({ profile, port = 0, prefs = {} }) {
  if (port !== 0 || Object.keys(prefs).some((name) => name.startsWith('marionette.'))) throw new Error('Marionette requires a profile-assigned port')
  profile = createResultsDirectory(path.basename(profile), path.dirname(path.resolve(profile)))
  const all = { 'marionette.port': port, 'xpinstall.signatures.required': false, 'browser.shell.checkDefaultBrowser': false,
    'datareporting.policy.dataSubmissionEnabled': false, 'browser.startup.homepage_override.mstone': 'ignore', 'extensions.autoDisableScopes': 0, ...prefs }
  fs.writeFileSync(`${profile}/user.js`, Object.entries(all).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n'), { flag: 'wx', mode: 0o600 })
  const proc = spawn(process.env.FIREFOX_PATH || '/usr/bin/firefox-esr', ['--marionette', '-remote-allow-system-access', '--headless', '--no-remote', '--profile', profile, '--width', '1280', '--height', '900'], { stdio: 'ignore' })
  let stopped = false
  proc.once('error', () => { stopped = true })
  proc.once('exit', () => { stopped = true })
  const alive = () => !stopped && proc.exitCode === null && proc.signalCode === null
  try {
    for (let i = 0; i < 60 && alive(); i++) {
      const assigned = readMarionettePort(profile)
      if (assigned !== null) {
        let client
        try { client = await connectMarionette(assigned) } catch { /* Firefox may still be binding its assigned port. */ }
        if (client && alive()) return { proc, client }
        client?.close()
      }
      if (alive()) await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error('Owned Marionette browser did not start')
  } catch (error) {
    if (alive()) proc.kill()
    throw error
  }
}

export function connectMarionette(port) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1')
    let buf = Buffer.alloc(0), greeted = false, next = 1
    const waiting = new Map()
    const fail = () => {
      const error = new Error('Owned Marionette connection closed')
      clearTimeout(greetingTimer)
      reject(error)
      for (const pending of waiting.values()) { clearTimeout(pending.timer); pending.reject(error) }
      waiting.clear()
      sock.destroy()
    }
    const greetingTimer = setTimeout(fail, 2000)
    sock.on('error', fail)
    sock.on('close', fail)
    sock.on('data', (d) => {
      try {
      buf = Buffer.concat([buf, d])
      for (;;) {
        const colon = buf.indexOf(58)
        if (colon < 0) { if (buf.length > 8) throw new Error(); return }
        if (!/^[1-9][0-9]{0,7}$/.test(buf.subarray(0, colon).toString('ascii'))) throw new Error()
        const len = Number(buf.subarray(0, colon).toString())
        if (len > 16 * 1024 * 1024) throw new Error()
        if (buf.length < colon + 1 + len) return
        const msg = JSON.parse(buf.subarray(colon + 1, colon + 1 + len).toString())
        buf = buf.subarray(colon + 1 + len)
        if (!greeted) {
          if (msg?.applicationType !== 'gecko' || msg.marionetteProtocol !== 3) throw new Error()
          greeted = true; clearTimeout(greetingTimer); resolve(client); continue
        }
        if (!Array.isArray(msg) || msg.length !== 4 || msg[0] !== 1) throw new Error()
        const [, id, error, result] = msg
        const w = waiting.get(id); waiting.delete(id)
        if (!w) continue
        clearTimeout(w.timer)
        if (error) w.reject(Object.assign(new Error(`${error.error}: ${error.message}`), { mn: error }))
        else w.resolve(result)
      }
      } catch { fail() }
    })
    const client = {
      send(name, params = {}) {
        if (sock.destroyed) return Promise.reject(new Error('Owned Marionette connection closed'))
        const id = next++
        const body = Buffer.from(JSON.stringify([0, id, name, params]))
        return new Promise((res, rej) => {
          waiting.set(id, { resolve: res, reject: rej, timer: setTimeout(fail, 900000) })
          sock.write(Buffer.concat([Buffer.from(`${body.length}:`), body]))
        })
      },
      close() { sock.destroy() },
    }
  })
}

export function session(c) {
  const s = {
    start: () => c.send('WebDriver:NewSession', { capabilities: { alwaysMatch: { acceptInsecureCerts: true } } }),
    context: (value) => c.send('Marionette:SetContext', { value }),
    install: (path) => c.send('Addon:Install', { path, temporary: true }),
    exec: async (body, args = []) => (await c.send('WebDriver:ExecuteScript', { script: body, args, sandbox: null }))?.value,
    execAsync: async (body, args = [], timeout = 60000) => (await c.send('WebDriver:ExecuteAsyncScript', { script: body, args, scriptTimeout: timeout }))?.value,
    go: (url) => c.send('WebDriver:Navigate', { url }),
    url: async () => (await c.send('WebDriver:GetCurrentURL'))?.value,
    handles: async () => (await c.send('WebDriver:GetWindowHandles')) ?? [],
    handle: async () => (await c.send('WebDriver:GetWindowHandle'))?.value,
    switchTo: (handle) => c.send('WebDriver:SwitchToWindow', { handle, focus: true }),
    newTab: async () => (await c.send('WebDriver:NewWindow', { type: 'tab' })).handle,
    close: () => c.send('WebDriver:CloseWindow'),
    shot: async (file) => { const r = await c.send('WebDriver:TakeScreenshot', { full: false, hash: false }); fs.writeFileSync(file, Buffer.from(r.value, 'base64')) },
    text: () => s.exec('return document.body ? document.body.innerText : ""'),
  }
  return s
}
