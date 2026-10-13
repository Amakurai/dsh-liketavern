/** 长正文的展示与延迟注入回归：允许已有内容透传，脚本新扩张和出口循环仍显式失败。 */
import { expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { parseTemplateDisplayParts, splitTemplateDisplay } from '../src/core/templateDisplay.js'
import { isolated } from '../src/node/isolated.js'
import { parseLorebook } from '../src/state/lorebook.js'

const context = (content = ''): TemplateContext => ({ variables: emptyTemplateScopes(), char: 'A', user: 'B', card: {}, entries: [], presets: [],
  history: content ? [{ role: 'assistant', content }] : [], now: 1000, seed: 1, phase: 'generate' })

it('超过 1 MiB 的已存展示片段保留首尾，格式化已有正文也不会因原文长度被拒绝', async () => {
  const text = '首段 ' + 'x'.repeat(1200 * 1024) + ' 尾段'
  expect(parseTemplateDisplayParts([{ kind: 'markdown', text }])).toEqual([{ kind: 'markdown', text }])
  expect(splitTemplateDisplay(text)).toEqual([{ kind: 'markdown', text }])
  const result = await isolated('template', { context: context(text), texts: ['<%- __formatTemplateMessage(getChatMessage(-1)) %>'] })
  expect(result.texts[0]).toContain(text)
  expect(result.texts[0]).toMatch(/^<p>/)
  expect(result.texts[0]).toMatch(/<\/p>\n?$/)
}, 30_000)

it('可信格式化的 HTML 转义允许合理线性扩张，超过 1 MiB 的代码块产物完整保留', async () => {
  const code = '&'.repeat(300_000)
  const entries = parseLorebook({ entries: [{ uid: 1, content: '@@render_after\n@@message_formatting\n<%- getChatMessage(-1) %>' }] }, { source: 'character', sourceRef: 'card' })
  const result = await isolated('template', { context: { ...context('```text\n' + code + '\n```'), entries, phase: 'render' }, texts: [''], decorateOutput: true })
  expect(result.parts[0]).toHaveLength(1)
  const part = result.parts[0]![0]!
  expect(part.kind).toBe('html')
  expect(part.text.length).toBeGreaterThan(1024 * 1024)
  expect(part.text).toContain('&amp;'.repeat(300_000))
  expect(part.text).toContain('</code></pre>')
}, 30_000)

it('超过 4 MiB 的正文仅展开一个小出口，原有内容不计入新增工作量', async () => {
  const body = '首段 ' + 'x'.repeat(4 * 1024 * 1024 + 100) + ' {{outletPromptsInjected:tail}}'
  const result = await isolated('template', { context: context(), texts: [`<% injectPrompt('tail','尾段') %>${body}`] })
  expect(result.texts[0]).toBe(body.replace('{{outletPromptsInjected:tail}}', '尾段'))
}, 30_000)

it('长正文不能使出口新增内容无限膨胀，失败后普通输出仍可运行', async () => {
  const body = 'x'.repeat(1200 * 1024) + '{{outletPromptsInjected:grow}}'
  await expect(isolated('template', { context: context(), texts: [`<% injectPrompt('grow','z'.repeat(1100000)) %>${body}`] }))
    .rejects.toThrow(/1 MiB|memory|超时/)
  expect((await isolated('template', { context: context(), texts: ['正常'] })).texts).toEqual(['正常'])
}, 30_000)
