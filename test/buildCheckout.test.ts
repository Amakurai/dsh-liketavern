/** 用真实 Git 首次检出与 workflow 原始 Bash 验证产物守卫：覆盖 autocrlf、原始引擎字节和漏交付文件。 */
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { parse } from 'yaml'
import ts from 'typescript'

const attributes = await readFile(new URL('../.gitattributes', import.meta.url), 'utf8')
const workflow = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'))
const steps = workflow.jobs.verify.steps as Array<{ name?: string; run?: string }>
const guard = steps.find(step => step.name === '校验 lib/ 与 presets/ 完整且未变化')!.run!
const bash = process.platform === 'win32'
  ? resolve(spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout.trim(), '../../..', 'bin/bash.exe') : 'bash'
const source = '/** 工厂多行模板，编译器必须看到与入库相同的原始换行。 */\nexport const ready = String.raw`first\nsecond`;\n'
const compile = (input: string) => ts.transpileModule(input, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, newLine: ts.NewLineKind.LineFeed } }).outputText
const generated = new Map([
  ['lib/index.js', compile(source)],
  ['lib/index.d.ts', '/** 工厂声明。 */\nexport declare const ready: boolean;\n'],
  ['lib/nested/client.js', '/** 工厂嵌套产物。 */\nexport const client = true;\n'],
  ['lib/nested/client.d.ts', '/** 工厂嵌套声明。 */\nexport declare const client: boolean;\n'],
])
const engineSource = '/** 固定引擎原始字节，不允许换行转换。 */\r\nexport {};\r\n'
const engineBytes = Buffer.from([0, 97, 115, 109, 13, 10, 255, 10])

function git(cwd: string, ...args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10_000 })
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `git ${args[0]} failed`)
  return result.stdout
}

async function write(root: string, path: string, value: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true })
  await writeFile(join(root, path), value)
}

function check(root: string) {
  return spawnSync(bash, ['--noprofile', '--norc', '-e', '-o', 'pipefail', '-c', guard], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 10_000,
  })
}

// 多次真实 commit/clone/Bash 检查的总时限独立于产品执行期限。
it.each(['true', 'false'])('首次检出 core.autocrlf=%s 后重建保持干净，守卫仍拒绝改动、未跟踪与缺失产物', { timeout: 30_000 }, async autocrlf => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-build-checkout-'))
  try {
    const seed = join(root, 'seed'), checkout = join(root, 'checkout')
    await mkdir(seed)
    git(seed, 'init')
    git(seed, 'config', 'core.autocrlf', 'false')
    await write(seed, '.gitattributes', attributes)
    await write(seed, 'src/index.ts', source)
    for (const [path, content] of generated) await write(seed, path, content)
    await write(seed, 'presets/tavern/preset.yml', 'name: factory\n')
    await write(seed, 'lib/vendor/checkpoint-engine-v1/engine.js', engineSource)
    await write(seed, 'lib/vendor/checkpoint-engine-v1/engine.wasm', engineBytes)
    await write(seed, 'vendor/checkpoint-engine-v1/engine.js', engineSource)
    await write(seed, 'vendor/checkpoint-engine-v1/engine.wasm', engineBytes)
    git(seed, 'add', '.')
    git(seed, '-c', 'user.name=Factory', '-c', 'user.email=factory@example.test', 'commit', '-m', 'factory build')
    git(root, 'clone', '--no-hardlinks', '--config', `core.autocrlf=${autocrlf}`, seed, checkout)
    expect(git(checkout, 'config', '--get', 'core.autocrlf').trim()).toBe(autocrlf)
    for (const [path, content] of generated) await write(checkout, path, content)
    const checkedOutSource = await readFile(join(checkout, 'src/index.ts'), 'utf8')
    expect(checkedOutSource).toBe(source)
    await write(checkout, 'lib/index.js', compile(checkedOutSource))
    for (const base of ['lib/vendor', 'vendor']) {
      expect(await readFile(join(checkout, base, 'checkpoint-engine-v1/engine.js'), 'utf8')).toBe(engineSource)
      expect(await readFile(join(checkout, base, 'checkpoint-engine-v1/engine.wasm'))).toEqual(engineBytes)
    }
    const clean = check(checkout)
    expect(clean.status, clean.stdout + clean.stderr).toBe(0)
    expect(git(checkout, 'status', '--porcelain', '--', 'lib/', 'presets/')).toBe('')

    await write(checkout, 'lib/index.js', 'export const ready = false;\n')
    expect(check(checkout).status).not.toBe(0)
    await write(checkout, 'lib/index.js', generated.get('lib/index.js')!)
    await write(checkout, 'lib/untracked.js', 'export {};\n')
    expect(check(checkout).status).not.toBe(0)
    await rm(join(checkout, 'lib/untracked.js'))
    await rm(join(checkout, 'lib/index.d.ts'))
    expect(check(checkout).status).not.toBe(0)
  } finally { await rm(root, { recursive: true, force: true }) }
})
