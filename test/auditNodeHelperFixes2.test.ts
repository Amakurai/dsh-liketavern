/**
 * Node 宿主编排与酒馆助手桥接第二轮缺陷修复回归测试（H1–H6）：
 * - H1: onTurnStart 使用 helperMvuInitAnchorTurn，以 Turn 0 开场白为锚点排队 MVU 初始化而不漏放空白开场
 * - H2: inheritedThroughTurn / forkAt / adoptHostFork 保留 Turn 0 (#t0) 到 walLineage 并通过完整性校验
 * - H3: agent/pre-step 拒绝复用上一轮过期 turnPlans；onTurnEnd 异常失败后 clearBinding 立即清理运行时
 * - H4: helperWorldbookOperation 更新内嵌角色书 @dsh/character 时保留原有世界书名而非覆写为内部哨兵
 * - H5: TavernService saveMemory/deleteMemory/compressMemories/revokeWorldDelta 对不存在的 cardId 抛 card-not-found 且不建空目录
 * - H6: rebindHelperWorldbooks 在 saveBinding 成功后才推进卡面租约绑定，失败时保留原租约校验基准
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage, LlmRuntime } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply as applyAgent } from '../src/agent.js'
import { resolveConfig } from '../src/node/config.js'
import { adoptHostFork, editUserMessage, inheritedThroughTurn } from '../src/node/floors.js'
import { helperMvuInitAnchorTurn } from '../src/node/helperMvuLifecycle.js'
import { closeHelperFrame, helperFrameWriteGuard, openHelperFrame } from '../src/node/helperFrameLease.js'
import { helperWorldbookOperation, rebindHelperWorldbooks } from '../src/node/helperWorldbook.js'
import { PRESET_ADAPTER_PROVIDER } from '../src/node/presetAdapter.js'
import { assertWalLineageComplete } from '../src/node/sessionArchiveWal.js'
import { TavernService } from '../src/node/service.js'
import { isTurnDeferred, onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { TAVERN_GREETING_SOURCE } from '../src/core/greetingLog.js'
import { HELPER_CHARACTER_WORLDBOOK } from '../src/core/helperWorldbook.js'
import { newStoryId, snapshotStory } from '../src/state/story.js'
import { importCard } from '../src/state/workspace.js'

let root: string
let state: TavernState

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-node-audit2-'))
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
    () => resolveConfig({ interactiveCards: true, mvu: { autoEnable: true } }),
  )
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function setupCardAndStory(sessionId: string) {
  const { cardId } = await importCard(join(root, 'characters'), {
    spec: 'chara_card_v2',
    name: 'HostAuditCard',
    description: 'desc',
    personality: 'pers',
    scenario: 'scen',
    firstMes: '开场白文本',
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    alternateGreetings: ['备用开场'],
    tags: [],
    creator: 'tester',
    characterVersion: '1',
    regexScripts: [],
    characterBook: {
      name: 'OriginalEmbeddedBook',
      entries: [{ keys: ['k'], content: 'v', enabled: true, insertion_order: 100 }],
    },
    extensions: {},
  })
  const storyId = newStoryId()
  await snapshotStory({ cardRoot: join(root, 'characters', cardId), sourceRoot: join(root, 'characters', cardId), id: storyId, sessionId })
  const binding = {
    sessionId,
    cardId,
    storyId,
    presetId: null,
    personaId: null,
    characterLorebookId: null,
    lorebookIds: [],
    interactiveCards: null,
    greetingIndex: 0,
    worldInfo: {},
    authorNote: '',
    injectJournal: false,
    helperMvu: true,
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  await state.saveBinding(binding)
  return { cardId, storyId, binding }
}

describe('Node 与 Helper 桥接第二轮缺陷修复回归 (H1–H6)', () => {
  it('H1: onTurnStart 以 Turn 0 开场白作 MVU 初始化锚点，空历史不误挂起而开场白挂起等待初始化', async () => {
    const sid = SessionId('sess-h1')
    await setupCardAndStory(sid)

    const emptySession = { id: sid, snapshotEvents: () => [] as SessionEvent[] }
    await onTurnStart(state, sid, 1, emptySession)
    expect(isTurnDeferred(state, sid, 1)).toBe(false)
    state.openFloors.delete(sid)

    const sidGreeting = SessionId('sess-h1-greet')
    const { cardId, storyId } = await setupCardAndStory(sidGreeting)
    const ws = await state.storyWorkspace(cardId, storyId)
    await ws.fs.writeText('state/helper.json', JSON.stringify({ version: 1, scopes: {} }))
    const lib = await state.getHelperScriptLibrary({ type: 'character', cardId })
    await state.saveHelperScriptLibrary({ type: 'character', cardId }, lib.revision, [
      {
        type: 'script',
        id: 'm1',
        name: 'MVU',
        enabled: true,
        content: 'mag_variable_initialized initVar MVU',
        info: '',
        button: { enabled: false, buttons: [] },
        data: {},
        export_with: { data: true, button: true },
      },
    ])
    const greetEvents: SessionEvent[] = [
      {
        type: 'assistant/message',
        seq: 0,
        time: 1,
        data: {
          turn: 0,
          message: createAssistantMessage({ source: TAVERN_GREETING_SOURCE, content: [{ type: 'text', text: '开场白欢迎' }] }),
        },
      } as SessionEvent,
    ]
    expect(helperMvuInitAnchorTurn({ id: sidGreeting, snapshotEvents: () => greetEvents })).toBe(0)
    await onTurnStart(state, sidGreeting, 1, { id: sidGreeting, snapshotEvents: () => greetEvents })
    expect(isTurnDeferred(state, sidGreeting, 1)).toBe(true)
  })

  it('H2: inheritedThroughTurn / forkAt / adoptHostFork 保留 #t0 到 walLineage 并通过完整性校验', async () => {
    const greetingMsg = createAssistantMessage({ source: TAVERN_GREETING_SOURCE, content: [{ type: 'text', text: '开场白' }] })
    const greetingEvent = { type: 'assistant/message', seq: 0, time: 1, data: { turn: 0, message: greetingMsg } } as SessionEvent
    expect(inheritedThroughTurn([greetingEvent])).toBe(0)

    const parentId = SessionId('sess-h2-parent')
    const { cardId, storyId } = await setupCardAndStory(parentId)
    const ws = await state.storyWorkspace(cardId, storyId)
    await ws.wal.beginFloor(`${parentId}#t0`)
    await ws.fs.withFloor(`${parentId}#t0`).writeText('journal.md', 't0 note')
    await ws.wal.commitFloor(`${parentId}#t0`)

    const ctx = new Context()
    const events: SessionEvent[] = [greetingEvent]
    const parentSession = {
      id: parentId,
      header: { id: parentId, isSeeded: false },
      snapshotEvents: () => events,
      requestHeader: () => ({ config: { provider: 'mock', model: 'm1' } }),
    }
    const childId = SessionId('sess-h2-child')
    const childMeta = {
      id: childId,
      header: { id: childId, isSeeded: true, parentSession: parentId },
      inheritedEventCount: 1,
      firstLifecycleSeq: 1,
      snapshotEvents: () => events,
    }
    ctx.provide('sessions', {
      get: (id: string) => (id === parentId ? parentSession : id === childId ? childMeta : undefined),
    } as never)
    ctx.provide('sessionPersistence', {
      open: async () => ({
        header: parentSession.header,
        inheritedEventCount: 0,
        read: async () => ({ events }),
        close: async () => {},
      }),
    } as never)
    const adopted = await adoptHostFork({ ctx, state }, childMeta as unknown as Session)
    expect(adopted).toBe(true)
    const childBinding = await state.loadBinding(childId)
    expect(childBinding?.walLineage).toEqual([{ sessionId: parentId, throughTurn: 0 }])
    const childWs = await state.storyWorkspace(cardId, childBinding!.storyId!)
    const activeFloors = (await childWs.wal.listFloors()).filter((f) => !f.rolledBack).map((f) => f.floor)
    expect(activeFloors).toEqual([`${parentId}#t0`])
    expect(() => assertWalLineageComplete(activeFloors, childBinding!, childId)).not.toThrow()

    // 验证 editUserMessage 在 Turn 1 回退并 fork 时同样保留 #t0 到 walLineage：
    const editParentId = SessionId('sess-h2-edit-parent')
    const { cardId: editCardId, storyId: editStoryId } = await setupCardAndStory(editParentId)
    const editWs = await state.storyWorkspace(editCardId, editStoryId)
    await editWs.wal.beginFloor(`${editParentId}#t0`)
    await editWs.fs.withFloor(`${editParentId}#t0`).writeText('journal.md', 't0 edit note')
    await editWs.wal.commitFloor(`${editParentId}#t0`)
    await editWs.wal.beginFloor(`${editParentId}#t1`)
    await editWs.fs.withFloor(`${editParentId}#t1`).writeText('journal.md', 't1 note')
    await editWs.wal.commitFloor(`${editParentId}#t1`)

    const t1UserMsg = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] })
    const t1AsstMsg = createAssistantMessage({ source: { provider: 'mock', model: 'm' }, content: [{ type: 'text', text: 'hi' }] })
    const editEvents: SessionEvent[] = [
      greetingEvent,
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } } as SessionEvent,
      { type: 'user/message', seq: 2, time: 3, data: t1UserMsg } as SessionEvent,
      { type: 'assistant/message', seq: 3, time: 4, data: { turn: 1, message: t1AsstMsg, stopReason: 'stop' } } as SessionEvent,
      { type: 'turn/end', seq: 4, time: 5, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent,
    ]
    const editChildId = SessionId('session-00000000-0000-4000-8000-000000000001')
    const ctxEdit = new Context()
    ctxEdit.provide('agentPresets', {
      composedPreset: () => 'tavern',
      resolve: async () => ({ id: 'tavern' }),
      mount: async () => {},
    } as never)
    ctxEdit.provide('agents', {
      get: () => ({ options: { provider: 'mock', model: 'm' }, ctx: {}, followup: vi.fn(async () => {}), inbox: { push: async () => {} } }),
      withoutInitiator: (fn: () => unknown) => fn(),
      create: async () => ({ dispose: async () => {} }),
    } as never)
    const editParentSession = {
      id: editParentId,
      seq: 4,
      header: { version: 1, id: editParentId, createdAt: new Date(0).toISOString(), agentPreset: 'tavern' },
      snapshotEvents: () => editEvents,
      requestHeader: () => ({ config: { provider: 'mock', model: 'm' } }),
    }
    ctxEdit.provide('sessions', {
      get: (id: string) =>
        id === editParentId
          ? editParentSession
          : id === editChildId
            ? { id: editChildId, inbox: { push: async () => {} } }
            : undefined,
    } as never)
    ctxEdit.provide('workspaceRegistry', { list: () => [{ sessionIds: [editParentId], attachSession: async () => {} }] } as never)
    const editResult = await editUserMessage({ ctx: ctxEdit, state }, editParentId, t1AsstMsg.id, 'edited user')
    const editedBinding = await state.loadBinding(editResult.childSessionId)
    expect(editedBinding?.walLineage).toEqual([{ sessionId: editParentId, throughTurn: 0 }])
  })

  it('H3: agent/pre-step 不复用过期轮次 turnPlans；endedWithError 楼层在 clearBinding 时直接清内存态', async () => {
    const sid = SessionId('sess-h3')
    await setupCardAndStory(sid)
    const ctx = new Context()
    new SessionStore(ctx)
    new AgentRegistry(ctx)
    new SystemPrompt(ctx, {})
    new ToolRuntime(ctx)
    new LlmRuntime(ctx)
    state.presetAdapter = {} as never
    new TavernService(ctx, state)
    const preStepHandlers: Array<(payload: unknown, next: () => Promise<unknown>) => Promise<unknown>> = []
    const origOn = ctx.on.bind(ctx)
    ctx.on = ((event: string, fn: (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>, opts?: unknown) => {
      if (event === 'agent/pre-step') preStepHandlers.push(fn)
      return origOn(event as never, fn as never, opts as never)
    }) as never
    applyAgent(ctx, {} as never)

    // 放入 turn 1 的计划，却发来 turn 2 的 pre-step，不得附加 turn 1 的 PRESET_PLAN_MARKER。
    state.turnPlans.set(sid, {
      turn: 1,
      cardId: 'c1',
      result: {
        messages: [],
        system: '',
        standing: '',
        standingKey: 'k',
        turnContext: '',
        sampling: {},
        activatedWi: [],
        logLines: [],
        stats: { wiCount: 0, wiDropped: 0, memoryCount: 0, tokensAfter: 0 },
        layout: { mode: 'st', entries: [] } as never,
      },
    })
    const inputMsg = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'turn 2 prompt' }] })
    const out = (await preStepHandlers[0]!(
      { agent: { id: sid, options: { provider: PRESET_ADAPTER_PROVIDER }, session: { snapshotEvents: () => [] } }, turn: 2, step: 1, messages: [inputMsg] },
      async () => ({ kind: 'enter', messages: [inputMsg] }),
    )) as { kind: string; messages: Array<{ metadata?: unknown }> }
    expect(out.kind).toBe('enter')
    expect(out.messages[0]?.metadata).toBeUndefined()

    // 验证 onTurnEnd 失败后 clearBinding 不会只设 pendingRuntimeClear，而是直接清除 openFloors/turnPlans：
    const sidErr = SessionId('sess-h3-err')
    const { cardId, storyId } = await setupCardAndStory(sidErr)
    await onTurnStart(state, sidErr, 1, { id: sidErr, snapshotEvents: () => [] })
    const ws = await state.storyWorkspace(cardId, storyId)
    const walDirs = await readdir(join(ws.fs.root, 'state/wal'), { withFileTypes: true })
    const floorDirName = walDirs.find((d) => d.isDirectory())!.name
    await rm(join(ws.fs.root, 'state/wal', floorDirName, 'meta.json'))
    await expect(
      onTurnEnd(state, sidErr, {
        id: sidErr,
        snapshotEvents: () => [
          { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } } as SessionEvent,
        ],
      }),
    ).rejects.toThrow()
    expect(state.openFloors.get(sidErr)?.endedWithError).toBe(true)

    await state.clearBinding(sidErr)
    expect(state.openFloors.has(sidErr)).toBe(false)
    expect(state.pendingRuntimeClear.has(sidErr)).toBe(false)
  })

  it('H4 & H6: 内嵌世界书保留原名而不写为 @dsh/character，且 rebindHelperWorldbooks 先写后推进租约', async () => {
    const sid = SessionId('sess-h46')
    const { cardId, storyId } = await setupCardAndStory(sid)
    const ctx = new Context()
    const events: SessionEvent[] = [
      {
        type: 'assistant/message',
        seq: 0,
        time: 1,
        data: { turn: 0, message: createAssistantMessage({ source: TAVERN_GREETING_SOURCE, content: [{ type: 'text', text: '开场白' }] }) },
      } as SessionEvent,
    ]
    ctx.provide('sessions', {
      get: () => ({ id: sid, snapshotEvents: () => events, flush: async () => {} }),
    } as never)

    // H4: helperWorldbookOperation 更新内嵌世界书时保留 OriginalEmbeddedBook 名称。
    const got = await helperWorldbookOperation(ctx, state, sid, 0, {
      storyId,
      name: HELPER_CHARACTER_WORLDBOOK,
      operation: 'get',
    })
    expect('snapshot' in got).toBe(true)
    const opRes = await helperWorldbookOperation(ctx, state, sid, 0, {
      storyId,
      name: HELPER_CHARACTER_WORLDBOOK,
      operation: 'upsert',
      revision: 'snapshot' in got ? got.snapshot.revision : undefined,
      entries: [{ uid: 1, keys: ['alpha'], content: 'beta', comment: 'c1', enabled: true }],
    })
    expect('snapshot' in opRes).toBe(true)
    const charWs = await state.loadCharacter(cardId)
    expect(charWs?.card.characterBook?.name).toBe('OriginalEmbeddedBook')

    // H6: 先打开租约，随后模拟 saveBinding 抛错，再验证租约绑定基准未前进；成功后才前进。
    const leaseOpen = await openHelperFrame(ctx, state, {
      sessionId: sid,
      storyId,
      messageId: 0,
      frameId: 'frame-h6-01',
      runtimeId: 'rt-1',
      epoch: 1,
    })
    const lease = { frameId: 'frame-h6-01', runtimeId: 'rt-1', epoch: 1, token: leaseOpen.token }
    const guard = helperFrameWriteGuard(state, { sessionId: sid, messageId: 0, storyId }, lease)

    const loreId = await state.saveLorebook('ExtraLore', { name: 'ExtraLore', entries: [] })
    const spySave = vi.spyOn(state, 'saveBinding').mockImplementationOnce(async () => {
      throw new Error('simulated disk failure')
    })
    await expect(
      rebindHelperWorldbooks(ctx, state, sid, 0, { storyId, kind: 'global', selection: [loreId] }, guard),
    ).rejects.toThrow('simulated disk failure')
    spySave.mockRestore()

    // 失败未改变磁盘绑定，也未污染内存租约，第二次合法绑定仍可使用同一 lease 成功完成并推进租约。
    const nextCtx = await rebindHelperWorldbooks(ctx, state, sid, 0, { storyId, kind: 'global', selection: [loreId] }, guard)
    expect(nextCtx.global).toEqual([loreId])
    const latestBinding = (await state.loadStoryBinding(sid))!
    expect(() => guard?.(latestBinding)).not.toThrow()
    closeHelperFrame(state, { sessionId: sid, messageId: 0, frameId: 'frame-h6-01', runtimeId: 'rt-1', epoch: 1, token: lease.token })
  })

  it('H5: saveMemory/deleteMemory/compressMemories/revokeWorldDelta 对缺失 cardId 报错且不创建孤立目录', async () => {
    const ctx = new Context()
    const service = new TavernService(ctx, state)
    const missingCard = 'missing-card-h5'
    await expect(service.saveMemory({ cardId: missingCard, body: 'fact' })).rejects.toThrow(/不存在/)
    await expect(service.deleteMemory({ cardId: missingCard, id: 'm1' })).rejects.toThrow(/不存在/)
    await expect(service.compressMemories({ cardId: missingCard })).rejects.toThrow(/不存在/)
    await expect(service.revokeWorldDelta({ cardId: missingCard, id: 'd1' })).rejects.toThrow(/不存在/)
    expect(existsSync(join(root, 'characters', missingCard))).toBe(false)
  })
})
