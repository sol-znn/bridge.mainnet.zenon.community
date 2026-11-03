import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appAssetRoot, openAppAsset } from '../../e2e/syrius/app-assets.mjs'

const roots: string[] = []
function fixture() {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'syrius-assets-'))
  roots.push(dir)
  const build = path.join(dir, 'build'), sibling = path.join(dir, 'build-private')
  fs.mkdirSync(build); fs.mkdirSync(sibling)
  fs.writeFileSync(path.join(build, 'index.html'), '<p>fixture</p>')
  fs.writeFileSync(path.join(build, 'style.css'), 'p { color: red }')
  fs.writeFileSync(path.join(sibling, 'secret.txt'), 'outside fixture')
  return { dir, build, sibling }
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }) })

describe('Syrius app lab static assets', () => {
  it('serves an opened regular asset with its exact content type and length', () => {
    const { build } = fixture(), root = appAssetRoot(build)
    for (const [target, type, text] of [['/', 'text/html', '<p>fixture</p>'], ['/style.css?cache=1', 'text/css', 'p { color: red }']]) {
      const asset = openAppAsset(root, target)
      expect(asset).not.toBeNull()
      try { expect(asset?.type).toBe(type); expect(asset?.bytes).toBe(Buffer.byteLength(text)); expect(fs.readFileSync(asset!.fd, 'utf8')).toBe(text) }
      finally { if (asset) fs.closeSync(asset.fd) }
    }
  })

  it('refuses common-prefix siblings and encoded traversal', () => {
    const { build } = fixture()
    for (const target of ['/..%2fbuild-private/secret.txt', '/%2e%2e%2fbuild-private/secret.txt', '/%2f..%2fbuild-private/secret.txt', '/..%5cbuild-private/secret.txt']) expect(openAppAsset(build, target)).toBeNull()
  })

  it('refuses malformed requests, directories, missing assets and unlisted file types', () => {
    const { build } = fixture()
    fs.mkdirSync(path.join(build, 'folder.js'))
    fs.writeFileSync(path.join(build, 'private.key'), 'not served')
    for (const target of [undefined, '', '//example.invalid/index.html', 'http://example.invalid/', '/%', '/%00.html', '/folder.js', '/missing.js', '/private.key', '/' + 'x'.repeat(8192)]) expect(openAppAsset(build, target)).toBeNull()
  })

  it('refuses symbolic links, linked ancestors and hard-linked files', () => {
    const { dir, build, sibling } = fixture()
    fs.symlinkSync(path.join(sibling, 'secret.txt'), path.join(build, 'link.txt'))
    fs.symlinkSync(sibling, path.join(build, 'linked'), 'dir')
    fs.linkSync(path.join(sibling, 'secret.txt'), path.join(build, 'hard.txt'))
    fs.symlinkSync(build, path.join(dir, 'alias'), 'dir')
    expect(() => appAssetRoot(path.join(dir, 'alias'))).toThrow()
    for (const target of ['/link.txt', '/linked/secret.txt', '/hard.txt']) expect(openAppAsset(build, target)).toBeNull()
  })

  it('refuses oversized regular assets and a replaced build root', () => {
    const { dir, build } = fixture()
    const fd = fs.openSync(path.join(build, 'large.js'), 'wx')
    try { fs.ftruncateSync(fd, 32 * 1024 * 1024 + 1) } finally { fs.closeSync(fd) }
    expect(openAppAsset(build, '/large.js')).toBeNull()
    fs.renameSync(build, path.join(dir, 'retained'))
    fs.symlinkSync(path.join(dir, 'retained'), build, 'dir')
    expect(openAppAsset(build, '/index.html')).toBeNull()
  })
})
