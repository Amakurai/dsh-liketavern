/**
 * 微任务成批执行回归：大量 await 照常完成且结果不变；
 * 无限异步循环（含吞掉中断错误的写法）仍在计算期限内终止，并以超时收口。
 */
import { expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../../src/core/template.js'
import { TemplateSandbox } from '../../src/node/templateSandbox.js'

const context = (): TemplateContext => ({
  variables: emptyTemplateScopes(), char: 'A', user: 'B', card: {}, entries: [], presets: [],
  history: [], now: 1000, seed: 1, phase: 'generate',
})

it('数千次 await 依序完成，结果与逐个执行一致', async () => {
  await TemplateSandbox.prepare()
  const sandbox = await TemplateSandbox.create(context(), false)
  try {
    const text = '<% const order=[]; for (let i=0;i<5000;i++) { await null; order.push(i) } %><%- order.length %>:<%- order.every((v,i)=>v===i) %>'
    expect(sandbox.render(text)).toBe('5000:true')
  } finally { sandbox.dispose() }
}, 30_000)

it('无限 await 循环仍按期限报超时', async () => {
  await TemplateSandbox.prepare()
  const sandbox = await TemplateSandbox.create(context(), false)
  try {
    expect(() => sandbox.render('<% while (true) await null %>')).toThrow(/超时/)
  } finally { sandbox.dispose() }
}, 30_000)

it('吞掉中断错误的异步循环也不能越过期限', async () => {
  await TemplateSandbox.prepare()
  const sandbox = await TemplateSandbox.create(context(), false)
  try {
    const started = Date.now()
    expect(() => sandbox.render('<% while (true) { try { await null } catch {} } %>')).toThrow(/超时/)
    expect(Date.now() - started).toBeLessThan(10_000)
  } finally { sandbox.dispose() }
}, 30_000)
