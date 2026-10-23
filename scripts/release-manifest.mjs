// Source and unpacked-artifact identity, with no author, host paths or secrets.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex')
const git = (args) => execFileSync('git', args).toString().trim()
const names = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString().split('\0').filter(Boolean))]
  .filter((name) => /^(src\/|public\/|scripts\/|docs\/|tests\/|e2e\/|\.github\/|[^/]+$)/.test(name)).sort()
const inputs = Object.fromEntries(names.filter((name) => fs.existsSync(name) && fs.statSync(name).isFile()).map((name) => [name, sha(fs.readFileSync(name))]))
const artifacts = {}
const outDir = path.resolve(process.argv[2] ?? 'dist')
function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name))) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) collect(file)
    else if (entry.name !== 'release-manifest.json') artifacts[path.relative(outDir, file).split(path.sep).join('/')] = sha(fs.readFileSync(file))
  }
}
collect(outDir)
const result = { schema:1, sourceCommit:git(['rev-parse','HEAD']), sourceTree:git(['rev-parse','HEAD^{tree}']),
  sourceDirty:git(['status','--porcelain']).length > 0, sourceInputsHash:sha(JSON.stringify(inputs)), lockfileHash:sha(fs.readFileSync('package-lock.json')),
  nodeVersion:process.versions.node, artifactTreeHash:sha(JSON.stringify(artifacts)), artifacts }
fs.writeFileSync(path.join(outDir, 'release-manifest.json'), JSON.stringify(result, null, 2)+'\n')
