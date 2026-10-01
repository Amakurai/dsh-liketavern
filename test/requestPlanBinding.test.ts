/** 请求计划归属回归：真实剧情与 AgentLoop 工厂适配器验证 assemble 后换绑/解除不能发出旧角色请求，同剧情编辑下一轮生效。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type LlmResolvedModelInfo, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply as applyAgent } from '../src/agent.js'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { registerPromptInputTracking } from '../src/node/pendingInputs.js'
import { sessionFile } from '../src/node/paths.js'
import { defaultPreset } from '../src/core/assemble.js'

vi.mock('../src/node/tools.js', () => ({ registerTavernTools: vi.fn() }))
vi.mock('../src/node/memoryMaintenance.js', () => ({ registerMemoryMaintenance: vi.fn() }))
const readFault = vi.hoisted(() => ({ target: '', readsBeforeFailure: 0 }))
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, readFile: async (...args: Parameters<typeof actual.readFile>) => {
    if (readFault.target === String(args[0]) && readFault.readsBeforeFailure-- === 0) {
      readFault.target = ''
      throw new Error('测试：绑定读取短暂失败')
    }
    return actual.readFile(...args)
  } }
})

let root: string, ctx: Context, state: TavernState, service: TavernService, agent: Agent
let cardA: string, cardB: string, presetB: string, storyA: string
const requests: GenerateOptions[] = [], errors: unknown[] = []
let prepareBarrier: { entered: PromiseWithResolvers<AbortSignal | undefined>; released: PromiseWithResolvers<void> } | undefined
class FactoryAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 64_000 } }
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal) {
    const barrier = prepareBarrier
    if (barrier) {
      prepareBarrier = undefined
      barrier.entered.resolve(signal)
      await barrier.released.promise
    }
    return super.prepareCall(provider, model, signal)
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    requests.push(options)
    yield { type: 'text-delta', index: 0, text: '工厂正常回复' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
beforeEach(async () => {
  requests.length = 0; errors.length = 0
  prepareBarrier = undefined
  root = await mkdtemp(join(tmpdir(), 'request-plan-binding-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  cardA = (await state.createCharacter('原请求角色')).cardId
  cardB = (await state.createCharacter('换绑请求角色')).cardId
  await state.saveCharacter(cardA, { description: 'CARD-A-ONLY' }); await state.saveCharacter(cardB, { description: 'CARD-B-ONLY' })
  const preset = defaultPreset()
  const presetA = await state.savePreset({ ...preset, identifier: 'request-plan-a', name: '请求预设A', sampling: { temperature: 0.21 } })
  presetB = await state.savePreset({ ...preset, identifier: 'request-plan-b', name: '请求预设B', sampling: { temperature: 0.83 } })
  await state.saveBinding({ sessionId: 'request-plan-binding', cardId: cardA, presetId: presetA, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  storyA = (await state.loadBinding('request-plan-binding'))!.storyId!
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  const llm = new LlmRuntime(ctx); llm.registerAdapter(['factory'], new FactoryAdapter())
  const loop = new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
  agent = await loop.create(SessionId('request-plan-binding'), { provider: 'factory', model: 'factory' })
  agent.session.append('agent-preset/selected', { agentPreset: 'tavern' })
  service = new TavernService(ctx, state, {} as TavernSettingsScope)
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') void state.enqueueSessionTask(session.id, () => onTurnStart(state, session.id, event.data.turn, session)).catch(error => errors.push(error))
    if (event.type === 'turn/end') {
      const events = session.snapshotEvents()
      void state.enqueueSessionTask(session.id, () => onTurnEnd(state, session.id, { id: session.id, snapshotEvents: () => events })).catch(error => errors.push(error))
    }
  })
  registerPromptInputTracking(ctx, state)
  ctx.on('agent/error', ({ error }) => errors.push(error))
  applyAgent(agent.ctx)
})
afterEach(async () => {
  readFault.target = ''
  vi.restoreAllMocks()
  agent?.cancel({ kind: 'disposed' }, { keepInbox: true }); await agent?.whenIdle()
  if (state && agent) await state.waitForSessionTasks(agent.id)
  await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true })
})
async function send(text: string) {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
}
function changeDuring(stage: 'pre-step' | 'request' | 'reasoning', change: () => Promise<void>) {
  let changed = false
  const mutate = async () => { if (!changed) { changed = true; await change() } }
  if (stage === 'reasoning') {
    const resolve = state.resolveModelInfoCached.bind(state)
    let calls = 0
    vi.spyOn(state, 'resolveModelInfoCached').mockImplementation(async (...args) => {
      if (++calls === 2) await mutate()
      return resolve(...args)
    })
  } else if (stage === 'request') agent.ctx.on('agent/request', async (_payload, next) => { const config = await next(); await mutate(); return config })
  else agent.ctx.on('agent/pre-step', async (_payload, next) => { const decision = await next(); await mutate(); return decision })
}

it.each(['pre-step', 'request', 'reasoning'] as const)('阶段 %s 换绑后拒绝旧请求，下一轮按新角色组装', async stage => {
  // 内部持久绑定路径不经过 remote 的取消策略，独立验证请求计划自身仍拒绝旧归属。
  changeDuring(stage, async () => { await state.saveBinding({ ...(await state.loadBinding(agent.id))!, cardId: cardB, presetId: presetB, storyId: undefined }) })
  await send('换绑窗口中的旧输入')
  expect(requests).toHaveLength(0)
  expect(errors.some(error => String(error).includes('请求计划'))).toBe(true)
  const wsA = await state.storyWorkspace(cardA, storyA)
  expect((await wsA.wal.validateFloor(`${agent.id}#t1`)).committed).toBe(true)
  expect(state.openFloors.has(agent.id)).toBe(false)
  errors.length = 0
  await send('新绑定的下一轮输入')
  expect(errors).toEqual([])
  expect(requests).toHaveLength(1)
  expect(requests[0]!.temperature).toBe(0.83)
  const system = requests[0]!.messages.filter(message => message.role === 'system').map(message => JSON.stringify(message.content)).join('\n')
  expect(system).toContain('CARD-B-ONLY'); expect(system).not.toContain('CARD-A-ONLY')
})

it.each(['pre-step', 'request', 'reasoning'] as const)('阶段 %s 解除绑定后不发旧角色请求，下一轮允许普通未绑定会话', async stage => {
  changeDuring(stage, async () => { await state.clearBinding(agent.id) })
  await send('解除窗口中的旧输入')
  expect(requests).toHaveLength(0)
  expect(errors.some(error => String(error).includes('请求计划'))).toBe(true)
  errors.length = 0
  await send('普通未绑定会话输入')
  expect(errors).toEqual([])
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]!.messages)).not.toContain('CARD-A-ONLY')
})

it('同剧情换预设不拒绝本轮冻结采样，下一轮应用新预设', async () => {
  changeDuring('request', async () => { await service.setSessionBinding({ binding: { ...(await state.loadBinding(agent.id))!, presetId: presetB } }) })
  await send('同剧情编辑预设')
  expect(errors).toEqual([])
  expect(requests[0]!.temperature).toBe(0.21)
  await send('下一轮使用新预设')
  expect(errors).toEqual([])
  expect(requests[1]!.temperature).toBe(0.83)
})

it('未绑定组装后首次绑定也不借旧未绑定请求发信，下一轮使用角色计划', async () => {
  await service.clearSessionBinding({ sessionId: agent.id })
  changeDuring('pre-step', async () => {
    await state.saveBinding({ sessionId: agent.id, cardId: cardB, presetId: presetB, personaId: null, lorebookIds: [],
      characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  })
  await send('首次绑定窗口中的旧输入')
  expect(requests).toHaveLength(0)
  expect(errors.some(error => String(error).includes('请求计划'))).toBe(true)
  errors.length = 0
  await send('首次绑定后的下一轮')
  expect(errors).toEqual([])
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]!.messages)).toContain('CARD-B-ONLY')
})

it.each(['switch', 'clear'] as const)('prepareCall 等待中通过 service %s 绑定时不提交旧角色请求', async action => {
  const barrier = { entered: Promise.withResolvers<AbortSignal | undefined>(), released: Promise.withResolvers<void>() }
  prepareBarrier = barrier
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '准备请求等待中的原输入' }] }))
  const signal = await barrier.entered.promise
  try {
    if (action === 'switch') await service.setSessionBinding({ binding: { ...(await state.loadBinding(agent.id))!, cardId: cardB, presetId: presetB } })
    else await service.clearSessionBinding({ sessionId: agent.id })
  } finally { barrier.released.resolve() }
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(requests).toHaveLength(0)
  expect(signal?.aborted).toBe(true)
  expect(errors).toEqual([])
  expect(agent.session.snapshotEvents().some(event => event.type === 'user/message' || event.type === 'system/message' || event.type === 'request/header')).toBe(false)
  const end = agent.session.snapshotEvents().findLast(event => event.type === 'turn/end')
  expect(end?.type === 'turn/end' ? end.data.reason : undefined).toMatchObject({ kind: 'aborted', reason: { kind: 'hook' } })
  expect(state.openFloors.has(agent.id)).toBe(false)
  const wsA = await state.storyWorkspace(cardA, storyA)
  expect((await wsA.wal.validateFloor(`${agent.id}#t1`)).committed).toBe(true)
  await send('绑定改变后的新输入')
  expect(errors).toEqual([])
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]!.messages)).not.toContain('CARD-A-ONLY')
  if (action === 'switch') expect(JSON.stringify(requests[0]!.messages)).toContain('CARD-B-ONLY')
})

it('prepareCall 等待中同剧情编辑预设继续使用原冻结采样', async () => {
  const barrier = { entered: Promise.withResolvers<AbortSignal | undefined>(), released: Promise.withResolvers<void>() }
  prepareBarrier = barrier
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '准备请求等待中的同剧情编辑' }] }))
  const signal = await barrier.entered.promise
  try { await service.setSessionBinding({ binding: { ...(await state.loadBinding(agent.id))!, presetId: presetB } }) }
  finally { barrier.released.resolve() }
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(signal?.aborted).toBe(false)
  expect(errors).toEqual([])
  expect(requests[0]!.temperature).toBe(0.21)
  await send('下一轮使用等待中保存的预设')
  expect(requests[1]!.temperature).toBe(0.83)
})

it.each(['schema', 'missing-card', 'archived-card', 'session-alias'] as const)('prepareCall 等待中无效 %s 提交不取消当前合法请求', async kind => {
  if (kind === 'archived-card') await state.archiveCharacter(cardB)
  const barrier = { entered: Promise.withResolvers<AbortSignal | undefined>(), released: Promise.withResolvers<void>() }
  prepareBarrier = barrier
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '无效编辑不能取消的输入' }] }))
  const signal = await barrier.entered.promise
  const binding = (await state.loadBinding(agent.id))!
  const file = sessionFile(state.paths, agent.id)
  let original: string | undefined
  try {
    if (kind === 'session-alias') {
      // 原始 JSON 明确属于另一会话，即使 live Agent 同名也须先拒绝身份冲突。
      original = await readFile(file, 'utf8')
      await writeFile(file, JSON.stringify({ ...binding, sessionId: '另一绑定文件所有者' }), 'utf8')
      await expect(service.clearSessionBinding({ sessionId: agent.id })).rejects.toThrow('身份冲突')
    }
    const candidate = kind === 'schema' ? { sessionId: agent.id, cardId: cardB }
      : { ...binding, cardId: kind === 'missing-card' ? 'missing_card' : cardB }
    await expect(service.setSessionBinding({ binding: candidate })).rejects.toThrow()
  } finally {
    if (original !== undefined) await writeFile(file, original, 'utf8')
    barrier.released.resolve()
  }
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(signal?.aborted).toBe(false)
  expect(errors).toEqual([])
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]!.messages)).toContain('CARD-A-ONLY')
})

it('prepareCall 换绑取消保留未来原生输入，下一次唤醒在新剧情认领原消息', async () => {
  const barrier = { entered: Promise.withResolvers<AbortSignal | undefined>(), released: Promise.withResolvers<void>() }
  prepareBarrier = barrier
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '被换绑取消的当前输入' }] }))
  await barrier.entered.promise
  const future = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'FUTURE-QUEUED-INPUT' }] })
  agent.followup(future)
  try { await service.setSessionBinding({ binding: { ...(await state.loadBinding(agent.id))!, cardId: cardB, presetId: presetB } }) }
  finally { barrier.released.resolve() }
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(requests).toHaveLength(0)
  expect(agent.inbox.nextTurn.map(message => message.id)).toEqual([future.id])
  await send('唤醒保留的未来队列')
  expect(errors).toEqual([])
  expect(requests).toHaveLength(2)
  expect(requests[0]!.messages.some(message => message.id === future.id)).toBe(true)
  expect(JSON.stringify(requests[0]!.messages)).toContain('CARD-B-ONLY')
  expect(agent.inbox.nextTurn).toEqual([])
})

it('prepareCall 等待中解除绑定的中间读取失败仍取消活动角色计划', async () => {
  const barrier = { entered: Promise.withResolvers<AbortSignal | undefined>(), released: Promise.withResolvers<void>() }
  prepareBarrier = barrier
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '解除绑定读取容错窗口' }] }))
  const signal = await barrier.entered.promise
  readFault.target = sessionFile(state.paths, agent.id)
  // 首次身份校验成功，读取当前绑定短暂失败，最终身份复核和删除仍成功。
  readFault.readsBeforeFailure = 1
  try { expect(await service.clearSessionBinding({ sessionId: agent.id })).toEqual({ cleared: true }) }
  finally { barrier.released.resolve() }
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(await state.loadBinding(agent.id)).toBeNull()
  expect(requests).toHaveLength(0)
  expect(signal?.aborted).toBe(true)
  expect(errors).toEqual([])
})

it('已开始轮次的 onlyIfBlank 解除请求不改绑定或取消准备', async () => {
  const barrier = { entered: Promise.withResolvers<AbortSignal | undefined>(), released: Promise.withResolvers<void>() }
  prepareBarrier = barrier
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '已经开始的剧情输入' }] }))
  const signal = await barrier.entered.promise
  try { expect(await service.clearSessionBinding({ sessionId: agent.id, onlyIfBlank: true })).toEqual({ cleared: false }) }
  finally { barrier.released.resolve() }
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(signal?.aborted).toBe(false)
  expect(errors).toEqual([])
  expect(requests).toHaveLength(1)
  expect((await state.loadBinding(agent.id))!.storyId).toBe(storyA)
})

it.skipIf(process.platform !== 'win32')('同卡大小写别名编辑不取消 prepareCall 的冻结计划', async () => {
  const barrier = { entered: Promise.withResolvers<AbortSignal | undefined>(), released: Promise.withResolvers<void>() }
  prepareBarrier = barrier
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '同卡大小写编辑输入' }] }))
  const signal = await barrier.entered.promise
  try { await service.setSessionBinding({ binding: { ...(await state.loadBinding(agent.id))!, cardId: cardA.toUpperCase(), presetId: presetB } }) }
  finally { barrier.released.resolve() }
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(signal?.aborted).toBe(false)
  expect(errors).toEqual([])
  expect(requests[0]!.temperature).toBe(0.21)
  expect((await state.loadBinding(agent.id))!.cardId).toBe(cardA)
})

it.each(['service-current', 'state-previous'] as const)('同剧情保存的 %s 读取故障拒绝写入，保留 lineage 和活动请求', async stage => {
  const lineage = [{ sessionId: '父会话', throughTurn: 3 }]
  await state.saveBinding({ ...(await state.loadBinding(agent.id))!, walLineage: lineage })
  const barrier = { entered: Promise.withResolvers<AbortSignal | undefined>(), released: Promise.withResolvers<void>() }
  prepareBarrier = barrier
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '读取故障时保留旧采样和祖先' }] }))
  const signal = await barrier.entered.promise
  const binding = (await state.loadBinding(agent.id))!
  readFault.target = sessionFile(state.paths, agent.id)
  // service 前置读取、锁内 current、state 原始身份预检、实际 previous 依次读同一绑定文件。
  readFault.readsBeforeFailure = stage === 'service-current' ? 1 : 3
  let failure: unknown
  try { await service.setSessionBinding({ binding: { ...binding, presetId: presetB } }) }
  catch (error) { failure = error }
  finally { barrier.released.resolve() }
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(signal?.aborted).toBe(false)
  expect(errors).toEqual([])
  expect((await state.loadBinding(agent.id))!.walLineage).toEqual(lineage)
  expect(String(failure)).toContain('绑定读取短暂失败')
  expect(requests).toHaveLength(1)
  expect(requests[0]!.temperature).toBe(0.21)
})

it('没有绑定和活动角色计划时重复解除不取消普通 prepareCall', async () => {
  await service.clearSessionBinding({ sessionId: agent.id })
  const barrier = { entered: Promise.withResolvers<AbortSignal | undefined>(), released: Promise.withResolvers<void>() }
  prepareBarrier = barrier
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '普通未绑定会话输入' }] }))
  const signal = await barrier.entered.promise
  expect(state.turnPlans.has(agent.id)).toBe(false)
  try { expect(await service.clearSessionBinding({ sessionId: agent.id })).toEqual({ cleared: true }) }
  finally { barrier.released.resolve() }
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(signal?.aborted).toBe(false)
  expect(errors).toEqual([])
  expect(requests).toHaveLength(1)
  expect(JSON.stringify(requests[0]!.messages)).not.toContain('CARD-A-ONLY')
})

it('换绑取消按原楼层收口，新剧情损坏模板不阻止旧 WAL 提交且下一轮仍拒绝', async () => {
  const sharedB = await state.workspace(cardB)
  await sharedB.fs.writeText('state/template.json', '{broken')
  const barrier = { entered: Promise.withResolvers<AbortSignal | undefined>(), released: Promise.withResolvers<void>() }
  prepareBarrier = barrier
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '换绑坏模板前的旧剧情输入' }] }))
  await barrier.entered.promise
  try { await service.setSessionBinding({ binding: { ...(await state.loadBinding(agent.id))!, cardId: cardB, presetId: presetB } }) }
  finally { barrier.released.resolve() }
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  const wsA = await state.storyWorkspace(cardA, storyA)
  expect((await wsA.wal.validateFloor(`${agent.id}#t1`)).committed).toBe(true)
  expect(state.openFloors.has(agent.id)).toBe(false)
  expect(errors).toEqual([])
  expect(requests).toHaveLength(0)
  const bindingB = (await state.loadBinding(agent.id))!
  const wsB = await state.storyWorkspace(bindingB.cardId, bindingB.storyId)
  expect(await wsB.fs.readText('state/template.json')).toBe('{broken')
  await send('新剧情坏模板必须拒绝的输入')
  expect(errors.some(error => error instanceof SyntaxError)).toBe(true)
  expect(requests).toHaveLength(0)
  expect(await wsB.fs.readText('state/template.json')).toBe('{broken')
  expect((await wsA.wal.validateFloor(`${agent.id}#t1`)).committed).toBe(true)
})
