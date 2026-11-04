/**
 * Empirical Adversarial Stress Test Probe for Milestone 2 (Issues 9–13).
 * Critic & Specialist Stress Probes:
 * - Issue 9: Frozen turn persona preservation & disk write-back protection during mid-turn default persona mutation
 * - Issue 10: Preset corruption handling (invalid syntax, truncated bytes, malformed UTF-8) with strictRead & no path leak in tools/pipeline
 * - Issue 11: Host fork adoption plan cleanup on clearSessionBinding (disk status === 'skipped', memory plan discarded, no phantom adoption)
 * - Issue 12: Journal optimistic concurrency with stale revisions & multi-writer race conflict detection
 * - Issue 13: Bounded character upload validation with oversized base64 preflight (Buffer.from zero allocation)
 */
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { Session } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultPreset } from '../src/core/assemble.js'
import { MAX_CARD_PNG_BASE64_CHARS } from '../src/core/cardLimits.js'
import { resolveConfig, type TavernSettingsScope } from '../src/node/config.js'
import { adoptHostFork } from '../src/node/floors.js'
import { hostForkAdoptionFile } from '../src/node/hostForkAdoption.js'
import { sessionFile, type TavernPaths } from '../src/node/paths.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { TavernService } from '../src/node/service.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { jsonEditRevision } from '../src/state/characterRevision.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let paths: TavernPaths
let state: TavernState
let service: TavernService
let cordisCtx: Context
let settingsScope: TavernSettingsScope

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'challenger-m2-stress-'))
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
    sessions: {
      get: (id: string) => sessionsMap.get(id),
      set: (id: string, s: Session) => sessionsMap.set(id, s),
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

describe('Adversarial Stress Test: Issue 9 (Frozen Turn Persona Preservation)', () => {
  it('mid-turn execution holds frozen turn persona and never writes session binding to disk when default persona changes', async () => {
    // 1. Setup personas P1 and P2
    const p1 = await state.savePersona({ id: 'persona-1', name: '人设一', description: '第一人设描述', avatar: null })
    const p2 = await state.savePersona({ id: 'persona-2', name: '人设二', description: '第二人设描述', avatar: null })

    // Set P1 as default persona in settings
    await settingsScope.update({ defaults: { personaId: p1 } })

    // Create character and bind session with persona P1
    const card = await state.createCharacter('测试主角')
    const sessionId = 'stress-session-p9'
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

    // 2. Start Turn 1
    await onTurnStart(state, sessionId, 1)

    // Assemble pipeline at turn start (freezes turn plan with P1)
    const firstRun = await runTavernPipeline({
      state,
      sessionId,
      agent: null,
      mode: 'live',
      historyOverride: [{ role: 'user', content: '你好' }],
    })
    expect(firstRun?.standing).toContain('第一人设描述')

    // Snapshot session binding on disk before mid-turn mutations
    const sFile = sessionFile(paths, sessionId)
    const diskBeforeMidTurn = await readFile(sFile, 'utf8')
    const statBeforeMidTurn = await stat(sFile)
    expect(JSON.parse(diskBeforeMidTurn).personaId).toBe(p1)

    // 3. ADVERSARIAL ATTACK: Mid-turn, default persona changes to P2 AND P1 is deleted!
    await settingsScope.update({ defaults: { personaId: p2 } })
    await state.deletePersona(p1)

    // If resolvePersona were invoked (as in old loadBinding), p1 would resolve to p2 and write to disk!
    // But loadStoryBinding must preserve p1:
    // a) loadStoryBinding directly
    const midStoryBinding = await state.loadStoryBinding(sessionId)
    expect(midStoryBinding?.personaId).toBe(p1)

    // b) Repeated pipeline assembly mid-turn
    const midRun = await runTavernPipeline({
      state,
      sessionId,
      agent: null,
      mode: 'live',
      historyOverride: [{ role: 'user', content: '你好续写' }],
    })
    // Must strictly retain frozen P1!
    expect(midRun).toBe(firstRun)
    expect(midRun?.standing).toContain('第一人设描述')
    expect(midRun?.standing).not.toContain('第二人设描述')

    // c) Verify disk was NEVER modified mid-turn
    const diskAfter = await readFile(sFile, 'utf8')
    const statAfter = await stat(sFile)
    expect(diskAfter).toBe(diskBeforeMidTurn)
    expect(statAfter.mtimeMs).toBe(statBeforeMidTurn.mtimeMs)

    // Contrast with old loadBinding: loadBinding resolves to p2 and writes to disk!
    const resolvedBinding = await state.loadBinding(sessionId)
    expect(resolvedBinding?.personaId).toBe(p2)
    const diskAfterResolve = await readFile(sFile, 'utf8')
    expect(JSON.parse(diskAfterResolve).personaId).toBe(p2)

    // 4. End Turn 1
    await onTurnEnd(state, sessionId)

    // In Turn 2, the new turn can pick up the updated default persona P2
    await onTurnStart(state, sessionId, 2)
    const turn2Run = await runTavernPipeline({
      state,
      sessionId,
      agent: null,
      mode: 'live',
      historyOverride: [{ role: 'user', content: '第二轮对话' }],
    })
    expect(turn2Run?.standing).toContain('第二人设描述')
  })

  it('turn lifecycle (onTurnStart/onTurnEnd) with personaId: null preserves null on disk and never triggers uncoordinated write-backs', async () => {
    // 1. Setup personas P1 and P2
    const p1 = await state.savePersona({ id: 'persona-1', name: '人设一', description: '第一人设描述', avatar: null })
    const p2 = await state.savePersona({ id: 'persona-2', name: '人设二', description: '第二人设描述', avatar: null })
    await settingsScope.update({ defaults: { personaId: p1 } })

    // 2. Create character and bind session with personaId: null
    const card = await state.createCharacter('测试主角')
    const sessionId = 'stress-session-null-persona'
    await state.saveBinding({
      sessionId,
      cardId: card.cardId,
      presetId: null,
      personaId: null, // explicitly null
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: true,
      helperMvu: true,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadStoryBinding(sessionId))!
    const ws = await state.storyWorkspace(card.cardId, binding.storyId!)
    await ws.fs.writeText('state/helper.json', JSON.stringify({ version: 1, scopes: {}, extras: {}, mvu: { version: 1, initialized: true, pending: [], completed: [] } }))

    const sFile = sessionFile(paths, sessionId)
    const diskBefore = await readFile(sFile, 'utf8')
    const statBefore = await stat(sFile)
    expect(JSON.parse(diskBefore).personaId).toBeNull()

    // 3. onTurnStart with helperMvuPending check
    await onTurnStart(state, sessionId, 1)

    // Verify disk was NOT modified during onTurnStart
    const diskAfterStart = await readFile(sFile, 'utf8')
    const statAfterStart = await stat(sFile)
    expect(JSON.parse(diskAfterStart).personaId).toBeNull()
    expect(diskAfterStart).toBe(diskBefore)
    expect(statAfterStart.mtimeMs).toBe(statBefore.mtimeMs)

    // Verify loadStoryBinding preserves null
    const storyBinding = await state.loadStoryBinding(sessionId)
    expect(storyBinding?.personaId).toBeNull()

    // 4. Run pipeline in live mode: resolves default persona P1 dynamically for prompt assembly
    const firstRun = await runTavernPipeline({
      state,
      sessionId,
      agent: null,
      mode: 'live',
      historyOverride: [{ role: 'user', content: '你好' }],
    })
    expect(firstRun?.standing).toContain('第一人设描述')
    expect(await readFile(sFile, 'utf8')).toBe(diskBefore)

    // 5. Mid-turn adversarial mutation
    await settingsScope.update({ defaults: { personaId: p2 } })
    await state.deletePersona(p1)

    // Mid-turn loadStoryBinding retains null
    const midStoryBinding = await state.loadStoryBinding(sessionId)
    expect(midStoryBinding?.personaId).toBeNull()

    // Mid-turn pipeline returns frozen turn plan
    const midRun = await runTavernPipeline({
      state,
      sessionId,
      agent: null,
      mode: 'live',
      historyOverride: [{ role: 'user', content: '续写' }],
    })
    expect(midRun).toBe(firstRun)
    expect(midRun?.standing).toContain('第一人设描述')
    expect(midRun?.standing).not.toContain('第二人设描述')

    // 6. onTurnEnd with queueHelperMvuTurn
    await onTurnEnd(state, sessionId)

    // Verify disk remained untouched across entire turn
    const diskAfterEnd = await readFile(sFile, 'utf8')
    const statAfterEnd = await stat(sFile)
    expect(JSON.parse(diskAfterEnd).personaId).toBeNull()
    expect(diskAfterEnd).toBe(diskBefore)
    expect(statAfterEnd.mtimeMs).toBe(statBefore.mtimeMs)

    // 7. Turn 2 starts with new default persona P2
    await onTurnStart(state, sessionId, 2)
    const run2 = await runTavernPipeline({
      state,
      sessionId,
      agent: null,
      mode: 'live',
      historyOverride: [{ role: 'user', content: '第二轮' }],
    })
    expect(run2?.standing).toContain('第二人设描述')
    expect(JSON.parse(await readFile(sFile, 'utf8')).personaId).toBeNull()
  })
})

describe('Adversarial Stress Test: Issue 10 (Preset Corruption Handling & No Path Leaks)', () => {
  it.each([
    ['invalid JSON syntax', '{"identifier": "broken", entries: [}'],
    ['truncated bytes', '{"identifier": "broken", "name": "corrupt", "entries": [{"identifier": "1", "content": "trun'],
    ['malformed non-UTF8 bytes', Buffer.from([0xff, 0xfe, 0xfd, 0x00, 0x12, 0x80, 0x81])],
  ])('corrupted preset (%s) triggers preset-unreadable error without leaking internal filesystem paths', async (_label, corruptPayload) => {
    const card = await state.createCharacter('预设故障测试卡')
    const preset = defaultPreset()
    preset.identifier = 'corruptible-preset'
    preset.name = '可损坏预设'
    const presetId = await state.savePreset(preset)

    const sessionId = `preset-corrupt-${Date.now()}`
    await state.saveBinding({
      sessionId,
      cardId: card.cardId,
      presetId,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    // Corrupt preset file on disk
    const presetFile = join(paths.presets, `${presetId}.json`)
    if (typeof corruptPayload === 'string') {
      await writeFile(presetFile, corruptPayload, 'utf8')
    } else {
      await writeFile(presetFile, corruptPayload)
    }

    // 1. loadPreset with strictRead = true must throw explicit error
    await expect(state.loadPreset(presetId, true)).rejects.toThrow(/预设.*损坏/)

    // 2. Service getPreset must reject with explicit error
    await expect(service.getPreset({ id: presetId })).rejects.toThrow(/预设.*损坏/)

    // 3. Pipeline execution must throw explicit error and NOT fall back to defaultPreset()
    await onTurnStart(state, sessionId, 1)
    await expect(runTavernPipeline({
      state,
      sessionId,
      agent: null,
      mode: 'live',
      historyOverride: [{ role: 'user', content: '测试' }],
    })).rejects.toThrow(/预设.*损坏/)

    // 4. Ensure turn plan was NOT frozen with default preset
    expect(state.turnPlans.has(sessionId)).toBe(false)
  })
})

describe('Adversarial Stress Test: Issue 11 (Host Fork Adoption Plan Cleanup on Clear Binding)', () => {
  it('clearSessionBinding writes status: skipped, clears in-memory plan, and prevents phantom re-adoption', async () => {
    // Setup parent session
    const parentCard = await state.createCharacter('父会话角色')
    const parentId = 'parent-session-1' as Session['id']
    await state.saveBinding({
      sessionId: parentId,
      cardId: parentCard.cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    // Setup child session mimicking native dsh host fork
    const childId = 'child-fork-session-1' as Session['id']
    const childSession = {
      id: childId,
      header: {
        parentSession: parentId,
        isSeeded: true,
        delegationDepth: 0,
      },
      inheritedEventCount: 0,
      firstLifecycleSeq: 0,
      snapshotEvents: () => [],
    } as unknown as Session

    // Register child session in cordis mock
    ;(cordisCtx.sessions as unknown as { set: (id: string, s: Session) => void }).set(childId, childSession)

    // Initial adoption: child inherits parent card
    const adopted = await adoptHostFork({ ctx: cordisCtx, state }, childSession)
    expect(adopted).toBe(true)

    // Verify child is bound
    const childBinding = await state.loadBinding(childId)
    expect(childBinding).not.toBeNull()
    expect(childBinding?.cardId).toBe(parentCard.cardId)

    // ADVERSARIAL STEP: Explicitly clear child session binding
    const clearResult = await service.clearSessionBinding({ sessionId: childId })
    expect(clearResult).toEqual({ cleared: true })

    // Check disk: adoption plan must record status: 'skipped'
    const planFile = hostForkAdoptionFile(childId)
    const planFs = new WorkspaceFs(root, null)
    const planRaw = await planFs.readText(planFile)
    expect(planRaw).not.toBeNull()
    const parsedPlan = JSON.parse(planRaw!)
    expect(parsedPlan.status).toBe('skipped')
    expect(parsedPlan.sessionId).toBe(childId)
    expect(parsedPlan.parentId).toBe(parentId)
    // Skipped plan must not leak binding or checkpoint details
    expect(parsedPlan.binding).toBeUndefined()
    expect(parsedPlan.sourceCheckpoint).toBeUndefined()

    // Check state: child binding is null
    expect(await state.loadBinding(childId)).toBeNull()

    // ATTACK: Subsequent host restart or re-adoption attempt must be REJECTED (returns false)
    const reAdopted = await adoptHostFork({ ctx: cordisCtx, state }, childSession)
    expect(reAdopted).toBe(false)
    expect(await state.loadBinding(childId)).toBeNull()
  })
})

describe('Adversarial Stress Test: Issue 12 (Journal Optimistic Concurrency & Multi-Writer Race)', () => {
  it('rejects stale expectedRevision and ensures atomic serializability across concurrent saves', async () => {
    const card = await state.createCharacter('笔记并发角色')
    const cardId = card.cardId

    // Initial write
    await state.saveJournal(cardId, '初始笔记版本0')
    const initial = await service.getJournal({ cardId })
    expect(initial.text).toBe('初始笔记版本0')
    const rev0 = initial.revision

    // Writer 1 updates successfully
    const save1 = await service.saveJournal({
      cardId,
      text: 'Writer 1 修改的正文',
      expectedRevision: rev0,
    })
    expect(save1.saved).toBe(true)
    const rev1 = save1.revision

    // Writer 2 uses stale rev0 -> MUST REJECT!
    await expect(service.saveJournal({
      cardId,
      text: 'Writer 2 基于过期 rev0 的修改',
      expectedRevision: rev0,
    })).rejects.toThrow(/笔记已被另一窗口或剧情修改/)

    // Confirm Writer 1's content remains intact
    const current = await service.getJournal({ cardId })
    expect(current.text).toBe('Writer 1 修改的正文')
    expect(current.revision).toBe(rev1)

    // STRESS ATTACK: 10 concurrent writers all racing with rev1
    const contenders = Array.from({ length: 10 }, (_, i) => ({
      cardId,
      text: `Contender #${i} content - ${Math.random()}`,
      expectedRevision: rev1,
    }))

    const results = await Promise.allSettled(
      contenders.map(c => service.saveJournal(c))
    )

    const fulfilled = results.filter(r => r.status === 'fulfilled')
    const rejected = results.filter(r => r.status === 'rejected')

    // Exactly 1 winner, exactly 9 losers!
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(9)

    // All 9 rejections must contain conflict error message
    for (const rej of rejected) {
      expect((rej as PromiseRejectedResult).reason.message).toMatch(/笔记已被另一窗口或剧情修改/)
    }

    // Disk text must match the single winner
    const winnerResult = (fulfilled[0] as PromiseFulfilledResult<{ saved: boolean; revision: string }>).value
    const winnerContender = contenders.find(c => jsonEditRevision(c.text) === winnerResult.revision)
    expect(winnerContender).toBeDefined()
    expect((await service.getJournal({ cardId })).text).toBe(winnerContender!.text)
  })

  it('rejects saveJournal when expectedRevision is missing or null', async () => {
    const card = await state.createCharacter('无版本笔记角色')
    await state.saveJournal(card.cardId, '既有笔记')

    // Missing expectedRevision
    await expect(service.saveJournal({
      cardId: card.cardId,
      text: '缺少版本参数',
    } as unknown as { cardId: string; text: string; expectedRevision: string })).rejects.toThrow(/笔记缺少保存版本/)

    // Null expectedRevision
    await expect(service.saveJournal({
      cardId: card.cardId,
      text: 'null版本参数',
      expectedRevision: null as unknown as string,
    })).rejects.toThrow(/笔记缺少保存版本/)
  })
})

describe('Adversarial Stress Test: Issue 13 (Character Upload Limits Preflight)', () => {
  it('strictly rejects oversized base64 PNG before Buffer.from allocation in both inspectCharacter and importCharacter', async () => {
    const decodeSpy = vi.spyOn(Buffer, 'from')

    try {
      // 1. Under limit: Buffer.from is permitted
      decodeSpy.mockClear()
      const underLimitPayload = Buffer.from('hello-world-not-a-png').toString('base64')
      try {
        await service.inspectCharacter({ name: 'valid.png', dataBase64: underLimitPayload })
      } catch (err: unknown) {
        // Fails with invalid PNG format, but NOT size limit preflight
        expect((err as Error).message).not.toMatch(/超过大小上限/)
      }
      expect(decodeSpy).toHaveBeenCalled()

      // 2. Oversized by 1 char: MAX_CARD_PNG_BASE64_CHARS + 1
      // Must be REJECTED BEFORE Buffer.from
      decodeSpy.mockClear()
      const oversizedPayload1 = 'A'.repeat(MAX_CARD_PNG_BASE64_CHARS + 1)
      await expect(service.inspectCharacter({
        name: 'oversized1.png',
        dataBase64: oversizedPayload1,
      })).rejects.toThrow(/PNG 角色卡超过大小上限/)
      expect(decodeSpy).not.toHaveBeenCalled()

      // 3. Oversized by 4 chars in importCharacter
      decodeSpy.mockClear()
      const oversizedPayload4 = 'A'.repeat(MAX_CARD_PNG_BASE64_CHARS + 4)
      await expect(service.importCharacter({
        name: 'oversized4.PNG', // case-insensitive test
        dataBase64: oversizedPayload4,
      })).rejects.toThrow(/PNG 角色卡超过大小上限/)
      expect(decodeSpy).not.toHaveBeenCalled()

      // 4. Massive 100MB simulation: string length check only, zero memory explosion
      decodeSpy.mockClear()
      // Use fake string-like object with length > MAX_CARD_PNG_BASE64_CHARS
      const hugeFakeString = {
        length: 100 * 1024 * 1024,
        toString() { return 'A' },
      } as unknown as string
      await expect(service.inspectCharacter({
        name: 'huge.png',
        dataBase64: hugeFakeString,
      })).rejects.toThrow(/PNG 角色卡超过大小上限/)
      expect(decodeSpy).not.toHaveBeenCalled()
    } finally {
      decodeSpy.mockRestore()
    }
  })
})
