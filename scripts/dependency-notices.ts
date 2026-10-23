import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import type { Plugin, ResolvedConfig } from 'vite'

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
const noticeName = /^(licen[sc]e|copying|notice|ofl)(?:[._-].*)?$/i
const ordered = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
interface LockedPackage { version?: string; dev?: boolean; link?: boolean; license?: string }
interface Notice { source: string; output: string; sha256: string; bytes: Buffer }
interface PackageNotices { packagePath: string; name: string; version: string; license: string; notices: Notice[] }

/** Validate installed, locked non-dev inputs without publishing author or host metadata. */
export function collectDependencyNotices(root: string) {
  root = fs.realpathSync(root)
  const lockBytes = fs.readFileSync(path.join(root, 'package-lock.json'))
  const lock = JSON.parse(lockBytes.toString()) as { lockfileVersion: number; packages: Record<string, LockedPackage> }
  if (![2, 3].includes(lock.lockfileVersion) || !lock.packages) throw new Error('A supported complete npm lockfile is required')
  const entries = Object.entries(lock.packages).filter(([name, entry]) => name && !entry.dev).sort(([a], [b]) => ordered(a, b))
  if (!entries.length || entries.length > 512) throw new Error('Unexpected non-development dependency count')
  const packages: PackageNotices[] = []
  let totalBytes = 0
  for (const [packagePath, entry] of entries) {
    if (!packagePath.startsWith('node_modules/') || packagePath.split('/').some((s) => !s || s === '.' || s === '..') || packagePath.includes('\\') || entry.link) throw new Error('Unqualified dependency path or workspace link')
    const directory = path.join(root, packagePath)
    if (fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('Linked dependency directories require separate notice qualification')
    const packageFile = path.join(directory, 'package.json')
    if (!fs.lstatSync(packageFile).isFile()) throw new Error('Dependency metadata must be a regular file')
    const installed = JSON.parse(fs.readFileSync(packageFile, 'utf8')) as { name: string; version: string; license: string }
    const expectedName = packagePath.split('/node_modules/').at(-1)!.replace(/^node_modules\//, '')
    if (installed.name !== expectedName || installed.version !== entry.version || typeof installed.license !== 'string' || installed.license !== entry.license) throw new Error(`Installed dependency metadata differs from the lockfile: ${packagePath}`)
    const names = fs.readdirSync(directory).filter((name) => noticeName.test(name)).sort(ordered)
    if (!names.length || names.length > 16) throw new Error(`Missing or excessive dependency notices: ${packagePath}`)
    if (names.some((name) => !/^[a-z0-9._-]+$/i.test(name)) || new Set(names.map((name) => name.toLowerCase())).size !== names.length) throw new Error(`Non-portable or colliding notice names: ${packagePath}`)
    const notices = names.map((name): Notice => {
      const file = path.join(directory, name), stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.nlink !== 1 || stat.size === 0 || stat.size > 256 * 1024) throw new Error(`Unqualified dependency notice: ${packagePath}/${name}`)
      const bytes = fs.readFileSync(file)
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      totalBytes += bytes.length
      if (totalBytes > 8 * 1024 * 1024) throw new Error('Dependency notices exceed the supported size')
      return { source: `${packagePath}/${name}`, output: `packages/${packagePath.slice('node_modules/'.length)}/${name}`, sha256: sha(bytes), bytes }
    })
    packages.push({ packagePath, name: installed.name, version: installed.version, license: installed.license, notices })
  }
  return { lockfileSha256: sha(lockBytes), packages }
}

export function writeDependencyNotices(root: string, output: string) {
  // Validate every input first. Never erase an existing or unknown output directory.
  const collected = collectDependencyNotices(root)
  fs.mkdirSync(output)
  for (const item of collected.packages) for (const notice of item.notices) {
    const destination = path.join(output, notice.output)
    fs.mkdirSync(path.dirname(destination), { recursive: true })
    fs.writeFileSync(destination, notice.bytes, { flag: 'wx' })
  }
  const manifest = {
    schema: 1,
    scope: 'All exact locked non-development packages; a conservative notice set, not a claim that every package is bundled',
    lockfileSha256: collected.lockfileSha256,
    packages: collected.packages.map(({ packagePath, name, version, license, notices }) => ({ packagePath, name, version, license,
      notices: notices.map(({ source, output, sha256, bytes }) => ({ source, output, sha256, bytes: bytes.length })),
    })),
  }
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' })
  fs.writeFileSync(path.join(output, 'README.txt'), [
    'Third-party notices', '',
    'These files preserve exact installed dependency and font notice texts, including required upstream attribution.',
    'The manifest binds their bytes and versions to the npm lockfile. The set may include packages absent from the final JavaScript bundle.',
    'These third-party terms do not select a license for application source or assets. Root licensing and distribution acceptance remain separate maintainer decisions.', '',
  ].join('\n'), { flag: 'wx' })
  return manifest
}

/** Covers CLI and programmatic Vite production builds, including browser qualification. */
export function dependencyNoticesPlugin(): Plugin {
  let config: ResolvedConfig
  return { name: 'locked-dependency-notices', apply: 'build',
    configResolved(value) { config = value },
    writeBundle() { writeDependencyNotices(config.root, path.resolve(config.root, config.build.outDir, 'third-party-notices')) },
  }
}
