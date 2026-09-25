import { messagesResponse } from './messagesApiFactory.js'
/** 结构化预设端到端回归：真实 AgentLoop、Settings、Session、剧情 WAL 与官方适配器通过工厂 HTTP 验证布局和恢复。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { LocalAttachmentStore } from '@deepseek-ai/dsh-attachment-local'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type Message, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { apply as applyDeepSeek, Config as DeepSeekConfig } from '@deepseek-ai/dsh-llm-deepseek-api-key'
import { Session, SessionId, SessionLogOffset, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { FileSettings } from './hostSettingsFactory.js'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { apply as applyAgent } from '../src/agent.js'
import { resolveConfig } from '../src/node/config.js'
import { registerPresetAdapter, PRESET_ADAPTER_PROVIDER, PRESET_ADAPTER_SOURCE_PROVIDER } from '../src/node/presetAdapter.js'
import { createPresetRequestProjector, hasPresetPlanMessage, projectPresetRequest, PRESET_PLAN_MESSAGE_TEXT } from '../src/node/presetRequestProjection.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { parseStPreset } from '../src/state/presetStore.js'

vi.mock('../src/node/tools.js', () => ({ registerTavernTools: vi.fn() }))
vi.mock('../src/node/memoryMaintenance.js', () => ({ registerMemoryMaintenance: vi.fn() }))
vi.mock('@deepseek-ai/dsh-anonymous-user-id', () => ({ getOrCreateAnonymousUserId: () => 'factory-structured-user' }))

/** 设置存储只写工厂目录，默认与 composition base 的合并由真实宿主服务完成。 */

type WireMessage = { role: string; content: string | { type: string; text?: string; file_id?: string }[];
  tool_call_id?: string; tool_calls?: { id: string; function: { name: string; arguments: string } }[] }
type Wire = { system?: string; messages: WireMessage[]; temperature?: number; max_tokens?: number; stop?: string[]; tools?: unknown[] }
let ctx: Context, state: TavernState, agent: Agent, root: string, cardId: string, presetId: string, storyId: string
let attachments: LocalAttachmentStore
let runTool = false, uploadCount = 0
const wires: Wire[] = [], requests: GenerateOptions[] = [], projected: GenerateOptions[] = [], seeds: SessionEvent[][] = [], errors: unknown[] = []
const children: AgentHandle[] = [], otherRequests: GenerateOptions[] = []
const textOf = (message: Message) => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const wireText = (message: WireMessage) => typeof message.content === 'string' ? message.content : message.content.map(part => part.text ?? '').join('\n')
const planMessages = (messages: readonly Message[]) => messages.filter(message => 'tavernPromptPlan' in message.source || message.source.kind === 'tavern-prompt-plan')
const slot = (wire: Wire, text: string) => wire.messages.flatMap(message => typeof message.content === 'string' ? [{text:message.content}] : message.content).findIndex(block => block.text?.split('\n').includes(text))
const projectedText = (request: GenerateOptions) => request.messages.map(textOf).join('\n')

/** 其它供应商只记录宿主送达的完整请求；沿用工厂模型能力但不进行消息投影。 */
class OtherAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string, signal?: AbortSignal) {
    return { ...await ctx.llm.resolveModelInfo(PRESET_ADAPTER_SOURCE_PROVIDER, model, signal), provider }
  }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    otherRequests.push(options)
    yield { type: 'text-delta', index: 0, text: 'OTHER-ANSWER' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** 只生成工厂 SSE，不读取任何真实模型服务。 */
function completion(tool: boolean, index: number): Response { return messagesResponse(`FACTORY-ANSWER-${index}`, tool ? { id: 'structured-tool', name: 'factory_edit_preset' } : undefined) }

async function user(text: string, image = false): Promise<UserMessage> {
  const ref = image ? await attachments.saveImage({ mediaType: 'image/png', name: 'factory.png',
    data: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNYffY9AASOAmiAObbZAAAAAElFTkSuQmCC', 'base64') }) : undefined
  return createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }, ...(ref ? [{ type: 'image' as const, attachment: ref }] : [])] })
}

async function send(message: UserMessage): Promise<void> {
  agent.followup(message)
  await agent.whenIdle()
  await state.waitForSessionTasks(agent.id)
  expect(errors).toEqual([])
  expect(agent.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)?.data.reason.kind).toBe('completed')
}

beforeEach(async () => {
  wires.length = 0; requests.length = 0; projected.length = 0; seeds.length = 0; errors.length = 0
  children.length = 0; otherRequests.length = 0; runTool = false; uploadCount = 0
  root = await mkdtemp(join(tmpdir(), 'tavern-structured-live-'))
  vi.stubEnv('DSH_HOME', root)
  vi.stubGlobal('fetch', vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input)
    if (url.endsWith('/files') && init?.method === 'POST') {
      uploadCount++
      const file = (init.body as FormData).get('file') as File
      return Response.json({ id: 'factory-file', type: 'file', size_bytes: file.size, filename: file.name, mime_type: 'image/png',
        created_at: new Date().toISOString() })
    }
    if (url !== 'https://structured.invalid/v1/messages') throw new Error(`Unexpected factory URL: ${url}`)
    wires.push(JSON.parse(String(init?.body)) as Wire)
    return completion(runTool && wires.length === 1, wires.length)
  }))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') },
  () => resolveConfig({}))
  await state.init()
  cardId = (await state.createCharacter('结构化工厂角色')).cardId
  const { preset } = parseStPreset({ name: '结构化工厂', identifier: 'structured-live', temperature: 0.31, openai_max_tokens: 777,
    prompts: [
      { identifier: 'main', role: 'system', content: 'PRESET-MAIN', forbid_overrides: true },
      { identifier: 'before-user', role: 'user', content: 'BEFORE-USER' },
      { identifier: 'depth-two', role: 'system', content: 'DEPTH-TWO', injection_position: 1, injection_depth: 2, injection_order: 20 },
      { identifier: 'depth-one', role: 'user', content: 'DEPTH-ONE', injection_position: 1, injection_depth: 1, injection_order: 20 },
      { identifier: 'chatHistory', marker: true },
      { identifier: 'depth-zero', role: 'assistant', content: 'DEPTH-ZERO', injection_position: 1, injection_depth: 0, injection_order: 20 },
      { identifier: 'tail', role: 'system', content: 'AFTER-HISTORY' },
    ] })
  presetId = await state.savePreset(preset)
  await state.saveBinding({ sessionId: 'structured-live', cardId, presetId, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  storyId = (await state.loadBinding('structured-live'))!.storyId!
  ctx = new Context()
  const file = join(root, 'settings.json')
  await writeFile(file, '{}')
  const settings = new FileSettings(ctx, file)
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  new LlmRuntime(ctx)
  attachments = new LocalAttachmentStore(ctx, { dshHome: root })
  ctx.provide('credentials', { resolve: async () => ({ value: 'factory-key', source: 'factory' }) } as unknown as CredentialProvider)
  const deepSeekRaw = { baseURL: 'https://structured.invalid/v1', apiKeyEnv: 'STRUCTURED_KEY', maxTokens: 1800,
    models: [{ id: 'factory', name: '工厂模型', contextWindow: 64000, inputModalities: ['text', 'image'], systemPromptUpdate: 'in-history' },
      { id: 'factory-leading', name: '仅首条系统提示模型', contextWindow: 64000, inputModalities: ['text'] }] }
  await settings.register('llm-deepseek-api-key', DeepSeekConfig, { base: deepSeekRaw })
  applyDeepSeek(ctx, DeepSeekConfig(deepSeekRaw))
  await vi.waitFor(() => expect(settings.get('llm-deepseek-api-key')).toBeDefined())
  const projector = createPresetRequestProjector(ctx)
  state.presetAdapter = registerPresetAdapter(ctx, (options, model) => { const result = projector.project(options, model); projected.push(result); return result })
  const loop = new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
  agent = await loop.create(SessionId('structured-live'), { provider: PRESET_ADAPTER_SOURCE_PROVIDER, model: 'factory' })
  ctx.provide('tavern', { state })
  ctx.systemPrompt.section({ name: 'factory:sdk', order: ctx.systemPrompt.getSectionOrder('TOOLS_SDK'), text: 'FACTORY-SDK-PREFIX' })
  ctx.systemPrompt.section({ name: 'factory:other', order: 9000, text: 'OTHER-HOST-SECTION' })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') void state.enqueueSessionTask(session.id, () => onTurnStart(state, session.id, event.data.turn, session)).catch(error => errors.push(error))
    if (event.type === 'turn/end') {
      const events = session.snapshotEvents()
      void state.enqueueSessionTask(session.id, () => onTurnEnd(state, session.id, { id: session.id, snapshotEvents: () => events })).catch(error => errors.push(error))
    }
  })
  ctx.on('agent/inbox/inserted', ({ agent: target, message }) => {
    const text = textOf(message)
    state.pendingInputs.set(target.id, [...(state.pendingInputs.get(target.id) ?? []), text])
    state.pendingTemplateInputs.set(target.id, [...(state.pendingTemplateInputs.get(target.id) ?? []), { id: message.id, text }])
  })
  ctx.on('agent/error', ({ error }) => errors.push(error))
  ctx.on('llm/stream', (options, next) => { requests.push(options); seeds.push([...agent.session.snapshotEvents()]); return next() })
  applyAgent(agent.ctx)
})

afterEach(async () => {
  agent?.cancel({ kind: 'disposed' }, { keepInbox: true })
  await agent?.whenIdle()
  if (agent && state) await state.waitForSessionTasks(agent.id)
  for (const handle of children) await handle.dispose()
  await ctx?.fiber.dispose()
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

it('自动选择适配器，真实 wire 保留 system/user/assistant 深度、SDK 前缀和用户图片', async () => {
  const input = await user('INPUT-ONE', true)
  await send(input)
  expect(requests).toHaveLength(1)
  expect(requests[0]!.provider).toBe(PRESET_ADAPTER_PROVIDER)
  expect(agent.session.requestHeader()?.config.provider).toBe(PRESET_ADAPTER_PROVIDER)
  expect(wires[0]!.messages.some(message => message.role === 'system')).toBe(false)
  for (const text of ['FACTORY-SDK-PREFIX', 'OTHER-HOST-SECTION', 'PRESET-MAIN', 'DEPTH-TWO', 'AFTER-HISTORY']) expect(wires[0]!.system).toContain(text)
  expect(wires[0]!.system!.match(/FACTORY-SDK-PREFIX/g)).toHaveLength(1)
  expect(slot(wires[0]!, 'DEPTH-ONE')).toBeLessThan(slot(wires[0]!, 'INPUT-ONE'))
  expect(slot(wires[0]!, 'DEPTH-ZERO')).toBeGreaterThan(slot(wires[0]!, 'INPUT-ONE'))
  const inputMessage = wires[0]!.messages.find(message => wireText(message).includes('INPUT-ONE'))!
  expect(inputMessage.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image', source: { type: 'file', file_id: 'factory-file' } })]))
  expect(uploadCount).toBe(1)
  const admittedInput = requests[0]!.messages.find(message => message.id === input.id)
  expect(admittedInput).toMatchObject({ id: input.id, role: input.role, content: input.content, source: { kind: 'user' } })
  const projectedInput = projected[0]!.messages.find(message => message.id === input.id)
  expect(projectedInput).toEqual(input)
  expect(projectedInput?.content).toBe(admittedInput?.content)
  expect(planMessages(requests[0]!.messages)).toHaveLength(1)
  expect(JSON.stringify(wires[0])).not.toContain(PRESET_PLAN_MESSAGE_TEXT)
  const ws = await state.storyWorkspace(cardId, storyId)
  expect((await ws.wal.validateFloor(`${agent.id}#t1`)).committed).toBe(true)
})

it('模型只支持首条 system 时真实传输合并全部系统规则，其它角色仍按布局送出', async () => {
  agent.options.model = 'factory-leading'
  await send(await user('LEADING-ONLY-INPUT'))
  expect(wires).toHaveLength(1)
  expect(wires[0]!.messages.filter(message => message.role === 'system')).toHaveLength(0)
  for (const text of ['FACTORY-SDK-PREFIX', 'OTHER-HOST-SECTION', 'PRESET-MAIN', 'DEPTH-TWO', 'AFTER-HISTORY']) expect(wires[0]!.system).toContain(text)
  expect(slot(wires[0]!, 'DEPTH-ONE')).toBeLessThan(slot(wires[0]!, 'LEADING-ONLY-INPUT'))
  expect(slot(wires[0]!, 'DEPTH-ZERO')).toBeGreaterThan(slot(wires[0]!, 'LEADING-ONLY-INPUT'))
})

it('Messages 不支持的 system 位置合并到首条完整提示，保留用户和助手条目顺序', async () => {
  const { preset } = parseStPreset({ name: '合并工厂', identifier: 'coalesced-live', prompts: [
    { identifier: 'main', role: 'system', content: 'COALESCE-A', forbid_overrides: true },
    { identifier: 'second', role: 'system', content: 'COALESCE-B' },
    { identifier: 'user-boundary', role: 'user', content: 'USER-BOUNDARY' },
    { identifier: 'third', role: 'system', content: 'COALESCE-C' },
    { identifier: 'chatHistory', marker: true },
    { identifier: 'tail-a', role: 'system', content: 'COALESCE-D' },
    { identifier: 'tail-b', role: 'system', content: 'COALESCE-E' },
    { identifier: 'assistant-boundary', role: 'assistant', content: 'ASSISTANT-BOUNDARY' },
    { identifier: 'tail-c', role: 'system', content: 'COALESCE-F' },
  ] })
  await state.savePreset({ ...preset, identifier: (await state.loadPreset(presetId))!.identifier })
  await send(await user('COALESCE-INPUT'))
  const wire = wires[0]!
  expect(wire.messages.some(message => message.role === 'system')).toBe(false)
  for (const text of ['FACTORY-SDK-PREFIX', 'OTHER-HOST-SECTION', ...'ABCDEF'.split('').map(letter => 'COALESCE-'+letter)]) expect(wire.system).toContain(text)
  expect(wire.system!.match(/FACTORY-SDK-PREFIX/g)).toHaveLength(1)
  expect(slot(wire, 'USER-BOUNDARY')).toBeLessThan(slot(wire, 'COALESCE-INPUT'))
  expect(slot(wire, 'ASSISTANT-BOUNDARY')).toBeGreaterThan(slot(wire, 'COALESCE-INPUT'))
  const stored = planMessages(requests[0]!.messages)[0]!.source
  expect('tavernPromptPlan' in stored).toBe(true)
  expect(JSON.stringify(stored)).toContain('COALESCE-A')
  expect(JSON.stringify(stored)).toContain('COALESCE-B')
})

it('两步骤保持同轮布局和工具配对，下一轮才重读资产且每轮载体只接收一次', async () => {
  runTool = true
  ctx.tools.register(defineTool({ name: 'factory_edit_preset', description: '工厂修改预设', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      const preset = (await state.loadPreset(presetId))!
      await state.savePreset({ ...preset, entries: preset.entries.map(prompt => prompt.identifier === 'main' || prompt.identifier === 'tail'
        ? { ...prompt, content: `UPDATED-${prompt.content}` } : prompt), sampling: { temperature: 0.81, maxTokens: 333, stop: [] } })
      return 'FACTORY-TOOL-RESULT'
    },
  }))
  const input = await user('INPUT-ONE')
  await send(input)
  expect(wires).toHaveLength(2)
  expect(requests).toHaveLength(2)
  for (let index = 0; index < 2; index++) {
    expect(wires[index]!.temperature).toBe(0.31)
    expect(wires[index]!.max_tokens).toBe(777)
    expect(projectedText(projected[index]!)).toContain('PRESET-MAIN')
    expect(projectedText(projected[index]!)).not.toContain('UPDATED-')
    expect(planMessages(requests[index]!.messages)).toHaveLength(1)
  }
  expect(planMessages(requests[1]!.messages)[0]).toBe(planMessages(requests[0]!.messages)[0])
  const callAt = wires[1]!.messages.findIndex(message => Array.isArray(message.content) && message.content.some(block => block.type === 'tool_use' && block.id === 'structured-tool'))
  expect(wires[1]!.messages[callAt + 1]).toMatchObject({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'structured-tool', content: [{ type: 'text', text: 'FACTORY-TOOL-RESULT' }], is_error: false }] })
  expect(callAt).toBeGreaterThanOrEqual(0)
  expect(wires[1]!.system).toContain('AFTER-HISTORY')
  const toolMessages = requests[1]!.messages.filter(message => message.role === 'tool' || message.content.some(block => block.type === 'tool-call'))
  for (const toolMessage of toolMessages) expect(projected[1]!.messages.find(message => message.id === toolMessage.id)).toBe(toolMessage)
  await send(await user('INPUT-TWO'))
  expect(wires).toHaveLength(3)
  expect(wires[2]!.temperature).toBe(0.81)
  expect(wires[2]!.max_tokens).toBe(333)
  expect(wires[2]!.system).toContain('UPDATED-PRESET-MAIN')
  expect(wires[2]!.system).toContain('UPDATED-AFTER-HISTORY')
  expect(slot(wires[2]!, 'PRESET-MAIN')).toBe(-1)
  expect(wires[2]!.system).toContain('DEPTH-TWO')
  expect(slot(wires[2]!, 'DEPTH-ONE')).toBeGreaterThan(slot(wires[2]!, 'FACTORY-ANSWER-2'))
  expect(slot(wires[2]!, 'DEPTH-ONE')).toBeLessThan(slot(wires[2]!, 'INPUT-TWO'))
  expect(planMessages(requests[2]!.messages)).toHaveLength(2)
  expect([1, 2].map(turn => agent.session.deriveMessages().filter(message => hasPresetPlanMessage(message, agent.id, turn)).length)).toEqual([1, 1])
  expect(wires[2]!.messages.filter(message => wireText(message) === 'DEPTH-ZERO')).toHaveLength(1)
})

it('实际请求日志经过 JSON 文件与真实 Session 恢复后仍能重建同一布局，解绑回原路由', async () => {
  await send(await user('RESTORE-INPUT'))
  const file = join(root, 'request-session.json')
  await writeFile(file, JSON.stringify({ events: seeds[0], header: agent.session.header, inheritedEventCount: agent.session.inheritedEventCount }))
  const saved = JSON.parse(await readFile(file, 'utf8')) as { events: SessionEvent[]; header: Session['header']; inheritedEventCount: Session['inheritedEventCount'] }
  const restored = Session.create(agent.id, saved.events, saved.header, saved.inheritedEventCount)
  const restoredPlan = planMessages(restored.deriveMessages())
  expect(restoredPlan).toHaveLength(1)
  expect(restoredPlan[0]).toEqual(planMessages(requests[0]!.messages)[0])
  const replay = projectPresetRequest({ ...requests[0]!, messages: restored.deriveMessages() }, restored, { model: { systemPromptUpdate: 'in-history' }, messagesApi: true })
  expect(replay.messages).toEqual(projected[0]!.messages)
  await state.clearBinding(agent.id)
  await send(await user('UNBOUND-INPUT'))
  expect(requests[1]!.provider).toBe(PRESET_ADAPTER_SOURCE_PROVIDER)
  expect(agent.session.requestHeader()?.config.provider).toBe(PRESET_ADAPTER_SOURCE_PROVIDER)
  expect(planMessages(requests[1]!.messages)).toHaveLength(1)
  expect(projected).toHaveLength(1)
})

it('恢复时旧 header 属于其它供应商，新 AgentOptions 选择官方路由仍携带本轮布局', async () => {
  ctx.llm.registerAdapter(['factory-other'], new OtherAdapter())
  agent.session.append('request/header', { header: { config: { provider: 'factory-other', model: 'factory' } }, reason: 'initial' })
  const file = join(root, 'other-provider-seed.json')
  await writeFile(file, JSON.stringify(agent.session.snapshotEvents()))
  const seed = JSON.parse(await readFile(file, 'utf8')) as SessionEvent[]
  const previousId = agent.id
  const childId = SessionId('structured-route-restore')
  await state.saveBinding({ ...(await state.loadBinding(previousId))!, sessionId: childId, storyId: undefined })
  const handle = await ctx.agents.create({ sessionId: childId, seed, inheritedEventCount: SessionLogOffset(seed.length),
    meta: { parentSession: previousId, isSeeded: true },
    agentOptions: { provider: PRESET_ADAPTER_SOURCE_PROVIDER, model: 'factory' }, setup: childCtx => applyAgent(childCtx) })
  children.push(handle)
  agent = handle.agent
  expect(agent.session.requestHeader()?.config.provider).toBe('factory-other')
  expect(agent.options.provider).toBe(PRESET_ADAPTER_SOURCE_PROVIDER)
  await send(await user('RESTORED-ROUTE-INPUT'))
  expect(requests[0]!.provider).toBe(PRESET_ADAPTER_PROVIDER)
  expect(planMessages(requests[0]!.messages)).toHaveLength(1)
  expect(wires[0]!.system).toContain('PRESET-MAIN')
  expect(slot(wires[0]!, 'DEPTH-ONE')).toBeLessThan(slot(wires[0]!, 'RESTORED-ROUTE-INPUT'))
  expect(otherRequests).toHaveLength(0)
})

it('request middleware 等 next 后最终切入 Tavern，pre-step 不依赖提前猜测路由', async () => {
  ctx.llm.registerAdapter(['factory-other'], new OtherAdapter())
  agent.options.provider = 'factory-other'
  let innerProvider: string | undefined
  agent.ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    innerProvider = config.provider
    state.presetAdapter!.ensureRegistered()
    return { ...config, provider: PRESET_ADAPTER_PROVIDER }
  }, { prepend: true })
  await send(await user('MIDDLEWARE-TAVERN-INPUT'))
  expect(innerProvider).toBe('factory-other')
  expect(requests[0]!.provider).toBe(PRESET_ADAPTER_PROVIDER)
  expect(planMessages(requests[0]!.messages)).toHaveLength(1)
  expect(wires[0]!.system).toContain('PRESET-MAIN')
  expect(wires[0]!.system).toContain('AFTER-HISTORY')
  expect(otherRequests).toHaveLength(0)
})

it.each([false, true])('最终走其它供应商时只附元数据，不增加人工消息或改写台词（middleware=%s）', async finalMiddleware => {
  ctx.llm.registerAdapter(['factory-other'], new OtherAdapter())
  agent.options.provider = finalMiddleware ? PRESET_ADAPTER_SOURCE_PROVIDER : 'factory-other'
  let innerProvider: string | undefined
  if (finalMiddleware) agent.ctx.on('agent/request', async (_payload, next) => {
    const config = await next()
    innerProvider = config.provider
    return { ...config, provider: 'factory-other' }
  }, { prepend: true })
  const incomingBatches: { id: string; role: string; content: Message['content'] }[][] = []
  const admittedBatches: { id: string; role: string; content: Message['content'] }[][] = []
  // 最内层先取得宿主已追加 runtime context 的正常接收批次，最外层核对 Tavern 只改元数据。
  agent.ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'enter') incomingBatches.push(decision.messages.map(({ id, role, content }) => ({ id, role, content })))
    return decision
  })
  agent.ctx.on('agent/pre-step', async (_payload, next) => {
    const decision = await next()
    if (decision.kind === 'enter') admittedBatches.push(decision.messages.map(({ id, role, content }) => ({ id, role, content })))
    return decision
  }, { prepend: true })
  const input = await user('UNCHANGED-OTHER-INPUT', true)
  await send(input)
  expect(requests[0]!.provider).toBe('factory-other')
  if (finalMiddleware) expect(innerProvider).toBe(PRESET_ADAPTER_PROVIDER)
  expect(otherRequests).toHaveLength(1)
  expect(admittedBatches).toEqual(incomingBatches)
  expect(planMessages(otherRequests[0]!.messages)).toHaveLength(1)
  expect(otherRequests[0]!.messages.filter(message => message.source.kind === 'user')).toEqual([
    expect.objectContaining({ id: input.id, role: 'user', content: input.content, source: expect.objectContaining({ kind: 'user' }) }),
  ])
  expect(otherRequests[0]!.messages.some(message => message.source.kind === 'tavern-prompt-plan')).toBe(false)
  expect(otherRequests[0]!.messages.some(message => textOf(message).includes(PRESET_PLAN_MESSAGE_TEXT))).toBe(false)
  expect(wires).toHaveLength(0)
  expect(projected).toHaveLength(0)
})
