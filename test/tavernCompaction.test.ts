/** Tavern 压缩接入回归：真实预设注册表、Loader、AgentLoop、压缩与命令模块配合临时 JSONL/剧情文件，验证发现、自动/手动压缩、失败保真及后续请求。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Group from '@deepseek-ai/cordis-plugin-group'
import { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { AgentRegistry, installModelSelection, type Agent, type AgentModelSelection } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import { CommandRuntime } from '@deepseek-ai/dsh-commands'
import '@deepseek-ai/dsh-compaction-tool-result-pruner'
import { createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type LlmResolvedModelInfo, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { PtcRuntime } from '@deepseek-ai/dsh-ptc-runtime'
import { Session, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { apply as applyPersistence, Config as PersistenceConfig } from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import * as tavernAgent from '../src/agent.js'
import { resolveConfig } from '../src/node/config.js'
import { PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER } from '../src/node/presetAdapter.js'
import { installTavernPreset } from '../src/node/presetInstall.js'
import { projectPresetRequest, type PresetProjectionDiagnostic } from '../src/node/presetRequestProjection.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'

let root: string, ctx: Context, state: TavernState, agent: Agent, outside: Agent, cardId: string, storyId: string
const requests: GenerateOptions[] = [], errors: unknown[] = []
const projectedRequests: Array<{ options: GenerateOptions; diagnostics: PresetProjectionDiagnostic[] }> = []
let summaryFinish: 'stop' | 'max-tokens' = 'stop'
const SUMMARY = '旧剧情摘要：蓝钥匙藏在北门，双方约定黎明会合。'
const textOf = (message: Pick<Message, 'content'>) => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const summaryRequests = () => requests.filter(request => request.purpose === 'compaction')
const chatRequests = () => requests.filter(request => request.purpose !== 'compaction')

/** 只返回手写流；摘要调用仍完整走宿主 LLM、摘要事务与持久化路径，不访问真实模型。 */
class FactoryAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 128_000 }, systemPromptUpdate: 'in-history' }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    requests.push(options)
    if (options.provider === PRESET_ADAPTER_PROVIDER && options.sessionId) {
      const session = ctx.sessions.get(options.sessionId)
      if (session) {
        const diagnostics: PresetProjectionDiagnostic[] = []
        const projected = projectPresetRequest(options, session, {
          messagesApi: true,
          model: { systemPromptUpdate: 'in-history' },
          onDiagnostic: item => diagnostics.push(item),
        })
        projectedRequests.push({ options: projected, diagnostics })
      }
    }
    const summary = options.purpose === 'compaction'
    yield { type: 'text-delta', index: 0, text: summary ? SUMMARY : '角色继续回应。' }
    yield { type: 'finish', reason: { kind: summary ? summaryFinish : 'stop' } }
  }
}

/** 提供实际 PTC 呈现所需的能力声明；本文件不执行模型程序，意外工具执行必须明确失败。 */
class FactoryPtcRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'process'
  resolve(): never { throw new Error('压缩回归不应执行 PTC 程序') }
  async run(): Promise<never> { throw new Error('压缩回归不应执行 PTC 程序') }
}

async function send(text: string): Promise<void> {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle()
  await state.waitForSessionTasks(agent.id)
  expect(errors).toEqual([])
  expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('completed')
}

const compact = () => ctx.commands.execute(agent, '/compact', [], new AbortController().signal)

beforeEach(async () => {
  requests.length = 0; projectedRequests.length = 0; errors.length = 0; summaryFinish = 'stop'
  root = await mkdtemp(join(tmpdir(), 'tavern-compaction-'))
  const config = resolveConfig({ sampling: { maxTokens: 1024 }, memory: { aliasExpansion: false } })
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'),
    presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'bindings') }, () => config)
  await state.init()
  cardId = (await state.createCharacter('压缩工厂角色')).cardId
  await state.saveCharacter(cardId, { systemPrompt: '保持角色身份，记住北门的约定。' })
  await state.saveBinding({ sessionId: 'compaction-factory', cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  storyId = (await state.loadBinding('compaction-factory'))!.storyId!
  ctx = new Context()
  const loader = new Loader(ctx, { baseUrl: new URL('../', import.meta.url).href })
  loader.builtins.group = Group
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx)
  new SystemPrompt(ctx, {}); new ToolRuntime(ctx); new TokenMeter(ctx); new CommandRuntime(ctx); new FactoryPtcRuntime(ctx)
  const llm = new LlmRuntime(ctx)
  llm.registerAdapter(['factory', PRESET_ADAPTER_SOURCE_PROVIDER, PRESET_ADAPTER_PROVIDER], new FactoryAdapter())
  await applyPersistence(ctx, PersistenceConfig({ root: join(root, 'host-sessions'), compression: 'none' }))
  ctx.provide('tavern', { state })
  const registry = new AgentPresetRegistry(ctx, AgentPresetRegistry.Config({ default: 'tavern' }))
  // Loader 的 Node 导入不负责源码 .js→.ts 映射；仅 Tavern 入口换成直接 import src 的内建模块，其余预设及宿主模块保持原样。
  loader.builtins['tavern-source'] = tavernAgent
  const register = registry.register.bind(registry)
  vi.spyOn(registry, 'register').mockImplementation(definition => register({ ...definition,
    plugins: definition.plugins.map(entry => entry.id === 'tavern' ? { ...entry, name: 'cordis:tavern-source' } : entry) }))
  await installTavernPreset(ctx)
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') void state.enqueueSessionTask(session.id, () => onTurnStart(state, session.id, event.data.turn, session)).catch(error => errors.push(error))
    if (event.type === 'turn/end') {
      const events = session.snapshotEvents()
      void state.enqueueSessionTask(session.id, () => onTurnEnd(state, session.id, { id: session.id, snapshotEvents: () => events })).catch(error => errors.push(error))
    }
  })
  ctx.on('agent/error', ({ error }) => errors.push(error))
  const loop = new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
  agent = await loop.create(SessionId('compaction-factory'), { provider: 'factory', model: 'factory' }, { cwd: root })
  outside = await loop.create(SessionId('outside-factory'), { provider: 'factory', model: 'factory' }, { cwd: root })
  await registry.select(agent, 'tavern')
})

afterEach(async () => {
  for (const target of [agent, outside]) {
    target?.cancel({ kind: 'disposed' }, { keepInbox: true })
    await target?.whenIdle()
    if (target && state) await state.waitForSessionTasks(target.id)
  }
  await ctx?.fiber.dispose()
  if (root) await rm(root, { recursive: true, force: true })
})

it('实际 Tavern 预设发现 /compact，隔离服务不泄露到宿主或其它会话；空历史不调用模型或开楼层', async () => {
  expect(ctx.commands.list(agent).map(command => command.name)).toContain('compact')
  expect(ctx.commands.list(outside).map(command => command.name)).not.toContain('compact')
  expect(ctx.get('compaction')).toBeUndefined()
  expect(ctx.get('toolResultPruner')).toBeUndefined()
  expect(ctx.agentPresets.serviceFor(agent, 'compaction')).toBeDefined()
  expect(ctx.agentPresets.serviceFor(agent, 'toolResultPruner')).toBeDefined()
  expect(ctx.agentPresets.inspectCompositions(agent.ctx)[0]?.leakedServices).toEqual([])
  expect((await compact())?.result).toMatchObject({ kind: 'success', text: 'No compactable history yet.' })
  expect(requests).toEqual([])
  expect(agent.session.snapshotEvents().some(event => event.type === 'turn/start' || event.type === 'compaction/start')).toBe(false)
})

it('低于自动阈值也能手动摘要；原日志与剧情记忆保留，持久化可重载且下一轮只使用压缩后的历史', async () => {
  const old = '旧剧情原文：蓝钥匙藏在北门。'.repeat(200)
  await send(old)
  await send('我们约好黎明会合。')
  const ws = await state.storyWorkspace(cardId, storyId)
  await ws.memory.write({ body: '不能随聊天压缩改写的长期记忆。', keys: ['北门'] })
  const memory = await ws.memory.list(), outsideEvents = outside.session.snapshotEvents()
  const turns = agent.session.snapshotEvents().filter(event => event.type === 'turn/start').length
  expect((await compact())?.result.kind).toBe('success')
  expect(summaryRequests()).toHaveLength(1)
  const events = agent.session.snapshotEvents()
  expect(events.filter(event => event.type === 'turn/start')).toHaveLength(turns)
  expect(events.some(event => event.type === 'user/message' && textOf(event.data) === old)).toBe(true)
  expect(events.find(event => event.type === 'compaction/start')?.data.turn).toBeNull()
  expect(agent.session.deriveMessages().map(textOf).join('\n')).toContain(SUMMARY)
  expect(agent.session.deriveMessages().map(textOf).join('\n')).not.toContain(old)
  expect(await ws.memory.list()).toEqual(memory)
  expect(outside.session.snapshotEvents()).toEqual(outsideEvents)
  await send('继续北门的约定。')
  const next = chatRequests().at(-1)!
  expect(next.messages.map(textOf).join('\n')).toContain(SUMMARY)
  expect(next.messages.map(textOf).join('\n')).not.toContain(old)
  expect(next.messages.map(textOf).join('\n')).toContain('保持角色身份')
  expect((await ws.wal.validateFloor(`${agent.id}#t3`)).committed).toBe(true)
  await ctx.sessions.flush(agent.session)
  const reader = await ctx.sessionPersistence.open(agent.id, 'read')
  try {
    const stored = [...(await reader.read()).events]
    const restored = Session.create(agent.id, stored, agent.session.header)
    expect(restored.deriveMessages()).toEqual(agent.session.deriveMessages())
  } finally { await reader.close() }
})

it('默认自动策略在真实下一轮触发压缩，保留近期输入并继续完成当前剧情楼层', async () => {
  const backend = ctx.agentPresets.serviceFor(agent, 'compaction')!
  const pruner = ctx.agentPresets.serviceFor(agent, 'toolResultPruner')!
  const automatic = vi.spyOn(backend, 'compactIfNeeded')
  const pruneSession = vi.spyOn(pruner, 'pruneSession')
  const old = '长篇旧史：' + '山河城门旧线索。'.repeat(40_000)
  await send(old)
  // 宿主按完整消息保留近期 token 尾；补足近期历史，才有能安全摘出的旧前缀。
  const recent = '近期剧情：' + '北门黎明等候。'.repeat(14_000)
  await send(recent)
  expect(summaryRequests()).toHaveLength(0)
  expect(ctx.tokenMeter.measure(agent.session).totalTokens).toBeGreaterThan(61_440)
  await send('近期玩家输入：现在去北门。')
  expect(automatic).toHaveBeenCalledWith(agent, 'pressure', expect.any(AbortSignal))
  expect(pruneSession).toHaveBeenCalledWith(agent.session)
  expect(summaryRequests().length).toBeGreaterThan(0)
  const events = agent.session.snapshotEvents()
  expect(events.find(event => event.type === 'compaction/start')?.data.turn).toBe(3)
  const next = chatRequests().at(-1)!
  expect(next.messages.map(textOf).join('\n')).toContain(SUMMARY)
  expect(next.messages.map(textOf).join('\n')).toContain('近期玩家输入：现在去北门。')
  expect(next.messages.map(textOf).join('\n')).toContain(recent)
  expect(next.messages.map(textOf).join('\n')).not.toContain(old)
  const ws = await state.storyWorkspace(cardId, storyId)
  expect((await ws.wal.validateFloor(`${agent.id}#t3`)).committed).toBe(true)
})

it('摘要截断明确失败且不替换旧历史，随后可以重试；生成中拒绝手动压缩', async () => {
  await send('必须保留的原始剧情。'.repeat(200))
  await send('保留近期对话。')
  const before = agent.session.deriveMessages()
  summaryFinish = 'max-tokens'
  expect((await compact())?.result.kind).toBe('error')
  expect(agent.session.deriveMessages()).toEqual(before)
  expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/summary')).toEqual([])
  expect(agent.session.snapshotEvents().filter(event => event.type === 'compaction/end').at(-1)?.data.error).toBeDefined()
  summaryFinish = 'stop'
  expect((await compact())?.result.kind).toBe('success')
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '正在生成的一轮' }] }))
  expect((await compact())?.result.kind).toBe('error')
  await agent.whenIdle()
  await state.waitForSessionTasks(agent.id)
  expect(errors).toEqual([])
})

it('DeepSeek 预设投影与 installModelSelection 联用：压缩后历史前系统提示仍在摘要之前，且内部路由不注入伪造换模提示', async () => {
  state.presetAdapter = { ensureRegistered() {} }
  const selection: { current: AgentModelSelection | undefined; assembled: AgentModelSelection | undefined } = {
    current: { provider: PRESET_ADAPTER_SOURCE_PROVIDER, model: 'deepseek-chat' },
    assembled: undefined,
  }
  installModelSelection(agent.ctx, selection)
  const observedVariables: Array<Record<string, string>> = []
  agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const res = await next()
    observedVariables.push({ ...res.variables })
    return res
  }, { prepend: true })

  await send('第一轮北门线索。'.repeat(120))
  expect(chatRequests().at(-1)?.provider).toBe(PRESET_ADAPTER_PROVIDER)
  expect(observedVariables.at(-1)?.['provider']).toBe(PRESET_ADAPTER_SOURCE_PROVIDER)
  expect((await compact())?.result.kind).toBe('success')
  expect(summaryRequests().at(-1)?.provider).toBe(PRESET_ADAPTER_PROVIDER)

  await send('压缩后继续行动。')
  const turn2Derived = agent.session.deriveMessages()
  expect(turn2Derived.filter(message => message.source.kind === 'model-selection')).toEqual([])
  const { options: projected, diagnostics } = projectedRequests.at(-1)!
  expect(diagnostics.some(item => item.kind === 'messages-system-layout')).toBe(false)
  const summaryIdx = projected.messages.findIndex(message => textOf(message).includes(SUMMARY))
  const cardIdx = projected.messages.findIndex(message => textOf(message).includes('保持角色身份，记住北门的约定。'))
  expect(cardIdx).toBeGreaterThanOrEqual(0)
  expect(summaryIdx).toBeGreaterThan(cardIdx)

  selection.current = { provider: PRESET_ADAPTER_SOURCE_PROVIDER, model: 'deepseek-reasoner' }
  await send('切换到推理模型继续。')
  const switchNotices = agent.session.deriveMessages().filter(message => message.source.kind === 'model-selection')
  expect(switchNotices).toHaveLength(1)
  expect(textOf(switchNotices[0]!)).toBe(
    '[model changed: assistant turns above this point were generated by deepseek-chat; the session continues with deepseek-reasoner]',
  )
  expect(switchNotices[0]!.source).toMatchObject({ kind: 'model-selection', summary: 'deepseek-chat → deepseek-reasoner' })

  await send('继续使用同一推理模型。')
  expect(agent.session.deriveMessages().filter(message => message.source.kind === 'model-selection')).toHaveLength(1)
})

