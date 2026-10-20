/**
 * A2 修复验证：EJS 完成状态与结果只存在于渲染包装闭包内，宿主经句柄读取。
 * 模板写 globalThis.__done/__result/__error 不再影响判定：永不完成的渲染明确失败，
 * 正常渲染也不会被同名全局改写结果。
 */
import { expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../../src/core/template.js'
import { isolated } from '../../src/node/isolated.js'

const context = (): TemplateContext => ({
  variables: emptyTemplateScopes(), char: 'A', user: 'B', card: {}, entries: [], presets: [],
  history: [], now: 1000, seed: 1, phase: 'generate',
})

it('A2：伪造完成协议不再让未完成的异步渲染冒充成功', async () => {
  const honest = '<% await new Promise(()=>{}) %>'
  await expect(isolated('template', { context: context(), texts: [honest] }, 3000))
    .rejects.toThrow(/异步任务未完成/)
  const forged = `<% globalThis.__result='FORGED'; globalThis.__done=true; globalThis.__error=null; await new Promise(()=>{}) %>`
  await expect(isolated('template', { context: context(), texts: [forged] }, 3000))
    .rejects.toThrow(/异步任务未完成/)
}, 30_000)

it('A2：正常渲染结果不被同名全局改写', async () => {
  const result = await isolated('template', { context: context(), texts: [`<% globalThis.__result='FORGED' %>真实结果`] }, 3000)
  expect(result.texts).toEqual(['真实结果'])
}, 30_000)
