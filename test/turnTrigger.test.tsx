/**
 * 唤醒本轮的非用户输入：宿主 0.1.7 会把续写合成指令原文画成可展开行，暴露内部提示词。
 * Tavern 接管后插件指令只显示简短说明且不含指令原文；其它来源保留可展开原文。
 */
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { CONTINUE_INSTRUCTION_PREFIX } from '../src/core/dshPrompt.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { TavernTurnTrigger } from '../src/client/trigger.js'

const mounted: ReactTestRenderer[] = []
beforeEach(() => setTavernLocale('zh'))
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()) })
async function render(text: string, kind: string) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(<TavernTurnTrigger node={{ data: { content: [{ type: 'text', text }], source: { kind } } }} />) })
  mounted.push(view)
  return JSON.stringify(view.toJSON())
}

it('插件续写指令只显示简短说明，不暴露指令原文', async () => {
  const html = await render(`${CONTINUE_INSTRUCTION_PREFIX}上一条角色回复可能因长度上限被截断。请紧接断点继续写`, 'dsh-tavern')
  expect(html).toContain('接着上一条回复续写')
  expect(html).not.toContain('长度上限')
})

it('其它插件指令显示通用说明；外部来源保留可展开原文', async () => {
  expect(await render('内部提示', 'dsh-tavern')).not.toContain('内部提示')
  const external = await render('定时任务：检查存档', 'schedule')
  expect(external).toContain('收到外部请求')
  expect(external).toContain('定时任务：检查存档')
})
