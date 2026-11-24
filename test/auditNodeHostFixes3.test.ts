/**
 * Node / Host 编排与契约第三轮缺陷修复回归测试（N1–N10）：
 * - N1 [P0]: 持 sessions 锁路径（helperChatEdits / helperMvu / helperRuntime / state）透传 waitForAdoption=false，并发 session/created 触发 adoptHostFork 不死锁
 * - N2 [P0/P1]: adoptHostFork 快照父剧情前等待 waitForSessionCommits；prepareBranchStory 拒绝未提交保留楼层与未关闭 prepared 模板 generation
 * - N3 [P1]: 空闲记忆维护（压缩与检索别名）按模型能力关闭思考（deepseek-official 回退 off），不可关闭思考的推理模型放宽 maxTokens，且仍严格拒绝 max-tokens 截断
 * - N4 [P1]: helperMvuInitAnchorTurn 与 latestCompletedMvuAssistant 共享同一谓词，非开场白 Turn 0 回复不再永久阻塞会话
 * - N5 [P1]: helperChatEdits 正文编辑分支按目标消息归属楼层升序分批写 WAL，后续回退保留层不误删已保存的 data/extra/pages 且不破坏旧层 WAL 依赖
 * - N6 [P1]: deriveLegacyLineage 复用 inheritedThroughTurn 识别 Turn 0 开场白，旧分支导出通过 assertWalLineageComplete
 * - N7 [P2]: agent/pre-step 的 dropStaleTurnNotices 在 step=1 且 claimed 为空时不再误清空内层返回的 decision.messages
 * - N8 [P2]: presetRequestProjection 在 messagesApi + in-history 下合并前导连续 system，消除 hostSystem 重复计入 text-budget
 * - N9 [P2]: inspectCharacter / importCharacter（service / state / remote）在解码与 JSON.parse 之前拦截超限非 PNG（JSON）角色卡上传
 * - N10 [P1]: remote.ts saveCharacter.depthPrompt.depth 仅接受非负安全整数且校验 role 枚举
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  LlmRuntime,
  type GenerateOptions,
  type LlmResolvedModelInfo,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply as applyAgent } from '../src/agent.js'
import { MAX_CARD_PNG_BASE64_CHARS } from '../src/core/cardLimits.js'
import { BOUND_DISCIPLINE, formatTurnStepNotice, TURN_PLAYBOOK } from '../src/core/dshPrompt.js'
import { TAVERN_GREETING_SOURCE } from '../src/core/greetingLog.js'
import { estimateTokens } from '../src/core/tokenize.js'
import { resolveConfig } from '../src/node/config.js'
import { adoptHostFork, FloorError, rollbackToFloor } from '../src/node/floors.js'
import { editHelperMessages } from '../src/node/helperChatEdits.js'
import {
  commitHelperMvuJob,
  ensureHelperMvuScriptAnchor,
  latestCompletedMvuAssistant,
  prepareHelperMvuJob,
  queueHelperMvuTurn,
} from '../src/node/helperMvu.js'
import { helperMvuInitAnchorTurn } from '../src/node/helperMvuLifecycle.js'
import { getHelperSnapshot } from '../src/node/helperRuntime.js'
import { compressMemoryBatch, registerMemoryMaintenance } from '../src/node/memoryMaintenance.js'
import {
  attachPresetPlanMessage,
  projectPresetRequest,
  type PresetProjectionDiagnostic,
  type PresetRequestPlan,
} from '../src/node/presetRequestProjection.js'
import { TavernService } from '../src/node/service.js'
import { deriveLegacyLineage } from '../src/node/sessionArchiveSnapshot.js'
import { assertWalLineageComplete } from '../src/node/sessionArchiveWal.js'
import { isTurnDeferred, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { TYPERT_REMOTE } from '../src/remote.js'
import { loadHelperState } from '../src/state/helper.js'
import { newStoryId, snapshotStory } from '../src/state/story.js'
import { loadTemplateGenerationIdentity, saveTemplateMetadata } from '../src/state/template.js'
import { importCard } from '../src/state/workspace.js'
import { withWorkspaceLock } from '../src/state/workspaceLock.js'

let root: string
let state: TavernState

function makePaths(base: string) {
  return {
    root: base,
    characters: join(base, 'characters'),
    lorebooks: join(base, 'library/lorebooks'),
    presets: join(base, 'library/presets'),
    personas: join(base, 'personas'),
    regexDir: join(base, 'regex'),
    sessions: join(base, 'sessions'),
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-node-audit3-'))
  state = new TavernState(makePaths(root), () => resolveConfig({ interactiveCards: true }))
  await state.init()
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function setupCardAndStory(sessionId: string, opts: { helperMvu?: boolean } = {}) {
  const { cardId } = await importCard(join(root, 'characters'), {
    spec: 'chara_card_v2',
    name: 'AuditCard3',
    description: 'desc',
    personality: 'pers',
    scenario: 'scen',
    firstMes: '开场白',
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    alternateGreetings: [],
    tags: [],
    creator: 'tester',
    characterVersion: '1',
    regexScripts: [],
    extensions: {},
  })
  const storyId = newStoryId()
  await snapshotStory({
    cardRoot: join(root, 'characters', cardId),
    sourceRoot: join(root, 'characters', cardId),
    id: storyId,
    sessionId,
  })
  const binding = {
    sessionId,
    cardId,
    storyId,
    presetId: null,
    personaId: null,
    characterLorebookId: null,
    lorebookIds: [],
    interactiveCards: true,
    greetingIndex: 0,
    ...(opts.helperMvu !== undefined ? { helperMvu: opts.helperMvu } : {}),
    createdAt: '2026-01-01T00:00:00.000Z',
  }
  await state.saveBinding(binding)
  return { cardId, storyId, binding }
}

function normalStopStream(text: string) {
  return [
    { type: 'chunk' as const, chunk: { type: 'text-delta' as const, index: 0, text } },
    { type: 'chunk' as const, chunk: { type: 'finish' as const, reason: { kind: 'stop' as const } } },
  ]
}

function appendCompletedTurn(session: Session, turn: number, userText: string, assistantText: string) {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  const userMsg = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: userText }] })
  const userEv = session.append('user/message', userMsg, { surfaceOp: 'append' })
  const assistantMsg = createAssistantMessage({
    source: { provider: 'factory', model: 'factory' },
    content: [{ type: 'text', text: assistantText }],
  })
  const assistantEv = session.append(
    'assistant/message',
    { turn, step: 1, message: assistantMsg, stream: normalStopStream(assistantText) },
    { surfaceOp: 'append' },
  )
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return { userEv, assistantEv }
}

function makePreparedGeneration(sessionId: string, cardId: string, storyId: string, turn: number) {
  const emptyScopes = { global: {}, local: {}, message: {} }
  const zeroHash = '0'.repeat(64)
  return {
    version: 1 as const,
    status: 'prepared' as const,
    sessionId,
    cardId,
    storyId,
    turn,
    floor: `${sessionId}#t${turn}`,
    replay: {
      version: 2 as const,
      context: {
        variables: emptyScopes,
        char: 'AuditCard3',
        user: '用户',
        card: {},
        entries: [],
        presets: [],
        history: [],
        now: 1,
        seed: 1,
        phase: 'generate' as const,
        sessionId,
        cardId,
      },
      variables: emptyScopes,
      messageVariablesHash: zeroHash,
      operations: [],
    },
    regexRules: [],
    hasMessageRegex: false,
    plan: {
      standingKey: 'k',
      sampling: { temperature: 1, topP: 1, maxTokens: null, stop: [], frequencyPenalty: 0, presencePenalty: 0, thinking: 'enabled' as const },
      standing: '',
      turnContext: '',
      messages: [],
      cacheFirstLayout: false,
      history: [],
      logLines: [],
      userName: '用户',
      personaDescription: '',
      personaLorebookId: null,
      wiBudget: { limit: 100, used: 0, overflowed: false },
      assembleLog: [],
      stats: { tokensBefore: 0, tokensAfter: 0, trimmedSections: [] },
    },
  }
}

function makeSeededChild(childId: Session['id'], parentId: Session['id'], seedEvents: readonly SessionEvent[] = []): Session {
  return Session.fromRestore(
    childId,
    seedEvents,
    { ...Session.create(childId).header, isSeeded: true, parentSession: parentId },
    seedEvents.length as never,
    'shared-frozen',
  )
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（疑似死锁）`)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

describe('Node / Host 编排与契约第三轮缺陷修复回归 (N1–N10)', () => {
  it('N1 [P0]: 持 sessions 锁期间并发触发 adoptHostFork，helperChatEdits 与 helperMvu 全路径无 AB/BA 死锁', async () => {
    const ctx = new Context()
    new SessionStore(ctx)
    const parentId = SessionId('sess-n1-parent')
    const childId = SessionId('sess-n1-child')
    const { cardId, storyId } = await setupCardAndStory(childId, { helperMvu: true })
    const ws = await state.storyWorkspace(cardId, storyId)

    const child = makeSeededChild(childId, parentId, [])
    const greet = child.append(
      'assistant/message',
      {
        turn: 0,
        step: 0,
        message: createAssistantMessage({ source: TAVERN_GREETING_SOURCE, content: [{ type: 'text', text: '开场白' }] }),
        stream: [],
      },
      { surfaceOp: 'append' },
    )
    const t1 = appendCompletedTurn(child, 1, '你好', '回复一')
    vi.spyOn(ctx.sessions, 'get').mockImplementation((id) => (id === childId ? child : undefined))

    await ws.wal.beginFloor(`${childId}#t0`)
    await ws.fs.withFloor(`${childId}#t0`).writeText('state/helper.json', JSON.stringify({ version: 1, scopes: {} }))
    await ws.wal.commitFloor(`${childId}#t0`)
    await ws.wal.beginFloor(`${childId}#t1`)
    await ws.fs.withFloor(`${childId}#t1`).writeText('journal.md', 'turn1')
    await ws.wal.commitFloor(`${childId}#t1`)

    // 模拟已持 ws.fs.root -> sessions 锁的期间，宿主对同一会话触发 session/created 登记 adoption
    const adoptionHeld = Promise.withResolvers<void>()
    let adoptionPromise!: Promise<void>
    await withTimeout(
      withWorkspaceLock(ws.fs.root, () =>
        withWorkspaceLock(state.paths.sessions, async () => {
          adoptionPromise = state.trackBindingAdoption(childId, async () => {
            adoptionHeld.resolve()
            await adoptHostFork({ ctx, state }, child)
          })
          await adoptionHeld.promise
          // 给 adoptHostFork 机会卡在 state.paths.sessions 锁上
          await Promise.resolve()

          // 1) state.getSessionHelperScripts(waitForAdoption=false) 与 getHelperSnapshot(waitForAdoption=false)
          const scripts = await state.getSessionHelperScripts(childId, storyId, { waitForAdoption: false })
          expect(scripts.storyId).toBe(storyId)
          const snap = await getHelperSnapshot(ctx, state, childId, t1.assistantEv.seq, { waitForAdoption: false })
          expect(snap.storyId).toBe(storyId)

          // 2) ensureHelperMvuScriptAnchor / prepareHelperMvuJob / commitHelperMvuJob / queueHelperMvuTurn
          //    在 locked()/queue() 内再次重入 ws.fs.root -> sessions 锁，不能反等 adoptionPromise
          const anchor = await ensureHelperMvuScriptAnchor(ctx, state, childId, storyId)
          expect(anchor).toBe(t1.assistantEv.seq)
          const work = await prepareHelperMvuJob(ctx, state, { sessionId: childId, storyId, runtimeId: 'rt-n1' })
          expect(work.status).toBe('pending')
          const committed = await commitHelperMvuJob(ctx, state, {
            sessionId: childId,
            storyId,
            runtimeId: 'rt-n1',
            jobId: work.job!.id,
            token: work.token!,
            data: { stat_data: { hp: 100 } },
          })
          expect(committed.status).toBe('idle')
          await queueHelperMvuTurn(state, childId, child)

          // 3) editHelperMessages 仅改元数据（在同锁内调用 assertHelperMvuWritable / getHelperSnapshot / withHelperStoryWrite）
          const beforeSnap = await getHelperSnapshot(ctx, state, childId, greet.seq, { waitForAdoption: false })
          const edited = await editHelperMessages(ctx, state, childId, greet.seq, {
            storyId,
            historyRevision: beforeSnap.historyRevision,
            edits: [{ message_id: 0, extra: { tag: 'ok' } }],
            before: [{ message_id: 0, extra: {} }],
          })
          expect(edited.branch).toBeNull()
          expect(edited.snapshot?.messages[0]?.extra).toEqual({ tag: 'ok' })
        }),
      ),
      3000,
      '持 sessions 锁并发 adoptHostFork',
    )
    await withTimeout(adoptionPromise, 3000, 'adoptHostFork 收尾')
    await ctx.fiber.dispose()
  })

  it('N2a [P0/P1]: adoptHostFork 快照父剧情前等待父会话 waitForSessionCommits，避免复制未提交楼层', async () => {
    const ctx = new Context()
    new SessionStore(ctx)
    const parentId = SessionId('sess-n2a-parent')
    const childId = SessionId('sess-n2a-child')
    const { cardId, storyId } = await setupCardAndStory(parentId)
    const ws = await state.storyWorkspace(cardId, storyId)

    const parent = Session.create(parentId)
    appendCompletedTurn(parent, 1, '用户输入', '助手回复')
    const child = makeSeededChild(childId, parentId, parent.snapshotEvents())
    vi.spyOn(ctx.sessions, 'get').mockImplementation((id) => (id === parentId ? parent : id === childId ? child : undefined))

    // 父会话开启了 #t1 且模板 generation 处于 prepared，模拟异步 onTurnEnd 正在队列中等待完成
    await ws.wal.beginFloor(`${parentId}#t1`)
    await saveTemplateMetadata(ws.fs.withFloor(`${parentId}#t1`), {
      version: 1,
      variables: { global: { flag: 't1' }, local: {}, message: {} },
      wiTimers: {},
      generation: makePreparedGeneration(parentId, cardId, storyId, 1),
    })

    const releaseCommit = Promise.withResolvers<void>()
    const commitQueued = state.enqueueSessionTask(parentId, async () => {
      await releaseCommit.promise
      await saveTemplateMetadata(ws.fs.withFloor(`${parentId}#t1`), {
        version: 1,
        variables: { global: { flag: 't1' }, local: {}, message: {} },
        wiTimers: {},
        generation: {
          version: 1,
          status: 'completed',
          sessionId: parentId,
          cardId,
          storyId,
          turn: 1,
          floor: `${parentId}#t1`,
        },
      })
      await ws.wal.commitFloor(`${parentId}#t1`)
    })

    const adopting = adoptHostFork({ ctx, state }, child)
    // 短暂延迟后再放行父提交，验证 adoptHostFork 确实在等待父提交落定
    await new Promise((r) => setTimeout(r, 30))
    expect(await state.loadBindingUnwaited(childId)).toBeNull()
    releaseCommit.resolve()
    await commitQueued
    expect(await adopting).toBe(true)

    const childBinding = await state.loadBindingUnwaited(childId)
    expect(childBinding?.storyId).toBeTruthy()
    const childWs = await state.storyWorkspace(childBinding!.cardId, childBinding!.storyId)
    const floors = await childWs.wal.listFloors()
    expect(floors.find((f) => f.floor === `${parentId}#t1`)?.committed).toBe(true)
    expect((await loadTemplateGenerationIdentity(childWs.fs))?.status).toBe('completed')
    await ctx.fiber.dispose()
  })

  it('N2b [P0/P1]: prepareBranchStory 拒绝保留未提交 WAL 楼层或未关闭 prepared 模板 generation，修复后可重试接管', async () => {
    const ctx = new Context()
    new SessionStore(ctx)
    const parentId = SessionId('sess-n2b-parent')
    const childId = SessionId('sess-n2b-child')
    const { cardId, storyId } = await setupCardAndStory(parentId)
    const ws = await state.storyWorkspace(cardId, storyId)

    const parent = Session.create(parentId)
    appendCompletedTurn(parent, 1, '问', '答')
    const child = makeSeededChild(childId, parentId, parent.snapshotEvents())
    vi.spyOn(ctx.sessions, 'get').mockImplementation((id) => (id === parentId ? parent : id === childId ? child : undefined))

    // 场景 1：保留楼层 #t1 未提交
    await ws.wal.beginFloor(`${parentId}#t1`)
    await ws.fs.withFloor(`${parentId}#t1`).writeText('journal.md', 'uncommitted')
    await expect(adoptHostFork({ ctx, state }, child)).rejects.toThrow(/尚未提交/)
    expect(await state.loadBindingUnwaited(childId)).toBeNull()

    // 场景 2：#t1 已提交但仍残留 prepared generation
    await saveTemplateMetadata(ws.fs.withFloor(`${parentId}#t1`), {
      version: 1,
      variables: { global: {}, local: {}, message: {} },
      wiTimers: {},
      generation: makePreparedGeneration(parentId, cardId, storyId, 1),
    })
    await ws.wal.commitFloor(`${parentId}#t1`)
    await expect(adoptHostFork({ ctx, state }, child)).rejects.toThrow(/未收口的模板生成楼层/)
    expect(await state.loadBindingUnwaited(childId)).toBeNull()

    // 恢复为 completed 后重试接管成功
    await ws.wal.reopenFloor(`${parentId}#t1`)
    await saveTemplateMetadata(ws.fs.withFloor(`${parentId}#t1`), {
      version: 1,
      variables: { global: {}, local: {}, message: {} },
      wiTimers: {},
    })
    await ws.wal.commitFloor(`${parentId}#t1`)
    expect(await adoptHostFork({ ctx, state }, child)).toBe(true)
    expect(await state.loadBindingUnwaited(childId)).not.toBeNull()
    await ctx.fiber.dispose()
  })

  it('N3 [P1]: 空闲记忆维护对 deepseek-official 关闭思考，对不可关思考模型放宽 maxTokens，且严格拒绝 max-tokens 截断', async () => {
    const calls: GenerateOptions[] = []
    const makeLlm = (
      resolveInfo: () => Promise<Partial<LlmResolvedModelInfo>>,
      finishKind: 'stop' | 'max-tokens' = 'stop',
    ) =>
      ({
        resolveModelInfo: vi.fn(async () => resolveInfo()),
        async *stream(options: GenerateOptions) {
          calls.push(options)
          yield { type: 'text-delta' as const, index: 0, text: '合并后的记忆正文' }
          yield { type: 'finish' as const, reason: { kind: finishKind } }
        },
      }) as unknown as LlmRuntime

    // 1) deepseek-official 公布含 off 档 -> 显式传 reasoningEffort: 'off'，保留 maxTokens=1024
    const officialLlm = makeLlm(async () => ({
      reasoning: { efforts: [{ id: 'off' }, { id: 'high' }], defaultEffort: 'high' },
    }))
    const mergedOfficial = await compressMemoryBatch(officialLlm, 'deepseek-official', 'deepseek-flash', ['记忆 A', '记忆 B'])
    expect(mergedOfficial).toBe('合并后的记忆正文')
    expect(calls.at(-1)?.reasoningEffort).toBe('off')
    expect(calls.at(-1)?.maxTokens).toBe(1024)

    // 2) deepseek-official 元数据解析失败 -> 仍回退 reasoningEffort: 'off'
    const fallbackLlm = makeLlm(async () => { throw new Error('metadata offline') })
    expect(await compressMemoryBatch(fallbackLlm, 'deepseek-official', 'deepseek-v4-pro', ['记忆 A'])).toBe('合并后的记忆正文')
    expect(calls.at(-1)?.reasoningEffort).toBe('off')

    // 3) 仅公布非 off 档的强制推理模型 -> 不乱传 off，且放宽 maxTokens >= 8192
    const forcedLlm = makeLlm(async () => ({
      reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' },
    }))
    expect(await compressMemoryBatch(forcedLlm, 'custom-reasoner', 'r1', ['记忆 A'])).toBe('合并后的记忆正文')
    expect(calls.at(-1)?.reasoningEffort).toBeUndefined()
    expect(calls.at(-1)?.maxTokens).toBeGreaterThanOrEqual(8192)

    // 4) 仍遵守边界 4：遇到 max-tokens 截断返回 null
    const truncatedLlm = makeLlm(async () => ({}), 'max-tokens')
    expect(await compressMemoryBatch(truncatedLlm, 'deepseek-official', 'deepseek-flash', ['记忆 A'])).toBeNull()

    // 5) 别名补全同样在 deepseek-official 上关闭思考
    const aliasCalls: GenerateOptions[] = []
    const aliasState = new TavernState(makePaths(await mkdtemp(join(tmpdir(), 'tavern-n3-alias-'))), () =>
      resolveConfig({ memory: { maxEntries: 10, aliasExpansion: true } }),
    )
    await aliasState.init()
    const { cardId } = await aliasState.createCharacter('别名角色')
    const sid = SessionId('sess-n3-alias')
    await aliasState.saveBinding({
      sessionId: sid,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const binding = (await aliasState.loadBinding(sid))!
    const ws = await aliasState.storyWorkspace(cardId, binding.storyId)
    await ws.memory.write({ body: '主角在酒馆遇到白银骑士' })

    const ctx = new Context()
    const aliasLlm = {
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }], defaultEffort: 'high' } }),
      async *stream(options: GenerateOptions) {
        aliasCalls.push(options)
        yield { type: 'text-delta' as const, index: 0, text: '1: 骑士, 酒馆' }
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
      },
    } as unknown as LlmRuntime
    registerMemoryMaintenance(ctx, aliasState, aliasLlm)
    const fakeAgent = {
      id: sid,
      options: { provider: 'deepseek-official', model: 'deepseek-flash' },
      session: {
        snapshotEvents: () => [{ type: 'turn/end', seq: 1, time: 1, data: { turn: 1, reason: { kind: 'completed' } } }],
        requestHeader: () => undefined,
      },
      runMaintenance: async (fn: (signal: AbortSignal) => Promise<void>) => fn(new AbortController().signal),
    } as unknown as Agent
    ctx.emit('agent/status', { agent: fakeAgent, status: 'idle' })
    await aliasState.waitForSessionTasks(sid)
    expect(aliasCalls).toHaveLength(1)
    expect(aliasCalls[0]?.reasoningEffort).toBe('off')
    expect(aliasCalls[0]?.maxTokens).toBe(2048)
    await ctx.fiber.dispose()
    await rm(aliasState.paths.root, { recursive: true, force: true })
  })

  it('N4 [P1]: helperMvuInitAnchorTurn 与 latestCompletedMvuAssistant/verifyTarget 判定一致，非开场白 Turn 0 消息可正常初始化并放行后续轮', async () => {
    const ctx = new Context()
    new SessionStore(ctx)
    const sid = SessionId('sess-n4')
    const { storyId } = await setupCardAndStory(sid, { helperMvu: true })

    // 非开场白来源且无正常 stop / turn/end 的遗留 Turn 0 assistant 消息
    const legacyTurn0: SessionEvent[] = [
      {
        type: 'assistant/message',
        seq: 0,
        time: 1,
        surfaceOp: 'append',
        data: {
          turn: 0,
          step: 0,
          stream: [],
          message: createAssistantMessage({
            source: { provider: 'imported', model: 'legacy' },
            content: [{ type: 'text', text: '导入的非开场白 Turn 0 消息' }],
          }),
        },
      } as SessionEvent,
    ]
    const legacySession = { id: sid, snapshotEvents: () => legacyTurn0 }
    vi.spyOn(ctx.sessions, 'get').mockImplementation((id) => (id === sid ? (legacySession as never) : undefined))

    // 三处口径一致：均识别为 Turn 0 初始化锚点
    expect(latestCompletedMvuAssistant(legacyTurn0)?.seq).toBe(0)
    expect(helperMvuInitAnchorTurn(legacySession)).toBe(0)

    // 首次开轮先延后等待初始化，同时后端能够真实下发并提交该 Turn 0 初始化任务（不再永久卡在 waiting）
    await onTurnStart(state, sid, 1, legacySession)
    expect(isTurnDeferred(state, sid, 1)).toBe(true)
    expect(await ensureHelperMvuScriptAnchor(ctx, state, sid, storyId)).toBe(0)
    const work = await prepareHelperMvuJob(ctx, state, { sessionId: sid, storyId, runtimeId: 'rt-n4' })
    expect(work.status).toBe('pending')
    expect(work.job?.seq).toBe(0)
    const committed = await commitHelperMvuJob(ctx, state, {
      sessionId: sid,
      storyId,
      runtimeId: 'rt-n4',
      jobId: work.job!.id,
      token: work.token!,
      data: { stat_data: { ready: true } },
    })
    expect(committed.status).toBe('idle')

    // 初始化完成后，下一轮不再被阻塞，正常开启 WAL 楼层
    state.deferredTurns.delete(sid)
    await onTurnStart(state, sid, 1, legacySession)
    expect(isTurnDeferred(state, sid, 1)).toBe(false)
    expect(state.openFloors.get(sid)?.floor).toBe(`${sid}#t1`)
    await ctx.fiber.dispose()
  })

  it('N5 [P1]: helperChatEdits 正文编辑分支按目标归属楼层分批提交 WAL，回退到中间层保留其编辑数据且旧层可干净回滚', async () => {
    const ctx = new Context()
    new SessionStore(ctx)
    new AgentRegistry(ctx)
    const sourceId = SessionId('sess-n5-src')
    const { cardId, storyId } = await setupCardAndStory(sourceId)
    const ws = await state.storyWorkspace(cardId, storyId)

    const source = Session.create(sourceId)
    source.append('agent-preset/selected', { agentPreset: 'tavern' })
    const greetEv = source.append(
      'assistant/message',
      {
        turn: 0,
        step: 0,
        message: createAssistantMessage({ source: TAVERN_GREETING_SOURCE, content: [{ type: 'text', text: '开场' }] }),
        stream: [],
      },
      { surfaceOp: 'append' },
    )
    appendCompletedTurn(source, 1, 'U1', 'A1')
    const t2 = appendCompletedTurn(source, 2, 'U2', 'A2')
    appendCompletedTurn(source, 3, 'U3', 'A3')

    const liveSessions = new Map<string, Session>([[sourceId, source]])
    vi.spyOn(ctx.sessions, 'get').mockImplementation((id) => liveSessions.get(id))
    const presets = { composedPreset: () => 'tavern', resolve: async () => ({ id: 'tavern' }), mount: vi.fn() }
    const origGet = ctx.get.bind(ctx)
    vi.spyOn(ctx, 'get').mockImplementation(((key: string) => (key === 'agentPresets' ? presets : origGet(key as never))) as never)
    const createSpy = vi.fn(async (opts: { sessionId: Session['id']; seed?: readonly SessionEvent[] }) => {
      const created = Session.create(opts.sessionId, opts.seed ?? [])
      liveSessions.set(opts.sessionId, created)
      return { agent: { id: opts.sessionId, session: created }, dispose: async () => {} }
    })
    ctx.agents.create = createSpy as never
    vi.spyOn(ctx.agents, 'get').mockImplementation((id) => (liveSessions.has(id) ? ({ options: { provider: 'factory', model: 'factory' }, ctx: {}, followup: vi.fn() } as never) : undefined))

    // 为 S#t1、S#t2、S#t3 写入真实 WAL 楼层
    await ws.wal.beginFloor(`${sourceId}#t1`)
    await ws.fs.withFloor(`${sourceId}#t1`).writeText('state/helper.json', JSON.stringify({ version: 1, scopes: { '["chat",""]': { step: 1 } } }))
    await ws.wal.commitFloor(`${sourceId}#t1`)
    await ws.wal.beginFloor(`${sourceId}#t2`)
    await ws.fs.withFloor(`${sourceId}#t2`).writeText('journal.md', 't2')
    await ws.wal.commitFloor(`${sourceId}#t2`)
    await ws.wal.beginFloor(`${sourceId}#t3`)
    await ws.fs.withFloor(`${sourceId}#t3`).writeText('journal.md', 't3')
    await ws.wal.commitFloor(`${sourceId}#t3`)

    // 同时编辑：Turn 0（开场白）extra、Turn 2 assistant 正文与 data、Turn 3 assistant data
    // 消息索引：0=开场(t0), 1=U1(t1), 2=A1(t1), 3=U2(t2), 4=A2(t2), 5=U3(t3), 6=A3(t3)
    const snap = await getHelperSnapshot(ctx, state, sourceId, t2.assistantEv.seq)
    const res = await editHelperMessages(ctx, state, sourceId, t2.assistantEv.seq, {
      storyId,
      historyRevision: snap.historyRevision,
      edits: [
        { message_id: 0, extra: { fromT0: true } },
        { message_id: 4, message: 'A2-已修改', data: { turn2Key: 'kept' } },
        { message_id: 6, data: { turn3Key: 'dropped-on-rollback-to-t2' } },
      ],
      before: [
        { message_id: 0, extra: {} },
        { message_id: 4, data: {} },
        { message_id: 6, data: {} },
      ],
    })
    expect(res.branch).not.toBeNull()
    const childId = res.branch!.childSessionId
    const childBinding = (await state.loadStoryBinding(childId))!
    const childWs = await state.storyWorkspace(childBinding.cardId, childBinding.storyId)
    const childFloors = (await childWs.wal.listFloors()).filter((f) => !f.rolledBack).map((f) => f.floor)
    // Turn 0 钳位到 retainedMaxTurn=1（C#t1），Turn 2 归 C#t2，Turn 3 归 C#t3
    expect(childFloors).toContain(`${childId}#t1`)
    expect(childFloors).toContain(`${childId}#t2`)
    expect(childFloors).toContain(`${childId}#t3`)

    // 回退到第 2 层（rollbackFromTurn=3）：应仅回滚 C#t3，完整保留 Turn 2 的 data 与 Turn 0 的 extra
    const rb2 = await rollbackToFloor({ ctx, state }, childId, undefined, 2)
    const rb2Binding = (await state.loadStoryBinding(rb2.childSessionId))!
    const rb2Ws = await state.storyWorkspace(rb2Binding.cardId, rb2Binding.storyId)
    const rb2Helper = await loadHelperState(rb2Ws.fs)
    const rb2Snap = await getHelperSnapshot(ctx, state, rb2.childSessionId, t2.assistantEv.seq)
    expect(rb2Snap.messages[0]?.extra).toEqual({ fromT0: true })
    expect(rb2Snap.messages[4]?.message).toBe('A2-已修改')
    expect(rb2Snap.messages[4]?.data).toEqual({ turn2Key: 'kept' })
    expect(Object.values(rb2Helper.scopes)).not.toContainEqual({ turn3Key: 'dropped-on-rollback-to-t2' })

    // 再回退到第 0 层（rollbackFromTurn=1）：C#t1 必须先于 S#t1 顺利回滚，不产生 WAL 依赖冲突
    const rb0 = await rollbackToFloor({ ctx, state }, childId, String(greetEv.data.message.id), 0)
    const rb0Binding = (await state.loadStoryBinding(rb0.childSessionId))!
    const rb0Ws = await state.storyWorkspace(rb0Binding.cardId, rb0Binding.storyId)
    const rb0Helper = await loadHelperState(rb0Ws.fs)
    expect(rb0Helper.extras).toEqual({})
    expect(rb0Helper.scopes).toEqual({})
    await ctx.fiber.dispose()
  })

  it('N6 [P1]: deriveLegacyLineage 识别仅继承 Turn 0 开场白的旧分支，归档导出不再误报来源缺失', async () => {
    const parentId = SessionId('sess-n6-parent')
    const childId = SessionId('sess-n6-child')
    const greetEvent: SessionEvent = {
      type: 'assistant/message',
      seq: 0,
      time: 1,
      surfaceOp: 'append',
      data: {
        turn: 0,
        step: 0,
        stream: [],
        message: createAssistantMessage({ source: TAVERN_GREETING_SOURCE, content: [{ type: 'text', text: '旧分支开场白' }] }),
      },
    } as SessionEvent

    const persistence = {
      open: vi.fn(async (id: string) => ({
        header: { id, isSeeded: false },
        inheritedEventCount: 0,
        read: async () => ({ events: [greetEvent] }),
        close: async () => {},
      })),
    } as unknown as SessionPersistence

    const lineage = await deriveLegacyLineage(persistence, {
      header: { id: childId, isSeeded: true, parentSession: parentId } as never,
      inheritedEventCount: 1,
      events: [greetEvent],
    })
    expect(lineage).toEqual([{ sessionId: parentId, throughTurn: 0 }])
    expect(() => assertWalLineageComplete([`${parentId}#t0`], { walLineage: lineage }, childId)).not.toThrow()
  })

  it('N7 [P2]: dropStaleTurnNotices 在 step=1 且 claimed 为空时不清空内层返回的 decision.messages', async () => {
    const ctx = new Context()
    new SessionStore(ctx)
    new SystemPrompt(ctx, {})
    new ToolRuntime(ctx)
    new LlmRuntime(ctx)
    new TavernService(ctx, state)
    applyAgent(ctx)

    const injected = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '内层合成步骤消息' }] })
    const agent = { id: SessionId('sess-n7-unbound'), session: Session.create(SessionId('sess-n7-unbound')) } as unknown as Agent

    // step=1 且 claimed 为空：stale.size===0，不应把内层 decision.messages 抹空
    const kept = await ctx.waterfall(
      'agent/pre-step',
      { agent, turn: 1, step: 1, messages: [], signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter' as const, messages: [injected], toolSet: undefined as never }),
    )
    expect(kept.kind).toBe('enter')
    if (kept.kind === 'enter') expect(kept.messages).toEqual([injected])

    // 对比：claimed 全部为旧轮 turn-scoped notice 时，仍应返回空批次
    const staleNotice = createUserMessage({
      source: { kind: 'dsh-tavern', form: 'notice', summary: '旧轮收口' },
      content: [{ type: 'text', text: formatTurnStepNotice(2) }],
    })
    const dropped = await ctx.waterfall(
      'agent/pre-step',
      { agent, turn: 2, step: 1, messages: [staleNotice], signal: new AbortController().signal } as never,
      async () => ({ kind: 'enter' as const, messages: [staleNotice], toolSet: undefined as never }),
    )
    expect(dropped.kind).toBe('enter')
    if (dropped.kind === 'enter') expect(dropped.messages).toEqual([])
    await ctx.fiber.dispose()
  })

  it('N8 [P2]: presetRequestProjection 在 messagesApi + in-history 下合并前导连续 system，不重复计入 hostSystem 文本预算', () => {
    const session = Session.create(SessionId('sess-n8'))
    const bigSdk = 'HOST-TOOLS ' + 'S'.repeat(4000)
    const standingText = `${BOUND_DISCIPLINE}\n\nSTANDING`
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append(
      'system/message',
      { turn: 1, step: 1, message: createSystemMessage(`${bigSdk}\n\n${standingText}`, '@deepseek-ai/dsh-system-prompt') },
      { surfaceOp: 'append' },
    )
    const userMsg = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '玩家输入' }] })
    const history = [{ inputIndex: 0, messageId: userMsg.id, role: 'user' as const, chat: true }]
    const plan: PresetRequestPlan = {
      version: 1,
      sessionId: session.id,
      turn: 1,
      standingText,
      contextText: TURN_PLAYBOOK,
      layout: {
        version: 1,
        history,
        entries: [
          {
            key: 'before-1',
            role: 'system',
            content: 'BEFORE-HISTORY-SYSTEM',
            sourceKeys: ['before-1'],
            turnLocal: true,
            placement: { kind: 'before-history', anchor: history[0]! },
          },
          {
            key: 'depth-0',
            role: 'system',
            content: 'DEPTH-0-SYSTEM',
            sourceKeys: ['depth-0'],
            turnLocal: true,
            placement: { kind: 'depth', depth: 0, order: 10, previous: history[0]! },
          },
        ],
      },
    }
    session.append('user/message', attachPresetPlanMessage(userMsg, plan), { surfaceOp: 'append' })

    const diagnostics: PresetProjectionDiagnostic[] = []
    const request: GenerateOptions = {
      provider: 'tavern-deepseek',
      model: 'deepseek-flash',
      sessionId: session.id,
      messages: session.deriveMessages(),
    }
    const output = projectPresetRequest(request, session, {
      messagesApi: true,
      model: { systemPromptUpdate: 'in-history', context: { contextWindow: 100_000 }, defaultMaxTokens: 1000 },
      onDiagnostic: (item) => diagnostics.push(item),
    })

    // userMsg 之前只应有一条合并后的前导 system，而非两条（hostSystem + hostSystem+before）
    const userIdx = output.messages.findIndex((m) => m.id === userMsg.id)
    const leadingSystems = output.messages.slice(0, userIdx).filter((m) => m.role === 'system')
    expect(leadingSystems).toHaveLength(1)
    const leadingText = leadingSystems[0]!.content.map((b) => (b.type === 'text' ? b.text : '')).join('')
    expect(leadingText.match(/HOST-TOOLS/g)).toHaveLength(1)
    expect(leadingText).toContain('BEFORE-HISTORY-SYSTEM')
    expect(leadingText).toContain(TURN_PLAYBOOK)

    // 文本预算与输出消息精确一致，不会多算一份被覆盖的 hostSystem
    const budget = diagnostics.find((d) => d.kind === 'text-budget')
    expect(budget?.kind).toBe('text-budget')
    const expectedTokens = output.messages.reduce(
      (sum, m) => sum + m.content.reduce((acc, b) => acc + (b.type === 'text' ? estimateTokens(b.text) : 0), 0),
      0,
    )
    if (budget?.kind === 'text-budget') {
      expect(budget.afterTextTokens).toBe(expectedTokens)
      // 若曾双计 hostSystem，afterTextTokens 会额外多出约 estimateTokens(bigSdk)
      expect(budget.afterTextTokens).toBeLessThan(expectedTokens + Math.floor(estimateTokens(bigSdk) / 2))
    }
  })

  it('N9 [P2]: JSON 角色卡上传在 Buffer.from / JSON.parse 之前拦截超限体积（service / state / remote）', async () => {
    const ctx = new Context()
    const service = new TavernService(ctx, state)
    // 故意使用非法 JSON 的纯字母超大 base64（> 24 MiB 编码后约 33.5M 字符）：
    // 若未在解码/parse 前拒绝，JSON.parse 会先抛 SyntaxError 而不是超过大小上限。
    const hugeBase64 = 'A'.repeat(Math.ceil((24 * 1024 * 1024) / 3) * 4 + 4)

    await expect(service.inspectCharacter({ name: 'huge.json', dataBase64: hugeBase64 })).rejects.toThrow(/JSON 角色卡超过大小上限/)
    await expect(service.importCharacter({ name: 'huge.json', dataBase64: hugeBase64 })).rejects.toThrow(/JSON 角色卡超过大小上限/)

    // state.importCharacter 直调也受 24 MiB 保护
    await expect(state.importCharacter('huge.json', new Uint8Array(24 * 1024 * 1024 + 1))).rejects.toThrow(/JSON 角色卡超过大小上限/)

    // remote schema 对超出 PNG 上限（32 MiB）的超大载荷直接拒绝
    const byMethod = new Map(TYPERT_REMOTE.descriptors.map((d) => [d.method, d]))
    const overPngBase64 = 'A'.repeat(MAX_CARD_PNG_BASE64_CHARS + 1)
    for (const method of ['inspectCharacter', 'importCharacter'] as const) {
      const schema = byMethod.get(method)!.parameters[0]!.codec.create()
      expect(() => schema.parse({ name: 'huge.png', dataBase64: overPngBase64 })).toThrow()
    }
    await ctx.fiber.dispose()
  })

  it('N10 [P1]: remote.ts saveCharacter.depthPrompt.depth 仅接受非负安全整数并校验 role 枚举', () => {
    const byMethod = new Map(TYPERT_REMOTE.descriptors.map((d) => [d.method, d]))
    const schema = byMethod.get('saveCharacter')!.parameters[0]!.codec.create()

    expect(schema.parse({ cardId: 'c1', depthPrompt: null })).toEqual({ cardId: 'c1', depthPrompt: null })
    expect(schema.parse({ cardId: 'c1', depthPrompt: { prompt: 'hi', depth: 0, role: 'system' } })).toEqual({
      cardId: 'c1',
      depthPrompt: { prompt: 'hi', depth: 0, role: 'system' },
    })
    expect(schema.parse({ cardId: 'c1', depthPrompt: { prompt: 'hi', depth: 4, role: 'user' } })).toBeTruthy()
    expect(schema.parse({ cardId: 'c1', depthPrompt: { prompt: 'hi', depth: 8, role: 'assistant' } })).toBeTruthy()

    for (const badDepth of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => schema.parse({ cardId: 'c1', depthPrompt: { prompt: 'hi', depth: badDepth, role: 'system' } })).toThrow()
    }
    expect(() => schema.parse({ cardId: 'c1', depthPrompt: { prompt: 'hi', depth: 2, role: 'tool' } })).toThrow()
  })
})
