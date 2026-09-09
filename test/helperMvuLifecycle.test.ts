/** 自动 MVU 门控集成：真实 0.1.2-rc.1 AgentLoop/Inbox、工厂 Session 和真实剧情 WAL 验证等待、取消与输入恢复。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, Inbox, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { apply as applyAgent } from '../src/agent.js'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'
import { registerHelperMvuLifecycle, reserveHelperMvuMaintenance, restoreHelperMvuInputs, blockHelperMvuAssembly, stopForHelperMvu, runHelperMvuEnable } from '../src/node/helperMvuLifecycle.js'
import { commitHelperMvuJob, helperMvuPending, prepareHelperMvuJob } from '../src/node/helperMvu.js'
import { loadHelperState } from '../src/state/helper.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { withWorkspaceLock } from '../src/state/workspaceLock.js'
import { greetingTurnEvents } from '../src/node/greetingSeed.js'
import { TAVERN_GREETING_SOURCE } from '../src/core/greetingLog.js'

vi.mock('../src/node/tools.js', () => ({ registerTavernTools: vi.fn() }))
vi.mock('../src/node/memoryMaintenance.js', () => ({ registerMemoryMaintenance: vi.fn() }))
vi.mock('../src/node/pipeline.js', () => ({ runTavernPipeline: vi.fn(async () => null) }))

let root: string, state: TavernState, ctx: Context, agent: Agent, cardId: string, storyId: string
let interactiveCards = true
const errors: unknown[] = []
const message = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const workspace = () => state.storyWorkspace(cardId, storyId)
const request = () => ({ sessionId: agent.id, storyId, runtimeId: 'factory-browser' })
const events = () => agent.session.snapshotEvents()
async function until(check: () => boolean | Promise<boolean>): Promise<void> { await vi.waitFor(async () => expect(await check()).toBe(true), { timeout: 2500, interval: 10 }) }
function greeting(): void {
  agent.session.append('assistant/message', { turn: 0, step: 0, message: createAssistantMessage({ content: [{ type: 'text', text: '开场白' }], source: TAVERN_GREETING_SOURCE }) }, { surfaceOp: 'append' })
}
async function completeJob(): Promise<void> {
  const work = await prepareHelperMvuJob(ctx, state, request())
  expect(work.status).toBe('pending')
  await commitHelperMvuJob(ctx, state, { ...request(), jobId: work.job!.id, token: work.token!, data: { stat_data: { phase: 'ready' } } })
}
function stopMessage(reason: 'stop' | 'max-tokens' = 'stop'): void {
  agent.session.append('step/start', { turn: 1, step: 1 })
  agent.session.append('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'finish', reason: { kind: reason } } })
  agent.session.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '正常回复' }] }) }, { surfaceOp: 'append' })
  agent.session.append('step/end', { turn: 1, step: 1 })
}
function reserveOnInsert(): void {
  ctx.on('agent/inbox/inserted', ({ agent: source }) => reserveHelperMvuMaintenance(state, source, error => errors.push(error)))
}
/** 无模型的末端探针保留已 claim 输入；只用于观察门控放行后确实读到新状态。 */
function rejectBeforeModel(observed: string[]): void {
  ctx.on('agent/pre-step', async payload => {
    observed.push(...payload.messages.map(item => item.id))
    restoreHelperMvuInputs(payload.agent, payload.turn, payload.messages)
    return { kind: 'reject' }
  })
}

beforeEach(async () => {
  vi.clearAllMocks(); errors.length = 0; interactiveCards = true
  root = await mkdtemp(join(tmpdir(), 'tavern-mvu-lifecycle-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({ interactiveCards }))
  await state.init(); cardId = (await state.createCharacter('MVU 工厂角色')).cardId
  await state.saveBinding({ sessionId: 'mvu-factory', cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null, interactiveCards: true, helperMvu: true, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  storyId = (await state.loadBinding('mvu-factory'))!.storyId!
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {})
  const loop = new AgentLoop(ctx, { agents: [] }); agent = loop.create(SessionId('mvu-factory'))
  ctx.provide('tavern', { state })
  registerHelperMvuLifecycle(ctx)
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') void state.enqueueSessionTask(session.id, () => onTurnStart(state, session.id, event.data.turn, session)).catch(error => errors.push(error))
    if (event.type === 'turn/end') {
      const closed = session.snapshotEvents()
      void state.enqueueSessionTask(session.id, () => onTurnEnd(state, session.id, { id: session.id, snapshotEvents: () => closed })).catch(error => errors.push(error))
    }
  })
  applyAgent(ctx)
})
afterEach(async () => {
  agent.cancel({ kind: 'disposed' }, { keepInbox: true })
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id); await ctx.fiber.dispose()
  vi.restoreAllMocks(); await rm(root, { recursive: true, force: true })
})

describe('宿主自动 MVU 门控', () => {
  it('真实 Loop 在首次插入通知同步认领维护，浏览器提交前不 claim，提交后只读取新变量', async () => {
    greeting(); reserveOnInsert(); const observed: string[] = []; rejectBeforeModel(observed)
    const first = message('第一条输入'), second = message('下一条输入')
    agent.followup(first); agent.followup(second)
    expect(events().some(event => event.type === 'turn/start')).toBe(false)
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([first.id, second.id])
    await until(() => state.triggerLogs.get(agent.id)?.lines.some(line => line.includes('mvu:waiting')) === true)
    expect(runTavernPipeline).not.toHaveBeenCalled()
    expect(await withWorkspaceLock((await workspace()).fs.root, async () => 'unlocked')).toBe('unlocked')
    await completeJob(); await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
    expect(observed).toEqual([first.id]); expect(runTavernPipeline).toHaveBeenCalledTimes(1)
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([first.id, second.id])
    expect(await helperMvuPending(state, agent.id)).toBe(false)
    expect(errors).toEqual([])
  })

  it('真实 turn 1 来源标记开场白没有 finish chunk，仍在首条输入前等待初始化', async () => {
    const binding = (await state.loadBinding(agent.id))!
    await state.saveBinding({ ...binding, sessionId: 'seed-greeting', storyId: undefined })
    const handle = await ctx.agents.create({ sessionId: SessionId('seed-greeting'), seed: greetingTurnEvents('实际 seed 开场白') })
    agent = handle.agent; storyId = (await state.loadBinding(agent.id))!.storyId!
    reserveOnInsert(); const input = message('开场白后首条真实输入')
    expect(events().some(event => event.type === 'assistant/chunk')).toBe(false)
    agent.followup(input)
    await until(() => state.triggerLogs.get(agent.id)?.lines.some(line => line.includes('mvu:waiting')) === true)
    expect(events().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([input.id])
    expect(runTavernPipeline).not.toHaveBeenCalled()
    agent.cancel({ kind: 'user' }, { keepInbox: true }); await agent.whenIdle()
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([input.id])
  })

  it('缺少开场白时首条真实输入可进入新楼层，不被无法初始化的空历史锁住', async () => {
    reserveOnInsert(); const observed: string[] = []; rejectBeforeModel(observed)
    const input = message('空历史首条'); agent.followup(input)
    await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
    expect(observed).toEqual([input.id]); expect(runTavernPipeline).toHaveBeenCalledTimes(1)
    expect((await (await workspace()).wal.listFloors()).some(floor => floor.floor === agent.id + '#t1')).toBe(true)
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([input.id]); expect(errors).toEqual([])
  })

  it('无 idle 维护的兜底不组装旧计划，原 ID 和 steering/queue 顺序持久保留且不自动重跑', async () => {
    greeting()
    const steer1 = message('转向一'), steer2 = message('转向二'), queued1 = message('排队一'), queued2 = message('排队二')
    agent.inbox.append('next-step', steer1); agent.inbox.append('next-step', steer2); agent.inbox.append('next-turn', queued1)
    agent.followup(queued2)
    await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
    expect(runTavernPipeline).not.toHaveBeenCalled()
    expect(agent.inbox.nextStep.map(item => item.id)).toEqual([steer1.id, steer2.id])
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([queued1.id, queued2.id])
    const replay = new Inbox(agent.session, { inserted() {}, discarded() {}, claimed() {} })
    expect(replay.nextStep.map(item => item.id)).toEqual([steer1.id, steer2.id]); expect(replay.nextTurn.map(item => item.id)).toEqual([queued1.id, queued2.id])
    expect(events().filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(events().some(event => event.type === 'step/start' || event.type === 'user/message')).toBe(false)
    expect(await (await workspace()).wal.listFloors()).toEqual([])
  })

  it('用户在 assemble 内取消也恢复 claim；显式移除恢复项后 turn/end 不复活该输入', async () => {
    greeting(); const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    ctx.on('system-prompt/assemble', async (_value, _context, next) => { entered.resolve(); await release.promise; return next() })
    const input = message('可取消输入'); agent.followup(input); await entered.promise
    expect(agent.inbox.hasPending).toBe(false)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([input.id])
    agent.inbox.remove(input.id)
    release.resolve(); await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
    expect(agent.inbox.hasPending).toBe(false)
    expect(runTavernPipeline).not.toHaveBeenCalled()
    expect(events().some(event => event.type === 'user/message')).toBe(false)
  })

  it('正常 stop 在 turn/end 前登记并等待，等待不占剧情锁或会话任务队列，提交只落当前楼层一次', async () => {
    agent.session.append('turn/start', { turn: 1 }); await state.waitForSessionTasks(agent.id); stopMessage()
    const control = new AbortController(); let done = false
    const stopping = ctx.serial('agent/turn-stopping', { agent, turn: 1, signal: control.signal }).then(() => { done = true })
    await until(async () => (await loadHelperState((await workspace()).fs)).mvu?.pending.length === 1)
    expect(done).toBe(false)
    await state.enqueueSessionTask(agent.id, async () => {})
    expect(await withWorkspaceLock((await workspace()).fs.root, async () => 'unlocked')).toBe('unlocked')
    await completeJob(); await stopping
    expect((await (await workspace()).wal.validateFloor(agent.id + '#t1')).committed).toBe(false)
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); await state.waitForSessionTasks(agent.id)
    const saved = await loadHelperState((await workspace()).fs)
    expect(saved.mvu?.pending).toEqual([]); expect(saved.mvu?.completed).toHaveLength(1)
    expect((await (await workspace()).wal.validateFloor(agent.id + '#t1')).committed).toBe(true)
    expect(errors).toEqual([])
  })

  it('stop 等待取消立即结束但持久任务保留；下一次门控暂缓新 WAL，不抹掉旧任务', async () => {
    agent.session.append('turn/start', { turn: 1 }); await state.waitForSessionTasks(agent.id); stopMessage()
    const control = new AbortController(), stopping = stopForHelperMvu(state, agent, control.signal)
    await until(async () => (await loadHelperState((await workspace()).fs)).mvu?.pending.length === 1)
    const cancelReason = new Error('工厂用户取消')
    control.abort(cancelReason); await expect(stopping).rejects.toThrow()
    expect(control.signal.reason).toBe(cancelReason)
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }); await state.waitForSessionTasks(agent.id)
    const before = await loadHelperState((await workspace()).fs)
    agent.session.append('turn/start', { turn: 2 }); await state.waitForSessionTasks(agent.id)
    // 本轮即使原停止轮被取消，也仍有持久 pending；不能因为 completed 集合不含它而放行。
    expect(await helperMvuPending(state, agent.id)).toBe(true)
    expect((await (await workspace()).wal.listFloors()).some(floor => floor.floor === agent.id + '#t2')).toBe(false)
    agent.session.append('turn/end', { turn: 2, reason: { kind: 'blocked' } }); await state.waitForSessionTasks(agent.id)
    expect(await loadHelperState((await workspace()).fs)).toEqual(before)
  })

  it('非正常 finish 不登记也不等待无法完成的初始化', async () => {
    agent.session.append('turn/start', { turn: 1 }); await state.waitForSessionTasks(agent.id); stopMessage('max-tokens')
    await expect(stopForHelperMvu(state, agent, new AbortController().signal)).resolves.toBeUndefined()
    expect((await loadHelperState((await workspace()).fs)).mvu).toBeUndefined()
  })

  it('无开场白的首轮尚有 steering 时，不把本轮未结束回复当作可初始化历史阻断后续步骤', async () => {
    agent.session.append('turn/start', { turn: 1 }); await state.waitForSessionTasks(agent.id); stopMessage()
    expect(await blockHelperMvuAssembly(state, agent, new AbortController().signal)).toBe(false)
    expect((await loadHelperState((await workspace()).fs)).mvu).toBeUndefined()
  })

  it('断开浏览器时取消空闲等待及时返回，首条输入仍保存在真实队列且不请求模型', async () => {
    greeting(); reserveOnInsert(); const input = message('断 UI 保留输入')
    agent.followup(input)
    await until(() => state.triggerLogs.get(agent.id)?.lines.some(line => line.includes('mvu:waiting')) === true)
    agent.cancel({ kind: 'user' }, { keepInbox: true })
    await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([input.id])
    expect(await helperMvuPending(state, agent.id)).toBe(true)
    expect(runTavernPipeline).not.toHaveBeenCalled()
    expect(events().some(event => event.type === 'user/message' || event.type === 'step/start')).toBe(false)
  })

  it('变量文件损坏也通过兜底保留输入，无新楼层或旧变量计划', async () => {
    greeting()
    const ws = await workspace(); await ws.fs.writeText('state/helper.json', '{broken')
    const input = message('损坏后仍保留'); agent.followup(input)
    await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([input.id])
    expect(runTavernPipeline).not.toHaveBeenCalled()
    expect(await ws.wal.listFloors()).toEqual([])
    expect(await ws.fs.readText('state/helper.json')).toBe('{broken')
  })

  it('已有本轮 WAL 时全局启用交互卡不追写历史初始化，当前轮可按原计划继续', async () => {
    greeting(); interactiveCards = false
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    ctx.on('system-prompt/assemble', async (_value, _context, next) => { entered.resolve(); await release.promise; return next() })
    rejectBeforeModel([])
    const input = message('等待期间开启'); agent.followup(input); await entered.promise
    interactiveCards = true
    release.resolve(); await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([input.id])
    expect(runTavernPipeline).toHaveBeenCalledTimes(1)
  })

  it('全局开关中途启用时在当前正常 stop 初始化；任务一经登记仍挡住已有楼层的后续组装', async () => {
    greeting(); interactiveCards = false
    agent.session.append('turn/start', { turn: 1 }); await state.waitForSessionTasks(agent.id)
    interactiveCards = true
    expect(await blockHelperMvuAssembly(state, agent)).toBe(false)
    stopMessage(); const control = new AbortController(), stopping = stopForHelperMvu(state, agent, control.signal)
    await until(async () => (await loadHelperState((await workspace()).fs)).mvu?.pending.length === 1)
    expect(await blockHelperMvuAssembly(state, agent)).toBe(true)
    expect((await loadHelperState((await workspace()).fs)).mvu?.pending[0]?.floor).toBe(agent.id + '#t1')
    await completeJob(); await stopping
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); await state.waitForSessionTasks(agent.id)
    expect((await (await workspace()).wal.listFloors()).map(floor => floor.floor)).toEqual([agent.id + '#t1'])
    expect(await helperMvuPending(state, agent.id)).toBe(false)
  })

  it('开启 MVU 同步认领真正 idle，保存期间到达的输入不会先被 claim 或新开楼层', async () => {
    greeting(); const binding = (await state.loadBinding(agent.id))!
    await state.saveBinding({ ...binding, helperMvu: false })
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const saving = runHelperMvuEnable(ctx, state, agent.id, async () => { entered.resolve(); await release.promise; await state.saveBinding({ ...binding, helperMvu: true }); return 'saved' })
    const input = message('保存期间输入'); agent.followup(input); await entered.promise
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([input.id])
    expect(events().some(event => event.type === 'turn/start')).toBe(false)
    release.resolve(); expect(await saving).toBe('saved'); await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
    expect(agent.inbox.nextTurn.map(item => item.id)).toEqual([input.id])
    expect(runTavernPipeline).not.toHaveBeenCalled()
    expect(await (await workspace()).wal.listFloors()).toEqual([])
  })

  it('实际 Loop 已经组装时开启失败且不调用保存，不在新 WAL 后启用旧楼层初始化', async () => {
    greeting(); await state.saveBinding({ ...(await state.loadBinding(agent.id))!, helperMvu: false })
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), save = vi.fn(async () => {})
    ctx.on('system-prompt/assemble', async (_value, _context, next) => { entered.resolve(); await release.promise; return next() })
    rejectBeforeModel([])
    agent.followup(message('已经组装')); await entered.promise
    await expect(runHelperMvuEnable(ctx, state, agent.id, save)).rejects.toThrow('请等待当前生成和维护结束')
    expect(save).not.toHaveBeenCalled(); expect((await state.loadBinding(agent.id))!.helperMvu).toBe(false)
    release.resolve(); await agent.whenIdle()
  })

  it('其它维护占有公开 idle 时立即拒绝开启；不等待旧维护、更不抢写配置', async () => {
    const release = Promise.withResolvers<void>(), maintenance = agent.runMaintenance(async () => release.promise)
    const save = vi.fn(async () => {})
    expect(agent.status).toBe('idle')
    await expect(runHelperMvuEnable(ctx, state, agent.id, save)).rejects.toThrow('请等待当前生成和维护结束')
    expect(save).not.toHaveBeenCalled()
    release.resolve(); await maintenance
  })

  it('开启检查时尚离线、等待任务期间实际 Agent 出现则拒绝旧检查，不保存设置', async () => {
    const coldId = SessionId('cold-enabling'), binding = (await state.loadBinding(agent.id))!
    await state.saveBinding({ ...binding, sessionId: coldId, storyId: undefined, helperMvu: false })
    const release = Promise.withResolvers<void>(), save = vi.fn(async () => {})
    const task = state.enqueueSessionTask(coldId, async () => release.promise)
    const saving = runHelperMvuEnable(ctx, state, coldId, save)
    const handle = await ctx.agents.create({ sessionId: coldId })
    release.resolve(); await task
    await expect(saving).rejects.toThrow('请等待当前生成和维护结束')
    expect(save).not.toHaveBeenCalled(); expect((await state.loadBinding(coldId))!.helperMvu).toBe(false)
    await handle.dispose()
  })

  it('开启前等待既有收口任务并复核 openFloor，离线会话仅在无活动楼层时保存', async () => {
    await state.saveBinding({ ...(await state.loadBinding(agent.id))!, helperMvu: false })
    const release = Promise.withResolvers<void>(), save = vi.fn(async () => 'saved')
    const task = state.enqueueSessionTask(agent.id, async () => { await release.promise; await onTurnStart(state, agent.id, 1, agent.session) })
    const saving = runHelperMvuEnable(ctx, state, agent.id, save)
    expect(save).not.toHaveBeenCalled(); release.resolve(); await task
    await expect(saving).rejects.toThrow('请等待当前生成和维护结束'); expect(save).not.toHaveBeenCalled()
    state.openFloors.set('offline', { cardId, storyId, floor: 'offline#t1' })
    await expect(runHelperMvuEnable(ctx, state, 'offline', save)).rejects.toThrow('请等待当前生成和维护结束')
    state.openFloors.delete('offline')
    expect(await runHelperMvuEnable(ctx, state, 'offline', save)).toBe('saved'); expect(save).toHaveBeenCalledTimes(1)
  })
})
