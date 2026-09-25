/** 楼层编辑交互回归：真实 React 配模拟宿主，验证未保存保护、正文冻结、重复提交与失败重试。 */
import type { ComponentProps, ReactNode } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TavernFloorActions } from '../src/client/actions.js'
import { invalidateSessionBinding } from '../src/client/cache.js'
import { setTavernLocale } from '../src/client/i18n.js'
import { Btn, ConfirmDialog, Dialog } from '../src/client/util.js'
import type { TavernRemote } from '../src/client/types.js'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { editAssistantMessage, getFloorAssistantMessage } from '../src/node/floors.js'
import { MemoryStore } from '../src/state/memory.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div role="dialog">{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null,
  Menu: () => null,
  IconBranchOutlineMedium: () => null, IconChevronLeftOutlineMedium: () => null, IconChevronRightOutlineMedium: () => null,
  IconEditOutlineMedium: () => null, IconListPenOutlineMedium: () => null, IconLoadingOutlineMedium: () => null,
  IconPlayOutlineMedium: () => null, IconRefreshOutlineMedium: () => null, IconUserOutlineMedium: () => null,
}))

const ok = <T,>(value: T) => ({ ok: true as const, value })
const mounted: ReactTestRenderer[] = []
beforeEach(() => { setTavernLocale('zh'); vi.stubGlobal('window', new EventTarget()); invalidateSessionBinding('floor-editor') })
afterEach(async () => { for (const view of mounted.splice(0)) await act(async () => view.unmount()); vi.unstubAllGlobals() })

function fixture() {
  const save = vi.fn<TavernRemote['editAssistantMessage']>(async () => ok({ childSessionId: 'child' }))
  const remote = {
    getSessionBinding: async () => ok({ binding: { cardId: 'factory-card' } }),
    getGreetingSwipe: async () => ok({ isGreeting: false, started: true, swipe: null }),
    getFloorSiblings: async () => ok({ swipe: null }),
    getFloorUserMessage: async () => ok({ turn: 2, text: '原始台词' }),
    getFloorAssistantMessage: async () => ok({ turn: 2, text: '原始台词' }),
    editUserMessage: save, editAssistantMessage: save,
  } as unknown as TavernRemote
  const sessions = { open: vi.fn(), refresh: vi.fn(async () => {}) }
  return { remote, sessions, save }
}
async function render(f: ReturnType<typeof fixture>) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(<TavernFloorActions remote={f.remote} sessions={f.sessions} sessionId="floor-editor" messageId="message-2"
    useSessions={(select) => select({ byId: { 'floor-editor': { projectionValues: { agentPreset: 'tavern' } } } })} />) })
  mounted.push(view)
  return view
}
const button = (view: ReactTestRenderer, label: string) => view.root.findAllByType(Btn).find((item) => item.props.children === label)!
const confirmation = (view: ReactTestRenderer) => view.root.findAllByType(ConfirmDialog).find((item) => item.props.open)
const change = async (view: ReactTestRenderer, text: string) => act(async () => view.root.findByType('textarea').props.onChange({ target: { value: text } }))
const requestClose = async (view: ReactTestRenderer) => act(async () => view.root.findByType(Dialog).props.onClose())

describe.each([
  { label: '编辑这一层的用户消息', saveLabel: '保存并重跑' },
  { label: '编辑回复并撤销该层旧事实（不重跑）', saveLabel: '保存（不重跑）' },
])('楼层编辑：$label', ({ label, saveLabel }) => {
  async function open(view: ReactTestRenderer) {
    await act(async () => view.root.findByProps({ 'aria-label': label }).props.onClick())
  }

  it('原文和空白不能保存，恢复原文可直接关闭且不创建分支', async () => {
    const f = fixture(), view = await render(f)
    await open(view)
    expect(button(view, saveLabel).props.disabled).toBe(true)
    await act(async () => button(view, saveLabel).props.onClick())
    expect(f.save).not.toHaveBeenCalled()
    await change(view, '新台词')
    expect(button(view, saveLabel).props.disabled).toBe(false)
    await change(view, '   ')
    expect(button(view, saveLabel).props.disabled).toBe(true)
    await change(view, '原始台词')
    await requestClose(view)
    expect(confirmation(view)).toBeUndefined()
    expect(view.root.findAllByType('textarea')).toHaveLength(0)
  })

  it('取消或关闭都保护未保存正文，返回编辑保留草稿，明确放弃才关闭', async () => {
    const f = fixture(), view = await render(f)
    await open(view)
    await change(view, '尚未保存的台词')
    const unload = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(unload)
    expect(unload.defaultPrevented).toBe(true)
    await act(async () => button(view, '取消').props.onClick())
    expect(confirmation(view)).toBeDefined()
    await act(async () => confirmation(view)!.props.onCancel())
    expect(view.root.findByType('textarea').props.value).toBe('尚未保存的台词')
    await requestClose(view)
    expect(confirmation(view)).toBeDefined()
    await act(async () => confirmation(view)!.props.onConfirm())
    expect(view.root.findAllByType('textarea')).toHaveLength(0)
    expect(f.save).not.toHaveBeenCalled()
    const after = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })

  it('保存等待时冻结正文并阻止同批双击；失败后保留内容并可重试', async () => {
    const f = fixture(), view = await render(f)
    const pending = Promise.withResolvers<Awaited<ReturnType<TavernRemote['editAssistantMessage']>>>()
    f.save.mockImplementationOnce(() => pending.promise)
    await open(view)
    await change(view, '要保存的台词')
    const submit = button(view, saveLabel).props.onClick
    await act(async () => { submit(); submit() })
    expect(f.save).toHaveBeenCalledTimes(1)
    expect(view.root.findByType('textarea').props.disabled).toBe(true)
    await change(view, '排队中的迟到输入')
    await requestClose(view)
    expect(view.root.findByType('textarea').props.value).toBe('要保存的台词')
    expect(confirmation(view)).toBeUndefined()
    await act(async () => pending.resolve({ ok: false, error: { code: 'test', message: '模拟保存失败' } }))
    expect(view.root.findByType('textarea').props.disabled).toBe(false)
    expect(JSON.stringify(view.toJSON())).toContain('模拟保存失败')
    expect(f.sessions.open).not.toHaveBeenCalled()
    await act(async () => button(view, saveLabel).props.onClick())
    expect(f.save).toHaveBeenLastCalledWith({ sessionId: 'floor-editor', messageId: 'message-2', text: '要保存的台词' })
    expect(f.sessions.refresh).toHaveBeenCalledOnce()
    expect(f.sessions.open).toHaveBeenCalledWith('child')
    expect(view.root.findAllByType('textarea')).toHaveLength(0)
  })

  it('传输异常后解除保存锁并保留草稿', async () => {
    const f = fixture(), view = await render(f)
    f.save.mockRejectedValueOnce(new Error('连接已断开'))
    await open(view)
    await change(view, '重连后继续保存')
    await act(async () => button(view, saveLabel).props.onClick())
    expect(view.root.findByType('textarea').props.value).toBe('重连后继续保存')
    expect(button(view, saveLabel).props.disabled).toBe(false)
    expect(JSON.stringify(view.toJSON())).toContain('连接已断开')
    await requestClose(view)
    expect(confirmation(view)).toBeDefined()
  })
})

/** 真实剧情文件和楼层事务经过 UI 保存入口，宿主创建失败后可重试且原剧情始终保留。 */
it('编辑回复失败重试只发布一个分支，正文与派生事实分别落在正确剧情', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tavern-floor-editor-'))
  try {
    const state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'),
      presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
    await state.init()
    const { cardId } = await state.createCharacter('测试灯塔')
    await state.saveBinding({ sessionId: 'floor-editor', cardId, presetId: null, personaId: null, lorebookIds: [],
      characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    const binding = (await state.loadBinding('floor-editor'))!
    const source = await state.storyWorkspace(cardId, binding.storyId)
    await source.wal.beginFloor('floor-editor#t2')
    await new MemoryStore(source.fs.withFloor('floor-editor#t2')).write({ body: '灯亮着' })
    await source.wal.commitFloor('floor-editor#t2')
    const message = { ...createAssistantMessage({ content: [{ type: 'text', text: '灯亮着' }], source: { provider: 'test', model: 'test' } }), id: 'message-2' }
    const events = [
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: '看看灯塔' }], source: { kind: 'user' } }) },
      { type: 'assistant/message', data: {stream: [],  turn: 2, step: 1, message } },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    ].map((event, seq) => ({ ...event, seq, time: seq })) as SessionEvent[]
    const sourceSession = { id: 'floor-editor', header: { agentPreset: 'tavern' }, inheritedEventCount: 0,
      snapshotEvents: () => events, requestHeader: () => ({ config: { provider: 'test', model: 'test' } }) } as unknown as Session
    const storedSessions = new Map<string, Session>([['floor-editor', sourceSession]])
    const createChild = vi.fn(async (options: { sessionId: string; seed: SessionEvent[] }) => {
      storedSessions.set(options.sessionId, { ...sourceSession, id: options.sessionId, snapshotEvents: () => options.seed } as Session)
      return { dispose: vi.fn() }
    }).mockRejectedValueOnce(new Error('模拟宿主创建失败'))
    const ctx = { get: (key: string) => key === 'agentPresets' ? { composedPreset: () => 'tavern', resolve: async () => ({ id: 'tavern' }) } : undefined,
      sessions: { get: (id: string) => storedSessions.get(id) }, logger: { warn: vi.fn() },
      agents: { get: () => ({ ctx: {}, options: { provider: 'test', model: 'test' } }),
        withoutInitiator: (fn: () => unknown) => fn(), create: createChild },
    } as unknown as Context
    const f = fixture()
    f.remote.getFloorAssistantMessage = async (request) => ok(await getFloorAssistantMessage({ ctx, state }, request.sessionId, request.messageId))
    f.save.mockImplementation(async (request) => ok(await editAssistantMessage({ ctx, state }, request.sessionId, request.messageId, request.text)))
    const view = await render(f)
    await act(async () => view.root.findByProps({ 'aria-label': '编辑回复并撤销该层旧事实（不重跑）' }).props.onClick())
    expect(button(view, '保存（不重跑）').props.disabled).toBe(true)
    await change(view, '灯已经熄灭')
    await act(async () => {
      const submit = button(view, '保存（不重跑）').props.onClick
      submit(); submit()
      await f.save.mock.results[0]!.value.catch(() => {})
    })
    expect(f.save).toHaveBeenCalledTimes(1)
    expect(await state.listStories(cardId)).toHaveLength(1)
    expect(view.root.findByType('textarea').props.value).toBe('灯已经熄灭')
    expect(JSON.stringify(view.toJSON())).toContain('模拟宿主创建失败')
    expect(f.sessions.open).not.toHaveBeenCalled()
    await act(async () => {
      button(view, '保存（不重跑）').props.onClick()
      await f.save.mock.results[1]!.value
    })
    const childId = f.sessions.open.mock.calls[0]![0] as string
    const childBinding = (await state.loadBinding(childId))!
    expect(await state.listStories(cardId)).toHaveLength(2)
    expect((await source.memory.list()).map((item) => item.body)).toEqual(['灯亮着'])
    expect(await (await state.storyWorkspace(cardId, childBinding.storyId)).memory.list()).toEqual([])
    const childMessage = storedSessions.get(childId)!.snapshotEvents().find((event) => event.type === 'assistant/message')!
    const childMessageId = (childMessage.data as { message: { id: string } }).message.id
    expect((await getFloorAssistantMessage({ ctx, state }, childId, childMessageId)).text).toBe('灯已经熄灭')
    expect((await getFloorAssistantMessage({ ctx, state }, 'floor-editor', 'message-2')).text).toBe('灯亮着')
  } finally { await rm(root, { recursive: true, force: true }) }
})
