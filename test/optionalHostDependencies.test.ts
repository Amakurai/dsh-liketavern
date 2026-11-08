/** 在独立真实 Node 进程中拒绝可选宿主模块，验证入口仍可加载，能力启用失败只影响对应阶段。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const probe = String.raw`
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const optional = ['@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-typert-registry']
const blocked = []
const src = pathToFileURL(join(process.cwd(), 'src') + sep).href
registerHooks({ resolve(specifier, context, next) {
  if (optional.includes(specifier)) {
    blocked.push(specifier)
    throw Object.assign(new Error('Missing optional host package: ' + specifier), { code: 'ERR_MODULE_NOT_FOUND' })
  }
  if (context.parentURL?.startsWith(src) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = fileURLToPath(new URL(specifier, context.parentURL)).replace(/\.js$/, '.ts')
    if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context)
  }
  return next(specifier, context)
} })

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
for (const name of optional) {
  assert.equal(pkg.peerDependencies[name], '*')
  assert.equal(pkg.peerDependenciesMeta[name].optional, true)
}
const entry = await import(new URL('index.ts', src).href)
assert.equal(typeof entry.apply, 'function')
assert.deepEqual(blocked, [])
const { installTavernPreset } = await import(new URL('node/presetInstall.ts', src).href)
const { guardPhase, guardPhaseAsync, hostDegradations } = await import(new URL('node/hostCompat.ts', src).href)
const warnings = []
const host = { logger: { warn: message => warnings.push(message) } }
const result = await guardPhaseAsync(host, 'agent 预设注册', () => installTavernPreset({
  agentPresets: { register: async () => { throw new Error('Unavailable registry must not run') } },
}))
assert.equal(result, undefined)
assert.deepEqual(blocked, ['@deepseek-ai/dsh-agent-preset-registry'])
assert.equal(warnings.length, 1)
assert.equal(hostDegradations(host)[0].phase, 'agent 预设注册')
assert.equal(guardPhase(host, 'unrelated subsystem', () => 42), 42)
`

it('缺少预设注册器与 Typert 包时仍能导入插件，按需注册失败由阶段守卫处理', async () => {
  const result = await execute(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', probe], {
    cwd: process.cwd(), timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true,
  })
  expect(result.stdout).toBe('')
}, 20_000)
