/**
 * Node 宿主编排与酒馆助手桥接层缺陷修复回归测试：
 * - C1: impersonate() 透传采样 thinking 派生的 reasoningEffort（例如关闭 DeepSeek 思考）
 * - C2: dsh-tavern-agent 的 agent/request 中间件位于 dsh-compaction-basic 内层，Turn 2+ 不触发伪换模压缩
 * - C3: projectPresetRequest（messagesApi: true）跳过空内容 user/assistant（宿主 Retry），避免 DeepSeekAdapter 报错
 * - C4: drainBindingAdoption 在解除绑定与销毁会话时取消失败重试，不再反向触发新一轮接管
 * - C5 & C6: adoptHostFork、rollbackToFloor、editAssistantMessage、setSessionBinding、clearSessionBinding 使用 preserve，不锁死坏人设也不偷绑默认人设
 * - D1: 世界书/MVU 开关/变量桥在锁外等待绑定接管，锁内不反向等待，避免与 adoptHostFork 互锁
 * - D2 & D3: 公共世界书同名副本就地保存不产生重复文件；聊天世界书绑定数组格式公共书正常包装
 * - D4: commitHelperVariables 与 withHelperStoryWrite 拒绝静默提交未收口宿主 WAL 楼层及 prepared 模板生成
 * - D5: 已有更新的中断/超长 WAL 楼层时，已初始化故事播种脚本落到最新楼层不炸，未初始化故事延后初始化不死锁
 * - D6: continueFloor 在开启原生 MVU 且最后回复被编辑（无终止帧）或错误结束时前置拒绝，不开注定卡死的续写轮
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  LlmRuntime,
  type GenerateOptions,
  type LlmCallConfig,
  type LlmStreamEvent,
} from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply as applyTavernAgent } from '../src/agent.js'
import { BOUND_DISCIPLINE } from '../src/core/dshPrompt.js'
import { DEFAULT_SAMPLING } from '../src/core/types.js'
import { resolveConfig } from '../src/node/config.js'
import { continueFloor, editAssistantMessage, rollbackToFloor } from '../src/node/floors.js'
import { ensureHelperMvuScriptAnchor, helperMvuPending, prepareHelperMvuJob } from '../src/node/helperMvu.js'
import { enableHelperMvu } from '../src/node/helperMvuEnable.js'
import { commitHelperVariables, getHelperSnapshot, withHelperStoryWrite } from '../src/node/helperRuntime.js'
import { getHelperWorldbookContext, helperWorldbookOperation, rebindHelperWorldbooks } from '../src/node/helperWorldbook.js'
import { impersonate } from '../src/node/impersonate.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER } from '../src/node/presetAdapter.js'
import { attachPresetPlanMessage, projectPresetRequest } from '../src/node/presetRequestProjection.js'
import { TavernService } from '../src/node/service.js'
import { onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { loadHelperState, saveHelperState } from '../src/state/helper.js'
import { withWorkspaceLock } from '../src/state/workspaceLock.js'

let root: string
let state: TavernState
let cardId: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-node-audit-'))
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
  cardId = (await state.createCharacter('审查角色')).cardId
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

async function bindSession(sessionId: string, overrides: Partial<Parameters<TavernState['saveBinding']>[0]> = {}) {
  await state.saveBinding({
    sessionId,
    cardId,
    presetId: null,
    personaId: null,
    lorebookIds: [],
    characterLorebookId: null,
    interactiveCards: true,
    greetingIndex: 0,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  })
  return (await state.loadStoryBinding(sessionId))!
}

describe('Node 与 Helper 层缺陷修复回归', () => {
  it('C1: impersonate() 遵循 sampling.thinking 透传 reasoningEffort 到 llm.stream', async () => {
    const noThinkState = new TavernState(state.paths, () =>
      resolveConfig({ sampling: { ...DEFAULT_SAMPLING, thinking: 'disabled' } }),
    )
    await noThinkState.init()
    await bindSession('imp-s1')

    const ctx = new Context()
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('imp-s1'))
    session.append('agent-preset/selected', { agentPreset: 'tavern' })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' } }), { surfaceOp: 'append' })

    const seenOptions: GenerateOptions[] = []
    const llm = {
      resolveModelInfo: async () => ({
        reasoning: {
          supported: true,
          efforts: ['off', 'low', 'high'],
          defaultEffort: 'high',
        },
      }),
      stream: (options: GenerateOptions) => {
        seenOptions.push(options)
        return (async function* (): AsyncIterable<LlmStreamEvent> {
          yield { type: 'text-delta', text: '代答台词' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const fakeAgent = {
      id: session.id,
      session,
      options: { provider: PRESET_ADAPTER_SOURCE_PROVIDER, model: 'deepseek-chat', maxTokens: 1024 },
    }
    const fakeCtx = {
      sessions: { get: (id: string) => (id === session.id ? session : undefined) },
      agents: { get: (id: string) => (id === session.id ? fakeAgent : undefined) },
      get: (name: string) => (name === 'llm' ? llm : undefined),
    } as unknown as Context

    const result = await impersonate({ ctx: fakeCtx, state: noThinkState }, 'imp-s1')
    expect(result.text).toBe('代答台词')
    expect(seenOptions).toHaveLength(1)
    expect(seenOptions[0]!.reasoningEffort).toBe('off')
    await ctx.fiber.dispose()
  })

  it('C2: dsh-tavern-agent 的 agent/request 运行于前置 compaction 中间件内层，使外层看到重写后的 tavern-deepseek', async () => {
    const binding = await bindSession('c2-s1')
    const ctx = new Context()
    ctx.provide('tavern', { state } as never)
    ctx.provide('systemPrompt', {
      getSectionOrder: () => 5000,
      section: () => () => {},
      context: () => () => {},
    } as never)
    ctx.provide('tools', { register: () => () => {} } as never)
    new LlmRuntime(ctx)

    // 模拟宿主启动时最先注册的 dsh-compaction-basic（带 { prepend: true }）。
    let outerSeenProvider: string | undefined
    ctx.on(
      'agent/request',
      async (_payload, next) => {
        const cfg = await next()
        outerSeenProvider = cfg.provider
        return cfg
      },
      { prepend: true },
    )

    state.presetAdapter = { ensureRegistered: () => {} } as never
    state.turnPlans.set('c2-s1', {
      turn: 2,
      cardId: binding.cardId,
      storyId: binding.storyId,
      result: {
        sampling: { ...DEFAULT_SAMPLING },
        layout: { version: 1, entries: [], history: [] },
      } as never,
    } as never)

    applyTavernAgent(ctx)

    const resolved = await ctx.waterfall(
      'agent/request',
      {
        agent: { id: 'c2-s1', options: {} },
        turn: 2,
        step: 1,
        signal: new AbortController().signal,
      } as never,
      async () => ({ provider: PRESET_ADAPTER_SOURCE_PROVIDER, model: 'deepseek-chat' }) as LlmCallConfig,
    )
    expect(resolved.provider).toBe(PRESET_ADAPTER_PROVIDER)
    expect(outerSeenProvider).toBe(PRESET_ADAPTER_PROVIDER)
    await ctx.fiber.dispose()
  })

  it('C3: projectPresetRequest（messagesApi: true）跳过空内容 Retry user 消息，避免在 assistant 后发出非法 in-history system', async () => {
    const ctx = new Context()
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('c3-s1'))
    const u1 = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } })
    const a1 = createAssistantMessage({ content: [{ type: 'text', text: 'hello' }], source: { provider: 'deepseek-official', model: 'deepseek-chat' } })
    const retryUser = attachPresetPlanMessage(
      createUserMessage({ content: [], source: { kind: 'retry' } as never }),
      {
        version: 1,
        sessionId: session.id,
        turn: 2,
        layout: {
          version: 1,
          history: [
            { inputIndex: 0, messageId: u1.id, role: 'user', chat: true },
            { inputIndex: 1, messageId: a1.id, role: 'assistant', chat: true },
          ],
          entries: [
            {
              key: 'depth-sys',
              role: 'system',
              content: 'TRAILING-SYSTEM',
              sourceKeys: ['preset:depth'],
              turnLocal: true,
              placement: { kind: 'after-history' },
            },
          ],
        },
        standingText: `${BOUND_DISCIPLINE}\nSTANDING`,
        contextText: 'TURN',
        cacheFirst: false,
      },
    )
    session.append('turn/start', { turn: 1 })
    session.append('user/message', u1, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: a1, stream: [] }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', retryUser, { surfaceOp: 'append' })

    const diagnostics: unknown[] = []
    const projected = projectPresetRequest(
      {
        provider: PRESET_ADAPTER_PROVIDER,
        model: 'deepseek-chat',
        sessionId: session.id,
        messages: [createSystemMessage(`HOST-SYS\n\n${BOUND_DISCIPLINE}\nSTANDING`), u1, a1, retryUser],
      },
      session,
      {
        messagesApi: true,
        model: { id: 'deepseek-chat', systemPromptUpdate: 'in-history' } as never,
        onDiagnostic: (d) => diagnostics.push(d),
      },
    )
    // 因为空 content 的 retryUser 会被 DeepSeekAdapter 跳过，尾部 system 必须安全合并进首条 system，并上报诊断。
    expect(diagnostics.some((d) => (d as { kind?: string }).kind === 'messages-system-layout')).toBe(true)
    const systemMsgs = projected.messages.filter((m) => m.role === 'system')
    expect(systemMsgs).toHaveLength(1)
    expect(JSON.stringify(systemMsgs[0]!.content)).toContain('TRAILING-SYSTEM')
    await ctx.fiber.dispose()
  })

  it('C4: drainBindingAdoption 丢弃待重试接管任务，clearSessionBinding 不反向触发新的接管重试', async () => {
    let attempts = 0
    await expect(
      state.trackBindingAdoption('c4-s1', async () => {
        attempts++
        throw new Error('first adoption failed')
      }),
    ).rejects.toThrow('first adoption failed')
    expect(attempts).toBe(1)

    const ctx = new Context()
    new SessionStore(ctx)
    const service = new TavernService(ctx, state)
    await service.clearSessionBinding({ sessionId: 'c4-s1' })
    expect(attempts).toBe(1)
    await ctx.fiber.dispose()
  })

  it('C5 & C6: 损坏人设文件不锁死 setSessionBinding / clearSessionBinding / rollbackToFloor / editAssistantMessage，且分叉保留 personaId=null', async () => {
    // 创建一个默认人设与一个损坏人设文件。
    await state.savePersona({ id: 'default-p', name: 'DefaultUser', description: 'desc', avatar: '', isDefault: true })
    await writeFile(join(state.paths.personas, 'broken.json'), '{broken json')

    const ctx = new Context()
    new SessionStore(ctx)
    const service = new TavernService(ctx, state)

    // 绑定指向损坏人设：仍允许改绑和解绑，不被 resolve 锁死。
    await bindSession('c6-s1', { personaId: 'broken' })
    await expect(
      service.setSessionBinding({
        binding: {
          sessionId: 'c6-s1',
          cardId,
          presetId: null,
          personaId: null,
          lorebookIds: [],
          characterLorebookId: null,
          interactiveCards: true,
          greetingIndex: 0,
          createdAt: new Date(0).toISOString(),
        },
      }),
    ).resolves.toEqual({ saved: true })
    expect((await state.loadStoryBinding('c6-s1'))!.personaId).toBeNull()

    await bindSession('c6-s2', { personaId: 'broken' })
    await expect(service.clearSessionBinding({ sessionId: 'c6-s2' })).resolves.toEqual({ cleared: true })

    // C5: rollbackToFloor / editAssistantMessage 在 personaId=null 时不得偷绑为 default-p，且损坏人设也不阻断操作。
    await bindSession('c5-s1', { personaId: null })
    const source = ctx.sessions.create(SessionId('c5-s1'))
    source.append('agent-preset/selected', { agentPreset: 'tavern' })
    source.append('turn/start', { turn: 1 })
    source.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    const a1 = createAssistantMessage({ content: [{ type: 'text', text: 'hello' }], source: { provider: 'factory', model: 'factory' } })
    source.append('assistant/message', { turn: 1, step: 1, message: a1, stream: [] }, { surfaceOp: 'append' })
    source.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const createdSessions = new Map<string, Session>()
    const fakeCtx = {
      sessions: {
        get: (id: string) => (id === source.id ? source : createdSessions.get(id)),
        messageProjections: ctx.sessions.messageProjections,
      },
      agents: {
        get: () => undefined,
        withoutInitiator: <T,>(fn: () => T) => fn(),
        create: async (opts: { sessionId: string }) => {
          const child = ctx.sessions.create(SessionId(opts.sessionId))
          createdSessions.set(opts.sessionId, child)
          return { agent: { id: child.id, session: child, followup: () => {}, whenIdle: async () => {} }, dispose: async () => {} }
        },
      },
      get: (name: string) =>
        name === 'workspace'
          ? { attachSession: async () => {} }
          : name === 'workspaceRegistry'
            ? { list: () => [] }
            : name === 'agentPresets'
              ? { resolve: async (id: string) => ({ id }), composedPreset: () => 'tavern', mount: () => () => {} }
              : undefined,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    } as unknown as Context

    const rolled = await rollbackToFloor({ ctx: fakeCtx, state }, 'c5-s1', a1.id)
    expect((await state.loadStoryBinding(rolled.childSessionId))!.personaId).toBeNull()

    const edited = await editAssistantMessage({ ctx: fakeCtx, state }, 'c5-s1', a1.id, 'edited hello')
    expect((await state.loadStoryBinding(edited.childSessionId))!.personaId).toBeNull()
    await ctx.fiber.dispose()
  })

  it('D1: 并发 host-fork adoption 持有/等待 sessions 锁时，世界书与 MVU 开关桥不发生 AB/BA 死锁', async () => {
    const binding = await bindSession('d1-s1')
    const adoptionEntered = Promise.withResolvers<void>()
    const releaseAdoption = Promise.withResolvers<void>()
    const adoption = state.trackBindingAdoption('d1-s1', async () => {
      adoptionEntered.resolve()
      await releaseAdoption.promise
      // 模拟 adoptHostFork 尾段需要获取 sessions 锁。
      await withWorkspaceLock(state.paths.sessions, async () => {})
      return true
    })
    await adoptionEntered.promise

    // 在 adoption 等待期间发起 getHelperWorldbookContext 和 enableHelperMvu：它们必须在 sessions 锁外等待 adoption。
    const wbCall = getHelperWorldbookContext(state, 'd1-s1', binding.storyId!)
    const fakeCtx = { agents: { get: () => undefined } } as unknown as Context
    const mvuCall = enableHelperMvu(fakeCtx, state, { sessionId: 'd1-s1', storyId: binding.storyId!, mode: 'explicit' })

    // 放行 adoption；如果存在 AB/BA 互锁，此处会永远挂死。
    releaseAdoption.resolve()
    await adoption
    const [wb, mvu] = await Promise.all([wbCall, mvuCall])
    expect(wb.storyId).toBe(binding.storyId)
    expect(mvu.enabled).toBe(true)
  })

  it('D2 & D3: 同名公共世界书就地更新不新建副本；聊天世界书绑定数组格式公共书正常保存', async () => {
    const binding = await bindSession('d2-s1')
    const id1 = await state.saveLorebook('dup', { name: 'SharedName', entries: { '0': { uid: 0, key: ['k1'], content: 'v1' } } })
    // 人为制造第二个同名公共世界书文件（名称不同 id，但内部 name 相同）。
    await writeFile(
      join(state.paths.lorebooks, 'dup-2.json'),
      JSON.stringify({ name: 'SharedName', entries: { '0': { uid: 0, key: ['k2'], content: 'v2' } } }),
    )
    // 数组格式公共世界书。
    await writeFile(
      join(state.paths.lorebooks, 'arr-book.json'),
      JSON.stringify([{ uid: 0, key: ['ak'], content: 'array-lore' }]),
    )
    expect(id1).toBe('dup')

    const ctx = new Context()
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('d2-s1'))
    const a1 = createAssistantMessage({ content: [{ type: 'text', text: 'hello' }], source: { provider: 'factory', model: 'factory' } })
    session.append('turn/start', { turn: 1 })
    const a1Event = session.append('assistant/message', { turn: 1, step: 1, message: a1, stream: [] }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const fakeCtx = {
      sessions: { get: () => session },
      get: () => undefined,
    } as unknown as Context

    const wbCtx = await getHelperWorldbookContext(state, 'd2-s1', binding.storyId!)
    const got = await helperWorldbookOperation(fakeCtx, state, 'd2-s1', a1Event.seq, {
      storyId: binding.storyId!,
      bindingRevision: wbCtx.bindingRevision,
      name: 'dup-2',
      operation: 'get',
    })
    expect(got.snapshot?.name).toBe('dup-2')

    // D2: 修改 dup-2 必须就地写回 dup-2，不能创建 dup-2-2.json。
    const updated = await helperWorldbookOperation(fakeCtx, state, 'd2-s1', a1Event.seq, {
      storyId: binding.storyId!,
      bindingRevision: wbCtx.bindingRevision,
      name: 'dup-2',
      operation: 'replace',
      revision: got.snapshot!.revision,
      entries: [{ ...got.snapshot!.entries[0]!, content: 'v2-updated' }],
    })
    expect(updated.snapshot?.name).toBe('dup-2')
    expect(await state.listLorebooks()).not.toContain('dup-2-2')
    const rawDup2 = JSON.parse((await state.loadLorebookJson('dup-2')) ? JSON.stringify(await state.loadLorebookJson('dup-2')) : '{}')
    expect(JSON.stringify(rawDup2)).toContain('v2-updated')

    // D3: 将数组格式公共书绑定为聊天世界书，不应抛出「聊天世界书必须为对象」。
    const rebound = await rebindHelperWorldbooks(fakeCtx, state, 'd2-s1', a1Event.seq, {
      storyId: binding.storyId!,
      bindingRevision: wbCtx.bindingRevision,
      kind: 'chat',
      selection: 'arr-book',
    })
    expect(rebound.chat).toMatch(/^@dsh\/chat\//)
    await ctx.fiber.dispose()
  })

  it('D4: commitHelperVariables 与 withHelperStoryWrite 拒绝提交未收口宿主 WAL 楼层或覆盖 prepared 模板生成', async () => {
    const binding = await bindSession('d4-s1')
    const ws = await state.storyWorkspace(binding.cardId, binding.storyId!)
    const ctx = new Context()
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('d4-s1'))
    const a1 = createAssistantMessage({ content: [{ type: 'text', text: 'hello' }], source: { provider: 'factory', model: 'factory' } })
    session.append('turn/start', { turn: 1 })
    const a1Event = session.append('assistant/message', { turn: 1, step: 1, message: a1, stream: [] }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const fakeCtx = { sessions: { get: () => session }, get: () => undefined } as unknown as Context

    // 场景 1: 宿主楼层 session#t1 处于未提交（committed=false）状态。
    await ws.wal.beginFloor('d4-s1#t1')
    const histRev = (await getHelperSnapshot(fakeCtx, state, 'd4-s1', a1Event.seq)).historyRevision
    await expect(
      commitHelperVariables(fakeCtx, state, {
        sessionId: 'd4-s1',
        messageId: a1Event.seq,
        storyId: binding.storyId!,
        historyRevision: histRev,
        changes: [{ key: '["chat",""]', before: {}, value: { x: 1 } }],
      }),
    ).rejects.toThrow('未收口的宿主事务')
    await expect(
      withHelperStoryWrite(fakeCtx, state, 'd4-s1', a1Event.seq, binding.storyId!, async (_fs, begin) => {
        await begin()
      }),
    ).rejects.toThrow('未收口的宿主事务')
    // 楼层必须保持 uncommitted！
    expect((await ws.wal.validateFloor('d4-s1#t1')).committed).toBe(false)

    // 场景 2: 楼层已提交但存在真实 prepared 模板生成，同样拒绝覆盖。
    await ws.wal.commitFloor('d4-s1#t1')
    await state.saveCharacter(cardId, { description: '<% setvar("seen", 1) %>desc' })
    const live2 = ctx.sessions.create(SessionId('d4-s2'))
    const binding2 = await bindSession('d4-s2')
    const ws2 = await state.storyWorkspace(binding2.cardId, binding2.storyId!)
    live2.append('agent-preset/selected', { agentPreset: 'tavern' })
    live2.append('turn/start', { turn: 1 })
    live2.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    await onTurnStart(state, 'd4-s2', 1, live2)
    await runTavernPipeline({ state, sessionId: 'd4-s2', agent: null, mode: 'live', historyOverride: [{ role: 'user', content: 'hi' }] })
    // 模拟楼层已提交且离开生成态（turn/end 落盘，openFloors 释放），但 generation 仍停在 prepared。
    const a2Event = live2.append('assistant/message', { turn: 1, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: 'reply' }], source: { provider: 'factory', model: 'factory' } }), stream: [] }, { surfaceOp: 'append' })
    live2.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await ws2.wal.commitFloor('d4-s2#t1')
    state.openFloors.delete('d4-s2')
    const fakeCtx2 = { sessions: { get: () => live2 }, get: () => undefined } as unknown as Context
    const histRev2 = (await getHelperSnapshot(fakeCtx2, state, 'd4-s2', a2Event.seq)).historyRevision
    await expect(
      commitHelperVariables(fakeCtx2, state, {
        sessionId: 'd4-s2',
        messageId: a2Event.seq,
        storyId: binding2.storyId!,
        historyRevision: histRev2,
        changes: [{ key: '["chat",""]', before: {}, value: { x: 2 } }],
      }),
    ).rejects.toThrow('模板楼层尚未收口')
    await expect(
      withHelperStoryWrite(fakeCtx2, state, 'd4-s2', a2Event.seq, binding2.storyId!, async (_fs, begin) => {
        await begin()
      }),
    ).rejects.toThrow('模板楼层尚未收口')
    await ctx.fiber.dispose()
  })

  it('D5: 中断/超长轮产生较新 WAL 楼层后，已初始化故事播种脚本不崩溃，未初始化故事延后初始化不死锁', async () => {
    const binding = await bindSession('d5-s1', { helperMvu: true })
    const ws = await state.storyWorkspace(binding.cardId, binding.storyId!)
    const ctx = new Context()
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('d5-s1'))
    const a1 = createAssistantMessage({ content: [{ type: 'text', text: 'first' }], source: { provider: 'factory', model: 'factory' } })
    const a2 = createAssistantMessage({ content: [{ type: 'text', text: 'partial' }], source: { provider: 'factory', model: 'factory' } })
    session.append('turn/start', { turn: 1 })
    const a1Event = session.append('assistant/message', { turn: 1, step: 1, message: a1, stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'stop' } } }] }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('assistant/message', { turn: 2, step: 1, message: a2, stream: [{ type: 'chunk', time: 0, chunk: { type: 'finish', reason: { kind: 'max-tokens' } } }] }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 2, reason: { kind: 'max-tokens' } })
    const fakeCtx = { sessions: { get: () => session }, get: () => undefined } as unknown as Context

    // 两个楼层均已提交（turn 2 因 max-tokens 结束）。
    await ws.wal.beginFloor('d5-s1#t1'); await ws.wal.commitFloor('d5-s1#t1')
    await ws.wal.beginFloor('d5-s1#t2'); await ws.wal.commitFloor('d5-s1#t2')

    // D5b: 尚未初始化时，ensureHelperMvuScriptAnchor / prepareHelperMvuJob / helperMvuPending 延后到下一次正常 stop，不抛错也不死锁！
    expect(await ensureHelperMvuScriptAnchor(fakeCtx, state, 'd5-s1', binding.storyId!)).toBeNull()
    expect((await prepareHelperMvuJob(fakeCtx, state, { sessionId: 'd5-s1', storyId: binding.storyId!, runtimeId: 'rt' })).status).toBe('waiting')
    expect(await helperMvuPending(state, 'd5-s1', true, 1)).toBe(false)

    // D5a: 已初始化后新增脚本：getHelperScriptBundle / ensureHelperMvuScriptAnchor 必须把静态 data 播种到最新楼层 d5-s1#t2 而不报「已有新的 WAL 楼层」。
    await ws.wal.reopenFloor('d5-s1#t2')
    await saveHelperState(ws.fs.withFloor('d5-s1#t2'), {
      version: 1,
      scopes: { [JSON.stringify(['message', a1.id])]: { stat_data: { hp: 10 } } },
      extras: {},
      mvu: { version: 1, initialized: true, pending: [], completed: [] },
    })
    await ws.wal.commitFloor('d5-s1#t2')
    const lib = await state.getHelperScriptLibrary({ type: 'global' })
    await state.saveHelperScriptLibrary(lib.target, lib.revision, [
      { type: 'script', value: { id: 'new-script', name: 'new', enabled: true, content: '', info: '', button: { enabled: false, buttons: [] }, data: { seeded: 1 } } },
    ])
    const anchor = await ensureHelperMvuScriptAnchor(fakeCtx, state, 'd5-s1', binding.storyId!)
    expect(anchor).toBe(a1Event.seq)
    expect((await ws.wal.validateFloor('d5-s1#t2')).committed).toBe(true)
    const savedHelper = await loadHelperState(ws.fs)
    expect(savedHelper.scopes[JSON.stringify(['script', 'new-script'])]).toEqual({ seeded: 1 })
    await ctx.fiber.dispose()
  })

  it('D6: 开启原生 MVU 时，continueFloor 对编辑过（无 finish）或错误结束的回复前置拒绝，不创建注定卡死的续写轮', async () => {
    await bindSession('d6-s1', { helperMvu: true })
    const ctx = new Context()
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('d6-s1'))
    session.append('agent-preset/selected', { agentPreset: 'tavern' })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    // 模拟编辑后的 assistant 消息：无 stream finish 且无 stat_data。
    const editedAssistant = createAssistantMessage({ content: [{ type: 'text', text: 'edited partial' }], source: { provider: 'factory', model: 'factory' } })
    session.append('assistant/message', { turn: 1, step: 1, message: editedAssistant, stream: [] }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    const followup = vi.fn()
    const fakeCtx = {
      sessions: { get: () => session },
      agents: { get: () => ({ id: session.id, session, followup }) },
      get: () => undefined,
    } as unknown as Context

    await expect(continueFloor({ ctx: fakeCtx, state }, 'd6-s1', editedAssistant.id)).rejects.toThrow(/续写来源没有可恢复/)
    expect(followup).not.toHaveBeenCalled()
    // 未产生任何未提交 WAL 楼层。
    const binding = (await state.loadStoryBinding('d6-s1'))!
    const ws = await state.storyWorkspace(binding.cardId, binding.storyId!)
    expect(await ws.wal.listFloors()).toEqual([])
    await ctx.fiber.dispose()
  })
})
