/**
 * 发版脚本的真实验证：临时目录里建真 git 仓与裸远端，跑真脚本、真 commit、真 push。
 * 覆盖两类事故：守卫漏挡（脏工作树、错分支、版本不前进、CHANGELOG 缺段、tag 重名）与
 * "守卫没挡住就动手"（失败用例必须保持版本/tag/远端完全不变）。
 */
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'

const releaseScript = fileURLToPath(new URL('../scripts/release.mjs', import.meta.url))
const notesScript = fileURLToPath(new URL('../scripts/release-notes.mjs', import.meta.url))
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr || result.stdout}`)
  return (result.stdout ?? '').trim()
}

/** 一个能直接发版的仓库：main、干净工作树、裸远端、带三段的 CHANGELOG。 */
async function makeRepo() {
  const base = await mkdtemp(join(tmpdir(), 'tavern-release-'))
  const work = join(base, 'work')
  const bare = join(base, 'origin.git')
  await mkdir(join(work, 'scripts'), { recursive: true })
  await cp(releaseScript, join(work, 'scripts', 'release.mjs'))
  await cp(notesScript, join(work, 'scripts', 'release-notes.mjs'))
  await writeFile(join(work, 'package.json'), `${JSON.stringify({ name: 'dsh-liketavern', version: '0.5.5' }, null, 2)}\n`)
  await writeFile(join(work, 'CHANGELOG.md'), [
    '# 更新日志', '', '## 未发布', '', '- 进行中的条目', '',
    '## 0.5.6（2026-10-22）', '', '- 新版本条目', '',
    '## 0.5.5（2026-10-20）', '', '- 旧版本条目', '',
  ].join('\n'))
  git(work, 'init', '-b', 'main')
  git(work, 'config', 'user.email', 'release@example.test')
  git(work, 'config', 'user.name', 'Release Test')
  git(work, 'add', '-A')
  git(work, 'commit', '-m', '初始提交')
  git(base, 'init', '--bare', bare)
  git(work, 'remote', 'add', 'origin', pathToFileURL(bare).href)
  git(work, 'push', '-u', 'origin', 'main')
  return { base, work, bare, remote: pathToFileURL(bare).href }
}

function release(work: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(work, 'scripts', 'release.mjs'), ...args], { cwd: work, encoding: 'utf8' })
}

async function version(work: string): Promise<string> {
  return JSON.parse(await readFile(join(work, 'package.json'), 'utf8')).version as string
}

it('守卫全部通过时：改版本、提交、打 tag、推到裸远端', { timeout: 120_000 }, async () => {
  const repo = await makeRepo()
  try {
    const result = release(repo.work, '0.5.6')
    expect(result.stderr).toBe('')
    expect(result.status).toBe(0)
    expect(await version(repo.work)).toBe('0.5.6')
    expect(git(repo.work, 'log', '-1', '--pretty=%s')).toBe('发布：v0.5.6')
    expect(git(repo.work, 'tag', '--list')).toBe('v0.5.6')
    // 远端真的收到了提交与 tag，而不是只在本机成功。
    expect(git(repo.base, '--git-dir', repo.bare, 'rev-parse', 'main')).toBe(git(repo.work, 'rev-parse', 'HEAD'))
    expect(git(repo.base, '--git-dir', repo.bare, 'tag', '--list')).toBe('v0.5.6')
  } finally {
    await rm(repo.base, { recursive: true, force: true })
  }
})

it('脏工作树被挡在不可逆动作之前', { timeout: 120_000 }, async () => {
  const repo = await makeRepo()
  try {
    await writeFile(join(repo.work, 'CHANGELOG.md'), `${await readFile(join(repo.work, 'CHANGELOG.md'), 'utf8')}\n- 手改\n`)
    const before = git(repo.work, 'rev-parse', 'HEAD')
    const result = release(repo.work, '0.5.6')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('未提交改动')
    expect(await version(repo.work)).toBe('0.5.5')
    expect(git(repo.work, 'tag', '--list')).toBe('')
    expect(git(repo.work, 'rev-parse', 'HEAD')).toBe(before)
  } finally {
    await rm(repo.base, { recursive: true, force: true })
  }
})

it('CHANGELOG 缺本版段时拒绝发版', { timeout: 120_000 }, async () => {
  const repo = await makeRepo()
  try {
    const result = release(repo.work, '0.5.7')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('缺少 "## 0.5.7"')
    expect(git(repo.work, 'tag', '--list')).toBe('')
  } finally {
    await rm(repo.base, { recursive: true, force: true })
  }
})

it('版本不前进时拒绝', { timeout: 120_000 }, async () => {
  const repo = await makeRepo()
  try {
    const backwards = release(repo.work, '0.5.4')
    expect(backwards.status).toBe(1)
    expect(backwards.stderr).toContain('不高于当前版本')
    expect(git(repo.work, 'tag', '--list')).toBe('')
  } finally {
    await rm(repo.base, { recursive: true, force: true })
  }
})

it('同名 tag 已存在时拒绝，且不再产生提交', { timeout: 120_000 }, async () => {
  const repo = await makeRepo()
  try {
    git(repo.work, 'tag', 'v0.5.6')
    const before = git(repo.work, 'rev-parse', 'HEAD')
    const duplicate = release(repo.work, '0.5.6')
    expect(duplicate.status).toBe(1)
    expect(duplicate.stderr).toContain('已存在 tag')
    expect(await version(repo.work)).toBe('0.5.5')
    expect(git(repo.work, 'rev-parse', 'HEAD')).toBe(before)
  } finally {
    await rm(repo.base, { recursive: true, force: true })
  }
})

it('不在 main 分支时拒绝', { timeout: 120_000 }, async () => {
  const repo = await makeRepo()
  try {
    git(repo.work, 'checkout', '-b', 'feature')
    const result = release(repo.work, '0.5.6')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('只允许 main')
    expect(await version(repo.work)).toBe('0.5.5')
  } finally {
    await rm(repo.base, { recursive: true, force: true })
  }
})

it('--dry-run 只跑守卫，不写版本、不提交、不推 tag', { timeout: 120_000 }, async () => {
  const repo = await makeRepo()
  try {
    const before = git(repo.work, 'rev-parse', 'HEAD')
    const result = release(repo.work, '0.5.6', '--dry-run')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('[dry-run]')
    expect(await version(repo.work)).toBe('0.5.5')
    expect(git(repo.work, 'tag', '--list')).toBe('')
    expect(git(repo.work, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(repo.base, '--git-dir', repo.bare, 'tag', '--list')).toBe('')
  } finally {
    await rm(repo.base, { recursive: true, force: true })
  }
})

it('release-notes 从真实 CHANGELOG 抽段，缺段即失败', { timeout: 60_000 }, async () => {
  const base = await mkdtemp(join(tmpdir(), 'tavern-notes-'))
  try {
    const out = join(base, 'notes.md')
    const ok = spawnSync(process.execPath, [notesScript, '0.5.5', 'CHANGELOG.md', out], { cwd: repoRoot, encoding: 'utf8' })
    expect(ok.status).toBe(0)
    const notes = await readFile(out, 'utf8')
    expect(notes.length).toBeGreaterThan(200)
    expect(notes).not.toContain('未发布')

    const missing = spawnSync(process.execPath, [notesScript, '9.9.9', 'CHANGELOG.md', join(base, 'none.md')],
      { cwd: repoRoot, encoding: 'utf8' })
    expect(missing.status).toBe(1)
    expect(missing.stderr).toContain('缺少 "9.9.9"')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
