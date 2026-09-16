/** 后台脚本运行器生命周期：真实 React 与模拟宿主消息验证同版本重载不能复用旧沙箱的就绪或故障状态。 */
import type { ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HelperScripts } from '../src/client/helperScripts.js'
import { HelperMvuRunner } from '../src/client/helperMvuRunner.js'
import { SpeechHtmlFrame } from '../src/client/speech.js'
import { notifyHelperScripts } from '../src/client/helperScriptNotifications.js'
import { scriptStatusStore } from '../src/client/helperScriptStatus.js'
import { parseHelperScriptTrees, type HelperScriptBundle } from '../src/core/helperScripts.js'
import type { TavernRemote } from '../src/client/types.js'

vi.mock('../src/client/speech.js', () => ({ SpeechHtmlFrame: () => null }))
vi.mock('../src/client/helperMvuRunner.js', () => ({ HelperMvuRunner: () => null }))
vi.mock('../src/client/actions.js', () => ({ BINDING_CHANGED_EVENT: 'test-binding-changed' }))
vi.mock('../src/client/styles.js', () => ({ CARD_VARIABLE_STYLES: '' }))
vi.mock('../src/core/cardFrame.js', () => ({ buildCardSrcDoc: () => '<!doctype html>' }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  IconChevronDownOutline14: () => null, Menu: () => null,
}))

let view: ReactTestRenderer | undefined
beforeEach(() => { vi.stubGlobal('window', new EventTarget()) })
afterEach(async () => {
  if (view) await act(async () => view!.unmount())
  view = undefined
  vi.unstubAllGlobals()
})

const bundle: HelperScriptBundle = {
  cardId: 'card', storyId: 'story', revision: 'same-revision', messageId: 0,
  trees: [], libraries: [{ target: { type: 'character', cardId: 'card' }, revision: 'same-revision',
    trees: parseHelperScriptTrees([{ id: 'script', name: '工厂脚本', enabled: true, content: 'await Promise.resolve()' }]) }],
  enabled: true, helperMvu: true, whitelist: [],
  snapshot: { storyId: 'story', historyRevision: 'history', currentMessageId: 0, writable: true, scopes: {},
    messages: [{ message_id: 0, name: '角色', role: 'assistant', is_hidden: false, message: 'hello', data: {}, extra: {} }] },
}
const status = () => scriptStatusStore.getSnapshot().find(item => item.sessionId === 'session')!

it.each([
  { failed: false, delayed: false }, { failed: true, delayed: false },
  { failed: false, delayed: true }, { failed: true, delayed: true },
])('同版本脚本重新挂载须重新就绪，旧错误/延迟：%j', async ({ failed, delayed }) => {
  const getHelperScriptBundle = vi.fn(async () => ({ ok: true as const, value: structuredClone(bundle) }))
  const remote = { getHelperScriptBundle } as unknown as TavernRemote
  await act(async () => { view = create(<HelperScripts remote={remote} sessionId="session" />) })
  await act(async () => view!.root.findByType(SpeechHtmlFrame).props.onScriptReady(true))
  expect(view!.root.findByType(HelperMvuRunner).props.ready).toBe(true)
  const oldFrame = view!.root.findByType(SpeechHtmlFrame).props
  const oldMvu = view!.root.findByType(HelperMvuRunner).props
  if (failed) {
    await act(async () => {
      oldFrame.onScriptError('临时脚本失败')
      oldFrame.onScriptReady(false)
      oldMvu.onStatus({ error: '旧执行器失败', busy: false, retry: () => {} })
    })
    expect(status().scripts[0]?.state).toBe('error')
  }
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof getHelperScriptBundle>>>()
  if (delayed) getHelperScriptBundle.mockReturnValueOnce(pending.promise)
  await act(async () => notifyHelperScripts('session', 'story'))
  if (delayed) {
    expect(view!.root.findAllByType(SpeechHtmlFrame)).toHaveLength(0)
    await act(async () => pending.resolve({ ok: true, value: structuredClone(bundle) }))
  }
  expect(view!.root.findByType(HelperMvuRunner).props.ready).toBe(false)
  expect(status().scripts[0]?.state).toBe('loading')
  expect(status().mvuError).toBeUndefined()
  await act(async () => view!.root.findByType(SpeechHtmlFrame).props.onScriptReady(true))
  expect(view!.root.findByType(HelperMvuRunner).props.ready).toBe(true)
  expect(status().scripts[0]?.state).toBe('ready')
  await act(async () => {
    oldFrame.onScriptError('旧沙箱迟到错误')
    oldFrame.onScriptReady(false)
    oldMvu.onStatus({ error: '旧执行器迟到错误', busy: false, retry: () => {} })
  })
  expect(view!.root.findByType(HelperMvuRunner).props.ready).toBe(true)
  expect(status().scripts[0]?.state).toBe('ready')
  expect(status().mvuError).toBeUndefined()
})
