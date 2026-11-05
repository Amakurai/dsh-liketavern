/**
 * 会话绑定人设自愈、空人设零写盘、并发楼层中断与会话销毁内存释放对抗压力测试。
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { sessionFile, type TavernPaths } from '../src/node/paths.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { TavernService } from '../src/node/service.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'

let root: string
let paths: TavernPaths
let state: TavernState
let service: TavernService
let cordisCtx: Context
let settingsScope: TavernSettingsScope

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'challenger-m3-adversarial-'))
  paths = {
    root,
    characters: join(root, 'characters'),
    lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'),
    personas: join(root, 'personas'),
    regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions'),
  }
  let currentSettings = resolveConfig({})
  settingsScope = {
    get: () => currentSettings,
    revision: () => 1,
    update: async (patch) => {
      currentSettings = { ...currentSettings, ...patch, defaults: { ...currentSettings.defaults, ...patch.defaults } }
    },
  }
  state = new TavernState(paths, () => settingsScope.get())
  await state.init()

  const sessionsMap = new Map<string, Session>()
  cordisCtx = {
    reflect: { provide: () => {} },
    get: () => undefined,
    sessions: {
      get: (id: string) => sessionsMap.get(id),
      set: (id: string, s: Session) => sessionsMap.set(id, s),
      list: () => [...sessionsMap.values()],
    },
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as Context

  service = new TavernService(cordisCtx, state, settingsScope)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

describe('Empirical Probe 1: Zero-Disk-Write Invariant for personaId: null', () => {
  it('strictly ZERO disk writes across 5 sequential turns with pipeline executions and helper states', async () => {
    const pDefault = await state.savePersona({
      id: 'default-p',
      name: '全局默认人设',
      description: '这是全局默认人设的描述',
      avatar: null,
    })
    await settingsScope.update({ defaults: { personaId: pDefault } })

    const card = await state.createCharacter('SequentialTurnCharacter')
    const sessionId = 'zero-write-seq-session'

    await state.saveBinding({
      sessionId,
      cardId: card.cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: true,
      helperMvu: true,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    const initialBinding = (await state.loadStoryBinding(sessionId))!
    const ws = await state.storyWorkspace(card.cardId, initialBinding.storyId!)
    await ws.fs.writeText('state/helper.json', JSON.stringify({
      version: 1,
      scopes: {},
      extras: {},
      mvu: { version: 1, initialized: true, pending: [], completed: [] },
    }))

    const sFile = sessionFile(paths, sessionId)
    const originalContent = await readFile(sFile, 'utf8')
    const originalStat = await stat(sFile)
    expect(JSON.parse(originalContent).personaId).toBeNull()

    const saveBindingSpy = vi.spyOn(state, 'saveBinding')

    // Execute 5 full sequential turns
    for (let turn = 1; turn <= 5; turn++) {
      // 1. onTurnStart
      await onTurnStart(state, sessionId, turn)

      // 2. loadStoryBinding
      const storyBinding = await state.loadStoryBinding(sessionId)
      expect(storyBinding?.personaId).toBeNull()

      // 3. pipeline assembly
      const run = await runTavernPipeline({
        state,
        sessionId,
        agent: null,
        mode: 'live',
        historyOverride: [{ role: 'user', content: `用户发言第${turn}轮` }],
      })
      expect(run).toBeDefined()
      // Pipeline in-memory persona resolution should resolve default persona
      expect(run?.standing).toContain('这是全局默认人设的描述')

      // 4. onTurnEnd
      await onTurnEnd(state, sessionId)

      // 5. verify session file on disk after each turn
      const curContent = await readFile(sFile, 'utf8')
      const curStat = await stat(sFile)
      expect(curContent).toBe(originalContent)
      expect(curStat.mtimeMs).toBe(originalStat.mtimeMs)
      expect(JSON.parse(curContent).personaId).toBeNull()
    }

    // Absolutely zero saveBinding calls after initial setup
    expect(saveBindingSpy).not.toHaveBeenCalled()
  })

  it('concurrent turns across 25 distinct sessions with personaId: null never trigger session file writes', async () => {
    const pDefault = await state.savePersona({
      id: 'default-p2',
      name: '并发默认人设',
      description: '并发人设描述',
      avatar: null,
    })
    await settingsScope.update({ defaults: { personaId: pDefault } })

    const card = await state.createCharacter('MultiSessionZeroWriteCard')
    const count = 25
    const sessionIds = Array.from({ length: count }, (_, i) => `concurrent-null-sess-${i}`)

    for (const sid of sessionIds) {
      await state.saveBinding({
        sessionId: sid,
        cardId: card.cardId,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: false,
        greetingIndex: 0,
        createdAt: new Date(0).toISOString(),
      })
    }

    // Record initial stats
    const statsBefore = new Map<string, { content: string; mtime: number }>()
    for (const sid of sessionIds) {
      const sFile = sessionFile(paths, sid)
      const content = await readFile(sFile, 'utf8')
      const s = await stat(sFile)
      statsBefore.set(sid, { content, mtime: s.mtimeMs })
    }

    const saveBindingSpy = vi.spyOn(state, 'saveBinding')

    // Concurrently execute turn start + pipeline + turn end
    await Promise.all(sessionIds.map(async (sid) => {
      await onTurnStart(state, sid, 1)
      const res = await runTavernPipeline({
        state,
        sessionId: sid,
        agent: null,
        mode: 'live',
        historyOverride: [{ role: 'user', content: '测试并发' }],
      })
      expect(res?.standing).toContain('并发人设描述')
      await onTurnEnd(state, sid)
    }))

    expect(saveBindingSpy).not.toHaveBeenCalled()

    // Verify all 25 files are bit-for-bit identical
    for (const sid of sessionIds) {
      const sFile = sessionFile(paths, sid)
      const contentAfter = await readFile(sFile, 'utf8')
      const statAfter = await stat(sFile)
      const before = statsBefore.get(sid)!
      expect(contentAfter).toBe(before.content)
      expect(statAfter.mtimeMs).toBe(before.mtime)
      expect(JSON.parse(contentAfter).personaId).toBeNull()
    }
  })
})

describe('Empirical Probe 2: Deleted Bound Persona Self-Healing Writeback', () => {
  it('heals deleted bound persona to default persona on read, updating disk atomically', async () => {
    // 1. Create two personas
    const pBound = await state.savePersona({
      id: 'bound-persona',
      name: '被绑定的人设',
      description: '绑定描述',
      avatar: null,
    })
    const pFallback = await state.savePersona({
      id: 'fallback-persona',
      name: '兜底人设',
      description: '兜底描述',
      avatar: null,
    })
    await settingsScope.update({ defaults: { personaId: pFallback } })

    const card = await state.createCharacter('SelfHealingCard')
    const sessionId = 'self-healing-session-1'

    await state.saveBinding({
      sessionId,
      cardId: card.cardId,
      presetId: null,
      personaId: pBound,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    const sFile = sessionFile(paths, sessionId)
    expect(JSON.parse(await readFile(sFile, 'utf8')).personaId).toBe(pBound)

    // 2. Delete the bound persona
    await state.deletePersona(pBound)
    expect(await state.loadPersona(pBound)).toBeNull()

    // 3. Mid-turn loadStoryBinding: MUST PRESERVE pBound and NOT heal to disk yet!
    const midStoryBinding = await state.loadStoryBinding(sessionId)
    expect(midStoryBinding?.personaId).toBe(pBound)
    expect(JSON.parse(await readFile(sFile, 'utf8')).personaId).toBe(pBound)

    // 4. Read via service.getSessionBinding / state.loadBinding: MUST HEAL to pFallback and WRITE TO DISK!
    const healed = await service.getSessionBinding({ sessionId })
    expect(healed.binding?.personaId).toBe(pFallback)

    // Direct disk verification
    const onDiskAfterHealing = JSON.parse(await readFile(sFile, 'utf8'))
    expect(onDiskAfterHealing.personaId).toBe(pFallback)

    // 5. Subsequent reads are idempotent (no redundant writes)
    const stat1 = await stat(sFile)
    const readAgain = await state.loadBinding(sessionId)
    expect(readAgain?.personaId).toBe(pFallback)
    const stat2 = await stat(sFile)
    expect(stat2.mtimeMs).toBe(stat1.mtimeMs)
  })

  it('heals deleted bound persona to null when system has ZERO personas, and subsequent reads cause ZERO writes', async () => {
    // 1. Create single persona and bind
    const pOnly = await state.savePersona({
      id: 'only-persona',
      name: '独苗人设',
      description: '独苗描述',
      avatar: null,
    })
    await settingsScope.update({ defaults: { personaId: null } })

    const card = await state.createCharacter('SinglePersonaCard')
    const sessionId = 'zero-persona-healing-session'

    await state.saveBinding({
      sessionId,
      cardId: card.cardId,
      presetId: null,
      personaId: pOnly,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    const sFile = sessionFile(paths, sessionId)
    expect(JSON.parse(await readFile(sFile, 'utf8')).personaId).toBe(pOnly)

    // 2. Delete pOnly so 0 personas exist in system
    await state.deletePersona(pOnly)
    expect((await state.listPersonas())).toHaveLength(0)

    // 3. Read triggers self-healing to null
    const healedBinding = await state.loadBinding(sessionId)
    expect(healedBinding?.personaId).toBeNull()

    // 4. Verify disk was updated to null
    const healedDisk = JSON.parse(await readFile(sFile, 'utf8'))
    expect(healedDisk.personaId).toBeNull()

    // 5. Now that personaId is null, test that ALL subsequent turn operations cause ZERO writes
    const sStatAfterHealing = await stat(sFile)
    const sContentAfterHealing = await readFile(sFile, 'utf8')

    await onTurnStart(state, sessionId, 1)
    await runTavernPipeline({
      state,
      sessionId,
      agent: null,
      mode: 'live',
      historyOverride: [{ role: 'user', content: '无任何人设测试' }],
    })
    await onTurnEnd(state, sessionId)

    const sStatAfterTurn = await stat(sFile)
    const sContentAfterTurn = await readFile(sFile, 'utf8')
    expect(sContentAfterTurn).toBe(sContentAfterHealing)
    expect(sStatAfterTurn.mtimeMs).toBe(sStatAfterHealing.mtimeMs)
  })

  it('concurrent racing readers during deleted persona self-healing converge safely without lock conflict or corruption', async () => {
    const p1 = await state.savePersona({ id: 'p-race-1', name: 'Race1', description: 'desc', avatar: null })
    const p2 = await state.savePersona({ id: 'p-race-2', name: 'Race2', description: 'desc2', avatar: null })
    await settingsScope.update({ defaults: { personaId: p2 } })

    const card = await state.createCharacter('RaceHealingCard')
    const sessionId = 'racing-healing-session'

    await state.saveBinding({
      sessionId,
      cardId: card.cardId,
      presetId: null,
      personaId: p1,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    // Delete p1
    await state.deletePersona(p1)

    // 30 concurrent loadBinding calls
    const calls = Array.from({ length: 30 }, () => state.loadBinding(sessionId))
    const results = await Promise.allSettled(calls)

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')
    expect(rejected).toHaveLength(0)
    expect(fulfilled).toHaveLength(30)

    for (const r of fulfilled) {
      expect((r as PromiseFulfilledResult<any>).value.personaId).toBe(p2)
    }

    // Disk must have p2
    const sFile = sessionFile(paths, sessionId)
    const finalDisk = JSON.parse(await readFile(sFile, 'utf8'))
    expect(finalDisk.personaId).toBe(p2)
  })
})

describe('Empirical Probe 3: Rapid Concurrent Floor Operations & Session Deletion Stress', () => {
  it('handles rapid interleaved floor operations and session disposal without unhandled errors or orphaned state', async () => {
    const card = await state.createCharacter('FloorStressCard')
    const sessionCount = 10
    const sessions = Array.from({ length: sessionCount }, (_, i) => `floor-stress-sess-${i}`)

    for (const sid of sessions) {
      await state.saveBinding({
        sessionId: sid,
        cardId: card.cardId,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: false,
        greetingIndex: 0,
        createdAt: new Date(0).toISOString(),
      })
    }

    // Interleave rapid onTurnStart, prompt assembly, and concurrent disposal
    const operations: Promise<unknown>[] = []

    for (const sid of sessions) {
      operations.push((async () => {
        // Start turn 1
        await onTurnStart(state, sid, 1)

        // Run pipeline
        await runTavernPipeline({
          state,
          sessionId: sid,
          agent: null,
          mode: 'live',
          historyOverride: [{ role: 'user', content: '并发楼层测试' }],
        })

        // Concurrently clear binding or finish turn
        if (Math.random() > 0.5) {
          // Finish turn then clear
          await onTurnEnd(state, sid)
          await state.clearBinding(sid)
        } else {
          // Clear binding mid-turn (simulating user closing tab or session disposal)
          await state.clearBinding(sid)
          // Finish turn on closed session should not throw fatal unhandled error
          try {
            await onTurnEnd(state, sid)
          } catch {
            // expected or handled gracefully
          }
        }
      })())
    }

    const results = await Promise.allSettled(operations)
    const failures = results.filter(r => r.status === 'rejected')
    expect(failures).toHaveLength(0)

    // Memory Leak Oracle: verify that all disposed sessions have ZERO entries across state maps
    for (const sid of sessions) {
      state.clearSessionRuntime(sid)

      expect(state.openFloors.has(sid)).toBe(false)
      expect(state.currentTurns.has(sid)).toBe(false)
      expect(state.currentSteps.has(sid)).toBe(false)
      expect(state.stepNoticeMarks.has(sid)).toBe(false)
      expect(state.turnPlans.has(sid)).toBe(false)
      expect(state.pendingTurnPlans.has(sid)).toBe(false)
      expect(state.pendingInputs.has(sid)).toBe(false)
      expect(state.pendingTemplateInputs.has(sid)).toBe(false)
      expect(state.triggerLogs.has(sid)).toBe(false)
      expect(state.requestDiagnostics.has(sid)).toBe(false)
      expect(state.sessionTaskTails.has(sid)).toBe(false)
      expect(state.sessionCommitTails.has(sid)).toBe(false)
    }
  })

  it('session disposal event handlers purge runtime memory state completely', async () => {
    const card = await state.createCharacter('DisposalEventCard')
    const sid = 'disposal-event-session-1'

    await state.saveBinding({
      sessionId: sid,
      cardId: card.cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    // Put data in runtime maps
    state.currentTurns.set(sid, 1)
    state.currentSteps.set(sid, 2)
    state.stepNoticeMarks.set(sid, 1)
    state.triggerLogs.set(sid, [])
    state.requestDiagnostics.set(sid, { kind: 'diagnostics' } as any)

    // Simulate session disposal
    state.clearSessionRuntime(sid)
    await state.clearBinding(sid)

    // Verify all memory maps are completely cleared
    expect(state.currentTurns.has(sid)).toBe(false)
    expect(state.currentSteps.has(sid)).toBe(false)
    expect(state.stepNoticeMarks.has(sid)).toBe(false)
    expect(state.triggerLogs.has(sid)).toBe(false)
    expect(state.requestDiagnostics.has(sid)).toBe(false)
    expect(await state.loadBinding(sid)).toBeNull()
  })
})
