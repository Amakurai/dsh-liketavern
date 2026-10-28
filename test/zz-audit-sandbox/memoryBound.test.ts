/**
 * A6 修复验证：失败分类诚实——真实错误（含 QuickJS OOM）优先于期限上报，
 * 实际触发中断后如另有错误，保留原始原因并同时报告中断；宿主仍会终止失控 worker。
 */
import { expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../../src/core/template.js'
import { templateExecutionBudget } from '../../src/core/templateBudget.js'
import { isolated } from '../../src/node/isolated.js'
import { TemplateSandbox } from '../../src/node/templateSandbox.js'

const context = (): TemplateContext => ({
  variables: emptyTemplateScopes(), char: 'A', user: 'B', card: {}, entries: [], presets: [],
  history: [], now: 1000, seed: 1, phase: 'generate',
})
const run = async (text: string, timeoutMs: number) => {
  const started = Date.now()
  try { await isolated('template', { context: context(), texts: [text] }, timeoutMs); return { ms: Date.now() - started, ok: true, message: '' } }
  catch (error) { return { ms: Date.now() - started, ok: false, message: String(error) } }
}

it('A6：单次巨大分配按内存上限明确失败（OOM 不是超时）', async () => {
  const result = await run('<% new Uint8Array(400*1024*1024) %>', 6000)
  expect(result.ok).toBe(false)
  expect(result.message).toMatch(/out of memory|内存/)
  expect(result.message).not.toMatch(/计算超时/)
}, 30_000)

it('A6：分类规则——真实错误优先，中断且超期才算超时', async () => {
  await TemplateSandbox.prepare()
  const sandbox = await TemplateSandbox.create(context(), false)
  try {
    const rule = sandbox as unknown as { deadline:number; renderFailure:(message:string)=>Error }
    rule.deadline = Date.now() - 1
    expect(rule.renderFailure('InternalError: out of memory').message).toMatch(/out of memory/)
    expect(rule.renderFailure('InternalError: interrupted').message).toMatch(/计算超时/)
    rule.deadline = Date.now() + 60_000
    expect(rule.renderFailure('InternalError: interrupted').message).toMatch(/EJS 模板失败/)
  } finally { sandbox.dispose() }
}, 30_000)

it('中断后出现其他错误时同时保留原始错误和中断事实', async () => {
  await TemplateSandbox.prepare()
  const sandbox = await TemplateSandbox.create(context(), false)
  try {
    const rule = sandbox as unknown as {
      deadline:number; interruptIfExpired:()=>boolean; renderFailure:(message:string)=>Error
    }
    rule.deadline = Date.now() + 60_000
    expect(rule.interruptIfExpired()).toBe(false)
    expect(rule.renderFailure('TypeError: not a function').message).toBe('EJS 模板失败：TypeError: not a function')
    rule.deadline = Date.now() - 1
    // 仅超期尚不足以改变真实错误；QuickJS 确实调用中断处理器后才附加中断事实。
    expect(rule.renderFailure('InternalError: out of memory').message).not.toMatch(/超时/)
    expect(rule.interruptIfExpired()).toBe(true)
    expect(rule.renderFailure('TypeError: not a function').message).toMatch(/TypeError: not a function.*超时中断/)
    expect(rule.renderFailure('InternalError: out of memory').message).toMatch(/out of memory.*超时中断/)
  } finally { sandbox.dispose() }
}, 30_000)

it('正常脚本错误不会被误报成中断', async () => {
  await TemplateSandbox.prepare()
  const sandbox = await TemplateSandbox.create(context(), false)
  try {
    expect(() => sandbox.render('<% throw new TypeError("actual error") %>')).toThrow(/TypeError:[\s\S]*actual error/)
    expect(() => sandbox.render('<% throw new TypeError("actual error") %>')).not.toThrow(/超时/)
  } finally { sandbox.dispose() }
}, 30_000)

it('A6：内存压力下的失控脚本仍显式失败（观察耗时）', async () => {
  const cpu = await run('<% while(true) {} %>', 8000)
  expect(cpu.ok).toBe(false)
  expect(cpu.message).toMatch(/计算超时/)
  // QuickJS 自身的阶段期限（小输入 4s）先于宿主 8s 显式期限终止死循环。
  expect(cpu.ms).toBeLessThan(templateExecutionBudget(0).sandboxMs + 2000)
  const bomb = await run("<% const a=[]; for(;;) a.push('x'.repeat(1000000)) %>", 8000)
  expect(bomb.ok).toBe(false)
  console.info(JSON.stringify({ probe: 'memory-classification', cpuMs: cpu.ms, cpuMessage: cpu.message, bombMs: bomb.ms, bombMessage: bomb.message }))
  // 沙箱期限在内存压力下可能被 GC 推迟，但硬边界仍是宿主终止 worker；分类必须诚实。
  expect(bomb.message).toMatch(/out of memory|内存|计算超时|已终止 worker/)
}, 40_000)
