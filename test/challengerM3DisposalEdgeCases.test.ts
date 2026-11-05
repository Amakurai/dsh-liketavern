/**
 * 会话销毁、绑定清理边界条件与运行期内存状态无残留压力回归测试。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { resolveConfig, TAVERN_NS, TavernConfigSchema, type TavernConfigRaw } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'
import { apply } from '../src/index.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'

describe('Challenger M3: Session Disposal & clearBinding Adversarial Stress', () => {
  let root: string
  let state: TavernState
  let ctx: Context
  let sessionsMap: Map<string, Session>
  let prevHome: string | undefined

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'challenger-m3-disposal-'))
    prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = root

    ctx = new Context()
    const rawConfig = (TavernConfigSchema as (input: unknown) => TavernConfigRaw)({})
    const config = Object.fromEntries(Object.entries(rawConfig).map(([k, v]) => [k, { get: () => v }])) as any
    sessionsMap = new Map<string, Session>()

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

    await apply(ctx, config)
    const service = ctx.get('tavern') as any
    state = service.state
  })

  afterEach(async () => {
    await ctx.fiber.dispose()
    if (prevHome !== undefined) process.env.DSH_HOME = prevHome
    else delete process.env.DSH_HOME
    await rm(root, { recursive: true, force: true })
  })

  it('Edge Case 1: 50 concurrent duplicate disposals (session/disposed + api-session/removed) complete idempotently without errors', async () => {
    const { cardId } = await state.createCharacter('高并发销毁卡')
    const sessionId = 'concurrent-double-disposal'
    const sess = Session.create(SessionId(sessionId))
    sessionsMap.set(sessionId, sess)

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

    // Populate all 16 runtime tables
    state.openFloors.set(sessionId, { cardId, floor: `${sessionId}#t1` })
    state.currentTurns.set(sessionId, 1)
    state.currentSteps.set(sessionId, 3)
    state.stepNoticeMarks.set(sessionId, '1:3')
    state.turnPlans.set(sessionId, { turn: 1, cardId, result: {} as any })
    state.pendingTurnPlans.set(sessionId, { turn: 1, cardId, floor: `${sessionId}#t1`, publish: async () => ({} as any) })
    state.pendingInputs.set(sessionId, ['input1'])
    state.pendingTemplateInputs.set(sessionId, [{ id: 't1', text: 'txt' }])
    state.triggerLogs.set(sessionId, { at: '2026-01-01', lines: ['l1'] })
    state.requestDiagnostics.set(sessionId, { text: 'diag', truncated: false })
    state.sessionTaskTails.set(sessionId, Promise.resolve())
    state.sessionCommitTails.set(sessionId, Promise.resolve())
    state.helperTurnClosures.set(`${sessionId}#t1`, { seq: 1 } as any)
    state.helperTurnClosures.set(sessionId, { seq: 1 } as any)
    state.pinStanding(sessionId, 'chat', `fp\0v1\0${cardId}`, 'standing-chat')
    state.pinStanding(sessionId, 'impersonate', `fp\0v1\0${cardId}`, 'standing-imp')
    state.appliedStanding.set(sessionId, 'standing-applied')
    state.appliedTurnContext.set(sessionId, 'turn-context-applied')

    // Fire 25 session/disposed and 25 api-session/removed concurrently
    const emissions: Promise<void>[] = []
    for (let i = 0; i < 25; i++) {
      ctx.emit('session/disposed', sess)
      ctx.emit('api-session/removed' as any, sessionId)
    }

    await vi.waitFor(async () => {
      expect(await state.loadBinding(sessionId)).toBeNull()
    })

    // Assert zero leaks in any of the maps
    expect(state.openFloors.has(sessionId)).toBe(false)
    expect(state.currentTurns.has(sessionId)).toBe(false)
    expect(state.currentSteps.has(sessionId)).toBe(false)
    expect(state.stepNoticeMarks.has(sessionId)).toBe(false)
    expect(state.turnPlans.has(sessionId)).toBe(false)
    expect(state.pendingTurnPlans.has(sessionId)).toBe(false)
    expect(state.pendingInputs.has(sessionId)).toBe(false)
    expect(state.pendingTemplateInputs.has(sessionId)).toBe(false)
    expect(state.triggerLogs.has(sessionId)).toBe(false)
    expect(state.requestDiagnostics.has(sessionId)).toBe(false)
    expect(state.sessionTaskTails.has(sessionId)).toBe(false)
    expect(state.sessionCommitTails.has(sessionId)).toBe(false)
    expect(state.helperTurnClosures.has(sessionId)).toBe(false)
    expect(state.helperTurnClosures.has(`${sessionId}#t1`)).toBe(false)
    expect(state.peekStanding(sessionId, 'chat', cardId)).toBeUndefined()
    expect(state.peekStanding(sessionId, 'impersonate', cardId)).toBeUndefined()
    expect(state.appliedStanding.has(sessionId)).toBe(false)
    expect(state.appliedTurnContext.has(sessionId)).toBe(false)
  })

  it('Edge Case 2: In-flight trackBindingAdoption is cancelled and cleaned on session disposal', async () => {
    const sessionId = 'session-with-slow-adoption'
    let adoptionSettled = false

    const slowAdoption = state.trackBindingAdoption(sessionId, async () => {
      await new Promise(r => setTimeout(r, 50))
      adoptionSettled = true
      return true
    })

    // Dispose while adoption promise is pending in tracking map
    state.clearSessionRuntime(sessionId)
    await state.clearBinding(sessionId)

    expect(await slowAdoption).toBe(true)
    expect(adoptionSettled).toBe(true)

    // Binding adoptions map should be purged and not leave stale entries
    await vi.waitFor(() => {
      expect((state as any).bindingAdoptions.has(sessionId)).toBe(false)
      expect((state as any).bindingAdoptionRetries.has(sessionId)).toBe(false)
    })
  })

  it('Edge Case 3: clearBinding during active turn preserves openFloors until finishTurn completes', async () => {
    const { cardId } = await state.createCharacter('轮次中解绑卡')
    const sessionId = 'active-turn-unbinding'
    const sess = Session.create(SessionId(sessionId))
    sessionsMap.set(sessionId, sess)

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

    // Begin a turn
    await onTurnStart(state, sessionId, 1, sess)
    expect(state.openFloors.has(sessionId)).toBe(true)
    const storyId = state.openFloors.get(sessionId)?.storyId
    expect(storyId).toBeDefined()

    // Simulate mid-turn unbind via clearBinding
    await state.clearBinding(sessionId)

    // Invariant: openFloors is preserved so WAL floor can be committed on turn end
    expect(state.openFloors.has(sessionId)).toBe(true)
    expect(state.openFloors.get(sessionId)?.storyId).toBe(storyId)
    // Binding file on disk was deleted
    expect(await state.loadBinding(sessionId)).toBeNull()

    // Complete the turn
    await onTurnEnd(state, sessionId, sess)

    // Once turn ends, openFloors must be cleaned
    expect(state.openFloors.has(sessionId)).toBe(false)
    expect(state.currentTurns.has(sessionId)).toBe(false)
  })

  it('Edge Case 4: Windows case variation of session ID in disposal does not crash or corrupt state', async () => {
    const { cardId } = await state.createCharacter('大小写卡')
    const baseId = 'Session-Case-Variation'
    const sess = Session.create(SessionId(baseId))
    sessionsMap.set(baseId, sess)

    await state.saveBinding({
      sessionId: baseId,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date().toISOString(),
    })

    state.pinStanding(baseId, 'chat', `fp\0v1\0${cardId}`, 'standing-original')

    // Clear runtime with exact case
    state.clearSessionRuntime(baseId)
    expect(state.peekStanding(baseId, 'chat', cardId)).toBeUndefined()

    // Clearing an arbitrary or lower-case variation of unknown session is idempotent
    state.clearSessionRuntime(baseId.toLowerCase())
    await state.clearBinding(baseId)

    expect(await state.loadBinding(baseId)).toBeNull()
  })
})
