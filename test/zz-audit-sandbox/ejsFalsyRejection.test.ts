/**
 * A5 修复验证：渲染包装把拒绝值转成可读原因（空值也保留“EJS 模板以空值拒绝”），
 * 因此 throw '' 不再被误报成“输出无效/超限”，真实原因与非空错误一并保留。
 */
import { expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../../src/core/template.js'
import { isolated } from '../../src/node/isolated.js'

const context = (): TemplateContext => ({
  variables: emptyTemplateScopes(), char: 'A', user: 'B', card: {}, entries: [], presets: [],
  history: [], now: 1000, seed: 1, phase: 'generate',
})
const failure = (text: string) => isolated('template', { context: context(), texts: [text] }, 3000)
  .then(() => '', error => String(error))

it('A5：模板以假值拒绝时保留真实原因', async () => {
  expect(await failure("<% throw '' %>")).toMatch(/EJS 模板失败：EJS 模板以空值拒绝/)
  expect(await failure('<% throw {toString(){return ""}} %>')).toMatch(/EJS 模板失败：EJS 模板以空值拒绝/)
  // 非空消息的拒绝照常保留原文。
  expect(await failure('<% throw new Error("真实原因") %>')).toMatch(/真实原因/)
  // 真正的输出超量仍按输出超量报告，与模板主动拒绝区分开。
  expect(await failure('<%= "x".repeat(3*1024*1024) %>')).toMatch(/净增超过 1 MiB 上限/)
  expect(await failure('<%= "x".repeat(3*1024*1024) %>')).not.toMatch(/空值拒绝/)
}, 30_000)
