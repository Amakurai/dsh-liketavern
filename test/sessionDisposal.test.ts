/**
 * 会话销毁生命周期、运行期清理、宿主注入过滤与适配器未绑定会话保护回归。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { resolveConfig, TAVERN_NS, TavernConfigSchema, type TavernConfigRaw } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'
import { isHostInjectedUserMessage } from '../src/core/dshPrompt.js'
import { apply, projectTavernAdapterRequest } from '../src/index.js'
import { createPresetRequestProjector } from '../src/node/presetRequestProjection.js'

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

    // 填充 session B 状态（对照组）
    state.openFloors.set(sessB, { cardId: 'card-2', floor: `${sessB}#t1` })
    state.currentTurns.set(sessB, 1)
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
