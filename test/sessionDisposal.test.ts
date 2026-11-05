/**
 * 会话销毁生命周期、运行期清理、宿主注入过滤与适配器未绑定会话保护回归。
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createAssistantMessage, createSystemMessage, createUserMessage, LlmRuntime, type GenerateOptions } from '@deepseek-ai/dsh-llm'
import { z } from 'zod'
import { apply as applyAgent } from '../src/agent.js'
import { resolveConfig, TAVERN_NS, TavernConfigSchema, type TavernConfigRaw } from '../src/node/config.js'
import { continueFloor, regenerate } from '../src/node/floors.js'
import { impersonate } from '../src/node/impersonate.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { BOUND_DISCIPLINE, isHostInjectedUserMessage } from '../src/core/dshPrompt.js'
import { apply, projectTavernAdapterRequest } from '../src/index.js'
import { attachPresetPlanMessage, createPresetPlanMessage, createPresetRequestProjector } from '../src/node/presetRequestProjection.js'
import { saveTemplateState } from '../src/state/template.js'

describe('会话销毁与状态清理 (Issue 2)', () => {
  let root: string
  let state: TavernState

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tavern-disposal-'))
    state = new TavernState(
      {
        root,
        characters: join(root, 'characters'),
        lorebooks: join(root, 'library/lorebooks'),
        presets: join(root, 'library/presets'),
        personas: join(root, 'personas'),
        regexDir: join(root, 'regex'),
        sessions: join(root, 'sessions'),
      },
      () => resolveConfig({}),
    )
    await state.init()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('clearSessionRuntime 清空会话在内存中的全部运行期状态与缓存，且不影响其它会话', async () => {
    const sessA = 'session-a'
    const sessB = 'session-b'
    const sessAOverlap = `${sessA}-extra`

    // 填充 session A 状态
    state.openFloors.set(sessA, { cardId: 'card-1', floor: `${sessA}#t1` })
    state.currentTurns.set(sessA, 1)
    state.currentSteps.set(sessA, 2)
    state.stepNoticeMarks.set(sessA, '1:2')
    state.turnPlans.set(sessA, { turn: 1, cardId: 'card-1', result: {} as any })
    state.pendingTurnPlans.set(sessA, { turn: 1, cardId: 'card-1', floor: `${sessA}#t1`, publish: async () => ({} as any) })
    state.pendingInputs.set(sessA, ['hello'])
    state.pendingTemplateInputs.set(sessA, [{ id: 'msg-1', text: 'hi' }])
    state.triggerLogs.set(sessA, { at: '2026-01-01', lines: ['line 1'] })
    state.requestDiagnostics.set(sessA, { text: 'diag', truncated: false })
    state.sessionTaskTails.set(sessA, Promise.resolve())
    state.sessionCommitTails.set(sessA, Promise.resolve())
    state.helperTurnClosures.set(`${sessA}#t1`, { seq: 1, storyId: 'story-1' } as any)
    state.helperTurnClosures.set(`${sessA}#t2`, { seq: 2, storyId: 'story-1' } as any)
    state.bindingAdoptions.set(sessA, Promise.resolve())
    state.bindingAdoptionRetries.set(sessA, async () => {})
    state.pinStanding(sessA, 'chat', 'fp-a\0v1\0card-1', 'standing-a')
    state.appliedStanding.set(sessA, 'applied-a')
    state.appliedTurnContext.set(sessA, 'context-a')
    state.deferredTurns.set(sessA, 1)

    // 填充 session B 状态（对照组）
    state.openFloors.set(sessB, { cardId: 'card-2', floor: `${sessB}#t1` })
    state.currentTurns.set(sessB, 1)
    state.deferredTurns.set(sessB, 2)
    state.helperTurnClosures.set(`${sessB}#t1`, { seq: 1, storyId: 'story-2' } as any)
    state.pinStanding(sessB, 'chat', 'fp-b\0v1\0card-2', 'standing-b')

    // 填充前缀重叠会话（边界隔离）
    state.helperTurnClosures.set(`${sessAOverlap}#t1`, { seq: 1, storyId: 'story-extra' } as any)

    // 执行 Session A 清理
    state.clearSessionRuntime(sessA)

    // 验证 Session A 全部被清除
    expect(state.openFloors.has(sessA)).toBe(false)
    expect(state.currentTurns.has(sessA)).toBe(false)
    expect(state.currentSteps.has(sessA)).toBe(false)
    expect(state.deferredTurns.has(sessA)).toBe(false)
    expect(state.stepNoticeMarks.has(sessA)).toBe(false)
    expect(state.turnPlans.has(sessA)).toBe(false)
    expect(state.pendingTurnPlans.has(sessA)).toBe(false)
    expect(state.pendingInputs.has(sessA)).toBe(false)
    expect(state.pendingTemplateInputs.has(sessA)).toBe(false)
    expect(state.triggerLogs.has(sessA)).toBe(false)
    expect(state.requestDiagnostics.has(sessA)).toBe(false)
    expect(state.sessionTaskTails.has(sessA)).toBe(false)
    expect(state.sessionCommitTails.has(sessA)).toBe(false)
    expect(state.helperTurnClosures.has(`${sessA}#t1`)).toBe(false)
    expect(state.helperTurnClosures.has(`${sessA}#t2`)).toBe(false)
    expect(state.bindingAdoptions.has(sessA)).toBe(false)
    expect(state.bindingAdoptionRetries.has(sessA)).toBe(false)
    expect(state.peekStanding(sessA, 'chat', 'card-1')).toBeUndefined()
    expect(state.appliedStanding.has(sessA)).toBe(false)
    expect(state.appliedTurnContext.has(sessA)).toBe(false)

    // 验证 Session B 完好保留
    expect(state.openFloors.has(sessB)).toBe(true)
    expect(state.currentTurns.get(sessB)).toBe(1)
    expect(state.deferredTurns.get(sessB)).toBe(2)
    expect(state.helperTurnClosures.has(`${sessB}#t1`)).toBe(true)
    expect(state.peekStanding(sessB, 'chat', 'card-2')).toBe('standing-b')

    // 验证前缀重叠会话完好保留
    expect(state.helperTurnClosures.has(`${sessAOverlap}#t1`)).toBe(true)
  })

  it('clearBinding 同时清理运行期内存与磁盘 sessions/<id>.json 文件', async () => {
    const { cardId } = await state.createCharacter('解绑测试卡')
    const sessionId = 'session-to-clear'
    await state.saveBinding({
      sessionId,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date().toISOString(),
    })

    state.openFloors.set(sessionId, { cardId, floor: `${sessionId}#t1` })
    state.currentTurns.set(sessionId, 1)
    state.helperTurnClosures.set(`${sessionId}#t1`, { seq: 1, storyId: 'story-clear' } as any)
    expect(await state.loadBinding(sessionId)).not.toBeNull()

    await state.clearBinding(sessionId)

    expect(state.openFloors.has(sessionId)).toBe(false)
    expect(state.currentTurns.has(sessionId)).toBe(false)
    expect(state.helperTurnClosures.has(`${sessionId}#t1`)).toBe(false)
    expect(await state.loadBinding(sessionId)).toBeNull()
  })

  it('session/disposed 与 api-session/removed 事件触发 clearBinding (通过 apply 真实注册)', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'tavern-disposal-home-'))
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = tempHome

    try {
      const ctx = new Context()
      const rawConfig = (TavernConfigSchema as (input: unknown) => TavernConfigRaw)({})
      const config = Object.fromEntries(Object.entries(rawConfig).map(([k, v]) => [k, { get: () => v }])) as any
      const sessionsMap = new Map<string, Session>()

      ctx.provide('settings', {
        configure: vi.fn(),
        describe: () => [{ ns: TAVERN_NS, revision: 1, value: rawConfig }],
        update: vi.fn(),
      } as any)
      ctx.provide('sessions', {
        list: () => [...sessionsMap.values()],
        get: (id: string) => sessionsMap.get(id),
      } as any)
      ctx.provide('agents', { get: () => undefined } as any)
      ctx.provide('typert', { register: () => () => {} } as any)
      ctx.provide('workspaceRegistry', { list: () => [] } as any)
      ctx.provide('agentPresets', { register: vi.fn(async () => async () => {}) } as any)
      ctx.provide('logger', { warn: vi.fn(), info: vi.fn() } as any)

      // 执行真实宿主插件注册
      await apply(ctx, config)
      const service = ctx.get('tavern') as any
      const hostState: TavernState = service.state

      // 在实际 state 存储中建立角色与会话绑定
      const { cardId } = await hostState.createCharacter('事件清理角色')
      const session1 = Session.create(SessionId('disposed-session-1'))
      const session2 = Session.create(SessionId('disposed-session-2'))
      sessionsMap.set(session1.id, session1)
      sessionsMap.set(session2.id, session2)

      await hostState.saveBinding({
        sessionId: session1.id,
        cardId,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: null,
        greetingIndex: 0,
        createdAt: new Date().toISOString(),
      })
      await hostState.saveBinding({
        sessionId: session2.id,
        cardId,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: null,
        greetingIndex: 0,
        createdAt: new Date().toISOString(),
      })

      expect(await hostState.loadBinding(session1.id)).not.toBeNull()
      expect(await hostState.loadBinding(session2.id)).not.toBeNull()

      // 触发 session/disposed，由 src/index.ts 注册的真实监听器消费
      ctx.emit('session/disposed', session1)
      await vi.waitFor(async () => {
        expect(await hostState.loadBinding(session1.id)).toBeNull()
      })

      // 触发 api-session/removed，由 src/index.ts 注册的真实监听器消费
      ctx.emit('api-session/removed' as any, session2.id)
      await vi.waitFor(async () => {
        expect(await hostState.loadBinding(session2.id)).toBeNull()
      })

      await ctx.fiber.dispose()
    } finally {
      if (prevHome !== undefined) process.env.DSH_HOME = prevHome
      else delete process.env.DSH_HOME
      await rm(tempHome, { recursive: true, force: true })
    }
  })
})

describe('适配器未挂载会话保护 (Issue 3)', () => {
  it('当 options.sessionId 对应的 session 为 undefined 时直接原样返回 options，不进入 projector 抛错', () => {
    const ctx = new Context()
    const sessionsMap = new Map<string, Session>()
    ctx.provide('sessions', {
      get: (id: string) => sessionsMap.get(id),
    } as any)

    const testOptions: GenerateOptions = {
      sessionId: 'unmounted-session-id',
      messages: [],
    } as any
    const dummyModel = { systemPromptUpdate: 'in-history' as const, defaultMaxTokens: 4096 }

    // 1. 直接执行 src/index.ts 的生产函数 projectTavernAdapterRequest
    const mockState = {
      requestDiagnostics: new Map(),
      currentTurns: new Map(),
      currentSteps: new Map(),
    } as any
    const result = projectTavernAdapterRequest(ctx, mockState, testOptions, dummyModel)
    expect(result).toBe(testOptions)

    // 2. 对照实验：若绕过该保护直接进入 createPresetRequestProjector，验证其必抛出会话缺失错误
    const projector = createPresetRequestProjector(ctx)
    expect(() => projector.project(testOptions, dummyModel)).toThrow('Tavern 请求找不到当前 Session，不能读取冻结提示词布局')
  })

  it('当 options.sessionId 对应的 session 存在但非 Tavern 会话时直接原样返回 options', () => {
    const ctx = new Context()
    const nonTavernSession = Session.create(SessionId('non-tavern-session'))
    ctx.provide('sessions', {
      get: (id: string) => (id === nonTavernSession.id ? nonTavernSession : undefined),
    } as any)
    ctx.provide('agents', { get: () => undefined } as any)

    const testOptions: GenerateOptions = {
      sessionId: nonTavernSession.id,
      messages: [],
    } as any
    const dummyModel = { systemPromptUpdate: 'in-history' as const, defaultMaxTokens: 4096 }

    const mockState = {
      requestDiagnostics: new Map(),
      currentTurns: new Map(),
      currentSteps: new Map(),
    } as any
    const result = projectTavernAdapterRequest(ctx, mockState, testOptions, dummyModel)
    expect(result).toBe(testOptions)
  })

  it('未提供 sessionId 或提供 purpose 时直接原样返回 options', () => {
    const ctx = new Context()
    ctx.provide('sessions', { get: () => undefined } as any)
    const dummyModel = { systemPromptUpdate: 'in-history' as const, defaultMaxTokens: 4096 }
    const mockState = {
      requestDiagnostics: new Map(),
      currentTurns: new Map(),
      currentSteps: new Map(),
    } as any

    const noSessionOptions: GenerateOptions = { messages: [] } as any
    expect(projectTavernAdapterRequest(ctx, mockState, noSessionOptions, dummyModel)).toBe(noSessionOptions)

    const purposeOptions: GenerateOptions = { sessionId: 'some-session', purpose: 'title', messages: [] } as any
    expect(projectTavernAdapterRequest(ctx, mockState, purposeOptions, dummyModel)).toBe(purposeOptions)
  })
})

describe('宿主及插件注入消息识别 (Issue 4)', () => {
  it('正确识别 dsh-tavern 来源的 step notice 为宿主/插件注入 user 消息', () => {
    expect(isHostInjectedUserMessage({ role: 'user', source: { kind: 'dsh-tavern' } })).toBe(true)
    expect(isHostInjectedUserMessage({ role: 'user', source: { kind: 'tavern-prompt-plan' } })).toBe(true)
    expect(isHostInjectedUserMessage({ role: 'user', source: { kind: 'runtime-context' } })).toBe(true)
    expect(isHostInjectedUserMessage({ role: 'user', source: { kind: 'agent-instructions' } })).toBe(true)
    expect(isHostInjectedUserMessage({ role: 'user', source: { kind: 'model-selection' } })).toBe(true)
    expect(isHostInjectedUserMessage({ role: 'user', source: { kind: 'compact-checkpoint' } })).toBe(true)
  })

  it('非 user 角色或非注入来源不被判定为注入 user 消息', () => {
    expect(isHostInjectedUserMessage({ role: 'assistant', source: { kind: 'dsh-tavern' } })).toBe(false)
    expect(isHostInjectedUserMessage({ role: 'system', source: { kind: 'dsh-tavern' } })).toBe(false)
    expect(isHostInjectedUserMessage({ role: 'user', source: { kind: 'user' } })).toBe(false)
    expect(isHostInjectedUserMessage({ role: 'user', source: {} })).toBe(false)
    expect(isHostInjectedUserMessage({ role: 'user' })).toBe(false)
  })
})

describe('近期提交 Bug 1-5 回归验证', () => {
  let root: string
  let state: TavernState

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tavern-bugfix-regressions-'))
    state = new TavernState(
      {
        root,
        characters: join(root, 'characters'),
        lorebooks: join(root, 'library/lorebooks'),
        presets: join(root, 'library/presets'),
        personas: join(root, 'personas'),
        regexDir: join(root, 'regex'),
        sessions: join(root, 'sessions'),
      },
      () => resolveConfig({}),
    )
    await state.init()
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('Bug 1: 持久化会话触发 session/disposed 与 api-session/removed 时仅清理内存态，保留磁盘绑定供冷恢复；在途任务屏障不中断', async () => {
    const tempHome = await mkdtemp(join(tmpdir(), 'tavern-persisted-disposal-'))
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = tempHome
    try {
      const ctx = new Context()
      const rawConfig = (TavernConfigSchema as (input: unknown) => TavernConfigRaw)({})
      const config = Object.fromEntries(Object.entries(rawConfig).map(([k, v]) => [k, { get: () => v }])) as any
      const sessionsMap = new Map<string, Session>()
      const persistedSet = new Set<string>(['persisted-sess'])

      ctx.provide('settings', {
        configure: vi.fn(),
        describe: () => [{ ns: TAVERN_NS, revision: 1, value: rawConfig }],
        update: vi.fn(),
      } as any)
      ctx.provide('sessions', {
        list: () => [...sessionsMap.values()],
        get: (id: string) => sessionsMap.get(id),
      } as any)
      ctx.provide('sessionPersistence' as any, {
        stat: vi.fn(async (id: string) => (persistedSet.has(id) ? { header: { id } } : undefined)),
      })
      ctx.provide('agents', { get: () => undefined } as any)
      ctx.provide('typert', { register: () => () => {} } as any)
      ctx.provide('workspaceRegistry', { list: () => [] } as any)
      ctx.provide('agentPresets', { register: vi.fn(async () => async () => {}) } as any)
      ctx.provide('logger', { warn: vi.fn(), info: vi.fn() } as any)

      await apply(ctx, config)
      const hostState: TavernState = (ctx.get('tavern') as any).state
      const { cardId } = await hostState.createCharacter('冷恢复角色')
      const sess = Session.create(SessionId('persisted-sess'))
      sessionsMap.set(sess.id, sess)

      await hostState.saveBinding({
        sessionId: sess.id,
        cardId,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: null,
        greetingIndex: 0,
        createdAt: new Date(0).toISOString(),
      })
      const storyId = (await hostState.loadBinding(sess.id))!.storyId
      expect(storyId).toBeDefined()

      hostState.triggerLogs.set(sess.id, { at: 'now', lines: ['line'] })
      let inFlightDone = false
      const inFlight = hostState.enqueueSessionTask(sess.id, async () => {
        await new Promise((r) => setTimeout(r, 30))
        inFlightDone = true
      })

      // 模拟宿主空闲卸载：SessionController 监听 session/disposed 并广播 api-session/removed
      sessionsMap.delete(sess.id)
      ctx.emit('session/disposed', sess)
      ctx.emit('api-session/removed' as any, sess.id)

      await inFlight
      await vi.waitFor(() => {
        expect(inFlightDone).toBe(true)
        expect(hostState.triggerLogs.has(sess.id)).toBe(false)
      })
      // 磁盘绑定与 storyId 必须完好保留，供后续 resume 冷恢复
      const recovered = await hostState.loadBinding(sess.id)
      expect(recovered?.cardId).toBe(cardId)
      expect(recovered?.storyId).toBe(storyId)

      // 验证在途卸载等待期间若同一 sessionId 被重新冷恢复为新实例，迟到的 api-session/removed 不会误清恢复后的运行态
      let gateResolve!: () => void
      const gate = new Promise<void>((r) => { gateResolve = r })
      const gatedTask = hostState.enqueueSessionTask(sess.id, () => gate)
      sessionsMap.delete(sess.id)
      ctx.emit('session/disposed', sess)
      ctx.emit('api-session/removed' as any, sess.id)
      const resumed = Session.create(SessionId('persisted-sess'))
      sessionsMap.set(resumed.id, resumed)
      hostState.triggerLogs.set(resumed.id, { at: 'resumed', lines: ['keep-me'] })
      gateResolve()
      await gatedTask
      await new Promise((r) => setTimeout(r, 20))
      expect(hostState.triggerLogs.get(resumed.id)?.lines).toEqual(['keep-me'])

      await ctx.fiber.dispose()
    } finally {
      if (prevHome !== undefined) process.env.DSH_HOME = prevHome
      else delete process.env.DSH_HOME
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  it('Bug 1: 轮次中途调用 clearBinding 后，onTurnEnd 收口完成时自动清空残留内存态', async () => {
    const { cardId } = await state.createCharacter('中途解绑清理卡')
    const session = Session.create(SessionId('mid-turn-clear'))
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    session.append('turn/start', { turn: 1 })
    await onTurnStart(state, session.id, 1, session)
    state.triggerLogs.set(session.id, { at: 'now', lines: ['log'] })
    state.requestDiagnostics.set(session.id, { text: 'diag', truncated: false })

    await state.clearBinding(session.id)
    expect(state.openFloors.has(session.id)).toBe(true)

    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)

    expect(state.openFloors.has(session.id)).toBe(false)
    expect(state.triggerLogs.has(session.id)).toBe(false)
    expect(state.requestDiagnostics.has(session.id)).toBe(false)
    expect(state.helperTurnClosures.has(`${session.id}#t1`)).toBe(false)
  })

  it('Bug 2: continueFloor 产生的续写楼层可正常执行 regenerate', async () => {
    const { cardId } = await state.createCharacter('续写重生成卡')
    const session = Session.create(SessionId('session-continue-regen'))
    session.append('agent-preset/selected', { agentPreset: 'tavern' })
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: '开场提问' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const firstReply = createAssistantMessage({
      content: [{ type: 'text', text: '未说完的半截话' }],
      source: { provider: 'deepseek-official', model: 'deepseek-chat' },
    })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
      message: firstReply,
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    let promptedMessage: any
    let forkedRequest: any
    let createdChildId = ''
    const childAgents = new Map<string, any>()
    const childSessions = new Map<string, Session>()
    const childPrompt = vi.fn()
    const agentObj = {
      id: session.id,
      status: 'idle' as const,
      session,
      options: { provider: 'deepseek-official', model: 'deepseek-chat' },
      ctx: new Context(),
      followup: vi.fn((msg: any) => {
        promptedMessage = msg
        session.append('turn/start', { turn: 2 })
        session.append('step/start', { turn: 2, step: 1 })
        session.append('user/message', msg, { surfaceOp: 'append' })
        session.append('assistant/message', {
          turn: 2,
          step: 1,
          stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }],
          message: createAssistantMessage({ content: [{ type: 'text', text: '续写出的下半截话' }], source: { provider: 'deepseek-official', model: 'deepseek-chat' } }),
        }, { surfaceOp: 'append' })
        session.append('step/end', { turn: 2, step: 1 })
        session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
      }),
    }
    const presetService = {
      composedPreset: () => 'tavern',
      resolve: async (id: string) => ({ id }),
      mount: async () => {},
    }
    const ctx = {
      get: (key: string) => (key === 'agentPresets' ? presetService : undefined),
       agentPresets: presetService,
      logger: { warn: vi.fn() },
      sessions: { get: (id: string) => (id === session.id ? session : childSessions.get(id)) },
      agents: {
        get: (id: string) => (id === session.id ? agentObj : childAgents.get(id)),
        withoutInitiator: (fn: () => any) => fn(),
        create: vi.fn(async (req: any) => {
          forkedRequest = req
          createdChildId = req.sessionId
          const childSession = Session.create(SessionId(createdChildId))
          childSessions.set(createdChildId, childSession)
          const childAgent = {
            id: createdChildId,
            status: 'idle' as const,
            session: childSession,
            inbox: { clear: vi.fn() },
            followup: childPrompt,
          }
          childAgents.set(createdChildId, childAgent)
          return { agent: childAgent, dispose: vi.fn(async () => {}) }
        }),
      },
      workspace: { attachSession: vi.fn(async () => {}) },
      workspaceRegistry: { list: () => [] },
    } as unknown as Context

    await continueFloor({ ctx, state }, session.id, firstReply.id)
    expect(promptedMessage?.source?.kind).toBe('dsh-tavern')

    // 对第 2 轮（续写楼层）执行 regenerate，不应报 no-user-message
    const regenResult = await regenerate({ ctx, state }, session.id, undefined, 2)
    expect(regenResult.childSessionId).toBe(createdChildId)
    expect(forkedRequest).toBeDefined()
    expect(childPrompt).toHaveBeenCalledTimes(1)
  })

  it('Bug 3: 曾运行过模板的剧情在后续非模板轮次跨重启收口时，finishTurn 仍能恢复并提交未提交楼层；WAL 损坏不静默吞掉', async () => {
    const { cardId } = await state.createCharacter('模板后普通轮恢复卡')
    const session = Session.create(SessionId('post-template-sess'))
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadBinding(session.id))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)

    // 模拟第 1 轮曾运行过模板并已 completed
    session.append('turn/start', { turn: 1 })
    await onTurnStart(state, session.id, 1, session)
    await saveTemplateState(ws.fs.withFloor(`${session.id}#t1`), {
      version: 1,
      variables: { global: {}, local: {}, message: {} },
      outputs: {},
      generation: {
        version: 1,
        status: 'completed',
        sessionId: session.id,
        cardId,
        storyId: binding.storyId,
        turn: 1,
        floor: `${session.id}#t1`,
      },
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)
    expect((await ws.wal.validateFloor(`${session.id}#t1`)).committed).toBe(true)

    // 第 2 轮为非模板普通轮，开层后模拟崩溃重启（内存 openFloors 丢失）
    session.append('turn/start', { turn: 2 })
    await onTurnStart(state, session.id, 2, session)
    await ws.fs.withFloor(`${session.id}#t2`).writeText('notes.txt', '第二轮普通写入')
    state.openFloors.delete(session.id)
    state.currentTurns.delete(session.id)

    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    await onTurnEnd(state, session.id, session)
    expect((await ws.wal.validateFloor(`${session.id}#t2`)).committed).toBe(true)

    // 验证首次 mkdir 后未写 meta.json 的空遗留目录在 onTurnStart 中视作未开层并正常补开
    await mkdir(join(ws.fs.root, 'state/wal', `${session.id}_t3`), { recursive: true })
    session.append('turn/start', { turn: 3 })
    await onTurnStart(state, session.id, 3, session)
    expect((await ws.wal.validateFloor(`${session.id}#t3`)).committed).toBe(false)

    // 验证第 3 轮若 WAL 元数据损坏，onTurnStart 与 onTurnEnd 必须显式抛出而非吞掉
    state.openFloors.delete(session.id)
    const corruptMetaPath = join(ws.fs.root, 'state/wal', `${session.id}_t3`, 'meta.json')
    await writeFile(corruptMetaPath, '{corrupt-meta', 'utf8')
    await expect(onTurnStart(state, session.id, 3, session)).rejects.toThrow(/WAL 元数据损坏/)
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
    await expect(onTurnEnd(state, session.id, session)).rejects.toThrow(/WAL 元数据损坏/)
  })

  it('Bug 4: 多会话共享 preset 作用域下第 2 个会话仍剥除伪造 tavern-deepseek 换模通知，且 modelSelection 投影正确清零 pending', async () => {
    const ctx = new Context()
    const projections = new SessionProjectionRegistry(ctx)
    const selSchema = z.object({
      provider: z.string().min(1),
      model: z.string().min(1),
      reasoningEffort: z.string().min(1).optional(),
    })
    projections.register({
      key: 'modelSelection',
      stateSchema: z.object({ lastUsed: selSchema.nullable(), pending: selSchema.nullable() }),
      init: () => ({ lastUsed: null, pending: null }),
      apply: (st: any, event: any) => {
        if (event.type === 'model/selection') return { lastUsed: st.lastUsed, pending: event.data }
        if (event.type !== 'request/header') return st
        const lastUsed = {
          provider: event.data.header.config.provider,
          model: event.data.header.config.model,
        }
        const pending = st.pending && st.pending.provider === lastUsed.provider && st.pending.model === lastUsed.model ? null : st.pending
        return { lastUsed, pending }
      },
      stateVersion: 2,
    } as any)
    new SystemPrompt(ctx, {})
    new LlmRuntime(ctx)
    ctx.provide('tools', { register: vi.fn(() => () => {}) } as any)
    ctx.provide('tavern', { state })

    // 挂载一次 applyAgent（模拟 preset 作用域只挂载一次）
    applyAgent(ctx)

    // 第 1 个会话触发一次 system-prompt/assemble
    const sess1 = Session.create(SessionId('multi-sess-1'))
    const agent1 = { id: sess1.id, session: sess1, options: {} } as any
    await ctx.waterfall(
      'system-prompt/assemble',
      { sections: [], contexts: [], variables: {} } as any,
      { agent: agent1, signal: new AbortController().signal } as any,
      async () => ({ sections: [], contexts: [], variables: {} }) as any,
    )

    // 第 2 个会话稍后创建并调用 installModelSelection（其 prepend: true 会排在旧钩子之前）
    const sess2 = Session.create(SessionId('multi-sess-2'))
    sess2.append('model/selection', { provider: 'deepseek-official', model: 'deepseek-chat' })
    sess2.append('request/header', {
      turn: 1,
      step: 1,
      header: {
        config: { provider: 'tavern-deepseek', model: 'deepseek-chat' },
        systemMessages: [createSystemMessage('sys')],
      },
    })
    let picked: any = { provider: 'deepseek-official', model: 'deepseek-chat' }
    const selection2 = {
      get current() {
        return picked
      },
      set current(v: any) {
        picked = v
      },
      consume(provider: string, model: string) {
        if (picked?.provider !== provider || picked?.model !== model) return false
        picked = undefined
        return true
      },
      assembled: undefined as any,
    }
    installModelSelection(ctx, selection2)

    const agent2 = { id: sess2.id, session: sess2, options: {} } as any
    await ctx.waterfall(
      'system-prompt/assemble',
      { sections: [], contexts: [], variables: {} } as any,
      { agent: agent2, signal: new AbortController().signal } as any,
      async () => ({ sections: [], contexts: [], variables: {} }) as any,
    )

    const userMsg = createUserMessage({ content: [{ type: 'text', text: '第二会话测试' }], source: { kind: 'user' } })
    const decision = await ctx.waterfall(
      'agent/pre-step',
      {
        agent: agent2,
        turn: 2,
        step: 1,
        messages: [userMsg],
        signal: new AbortController().signal,
        decision: { kind: 'enter' as const, messages: [userMsg] },
      } as any,
      async () => ({ kind: 'enter' as const, messages: [userMsg] }),
    )
    expect(decision.kind).toBe('enter')
    if (decision.kind === 'enter') {
      expect(decision.messages.some((m: any) => m.source.kind === 'model-selection')).toBe(false)
    }

    // 验证 modelSelection 投影将 tavern-deepseek 归一化为 deepseek-official 并清除同模型 pending
    const projState = projections.stateOf(sess2, 'modelSelection' as any) as any
    expect(projState).toEqual({
      lastUsed: { provider: 'deepseek-official', model: 'deepseek-chat' },
      pending: null,
    })
  })

  it('Bug 5: frontierAt 在跨轮边界停止且不吞并下一轮续写/计划载体；pipeline 与 impersonate 保持一致规范', async () => {
    const ctx = new Context()
    const session = Session.create(SessionId('frontier-sess'))
    session.append('agent-preset/selected', { agentPreset: 'tavern' })
    session.append('turn/start', { turn: 1 })
    const msg1 = createUserMessage({ content: [{ type: 'text', text: '第一轮无回复输入' }], source: { kind: 'user' } })
    session.append('user/message', msg1, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } })

    session.append('turn/start', { turn: 2 })
    const standingText = `${BOUND_DISCIPLINE}\n\nSTANDING`
    const anchor0 = { inputIndex: 0, messageId: msg1.id, role: 'user' as const, chat: true }
    const plan2 = {
      version: 1 as const,
      sessionId: session.id,
      turn: 2,
      standingText,
      contextText: 'CONTEXT',
      cacheFirst: true,
      layout: {
        version: 1 as const,
        history: [anchor0],
        entries: [
          {
            key: 'after-u1',
            role: 'user' as const,
            content: 'AFTER_TURN1_MARKER',
            sourceKeys: ['after-u1'],
            turnLocal: false,
            placement: { kind: 'history-relative' as const, anchor: anchor0, side: 'after' as const },
          },
          {
            key: 'tail-entry',
            role: 'system' as const,
            content: 'TURN2_TAIL_MARKER',
            sourceKeys: ['tail-entry'],
            turnLocal: true,
            placement: { kind: 'after-history' as const, anchor: anchor0, order: 0 },
          },
        ],
      },
    }
    const contMsg = createUserMessage({
      id: 'u2-cont' as any,
      content: [{ type: 'text', text: '[Continue the following message. Do not repeat any part of it.]\n\n' }],
      source: { kind: 'dsh-tavern', form: 'notice', summary: '续写指令' } as any,
    })
    const stepNoticeMsg = createUserMessage({
      id: 'u2-step-notice' as any,
      content: [{ type: 'text', text: '【Tavern 步骤】当前位于本轮第 2 步。' }],
      source: { kind: 'dsh-tavern', form: 'notice', summary: '步骤 2 收口提示' } as any,
    })
    const planCarrier = createPresetPlanMessage(plan2)
    session.append('user/message', planCarrier, { surfaceOp: 'append' })
    session.append('user/message', contMsg, { surfaceOp: 'append' })
    session.append('user/message', stepNoticeMsg, { surfaceOp: 'append' })

    ctx.provide('sessions', { get: (id: string) => (id === session.id ? session : undefined) } as any)
    ctx.provide('agents', { get: () => undefined } as any)

    const projector = createPresetRequestProjector(ctx)
    const projected = projector.project(
      {
        sessionId: session.id,
        messages: [
          createSystemMessage(`SDK\n\n${standingText}`),
          msg1,
          planCarrier,
          contMsg,
          stepNoticeMsg,
        ],
      } as any,
      { systemPromptUpdate: 'in-history', defaultMaxTokens: 4096 },
    )
    const texts = projected.messages.map((m) => m.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n'))
    const idxAfterU1 = texts.findIndex((t) => t.includes('AFTER_TURN1_MARKER'))
    const idxCont = texts.findIndex((t) => t.includes('[Continue the following message'))
    const idxTail = texts.findIndex((t) => t.includes('TURN2_TAIL_MARKER'))
    const idxStepNotice = texts.findIndex((t) => t.startsWith('【Tavern 步骤】'))
    expect(idxAfterU1).toBeGreaterThan(0)
    expect(idxCont).toBeGreaterThan(idxAfterU1)
    expect(idxTail).toBeGreaterThan(idxCont)
    expect(idxStepNotice).toBeGreaterThan(idxTail)

    // 验证 impersonate 非 Tavern 会话报错文案中的空格
    const plainSess = Session.create(SessionId('plain-sess'))
    const impCtx = {
      get: () => undefined,
      sessions: { get: () => plainSess },
      agents: { get: () => undefined },
      sessionProjections: { stateOf: () => undefined },
    } as unknown as Context
    await expect(impersonate({ ctx: impCtx, state }, plainSess.id)).rejects.toThrow('当前会话不是 Tavern 模式')

    // 验证 pipeline 过滤非合成 dsh-tavern 消息与 templateMessageHistory 一致
    const { cardId } = await state.createCharacter('管线过滤卡')
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const customTavernNotice = createUserMessage({
      id: 'u-custom-notice' as any,
      content: [{ type: 'text', text: '非标准前缀插件提示' }],
      source: { kind: 'dsh-tavern', form: 'notice', summary: '内部通知' } as any,
    })
    session.append('user/message', customTavernNotice, { surfaceOp: 'append' })
    const res = await runTavernPipeline({
      state,
      sessionId: session.id,
      agent: { id: session.id, session, options: {} } as any,
      mode: 'preview',
    })
    expect(res?.history.map((m) => m.content)).toEqual(['第一轮无回复输入'])
  })
})

