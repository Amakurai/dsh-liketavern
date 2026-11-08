/** 实际执行发布 workflow 的 Bash：用工厂 gh 替代外部服务，验证附件失败、草稿恢复和公开版本不可覆盖。 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'

const workflow = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'))
const steps = workflow.jobs.release.steps as Array<{ name?: string; run?: string }>
const publish = steps.find(step => step.name === '发布已验证安装包')!.run!
const metadata = steps.find(step => step.name === '校验待发布包并生成说明')!.run!
const ensureTag = steps.find(step => step.name === '创建已验证标签（手动发布）')!.run!
// Windows PATH 上的 bash 可能是 WSL 启动器；定位实际 git 安装携带的 Git Bash。
const bash = process.platform === 'win32'
  ? resolve(spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim(), '../../..', 'bin/bash.exe') : 'bash'

const factoryGh = `
gh() {
  printf '%s\\n' "$1 $2" >> "$CALL_LOG"
  case "$1 $2" in
    'release view')
      if [ "$SCENARIO" = new ]; then return 1; fi
      case "$SCENARIO" in published|changed|missing) echo false;; *) echo true;; esac ;;
    'release create') ;;
    'release upload') if [ "$SCENARIO" = upload-failure ]; then return 42; fi ;;
    'release edit') ;;
    'release download')
      mkdir -p "$RUNNER_TEMP/published"
      cp release-assets/dsh-liketavern-1.2.3.tgz "$RUNNER_TEMP/published/"
      if [ "$SCENARIO" = changed ]; then printf tampered >> "$RUNNER_TEMP/published/dsh-liketavern-1.2.3.tgz"; fi
      if [ "$SCENARIO" != missing ]; then cp release-assets/SHA256SUMS.txt "$RUNNER_TEMP/published/"; fi ;;
    *) return 99 ;;
  esac
}
`

async function fixture(task: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'tavern-release-workflow-'))
  try {
    await mkdir(join(root, 'release-assets'))
    await writeFile(join(root, 'release-assets/dsh-liketavern-1.2.3.tgz'), 'verified factory package')
    const hash = createHash('sha256').update('verified factory package').digest('hex')
    const checksum = `${hash}  dsh-liketavern-1.2.3.tgz\n`
    await writeFile(join(root, 'release-assets/SHA256SUMS.txt'), checksum)
    await writeFile(join(root, 'release-assets/dsh-liketavern-1.2.3.tgz.sha256'), checksum)
    await writeFile(join(root, 'release-title.txt'), 'factory release')
    await writeFile(join(root, 'release-notes.md'), 'factory notes')
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    await writeFile(join(root, 'CHANGELOG.md'), '## 1.2.3\n\n- factory change\n')
    await mkdir(join(root, 'scripts'))
    await cp(new URL('../scripts/release-notes.mjs', import.meta.url), join(root, 'scripts/release-notes.mjs'))
    await task(root)
  } finally { await rm(root, { recursive: true, force: true }) }
}

function run(root: string, script: string, scenario = '', options: { factory?: string; env?: Record<string, string> } = {}) {
  // 统一转成 Git Bash 的 POSIX 路径；仅替换反斜杠会让 mkdir -p 探测 Windows 用户父目录，在受限环境中失败。
  const preparePaths = process.platform === 'win32'
    ? 'RUNNER_TEMP="$(cygpath -u "$RUNNER_TEMP")"\nCALL_LOG="$(cygpath -u "$CALL_LOG")"\n' : ''
  return spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', `${preparePaths}${options.factory ?? factoryGh}\n${script}`], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000,
    env: { ...process.env, SCENARIO: scenario, RELEASE_TAG: 'v1.2.3', RUNNER_TEMP: root.replace(/\\/g, '/'), CALL_LOG: join(root, 'calls.txt').replace(/\\/g, '/'), ...options.env },
  })
}

it.each([
  ['new', ['view', 'create', 'upload', 'edit']],
  ['draft', ['view', 'upload', 'edit']],
  ['published', ['view', 'download']],
] as const)('%s：只有附件就绪后才发布，公开的相同附件可幂等重跑', async (scenario, commands) => {
  await fixture(async root => {
    const result = run(root, publish, scenario)
    expect(result.status, result.stderr || result.error?.message).toBe(0)
    expect((await readFile(join(root, 'calls.txt'), 'utf8')).trim().split('\n')).toEqual(commands.map(command => `release ${command}`))
  })
})

/** 手动入口只允许当前已验证提交：真实 Bash 执行标签创建逻辑，gh 仅记录请求。 */
const tagFactory = `
gh() {
  printf '%s\\n' "$*" >> "$CALL_LOG"
  case "$*" in
    'api repos/factory/repo/git/ref/tags/v1.2.3')
      if [ "$SCENARIO" = new-tag ]; then return 1; fi ;;
    'api repos/factory/repo/commits/v1.2.3 --jq .sha')
      if [ "$SCENARIO" = changed-tag ]; then echo bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb; else echo "$GITHUB_SHA"; fi ;;
    'api --method POST repos/factory/repo/git/refs -f ref=refs/tags/v1.2.3 -f sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') ;;
    *) return 99 ;;
  esac
}
`
const manualEnvironment = { GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'factory/repo', GITHUB_SHA: 'a'.repeat(40) }

it.each(['new-tag', 'existing-tag'])('手动发布 %s：新标签固定当前 SHA，相同标签幂等且不移动', async scenario => {
  await fixture(async root => {
    const result = run(root, ensureTag, scenario, { factory: tagFactory, env: manualEnvironment })
    expect(result.status, result.stderr || result.error?.message).toBe(0)
    const calls = await readFile(join(root, 'calls.txt'), 'utf8')
    expect(calls.includes('--method POST')).toBe(scenario === 'new-tag')
    expect(calls).not.toContain('--method PATCH')
  })
})

it('手动发布遇到指向其他提交的旧标签时拒绝，不覆盖或移动', async () => {
  await fixture(async root => {
    expect(run(root, ensureTag, 'changed-tag', { factory: tagFactory, env: manualEnvironment }).status).not.toBe(0)
    expect(await readFile(join(root, 'calls.txt'), 'utf8')).not.toContain('--method POST')
  })
})

it.each([{ GITHUB_REF: 'refs/heads/another' }, { RELEASE_TAG: 'v9.9.9' }])('手动发布前拒绝错误分支或版本 %j，不创建标签', async invalid => {
  await fixture(async root => {
    expect(run(root, ensureTag, 'new-tag', { factory: tagFactory, env: { ...manualEnvironment, ...invalid } }).status).not.toBe(0)
    await expect(readFile(join(root, 'calls.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

it.each(['upload-failure', 'changed', 'missing'])('%s：附件失败或公开内容不一致时拒绝，不继续发布或覆盖', async scenario => {
  await fixture(async root => {
    const result = run(root, publish, scenario)
    expect(result.status).not.toBe(0)
    const calls = await readFile(join(root, 'calls.txt'), 'utf8')
    expect(calls).not.toContain('release edit')
    if (scenario !== 'upload-failure') expect(calls).not.toContain('release upload')
  })
})

it('真实校验和与版本验证：合法包通过，篡改字节和错 tag 均拒绝', async () => {
  await fixture(async root => {
    expect(run(root, metadata).status).toBe(0)
    await writeFile(join(root, 'release-assets/dsh-liketavern-1.2.3.tgz'), 'tampered factory package')
    expect(run(root, metadata).status).not.toBe(0)
    await writeFile(join(root, 'package.json'), JSON.stringify({ version: '1.2.4' }))
    expect(run(root, metadata).status).not.toBe(0)
  })
})
