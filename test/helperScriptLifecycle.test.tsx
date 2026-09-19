/** 后台脚本运行器生命周期：真实 React 与模拟宿主消息验证官方 MVU 适配、故障阻止执行与重载后的运行时隔离。 */
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
vi.mock('../src/core/cardFrame.js', () => ({ buildCardSrcDoc: (html: string) => html }))
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
const betaImport = "import 'https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js';"

it('官方 beta 脚本显示原生适配，并在沙箱就绪回执后允许 MVU 执行', async () => {
  const nativeBundle: HelperScriptBundle = { ...bundle, libraries: [{ ...bundle.libraries[0]!,
    trees: parseHelperScriptTrees([{ id: 'native', name: '原生框架', enabled: true, content: betaImport }]) }] }
  const remote = { getHelperScriptBundle: async () => ({ ok: true, value: structuredClone(nativeBundle) }) } as unknown as TavernRemote
  await act(async () => { view = create(<HelperScripts remote={remote} sessionId="session" />) })
  expect(status().scripts).toEqual([expect.objectContaining({ id: 'native', native: true, state: 'loading' })])
  expect(view!.root.findByType(HelperMvuRunner).props.ready).toBe(false)
  const frame = view!.root.findByType(SpeechHtmlFrame).props
  expect(frame.srcDoc).toContain("waitGlobalInitialized('Mvu')")
  expect(frame.srcDoc).not.toContain('bundle.js')
  await act(async () => frame.onScriptReady(true))
  expect(status().scripts[0]).toMatchObject({ native: true, state: 'ready' })
  expect(view!.root.findByType(HelperMvuRunner).props.ready).toBe(true)
})

it('原生 beta 就绪不能绕过其它脚本故障，旧运行时及故障后的就绪回执也不能放行 MVU', async () => {
  const mixedBundle: HelperScriptBundle = { ...bundle, libraries: [{ ...bundle.libraries[0]!,
    trees: parseHelperScriptTrees([
      { id: 'native', name: '原生框架', enabled: true, content: betaImport },
      { id: 'custom', name: '自定义规则', enabled: true, content: 'throw new Error("工厂故障")' },
    ]) }] }
  const remote = { getHelperScriptBundle: async () => ({ ok: true, value: structuredClone(mixedBundle) }) } as unknown as TavernRemote
  await act(async () => { view = create(<HelperScripts remote={remote} sessionId="session" />) })
  const oldFrames = view!.root.findAllByType(SpeechHtmlFrame).map(frame => frame.props)
  await act(async () => { for (const frame of oldFrames) frame.onScriptReady(true) })
  expect(view!.root.findByType(HelperMvuRunner).props.ready).toBe(true)
  await act(async () => notifyHelperScripts('session', 'story'))
  const frames = view!.root.findAllByType(SpeechHtmlFrame)
  const native = frames.find(frame => frame.props.title === '原生框架')!.props
  const custom = frames.find(frame => frame.props.title === '自定义规则')!.props
  await act(async () => {
    custom.onScriptError('工厂故障')
    for (const frame of oldFrames) frame.onScriptReady(true)
  })
  expect(status().scripts.find(script => script.id === 'native')?.state).toBe('loading')
  expect(view!.root.findByType(HelperMvuRunner).props.ready).toBe(false)
  await act(async () => native.onScriptReady(true))
  expect(status().scripts.find(script => script.id === 'native')).toMatchObject({ native: true, state: 'ready' })
  expect(view!.root.findByType(HelperMvuRunner).props.ready).toBe(false)
  await act(async () => custom.onScriptReady(true))
  expect(status().state).toBe('error')
  expect(status().scripts.find(script => script.id === 'custom')).toMatchObject({ native: false, state: 'error', error: '工厂故障' })
  expect(view!.root.findByType(HelperMvuRunner).props.ready).toBe(false)
})

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
