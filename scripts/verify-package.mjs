/**
 * 发布包边界校验：确认运行产物齐全、发布文档的相对链接均指向包内文件，
 * 同时拒绝白名单外目录越界。实际打包时还生成可审核的 SHA-256。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const dryRun = process.argv.includes('--dry-run')
// CI 已先完成构建与 lib/ 一致性检查；这里禁用生命周期，避免审核包在校验后再次改写产物。
const npmArguments = ['pack', ...(dryRun ? ['--dry-run'] : []), '--json', '--ignore-scripts']
const npmExecPath = process.env.npm_execpath
const npmCommand = npmExecPath
  ? process.execPath
  : process.platform === 'win32'
    ? process.env.ComSpec || 'cmd.exe'
    : 'npm'
const commandArguments = npmExecPath
  ? [npmExecPath, ...npmArguments]
  : process.platform === 'win32'
    ? ['/d', '/s', '/c', 'npm.cmd', ...npmArguments]
    : npmArguments

const output = execFileSync(npmCommand, commandArguments, {
  encoding: 'utf8',
  maxBuffer: 20 * 1024 * 1024,
  windowsHide: true,
})

const jsonStart = output.search(/^\s*\[/m)
if (jsonStart < 0) {
  throw new Error('npm pack 未返回 JSON 文件清单')
}

const records = JSON.parse(output.slice(jsonStart))
if (!Array.isArray(records) || records.length !== 1) {
  throw new Error(`npm pack 返回了 ${Array.isArray(records) ? records.length : '非数组'} 个包，预期为 1 个`)
}

const record = records[0]
if (!record || !Array.isArray(record.files)) {
  throw new Error('npm pack JSON 缺少 files 清单')
}

const files = record.files.map((file) => file.path)
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const required = new Set([
  'lib/index.js',
  'lib/client.js',
  'lib/doctor.js',
  'lib/doctor.d.ts',
  'lib/vendor/template-libraries.js',
  'lib/vendor/template-faker.js',
  'lib/vendor/card-libraries.js',
  'cordis.patch.yml',
  'presets/tavern/agent.cordis.yml',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'LICENSE',
])

/** main / exports / bin 是公开契约：从 manifest 动态纳入，防新增入口忘记进包。 */
function addPackageTarget(value, label) {
  if (typeof value !== 'string') return
  const target = value.replace(/^\.\//, '')
  if (!target || target.startsWith('/') || target.includes('\\') || target.includes(':')
    || target.split('/').some(part => part === '..' || part === '.' || part === '')) {
    throw new Error(`package.json ${label} 含不安全的发布路径`)
  }
  required.add(target)
}

function collectExportTargets(value, label) {
  if (typeof value === 'string') {
    addPackageTarget(value, label)
    return
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  for (const [key, nested] of Object.entries(value)) collectExportTargets(nested, `${label}.${key}`)
}

addPackageTarget(packageJson.main, 'main')
addPackageTarget(packageJson.types, 'types')
if (typeof packageJson.bin === 'string') addPackageTarget(packageJson.bin, 'bin')
else if (packageJson.bin && typeof packageJson.bin === 'object' && !Array.isArray(packageJson.bin)) {
  for (const [name, target] of Object.entries(packageJson.bin)) addPackageTarget(target, `bin.${name}`)
}
collectExportTargets(packageJson.exports, 'exports')
const allowedRootFiles = new Set([
  'package.json',
  'cordis.patch.yml',
  'README.md',
  'README.en.md',
  'CHANGELOG.md',
  'LICENSE',
])

const missing = [...required].filter((file) => !files.includes(file))
const forbidden = files.filter(
  (file) => !allowedRootFiles.has(file) && !file.startsWith('lib/') && !file.startsWith('presets/'),
)
const packagedFiles = new Set(files)
const invalidRelativeLinks = ['README.md', 'README.en.md', 'CHANGELOG.md'].flatMap((markdown) => {
  const source = readFileSync(markdown, 'utf8')
  return [...source.matchAll(/\]\(([^)]+)\)/g)].flatMap((match) => {
    const href = match[1]
    if (/^(?:[a-z][a-z+.-]*:|#|\/\/)/i.test(href)) return []
    const target = href.split(/[?#]/, 1)[0].replace(/^\.\//, '')
    return target && !packagedFiles.has(target) ? [`${markdown}: ${href}`] : []
  })
})
if (missing.length || forbidden.length || invalidRelativeLinks.length) {
  const details = [
    missing.length ? `缺失文件: ${missing.join(', ')}` : '',
    forbidden.length ? `越界文件: ${forbidden.join(', ')}` : '',
    invalidRelativeLinks.length ? `发布文档包含包内不存在的相对链接: ${invalidRelativeLinks.join(', ')}` : '',
  ].filter(Boolean)
  throw new Error(`npm pack 白名单校验失败\n${details.join('\n')}`)
}

if (dryRun) {
  console.log(`npm pack 白名单校验通过，共 ${files.length} 个文件（dry-run）`)
  process.exit(0)
}

if (typeof record.filename !== 'string' || !/^[A-Za-z0-9._-]+\.tgz$/.test(record.filename)) {
  throw new Error('npm pack 返回了不安全的 tarball 文件名')
}

const tarball = path.resolve(record.filename)
if (path.dirname(tarball) !== process.cwd()) {
  throw new Error('npm pack tarball 不在当前工作目录')
}

const digest = createHash('sha256').update(readFileSync(tarball)).digest('hex')
const checksum = `${record.filename}.sha256`
writeFileSync(checksum, `${digest}  ${record.filename}\n`, 'utf8')

if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `tarball=${record.filename}\nchecksum=${checksum}\nsha256=${digest}\n`,
    'utf8',
  )
}

console.log(`npm pack 白名单校验通过，共 ${files.length} 个文件`)
console.log(`待审核包: ${record.filename}`)
console.log(`SHA-256: ${digest}`)
