#!/usr/bin/env node
/**
 * 一键发版脚本。原则：所有能拒绝发版的事，都在不可逆动作（改版本 / 提交 / 打 tag / push）之前完成。
 *
 *   node scripts/release.mjs 0.6.0
 *   node scripts/release.mjs patch|minor|major
 *   node scripts/release.mjs 0.6.0 --dry-run     只跑守卫，不改任何东西
 *
 * 本脚本**不发布**：push 出 v* tag 后由 .github/workflows/release.yml 唯一执行 npm publish
 * 与 GitHub Release，避免本地与 CI 双发竞争。tag 之前请先确认 CI 在 main 上是绿的。
 *
 * 退出码：0 成功或 --dry-run 通过；1 任一守卫拒绝（stderr 带原因）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractReleaseNotes } from './release-notes.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`\nRelease stopped: ${message}\n`)
  process.exit(1)
}

/** 统一捕获 stdout/stderr，让 git 的拒绝理由原样出现在报错里。 */
function git(args, { allowFailure = false } = {}) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
  if (result.error) fail(`无法运行 git：${result.error.message}`)
  if (result.status !== 0 && !allowFailure) {
    fail(`git ${args.join(' ')} 失败：${(result.stderr || result.stdout || '').trim()}`)
  }
  return { ok: result.status === 0, out: (result.stdout ?? '').trim(), err: (result.stderr ?? '').trim() }
}

function parseArgs(argv) {
  const options = { version: undefined, dryRun: false, branch: 'main', remote: 'origin' }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--branch') options.branch = argv[++index] ?? fail('--branch 需要参数')
    else if (arg === '--remote') options.remote = argv[++index] ?? fail('--remote 需要参数')
    else if (arg.startsWith('--')) fail(`未知参数 ${arg}`)
    else if (options.version === undefined) options.version = arg
    else fail(`多余的参数 ${arg}`)
  }
  return options
}

function nextVersion(current, requested) {
  const parts = current.split('.').map(Number)
  if (parts.length !== 3 || parts.some(part => !Number.isInteger(part))) fail(`package.json 版本不是 x.y.z：${current}`)
  const [major, minor, patch] = parts
  if (requested === 'major') return `${major + 1}.0.0`
  if (requested === 'minor') return `${major}.${minor + 1}.0`
  if (requested === 'patch') return `${major}.${minor}.${patch + 1}`
  if (!/^\d+\.\d+\.\d+$/.test(requested)) fail(`"${requested}" 既不是版本号也不是 patch/minor/major`)
  const [na, nb, nc] = requested.split('.').map(Number)
  const forward = na > major || (na === major && (nb > minor || (nb === minor && nc > patch)))
  if (!forward) fail(`"${requested}" 不高于当前版本 ${current}`)
  return requested
}

const options = parseArgs(process.argv.slice(2))
if (!options.version) fail('用法：node scripts/release.mjs <x.y.z|patch|minor|major> [--dry-run] [--branch main] [--remote origin]')

const pkgPath = join(root, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const next = nextVersion(pkg.version, options.version)
const tag = `v${next}`

// ── 守卫：任何一条不满足都不碰工作树 ────────────────────────────────────────────
// 只看已跟踪改动：本地笔记、日志、临时目录不该拦住发版。未跟踪的 lib/ 新产物由 CI 的
// 「构建后 git status 校验」兜住，那里才是产物完整性的权威检查。
const status = git(['status', '--porcelain', '--untracked-files=no']).out
if (status) fail(`工作树有未提交改动，先提交再发版：\n${status}`)

const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out
if (branch !== options.branch) fail(`当前在 ${branch}，发版只允许 ${options.branch}`)

if (git(['tag', '--list', tag]).out) fail(`本地已存在 tag ${tag}`)

git(['fetch', options.remote, options.branch])
const upstream = `${options.remote}/${options.branch}`
if (!git(['merge-base', '--is-ancestor', upstream, 'HEAD'], { allowFailure: true }).ok) {
  fail(`本地 ${options.branch} 落后或偏离 ${upstream}，先同步`)
}
if (git(['ls-remote', '--tags', options.remote, `refs/tags/${tag}`]).out) fail(`远端已存在 tag ${tag}`)

// 与 CI 用同一个抽取函数：本地放行而 CI 拒绝，意味着 tag 已推出去才红灯。
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8')
if (extractReleaseNotes(changelog, next) === null) {
  fail(`CHANGELOG.md 缺少 "## ${next}" 段或段内容为空；release workflow 用它生成 Release notes`)
}

if (options.dryRun) {
  console.log(`\n[dry-run] 守卫全部通过：${pkg.version} → ${next}，将提交、打 ${tag} 并推送到 ${options.remote}/${options.branch}。未做任何改动。\n`)
  process.exit(0)
}

// ── 不可逆动作 ────────────────────────────────────────────────────────────────
pkg.version = next
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
// 锁文件根版本与 package.json 同步，和 npm version 的行为一致；否则发布提交留下过期锁文件。
const lockPath = join(root, 'package-lock.json')
const staged = ['package.json', 'CHANGELOG.md']
if (existsSync(lockPath)) {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'))
  lock.version = next
  if (lock.packages?.['']) lock.packages[''].version = next
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`)
  staged.push('package-lock.json')
}

git(['add', ...staged])
git(['commit', '-m', `发布：${tag}`])
git(['tag', tag])
// --atomic：分支被拒（远端已前进）时 tag 也不落地，否则 CI 会发布一个不在 main 上的提交。
git(['push', '--atomic', options.remote, `HEAD:refs/heads/${options.branch}`, `refs/tags/${tag}`])

console.log(`\n已提交并推送 ${tag}。.github/workflows/release.yml 会用同一段 CHANGELOG 发布 npm 并建 GitHub Release。\n`)
