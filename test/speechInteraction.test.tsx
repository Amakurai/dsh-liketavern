/** 交互卡消息行为：真实 React + 伪 iframe 窗口，验证来源校验、连续点击去重、错误反馈与会话隔离。 */
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { SpeechBubble } from '../src/client/speech.js'
import type { TavernRemote } from '../src/client/types.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { Btn } from '../src/client/util.js'

vi.mock('../src/client/styles.js', () => ({ CARD_VARIABLE_STYLES: '' }))
vi.mock('../src/client/cache.js', () => ({ cachedAvatar: async () => ({ ok: true, value: { dataUrl: null } }) }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCopyOutline16: () => null, IconUserOutline16: () => null,
  Tooltip: (p: { children?: ReactNode }) => <>{p.children}</>,
  Button: (p: { children?: ReactNode }) => <button>{p.children}</button>,
  Modal: (p: { open: boolean; children?: ReactNode; footer?: ReactNode }) => p.open ? <div>{p.children}{p.footer}</div> : null,
  MarkdownText: () => null, Toast: () => null,
}))
let view: ReactTestRenderer | undefined
let events: EventTarget
const source = {}
const remote = { renderOutputText: async () => ({ ok: true, value: { text: '', htmls: ['<p>测试卡</p>'], interactiveCards: true,
  whitelist: [], greetings: ['初始', '备选'], greetingIndex: 0, canSwipeGreeting: true } }) } as unknown as TavernRemote
beforeEach(() => { events = new EventTarget(); vi.stubGlobal('window', events); setTavernLocale('zh') })
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; vi.unstubAllGlobals() })
function node(onSwipeGreeting: (index: number) => Promise<void>, sessionId = 'source') {
  return <SpeechBubble remote={remote} sessionId={sessionId} cardId="card" name="灯塔" rawText="测试开场白" onSwipeGreeting={onSwipeGreeting} />
}
async function mount(component: ReactNode) {
  await act(async () => { view = create(component, { createNodeMock: (element) => element.type === 'iframe' ? { contentWindow: source } : null }) })
}
function swipe(from: unknown = source) {
  const event = new Event('message')
  Object.defineProperties(event, { source: { value: from }, data: { value: { source: 'dsh-tavern-card', action: 'swipeGreeting', index: 1 } } })
  events.dispatchEvent(event)
}

it('忽略别的窗口；当前卡面失败明确展示错误，重试期间重复点击只发一次请求', async () => {
  let fail!: (reason: Error) => void
  const onSwipe = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject }))
  await mount(node(onSwipe))
  expect(view!.root.findByType('iframe').props.sandbox).toBe('allow-scripts')
  await act(async () => swipe({}))
  expect(onSwipe).not.toHaveBeenCalled()
  await act(async () => { swipe(); swipe() })
  expect(onSwipe).toHaveBeenCalledOnce()
  await act(async () => fail(new Error('分支创建失败，请重试')))
  expect(view!.root.findByProps({ role: 'alert' }).children.join('')).toContain('分支创建失败')
  onSwipe.mockResolvedValueOnce()
  await act(async () => swipe())
  expect(onSwipe).toHaveBeenCalledTimes(2)
  expect(view!.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
})

it('切换会话后旧请求失败不能污染新气泡，也不能锁住新卡面的点击', async () => {
  let fail!: (reason: Error) => void
  const oldSwipe = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject }))
  const newSwipe = vi.fn(async () => {})
  await mount(node(oldSwipe))
  await act(async () => swipe())
  await act(async () => view!.update(node(newSwipe, 'new-session')))
  await act(async () => fail(new Error('旧请求失败')))
  await act(async () => swipe())
  expect(newSwipe).toHaveBeenCalledOnce()
  expect(view!.root.findAllByProps({ role: 'alert' })).toHaveLength(0)
})

it('恢复由用户在宿主输入；错误备份保留原 iframe，合法备份重建隔离卡面', async () => {
  await mount(node(vi.fn(async () => {})))
  const oldFrame = view!.root.findByType('iframe')
  const before = oldFrame.props.srcDoc
  const click = (text: string) => view!.root.findAllByType(Btn).find((b) => b.props.children === text)!.props.onClick()
  await act(async () => click('恢复卡内备份'))
  await act(async () => view!.root.findByType('textarea').props.onChange({ target: { value: 'bad' } }))
  await act(async () => click('确定'))
  expect(view!.root.findByType('iframe')).toBe(oldFrame)
  expect(view!.root.findByProps({ role: 'alert' }).children.join('')).toContain('备份无效')
  const backup = JSON.stringify({ version: 1, scopes: { '["character",""]': { test: '恢复内容' } } })
  await act(async () => view!.root.findByType('textarea').props.onChange({ target: { value: backup } }))
  await act(async () => click('确定'))
  const after = view!.root.findByType('iframe')
  expect(after).not.toBe(oldFrame)
  expect(after.props.srcDoc).not.toBe(before)
  expect(after.props.srcDoc).toContain('恢复内容')
  expect(after.props.sandbox).toBe('allow-scripts')
  expect(view!.root.findAllByType('textarea')).toHaveLength(0)
})
