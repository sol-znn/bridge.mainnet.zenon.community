import fs from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { collectDependencyNotices, writeDependencyNotices } from '../../scripts/dependency-notices.ts'

const roots: string[] = []
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), 'bridge-notices-'))); roots.push(root)
  const packages: Record<string, any> = { '': {}, 'node_modules/dev-only': { version: '1', dev: true } }
  for (const [name, license] of [['fixture-package', 'MIT'], ['@fixture/font', 'OFL-1.1']]) {
    const location = `node_modules/${name}`, directory = path.join(root, location)
    fs.mkdirSync(directory, { recursive: true })
    fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', license, author: 'PRIVATE_METADATA_MARKER' }))
    fs.writeFileSync(path.join(directory, 'LICENSE'), Buffer.from('Required upstream fixture attribution.\r\nLicense text.\r\n'))
    packages[location] = { version: '1.0.0', license }
  }
  fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }))
  return root
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true }) })
describe('locked distribution notice completeness', () => {
  it('retains font and dependency notice bytes, exact versions and deterministic hashes without author or host metadata', () => {
    const root = fixture(), a = path.join(root, 'output-a'), b = path.join(root, 'output-b')
    fs.writeFileSync(path.join(root, 'node_modules/fixture-package/NOTICE.txt'), 'Additional required fixture notice.\n')
    const manifest = writeDependencyNotices(root, a)
    expect(manifest.packages).toHaveLength(2)
    expect(manifest.packages.some((p) => p.license === 'OFL-1.1')).toBe(true)
    expect(manifest.lockfileSha256).toBe(sha(fs.readFileSync(path.join(root, 'package-lock.json'))))
    for (const item of manifest.packages) for (const notice of item.notices) {
      const bytes = fs.readFileSync(path.join(a, notice.output))
      expect(bytes).toEqual(fs.readFileSync(path.join(root, notice.source)))
      expect(sha(bytes)).toBe(notice.sha256)
    }
    expect(JSON.stringify(manifest)).not.toContain('PRIVATE_METADATA_MARKER')
    expect(JSON.stringify(manifest)).not.toContain(root)
    expect(writeDependencyNotices(root, b)).toEqual(manifest)
    expect(fs.readFileSync(path.join(a, 'manifest.json'))).toEqual(fs.readFileSync(path.join(b, 'manifest.json')))
  })
  it.each(['name', 'version', 'license'])('refuses substituted installed %s before creating output', (field) => {
    const root = fixture(), file = path.join(root, 'node_modules/fixture-package/package.json')
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8')); pkg[field] = 'substituted'; fs.writeFileSync(file, JSON.stringify(pkg))
    expect(() => writeDependencyNotices(root, path.join(root, 'output'))).toThrow('differs')
    expect(fs.existsSync(path.join(root, 'output'))).toBe(false)
  })
  it('refuses missing notice text instead of distributing only metadata', () => {
    const root = fixture(); fs.unlinkSync(path.join(root, 'node_modules/fixture-package/LICENSE'))
    expect(() => collectDependencyNotices(root)).toThrow('Missing')
  })
  it('refuses notice symlinks without copying an arbitrary file', () => {
    const root = fixture(), file = path.join(root, 'node_modules/fixture-package/LICENSE')
    fs.unlinkSync(file); fs.symlinkSync(path.join(root, 'package-lock.json'), file)
    expect(() => collectDependencyNotices(root)).toThrow('Unqualified')
  })
  it('refuses linked dependency directories', () => {
    const root = fixture(), source = path.join(root, 'node_modules/fixture-package'), target = path.join(root, 'relocated')
    fs.renameSync(source, target); fs.symlinkSync(target, source)
    expect(() => collectDependencyNotices(root)).toThrow('Linked')
  })
  it.each(['node_modules/../outside', '/outside', 'node_modules\\outside'])('refuses unsafe locked path %s before reading it', (unsafe) => {
    const root = fixture(), file = path.join(root, 'package-lock.json'), lock = JSON.parse(fs.readFileSync(file, 'utf8'))
    lock.packages[unsafe] = { version: '1.0.0' }; fs.writeFileSync(file, JSON.stringify(lock))
    expect(() => collectDependencyNotices(root)).toThrow('path')
  })
  it('refuses workspace links and unsupported lock formats', () => {
    const root = fixture(), file = path.join(root, 'package-lock.json'), lock = JSON.parse(fs.readFileSync(file, 'utf8'))
    lock.packages['node_modules/fixture-package'].link = true; fs.writeFileSync(file, JSON.stringify(lock))
    expect(() => collectDependencyNotices(root)).toThrow('link')
    lock.lockfileVersion = 1; fs.writeFileSync(file, JSON.stringify(lock)); expect(() => collectDependencyNotices(root)).toThrow('lockfile')
  })
  it.each([Buffer.alloc(0), Buffer.alloc(256 * 1024 + 1), Buffer.from([255])])('refuses empty, oversized or non-UTF-8 notice text', (bytes) => {
    const root = fixture(); fs.writeFileSync(path.join(root, 'node_modules/fixture-package/LICENSE'), bytes)
    expect(() => collectDependencyNotices(root)).toThrow()
  })
  it('preserves pre-existing output and unknown files', () => {
    const root = fixture(), output = path.join(root, 'output'); fs.mkdirSync(output); fs.writeFileSync(path.join(output, 'keep'), 'original')
    expect(() => writeDependencyNotices(root, output)).toThrow()
    expect(fs.readFileSync(path.join(output, 'keep'), 'utf8')).toBe('original')
    expect(fs.readdirSync(output)).toEqual(['keep'])
  })
  it('refuses non-portable notice names before writing an artifact', () => {
    const root = fixture(); fs.writeFileSync(path.join(root, 'node_modules/fixture-package/LICENSE.extra:stream'), 'fixture')
    expect(() => collectDependencyNotices(root)).toThrow('Non-portable')
  })
})
