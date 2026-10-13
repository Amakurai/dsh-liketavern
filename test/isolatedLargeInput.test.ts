/** 长文本跨 worker 边界回归：正常正文不被旧传输阈值拒绝，大输入中的恶意正则仍终止并释放槽位。 */
import { expect, it } from 'vitest'
import { isolated } from '../src/node/isolated.js'
import { compileRegexScripts } from '../src/core/regex.js'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'

it('超过 16 MiB 的合法正文完整进入和返回 worker', async () => {
  const text = '长历史标记 ' + 'x'.repeat(17 * 1024 * 1024) + ' 最后消息'
  const result = await isolated('render', { text, rules: [], macroCtx: { char: 'A', user: 'B' } })
  expect(result.text).toBe(text)
  expect(result.applied).toEqual([])
}, 30_000)

it('大输入不放宽显式超时，灾难正则终止后下一任务可以继续', async () => {
  const rules = compileRegexScripts([{ id: 'bad', scriptName: 'bad', findRegex: '^([a-z]|a)+$', replaceString: '', placement: [2], disabled: false }], 'card')
  let heartbeat = false
  const timer = setTimeout(() => { heartbeat = true }, 30)
  try {
    await expect(isolated('render', { text: 'a'.repeat(40) + '!', rules, macroCtx: { char: 'x'.repeat(4 * 1024 * 1024), user: 'B' } }, 80)).rejects.toThrow(/超时/)
    expect(heartbeat).toBe(true)
    const result = await isolated('render', { text: '下一次正常正文', rules: [], macroCtx: { char: 'A', user: 'B' } })
    expect(result.text).toBe('下一次正常正文')
  } finally { clearTimeout(timer) }
}, 15_000)

it('长上下文中的无限 JavaScript 同样受显式累计期限保护', async () => {
  const context: TemplateContext = { variables: emptyTemplateScopes(), char: 'A', user: 'B', card: {}, entries: [], presets: [],
    history: [{ role: 'user', content: 'x'.repeat(4 * 1024 * 1024) }], now: 1000, seed: 1, phase: 'generate' }
  await expect(isolated('template', { context, texts: ['<% while (true) {} %>'] }, 100)).rejects.toThrow(/interrupt|超时/)
  expect((await isolated('template', { context: { ...context, history: [] }, texts: ['恢复正常'] })).texts).toEqual(['恢复正常'])
}, 15_000)
