/** 英雄区生命周期回归：模拟宿主 blank 延迟与 remote，验证重复进入、错误重试及会话切换隔离。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { TavernHeroCharacter } from '../src/client/hero.js'
import { CharacterPicker } from '../src/client/characterPicker.js'
import { Btn } from '../src/client/util.js'
import type { TavernRemote } from '../src/client/types.js'

vi.mock('../src/client/styles.js', () => ({}))
vi.mock('../src/client/actions.js', () => ({ BINDING_CHANGED_EVENT: 'binding-changed' }))
vi.mock('../src/client/chip.js', () => ({ bindingFromDefaults: async (_remote: unknown, sessionId: string, cardId: string) => ({ sessionId, cardId }) }))
vi.mock('../src/client/characterPicker.js', () => ({ CharacterPicker: () => null, rememberCharacter: () => {} }))
vi.mock('../src/client/cache.js', () => ({ invalidateSessionBinding: () => {},
  cachedAvatar: async () => ({ ok: true, value: { dataUrl: null } }),
  cachedCharacterDetail: async () => ({ ok: true, value: { name: '灯塔', firstMes: '欢迎', alternateGreetings: [], tags: [] } }),
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (p: { children?: ReactNode }) => <button>{p.children}</button>,
  Tooltip: (p: { children?: ReactNode }) => <>{p.children}</>,
  IconChevronLeftOutline14: () => null, IconChevronRightOutline14: () => null,
  IconChevronDownOutline14: () => null, IconUserOutline16: () => null,
}))

let view: ReactTestRenderer | undefined
beforeEach(() => {
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }))
  vi.stubGlobal('document', { body: {} })
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} })
})
afterEach(async () => {
  if (view) await act(async () => view!.unmount())
  view = undefined
  vi.unstubAllGlobals()
})
const ok = <T,>(value: T) => ({ ok: true as const, value })
function fixture(started = false) {
  let selected = started
  const clearSessionBinding = vi.fn(async () => ok({ cleared: true }))
  const ensureGreeting = vi.fn(async () => ok({ created: true, conversationStarted: true }))
  const remote = {
    getSessionBinding: async ({ sessionId }: { sessionId: string }) => ok({ binding: selected ? { cardId: 'card', sessionId, greetingIndex: 0 } : null,
      userName: '旅人', canSwipeGreeting: true, conversationStarted: started }),
    listCharacters: async () => ok({ items: [] }),
    setSessionBinding: async () => { selected = true; return ok({ saved: true }) },
    clearSessionBinding, ensureGreeting,
  } as unknown as TavernRemote
  const sessions = { open: vi.fn(), refresh: vi.fn(async () => {}) }
  const node = (sessionId: string) => <TavernHeroCharacter remote={remote} sessionId={sessionId} sessions={sessions}
    session={{ blank: true }} useSessions={() => 'tavern'} />
  return { clearSessionBinding, ensureGreeting, sessions, node }
}
async function mount(node: ReactNode) { await act(async () => { view = create(node) }) }
async function pick() {
  const chip = view!.root.findByProps({ 'data-tavern-hero-seat': '' }).findByType('button')
  await act(async () => chip.props.onClick())
  await act(async () => view!.root.findByType(CharacterPicker).props.onPick('card'))
}
function start() { return view!.root.findByType(Btn).props.onClick() }

it('宿主 blank 滞后但日志已开始时不显示预览、不清绑定，并刷新列表', async () => {
  const f = fixture(true)
  await mount(f.node('existing'))
  expect(view!.toJSON()).toBeNull()
  expect(f.clearSessionBinding).not.toHaveBeenCalled()
  expect(f.sessions.refresh).toHaveBeenCalledOnce()
})

it.each([true, false])('创建结果 %s，只要日志已开始就收起预览并同步宿主', async (created) => {
  const f = fixture()
  f.ensureGreeting.mockResolvedValue(ok({ created, conversationStarted: true }))
  await mount(f.node('first'))
  await pick()
  await act(async () => start())
  expect(view!.toJSON()).toBeNull()
  expect(f.sessions.refresh).toHaveBeenCalledOnce()
  expect(f.clearSessionBinding).not.toHaveBeenCalled()
})

it('写入失败保留预览并可重试', async () => {
  const f = fixture()
  f.ensureGreeting.mockRejectedValueOnce(new Error('模拟写入失败'))
  await mount(f.node('retry'))
  await pick()
  await act(async () => start())
  expect(view!.root.findByProps({ className: 'dsh-tavern-hero-error' }).children).toContain('模拟写入失败')
  expect(view!.root.findByType(Btn).props.disabled).toBe(false)
  await act(async () => start())
  expect(view!.toJSON()).toBeNull()
})

it('开始请求尚未返回时切换会话，旧请求完成不能隐藏新会话或锁住选择器', async () => {
  const f = fixture()
  let finish!: (value: { ok: true; value: { created: boolean; conversationStarted: boolean } }) => void
  f.ensureGreeting.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
  await mount(f.node('old'))
  await pick()
  await act(async () => start())
  await act(async () => view!.update(f.node('new')))
  await act(async () => finish(ok({ created: true, conversationStarted: true })))
  expect(view!.root.findByProps({ 'data-tavern-hero-seat': '' }).findByType('button').props.disabled).toBeFalsy()
  expect(view!.toJSON()).not.toBeNull()
})
