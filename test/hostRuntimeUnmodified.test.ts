/** 在独立 Node 进程加载真实宿主类与源码，避免测试全局兼容桩掩盖模型选择行为。 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const execute = promisify(execFile)
const probe = String.raw`
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { join, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { AgentModel } from '@deepseek-ai/dsh-agent'

const src = pathToFileURL(join(process.cwd(), 'src') + sep).href
registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.startsWith(src) && specifier.startsWith('.') && specifier.endsWith('.js')) {
    const candidate = fileURLToPath(new URL(specifier, context.parentURL)).replace(/\.js$/, '.ts')
    if (existsSync(candidate)) return next(pathToFileURL(candidate).href, context)
  }
  return next(specifier, context)
} })
const { ensureAgentRequestSelectionSync } = await import(new URL('node/modelRoute.ts', src).href)
const defaults = { provider: 'factory', model: 'default' }
const selected = { provider: 'factory', model: 'selected' }
const inherited = { provider: 'factory', model: 'inherited' }
const session = { ownEvents: () => [], append: () => { throw new Error('unexpected model write') } }
const tavernModel = new AgentModel(() => ({ pending: selected, lastUsed: null }), session, defaults)
const otherModel = new AgentModel(() => ({ pending: null, lastUsed: inherited }), session, defaults)
const tavern = { options: defaults, model: tavernModel, requestHeaderLogged: false,
  dispatch: { waterfall: async () => defaults }, preStep: async () => tavernModel.current() }
const other = { options: defaults, model: otherModel, requestHeaderLogged: false,
  dispatch: { waterfall: async () => defaults }, preStep: async () => otherModel.current() }
ensureAgentRequestSelectionSync(tavern)
assert.deepEqual(otherModel.current(), inherited)
assert.deepEqual(await other.preStep(), inherited)
assert.deepEqual(await tavern.preStep(), selected)
`

it('未修改的真实宿主模型选择保持当前选择和分支继承，不受另一个 Tavern 会话影响', async () => {
  const result = await execute(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', probe], {
    cwd: process.cwd(), timeout: 15_000, maxBuffer: 1024 * 1024,
  })
  expect(result.stdout).toBe('')
}, 20_000)
