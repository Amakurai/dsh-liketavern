/**
 * 修复后行为（C3）：hero 选角等待进行中的清扫改为有界等待（不再是 20ms 无限忙等）。
 * 清扫请求悬挂时，等待在写超时后明确失败并放行选角流程；卸载后不留下重排的定时器。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { TavernHeroCharacter } from '../../src/client/hero.js'
import { CharacterPicker } from '../../src/client/characterPicker.js'
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
  vi.useFakeTimers()
  vi.stubGlobal('window', Object.assign(new EventTarget(), { setTimeout, clearTimeout }))
  vi.stubGlobal('document', { body: {} })
  vi.stubGlobal('HTMLElement', class {})
  vi.stubGlobal('MutationObserver', class { observe() {} disconnect() {} })
})
afterEach(async () => {
  if (view) await act(async () => view!.unmount())
  view = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const ok = <T,>(value: T) => ({ ok: true as const, value })

it('清扫在途期间选角保存失败时，同步刷新已被清扫的绑定状态并复位选角标记', async () => {
  let clearedOnServer = false
  const clearGate = Promise.withResolvers<{ ok: true; value: { cleared: boolean } }>()
  const getSessionBinding = vi.fn(async ({ sessionId }: { sessionId: string }) =>
    ok({ binding: clearedOnServer ? null : { sessionId, cardId: 'card', greetingIndex: 0 }, userName: '旅人', canSwipeGreeting: true, conversationStarted: false }))
  const setSessionBinding = vi.fn(async () => ({ ok: false as const, error: { code: 'ERR', message: '选角写入失败' } }))
  const remote = {
    renderOutputText: vi.fn(async ({ text }: { text: string }) => ok({ text, htmls: [] as string[] })),
    getSessionBinding,
    listCharacters: async () => ok({ items: [] }),
    setSessionBinding,
    clearSessionBinding: vi.fn(async () => {
      const res = await clearGate.promise
      clearedOnServer = true
      return res
    }),
  } as unknown as TavernRemote
  const sessions = { open: vi.fn(), refresh: vi.fn(async () => {}) }
  await act(async () => {
    view = create(<TavernHeroCharacter remote={remote} sessionId="clearing-pick-fail" sessions={sessions}
      session={{ blank: true }} useSessions={() => 'tavern'} />)
  })
  await act(async () => { await Promise.resolve() })
  expect(getSessionBinding).toHaveBeenCalledTimes(1)

  const chip = view!.root.findByProps({ 'data-tavern-hero-seat': '' }).findByType('button')
  await act(async () => { chip.props.onClick() })
  const pickPromise = act(async () => {
    view!.root.findByType(CharacterPicker).props.onPick('card')
    clearGate.resolve(ok({ cleared: true }))
  })
  await pickPromise
  expect(setSessionBinding).toHaveBeenCalledTimes(1)
  expect(getSessionBinding.mock.calls.length).toBeGreaterThanOrEqual(2)
  expect(JSON.stringify(view!.toJSON())).not.toContain('灯塔')
})

it('清扫悬挂时选角等待有界超时后继续，卸载后不再排队定时器', async () => {
  const setSessionBinding = vi.fn(async () => ok({ saved: true }))
  const remote = {
    renderOutputText: vi.fn(async ({ text }: { text: string }) => ok({ text, htmls: [] as string[] })),
    getSessionBinding: async ({ sessionId }: { sessionId: string }) =>
      ok({ binding: { sessionId, cardId: 'card', greetingIndex: 0 }, userName: '旅人', canSwipeGreeting: true, conversationStarted: false }),
    listCharacters: async () => ok({ items: [] }),
    setSessionBinding,
    // 悬挂的清扫请求：既不放行也不失败，只能靠写超时兜底。
    clearSessionBinding: vi.fn(() => new Promise(() => {})),
  } as unknown as TavernRemote
  const sessions = { open: vi.fn(), refresh: vi.fn(async () => {}) }
  await act(async () => {
    view = create(<TavernHeroCharacter remote={remote} sessionId="clearing-hang" sessions={sessions}
      session={{ blank: true }} useSessions={() => 'tavern'} />)
  })
  await act(async () => { await Promise.resolve() })

  const chip = view!.root.findByProps({ 'data-tavern-hero-seat': '' }).findByType('button')
  await act(async () => { chip.props.onClick() })
  await act(async () => { view!.root.findByType(CharacterPicker).props.onPick('card') })
  // 还在有界等待中：没有 20ms 忙等循环，也没有发出写入。
  expect(setSessionBinding).not.toHaveBeenCalled()

  // 推进到写超时：清扫明确失败，选角流程继续走完（不再是无限等待）。
  await act(async () => { vi.advanceTimersByTime(20_000) })
  await act(async () => { await Promise.resolve() })
  await act(async () => { await Promise.resolve() })
  expect(remote.clearSessionBinding).toHaveBeenCalledTimes(1)
  expect(setSessionBinding).toHaveBeenCalledTimes(1)
  const error = view!.root.findByProps({ className: 'dsh-tavern-hero-error' }).children.join('')
  expect(error).toMatch(/timed out|超时/)

  await act(async () => { view!.unmount() })
  view = undefined
  await act(async () => { vi.advanceTimersByTime(3_000) })
  // 卸载后没有仍在重排的定时器（旧实现的 20ms 循环会一直存活）。
  expect(vi.getTimerCount()).toBe(0)
})
