/** MVU 宿主门控：停止前等待浏览器提交，空闲期保留输入；兜底拒绝只恢复原生队列，不伪造模型请求。 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, InboxTarget } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setTimeout as delay } from 'node:timers/promises'
import { helperMvuPending, queueHelperMvuStop } from './helperMvu.js'
import { isTavernGreetingEvent } from '../core/greetingLog.js'
import type { TavernState } from './state.js'

type Snapshot = Pick<Session, 'id' | 'snapshotEvents'>
interface Claim { message: UserMessage; target: InboxTarget; turn: number }
interface Gate {
  removed: Map<string, InboxTarget>
  claimed: Map<string, Claim>
  blocked: Set<number>
  maintenance: boolean
  abortCleanup: Map<number, () => void>
}
const gates = new WeakMap<Agent, Gate>()
function gateFor(agent: Agent): Gate {
  let gate = gates.get(agent)
  if (!gate) { gate = { removed: new Map(), claimed: new Map(), blocked: new Set(), maintenance: false, abortCleanup: new Map() }; gates.set(agent, gate) }
  return gate
}
/** 开启配置必须先同步认领宿主真正 idle；不能在新的空 WAL 出现后再尝试初始化旧回复。 */
export async function runHelperMvuEnable<T>(ctx: Context, state: TavernState, sessionId: string, save: () => Promise<T>): Promise<T> {
  const message = '请等待当前生成和维护结束后再开启自动 MVU'
  const perform = async (signal?: AbortSignal): Promise<T> => {
    if (signal) await abortable(state.waitForSessionTasks(sessionId), signal)
    else await state.waitForSessionTasks(sessionId)
    if (ctx.agents?.get(SessionId(sessionId)) !== agent) throw new Error(message)
    if (state.openFloors.has(sessionId)) throw new Error(message)
    signal?.throwIfAborted()
    return save()
  }
  const agent = ctx.agents?.get(SessionId(sessionId))
  if (!agent) return perform()
  // status=idle 也可能属于其它维护；runMaintenance 的同步认领才是最终裁决。
  if (agent.status !== 'idle') throw new Error(message)
  try { return agent.runMaintenance(signal => perform(signal)) }
  catch { throw new Error(message) }
}
function currentTurn(session: Snapshot): number | undefined {
  const event = [...session.snapshotEvents()].reverse().find(item => item.type === 'turn/start' || item.type === 'turn/end')
  return event?.type === 'turn/start' ? event.data.turn : undefined
}
/** 空历史没有可初始化的回复，允许首轮生成；开场白由维护等待的 session task 先写入。 */
export function helperMvuHasAssistant(session: Snapshot): boolean {
  const events = session.snapshotEvents()
  return events.some(event => {
    if (event.type !== 'assistant/message' || event.data.interrupted || event.surfaceOp !== undefined && event.surfaceOp !== 'append'
      || !event.data.message.content.some(block => block.type === 'text' && block.text.trim())) return false
    if (isTavernGreetingEvent(event) || event.data.turn === 0) return true
    const end = events.find(item => item.type === 'turn/end' && item.data.turn === event.data.turn)
    if (end?.type !== 'turn/end' || end.data.reason.kind !== 'completed') return false
    const chunks = events.filter(item => item.type === 'assistant/chunk' && item.data.turn === event.data.turn && item.data.step === event.data.step)
    const last = chunks.at(-1)
    return chunks.filter(item => item.type === 'assistant/chunk' && item.data.chunk.type === 'finish').length === 1
      && last?.type === 'assistant/chunk' && last.data.chunk.type === 'finish' && last.data.chunk.reason.kind === 'stop' && last.seq < event.seq
  })
}

/** 取消可以结束单次读盘或短间隔等待，不占用剧情锁，也不把浏览器工作放入 session task 队列。 */
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    work.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
    if (signal.aborted) abort()
  })
}
export async function waitForHelperMvu(state: TavernState, agent: Agent, signal: AbortSignal, includeInitialization = true): Promise<void> {
  let announced = false
  while (await abortable(helperMvuPending(state, agent.id, includeInitialization), signal)) {
    if (!announced) {
      state.recordTriggerLog(agent.id, ['[mvu:waiting] 等待角色变量处理；请保持交互卡页面打开。取消会保留待处理任务和原生队列。'])
      announced = true
    }
    await delay(250, undefined, { signal })
  }
  signal.throwIfAborted()
}

/** inbox 插入通知在 send 唤醒之前同步到达；先认领真正 idle，才在维护内部读取配置和等待。 */
export function reserveHelperMvuMaintenance(state: TavernState, agent: Agent, report: (error: unknown) => void): void {
  const gate = gateFor(agent)
  if (agent.status !== 'idle' || gate.maintenance) return
  try {
    gate.maintenance = true
    const task = agent.runMaintenance(async signal => {
      await abortable(state.waitForSessionTasks(agent.id), signal)
      await waitForHelperMvu(state, agent, signal, helperMvuHasAssistant(agent.session))
    })
    void task.catch(report).finally(() => { gate.maintenance = false })
  } catch {
    // 其它公开维护可能已经占有实际 idle；后续 assemble/pre-step 门控仍会保留输入。
    gate.maintenance = false
  }
}

/** 正常 stop 候选在宿主 turn/end 与下一条输入 claim 前排入持久任务；取消不清掉任务。 */
export async function stopForHelperMvu(state: TavernState, agent: Agent, signal: AbortSignal): Promise<void> {
  await abortable(state.waitForSessionTasks(agent.id), signal)
  signal.throwIfAborted()
  const events = agent.session.snapshotEvents()
  const turn = currentTurn(agent.session)
  const assistant = [...events].reverse().find(event => event.type === 'assistant/message' && event.data.turn === turn)
  if (assistant?.type !== 'assistant/message' || assistant.data.interrupted) return
  const chunks = events.filter(event => event.type === 'assistant/chunk' && event.data.turn === turn && event.data.step === assistant.data.step)
  const last = chunks.at(-1)
  if (chunks.filter(event => event.type === 'assistant/chunk' && event.data.chunk.type === 'finish').length !== 1
    || last?.type !== 'assistant/chunk' || last.data.chunk.type !== 'finish' || last.data.chunk.reason.kind !== 'stop'
    || last.seq >= assistant.seq) return
  await abortable(queueHelperMvuStop(state, agent.id, { id: agent.id, snapshotEvents: () => events }), signal)
  // 预检与 candidates() 口径不完全一致（surfaceOp/空正文）：queue 可能登记 0 个任务。
  // 未初始化剧情若已无可初始化回复，includeInitialization 必须为 false，否则轮次停止被无限阻塞。
  await waitForHelperMvu(state, agent, signal, helperMvuHasAssistant(agent.session))
}

/** 只从公开 claim 删除记录取得原目标；取消删除带 outcome=canceled，不被当作待恢复输入。 */
export function observeHelperMvuSessionEvent(agent: Agent, event: SessionEvent): void {
  const gate = gateFor(agent)
  if (event.type === 'agent/inbox/spliced') {
    const splice = event.data
    if (splice.removedCount) {
      const list = splice.target === 'next-turn' ? agent.inbox.nextTurn : agent.inbox.nextStep
      for (const message of list.slice(splice.start, splice.start + splice.removedCount)) {
        if (splice.outcome === 'canceled') { gate.claimed.delete(message.id); gate.removed.delete(message.id) }
        else if (splice.inserted.length === 0) gate.removed.set(message.id, splice.target)
      }
    }
  } else if (event.type === 'user/message') {
    gate.claimed.delete(event.data.id)
  } else if (event.type === 'turn/end') {
    if (gate.blocked.has(event.data.turn)) restoreHelperMvuInputs(agent, event.data.turn)
    gate.blocked.delete(event.data.turn)
    gate.abortCleanup.get(event.data.turn)?.()
    gate.abortCleanup.delete(event.data.turn)
    for (const [id, claim] of gate.claimed) if (claim.turn <= event.data.turn) gate.claimed.delete(id)
    gate.removed.clear()
  }
}
export function observeHelperMvuClaim(agent: Agent, message: UserMessage, turn: number): void {
  const gate = gateFor(agent), target = gate.removed.get(message.id)
  gate.removed.delete(message.id)
  if (target) gate.claimed.set(message.id, { message, target, turn })
}

/** 恢复尚未进入 user/message 的原输入，不 wake；下一条真实输入可以唤醒保留队列。 */
export function restoreHelperMvuInputs(agent: Agent, turn: number, messages?: readonly UserMessage[]): void {
  const gate = gateFor(agent), allowed = messages ? new Set(messages.map(message => message.id)) : undefined
  const pending = new Set([...agent.inbox.nextStep, ...agent.inbox.nextTurn].map(message => message.id))
  for (const target of ['next-step', 'next-turn'] as const) {
    const restore = [...gate.claimed.values()].filter(claim => claim.turn === turn && claim.target === target
      && (!allowed || allowed.has(claim.message.id)) && !pending.has(claim.message.id)).map(claim => claim.message)
    if (restore.length) agent.inbox.splice(target, 0, 0, restore)
  }
}
export function isHelperMvuBlocked(agent: Agent, turn: number): boolean { return gateFor(agent).blocked.has(turn) }

/** 在 await next() 之前判断；abort 可能让宿主跳过 pre-step，因此被挡轮次同时安装取消恢复。 */
export async function blockHelperMvuAssembly(state: TavernState, agent: Agent, signal?: AbortSignal): Promise<boolean> {
  const turn = currentTurn(agent.session)
  if (turn === undefined) return false
  let blocked: boolean
  try {
    await state.waitForSessionTasks(agent.id)
    // 全局交互设置可能在已开层的一轮中启用；空初始化延后到该轮 stop，真实 pending 仍强制等待。
    const opened = state.openFloors.get(agent.id)?.floor === agent.id + '#t' + turn
    blocked = await helperMvuPending(state, agent.id, !opened && helperMvuHasAssistant(agent.session))
  } catch (error) {
    state.recordTriggerLog(agent.id, [`[mvu:blocked] 变量状态读取失败，输入已保留：${String(error)}`])
    blocked = true
  }
  if (!blocked) return false
  gateFor(agent).blocked.add(turn)
  state.recordTriggerLog(agent.id, ['[mvu:blocked] 变量任务尚未完成，输入保留在原生队列；处理完成后可取消排队并重新发送，或发送下一条输入以继续队列。'])
  if (signal?.aborted) restoreHelperMvuInputs(agent, turn)
  else if (signal) {
    const gate = gateFor(agent), abort = () => restoreHelperMvuInputs(agent, turn)
    gate.abortCleanup.get(turn)?.()
    signal.addEventListener('abort', abort, { once: true })
    gate.abortCleanup.set(turn, () => signal.removeEventListener('abort', abort))
  }
  return true
}

/** 宿主事件只保留身份和队列目标；第三方回调始终由原有 opaque iframe 执行。 */
export function registerHelperMvuLifecycle(ctx: Context): void {
  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id)
    if (agent?.session === session) observeHelperMvuSessionEvent(agent, event)
  })
  ctx.on('agent/inbox/claimed', ({ agent, message, turn }) => observeHelperMvuClaim(agent, message, turn))
}
