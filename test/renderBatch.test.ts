/** 气泡展示批处理：同一时刻的请求合批、按会话与上限拆分、单项与整批失败的边界，以及共享快照按引用重组。 */
import { expect, it, vi } from 'vitest'
import { expandRenderedOutputBatch, renderOutputBatched } from '../src/client/renderBatch.js'
import type { RenderedOutput, RenderedOutputBatch, RenderedOutputBatchItem } from '../src/remote.js'
import type { TavernRemote } from '../src/client/types.js'
import type { HelperSnapshotBase } from '../src/core/helperRuntime.js'

const plain = (text: string): RenderedOutputBatchItem => ({ text, html: null, htmls: [], interactiveCards: true, whitelist: [], greetings: [], greetingIndex: 0, canSwipeGreeting: false })
const base: HelperSnapshotBase = { storyId: 'story', historyRevision: 'rev', writable: true, scopes: {}, messages: [] }
type BatchRequest = { sessionId: string; items: Array<{ text: string; messageId?: number }> }

function factoryRemote() {
  const renderOutputText = vi.fn(async (request: { text: string }) => ({ ok: true as const, value: plain(`单条:${request.text}`) as RenderedOutput }))
  const renderOutputTexts = vi.fn(async (request: BatchRequest) => ({ ok: true as const, value: {
    items: request.items.map((item) => ({ ok: true as const, value: plain(`批量:${item.text}`) })),
  } satisfies RenderedOutputBatch }))
  return { remote: { renderOutputText, renderOutputTexts } as unknown as TavernRemote, renderOutputText, renderOutputTexts }
}

it('同一时刻的多个气泡合成一次批量请求，结果按原顺序分发；单个请求仍走逐条接口', async () => {
  const { remote, renderOutputText, renderOutputTexts } = factoryRemote()
  const results = await Promise.all(['甲', '乙', '丙'].map((text, index) => renderOutputBatched(remote, { sessionId: 's', text, messageId: index })))
  expect(renderOutputTexts).toHaveBeenCalledOnce()
  expect(renderOutputTexts.mock.calls[0]![0]).toEqual({ sessionId: 's', items: [{ text: '甲', messageId: 0 }, { text: '乙', messageId: 1 }, { text: '丙', messageId: 2 }] })
  expect(results.map((result) => result.ok && result.value.text)).toEqual(['批量:甲', '批量:乙', '批量:丙'])
  expect(renderOutputText).not.toHaveBeenCalled()
  const single = await renderOutputBatched(remote, { sessionId: 's', text: '丁' })
  expect(single).toMatchObject({ ok: true, value: { text: '单条:丁' } })
  expect(renderOutputText).toHaveBeenCalledOnce()
})

it('不同会话分别成批，超过单批上限时拆分且不丢项', async () => {
  const { remote, renderOutputTexts } = factoryRemote()
  const pending = [
    ...Array.from({ length: 70 }, (_, index) => renderOutputBatched(remote, { sessionId: 'a', text: `a${index}` })),
    renderOutputBatched(remote, { sessionId: 'b', text: 'b0' }), renderOutputBatched(remote, { sessionId: 'b', text: 'b1' }),
  ]
  const results = await Promise.all(pending)
  expect(renderOutputTexts.mock.calls.map(([request]) => [request.sessionId, request.items.length])).toEqual([['a', 64], ['a', 6], ['b', 2]])
  expect(results.every((result) => result.ok)).toBe(true)
  expect(results[69]).toMatchObject({ ok: true, value: { text: '批量:a69' } })
})

it('宿主没有批量方法时逐条请求；整批失败时每项都得到同一错误', async () => {
  const renderOutputText = vi.fn(async () => ({ ok: true as const, value: plain('单条') }))
  const legacy = { renderOutputText } as unknown as TavernRemote
  await Promise.all([renderOutputBatched(legacy, { sessionId: 's', text: '1' }), renderOutputBatched(legacy, { sessionId: 's', text: '2' })])
  expect(renderOutputText).toHaveBeenCalledTimes(2)

  const failing = { renderOutputText, renderOutputTexts: vi.fn(async () => ({ ok: false as const, error: { code: 'busy', message: '服务忙' } })) } as unknown as TavernRemote
  const failed = await Promise.all([renderOutputBatched(failing, { sessionId: 's', text: '1' }), renderOutputBatched(failing, { sessionId: 's', text: '2' })])
  expect(failed).toEqual([{ ok: false, error: { code: 'busy', message: '服务忙' } }, { ok: false, error: { code: 'busy', message: '服务忙' } }])
  const rejected = { renderOutputText, renderOutputTexts: vi.fn(async () => { throw new Error('连接中断') }) } as unknown as TavernRemote
  const lost = await Promise.all([renderOutputBatched(rejected, { sessionId: 's', text: '1' }), renderOutputBatched(rejected, { sessionId: 's', text: '2' })])
  expect(lost.map((result) => !result.ok && result.error.message)).toEqual(['连接中断', '连接中断'])
})

it('重组时卡面共享同一份历史；声明了共享部分却缺失的项明确失败', () => {
  const scripts = { storyId: 'story', bindingRevision: 'b', libraries: [] }
  const worldbooks = { storyId: 'story', bindingRevision: 'b', names: [], global: [], characterName: '灯塔', character: { primary: null, additional: [] }, chat: null }
  const expanded = expandRenderedOutputBatch({ helperBase: base, helperScripts: scripts, helperWorldbooks: worldbooks, items: [
    { ok: true, value: { ...plain('卡一'), helperMessageId: 1, helperExtras: true } },
    { ok: true, value: { ...plain('卡二'), helperMessageId: 3, helperExtras: true } },
    { ok: false, error: '卡面消息不在当前剧情中' },
  ] })
  const [one, two, three] = expanded
  if (!one?.ok || !two?.ok) throw new Error('卡面项应成功')
  expect(one.value.helper).toEqual({ ...base, currentMessageId: 1 })
  expect(one.value.helper!.messages).toBe(two.value.helper!.messages)
  expect(two.value.helper!.currentMessageId).toBe(3)
  expect(one.value.helperScripts).toBe(scripts)
  expect(one.value).not.toHaveProperty('helperMessageId')
  expect(three).toEqual({ ok: false, error: { code: 'render-failed', message: '卡面消息不在当前剧情中' } })
  expect(expandRenderedOutputBatch({ items: [{ ok: true, value: { ...plain('缺快照'), helperMessageId: 0 } }] })[0])
    .toMatchObject({ ok: false, error: { message: '批量展示结果缺少卡面快照' } })
  expect(expandRenderedOutputBatch({ helperBase: base, items: [{ ok: true, value: { ...plain('缺脚本'), helperExtras: true } }] })[0])
    .toMatchObject({ ok: false, error: { message: '批量展示结果缺少脚本库或世界书上下文' } })
})
