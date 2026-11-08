/** 当前 Tavern 页面的实时宿主日志订阅：消费实时追加与回复结算，忽略临时流和历史载入，完成屏障后再通知沙箱。 */
import type { SessionEventSource, SessionEventWindow } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { BINDING_CHANGED_EVENT } from './actions.js'
import { emitHelperHostEvent, reportHelperHostEventError } from './helperEventRouter.js'
import { notifyHelperStory } from './helperNotifications.js'
import { sessionViews, type SessionViewsPort } from './sessionViews.js'
import type { ClientContext, TavernRemote } from './types.js'

type EventRemote = Pick<TavernRemote, 'getHelperEventState'>
type EventState = Extract<Awaited<ReturnType<EventRemote['getHelperEventState']>>, { ok: true }>['value']
type Signal = { kind: 'start'; seq: number } | { kind: 'user'; seq: number } |
  { kind: 'assistant'; seq: number; turn: number } |
  { kind: 'end'; seq: number; turn: number; completed: boolean; assistants: number[] }
type Turn = { started: boolean; assistants: number[] }
type View = {
  sessionId: string; source: SessionEventSource; active: boolean; epoch: number; storyId?: string
  revision: number; highwater: number; turns: Map<number, Turn>; assistantCount: number
  /** 每轮已捕获的持久 assistant seq；settle-assistant 可能晚于 turn/end 到达，不能按全局 highwater 丢弃。 */
  assistantsByTurn: Map<number, Set<number>>
  /** 已捕获 turn/end 的轮次；晚到的 settle 不能再新建一个永远等不到结束的轮次。 */
  endedTurns: Set<number>
  queue: Signal[]; running: boolean; ready: boolean; requests: Set<() => void>; dispose: () => void; probe: number
}
const MAX_QUEUE = 256, MAX_TURNS = 64, MAX_ASSISTANTS = 4096
class SourceChanged extends Error {}

/** 仅解析当前已保留会话的公开 binding，不调用 open/历史分页；旧宿主没有 binding 时不安装。 */
export function installHelperLiveEvents(sessions: Pick<ClientContext['sessions'], 'binding'>, remote: EventRemote,
  views: Pick<SessionViewsPort, 'currentTavernSession' | 'subscribe'> = sessionViews): () => void {
  if (!sessions.binding) return () => {}
  let active = true, selected: View | undefined
  const current = (view: View, epoch = view.epoch) => active && selected === view && view.active && view.epoch === epoch
  const report = (view: View, error: unknown) => {
    if (current(view) && !(error instanceof SourceChanged)) reportHelperHostEventError(view.sessionId, view.storyId ?? '', error)
  }
  const cancel = (view: View) => {
    view.epoch++
    for (const stop of [...view.requests]) stop()
    view.queue = []; view.turns.clear(); view.assistantsByTurn.clear(); view.endedTurns.clear(); view.assistantCount = 0; view.running = false
  }
  const read = (view: View, request: Parameters<EventRemote['getHelperEventState']>[0], epoch = view.epoch): Promise<EventState> => {
    if (!current(view, epoch)) return Promise.reject(new SourceChanged('宿主事件来源已改变'))
    return new Promise((resolve, reject) => {
      let done = false
      const finish = (error?: unknown, result?: EventState) => {
        if (done) return
        done = true; clearTimeout(timer); view.requests.delete(stop)
        if (error) reject(error)
        else if (!current(view, epoch)) reject(new SourceChanged('宿主事件来源已改变'))
        else resolve(result!)
      }
      const stop = () => finish(new SourceChanged('宿主事件来源已改变'))
      const timer = setTimeout(() => finish(new Error('宿主消息事件快照读取超时')), 25000)
      view.requests.add(stop)
      try {
        void remote.getHelperEventState(request).then(result => {
          if (!result.ok) finish(new Error(result.error.message))
          else finish(undefined, result.value)
        }, finish)
      } catch (error) { finish(error) }
    })
  }
  /** 记录每轮已见过的持久 assistant；返回 true 表示首次出现。 */
  const rememberAssistant = (view: View, event: SessionEvent): boolean => {
    if (event.type !== 'assistant/message' || (event.surfaceOp !== undefined && event.surfaceOp !== 'append') || event.data.interrupted) return false
    const turn = event.data.turn
    let seen = view.assistantsByTurn.get(turn)
    if (!seen) {
      if (view.assistantsByTurn.size >= MAX_TURNS) view.assistantsByTurn.delete(view.assistantsByTurn.keys().next().value!)
      seen = new Set(); view.assistantsByTurn.set(turn, seen)
    }
    if (seen.has(event.seq)) return false
    seen.add(event.seq)
    return true
  }
  const baseline = (view: View, snapshot: SessionEventWindow) => {
    view.revision = snapshot.revision
    view.assistantsByTurn.clear(); view.endedTurns.clear()
    for (const entry of snapshot.entries) if (entry.type === 'event') {
      view.highwater = Math.max(view.highwater, entry.event.seq)
      rememberAssistant(view, entry.event)
      if (entry.event.type === 'turn/end') view.endedTurns.add(entry.event.data.turn)
    }
  }
  const reset = (view: View, snapshot: SessionEventWindow) => {
    cancel(view); baseline(view, snapshot)
    if (!view.ready) initialize(view)
    if (view.storyId) notifyHelperStory(view.sessionId, view.storyId)
  }
  const dispatch = async (view: View, signal: Signal, epoch: number) => {
    const state = await read(view, { sessionId: view.sessionId, storyId: view.storyId,
      ...(signal.kind === 'end' ? { closedSeq: signal.seq } : {}) }, epoch)
    if (view.storyId !== undefined && state.storyId !== view.storyId) throw new Error('宿主消息事件的剧情绑定已改变')
    view.storyId = state.storyId
    const valid = () => current(view, epoch) && view.storyId === state.storyId
    const emit = (event: Parameters<typeof emitHelperHostEvent>[2], data: unknown[]) =>
      emitHelperHostEvent(view.sessionId, state.storyId, event, data, valid)
    if (!valid()) return
    if (signal.kind === 'start') await emit('generation_started', ['normal', {}, false])
    else if (signal.kind === 'user') {
      const message = state.messages.find(item => item.seq === signal.seq && item.role === 'user')
      if (message) { notifyHelperStory(view.sessionId, state.storyId); await emit('message_sent', [message.message_id]) }
    } else if (signal.kind === 'assistant') {
      const message = state.messages.find(item => item.seq === signal.seq && item.role === 'assistant')
      if (message) { notifyHelperStory(view.sessionId, state.storyId); await emit('message_received', [message.message_id, 'normal']) }
    } else {
      if (state.closedThrough < signal.seq) throw new Error('宿主消息事件尚未完成剧情收口')
      notifyHelperStory(view.sessionId, state.storyId)
      if (!signal.completed) { await emit('generation_stopped', []); return }
      for (const seq of signal.assistants) {
        if (!valid()) return
        const message = state.messages.find(item => item.seq === seq && item.role === 'assistant')
        if (message) await emit('message_received', [message.message_id, 'normal'])
      }
      if (!valid()) return
      const last = state.messages.filter(item => item.seq <= signal.seq).at(-1)
      await emit('generation_ended', [last?.message_id ?? -1])
    }
  }
  const drain = (view: View) => {
    if (view.running || !view.ready || !current(view)) return
    const epoch = view.epoch
    view.running = true
    void (async () => {
      while (current(view, epoch) && view.queue.length) {
        const signal = view.queue.shift()!
        try { await dispatch(view, signal, epoch) }
        catch (error) { if (current(view, epoch)) report(view, error) }
      }
    })().finally(() => {
      if (!current(view, epoch)) return
      view.running = false
      if (view.queue.length) drain(view)
    })
  }
  const enqueue = (view: View, signal: Signal) => {
    if (view.queue.length >= MAX_QUEUE) throw new Error('宿主消息事件超过待处理预算')
    view.queue.push(signal)
  }
  const initialize = (view: View) => {
    const epoch = view.epoch
    void read(view, { sessionId: view.sessionId }, epoch).then(state => {
      if (!current(view, epoch)) return
      view.storyId = state.storyId; view.ready = true; drain(view)
    }).catch(error => {
      if (!current(view, epoch)) return
      report(view, error); cancel(view); view.ready = false
    })
  }
  const capture = (view: View, event: SessionEvent, settled = false) => {
    // settle-assistant 是事后补发的持久结算：即使 turn/end 已推进 highwater，也要按轮次身份补收 assistant。
    // 其它事件沿用全局单调游标，避免历史/重复 append 被当作新消息。
    if (event.seq <= view.highwater && !settled) return
    if (event.seq > view.highwater) view.highwater = event.seq
    if (event.type === 'turn/start') {
      let turn = view.turns.get(event.data.turn)
      if (!turn) {
        if (view.turns.size >= MAX_TURNS) throw new Error('宿主消息事件超过待完成轮次预算')
        turn = { started: false, assistants: [] }; view.turns.set(event.data.turn, turn)
      }
      if (!turn.started) { turn.started = true; enqueue(view, { kind: 'start', seq: event.seq }) }
    } else if (event.type === 'user/message' && (event.surfaceOp === undefined || event.surfaceOp === 'append')) {
      enqueue(view, { kind: 'user', seq: event.seq })
    } else if (event.type === 'assistant/message' && (event.surfaceOp === undefined || event.surfaceOp === 'append') && !event.data.interrupted) {
      if (!rememberAssistant(view, event)) return
      const turnNumber = event.data.turn, turn = view.turns.get(turnNumber)
      if (turn) {
        if (view.assistantCount >= MAX_ASSISTANTS) throw new Error('宿主消息事件超过待完成回复预算')
        turn.assistants.push(event.seq); view.assistantCount++
      } else if (view.endedTurns.has(turnNumber)) {
        // turn/end 已先被捕获：把补发的接收事件插到待发送结束信号之前，保持 message_received 先于 generation_ended。
        const signal: Signal = { kind: 'assistant', seq: event.seq, turn: turnNumber }
        const index = view.queue.findIndex(item => item.kind === 'end' && item.turn === turnNumber)
        if (index >= 0) view.queue.splice(index, 0, signal)
        else enqueue(view, signal)
      } else {
        let created = view.turns.get(turnNumber)
        if (!created) {
          if (view.turns.size >= MAX_TURNS) throw new Error('宿主消息事件超过待完成轮次预算')
          created = { started: false, assistants: [] }; view.turns.set(turnNumber, created)
        }
        if (view.assistantCount >= MAX_ASSISTANTS) throw new Error('宿主消息事件超过待完成回复预算')
        created.assistants.push(event.seq); view.assistantCount++
      }
    } else if (event.type === 'turn/end') {
      const turn = view.turns.get(event.data.turn)
      if (!turn) return
      view.turns.delete(event.data.turn); view.assistantCount -= turn.assistants.length
      if (view.endedTurns.size >= MAX_TURNS) view.endedTurns.delete(view.endedTurns.values().next().value!)
      view.endedTurns.add(event.data.turn)
      enqueue(view, { kind: 'end', seq: event.seq, turn: event.data.turn, completed: event.data.reason.kind === 'completed', assistants: turn.assistants })
    }
  }
  const sync = () => {
    // 宿主 0.1.7 不再公开当前会话；取会话作用域组件登记的最近显示的 Tavern 会话。
    const sessionId = views.currentTavernSession()
    const binding = sessionId ? sessions.binding?.(sessionId) : undefined
    if (selected?.sessionId === sessionId && selected?.source === binding?.eventSource) return
    if (selected) { selected.active = false; cancel(selected); selected.dispose(); selected = undefined }
    if (!active || !sessionId || !binding || binding.sessionId !== sessionId) return
    const view: View = { sessionId, source: binding.eventSource, active: true, epoch: 0, revision: -1, highwater: -1,
      turns: new Map(), assistantsByTurn: new Map(), endedTurns: new Set(), assistantCount: 0, queue: [], running: false, ready: false, requests: new Set(), dispose: () => {}, probe: 0 }
    selected = view
    baseline(view, view.source.getSnapshot())
    view.dispose = view.source.subscribe(() => {
      if (!current(view)) return
      const snapshot = view.source.getSnapshot()
      if (snapshot.revision <= view.revision) return
      view.revision = snapshot.revision
      if (snapshot.change.kind === 'replace') { reset(view, snapshot); return }
      if (snapshot.change.kind === 'prepend') return
      try {
        // rc.2 结算会以单个 entry 替换临时流；无 entry 只是清理失败/取消的尝试。
        // 临时流的分数 seq 不属于持久游标，不能提前吞掉同一步最终 assistant/message。
        if (snapshot.change.kind === 'settle-assistant') {
          if (snapshot.change.entry) capture(view, snapshot.change.entry.event, true)
        } else {
          for (const entry of snapshot.change.entries) if (entry.type === 'event') capture(view, entry.event)
        }
      }
      catch (error) { report(view, error); reset(view, snapshot); return }
      drain(view)
    })
    // 订阅先于异步身份读取；读取期间到达的 live append 仍完整留在同步游标中。
    initialize(view)
  }
  const changed = (event: Event) => {
    const view = selected
    if (!view || (event as CustomEvent<unknown>).detail !== view.sessionId) return
    const epoch = view.epoch, probe = ++view.probe
    void read(view, { sessionId: view.sessionId }, epoch).then(state => {
      if (!current(view, epoch) || probe !== view.probe) return
      const different = view.storyId !== undefined && view.storyId !== state.storyId, suspended = !view.ready
      view.storyId = state.storyId; view.ready = true
      if (different || suspended) reset(view, view.source.getSnapshot())
      drain(view)
    }).catch(error => {
      if (!current(view, epoch) || probe !== view.probe) return
      report(view, error); cancel(view); baseline(view, view.source.getSnapshot()); view.ready = false
    })
  }
  const unsub = views.subscribe(sync)
  if (typeof window !== 'undefined') window.addEventListener(BINDING_CHANGED_EVENT, changed)
  sync()
  return () => {
    active = false; unsub()
    if (typeof window !== 'undefined') window.removeEventListener(BINDING_CHANGED_EVENT, changed)
    if (selected) { selected.active = false; cancel(selected); selected.dispose(); selected = undefined }
  }
}
