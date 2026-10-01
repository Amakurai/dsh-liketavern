/** 楼层操作竞态回归：真实 React 操作条配延迟 remote，保护绑定更新、同批双击和操作互斥。 */
import type { ComponentProps, ReactNode } from 'react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BINDING_CHANGED_EVENT, TavernFloorActions, TavernInterruptedFloorActions } from '../src/client/actions.js'
import { invalidateSessionBinding } from '../src/client/cache.js'
import { setTavernLocale, t } from '../src/client/i18n.js'
import { markSessionView } from '../src/client/sessionViews.js'
import type { TavernRemote } from '../src/client/types.js'
import { resolveConfig } from '../src/node/config.js'
import { rollbackToFloor } from '../src/node/floors.js'
import { TavernState } from '../src/node/state.js'
import { MemoryStore } from '../src/state/memory.js'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', () => ({
  Button: (props: ComponentProps<'button'>) => <button {...props} />,
  Modal: (props: { open: boolean; children?: ReactNode; footer?: ReactNode }) => props.open ? <div>{props.children}{props.footer}</div> : null,
  Tooltip: (props: { children?: ReactNode }) => <>{props.children}</>, Toast: () => null, Menu: () => null,
  IconBranchOutlineMedium: () => null, IconChevronLeftOutlineMedium: () => null, IconChevronRightOutlineMedium: () => null,
  IconEditOutlineMedium: () => null, IconListPenOutlineMedium: () => null, IconLoadingOutlineMedium: () => null,
  IconPlayOutlineMedium: () => null, IconRefreshOutlineMedium: () => null, IconUserOutlineMedium: () => null,
}))

const ok = <T,>(value: T) => ({ ok: true as const, value })
const mounted: ReactTestRenderer[] = []
let unmarkView: () => void
beforeEach(() => {
  setTavernLocale('zh')
  vi.stubGlobal('window', new EventTarget())
  invalidateSessionBinding('floor-concurrency')
  invalidateSessionBinding('other-floor')
  unmarkView = markSessionView('floor-concurrency', true)
})
afterEach(async () => {
  unmarkView()
  for (const view of mounted.splice(0)) await act(async () => view.unmount())
  vi.unstubAllGlobals()
})

function fixture() {
  const fork = vi.fn<TavernRemote['regenerate']>(async () => ok({ childSessionId: 'child' }))
  const remote = {
    getSessionBinding: vi.fn(async () => ok({ binding: { cardId: 'card' } })),
    getGreetingSwipe: vi.fn(async () => ok({ isGreeting: false, started: true, swipe: null })),
    getFloorSiblings: async () => ok({ swipe: null }),
    regenerate: fork, rollbackToFloor: fork,
    continueFloor: vi.fn(async () => ok({})),
    getFloorUserMessage: vi.fn(async () => ok({ turn: 2, text: '用户正文' })),
    getFloorAssistantMessage: vi.fn(async () => ok({ turn: 2, text: '回复正文' })),
    impersonate: vi.fn(async () => ok({ text: '代答正文' })),
  } as unknown as TavernRemote
  const sessions = { open: vi.fn(), refresh: vi.fn(async () => {}) }
  return { remote, sessions, fork }
}
function component(f: ReturnType<typeof fixture>, interrupted: boolean, sessionId = 'floor-concurrency') {
  return interrupted
    ? <TavernInterruptedFloorActions remote={f.remote} sessions={f.sessions} sessionId={sessionId} turn={2} />
    : <TavernFloorActions remote={f.remote} sessions={f.sessions} sessionId={sessionId} messageId="message-2"
      useSessions={select => select({ byId: { [sessionId]: { projectionValues: { agentPreset: 'tavern' } } } })} />
}
async function render(f: ReturnType<typeof fixture>, interrupted = false) {
  let view!: ReactTestRenderer
  await act(async () => { view = create(component(f, interrupted)) })
  mounted.push(view)
  return view
}
const onAction = (view: ReactTestRenderer, key: string) => view.root.findByProps({ 'aria-label': t(key) }).props.onClick as () => void

describe.each([false, true])('楼层分支同步互斥，中断楼层：%s', interrupted => {
  it('兄弟导航刷新期间忽略同批重复导航和分支写入', async () => {
    const f = fixture()
    f.remote.getFloorSiblings = async () => ok({ swipe: { turn: 2, index: 0, total: 2, siblings: ['floor-concurrency', 'sibling'] } })
    const view = await render(f, interrupted)
    const refresh = Promise.withResolvers<void>()
    f.sessions.refresh.mockImplementationOnce(() => refresh.promise)
    const branch = onAction(view, 'actions.branchNext'), regenerate = onAction(view, 'actions.regenerate')
    await act(async () => { branch(); branch(); regenerate() })
    expect(f.sessions.refresh).toHaveBeenCalledOnce()
    expect(f.fork).not.toHaveBeenCalled()
    await act(async () => refresh.resolve())
    expect(f.sessions.open).toHaveBeenCalledExactlyOnceWith('sibling')
    await act(async () => onAction(view, 'actions.regenerate')())
    expect(f.fork).toHaveBeenCalledOnce()
  })

  it('同批重复点击只创建一次分支，等待刷新期间也不接受其它操作', async () => {
    const f = fixture(), view = await render(f, interrupted)
    const fork = Promise.withResolvers<Awaited<ReturnType<TavernRemote['regenerate']>>>()
    const refresh = Promise.withResolvers<void>()
    f.fork.mockImplementationOnce(() => fork.promise)
    f.sessions.refresh.mockImplementationOnce(() => refresh.promise)
    const regenerate = onAction(view, 'actions.regenerate'), rollback = onAction(view, 'actions.rollback')
    await act(async () => { regenerate(); regenerate(); rollback() })
    expect(f.fork).toHaveBeenCalledTimes(1)
    await act(async () => fork.resolve(ok({ childSessionId: 'child' })))
    expect(f.sessions.refresh).toHaveBeenCalledTimes(1)
    await act(async () => rollback())
    expect(f.fork).toHaveBeenCalledTimes(1)
    await act(async () => refresh.resolve())
    expect(f.sessions.open).toHaveBeenCalledOnce()
    await act(async () => onAction(view, 'actions.rollback')())
    expect(f.fork).toHaveBeenCalledTimes(2)
  })

  it('请求失败释放互斥锁，错误保留并允许再次操作', async () => {
    const f = fixture(), view = await render(f, interrupted)
    const pending = Promise.withResolvers<Awaited<ReturnType<TavernRemote['regenerate']>>>()
    f.fork.mockImplementationOnce(() => pending.promise)
    const regenerate = onAction(view, 'actions.regenerate')
    await act(async () => { regenerate(); regenerate() })
    await act(async () => pending.reject(new Error('分支暂时失败')))
    expect(f.fork).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(view.toJSON())).toContain('分支暂时失败')
    await act(async () => onAction(view, 'actions.regenerate')())
    expect(f.fork).toHaveBeenCalledTimes(2)
    expect(f.sessions.open).toHaveBeenCalledOnce()
  })
})

it.each([
  ['actions.continue', 'continueFloor'],
  ['actions.editUser', 'getFloorUserMessage'],
  ['actions.editAi', 'getFloorAssistantMessage'],
  ['actions.impersonate', 'impersonate'],
] as const)('其它楼层操作与分支共享同步互斥：%s', async (action, method) => {
  const f = fixture(), view = await render(f)
  const pending = Promise.withResolvers<unknown>()
  vi.mocked(f.remote[method]).mockImplementationOnce(() => pending.promise as ReturnType<TavernRemote[typeof method]>)
  const invoke = onAction(view, action), regenerate = onAction(view, 'actions.regenerate')
  await act(async () => { invoke(); invoke(); regenerate() })
  expect(f.remote[method]).toHaveBeenCalledTimes(1)
  expect(f.fork).not.toHaveBeenCalled()
  await act(async () => pending.resolve({ ok: false, error: { code: 'test', message: '暂时失败' } }))
  await act(async () => onAction(view, 'actions.regenerate')())
  expect(f.fork).toHaveBeenCalledOnce()
})

it.each(['bound', 'unbound', 'error'] as const)('绑定更新先完成后旧读取迟到，操作条仍遵守最新绑定：%s', async latest => {
  const f = fixture()
  const old = Promise.withResolvers<Awaited<ReturnType<TavernRemote['getSessionBinding']>>>()
  const fresh = Promise.withResolvers<Awaited<ReturnType<TavernRemote['getSessionBinding']>>>()
  vi.mocked(f.remote.getSessionBinding).mockImplementationOnce(() => old.promise).mockImplementationOnce(() => fresh.promise)
  const view = await render(f)
  await act(async () => {
    invalidateSessionBinding('floor-concurrency')
    window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: 'floor-concurrency' }))
  })
  await act(async () => fresh.resolve(latest === 'error'
    ? { ok: false, error: { code: 'test', message: '读取失败' } }
    : ok({ binding: latest === 'bound' ? { cardId: 'new-card' } : null }) as Awaited<ReturnType<TavernRemote['getSessionBinding']>>))
  const expected = latest === 'bound' ? 6 : 0
  expect(view.root.findAllByType('button')).toHaveLength(expected)
  await act(async () => old.resolve(ok({ binding: latest === 'bound' ? null : { cardId: 'old-card' } }) as Awaited<ReturnType<TavernRemote['getSessionBinding']>>))
  expect(view.root.findAllByType('button')).toHaveLength(expected)
})

it('切换到另一会话时，旧会话的已绑定状态不能提前开放新会话操作', async () => {
  const f = fixture(), view = await render(f)
  const pending = Promise.withResolvers<Awaited<ReturnType<TavernRemote['getSessionBinding']>>>()
  vi.mocked(f.remote.getSessionBinding).mockImplementationOnce(() => pending.promise)
  await act(async () => view.update(component(f, false, 'other-floor')))
  expect(view.root.findAllByType('button')).toHaveLength(0)
  expect(f.remote.getGreetingSwipe).toHaveBeenCalledExactlyOnceWith({ sessionId: 'floor-concurrency', messageId: 'message-2' })
  await act(async () => pending.resolve(ok({ binding: null })))
  expect(view.root.findAllByType('button')).toHaveLength(0)
})

/** 真实剧情目录、WAL 与宿主 seed 经过回退入口；UI 双击不能多发布剧情或撤销原剧情。 */
it('同批重复回退只发布一个子剧情，回退后的事实留在正确分支', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tavern-floor-action-concurrency-'))
  try {
    const state = new TavernState({ root: directory, characters: join(directory, 'characters'), lorebooks: join(directory, 'lorebooks'),
      presets: join(directory, 'presets'), personas: join(directory, 'personas'), regexDir: join(directory, 'regex'), sessions: join(directory, 'sessions') }, () => resolveConfig({}))
    await state.init()
    const { cardId } = await state.createCharacter('测试灯塔')
    await state.saveBinding({ sessionId: 'floor-concurrency', cardId, presetId: null, personaId: null, lorebookIds: [],
      characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    const binding = (await state.loadBinding('floor-concurrency'))!
    const source = await state.storyWorkspace(cardId, binding.storyId)
    for (const [turn, body] of [[1, '灯亮着'], [2, '灯已经熄灭']] as const) {
      const floor = `floor-concurrency#t${turn}`
      await source.wal.beginFloor(floor)
      await new MemoryStore(source.fs.withFloor(floor)).write({ body })
      await source.wal.commitFloor(floor)
    }
    const events = [1, 2].flatMap(turn => [
      { type: 'turn/start', data: { turn } },
      { type: 'assistant/message', surfaceOp: 'append', data: { stream: [], turn, step: 1,
        message: { ...createAssistantMessage({ content: [{ type: 'text', text: '测试回复' }], source: { provider: 'test', model: 'test' } }), id: `message-${turn}` } } },
      { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } },
    ]).map((event, seq) => ({ ...event, seq, time: seq })) as SessionEvent[]
    const sourceSession = { id: 'floor-concurrency', header: { agentPreset: 'tavern' }, inheritedEventCount: 0,
      snapshotEvents: () => events, requestHeader: () => ({ config: { provider: 'test', model: 'test' } }) } as unknown as Session
    const childSessions = new Map<string, Session>()
    const createChild = vi.fn(async (options: { sessionId: string; seed: SessionEvent[] }) => {
      childSessions.set(options.sessionId, { ...sourceSession, id: options.sessionId, snapshotEvents: () => options.seed } as Session)
      return { dispose: vi.fn() }
    })
    const ctx = { get: (key: string) => key === 'agentPresets' ? { composedPreset: () => 'tavern', resolve: async () => ({ id: 'tavern' }) } : undefined,
      sessions: { get: (id: string) => id === sourceSession.id ? sourceSession : childSessions.get(id) }, logger: { warn: vi.fn() },
      agents: { get: () => ({ ctx: {}, options: { provider: 'test', model: 'test' } }),
        withoutInitiator: (fn: () => unknown) => fn(), create: createChild },
    } as unknown as Context
    const f = fixture(), gate = Promise.withResolvers<void>()
    f.fork.mockImplementation(async request => {
      await gate.promise
      return ok(await rollbackToFloor({ ctx, state }, request.sessionId, request.messageId))
    })
    const view = await render(f)
    // fixture 使用第二层的消息 ID；回退第一层以检验第二层事实只在子剧情撤销。
    await act(async () => view.update(<TavernFloorActions remote={f.remote} sessions={f.sessions} sessionId="floor-concurrency" messageId="message-1"
      useSessions={select => select({ byId: { 'floor-concurrency': { projectionValues: { agentPreset: 'tavern' } } } })} />))
    const rollback = onAction(view, 'actions.rollback')
    await act(async () => { rollback(); rollback() })
    await act(async () => { gate.resolve(); await f.fork.mock.results[0]!.value })
    expect(f.fork).toHaveBeenCalledOnce()
    expect(createChild).toHaveBeenCalledOnce()
    expect(f.sessions.open).toHaveBeenCalledOnce()
    const childId = f.sessions.open.mock.calls[0]![0] as string
    const child = (await state.loadBinding(childId))!
    expect(await state.listStories(cardId)).toHaveLength(2)
    expect((await source.memory.list()).map(item => item.body).sort()).toEqual(['灯亮着', '灯已经熄灭'])
    expect((await (await state.storyWorkspace(cardId, child.storyId)).memory.list()).map(item => item.body)).toEqual(['灯亮着'])
    expect(childSessions.get(childId)!.snapshotEvents()).toHaveLength(3)
    expect(sourceSession.snapshotEvents()).toHaveLength(6)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
