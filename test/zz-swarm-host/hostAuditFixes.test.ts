/**
 * Host / Agent / 预设投影 / 空闲维护 / 楼层并发与边界加固回归测试。
 * 使用真实临时文件系统与工厂替身验证：
 * 1. 预设投影在宿主保留空文本 system-prompt 尾节点时取最近非空系统提示，以及前导 developer 消息间隔下不重复计入 SDK；
 * 2. DeepSeek 预设适配器随 fiber dispose 释放底层注册句柄，缺少 listConfigurableProviders 时优雅回退；
 * 3. 非 DeepSeek Tavern 会话在采样改写 reasoningEffort 后消费换模选择，agent/request probe 合入预设采样与解绑回退；
 * 4. 记忆维护（压缩/别名）期间删卡不复活僵尸目录、陈旧 pending 压缩标记自动消解、预排队输入立即让路、换绑取消在途维护；
 * 5. 插件分支同步豁免宿主接管、楼层续写与 fork 并发换绑/开层屏障、onTurnEnd 延迟轮清理、草稿目录拒绝符号链接、只读工具复用无楼层句柄及人设别名缓存失效。
 */
import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, symbols } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import {
  LlmRuntime,
  MessageId,
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
  freezeMessage,
  type GenerateOptions,
  type Message,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { apply as applyHost, Config as HostConfig } from '../../src/index.js'
import { apply as applyAgent } from '../../src/agent.js'
import { BOUND_DISCIPLINE, TURN_PLAYBOOK } from '../../src/core/dshPrompt.js'
import { defaultPreset } from '../../src/core/assemble.js'
import { resolveConfig, type TavernConfigRaw, type TavernSettingsScope } from '../../src/node/config.js'
import { deleteEditorDraft, getEditorDraft, saveEditorDraft } from '../../src/node/editorDrafts.js'
import { FloorError, continueFloor, isPluginForkSession, rollbackToFloor } from '../../src/node/floors.js'
import { impersonate } from '../../src/node/impersonate.js'
import { compressOldestMemories, registerMemoryMaintenance } from '../../src/node/memoryMaintenance.js'
import { installTavernModelSelectionCompat } from '../../src/node/modelRoute.js'
import type { TavernPaths } from '../../src/node/paths.js'
import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER, registerPresetAdapter } from '../../src/node/presetAdapter.js'
import { attachPresetPlanMessage, projectPresetRequest, type PresetRequestPlan } from '../../src/node/presetRequestProjection.js'
import { TavernService } from '../../src/node/service.js'
import { onTurnEnd } from '../../src/node/sessionLifecycle.js'
import { CharacterArchivedError, TavernState } from '../../src/node/state.js'
import { registerTavernTools } from '../../src/node/tools.js'
import { WorkspaceLinkError } from '../../src/state/workspaceFs.js'

const tempDirs: string[] = []
const activeContexts: Context[] = []

async function createTempPaths(prefix = 'zz-swarm-host-'): Promise<TavernPaths> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  tempDirs.push(root)
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

afterEach(async () => {
  for (const ctx of activeContexts.splice(0).reverse()) {
    await ctx.fiber.dispose().catch(() => {})
  }
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('预设请求投影边界修复', () => {
  it('宿主保留空文本 system-prompt 尾节点时按最近非空 system 投影，且跳过空尾节点', () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('proj-dormant-tail'), { agentPreset: 'tavern' })
    const standingText = `${BOUND_DISCIPLINE}\n\n角色骨架：阿星`
    const activeSystem = freezeMessage({
      ...createSystemMessage(`HOST_TOOLS_SDK\n\n${standingText}`),
      id: MessageId('sys-head'),
      source: { kind: 'system-prompt' } as Message['source'],
    })
    const dormantTail = freezeMessage({
      ...createSystemMessage(''),
      id: MessageId('sys-dormant-tail'),
      source: { kind: 'system-prompt' } as Message['source'],
    })
    const rawUser = createUserMessage({ content: [{ type: 'text', text: '早上好' }], source: { kind: 'user' } })
    const plan: PresetRequestPlan = {
      version: 1,
      sessionId: session.id,
      turn: 1,
      standingText,
      contextText: TURN_PLAYBOOK,
      layout: {
        version: 1,
        history: [{ inputIndex: 0, messageId: rawUser.id, role: 'user', chat: true }],
        entries: [{
          key: 'preset:main',
          role: 'system',
          content: '预设前置说明',
          sourceKeys: ['preset:main'],
          turnLocal: false,
          placement: { kind: 'before-history' },
        }],
      },
    }
    const carrier = attachPresetPlanMessage(rawUser, plan)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', carrier, { surfaceOp: 'append' })

    const projected = projectPresetRequest({
      provider: PRESET_ADAPTER_SOURCE_PROVIDER,
      model: 'deepseek-chat',
      sessionId: session.id,
      messages: [activeSystem, carrier, dormantTail],
    }, session, {
      messagesApi: true,
      model: { systemPromptUpdate: 'in-history', context: { contextWindow: 65536 }, defaultMaxTokens: 4096 },
    })

    expect(projected.messages[0]?.role).toBe('system')
    const firstText = projected.messages[0]?.content[0]?.type === 'text' ? projected.messages[0].content[0].text : ''
    expect(firstText).toContain('HOST_TOOLS_SDK')
    expect(firstText).toContain(BOUND_DISCIPLINE)
    expect(firstText).not.toContain('角色骨架：阿星')
    expect(firstText).toContain('预设前置说明')
    expect(projected.messages.some(m => m.id === dormantTail.id)).toBe(false)
  })

  it('messagesApi + in-history 下前导区含 developer 消息时不把 SDK 重复计入两份快照', () => {
    const ctx = new Context()
    activeContexts.push(ctx)
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('proj-leading-dev'), { agentPreset: 'tavern' })
    const standingText = `${BOUND_DISCIPLINE}\n\n角色设定`
    const sdkMarker = 'UNIQUE_HOST_TOOLS_SDK_MARKER'
    const hostSystem = freezeMessage({
      ...createSystemMessage(`${sdkMarker}\n\n${standingText}`),
      id: MessageId('sys-0'),
      source: { kind: 'system-prompt' } as Message['source'],
    })
    const devMsg = freezeMessage({
      id: MessageId('dev-0'),
      role: 'developer',
      content: [{ type: 'text', text: 'Tool schema delta' }],
      source: { kind: 'tool-addition' } as unknown as Message['source'],
    })
    const rawUser = createUserMessage({ content: [{ type: 'text', text: '继续前进' }], source: { kind: 'user' } })
    const assistantMsg = createAssistantMessage({
      content: [{ type: 'text', text: '前方是雾林。' }],
      source: { provider: PRESET_ADAPTER_SOURCE_PROVIDER, model: 'deepseek-chat' },
    })
    const user2 = createUserMessage({ content: [{ type: 'text', text: '拔出短剑' }], source: { kind: 'user' } })
    const plan: PresetRequestPlan = {
      version: 1,
      sessionId: session.id,
      turn: 2,
      standingText,
      contextText: TURN_PLAYBOOK,
      layout: {
        version: 1,
        history: [
          { inputIndex: 0, messageId: rawUser.id, role: 'user', chat: true },
          { inputIndex: 1, messageId: assistantMsg.id, role: 'assistant', chat: true },
          { inputIndex: 2, messageId: user2.id, role: 'user', chat: true },
        ],
        entries: [
          {
            key: 'preset:before',
            role: 'system',
            content: '前置扮演规则',
            sourceKeys: ['preset:before'],
            turnLocal: false,
            placement: { kind: 'before-history' },
          },
          {
            key: 'preset:depth1',
            role: 'system',
            content: '深度系统提醒',
            sourceKeys: ['preset:depth1'],
            turnLocal: true,
            placement: {
              kind: 'depth',
              depth: 1,
              order: 100,
              previous: { inputIndex: 0, messageId: rawUser.id, role: 'user', chat: true },
              next: { inputIndex: 1, messageId: assistantMsg.id, role: 'assistant', chat: true },
            },
          },
        ],
      },
    }
    const carrier = attachPresetPlanMessage(user2, plan)
    session.append('turn/start', { turn: 1 })
    session.append('user/message', rawUser, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: assistantMsg, stream: [] }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    session.append('user/message', carrier, { surfaceOp: 'append' })

    const projected = projectPresetRequest({
      provider: PRESET_ADAPTER_SOURCE_PROVIDER,
      model: 'deepseek-chat',
      sessionId: session.id,
      messages: [hostSystem, devMsg, rawUser, assistantMsg, carrier],
    }, session, {
      messagesApi: true,
      model: { systemPromptUpdate: 'in-history', context: { contextWindow: 65536 }, defaultMaxTokens: 4096 },
    })

    const systemBlocks = projected.messages.filter(m => m.role === 'system')
    // 前导 hostSystem + TURN_PLAYBOOK + preset:before 合并为首条，加中途 depth1 共两条 system 快照
    expect(systemBlocks).toHaveLength(2)
    expect(projected.messages[1]?.id).toBe(devMsg.id)
    const depthSnapshotText = systemBlocks[1]!.content[0]?.type === 'text' ? systemBlocks[1]!.content[0].text : ''
    expect(depthSnapshotText.split(sdkMarker)).toHaveLength(2)
    expect(depthSnapshotText).toContain('前置扮演规则')
    expect(depthSnapshotText).toContain('深度系统提醒')
  })
})

describe('DeepSeek 预设适配器生命周期与目录降级', () => {
  it('子插件 fiber 卸载时释放 LlmRuntime 注册句柄，重新挂载不会触发 DUPLICATE_ADAPTER；缺 listConfigurableProviders 仍可读取设置', async () => {
    const rootCtx = new Context()
    activeContexts.push(rootCtx)
    const realLlm = new LlmRuntime(rootCtx)
    void realLlm
    rootCtx.provide('settings' as any, {
      describe: () => [{ ns: 'llm-deepseek-api-key', revision: 1, value: { apiKey: 'test-key', baseUrl: 'https://api.deepseek.com' } }],
    })

    // 1) 在真实 LlmRuntime 上挂载并卸载，验证函数型 AdapterRegistrationHandle 被正确调用移除
    let controller1!: ReturnType<typeof registerPresetAdapter>
    const fiber1 = rootCtx.plugin((sub) => {
      controller1 = registerPresetAdapter(sub, (options) => options)
    })
    await fiber1
    controller1.ensureRegistered()
    expect(rootCtx.get('llm')!.listProviders().some(p => p.id === PRESET_ADAPTER_PROVIDER)).toBe(true)

    await fiber1.dispose()
    expect(rootCtx.get('llm')!.listProviders().some(p => p.id === PRESET_ADAPTER_PROVIDER)).toBe(false)

    let controller2!: ReturnType<typeof registerPresetAdapter>
    const fiber2 = rootCtx.plugin((sub) => {
      controller2 = registerPresetAdapter(sub, (options) => options)
    })
    await fiber2
    expect(() => controller2.ensureRegistered()).not.toThrow()
    await fiber2.dispose()

    // 2) 替身 llm 不提供 listConfigurableProviders 时回退默认 SETTINGS_NS
    const minimalCtx = new Context()
    activeContexts.push(minimalCtx)
    const registered: string[] = []
    minimalCtx.provide('settings' as any, {
      describe: () => [{ ns: 'llm-deepseek-api-key', revision: 1, value: { apiKey: 'test-key', baseUrl: 'https://api.deepseek.com' } }],
    })
    minimalCtx.provide('llm' as any, {
      registerAdapter: (ids: string[]) => { registered.push(...ids); return () => {} },
    })
    const controller3 = registerPresetAdapter(minimalCtx, (options) => options)
    expect(() => controller3.ensureRegistered()).not.toThrow()
    expect(registered).toEqual([PRESET_ADAPTER_PROVIDER])
  })
})

describe('模型选择兼容与 agent/request probe 对齐', () => {
  it('非 DeepSeek 的 Tavern 会话在采样覆写 reasoningEffort 后仍消费 controller.agents 待定选择，不影响普通会话', async () => {
    const rootCtx = new Context()
    activeContexts.push(rootCtx)
    new SessionStore(rootCtx)
    const tavernSession = rootCtx.sessions.create(SessionId('tavern-openai'))
    tavernSession.append('agent-preset/selected', { agentPreset: 'tavern' })
    const plainSession = rootCtx.sessions.create(SessionId('plain-openai'))
    plainSession.append('agent-preset/selected', { agentPreset: 'default' })

    const tavernConsume = vi.fn()
    const plainConsume = vi.fn()
    const tavernAgent = { session: tavernSession }
    const plainAgent = { session: plainSession }
    rootCtx.provide('agents' as any, {
      get: (id: string) => (id === tavernSession.id ? tavernAgent : id === plainSession.id ? plainAgent : undefined),
    })
    rootCtx.provide('sessionController' as any, {
      agents: {
        consumeSelection: () => false,
        selections: new Map<unknown, unknown>([
          [tavernAgent, { current: { provider: 'openai', model: 'gpt-5', reasoningEffort: 'low' }, consume: tavernConsume }],
          [plainAgent, { current: { provider: 'openai', model: 'gpt-5', reasoningEffort: 'low' }, consume: plainConsume }],
        ]),
      },
    })
    installTavernModelSelectionCompat(rootCtx)

    rootCtx.emit('session/event' as any, plainSession, {
      type: 'request/header',
      data: { header: { config: { provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' } } },
    })
    expect(plainConsume).not.toHaveBeenCalled()

    rootCtx.emit('session/event' as any, tavernSession, {
      type: 'request/header',
      data: { header: { config: { provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' } } },
    })
    expect(tavernConsume).toHaveBeenCalledWith('openai', 'gpt-5', 'low')
  })

  it('agent/request probe 遵循全局采样回退与预设采样合并，解绑会话将 tavern-deepseek 还原为官方路由', async () => {
    const paths = await createTempPaths('agent-probe-')
    let rawConfig: TavernConfigRaw = { sampling: { temperature: 0.65, maxTokens: 2048, thinking: 'disabled', stop: ['</END>'] } }
    const state = new TavernState(paths, () => resolveConfig(rawConfig))
    await state.init()
    const ensureRegistered = vi.fn()
    state.presetAdapter = { ensureRegistered }
    const { cardId } = await state.createCharacter('Probe 测试卡')
    const preset = {
      ...defaultPreset(),
      identifier: 'probe-preset',
      name: 'Probe 预设',
      sampling: { temperature: undefined, maxTokens: 4096, topP: 1, frequencyPenalty: 0, presencePenalty: 0, stop: ['[STOP]'] },
    }
    const { id: presetId } = await state.savePresetSnapshot(preset as any)

    let requestHook: ((payload: any, next: () => Promise<any>) => Promise<any>) | undefined
    const llmStub = { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } }) }
    const services: Record<string, unknown> = { tavern: { state }, llm: llmStub }
    const mockCtx = {
      tavern: { state },
      llm: llmStub,
      get: (key: string) => services[key],
      systemPrompt: { section: () => () => {}, context: () => () => {}, assemble: () => () => {} },
      tools: { register: () => () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      effect: () => {},
      on: (name: string, fn: any) => {
        if (name === 'agent/request') requestHook = fn
        return () => {}
      },
    } as unknown as Context
    applyAgent(mockCtx)
    expect(requestHook).toBeTypeOf('function')

    // 未绑定会话：probe 将遗留 tavern-deepseek 映射回 deepseek-official
    const unboundRes = await requestHook!(
      { probe: true, agent: { id: 'unbound-s', options: {} } },
      async () => ({ provider: PRESET_ADAPTER_PROVIDER, model: 'deepseek-chat', messages: [] }),
    )
    expect(unboundRes.provider).toBe(PRESET_ADAPTER_SOURCE_PROVIDER)

    // 已绑定会话：preset.sampling.temperature=undefined 不冲掉 state.config.sampling.temperature(0.65)
    await state.saveBinding({
      sessionId: 'bound-s',
      cardId,
      presetId,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const boundRes = await requestHook!(
      { probe: true, agent: { id: 'bound-s', options: {} } },
      async () => ({ provider: PRESET_ADAPTER_SOURCE_PROVIDER, model: 'deepseek-reasoner', reasoningEffort: 'high', messages: [] }),
    )
    expect(ensureRegistered).toHaveBeenCalledTimes(1)
    expect(boundRes).toMatchObject({
      provider: PRESET_ADAPTER_PROVIDER,
      temperature: 0.65,
      maxTokens: 4096,
      stop: ['[STOP]'],
      reasoningEffort: 'off',
    })
  })
})

describe('记忆空闲维护与换绑并发安全', () => {
  it('压缩辅助流在途期间解绑并永久删除角色，迟到流返回后不会复活已删角色/剧情目录', async () => {
    const paths = await createTempPaths('maint-delete-race-')
    const state = new TavernState(paths, () => resolveConfig({ memory: { maxEntries: 1, compressBatch: 2 } }))
    await state.init()
    const { cardId } = await state.createCharacter('待删维护卡')
    await state.saveBinding({
      sessionId: 'maint-del-s',
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadStoryBinding('maint-del-s'))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)
    await ws.memory.write({ body: '旧事实一' })
    await ws.memory.write({ body: '旧事实二' })

    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const llm = {
      async *stream(): AsyncIterable<StreamChunk> {
        entered.resolve()
        await release.promise
        yield { type: 'text-delta', text: '合并后的事实' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as unknown as LlmRuntime

    const compressPromise = compressOldestMemories(state, llm, cardId, 'factory', 'factory-model', binding.storyId)
    await entered.promise

    await state.clearBinding('maint-del-s')
    await state.archiveCharacter(cardId)
    const plan = await state.characterDeletePlan(cardId)
    await state.deleteCharacter(cardId, { discardStoryIds: plan.stories.map(s => s.id) })

    release.resolve()
    expect(await compressPromise).toBeNull()
    await expect(lstat(join(paths.characters, cardId))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('陈旧 pendingMemoryCompress 在容量恢复后自动清除并立即放行别名扩充；预排队用户输入使别名扩充让路', async () => {
    const paths = await createTempPaths('maint-stale-pending-')
    const state = new TavernState(paths, () => resolveConfig({ memory: { maxEntries: 5, aliasExpansion: true } }))
    await state.init()
    const { cardId } = await state.createCharacter('别名与陈旧标记卡')
    await state.saveBinding({
      sessionId: 'stale-pending-s',
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadStoryBinding('stale-pending-s'))!
    const ws = await state.storyWorkspace(cardId, binding.storyId)
    await ws.memory.write({ body: '北塔储水罐阀门锈死。' })
    // 模拟此前超限留下的陈旧压缩标记，但当前仅 1 条（<= maxEntries=5）
    state.pendingMemoryCompress.add(binding.storyId!)

    const ctx = new Context()
    activeContexts.push(ctx)
    new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {})
    const loop = new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
    const agent = await loop.create(SessionId('stale-pending-s'), { provider: 'factory', model: 'factory-model' })

    const calls: string[] = []
    const llm = {
      async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
        const text = (options.messages[0]?.content[0] as { text?: string } | undefined)?.text ?? ''
        calls.push(text)
        yield { type: 'text-delta', text: '1: 储水罐、阀门、供水故障' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as unknown as LlmRuntime
    registerMemoryMaintenance(ctx, state, llm)

    // 1) idle 之前收件箱已进入新消息：别名补全直接让路，不调用 LLM，也不消耗本轮标记
    agent.session.append('turn/start', { turn: 1 })
    agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const fakeAgentWithInbox = Object.create(agent, {
      inbox: { value: { nextTurn: [{ id: 'queued-user-msg' }], nextStep: [] } },
    }) as Agent
    ctx.emit('agent/status', { agent: fakeAgentWithInbox, status: 'idle' })
    await state.waitForSessionTasks(agent.id)
    await agent.whenIdle()
    expect(state.pendingMemoryCompress.has(binding.storyId!)).toBe(false)
    expect(calls).toHaveLength(0)

    // 2) 收件箱清空后同一轮再次回到 idle：陈旧压缩标记已消，直接完成别名补全
    ctx.emit('agent/status', { agent, status: 'idle' })
    await state.waitForSessionTasks(agent.id)
    await agent.whenIdle()
    expect(calls).toHaveLength(1)
    expect((await ws.memory.search('供水故障', { topK: 5 })).map(h => h.entry.body)).toEqual(['北塔储水罐阀门锈死。'])
  })

  it('service.clearSessionBinding 在 agent 处于 idle 维护相位时同步取消维护信号', async () => {
    const paths = await createTempPaths('service-cancel-maint-')
    const state = new TavernState(paths, () => resolveConfig({}))
    await state.init()
    const { cardId } = await state.createCharacter('换绑取消维护卡')
    await state.saveBinding({
      sessionId: 'maint-cancel-s',
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })

    const ctx = new Context()
    activeContexts.push(ctx)
    new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {})
    const loop = new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
    const agent = await loop.create(SessionId('maint-cancel-s'), { provider: 'factory', model: 'factory-model' })

    const entered = Promise.withResolvers<AbortSignal>()
    const maintDone = agent.runMaintenance(async (signal) => {
      entered.resolve(signal)
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
    })
    const signal = await entered.promise
    expect(agent.status).toBe('idle')

    const scope: TavernSettingsScope = {
      get: () => ({}),
      revision: () => 1,
      update: async () => {},
    }
    const service = new TavernService(ctx, state, scope)
    await service.clearSessionBinding({ sessionId: 'maint-cancel-s' })
    expect(signal.aborted).toBe(true)
    await maintDone
  })
})

describe('楼层并发屏障、编辑器草稿防链接、只读工具与收口健壮性', () => {
  it('continueFloor 在 openFloors 未提交或存在排队 nextTurn 输入时拒绝续写；fork 期间原会话解绑抛 binding-changed 并回收孤儿剧情', async () => {
    const paths = await createTempPaths('floors-race-')
    const state = new TavernState(paths, () => resolveConfig({}))
    await state.init()
    const { cardId } = await state.createCharacter('楼层并发卡')
    const ctx = new Context()
    activeContexts.push(ctx)
    new SessionStore(ctx)
    const session = ctx.sessions.create(SessionId('floor-src'))
    session.append('agent-preset/selected', { agentPreset: 'tavern' })
    const userMsg = createUserMessage({ content: [{ type: 'text', text: '推开门' }], source: { kind: 'user' } })
    const asstMsg = createAssistantMessage({ content: [{ type: 'text', text: '门后是一条长廊' }], source: { provider: 'factory', model: 'm' } })
    session.append('turn/start', { turn: 1 })
    session.append('user/message', userMsg, { surfaceOp: 'append' })
    session.append('assistant/message', { turn: 1, step: 1, message: asstMsg, stream: [] }, { surfaceOp: 'append' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    await state.saveBinding({
      sessionId: session.id,
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadStoryBinding(session.id))!

    // 1) openFloors 未释放时拒绝 continueFloor
    state.openFloors.set(session.id, { cardId, storyId: binding.storyId, floor: `${session.id}#t1` })
    await expect(continueFloor({ ctx, state }, session.id, asstMsg.id)).rejects.toMatchObject({ code: 'turn-open' })
    state.openFloors.delete(session.id)

    // 2) agent.inbox.nextTurn 已有排队消息时拒绝 continueFloor
    let queuedNextTurn: unknown[] = [{ id: 'pending-user' }]
    let disposedChild = false
    const mockAgents = {
      get: (id: string) => (id === session.id ? { id, ctx, options: { provider: 'factory', model: 'm' }, inbox: { nextTurn: queuedNextTurn } } : undefined),
      withoutInitiator: <T>(fn: () => T) => fn(),
      create: async ({ sessionId: childId }: { sessionId: string }) => {
        expect(isPluginForkSession(childId)).toBe(true)
        // 模拟 forkChildSession 等待期间用户对源会话解除绑定（不改 source.seq）
        await state.clearBinding(session.id)
        return {
          agent: { id: childId },
          dispose: async () => { disposedChild = true },
        }
      },
    }
    ctx.provide('agents' as any, mockAgents)
    Object.assign(ctx, { agents: mockAgents })
    ctx.provide('agentPresets' as any, {
      composedPreset: () => 'tavern',
      resolve: async (id: string) => ({ id }),
      mount: async () => {},
    })
    await expect(continueFloor({ ctx, state }, session.id, asstMsg.id)).rejects.toMatchObject({ code: 'turn-open' })
    queuedNextTurn = []

    // 3) rollbackToFloor 在 forkChildSession 期间遇到源会话解绑：抛 FloorError('binding-changed') 并清理子会话与孤儿剧情
    const storiesBefore = await state.listStories(cardId)
    await expect(rollbackToFloor({ ctx, state }, session.id, asstMsg.id)).rejects.toSatisfy(
      (err: unknown) => err instanceof FloorError && err.code === 'binding-changed',
    )
    expect(disposedChild).toBe(true)
    expect(await state.listStories(cardId)).toEqual(storiesBefore)
  })

  it('插件分支创建期间 session/created 同步豁免宿主分支接管（不登记 trackBindingAdoption）', async () => {
    const paths = await createTempPaths('host-plugin-fork-exempt-')
    const prevDshHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = paths.root
    try {
      const ctx = new Context()
      activeContexts.push(ctx)
      ctx.provide('settings' as any, {
        configure: () => () => {},
        describe: () => [{ ns: 'dsh-liketavern', revision: 1, value: {} }],
        update: async () => {},
      })
      new SessionStore(ctx)
      const hostAgents = {
        get: () => undefined,
        list: () => [],
        withoutInitiator: <T>(fn: () => T) => fn(),
        create: async () => ({ agent: {}, dispose: async () => {} }),
      }
      ctx.provide('agents' as any, hostAgents)
      Object.assign(ctx, { agents: hostAgents })
      ctx.provide('agentPresets' as any, {
        register: () => () => {},
        composedPreset: () => 'tavern',
        resolve: async (id: string) => ({ id }),
        mount: async () => {},
      })
      await applyHost(ctx, HostConfig({}))
      const tavern = ctx.get('tavern' as any) as { state: TavernState }
      const trackSpy = vi.spyOn(tavern.state, 'trackBindingAdoption')

      const { cardId } = await tavern.state.createCharacter('分支豁免测试卡')
      const parent = ctx.sessions.create(SessionId('parent-fork-src'))
      parent.append('agent-preset/selected', { agentPreset: 'tavern' })
      await tavern.state.saveBinding({
        sessionId: parent.id,
        cardId,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: false,
        greetingIndex: 0,
        createdAt: new Date(0).toISOString(),
      })
      const parentBinding = (await tavern.state.loadStoryBinding(parent.id))!
      parent.append('turn/start', { turn: 1 })
      parent.append('user/message', createUserMessage({ content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }), { surfaceOp: 'append' })
      const asst = createAssistantMessage({ content: [{ type: 'text', text: '你好！' }], source: { provider: 'factory', model: 'm' } })
      parent.append('assistant/message', { turn: 1, step: 1, message: asst, stream: [] }, { surfaceOp: 'append' })
      parent.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

      ctx.provide('workspaceRegistry' as any, {
        list: () => [{
          sessionIds: [parent.id],
          attachSession: async () => { throw new Error('模拟工作区挂载失败') },
        }],
      })
      hostAgents.create = (async ({ sessionId: childId }: { sessionId: string }) => {
        const child = ctx.sessions.create(SessionId(childId), { parentSession: parent.id, isSeeded: true })
        child.append('agent-preset/selected', { agentPreset: 'tavern' })
        return { agent: { id: childId }, dispose: async () => {} }
      }) as any

      await expect(rollbackToFloor({ ctx, state: tavern.state }, parent.id, asst.id)).rejects.toMatchObject({
        code: 'workspace-attach-failed',
      })
      expect(trackSpy).not.toHaveBeenCalled()
      expect((await tavern.state.loadStoryBinding(parent.id))?.storyId).toBe(parentBinding.storyId)
    } finally {
      if (prevDshHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = prevDshHome
    }
  })

  it('onTurnEnd 处理延迟轮次（deferredTurns）遇到绑定读取抛错时仍清理全部本轮运行态映射', async () => {
    const paths = await createTempPaths('deferred-turn-cleanup-')
    const state = new TavernState(paths, () => resolveConfig({}))
    await state.init()
    const sid = 'deferred-err-s'
    state.deferredTurns.set(sid, 3)
    state.currentTurns.set(sid, 3)
    state.currentSteps.set(sid, 1)
    state.pendingInputs.set(sid, ['待重放的用户台词'])
    state.pendingTemplateInputs.set(sid, ['待重放的模板输入'])
    vi.spyOn(state, 'loadStoryBinding').mockRejectedValueOnce(new CharacterArchivedError())

    const fakeSession = {
      id: sid,
      snapshotEvents: () => [
        { seq: 1, time: 0, type: 'turn/start', data: { turn: 3 } },
        { seq: 2, time: 0, type: 'turn/end', data: { turn: 3, reason: { kind: 'interrupted' } } },
      ],
    } as unknown as Pick<Session, 'id' | 'snapshotEvents'>

    await expect(onTurnEnd(state, sid, fakeSession)).resolves.toBeUndefined()
    expect(state.currentTurns.has(sid)).toBe(false)
    expect(state.currentSteps.has(sid)).toBe(false)
    expect(state.pendingInputs.has(sid)).toBe(false)
    expect(state.pendingTemplateInputs.has(sid)).toBe(false)
    expect(state.helperTurnClosures.get(`${sid}#t3`)).toMatchObject({ seq: 2, deferred: true })
  })

  it('editorDrafts 读写删拒绝符号链接/目录联接，不跨出草稿目录', async () => {
    const paths = await createTempPaths('editor-draft-link-')
    const owner = 'browser-owner-1234'
    const key = 'preset:main'
    const ownerHash = createHash('sha256').update(owner, 'utf8').digest('hex')
    const outside = await mkdtemp(join(tmpdir(), 'editor-draft-outside-'))
    tempDirs.push(outside)
    await writeFile(
      join(outside, `${createHash('sha256').update(key, 'utf8').digest('hex')}.json`),
      JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), value: { secret: 'leaked' } }),
    )
    await mkdir(join(paths.root, 'editor-drafts'), { recursive: true })
    await symlink(
      outside,
      join(paths.root, 'editor-drafts', ownerHash),
      process.platform === 'win32' ? 'junction' : 'dir',
    )

    await expect(getEditorDraft(paths.root, owner, key)).rejects.toBeInstanceOf(WorkspaceLinkError)
    await expect(saveEditorDraft(paths.root, owner, key, { text: 'overwrite' })).rejects.toBeInstanceOf(WorkspaceLinkError)
    await expect(deleteEditorDraft(paths.root, owner, key)).rejects.toBeInstanceOf(WorkspaceLinkError)
  })

  it('只读工具在存在陈旧跨轮 openFloors 时仍复用无楼层句柄；代答等待期间会话销毁不发孤儿流；人设删除同步作废原名缓存与默认项', async () => {
    const paths = await createTempPaths('tools-impersonate-persona-')
    let defaultPersonaId = 'Hero/Raw Name'
    const state = new TavernState(paths, () => resolveConfig({ defaults: { personaId: defaultPersonaId } }))
    await state.init()
    const { cardId } = await state.createCharacter('综合验证卡')
    await state.saveBinding({
      sessionId: 'tool-read-s',
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadStoryBinding('tool-read-s'))!
    const handle = await state.storyWorkspace(cardId, binding.storyId)
    await handle.memory.write({ body: '酒馆地下室藏着旧地图。' })
    // 故意挂一个旧轮遗留 openFloors：只读工具仍应正常工作且不报错，写工具则拒绝写入
    state.openFloors.set('tool-read-s', { cardId, storyId: binding.storyId, floor: 'tool-read-s#t1' })
    state.currentTurns.set('tool-read-s', 2)

    const registeredTools = new Map<string, (args: any, exec: any) => Promise<any>>()
    const toolCtx = {
      tools: {
        register: (tool: any) => {
          registeredTools.set(tool.name, (args, exec) => tool.execute(args, exec))
          return () => {}
        },
      },
    } as unknown as Context
    registerTavernTools(toolCtx, state)

    const exec = { agent: { id: 'tool-read-s', inject: () => {} } }
    const searchOut = await registeredTools.get('tavern_memory_search')!({ query: '地图' }, exec)
    expect(searchOut.results).toHaveLength(1)

    const writeOut = await registeredTools.get('tavern_memory_write')!({ body: '不应写入旧楼层' }, exec)
    expect(writeOut).toMatchObject({ ok: false })
    state.openFloors.delete('tool-read-s')

    // 代答：resolveModelInfo 异步期间会话从 ctx.sessions 移除，stream 不应被调用
    const impCtx = new Context()
    activeContexts.push(impCtx)
    const impSession = Session.create(SessionId('tool-read-s'))
    impSession.append('agent-preset/selected', { agentPreset: 'tavern' })
    const sessionsMap = new Map<string, Session>([[impSession.id, impSession]])
    const impSessions = {
      list: () => [...sessionsMap.values()],
      get: (id: string) => sessionsMap.get(id),
    }
    impCtx.provide('sessions' as any, impSessions)
    Object.assign(impCtx, { sessions: impSessions })
    let streamCalled = false
    const impAgents = {
      get: (id: string) => (id === impSession.id ? { id, ctx: impCtx, session: impSession, options: { provider: 'factory', model: 'm' } } : undefined),
    }
    impCtx.provide('agents' as any, impAgents)
    Object.assign(impCtx, { agents: impAgents })
    const impLlm = {
      resolveModelInfo: async () => {
        sessionsMap.delete(impSession.id)
        return {}
      },
      async *stream() {
        streamCalled = true
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    }
    impCtx.provide('llm' as any, impLlm)
    Object.assign(impCtx, { llm: impLlm })
    await expect(impersonate({ ctx: impCtx, state }, impSession.id)).rejects.toMatchObject({ code: 'session-not-live' })
    expect(streamCalled).toBe(false)

    // 人设：带特殊字符 sourceId 的人设保存、缓存读取与删除，同步清除原名修订缓存及 defaults.personaId
    const scope: TavernSettingsScope = {
      get: () => ({ defaults: { personaId: defaultPersonaId } }),
      revision: () => 1,
      update: async (patch: any) => {
        if (patch.defaults?.personaId !== undefined) defaultPersonaId = patch.defaults.personaId
      },
    }
    const service = new TavernService(new Context(), state, scope)
    const savedPersona = await service.savePersona({
      persona: { id: 'Hero/Raw Name', name: '勇者', description: '持剑旅人', avatar: null, lorebookId: null },
    })
    expect(savedPersona.id).not.toBe('Hero/Raw Name')
    expect((await state.loadPersona('Hero/Raw Name'))?.name).toBe('勇者')

    await service.deletePersona({ id: savedPersona.id })
    expect(await state.loadPersona('Hero/Raw Name')).toBeNull()
    expect(defaultPersonaId).toBe('')
  })

  it('真实 Cordis 子插件卸载期间 disposeSession 不把已卸载的宿主服务误判为临时会话并清除持久绑定', async () => {
    const paths = await createTempPaths('cordis-fiber-dispose-')
    const prevDshHome = process.env['DSH_HOME']
    process.env['DSH_HOME'] = paths.root
    try {
      const rootCtx = new Context()
      activeContexts.push(rootCtx)
      rootCtx.provide('settings' as any, {
        configure: () => () => {},
        describe: () => [{ ns: 'dsh-liketavern', revision: 1, value: {} }],
        update: async () => {},
      })
      new SessionStore(rootCtx)
      const hostAgents = { get: () => undefined, list: () => [] }
      rootCtx.provide('agents' as any, hostAgents)
      Object.assign(rootCtx, { agents: hostAgents })

      const childFiber = rootCtx.plugin(async (sub) => {
        await applyHost(sub, HostConfig({}))
      })
      await childFiber
      const tavern = rootCtx.get('tavern' as any) as { state: TavernState }
      const { cardId } = await tavern.state.createCharacter('子插件卸载保留绑定卡')
      const session = rootCtx.sessions.create(SessionId('persisted-across-unload'))
      session.append('agent-preset/selected', { agentPreset: 'tavern' })
      await tavern.state.saveBinding({
        sessionId: session.id,
        cardId,
        presetId: null,
        personaId: null,
        lorebookIds: [],
        characterLorebookId: null,
        interactiveCards: false,
        greetingIndex: 0,
        createdAt: new Date(0).toISOString(),
      })

      // 先在活跃期触发 session/disposed 并卡在 waitForSessionTasks，待 rootCtx 完全卸载后再放行恢复
      const gate = Promise.withResolvers<void>()
      const pendingTask = tavern.state.enqueueSessionTask(session.id, () => gate.promise)
      rootCtx.emit('session/disposed', session)
      await rootCtx.fiber.dispose()
      gate.resolve()
      await pendingTask
      await new Promise((resolve) => setTimeout(resolve, 20))

      const coldState = new TavernState(tavern.state.paths, () => resolveConfig({}))
      await coldState.init()
      expect((await coldState.loadStoryBinding(session.id))?.cardId).toBe(cardId)
    } finally {
      if (prevDshHome === undefined) delete process.env['DSH_HOME']
      else process.env['DSH_HOME'] = prevDshHome
    }
  })

  it('registerPresetAdapter 在 releaseRegistration 同步触发 llm/adapters-updated 时不双注册，fiber 卸载后拒绝再注册', async () => {
    const rootCtx = new Context()
    activeContexts.push(rootCtx)
    const llm1Ctx = new Context()
    activeContexts.push(llm1Ctx)
    const llm1 = new LlmRuntime(llm1Ctx)
    const llm2Ctx = new Context()
    activeContexts.push(llm2Ctx)
    const llm2 = new LlmRuntime(llm2Ctx)
    // 转发底层 LlmRuntime 的同步 llm/adapters-updated 事件到 rootCtx，复现真实宿主重入链路
    llm1Ctx.on('llm/adapters-updated', () => rootCtx.emit('llm/adapters-updated'))
    llm2Ctx.on('llm/adapters-updated', () => rootCtx.emit('llm/adapters-updated'))
    let currentLlm = llm1
    rootCtx.provide('llm' as any, {
      get [symbols.original]() { return currentLlm },
      listProviders: () => currentLlm.listProviders(),
      registerAdapter: (ids: string[], adapter: any) => currentLlm.registerAdapter(ids, adapter),
    })
    rootCtx.provide('settings' as any, {
      describe: () => [{ ns: 'llm-deepseek-api-key', revision: 1, value: { apiKey: 'test-key', baseUrl: 'https://api.deepseek.com' } }],
    })

    let controller!: ReturnType<typeof registerPresetAdapter>
    const fiber = rootCtx.plugin((sub) => {
      controller = registerPresetAdapter(sub, (o) => o)
      sub.on('llm/adapters-updated', () => {
        if (sub.fiber.uid === null || sub.fiber.state === 4 || sub.fiber.state === 5) return
        controller.ensureRegistered()
      })
    })
    await fiber
    controller.ensureRegistered()
    expect(llm1.listProviders().some(p => p.id === PRESET_ADAPTER_PROVIDER)).toBe(true)

    // 模拟底层 LlmRuntime 实例替换：旧句柄释放时会同步触发 llm/adapters-updated，不应触发 DUPLICATE_ADAPTER
    currentLlm = llm2
    expect(() => controller.ensureRegistered()).not.toThrow()
    expect(llm1.listProviders().some(p => p.id === PRESET_ADAPTER_PROVIDER)).toBe(false)
    expect(llm2.listProviders().some(p => p.id === PRESET_ADAPTER_PROVIDER)).toBe(true)

    await fiber.dispose()
    expect(llm2.listProviders().some(p => p.id === PRESET_ADAPTER_PROVIDER)).toBe(false)
    expect(() => controller.ensureRegistered()).toThrow(/disposed/)
    expect(llm2.listProviders().some(p => p.id === PRESET_ADAPTER_PROVIDER)).toBe(false)
  })

  it('agent/request probe 校验 turn 一致性且无布局旧轮不路由至预设适配器；维护期间 card.json 暂时损坏保留 pending 标记', async () => {
    const paths = await createTempPaths('probe-and-corrupt-card-')
    const state = new TavernState(paths, () => resolveConfig({
      sampling: { temperature: 0.7, maxTokens: 1024, thinking: 'disabled', stop: [] },
      memory: { maxEntries: 1, compressBatch: 2 },
    }))
    await state.init()
    state.presetAdapter = { ensureRegistered: () => {} }
    const { cardId } = await state.createCharacter('旧轮与坏卡测试')
    await state.saveBinding({
      sessionId: 'legacy-probe-s',
      cardId,
      presetId: null,
      personaId: null,
      lorebookIds: [],
      characterLorebookId: null,
      interactiveCards: false,
      greetingIndex: 0,
      createdAt: new Date(0).toISOString(),
    })
    const binding = (await state.loadStoryBinding('legacy-probe-s'))!

    // 1) probe：turn=1 的旧无布局计划在 turn=1 probe 时回退官方路由，在 turn=2 probe 时不误复用旧采样
    state.turnPlans.set('legacy-probe-s', {
      turn: 1,
      cardId,
      storyId: binding.storyId,
      result: {
        standingKey: 'k',
        standing: '',
        turnContext: '',
        system: '',
        history: [],
        userName: 'User',
        logLines: [],
        sampling: { temperature: 1.25, maxTokens: 512, topP: 1, frequencyPenalty: 0, presencePenalty: 0, thinking: 'disabled', stop: [] },
      } as any,
    })

    let requestHook: ((payload: any, next: () => Promise<any>) => Promise<any>) | undefined
    const llmStub = { resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: 'off' }] } }) }
    const services: Record<string, unknown> = { tavern: { state }, llm: llmStub }
    applyAgent({
      tavern: { state },
      llm: llmStub,
      get: (k: string) => services[k],
      systemPrompt: { section: () => () => {}, context: () => () => {}, assemble: () => () => {} },
      tools: { register: () => () => {} },
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      effect: () => {},
      on: (name: string, fn: any) => { if (name === 'agent/request') requestHook = fn; return () => {} },
    } as unknown as Context)

    const legacyTurn1 = await requestHook!(
      { probe: true, turn: 1, agent: { id: 'legacy-probe-s', options: {} } },
      async () => ({ provider: PRESET_ADAPTER_PROVIDER, model: 'deepseek-chat', messages: [] }),
    )
    expect(legacyTurn1).toMatchObject({ provider: PRESET_ADAPTER_SOURCE_PROVIDER, temperature: 1.25, maxTokens: 512 })

    const mismatchTurn2 = await requestHook!(
      { probe: true, turn: 2, agent: { id: 'legacy-probe-s', options: {} } },
      async () => ({ provider: PRESET_ADAPTER_SOURCE_PROVIDER, model: 'deepseek-chat', messages: [] }),
    )
    expect(mismatchTurn2).toMatchObject({ provider: PRESET_ADAPTER_PROVIDER, temperature: 0.7, maxTokens: 1024 })

    // 2) 维护期间 card.json 被写坏（非删除）：拒绝归档且保留 pendingMemoryCompress，修复后可继续压缩
    const ws = await state.storyWorkspace(cardId, binding.storyId)
    await ws.memory.write({ body: '第一条待压缩事实' })
    await ws.memory.write({ body: '第二条待压缩事实' })
    state.pendingMemoryCompress.add(binding.storyId!)

    const cardJsonPath = join(paths.characters, cardId, 'card.json')
    const validCardJson = await (await state.workspace(cardId)).fs.readText('card.json')
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const compressLlm = {
      async *stream(): AsyncIterable<StreamChunk> {
        entered.resolve()
        await release.promise
        yield { type: 'text-delta', text: '修复后合并成功' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as unknown as LlmRuntime

    const firstAttempt = compressOldestMemories(state, compressLlm, cardId, 'factory', 'm', binding.storyId)
    await entered.promise
    await writeFile(cardJsonPath, '{corrupted-json')
    state.invalidateSessionArchiveCard(cardId)
    release.resolve()
    expect(await firstAttempt).toBeNull()
    expect(state.pendingMemoryCompress.has(binding.storyId!)).toBe(true)
    expect(await ws.memory.list()).toHaveLength(2)

    await writeFile(cardJsonPath, validCardJson!)
    state.invalidateSessionArchiveCard(cardId)
    const retryLlm = {
      async *stream(): AsyncIterable<StreamChunk> {
        yield { type: 'text-delta', text: '修复后合并成功' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    } as unknown as LlmRuntime
    const secondAttempt = await compressOldestMemories(state, retryLlm, cardId, 'factory', 'm', binding.storyId)
    expect(secondAttempt?.archived).toBe(2)
  })
})
