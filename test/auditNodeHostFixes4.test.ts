/**
 * Node / Host / Helper / Adapter 第四轮审计修复回归测试（N1–N6）：
 * - N1: disposeSession 在持久化会话卸载时保留 forkedSessionParents 与绑定，无 .stat 持久化服务 fail-closed，
 *       确认删除后清理绑定、hostForkIdentity、hostForkAdoption 并撤销活动卡面租约
 * - N2: saveBinding 撤销失效旧卡面租约释放 1024 预算，rebindHelperWorldbooks 同步保留当前写入帧
 * - N3: helper 变量写入超 4 MiB 时在开启 WAL 楼层前预检失败，不遗留未提交楼层
 * - N4: registerPresetAdapter 在 llm 实例重启或 provider 缺失时自动重新注册适配器
 * - N5: installTavernModelSelectionCompat 在 ctx.fiber.dispose() 卸载时清理监听、还原投影补丁并允许重新安装
 * - N6: impersonate 换模后第一轮优先跟随未消费 model/selection，不泄漏上一模型的旧 reasoningEffort
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, symbols } from '@deepseek-ai/cordis'
import {
  createAssistantMessage,
  createUserMessage,
  type GenerateOptions,
  type LlmStreamEvent,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.js'
import { DEFAULT_SAMPLING } from '../src/core/types.js'
import { resolveConfig, TAVERN_NS, TavernConfigSchema, type TavernConfigRaw } from '../src/node/config.js'
import { helperFrameWriteGuard, openHelperFrame } from '../src/node/helperFrameLease.js'
import { commitHelperVariables, getHelperSnapshot } from '../src/node/helperRuntime.js'
import { getHelperWorldbookContext, rebindHelperWorldbooks } from '../src/node/helperWorldbook.js'
import { readHostForkAdoption, writeHostForkAdoption } from '../src/node/hostForkAdoption.js'
import { writeHostForkIdentity } from '../src/node/hostForkIdentity.js'
import { impersonate } from '../src/node/impersonate.js'
import { installTavernModelSelectionCompat, sessionModelRoute } from '../src/node/modelRoute.js'
import {
  PRESET_ADAPTER_PROVIDER,
  PRESET_ADAPTER_SOURCE_PROVIDER,
  registerPresetAdapter,
} from '../src/node/presetAdapter.js'
import { forkedSessionParents } from '../src/node/sessionArchiveSnapshot.js'
import { loadHelperState, saveHelperState, serializeHelperState } from '../src/state/helper.js'
import { TavernState } from '../src/node/state.js'

let root: string
const contexts: Context[] = []

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-node-audit4-'))
})

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

function makeState(pathsRoot = root, configOverride: Partial<TavernConfigRaw> = {}) {
  return new TavernState(
    {
      root: pathsRoot,
      characters: join(pathsRoot, 'characters'),
      lorebooks: join(pathsRoot, 'library/lorebooks'),
      presets: join(pathsRoot, 'library/presets'),
      personas: join(pathsRoot, 'personas'),
      regexDir: join(pathsRoot, 'regex'),
      sessions: join(pathsRoot, 'sessions'),
    },
    () => resolveConfig(configOverride),
  )
}

describe('Node / Host / Helper / Adapter 第四轮审计修复回归', () => {
  it('N1: disposeSession 对持久化会话保留 forkedSessionParents，对缺少 stat 的 persistence 保守保留绑定，确认删除时清理接管记录与卡面租约', async () => {
    const prevHome = process.env.DSH_HOME
    process.env.DSH_HOME = root
    try {
      const ctx = new Context()
      contexts.push(ctx)
      const rawConfig = (TavernConfigSchema as (input: unknown) => TavernConfigRaw)({})
      const config = Object.fromEntries(Object.entries(rawConfig).map(([k, v]) => [k, { get: () => v }])) as any
      const sessionsMap = new Map<string, Session>()
      let persistenceService: Record<string, unknown> = {
        stat: vi.fn(async (id: string) => (id === 's-persisted' ? { header: { id } } : undefined)),
      }

      ctx.provide('settings', {
        configure: vi.fn(),
        describe: () => [{ ns: TAVERN_NS, revision: 1, value: rawConfig }],
        update: vi.fn(),
      } as any)
      ctx.provide('sessions', {
        list: () => [...sessionsMap.values()],
        get: (id: string) => sessionsMap.get(id),
      } as any)
      ctx.provide('sessionPersistence' as any, new Proxy({}, {
        get(_t, prop) { return Reflect.get(persistenceService, prop) },
      }))
      ctx.provide('agents', { get: () => undefined } as any)
      ctx.provide('typert', { register: () => () => {} } as any)
      ctx.provide('workspaceRegistry', { list: () => [] } as any)
      ctx.provide('agentPresets', { register: vi.fn(async () => async () => {}) } as any)
      ctx.provide('logger', { warn: vi.fn(), info: vi.fn() } as any)

      await apply(ctx, config)
      const state: TavernState = (ctx.get('tavern') as any).state
      const { cardId } = await state.createCharacter('销毁保护卡')

      // 1) 持久化会话空闲卸载：保留绑定与 forkedSessionParents
      const persistedSession = Session.create(SessionId('s-persisted'))
      sessionsMap.set(persistedSession.id, persistedSession)
      forkedSessionParents.set(persistedSession.id, 'parent-1')
      await state.saveBinding({
        sessionId: persistedSession.id,
        cardId,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: null,
        greetingIndex: 0,
        createdAt: new Date(0).toISOString(),
      })
      sessionsMap.delete(persistedSession.id)
      ctx.emit('session/disposed', persistedSession)
      await new Promise((r) => setTimeout(r, 30))
      expect(await state.loadBinding(persistedSession.id)).not.toBeNull()
      expect(forkedSessionParents.get(persistedSession.id)).toBe('parent-1')
      forkedSessionParents.delete(persistedSession.id)

      // 2) 持久化服务缺失 .stat（接口漂移）：fail-closed 保留绑定
      const noStatSession = Session.create(SessionId('s-no-stat'))
      sessionsMap.set(noStatSession.id, noStatSession)
      await state.saveBinding({
        sessionId: noStatSession.id,
        cardId,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: null,
        greetingIndex: 0,
        createdAt: new Date(0).toISOString(),
      })
      persistenceService = {}
      sessionsMap.delete(noStatSession.id)
      ctx.emit('session/disposed', noStatSession)
      await new Promise((r) => setTimeout(r, 30))
      expect(await state.loadBinding(noStatSession.id)).not.toBeNull()

      // 3) 确认删除（stat 返回 undefined）：清理绑定、hostForkAdoption 与活动卡面租约
      persistenceService = { stat: vi.fn(async () => undefined) }
      const deletedSession = Session.create(SessionId('s-deleted'))
      deletedSession.append('assistant/message', {
        turn: 0,
        step: 1,
        message: createAssistantMessage({ content: [{ type: 'text', text: 'hi' }], source: { provider: 'p', model: 'm' } }),
      }, { surfaceOp: 'append' })
      sessionsMap.set(deletedSession.id, deletedSession)
      await state.saveBinding({
        sessionId: deletedSession.id,
        cardId,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: true,
        greetingIndex: 0,
        createdAt: new Date(0).toISOString(),
      })
      const binding = (await state.loadStoryBinding(deletedSession.id))!
      const lease = await openHelperFrame(ctx, state, {
        sessionId: deletedSession.id,
        storyId: binding.storyId!,
        messageId: deletedSession.snapshotEvents()[0]!.seq,
        frameId: 'frame-dispose-1',
        runtimeId: 'rt-1',
        epoch: 1,
        readOnly: false,
      })
      await writeHostForkIdentity(state.paths, deletedSession.id, 'parent-x', [])
      await writeHostForkAdoption(state.paths, {
        version: 1,
        status: 'unverified',
        sessionId: deletedSession.id,
        parentId: 'parent-x',
        inheritedCount: 0,
        seedHash: 'a'.repeat(64),
      })

      sessionsMap.delete(deletedSession.id)
      ctx.emit('session/disposed', deletedSession)
      await vi.waitFor(async () => {
        expect(await state.loadBinding(deletedSession.id)).toBeNull()
      })
      expect(await readHostForkAdoption(state.paths, deletedSession, [], 'parent-x')).toBeNull()
      const guard = helperFrameWriteGuard(state, { sessionId: deletedSession.id, storyId: binding.storyId! }, {
        frameId: 'frame-dispose-1',
        runtimeId: 'rt-1',
        epoch: 1,
        token: lease.token,
      })!
      expect(() => guard(binding)).toThrow(/租约已失效/)
    } finally {
      if (prevHome !== undefined) process.env.DSH_HOME = prevHome
      else delete process.env.DSH_HOME
    }
  })

  it('N2: saveBinding 撤销失效旧卡面租约，rebindHelperWorldbooks 同步保留写入帧自身租约', async () => {
    const state = makeState()
    await state.init()
    const { cardId } = await state.createCharacter('世界书租约卡')
    await state.saveLorebook('BookA', { entries: {} })
    const ctx = new Context()
    contexts.push(ctx)
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('s-lease'))
    session.append('assistant/message', {
      turn: 0,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'hello' }], source: { provider: 'p', model: 'm' } }),
    }, { surfaceOp: 'append' })
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: true,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadStoryBinding(session.id))!
    const msgSeq = session.snapshotEvents()[0]!.seq

    const writer = await openHelperFrame(ctx, state, {
      sessionId: session.id, storyId: binding.storyId!, messageId: msgSeq, frameId: 'frame-writer-01', runtimeId: 'rt-w', epoch: 1, readOnly: false,
    })
    const sibling = await openHelperFrame(ctx, state, {
      sessionId: session.id, storyId: binding.storyId!, messageId: msgSeq, frameId: 'frame-sibling-1', runtimeId: 'rt-s', epoch: 1, readOnly: false,
    })

    const writerGuard = helperFrameWriteGuard(state, { sessionId: session.id, messageId: msgSeq, storyId: binding.storyId! }, {
      frameId: 'frame-writer-01', runtimeId: 'rt-w', epoch: 1, token: writer.token,
    })!
    const siblingGuard = helperFrameWriteGuard(state, { sessionId: session.id, messageId: msgSeq, storyId: binding.storyId! }, {
      frameId: 'frame-sibling-1', runtimeId: 'rt-s', epoch: 1, token: sibling.token,
    })!

    const wbCtx = await getHelperWorldbookContext(state, session.id, binding.storyId!)
    await rebindHelperWorldbooks(ctx, state, session.id, msgSeq, {
      storyId: binding.storyId!,
      bindingRevision: wbCtx.bindingRevision,
      kind: 'global',
      selection: ['BookA'],
    }, writerGuard)

    const updatedBinding = (await state.loadStoryBinding(session.id))!
    // 写入帧自身租约随新绑定同步，仍可继续通过校验；兄弟帧因旧绑定指纹已立即被撤销
    expect(() => writerGuard(updatedBinding)).not.toThrow()
    expect(() => siblingGuard(updatedBinding)).toThrow(/租约已失效/)
  })

  it('N3: commitHelperVariables 超 4 MiB 时在开启 WAL 楼层前预检拒绝，不留下未提交 WAL 楼层', async () => {
    const state = makeState()
    await state.init()
    const { cardId } = await state.createCharacter('超限预检卡')
    const ctx = new Context()
    contexts.push(ctx)
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('s-oversize'))
    session.append('assistant/message', {
      turn: 0,
      step: 1,
      message: createAssistantMessage({ content: [{ type: 'text', text: 'hello' }], source: { provider: 'p', model: 'm' } }),
    }, { surfaceOp: 'append' })
    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: true,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadStoryBinding(session.id))!
    const ws = await state.storyWorkspace(cardId, binding.storyId!)
    const msgSeq = session.snapshotEvents()[0]!.seq
    const snap = await getHelperSnapshot(ctx, state, session.id, msgSeq)

    // 1) commitHelperVariables 写入合法 700 KiB chat 变量后，再写 500 KiB global 变量导致 scopes 超 1 MiB：
    //    必须在 reopenFloor 前预检失败，楼层保持 committed=true 不遗留未提交 WAL。
    const filler = 'a'.repeat(700_000)
    await commitHelperVariables(ctx, state, {
      sessionId: session.id,
      messageId: msgSeq,
      storyId: binding.storyId!,
      historyRevision: snap.historyRevision,
      changes: [{ key: JSON.stringify(['chat', '']), before: {}, value: { chunk: filler } }],
    })
    await expect(commitHelperVariables(ctx, state, {
      sessionId: session.id,
      messageId: msgSeq,
      storyId: binding.storyId!,
      historyRevision: snap.historyRevision,
      changes: [{ key: JSON.stringify(['global', '']), before: {}, value: { chunk2: 'b'.repeat(500_000) } }],
    })).rejects.toThrow(/超过预算/)

    const verified = await ws.wal.validateFloor(`${session.id}#t0`)
    expect(verified.committed).toBe(true)

    // 2) serializeHelperState 预检整文件 > 4 MiB 上限：四段各自严格 <= 1 MiB 通过单表检查，
    //    加上顶层 JSON 包装后超过 4 MiB，由 serializeHelperState 在开启 WAL 楼层前拦截。
    const { helperJson } = await import('../src/core/helperRuntime.js')
    const packNearLimit = (skeleton: (s: string) => unknown) => {
      let lo = 0, hi = 1024 * 1024
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        try { helperJson(skeleton('x'.repeat(mid))); lo = mid } catch { hi = mid - 1 }
      }
      return skeleton('x'.repeat(lo))
    }
    const scopes = packNearLimit((s) => ({ [JSON.stringify(['chat', ''])]: { a: s } })) as Record<string, Record<string, unknown>>
    const extras = packNearLimit((s) => ({ a: { a: s } })) as Record<string, Record<string, unknown>>
    const swipes = packNearLimit((s) => ({
      a: {
        active: 0,
        pages: [
          { message: 'p'.repeat(250 * 1024), data: {}, extra: {} },
          { message: 'p'.repeat(250 * 1024), data: {}, extra: {} },
          { message: 'p'.repeat(250 * 1024), data: {}, extra: {} },
          { message: 'p'.repeat(250 * 1024), data: {}, extra: {} },
          { message: s, data: {}, extra: {} },
        ],
      },
    })) as any
    const mvu = packNearLimit((s) => ({
      version: 1 as const,
      initialized: true,
      pending: [0, 1, 2, 3, 4].map((i) => ({
        id: `${i}`.padStart(64, '0'),
        identity: `m${i}`,
        kind: 'update' as const,
        seq: i + 1,
        turn: i + 1,
        floor: `${session.id}#t${i + 1}`,
        text: i < 4 ? 'q'.repeat(250 * 1024) : s,
      })),
      completed: [],
    })) as any
    expect(() => serializeHelperState({ scopes, extras, swipes, mvu })).toThrow(/酒馆助手状态文件超限/)
    expect(Object.keys((await loadHelperState(ws.fs)).scopes)).toHaveLength(1)
    void saveHelperState
  })

  it('N4: registerPresetAdapter 在 llm 重启或 provider 丢失后自动重新注册', () => {
    const ctx = new Context()
    contexts.push(ctx)
    const registeredProviders = new Set<string>([PRESET_ADAPTER_SOURCE_PROVIDER])
    let registerCalls = 0
    const makeLlm = () => ({
      listProviders: () => [...registeredProviders].map((id) => ({ id, name: id })),
      listConfigurableProviders: () => [{ id: PRESET_ADAPTER_SOURCE_PROVIDER, settingsNamespace: 'llm-deepseek-api-key', settingsPath: [] }],
      registerAdapter: vi.fn((ids: string[]) => {
        registerCalls++
        for (const id of ids) registeredProviders.add(id)
        return { replace: vi.fn(), dispose: vi.fn() }
      }),
    })
    let currentLlm = makeLlm()
    ctx.provide('settings', {
      describe: () => [{ ns: 'llm-deepseek-api-key', revision: 1, value: { apiKey: 'test-key', baseUrl: 'https://api.deepseek.com' } }],
    } as any)
    ctx.provide('llm' as any, {
      get [symbols.original]() { return currentLlm },
      listProviders: () => currentLlm.listProviders(),
      listConfigurableProviders: () => currentLlm.listConfigurableProviders(),
      registerAdapter: (ids: string[], adapter: unknown) => (currentLlm.registerAdapter as any)(ids, adapter),
    })

    const controller = registerPresetAdapter(ctx, (o) => o)
    controller.ensureRegistered()
    expect(registerCalls).toBe(1)

    // 同一实例且 provider 仍在：幂等不重注册
    controller.ensureRegistered()
    expect(registerCalls).toBe(1)

    // 模拟 provider 被清空：重新注册
    registeredProviders.delete(PRESET_ADAPTER_PROVIDER)
    controller.ensureRegistered()
    expect(registerCalls).toBe(2)

    // 模拟 llm 服务实例替换（重启）：重新注册到新实例
    currentLlm = makeLlm()
    controller.ensureRegistered()
    expect(registerCalls).toBe(3)
  })

  it('N5: installTavernModelSelectionCompat 随 ctx.fiber.dispose 还原投影补丁并允许再次安装', async () => {
    const rootCtx = new Context()
    contexts.push(rootCtx)
    const origApply = (state: unknown) => state
    const origParse = (input: unknown) => input
    const def = { key: 'modelSelection', apply: origApply, stateSchema: { parse: origParse } }
    const origRegister = vi.fn(() => () => {})
    const projections = {
      registrations: new Map([['modelSelection', { def }]]),
      register: origRegister,
    }
    rootCtx.provide('sessionProjections' as any, projections)

    const fiber1 = rootCtx.plugin((c) => { installTavernModelSelectionCompat(c) })
    await fiber1
    expect(def.apply).not.toBe(origApply)
    expect(projections.register).not.toBe(origRegister)

    await fiber1.dispose()
    expect(def.apply).toBe(origApply)
    expect(def.stateSchema.parse).toBe(origParse)
    expect(projections.register).toBe(origRegister)

    // 再次安装到同一 root 必须生效
    const fiber2 = rootCtx.plugin((c) => { installTavernModelSelectionCompat(c) })
    await fiber2
    expect(def.apply).not.toBe(origApply)
  })

  it('N6: impersonate 换模后第一轮优先跟随未消费 model/selection，不泄漏上一模型的旧 reasoningEffort', async () => {
    const state = makeState(root, { sampling: { ...DEFAULT_SAMPLING, thinking: 'enabled' } })
    await state.init()
    const { cardId } = await state.createCharacter('换模代答卡')
    await state.saveBinding({
      sessionId: 'imp-switch',
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: null,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    const ctx = new Context()
    contexts.push(ctx)
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('imp-switch'))
    session.append('agent-preset/selected', { agentPreset: 'tavern' })
    session.append('request/header', {
      header: { config: { provider: PRESET_ADAPTER_PROVIDER, model: 'deepseek-reasoner', reasoningEffort: 'high' } },
    } as any)
    session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
    // 用户在界面切到另一提供商模型且指定了 low 档（尚未发信，因此 requestHeader 仍指向旧模型 high 档）
    session.append('model/selection', { provider: 'openai', model: 'gpt-5', reasoningEffort: 'low' } as any)

    expect(sessionModelRoute({ options: {}, session } as any)).toEqual({
      provider: 'openai',
      model: 'gpt-5',
      reasoningEffort: 'low',
    })

    const seen: GenerateOptions[] = []
    const llm = {
      resolveModelInfo: async () => ({
        reasoning: { supported: true, efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
      }),
      stream: (options: GenerateOptions) => {
        seen.push(options)
        return (async function* (): AsyncIterable<LlmStreamEvent> {
          yield { type: 'text-delta', text: '你好' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
    const fakeAgent = { id: session.id, session, options: { provider: PRESET_ADAPTER_SOURCE_PROVIDER, model: 'deepseek-reasoner' } }
    const fakeCtx = {
      sessions: { get: (id: string) => (id === session.id ? session : undefined) },
      agents: { get: (id: string) => (id === session.id ? fakeAgent : undefined) },
      get: (name: string) => (name === 'llm' ? llm : undefined),
    } as unknown as Context

    const out = await impersonate({ ctx: fakeCtx, state }, session.id)
    expect(out.text).toBe('你好')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.provider).toBe('openai')
    expect(seen[0]!.model).toBe('gpt-5')
    expect(seen[0]!.reasoningEffort).toBe('low')
  })
})
