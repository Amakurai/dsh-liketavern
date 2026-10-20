/**
 * 修复后行为（C5）：后台脚本容器等待首条消息时的轮询改为指数退避 + 次数上限。
 * 长时不发言不再 1Hz 空转；上限用尽后只靠剧情通知唤醒，定时器在卸载时全部清掉。
 */
import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HelperScripts } from '../../src/client/helperScripts.js'
import { parseHelperScriptTrees, type HelperScriptBundle } from '../../src/core/helperScripts.js'
import type { TavernRemote } from '../../src/client/types.js'

vi.mock('../../src/client/speech.js', () => ({ SpeechHtmlFrame: () => null }))
vi.mock('../../src/client/helperMvuRunner.js', () => ({ HelperMvuRunner: () => null }))
vi.mock('../../src/client/actions.js', () => ({ BINDING_CHANGED_EVENT: 'test-binding-changed' }))
vi.mock('../../src/client/styles.js', () => ({ CARD_VARIABLE_STYLES: '' }))
vi.mock('../../src/core/cardFrame.js', () => ({ buildCardSrcDoc: (html: string) => html }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  IconChevronDownOutlineMedium: () => null, Menu: () => null,
}))

let view: ReactTestRenderer | undefined
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('window', new EventTarget())
})
afterEach(async () => {
  if (view) await act(async () => view!.unmount())
  view = undefined
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** 已启用脚本但还没有任何角色消息：正是原来每秒重拉 bundle 的等待场景。 */
const waitingBundle: HelperScriptBundle = {
  cardId: 'card', storyId: 'story', revision: 'revision', messageId: null,
  trees: [], libraries: [{ target: { type: 'character', cardId: 'card' }, revision: 'revision',
    trees: parseHelperScriptTrees([{ id: 'script', name: '等待脚本', enabled: true, content: 'await Promise.resolve()' }]) }],
  enabled: true, helperMvu: false, whitelist: [],
}

it('等待首条消息的轮询指数退避且有上限，卸载后不再重拉', async () => {
  const getHelperScriptBundle = vi.fn(async () => ({ ok: true as const, value: structuredClone(waitingBundle) }))
  const remote = { getHelperScriptBundle } as unknown as TavernRemote
  await act(async () => { view = create(<HelperScripts remote={remote} sessionId="session" />) })
  await act(async () => { await Promise.resolve() })
  expect(getHelperScriptBundle).toHaveBeenCalledTimes(1)

  // 1 分钟、按秒推进（每次推进后让 React 提交）：退避后只有个位数重拉；
  // 旧的固定 1s 轮询会产生约 60 次。
  for (let second = 0; second < 60; second++) {
    await act(async () => { vi.advanceTimersByTime(1_000) })
    await act(async () => { await Promise.resolve() })
  }
  const afterMinute = getHelperScriptBundle.mock.calls.length
  expect(afterMinute).toBeGreaterThan(1)
  expect(afterMinute).toBeLessThanOrEqual(12)

  // 再等 30 分钟：重试次数上限（1 次首载 + 20 次重试）用尽后不再排新定时器。
  await act(async () => { vi.advanceTimersByTime(1_800_000) })
  await act(async () => { await Promise.resolve() })
  const afterHour = getHelperScriptBundle.mock.calls.length
  expect(afterHour).toBeLessThanOrEqual(21)
  expect(vi.getTimerCount()).toBe(0)

  await act(async () => { view!.unmount() })
  view = undefined
  await act(async () => { vi.advanceTimersByTime(600_000) })
  expect(getHelperScriptBundle.mock.calls.length).toBe(afterHour)
  expect(vi.getTimerCount()).toBe(0)
})
