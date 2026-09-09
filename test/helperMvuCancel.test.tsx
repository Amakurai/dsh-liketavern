/** 自动 MVU 取消等待界面：真实 React 检查宿主回调去重、失败可重试，以及保留原执行 iframe/事务。 */
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { HelperMvuRunner } from '../src/client/helperMvuRunner.js'
import { HelperScripts } from '../src/client/helperScripts.js'
import { Btn, Err } from '../src/client/util.js'
import { setTavernLocale } from '../src/client/i18n.js'
import type { TavernRemote } from '../src/client/types.js'
import type { HelperSnapshot } from '../src/core/helperRuntime.js'

vi.mock('../src/client/styles.js', () => ({ CARD_VARIABLE_STYLES: '' }))
vi.mock('../src/client/speech.js', () => ({ SpeechHtmlFrame: () => null }))
vi.mock('../src/client/helperScriptEditor.js', () => ({ HelperScriptEditor: () => null }))
vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  IconCopyOutline16: () => null, IconUserOutline16: () => null, IconChevronDownOutline14: () => null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>,
  Button: (props: { children?: ReactNode }) => <button>{props.children}</button>, Toast: () => null,
}))
const snapshot: HelperSnapshot = { storyId: 'story', historyRevision: 'revision', currentMessageId: 0, messages: [], scopes: {}, writable: false }
const source = { postMessage: vi.fn() }
let view: ReactTestRenderer | undefined
beforeEach(() => { vi.stubGlobal('window', new EventTarget()); setTavernLocale('zh'); source.postMessage.mockClear() })
afterEach(async () => { if (view) await act(async () => view!.unmount()); view = undefined; vi.unstubAllGlobals() })
async function mount(component: ReactNode): Promise<void> {
  await act(async () => { view = create(component, { createNodeMock: element => element.type === 'iframe' ? { contentWindow: source } : null }) })
}
const cancelButton = () => view!.root.findAllByType(Btn).find(button => String(button.props.children).includes('取消等待'))!

it('等待脚本时可取消，重复点击只调用一次宿主动作并保留执行器', async () => {
  const release = Promise.withResolvers<void>(), onCancel = vi.fn(() => release.promise)
  const prepareHelperMvuJob = vi.fn(), commitHelperMvuJob = vi.fn()
  await mount(<HelperMvuRunner remote={{ prepareHelperMvuJob, commitHelperMvuJob } as unknown as TavernRemote} sessionId="session" storyId="story" snapshot={snapshot} ready={false} onCancel={onCancel}/>)
  const original = view!.root.findByType('iframe').props.srcDoc
  await act(async () => { cancelButton().props.onClick(); cancelButton().props.onClick() })
  expect(onCancel).toHaveBeenCalledTimes(1); expect(cancelButton().props.disabled).toBe(true)
  await act(async () => release.resolve())
  expect(cancelButton().props.disabled).toBe(false)
  expect(view!.root.findByType('iframe').props.srcDoc).toBe(original)
  expect(view!.root.findByType('iframe').props.sandbox).toBe('allow-scripts')
  expect(prepareHelperMvuJob).not.toHaveBeenCalled(); expect(commitHelperMvuJob).not.toHaveBeenCalled()
  expect(source.postMessage).not.toHaveBeenCalled()
})

it('取消动作失败单独显示错误并可重试，不把失败解释为任务已删除', async () => {
  const onCancel = vi.fn().mockRejectedValueOnce(new Error('宿主取消连接失败')).mockResolvedValue(undefined)
  await mount(<HelperMvuRunner remote={{} as TavernRemote} sessionId="session" storyId="story" snapshot={snapshot} ready={false} onCancel={onCancel}/>)
  await act(async () => cancelButton().props.onClick())
  expect(view!.root.findAllByType(Err).some(error => error.props.message === '宿主取消连接失败')).toBe(true)
  expect(view!.root.findAllByType('iframe')).toHaveLength(1)
  await act(async () => cancelButton().props.onClick())
  expect(onCancel).toHaveBeenCalledTimes(2)
  expect(view!.root.findAllByType(Err).some(error => error.props.message === '宿主取消连接失败')).toBe(false)
})

it('后台脚本容器将会话取消能力传给运行器，未提供能力时不展示无效按钮', async () => {
  const onCancel = vi.fn(async () => {})
  const getHelperScriptBundle = vi.fn(async () => ({ ok: true, value: { enabled: true, helperMvu: true, storyId: 'story', cardId: 'card', messageId: 0, snapshot, trees: [], revision: 'revision' } }))
  await mount(<HelperScripts remote={{ getHelperScriptBundle } as unknown as TavernRemote} sessionId="session" onCancel={onCancel}/>)
  expect(view!.root.findByProps({className:"dsh-tavern-scriptHost"}).props.hidden).toBe(true)
  expect(view!.root.findByType(HelperMvuRunner).props.onCancel).toBe(onCancel)
  await act(async () => view!.update(<HelperMvuRunner remote={{} as TavernRemote} sessionId="session" storyId="story" snapshot={snapshot} ready={false}/>))
  expect(cancelButton()).toBeUndefined()
})
