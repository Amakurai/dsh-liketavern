/** 公开同步事件源的手写适配器：验证实时消息边界、收口屏障、异步取消、队列预算和会话切换，不打开历史或调用模型。 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionEventLikeEntry, SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import { SessionId, SessionSeq, type SessionEvent, type TurnEndReason } from '@deepseek-ai/dsh-session/types'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { installHelperLiveEvents } from '../src/client/helperLiveEvents.js'
import { emitHelperHostEvent, reportHelperHostEventError } from '../src/client/helperEventRouter.js'
import { watchHelperStory } from '../src/client/helperNotifications.js'
import type { ClientContext, TavernRemote } from '../src/client/types.js'
import type { TavernMethodResults } from '../src/remote.js'

vi.mock('../src/client/actions.js', () => ({ BINDING_CHANGED_EVENT: 'fixture-binding-changed' }))
vi.mock('../src/client/helperEventRouter.js', () => ({ emitHelperHostEvent: vi.fn(), reportHelperHostEventError: vi.fn() }))
type State = TavernMethodResults['getHelperEventState']
type EventRequest = Parameters<TavernRemote['getHelperEventState']>[0]
type Emission = { sessionId: string; storyId: string; event: string; data: unknown[] }
const emissions: Emission[] = [], cleanups: (() => void)[] = []
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise<void>(resolve => setImmediate(resolve)) }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
let browser: EventTarget
beforeEach(() => {
  vi.clearAllMocks(); emissions.length = 0; browser = new EventTarget(); vi.stubGlobal('window', browser)
  vi.mocked(emitHelperHostEvent).mockImplementation(async (sessionId, storyId, event, data, current) => {
    if (current && !current()) throw new Error('fixture stale source')
    emissions.push({ sessionId, storyId, event, data })
  })
})
afterEach(() => { for (const stop of cleanups.splice(0)) stop(); vi.unstubAllGlobals(); vi.useRealTimers() })

class Source implements SessionEventSource {
  listeners = new Set<() => void>()
  snapshot: SessionEventWindow
  constructor(events: SessionEvent[] = []) {
    const entries = events.map(event => ({ type: 'event' as const, event }))
    this.snapshot = { entries, hasMore: false, revision: 0, change: { kind: 'replace', entries } }
  }
  getSnapshot = () => this.snapshot
  subscribe = (fn: () => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  notify() { for (const listener of this.listeners) listener() }
  append(...events: SessionEvent[]) {
    const entries = events.map(event => ({ type: 'event' as const, event }))
    this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1, entries: [...this.snapshot.entries, ...entries], change: { kind: 'append', entries } }
    this.notify()
  }
  replace(events: SessionEvent[]) {
    const entries = events.map(event => ({ type: 'event' as const, event }))
    this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1, entries, change: { kind: 'replace', entries } }
    this.notify()
  }
  prepend(events: SessionEvent[]) {
    const entries: SessionEventLikeEntry[] = events.map(event => ({ type: 'event', event }))
    this.snapshot = { ...this.snapshot, revision: this.snapshot.revision + 1, entries: [...entries, ...this.snapshot.entries], change: { kind: 'prepend', entries } }
    this.notify()
  }
}
const start = (seq: number, turn = 1): SessionEvent<'turn/start'> => ({ seq: SessionSeq(seq), time: seq, type: 'turn/start', data: { turn } })
const end = (seq: number, turn = 1, reason: TurnEndReason = { kind: 'completed' }): SessionEvent<'turn/end'> => ({ seq: SessionSeq(seq), time: seq, type: 'turn/end', data: { turn, reason } })
const user = (seq: number, text = '用户台词'): SessionEvent<'user/message'> => ({ seq: SessionSeq(seq), time: seq, type: 'user/message', surfaceOp: 'append', data: createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }) })
const assistant = (seq: number, turn = 1, step = 1, interrupted = false): SessionEvent<'assistant/message'> => ({ seq: SessionSeq(seq), time: seq, type: 'assistant/message', surfaceOp: 'append', data: { turn, step, message: createAssistantMessage({ content: [{ type: 'text', text: '角色回复' }], source: { provider: 'fixture', model: 'fixture' } }), ...(interrupted ? { interrupted: true } : {}) } })

function fixture(initial: SessionEvent[] = [], initialCurrent: string | undefined = 'session') {
  const source = new Source(initial), sources = new Map([['session', source]])
  const listListeners = new Set<() => void>()
  let selected = initialCurrent, preset = 'tavern', storyId = 'story'
  const sessions: ClientContext['sessions'] = {
    open: vi.fn(),
    binding: id => { const value = sources.get(id); return value ? { sessionId: SessionId(id), eventSource: value } : undefined },
    list: {
      getSnapshot: () => ({ current: selected, byId: Object.fromEntries([...sources].map(([id]) => [id, { projectionValues: { agentPreset: preset } }])) }),
      subscribe: fn => { listListeners.add(fn); return () => { listListeners.delete(fn) } },
    },
  }
  const state = (request: EventRequest): State => {
    if (request.storyId !== undefined && request.storyId !== storyId) throw new Error('fixture story changed')
    const events = sources.get(request.sessionId)?.snapshot.entries.flatMap(entry => entry.type === 'event' ? [entry.event] : []) ?? []
    // 服务负责把完整历史映射为规范下标；模拟不可见消息不占位置，客户端不能以当前分页自己编号。
    const visible = events.filter(event => event.type === 'assistant/message' && (event.surfaceOp === undefined || event.surfaceOp === 'append') ||
      event.type === 'user/message' && (event.surfaceOp === undefined || event.surfaceOp === 'append') && event.data.content.some(block => block.type === 'text' && block.text !== 'fixture synthetic'))
    const messages: State['messages'] = visible.map((event, message_id) => ({ seq: event.seq, message_id, role: event.type === 'user/message' ? 'user' : 'assistant' }))
    const closedThrough = Math.max(-1, ...events.filter(event => event.type === 'turn/end').map(event => event.seq))
    return { storyId, historyRevision: `revision-${events.length}`, messages, writable: true, closedThrough }
  }
  const getHelperEventState = vi.fn<TavernRemote['getHelperEventState']>(async request => ({ ok: true, value: state(request) }))
  const stop = installHelperLiveEvents(sessions, { getHelperEventState }); cleanups.push(stop)
  return { source, sources, sessions, state, getHelperEventState, stop,
    select: (id: string | undefined) => { selected = id; for (const fn of listListeners) fn() },
    preset: (value: string) => { preset = value; for (const fn of listListeners) fn() },
    story: (value: string) => { storyId = value; browser.dispatchEvent(new CustomEvent('fixture-binding-changed', { detail: selected })) },
  }
}
const events = () => emissions.map(({ event, data }) => [event, data])

it('初始历史、分页和重连仅建立基线，不把旧回复或初始 append 快照当成新消息', async () => {
  const f = fixture([start(10), assistant(11), end(12)]), notify = vi.fn()
  cleanups.push(watchHelperStory('session', 'story', notify)); await settle()
  f.source.prepend([user(2)]); f.source.notify(); f.source.replace([user(2), start(10), assistant(11), end(12)])
  f.source.append(end(13)); await settle()
  expect(emissions).toEqual([]); expect(notify).toHaveBeenCalledTimes(1)
  expect(f.sessions.open).not.toHaveBeenCalled()
  f.stop(); const late = installHelperLiveEvents(f.sessions, { getHelperEventState: f.getHelperEventState }); cleanups.push(late)
  await settle(); expect(emissions).toEqual([])
})

it('同步连续 append 保持每个增量，去重后按规范下标发送可见用户、多个步骤回复和结束事件', async () => {
  const f = fixture([assistant(0, 0)]), notify = vi.fn()
  cleanups.push(watchHelperStory('session', 'story', notify)); await settle()
  f.source.append(start(1)); f.source.append(user(2, 'fixture synthetic')); f.source.append(user(3))
  f.source.append(assistant(4, 1, 1)); f.source.append(assistant(5, 1, 2)); f.source.append(end(6)); f.source.notify()
  f.source.append(end(6)); await settle()
  expect(events()).toEqual([
    ['generation_started', ['normal', {}, false]], ['message_sent', [1]],
    ['message_received', [2, 'normal']], ['message_received', [3, 'normal']], ['generation_ended', [3]],
  ])
  expect(notify).toHaveBeenCalledTimes(2)
  expect(f.getHelperEventState.mock.calls.some(([request]) => request.closedSeq === 6 && request.storyId === 'story')).toBe(true)
})

it('surface replace 和中断消息不伪造正常回复，非 completed 轮次只报告停止', async () => {
  const f = fixture(); await settle()
  const replacement: SessionEvent<'assistant/message'> = { ...assistant(2), surfaceOp: { op: 'replace', start: 0, end: 0 } }
  f.source.append(start(0), user(1), replacement, assistant(3, 1, 1, true), end(4, 1, { kind: 'aborted', reason: { kind: 'legacy' } }))
  f.source.append(start(5, 2), assistant(6, 2), end(7, 2, { kind: 'max-tokens' }))
  await settle()
  expect(events()).toEqual([
    ['generation_started', ['normal', {}, false]], ['message_sent', [0]], ['generation_stopped', []],
    ['generation_started', ['normal', {}, false]], ['generation_stopped', []],
  ])
})

it('排队时下一轮已到达，上一轮结束编号仍截断到该 turn/end', async () => {
  const f = fixture(); await settle()
  f.source.append(start(0), user(1), assistant(2), end(3), start(4, 2), user(5), assistant(6, 2), end(7, 2))
  await settle()
  expect(emissions.filter(item => item.event === 'generation_ended').map(item => item.data)).toEqual([[1], [3]])
})

it('旧日志默认 append 交给权威消息目录过滤，最初已打开轮次只报告后来实际追加的回复', async () => {
  const f = fixture([start(0), assistant(1)]); await settle()
  f.source.append({ ...user(2), surfaceOp: undefined }, { ...assistant(3), surfaceOp: undefined }, end(4))
  await settle()
  expect(events()).toEqual([['message_sent', [1]], ['message_received', [2, 'normal']], ['generation_ended', [2]]])
})

it.each<TurnEndReason>([{ kind: 'blocked' }, { kind: 'interrupted' }, { kind: 'error', error: { code: 'UNKNOWN', message: 'fixture' } }])('其他失败收口 %j 都不伪造成功接收', async reason => {
  const f = fixture(); await settle(); f.source.append(start(0), assistant(1), end(2, 1, reason)); await settle()
  expect(events()).toEqual([['generation_started', ['normal', {}, false]], ['generation_stopped', []]])
})

it('回复必须等待确切完成屏障，收口失败显式报错且不通知收到或成功结束', async () => {
  const f = fixture(); await settle()
  const barrier = deferred<void>()
  f.getHelperEventState.mockImplementation(async request => {
    if (request.closedSeq !== undefined) { await barrier.promise; return { ok: false, error: { code: 'fixture', message: 'fixture WAL close failed' } } }
    return { ok: true, value: f.state(request) }
  })
  f.source.append(start(0), assistant(1), end(2)); await settle()
  expect(events()).toEqual([['generation_started', ['normal', {}, false]]])
  barrier.resolve(); await settle()
  expect(reportHelperHostEventError).toHaveBeenCalledWith('session', 'story', expect.objectContaining({ message: 'fixture WAL close failed' }))
  expect(events()).toEqual([['generation_started', ['normal', {}, false]]])
})

it('重连取消已排队 RPC 和未结束回复，新的 turn/end 不能复用旧 pending', async () => {
  const f = fixture(); await settle()
  const response = deferred<Awaited<ReturnType<TavernRemote['getHelperEventState']>>>()
  f.getHelperEventState.mockReturnValueOnce(response.promise)
  f.source.append(start(0), assistant(1)); await settle()
  const old = f.state({ sessionId: 'session' }); f.source.replace([start(0), assistant(1)])
  f.source.append(end(2)); response.resolve({ ok: true, value: old }); await settle()
  expect(emissions).toEqual([])
  f.source.append(start(3, 2), assistant(4, 2), end(5, 2)); await settle()
  expect(events()).toEqual([['generation_started', ['normal', {}, false]], ['message_received', [1, 'normal']], ['generation_ended', [1]]])
})

it('会话切换同步取消在途 RPC 与旧监听执行许可，不打开任何后台历史', async () => {
  const f = fixture(); await settle()
  f.sources.set('other', new Source([assistant(0, 0)]))
  const prepared = deferred<void>(); let started!: () => void
  const preparing = new Promise<void>(resolve => { started = resolve })
  vi.mocked(emitHelperHostEvent).mockImplementationOnce(async (sessionId, storyId, event, data, current) => {
    started(); await prepared.promise
    if (current?.()) emissions.push({ sessionId, storyId, event, data })
  })
  f.source.append(start(0)); await preparing; f.select('other'); prepared.resolve(); await settle()
  expect(emissions).toEqual([]); expect(f.source.listeners.size).toBe(0)
  f.sources.get('other')!.append(start(1), assistant(2), end(3)); await settle()
  expect(emissions.every(item => item.sessionId === 'other')).toBe(true)
  expect(f.sessions.open).not.toHaveBeenCalled()
})

it('初次身份读取期间仍捕获同步增量，换会话后迟到响应不能恢复旧订阅', async () => {
  const first = deferred<Awaited<ReturnType<TavernRemote['getHelperEventState']>>>()
  const source = new Source(), listeners = new Set<() => void>(); let selected: string | undefined = 'session'
  const remote = { getHelperEventState: vi.fn<TavernRemote['getHelperEventState']>().mockReturnValue(first.promise) }
  const sessions: ClientContext['sessions'] = { open: vi.fn(), binding: id => ({ sessionId: SessionId(id), eventSource: source }),
    list: { getSnapshot: () => ({ current: selected, byId: { session: { projectionValues: { agentPreset: 'tavern' } } } }), subscribe: fn => { listeners.add(fn); return () => { listeners.delete(fn) } } } }
  const stop = installHelperLiveEvents(sessions, remote); cleanups.push(stop)
  source.append(start(0), assistant(1), end(2)); await settle(); expect(remote.getHelperEventState).toHaveBeenCalledTimes(1)
  selected = undefined; for (const fn of listeners) fn()
  first.resolve({ ok: true, value: { storyId: 'story', historyRevision: 'a', messages: [], writable: true, closedThrough: 2 } }); await settle()
  expect(emissions).toEqual([]); expect(source.listeners.size).toBe(0)
})

it('初次身份读取完成后按原序消费等待期间的消息，替换初始窗口会取消旧身份请求', async () => {
  const f = fixture(); await settle(); f.stop()
  const first = deferred<Awaited<ReturnType<TavernRemote['getHelperEventState']>>>()
  f.getHelperEventState.mockReturnValueOnce(first.promise)
  const stop = installHelperLiveEvents(f.sessions, { getHelperEventState: f.getHelperEventState }); cleanups.push(stop)
  f.source.append(start(0), user(1), assistant(2), end(3)); await settle(); expect(emissions).toEqual([])
  first.resolve({ ok: true, value: f.state({ sessionId: 'session' }) }); await settle()
  expect(events()).toEqual([['generation_started', ['normal', {}, false]], ['message_sent', [0]], ['message_received', [1, 'normal']], ['generation_ended', [1]]])
  stop(); emissions.length = 0
  const stale = deferred<Awaited<ReturnType<TavernRemote['getHelperEventState']>>>()
  f.getHelperEventState.mockReturnValueOnce(stale.promise)
  cleanups.push(installHelperLiveEvents(f.sessions, { getHelperEventState: f.getHelperEventState }))
  f.source.append(start(4, 2), assistant(5, 2)); f.source.replace([start(4, 2), assistant(5, 2)])
  stale.resolve({ ok: true, value: { ...f.state({ sessionId: 'session' }), storyId: 'stale-story' } }); await settle()
  f.source.append(end(6, 2), start(7, 3), assistant(8, 3), end(9, 3)); await settle()
  expect(emissions.every(item => item.storyId === 'story')).toBe(true)
  expect(emissions.filter(item => item.event === 'message_received')).toHaveLength(1)
})

it('同剧情绑定广播保留在途轮次，换剧情重建基线，身份读取失败后停发直到成功核验', async () => {
  const f = fixture(); await settle()
  f.source.append(start(0), assistant(1)); await settle(); f.story('story'); await settle(); f.source.append(end(2)); await settle()
  expect(emissions.filter(item => item.event === 'message_received')).toHaveLength(1)
  f.source.append(start(3, 2), assistant(4, 2)); await settle(); f.story('new-story'); await settle(); f.source.append(end(5, 2)); await settle()
  expect(emissions.filter(item => item.event === 'message_received')).toHaveLength(1)
  f.getHelperEventState.mockRejectedValueOnce(new Error('fixture binding probe failed')); f.story('new-story'); await settle()
  const count = emissions.length
  f.source.append(start(6, 3), assistant(7, 3), end(8, 3)); await settle(); expect(emissions).toHaveLength(count)
  f.story('new-story'); await settle()
  expect(reportHelperHostEventError).toHaveBeenCalledWith('session', 'new-story', expect.objectContaining({ message: 'fixture binding probe failed' }))
  expect(emissions).toHaveLength(count)
  f.source.append(start(9, 4), assistant(10, 4), end(11, 4)); await settle()
  expect(emissions.slice(count).every(item => item.storyId === 'new-story')).toBe(true)
})

it('待处理信号与轮次有界，超量后报错并重新建立基线', async () => {
  const f = fixture(); await settle()
  const gate = deferred<Awaited<ReturnType<TavernRemote['getHelperEventState']>>>()
  f.getHelperEventState.mockReturnValueOnce(gate.promise)
  f.source.append(start(0))
  for (let seq = 1; seq < 300; seq++) f.source.append(user(seq))
  await settle()
  expect(reportHelperHostEventError).toHaveBeenCalledWith('session', 'story', expect.objectContaining({ message: '宿主消息事件超过待处理预算' }))
  gate.resolve({ ok: true, value: f.state({ sessionId: 'session' }) }); await settle()
  expect(emissions.every(item => item.event !== 'generation_started')).toBe(true)
})

it('未完成轮次与候选回复分别有界，不让流式窗口持有无界待发状态', async () => {
  const f = fixture(); await settle()
  f.source.append(...Array.from({ length: 65 }, (_, index) => assistant(index, index))); await settle()
  expect(reportHelperHostEventError).toHaveBeenCalledWith('session', 'story', expect.objectContaining({ message: '宿主消息事件超过待完成轮次预算' }))
  f.source.append(...Array.from({ length: 4097 }, (_, index) => assistant(index + 100, 66, index))); await settle()
  expect(reportHelperHostEventError).toHaveBeenCalledWith('session', 'story', expect.objectContaining({ message: '宿主消息事件超过待完成回复预算' }))
  f.source.append(end(5000, 66)); await settle(); expect(emissions).toEqual([])
})

it('快照读取超时可见，卸载会取消超时器且迟到 RPC 不重新派发', async () => {
  const f = fixture(); await settle(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const gate = deferred<Awaited<ReturnType<TavernRemote['getHelperEventState']>>>()
  f.getHelperEventState.mockReturnValueOnce(gate.promise); f.source.append(start(0)); await settle()
  await vi.advanceTimersByTimeAsync(25000); await settle()
  expect(reportHelperHostEventError).toHaveBeenCalledWith('session', 'story', expect.objectContaining({ message: '宿主消息事件快照读取超时' }))
  f.getHelperEventState.mockReturnValueOnce(gate.promise); f.source.append(user(1)); await settle(); expect(vi.getTimerCount()).toBe(1)
  f.stop(); expect(vi.getTimerCount()).toBe(0)
  gate.resolve({ ok: true, value: f.state({ sessionId: 'session' }) }); await settle(); expect(emissions).toEqual([])
})

it('非 Tavern 模式不订阅；binding 延迟出现后随列表建立基线；卸载移除订阅', async () => {
  const f = fixture(); await settle(); f.preset('other')
  expect(f.source.listeners.size).toBe(0)
  f.source.append(start(0), assistant(1), end(2)); f.preset('tavern'); await settle(); expect(emissions).toEqual([])
  f.sources.delete('session'); f.select('session'); expect(f.source.listeners.size).toBe(0)
  f.sources.set('session', f.source); f.select('session'); await settle(); expect(emissions).toEqual([])
  f.stop(); expect(f.source.listeners.size).toBe(0)
  const legacy = { ...f.sessions, binding: undefined }; const stop = installHelperLiveEvents(legacy, { getHelperEventState: f.getHelperEventState }); stop()
  expect(f.sessions.open).not.toHaveBeenCalled()
})
