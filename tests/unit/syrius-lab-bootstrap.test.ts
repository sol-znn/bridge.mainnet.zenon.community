import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const mocks = vi.hoisted(() => ({ launch: vi.fn(), spawn: vi.fn() }))
vi.mock('puppeteer-core', () => ({ default: { launch: mocks.launch } }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
let root: string
const originalArgs = process.argv
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks()
  root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'syrius-bootstrap-'))
  fs.mkdirSync(path.join(root, 'app'))
  process.argv = ['node', 'fixture.mjs', 'run', path.join(root, 'app'), 'fixture-addon']
  vi.stubEnv('RESULTS_DIR', path.join(root, 'results'))
  vi.stubEnv('CHROME_MV2_PATH', '/fixture/chrome')
})
afterEach(() => {
  process.argv = originalArgs; vi.unstubAllEnvs(); vi.unstubAllGlobals()
  fs.rmSync(root, { recursive: true, force: true })
})

describe('Syrius driver refusal before browser or evidence side effects', () => {
  for (const driver of ['matrix.mjs', 'matrix-mv2.mjs', 'matrix-app.mjs', 'matrix-ff.mjs']) {
    it(`${driver} refuses a remote page without contacting any RPC`, async () => {
      vi.stubEnv('BRIDGE_URL', 'http://example.invalid/')
      const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher)
      await expect(import(`../../e2e/syrius/${driver}`)).rejects.toThrow('Isolated wallet lab refused')
      expect(fetcher).not.toHaveBeenCalled()
      expect(mocks.launch).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(root, 'results'))).toBe(false)
    })

    it(`${driver} refuses a mainnet frontier before opening a wallet`, async () => {
      vi.stubEnv('BRIDGE_URL', 'http://127.0.0.1:4174/')
      const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { chainIdentifier: 1, height: 8, hash: 'ab'.repeat(32) } })))
      vi.stubGlobal('fetch', fetcher)
      await expect(import(`../../e2e/syrius/${driver}`)).rejects.toThrow('Isolated wallet lab refused')
      expect(fetcher).toHaveBeenCalledTimes(1)
      expect(mocks.launch).not.toHaveBeenCalled(); expect(mocks.spawn).not.toHaveBeenCalled()
      expect(fs.existsSync(path.join(root, 'results'))).toBe(false)
    })
  }

  it('nodes.mjs refuses a remote page before launching or writing results', async () => {
    vi.stubEnv('BRIDGE_URL', 'http://example.invalid/')
    await expect(import('../../e2e/syrius/' + 'nodes.mjs')).rejects.toThrow('Isolated wallet lab refused')
    expect(mocks.launch).not.toHaveBeenCalled()
    expect(fs.existsSync(path.join(root, 'results'))).toBe(false)
  })
})
