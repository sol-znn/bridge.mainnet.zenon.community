import fs from 'node:fs'
import path from 'node:path'

const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ico': 'image/x-icon',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.txt': 'text/plain',
}

export function appAssetRoot(value) {
  if (typeof value !== 'string' || !value) throw new Error('Set an isolated app build directory')
  const root = path.resolve(value)
  if (!fs.lstatSync(root).isDirectory() || fs.realpathSync(root) !== root) throw new Error('App build directory must be a regular directory')
  return root
}

export function openAppAsset(root, target) {
  let fd
  try {
    if (typeof target !== 'string' || target.length > 8192 || !target.startsWith('/') || target.startsWith('//') || /[\\\x00-\x20\x7f]/.test(target)) return null
    const pathname = decodeURIComponent(new URL(target, 'http://127.0.0.1').pathname)
    if (/[\\\x00]/.test(pathname)) return null
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
    const relative = path.relative(root, file)
    if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) return null
    const type = types[path.extname(file)]
    if (!type) return null
    const rootStat = fs.lstatSync(root)
    if (!rootStat.isDirectory() || fs.realpathSync(root) !== root) return null
    let component = root
    let expected
    for (const name of relative.split(path.sep)) {
      component = path.join(component, name)
      const stat = fs.lstatSync(component)
      if (component === file) { if (!stat.isFile() || stat.nlink !== 1) return null; expected = stat }
      else if (!stat.isDirectory()) return null
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | (fs.constants.O_NOFOLLOW || 0))
    const stat = fs.fstatSync(fd)
    const currentRoot = fs.lstatSync(root)
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024 ||
        stat.dev !== expected.dev || stat.ino !== expected.ino ||
        rootStat.dev !== currentRoot.dev || rootStat.ino !== currentRoot.ino ||
        fs.realpathSync(file) !== file) { fs.closeSync(fd); return null }
    return { fd, type, bytes: stat.size }
  } catch {
    if (fd !== undefined) fs.closeSync(fd)
    return null
  }
}
