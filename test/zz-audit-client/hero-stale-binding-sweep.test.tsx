/**
 * 修复后行为（C2）：空白会话上的陈旧绑定清扫失败不算完成。
 * 失败时回滚一次性标记并给出重试入口；重试成功后绑定被真正清掉，英雄区不再显示旧卡预览。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { TavernHeroCharacter } from '../../src/client/hero.js'
import { CharacterPicker } from '../../src/client/characterPicker.js'
import { Btn } from '../../src/client/util.js'
import type { TavernRemote } from '../../src/client/types.js'

vi.mock('../../src/client/styles.js', () => ({}))
vi.mock('../../src/client/actions.js', () => ({ BINDING_CHANGED_EVENT: 'binding-changed' }))
vi.mock('../../src/client/chip.js', () => ({ bindingFromDefaults: async (_remote: unknown, sessionId: string, cardId: string) => ({ sessionId, cardId }) }))
vi.mock('../../src/client/characterPicker.js', () => ({ CharacterPicker: () => null, rememberCharacter: () => {} }))
vi.mock('../../src/client/cache.js', () => ({
  invalidateSessionBinding: () => {},
  CHARACTER_CHANGED_EVENT: 'character-changed',
  cachedAvatar: async () => ({ ok: true, value: { dataUrl: null } }),
  cachedCharacterDetail: async () => ({ ok: true, value: { name: '灯塔', firstMes: '欢迎', alternateGreetings: [], tags: [] } }),
}))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (p: { children?: ReactNode }) => <button>{p.children}</button>,
  Tooltip: (p: { children?: ReactNode }) => <>{p.children}</>,
  IconChevronLeftOutlineMedium: () => null, IconChevronRightOutlineMedium: () => null,
  IconChevronDownOutlineMedium: () => null, IconUserOutlineMedium: () => null,
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

it('清扫失败可重试：重试成功后陈旧绑定被清掉，旧卡预览消失', async () => {
  let bound = true
  const clearSessionBinding = vi.fn(async () => {
    if (bound && clearSessionBinding.mock.calls.length === 1) throw new Error('模拟清扫失败')
    bound = false
    return ok({ cleared: true })
  })
  const remote = {
    renderOutputText: vi.fn(async ({ text }: { text: string }) => ok({ text, htmls: [] as string[] })),
    // 空白会话上残留着上次的绑定：正是需要被清扫的场景；清扫成功后返回 null。
    getSessionBinding: async ({ sessionId }: { sessionId: string }) => ok({
      binding: bound ? { sessionId, cardId: 'card', greetingIndex: 0 } : null,
      userName: '旅人', canSwipeGreeting: true, conversationStarted: false,
    }),
    listCharacters: async () => ok({ items: [] }),
    setSessionBinding: vi.fn(async () => ok({ saved: true })),
    clearSessionBinding,
  } as unknown as TavernRemote
  const sessions = { open: vi.fn(), refresh: vi.fn(async () => {}) }
  const node = <TavernHeroCharacter remote={remote} sessionId="sweep-fail" sessions={sessions}
    session={{ blank: true }} useSessions={() => 'tavern'} />
  await act(async () => { view = create(node) })
  await act(async () => { await Promise.resolve() })

  // 第一次清扫失败：错误可见，并提供重试入口；陈旧绑定仍显示（尚未清掉）。
  expect(clearSessionBinding).toHaveBeenCalledTimes(1)
  const errorBox = () => view!.root.findByProps({ className: 'dsh-tavern-hero-error' })
  expect(errorBox().children.join('')).toContain('模拟清扫失败')
  expect(JSON.stringify(view!.toJSON())).toContain('灯塔')

  await act(async () => { errorBox().findByType(Btn).props.onClick() })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })

  // 重试真的再次清扫，并且成功后绑定与旧卡预览都消失。
  expect(clearSessionBinding).toHaveBeenCalledTimes(2)
  expect(bound).toBe(false)
  expect(view!.root.findAllByProps({ className: 'dsh-tavern-hero-error' })).toHaveLength(0)
  expect(JSON.stringify(view!.toJSON())).not.toContain('灯塔')
})
