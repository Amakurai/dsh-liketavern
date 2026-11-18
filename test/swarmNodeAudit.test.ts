/**
 * 宿主编排层（src/node/**、src/agent.ts）深度审计回归测试：
 * 1. 卡面桥 frameLease 与默认/未指定人设（personaId: null）、重命名角色与世界书归一化绑定的对齐；
 *    人设文件损坏时不阻塞自动 MVU 准备/收口、脚本包加载与卡面桥写入，以及 MVU 初始化世界书原名/大小写解析；
 * 2. renderOutputTexts 混合纯文本、原生 <details> 与真实 <iframe> 批次的单快照一致性及损坏隔离，
 *    以及各酒馆助手写接口的会话队列串行（enqueueSessionTask / waitForSessionCommits）与记忆/状态面板写锁；
 * 3. TavernState 角色/剧情工作区并发冷启动去重、临时文件清理前置、活跃楼层/待压缩剧情的 LRU 保护，
 *    以及删卡时并发读取的修订防回填、avatarCache 与 pendingMemoryCompress 回收；
 * 4. 0.2.2-rc.3 下 ensureAgentRequestSelectionSync 对 probe 的隔离与零伪造 model/selection 日志、
 *    onTurnEnd（含暂缓轮）对 appliedStanding / appliedTurnContext 的清理，以及 computeWorker 中 wi 条件求值保留沙箱缓存。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import {
  createAssistantMessage,
  createUserMessage,
  LlmAdapter,
  LlmError,
  LlmRuntime,
  ReasoningEffortId,
  type GenerateOptions,
  type LlmResolvedModelInfo,
  type PreparedAdapterCall,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply as applyAgent } from '../src/agent.js'
import { resolveConfig } from '../src/node/config.js'
import { greetingTurnEvents } from '../src/node/greetingSeed.js'
import { disposeIdleComputeWorkers, isolated, isolatedWorkerStats } from '../src/node/isolated.js'
import { ensureAgentRequestSelectionSync } from '../src/node/modelRoute.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernService } from '../src/node/service.js'
import { TavernState } from '../src/node/state.js'
import type { HelperFrameLease, HelperFrameOpen } from '../src/core/helperFrame.js'
import type { TemplateContext } from '../src/core/template.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE } from '../src/core/types.js'
import type { TavernPaths } from '../src/node/paths.js'
import { parseStPreset } from '../src/state/presetStore.js'
import { embedCardInPng } from '../src/state/card.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

const tempRoots: string[] = []

async function makePaths(prefix: string): Promise<TavernPaths> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(root)
  return {
    root,
    characters: join(root, 'characters'),
    lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'),
    personas: join(root, 'personas'),
    regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions'),
  }
}

function appendCompletedAssistantTurn(session: Session, turn: number, userText: string, assistantText: string): number {
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } }), {
    surfaceOp: 'append',
  })
  session.append('step/start', { turn, step: 1 })
  const assistant = session.append(
    'assistant/message',
    {
      turn,
      step: 1,
      stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }] as never,
      message: createAssistantMessage({
        content: [{ type: 'text', text: assistantText }],
        source: { provider: 'factory', model: 'factory' },
      }),
    },
    { surfaceOp: 'append' },
  )
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  return assistant.seq
}

afterEach(async () => {
  vi.restoreAllMocks()
  await disposeIdleComputeWorkers()
  while (tempRoots.length > 0) {
    await rm(tempRoots.pop()!, { recursive: true, force: true })
  }
})

describe('卡面桥 frameLease、人设容错与 MVU 初始化世界书解析', () => {
  let paths: TavernPaths
  let state: TavernState
  let ctx: Context
  let service: TavernService
  let cardId: string
  let session: Session
  let messageId: number

  beforeEach(async () => {
    paths = await makePaths('node-audit-lease-')
    state = new TavernState(paths, () => resolveConfig({}))
    await state.init()
    cardId = (await state.createCharacter('审计角色')).cardId
    await state.saveCharacter(cardId, { firstMes: '开场白一', alternateGreetings: ['开场白二'] })
    await state.savePersona({ id: 'default-traveler', name: '旅人', description: '默认人设描述', avatar: null })

    ctx = new Context()
    new SessionStore(ctx)
    new AgentRegistry(ctx)
    ctx.provide('agentPresets', { composedPreset: () => 'tavern', resolve: async () => ({ id: 'tavern' }), mount: vi.fn() })
    vi.spyOn(ctx.agents, 'create').mockImplementation((async (options: { sessionId: Session['id']; seed?: SessionEvent[] }) => {
      ctx.sessions.create(options.sessionId, options.seed ? { seed: options.seed } : {})
      return { dispose: vi.fn(async () => {}) } as unknown as AgentHandle
    }) as never)

    session = ctx.sessions.create(SessionId('session-lease-audit'))
    session.append('agent-preset/selected', { agentPreset: 'tavern' })
    messageId = appendCompletedAssistantTurn(session, 1, '你好', '<div>初始卡面</div>')

    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: true,
      greetingIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    service = new TavernService(ctx, state, { get: () => resolveConfig({}), update: async () => undefined })
  })

  afterEach(async () => {
    await ctx?.fiber.dispose()
  })

  async function openLease(targetSessionId = session.id, targetMessageId = messageId, epoch = 1): Promise<HelperFrameLease> {
    const storyId = (await state.loadStoryBinding(targetSessionId))!.storyId!
    const req: HelperFrameOpen = {
      sessionId: targetSessionId,
      storyId,
      messageId: targetMessageId,
      frameId: `frame-${targetSessionId}-${targetMessageId}`,
      runtimeId: `rt-${epoch}`,
      epoch,
      readOnly: false,
    }
    const { token } = await service.openHelperFrame(req)
    return { frameId: req.frameId, runtimeId: req.runtimeId, epoch: req.epoch, token }
  }

  it('存在默认/唯一人设且会话绑定 personaId=null 时，全部卡面桥写操作与角色改名后同租约连续写入均正常通过，子分支保持 personaId=null', async () => {
    const storyId = (await state.loadStoryBinding(session.id))!.storyId!
    await state.saveLorebook('public-lore', { name: 'public-lore', entries: { 0: { content: '共享设定' } } })
    const frameLease = await openLease()

    // 1. 角色重命名使磁盘 card.name 与旧 binding.cardName 不同；随后通过卡面租约重绑世界书设置（乱序键）与全局书
    await state.saveCharacter(cardId, { name: '审计角色·改名' })
    const wb0 = await service.getHelperWorldbookContext({ sessionId: session.id, storyId })
    const wb1 = await service.rebindHelperWorldbooks({
      sessionId: session.id,
      messageId,
      storyId,
      bindingRevision: wb0.bindingRevision,
      frameLease,
      kind: 'settings',
      selection: { recursive: false, scan_depth: 2, selected_global_lorebooks: ['public-lore'] },
    })
    expect(wb1.global).toEqual(['public-lore'])
    expect((await state.loadStoryBinding(session.id))?.personaId).toBeNull()

    // 2. 同一租约继续操作聊天世界书（走 withHelperStoryWrite + run 双重 beforeWrite 校验）
    const wb2 = await service.rebindHelperWorldbooks({
      sessionId: session.id,
      messageId,
      storyId,
      bindingRevision: wb1.bindingRevision,
      frameLease,
      kind: 'ensure-chat',
      selection: '剧情书',
    })
    expect(wb2.chat).toBe('@dsh/chat')
    const chatCreated = await service.helperWorldbookOperation({
      sessionId: session.id,
      messageId,
      storyId,
      bindingRevision: wb2.bindingRevision,
      frameLease,
      name: '@dsh/chat',
      operation: 'replace',
      revision: (
        await service.helperWorldbookOperation({
          sessionId: session.id,
          messageId,
          storyId,
          bindingRevision: wb2.bindingRevision,
          frameLease,
          name: '@dsh/chat',
          operation: 'get',
        })
      ).snapshot!.revision,
      entries: [{ uid: 1, name: '线索', content: '码头密信' }],
    })
    expect(chatCreated.snapshot?.entries[0]?.content).toBe('码头密信')

    // 3. 同一租约提交酒馆助手变量与会话脚本库
    const snap0 = await service.getHelperSnapshot({ sessionId: session.id, messageId })
    const snap1 = await service.commitHelperVariables({
      sessionId: session.id,
      messageId,
      storyId,
      historyRevision: snap0.historyRevision,
      frameLease,
      changes: [{ key: JSON.stringify(['chat', '']), before: {}, value: { clueCount: 1 } }],
    })
    expect(snap1.scopes[JSON.stringify(['chat', ''])]).toEqual({ clueCount: 1 })

    const scripts0 = await service.getSessionHelperScripts({ sessionId: session.id, storyId })
    const charLib = scripts0.libraries.find((lib) => lib.type === 'character')!
    const savedScript = await service.commitSessionHelperScripts({
      sessionId: session.id,
      storyId,
      bindingRevision: scripts0.bindingRevision,
      frameLease,
      type: 'character',
      revision: charLib.revision,
      trees: [{ id: 'card-btn', type: 'script', name: '面板脚本', enabled: true, content: 'void 0', info: '', button: { enabled: false, buttons: [] }, data: {} }],
    })
    expect(savedScript.trees).toHaveLength(1)

    // 4. 同一租约执行 editHelperMessages（创建分支）并验证子分支仍保留 personaId=null（不把当前默认人设固化进子会话）
    const editRes = await service.editHelperMessages({
      sessionId: session.id,
      messageId,
      storyId,
      historyRevision: snap1.historyRevision,
      frameLease,
      edits: [{ message_id: snap1.currentMessageId, message: '<div>修订后的卡面</div>' }],
    })
    expect(editRes.branch?.childSessionId).toBeTruthy()
    const editedChildBinding = await state.loadStoryBinding(editRes.branch!.childSessionId)
    expect(editedChildBinding?.personaId).toBeNull()

    // 5. 开场白会话在 personaId=null 且存在默认人设时，卡面租约 swipeGreeting 同样通过并保留 personaId=null
    const greetSession = ctx.sessions.create(SessionId('session-greet-lease'), {
      seed: [
        { type: 'agent-preset/selected', seq: 0, time: 0, data: { agentPreset: 'tavern' } },
        ...greetingTurnEvents('开场白一').map((event) => ({ ...event, seq: event.seq + 1 })),
      ] as SessionEvent[],
    })
    const greetSeq = greetSession.snapshotEvents().find((e) => e.type === 'assistant/message')!.seq
    await state.saveBinding({
      sessionId: greetSession.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: true,
      greetingIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const greetLease = await openLease(greetSession.id, greetSeq, 1)
    const swiped = await service.swipeGreeting({ sessionId: greetSession.id, index: 1, frameLease: greetLease })
    expect(swiped.index).toBe(1)
    expect((await state.loadStoryBinding(swiped.childSessionId))?.personaId).toBeNull()
  })

  it('人设文件损坏时不阻塞脚本包加载、自动 MVU 初始化/收口与卡面桥，且 MVU 初始化可解析未净化原名世界书', async () => {
    const unsanitizedBookName = '主线 设定'
    const diskBookId = await state.saveLorebook(unsanitizedBookName, {
      name: unsanitizedBookName,
      entries: {
        0: { comment: '[InitVar]', content: '{"hp":100}', disable: false },
      },
    })
    expect(diskBookId).not.toBe(unsanitizedBookName)

    const existing = (await state.loadStoryBinding(session.id))!
    await state.saveBinding({
      ...existing,
      personaId: 'default-traveler',
      helperMvu: true,
      lorebookIds: [unsanitizedBookName],
    })

    // 破坏人设 JSON：getSessionBinding 仍严格报错，但已生成楼层的 MVU 准备/提交、脚本包与卡面桥仍能收口
    await writeFile(join(paths.personas, 'default-traveler.json'), '{broken-persona-json', 'utf8')
    await expect(service.getSessionBinding({ sessionId: session.id })).rejects.toThrow(/人设.*损坏/)

    const bundle = await service.getHelperScriptBundle({ sessionId: session.id })
    expect(bundle.storyId).toBe(existing.storyId)
    expect(bundle.userName).toBe('User')

    const mvuPrep = await service.prepareHelperMvuJob({
      sessionId: session.id,
      storyId: existing.storyId!,
      runtimeId: 'mvu-runner-1',
    })
    expect(mvuPrep.status).toBe('pending')
    if (mvuPrep.status !== 'pending' || !mvuPrep.job || !mvuPrep.token) throw new Error('expected MVU initialize job')
    expect(mvuPrep.job.kind).toBe('initialize')
    expect(mvuPrep.initialSources?.some((src) => src.entries.some((entry) => entry.comment === '[InitVar]'))).toBe(true)

    const committed = await service.commitHelperMvuJob({
      sessionId: session.id,
      storyId: existing.storyId!,
      runtimeId: 'mvu-runner-1',
      jobId: mvuPrep.job.id,
      token: mvuPrep.token,
      data: { stat_data: { hp: 100 } },
    })
    expect(committed.status).toBe('idle')

    const lease = await openLease()
    const snap = await service.getHelperSnapshot({ sessionId: session.id, messageId })
    const updated = await service.commitHelperVariables({
      sessionId: session.id,
      messageId,
      storyId: existing.storyId!,
      historyRevision: snap.historyRevision,
      frameLease: lease,
      changes: [{ key: JSON.stringify(['chat', '']), before: {}, value: { afterMvu: true } }],
    })
    expect(updated.scopes[JSON.stringify(['chat', ''])]).toEqual({ afterMvu: true })

    // 真正缺失的世界书在 MVU 初始化时仍明确报错
    const missingSession = ctx.sessions.create(SessionId('session-mvu-missing-book'))
    missingSession.append('agent-preset/selected', { agentPreset: 'tavern' })
    appendCompletedAssistantTurn(missingSession, 1, '开局', '正文')
    await state.saveBinding({
      sessionId: missingSession.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: ['nonexistent-lorebook'],
      characterLorebookId: null,
      interactiveCards: true,
      helperMvu: true,
      greetingIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const missingStoryId = (await state.loadStoryBinding(missingSession.id))!.storyId!
    const missingWs = await state.storyWorkspace(cardId, missingStoryId)
    await missingWs.wal.beginFloor(`${missingSession.id}#t1`)
    await missingWs.wal.commitFloor(`${missingSession.id}#t1`)
    await expect(
      service.prepareHelperMvuJob({ sessionId: missingSession.id, storyId: missingStoryId, runtimeId: 'mvu-runner-2' }),
    ).rejects.toThrow(/自动 MVU 初始化世界书不存在：nonexistent-lorebook/)
  })
})

describe('renderOutputTexts 混合批次快照一致性、损坏隔离与写队列串行', () => {
  let paths: TavernPaths
  let state: TavernState
  let ctx: Context
  let service: TavernService
  let cardId: string
  let session: Session
  let seqPlain: number
  let seqDetails: number
  let seqIframe: number

  beforeEach(async () => {
    paths = await makePaths('node-audit-batch-')
    state = new TavernState(paths, () => resolveConfig({}))
    await state.init()
    cardId = (await state.createCharacter('批次角色')).cardId

    ctx = new Context()
    new SessionStore(ctx)
    new AgentRegistry(ctx)
    session = ctx.sessions.create(SessionId('session-batch-audit'))
    session.append('agent-preset/selected', { agentPreset: 'tavern' })
    seqPlain = appendCompletedAssistantTurn(session, 1, 'u1', '纯文本回复')
    seqDetails = appendCompletedAssistantTurn(session, 2, 'u2', '<details><summary>思考</summary>原生折叠内容</details>')
    seqIframe = appendCompletedAssistantTurn(session, 3, 'u3', '<div class="card">互动卡面</div>')

    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: true,
      greetingIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    service = new TavernService(ctx, state, { get: () => resolveConfig({}), update: async () => undefined })
  })

  afterEach(async () => {
    await ctx?.fiber.dispose()
  })

  it('混合纯文本、原生 <details> 与真实 <iframe> 批次共享单次快照读取，且 helper.json 损坏仅隔离 <iframe> 项', async () => {
    const batch = await service.renderOutputTexts({
      sessionId: session.id,
      items: [
        { messageId: seqPlain, text: '纯文本回复' },
        { messageId: seqDetails, text: '<details><summary>思考</summary>原生折叠内容</details>' },
        { messageId: seqIframe, text: '<div class="card">互动卡面</div>' },
      ],
    })
    expect(batch.items.map((item) => item.ok)).toEqual([true, true, true])
    expect(batch.helperBase).toBeDefined()
    expect(batch.helperScripts).toBeDefined()
    expect(batch.helperWorldbooks).toBeDefined()

    const plainItem = batch.items[0]!
    const detailsItem = batch.items[1]!
    const iframeItem = batch.items[2]!
    if (!plainItem.ok || !detailsItem.ok || !iframeItem.ok) throw new Error('expected all batch items ok')

    expect(plainItem.value.helperContext?.historyRevision).toBe(batch.helperBase!.historyRevision)
    expect(detailsItem.value.helperContext?.historyRevision).toBe(batch.helperBase!.historyRevision)
    expect(plainItem.value.helperContext?.storyId).toBe(batch.helperBase!.storyId)
    expect(iframeItem.value.helperMessageId).toBe(5)
    expect(iframeItem.value.helperExtras).toBe(true)

    // 破坏 state/helper.json：同批次内的纯文本和原生 <details> 气泡仍应成功返回，仅 <iframe> 项报错
    const binding = (await state.loadStoryBinding(session.id))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)
    await ws.plainFs.writeText('state/helper.json', '{corrupt-helper-state')

    const brokenBatch = await service.renderOutputTexts({
      sessionId: session.id,
      items: [
        { messageId: seqPlain, text: '纯文本回复' },
        { messageId: seqDetails, text: '<details><summary>思考</summary>原生折叠内容</details>' },
        { messageId: seqIframe, text: '<div class="card">互动卡面</div>' },
      ],
    })
    expect(brokenBatch.items[0]?.ok).toBe(true)
    expect(brokenBatch.items[1]?.ok).toBe(true)
    expect(brokenBatch.items[2]?.ok).toBe(false)
    if (brokenBatch.items[0]?.ok) {
      expect(brokenBatch.items[0].value.helperContext?.storyId).toBe(binding.storyId)
    }
  })

  it('世界书重绑与修改进入会话提交队列，后续只读上下文与展示渲染等待在途写完成且不等后台维护', async () => {
    const storyId = (await state.loadStoryBinding(session.id))!.storyId!
    await state.saveLorebook('queued-book', { name: 'queued-book', entries: { 0: { content: '排队设定' } } })
    const wb0 = await service.getHelperWorldbookContext({ sessionId: session.id, storyId })

    let releaseTurnTask!: () => void
    const turnGate = state.enqueueSessionTask(
      session.id,
      () => new Promise<void>((resolve) => { releaseTurnTask = resolve }),
    )

    let rebindSettled = false
    const pendingRebind = service
      .rebindHelperWorldbooks({
        sessionId: session.id,
        messageId: seqIframe,
        storyId,
        bindingRevision: wb0.bindingRevision,
        kind: 'global',
        selection: ['queued-book'],
      })
      .then((res) => {
        rebindSettled = true
        return res
      })

    // 在途世界书重绑未落定前，getHelperWorldbookContext（waitForSessionCommits）必须等待它完成
    let readBeforeRelease = false
    const pendingRead = service.getHelperWorldbookContext({ sessionId: session.id, storyId }).then((res) => {
      readBeforeRelease = !rebindSettled
      return res
    })

    await new Promise((r) => setTimeout(r, 30))
    expect(rebindSettled).toBe(false)

    // 紧随其后排入后台维护任务：只读查询只需等 pendingRebind 完成，不等后台维护
    let releaseMaintenance!: () => void
    const maintenanceGate = state.enqueueSessionTask(
      session.id,
      () => new Promise<void>((resolve) => { releaseMaintenance = resolve }),
      { background: true },
    )

    releaseTurnTask()
    await turnGate
    const rebound = await pendingRebind
    const readAfter = await pendingRead
    expect(readBeforeRelease).toBe(false)
    expect(rebound.global).toEqual(['queued-book'])
    expect(readAfter.global).toEqual(['queued-book'])

    releaseMaintenance()
    await maintenanceGate
  })
})

describe('TavernState 工作区并发冷启动、LRU 保护与删卡缓存失效', () => {
  it('并发冷打开同一工作区共享同一句柄且先完成临时文件清扫；活跃开层与待压缩剧情不被 LRU 逐出', async () => {
    const paths = await makePaths('node-audit-lru-')
    const state = new TavernState(paths, () => resolveConfig({ memory: { maxEntries: 1, maxTokens: 10, compressBatch: 2 } }))
    await state.init()
    const cardId = (await state.createCharacter('并发工作区角色')).cardId
    await state.saveBinding({
      sessionId: 's-pinned-open',
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await state.saveBinding({
      sessionId: 's-pinned-compress',
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const openStoryId = (await state.loadStoryBinding('s-pinned-open'))!.storyId!
    const compressStoryId = (await state.loadStoryBinding('s-pinned-compress'))!.storyId!

    // 冷实例并发打开同一剧情 8 次，必须拿到同一个 WorkspaceHandle / MemoryStore 实例
    const coldState = new TavernState(paths, () => resolveConfig({}))
    await coldState.init()
    const handles = await Promise.all(Array.from({ length: 8 }, () => coldState.storyWorkspace(cardId, openStoryId)))
    for (const h of handles) {
      expect(h).toBe(handles[0])
      expect(h.memory).toBe(handles[0]!.memory)
    }

    // 标记活跃楼层与待压缩剧情后，再创建超过 WORKSPACES_MAX(64) 个普通剧情句柄触发 LRU 淘汰
    const pinnedOpenHandle = await state.storyWorkspace(cardId, openStoryId)
    const pinnedCompressHandle = await state.storyWorkspace(cardId, compressStoryId)
    state.openFloors.set('s-pinned-open', { cardId, storyId: openStoryId, floor: 's-pinned-open#t1' })
    state.pendingMemoryCompress.add(compressStoryId)

    for (let i = 0; i < 70; i++) {
      const sid = `s-ephemeral-${i}`
      await state.saveBinding({
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
      const stId = (await state.loadStoryBinding(sid))!.storyId!
      await state.storyWorkspace(cardId, stId)
    }

    expect(await state.storyWorkspace(cardId, openStoryId)).toBe(pinnedOpenHandle)
    expect(await state.storyWorkspace(cardId, compressStoryId)).toBe(pinnedCompressHandle)
  })

  it('删卡期间的在途读取不会把已删角色回填进缓存，且 avatarCache 与 pendingMemoryCompress 同步清理', async () => {
    const paths = await makePaths('node-audit-del-cache-')
    const state = new TavernState(paths, () => resolveConfig({ memory: { maxEntries: 2, maxTokens: 5000, compressBatch: 2 } }))
    await state.init()
    const ctx = new Context()
    const service = new TavernService(ctx, state, { get: () => resolveConfig({}), update: async () => undefined })

    const png = embedCardInPng(null, { spec: 'chara_card_v2', spec_version: '2.0', data: { name: '带头像角色', description: 'desc', first_mes: 'hi' } }, 'chara_card_v2')
    const imported = await state.importCharacter('avatar-card.png', png)
    const cardId = imported.cardId

    // 预热头像缓存，并验证面板删除/归并记忆在容量恢复后清理 pendingMemoryCompress
    const avatarBefore = await service.getAvatar({ cardId })
    expect(avatarBefore.dataUrl).toMatch(/^data:image\/png;base64,/)

    const m1 = await service.saveMemory({ cardId, body: '第一条记忆' })
    const m2 = await service.saveMemory({ cardId, body: '第二条记忆' })
    const m3 = await service.saveMemory({ cardId, body: '第三条记忆' })
    state.pendingMemoryCompress.add(cardId)
    await service.deleteMemory({ cardId, id: m3.id })
    expect(state.pendingMemoryCompress.has(cardId)).toBe(false)

    state.pendingMemoryCompress.add(cardId)
    const merged = await service.compressMemories({ cardId })
    expect(merged.merged).toBe(2)
    expect(state.pendingMemoryCompress.has(cardId)).toBe(false)
    void m1
    void m2

    // 模拟一次冷读取在删卡前已读出磁盘对象、在删卡完成后才收尾返回：修订号已推进，不得把旧卡写回 cardCache
    const coldState = new TavernState(paths, () => resolveConfig({}))
    await coldState.init()
    const readStarted = Promise.withResolvers<void>()
    const allowFinish = Promise.withResolvers<void>()
    const rawRead = WorkspaceFs.prototype.readText
    const spy = vi.spyOn(WorkspaceFs.prototype, 'readText').mockImplementation(async function (this: WorkspaceFs, relPath: string) {
      const text = await rawRead.call(this, relPath)
      if (relPath === 'card.json' && this.root.endsWith(cardId)) {
        readStarted.resolve()
        await allowFinish.promise
      }
      return text
    })

    const inflightLoad = coldState.loadCharacter(cardId)
    await readStarted.promise
    spy.mockRestore()

    state.pendingMemoryCompress.add(cardId)
    await service.archiveCharacter({ cardId })
    await service.deleteCharacter({ cardId })
    // 同步通知同一进程冷实例删除
    await coldState.archiveCharacter(cardId).catch(() => {})
    ;(coldState as unknown as { invalidateSessionArchiveCard(id: string): void }).invalidateSessionArchiveCard(cardId)
    allowFinish.resolve()
    await inflightLoad

    expect(await coldState.loadCharacter(cardId)).toBeNull()
    expect(await state.loadCharacter(cardId)).toBeNull()
    expect((await service.getAvatar({ cardId })).dataUrl).toBeNull()
    expect(state.pendingMemoryCompress.has(cardId)).toBe(false)
    await ctx.fiber.dispose()
  })
})

describe('宿主 0.2.2-rc.3 请求选择同步、回合末上下文清理与 worker 沙箱缓存保留', () => {
  it('probe 请求不篡改活跃步骤选择，真实请求与 prepareCall 失败均不伪造 model/selection 日志或残留未消费 pending', async () => {
    const paths = await makePaths('node-audit-route-')
    const state = new TavernState(paths, () => resolveConfig({ sampling: { thinking: 'enabled' } }))
    await state.init()
    const cardId = (await state.createCharacter('路由角色')).cardId
    const { preset } = parseStPreset({
      name: '思考档预设',
      identifier: 'effort-preset',
      temperature: 0.6,
      openai_max_tokens: 512,
      prompts: [{ identifier: 'chatHistory', marker: true }],
    })
    const presetId = await state.savePreset(preset)

    let failPrepareCall = true
    class EffortAdapter extends LlmAdapter {
      override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return {
          provider,
          id: model,
          name: model,
          inputModalities: ['text'],
          context: { contextWindow: 64_000 },
          reasoning: { efforts: [{ id: ReasoningEffortId('off') }, { id: ReasoningEffortId('medium') }, { id: ReasoningEffortId('high') }], defaultEffort: ReasoningEffortId('medium') },
        }
      }
      override async prepareCall(provider: string, model: string): Promise<PreparedAdapterCall> {
        if (failPrepareCall) {
          throw new LlmError('missing credential', 'MISSING_CREDENTIAL')
        }
        const info = await this.resolveModel(provider, model)
        return {
          model: info,
          adapterDefaults: { reasoningEffort: true },
          stream: (options) => this.stream(options),
        }
      }
      override async *stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', index: 0, text: '正常回复' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    }

    const ctx = new Context()
    new SessionStore(ctx)
    new AgentRegistry(ctx)
    const projections = new SessionProjectionRegistry(ctx)
    new SystemPrompt(ctx, {})
    new ToolRuntime(ctx)
    const llm = new LlmRuntime(ctx)
    llm.registerAdapter(['factory'], new EffortAdapter())
    const loop = new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
    const agent: Agent = await loop.create(SessionId('session-route-022'), { provider: 'factory', model: 'reasoner' })
    await state.saveBinding({
      sessionId: agent.id,
      cardId,
      presetId,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    })

    ctx.provide('tavern', { state })
    ctx.on('session/event', (sess, event) => {
      if (event.type === 'turn/start') {
        void state.enqueueSessionTask(sess.id, () => onTurnStart(state, sess.id, event.data.turn, sess))
      } else if (event.type === 'turn/end') {
        const snapshot = sess.snapshotEvents()
        void state.enqueueSessionTask(sess.id, () => onTurnEnd(state, sess.id, { id: sess.id, snapshotEvents: () => snapshot }))
      }
    })
    ctx.on('agent/error', () => {})
    applyAgent(agent.ctx)

    // 1. probe waterfall 不得改动已锁定的步骤 selection，也不得向会话写入 model/selection
    const lockedSelection = { provider: 'factory', model: 'reasoner' }
    ensureAgentRequestSelectionSync(agent, lockedSelection)
    state.presetAdapter = { ensureRegistered: () => {} }
    const probed = await (agent as unknown as { dispatch: { waterfall: (name: string, payload: unknown, base: () => Promise<unknown>) => Promise<unknown> } }).dispatch.waterfall(
      'agent/request',
      { agent, turn: 1, step: 1, probe: true, signal: new AbortController().signal },
      async () => ({ provider: 'deepseek-official', model: 'reasoner' }),
    )
    expect((probed as { provider: string }).provider).toBe('tavern-deepseek')
    expect(lockedSelection).toEqual({ provider: 'factory', model: 'reasoner' })
    expect(agent.session.snapshotEvents().filter((e) => e.type === 'model/selection')).toHaveLength(0)
    state.presetAdapter = undefined

    // 2. prepareCall 失败的轮次不得向持久日志留下伪造的 model/selection，且结束时清理 appliedStanding / appliedTurnContext
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '先触发凭证失败' }] }))
    await agent.whenIdle()
    await state.waitForSessionTasks(agent.id)
    expect(agent.session.snapshotEvents().filter((e) => e.type === 'model/selection')).toHaveLength(0)
    expect(state.appliedStanding.has(agent.id)).toBe(false)
    expect(state.appliedTurnContext.has(agent.id)).toBe(false)

    // 3. 凭证恢复后正常发信（含 adapterDefaults.reasoningEffort = true），不产生悬空 pending 选择，回合结束后清空 appliedTurnContext
    failPrepareCall = false
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '恢复后发信' }] }))
    await agent.whenIdle()
    await state.waitForSessionTasks(agent.id)
    expect(agent.session.snapshotEvents().filter((e) => e.type === 'model/selection')).toHaveLength(0)
    const selState = projections.stateOf(agent.session, 'modelSelection' as never) as { pending: unknown; lastUsed: unknown } | undefined
    expect(selState?.pending ?? null).toBeNull()
    expect(state.appliedStanding.has(agent.id)).toBe(false)
    expect(state.appliedTurnContext.has(agent.id)).toBe(false)

    // 4. 暂缓轮（deferredTurns）结束时同样清空 appliedStanding / appliedTurnContext
    state.appliedStanding.set(agent.id, 'stale-standing')
    state.appliedTurnContext.set(agent.id, 'stale-turn-context')
    state.deferredTurns.set(agent.id, 99)
    await onTurnEnd(state, agent.id, {
      id: agent.id,
      snapshotEvents: () => [{ type: 'turn/end', seq: 999, time: 0, data: { turn: 99, reason: { kind: 'blocked' } } }] as unknown as SessionEvent[],
    })
    expect(state.appliedStanding.has(agent.id)).toBe(false)
    expect(state.appliedTurnContext.has(agent.id)).toBe(false)

    await ctx.fiber.dispose()
  })

  it('computeWorker 执行带 templateCondition 的 wi 求值不会清空已缓存的跨步骤模板沙箱', async () => {
    await disposeIdleComputeWorkers()
    const baseTemplateCtx: TemplateContext = {
      variables: { global: {}, local: { score: 1 }, message: {} },
      char: 'Alice',
      user: 'Bob',
      card: { name: 'Alice' },
      entries: [],
      presets: [],
      history: [{ role: 'user', content: 'start' }],
      historyIdentities: [{ messageId: 'msg-1', swipeId: 0 }],
      now: 1_700_000_000_000,
      seed: 7,
      phase: 'generate',
      sessionId: 'cache-preserve-session',
      cardId: 'card-cache',
    }
    const preset = {
      identifier: 'tpl-preset',
      name: 'TplPreset',
      sampling: { temperature: 1, maxTokens: 512, stop: [] },
      entries: [
        { identifier: 'main', name: 'Main', role: 'system' as const, enabled: true, position: 'relative' as const, order: 10, depth: 4, marker: false, content: '<% setLocalVar("score", getLocalVar("score") + 1) %>SYS' },
        { identifier: 'chatHistory', name: 'History', role: 'system' as const, enabled: true, position: 'relative' as const, order: 20, depth: 4, marker: true, content: '' },
      ],
    }

    const assembled = await isolated('assemble', {
      preset,
      card: null,
      personaDescription: '',
      history: [{ role: 'user', content: 'start' }],
      wi: null,
      memories: [],
      worldDeltas: [],
      regexRules: [],
      budget: { maxTokens: 4096, reserveForOutput: 512 },
      seed: 7,
      templates: baseTemplateCtx,
      macroCtx: {
        char: 'Alice',
        user: 'Bob',
        outlets: {},
      },
    })
    expect(assembled.templateReplay).toBeDefined()
    const hitsBefore = isolatedWorkerStats().cacheHits

    // 在同一空闲 worker 上执行需要临时 TemplateSandbox 的 wi 条件求值
    const wiRes = await isolated('wi', {
      entries: [
        {
          key: 'global:g:cond-1',
          uid: 'cond-1',
          keys: ['start'],
          secondaryKeys: [],
          comment: 'conditional',
          content: 'HIT',
          constant: true,
          selective: false,
          selectiveLogic: 0,
          order: 10,
          position: 0,
          depth: 4,
          role: 0,
          outletName: '',
          enabled: true,
          useRegex: false,
          preventRecursion: false,
          excludeRecursion: false,
          delayUntilRecursion: 0,
          probability: 100,
          useProbability: false,
          sticky: null,
          cooldown: null,
          delay: null,
          ignoreBudget: false,
          group: '',
          groupWeight: 100,
          groupOverride: false,
          automationId: '',
          scanDepth: null,
          caseSensitive: null,
          matchWholeWords: null,
          source: 'global',
          sourceRef: 'g',
          templateCondition: 'variables.score >= 1',
        } as never,
      ],
      messages: [{ role: 'user', content: 'start' }],
      settings: DEFAULT_WI_SETTINGS,
      timerState: EMPTY_TIMER_STATE,
      contextWindowTokens: 4096,
      reservedTokens: 256,
      seed: 7,
      templates: baseTemplateCtx,
    })
    expect(wiRes.activated).toHaveLength(1)

    // 随后的回复阶段模板恢复应命中保留下来的同一份沙箱缓存（cacheHits + 1）
    const replyCtx: TemplateContext = {
      ...baseTemplateCtx,
      variables: assembled.templateVariables!,
      messageVariables: assembled.templateMessageVariables,
      phase: 'output',
    }
    const rendered = await isolated('template', {
      texts: ['score=<%- getLocalVar("score") %>'],
      context: replyCtx,
      replay: assembled.templateReplay,
    })
    expect(rendered.texts[0]).toBe('score=2')
    expect(isolatedWorkerStats().cacheHits).toBe(hitsBefore + 1)
  })
})
