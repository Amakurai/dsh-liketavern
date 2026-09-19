/** 预设真实请求回归：rc.2 AgentLoop、Session、工厂适配器与真实剧情 WAL 验证后置落位、逐轮刷新、采样冻结及宿主消息保真。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, LlmAdapter, LlmRuntime, ToolCallId, type GenerateOptions, type LlmResolvedModelInfo, type Message, type StreamChunk, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { defineTool, ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply as applyAgent } from '../src/agent.js'
import { resolveConfig } from '../src/node/config.js'
import { forkAgentOptions } from '../src/node/floors.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { parseStPreset } from '../src/state/presetStore.js'

vi.mock('../src/node/tools.js', () => ({ registerTavernTools: vi.fn() }))
vi.mock('../src/node/memoryMaintenance.js', () => ({ registerMemoryMaintenance: vi.fn() }))

let root: string, ctx: Context, state: TavernState, agent: Agent, cardId: string, presetId: string, storyId: string
let config = resolveConfig({ sampling: { temperature: 1.2, maxTokens: 1800, stop: ['GLOBAL-STOP'] } })
let firstStepTool = false
const requests: GenerateOptions[] = []
const errors: unknown[] = []
const children: AgentHandle[] = []
const textOf = (message: Message) => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const snapshots = (request: GenerateOptions) => request.messages.filter(message =>
  message.role === 'user' && message.source.kind === 'plugin' && message.source.plugin === '@deepseek-ai/dsh-system-prompt')
const systemText = (request: GenerateOptions) => request.messages.filter(message => message.role === 'system').map(textOf).join('\n')

/** 工厂适配器只消费公开请求并返回手写流；图片引用留在模型消息中，不读取真实附件或调用网络。 */
class FactoryAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: ['text', 'image'], context: { contextWindow: 64_000 } }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    requests.push(options)
    if (firstStepTool && requests.length === 1) {
      yield { type: 'tool-call-delta', index: 0, id: ToolCallId('factory-call'), name: 'factory_edit_preset', argumentsDelta: '{}' }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: '工厂正常回复' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function userMessage(text: string, image = false): UserMessage {
  return createUserMessage({ source: { kind: 'user' }, content: [
    { type: 'text', text },
    ...(image ? [{ type: 'image' as const, attachment: { attachmentId: AttachmentId('a'.repeat(64)), mediaType: 'image/png' as const, bytes: 32, width: 1, height: 1, name: 'factory.png' } }] : []),
  ] })
}

async function send(message: UserMessage, target = agent): Promise<void> {
  target.followup(message)
  await target.whenIdle()
  await state.waitForSessionTasks(target.id)
  expect(errors).toEqual([])
  const end = target.session.snapshotEvents().filter(event => event.type === 'turn/end').at(-1)
  expect(end?.data.reason.kind).toBe('completed')
}

beforeEach(async () => {
  requests.length = 0; errors.length = 0; children.length = 0; firstStepTool = false
  config = resolveConfig({ sampling: { temperature: 1.2, maxTokens: 1800, stop: ['GLOBAL-STOP'] } })
  root = await mkdtemp(join(tmpdir(), 'tavern-preset-live-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library', 'lorebooks'),
    presets: join(root, 'library', 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => config)
  await state.init()
  cardId = (await state.createCharacter('预设工厂角色')).cardId
  await state.saveCharacter(cardId, { systemPrompt: 'CARD-MAIN', postHistoryInstructions: 'CARD-PHI' })
  const { preset } = parseStPreset({ name: '预设请求工厂', identifier: 'preset-live-factory', temperature: 0.37, openai_max_tokens: 777,
    stop: ['PRESET-STOP'], prompts: [
      { identifier: 'main', name: '主提示', role: 'system', content: 'PRESET-MAIN' },
      { identifier: 'chatHistory', name: '聊天历史', role: 'system', marker: true },
      { identifier: 'tail', name: '后置规则', role: 'assistant', content: 'PRESET-TAIL' },
      { identifier: 'jailbreak', name: '后置指令', role: 'system', content: 'PRESET-JAILBREAK' },
      { identifier: 'depth-zero', name: '零深度规则', role: 'system', injection_position: 1, injection_depth: 0, content: 'DEPTH-ZERO' },
    ], prompt_order: [{ character_id: 100001, order: ['main', 'chatHistory', 'tail', 'jailbreak', 'depth-zero'].map(identifier => ({ identifier, enabled: true })) }] })
  presetId = await state.savePreset(preset)
  await state.saveBinding({ sessionId: 'preset-live-factory', cardId, presetId, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  storyId = (await state.loadBinding('preset-live-factory'))!.storyId!
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  const llm = new LlmRuntime(ctx)
  llm.registerAdapter(['factory'], new FactoryAdapter())
  const loop = new AgentLoop(ctx, { agents: [] })
  agent = await loop.create(SessionId('preset-live-factory'), { provider: 'factory', model: 'factory' })
  ctx.provide('tavern', { state })
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
  applyAgent(agent.ctx)
})

afterEach(async () => {
  for (const handle of children) {
    await handle.dispose()
    await state.waitForSessionTasks(handle.agent.id)
  }
  agent?.cancel({ kind: 'disposed' }, { keepInbox: true })
  await agent?.whenIdle()
  if (state && agent) await state.waitForSessionTasks(agent.id)
  await ctx?.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

it('每轮把同字节后置规则追加到新用户之后，覆盖卡级槽位且保留宿主图片消息', async () => {
  const first = userMessage('第一轮输入', true)
  await send(first)
  const second = userMessage('第二轮输入')
  await send(second)
  expect(requests).toHaveLength(2)
  const [r1, r2] = requests as [GenerateOptions, GenerateOptions]
  for (const request of requests) {
    expect(request.temperature).toBe(0.37)
    expect(request.maxTokens).toBe(777)
    expect(request.stop).toEqual(['PRESET-STOP'])
    expect(systemText(request).match(/CARD-MAIN/g)).toHaveLength(1)
    expect(systemText(request)).not.toContain('PRESET-MAIN')
    for (const tail of ['PRESET-TAIL', 'DEPTH-ZERO', 'CARD-PHI', 'PRESET-JAILBREAK']) expect(systemText(request)).not.toContain(tail)
    const last = request.messages.at(-1)!
    expect(last.role).toBe('user')
    expect(textOf(last)).toContain('DEPTH-ZERO\n\nPRESET-TAIL\n\nCARD-PHI')
    expect(textOf(last)).not.toContain('PRESET-JAILBREAK')
    expect(request.messages.find(message => message.id === first.id)).toEqual(first)
  }
  expect(systemText(r2)).toBe(systemText(r1))
  expect(snapshots(r1)).toHaveLength(1)
  expect(snapshots(r2)).toHaveLength(2)
  expect(r1.messages.at(-2)?.id).toBe(first.id)
  expect(r2.messages.at(-2)?.id).toBe(second.id)
  expect(textOf(snapshots(r2)[0]!)).toBe(textOf(snapshots(r1)[0]!))
  expect(textOf(snapshots(r2)[1]!)).not.toBe(textOf(snapshots(r1)[0]!))
  const userEvents = agent.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')
  expect(userEvents.map(event => event.data)).toEqual([first, second])
  const ws = await state.storyWorkspace(cardId, storyId)
  expect((await ws.wal.validateFloor(`${agent.id}#t1`)).committed).toBe(true)
  expect((await ws.wal.validateFloor(`${agent.id}#t2`)).committed).toBe(true)
})

it('同轮工具后重放冻结预设且不重复快照，下一轮才更新采样并保留工具消息结构', async () => {
  firstStepTool = true
  ctx.tools.register(defineTool({ name: 'factory_edit_preset', description: '只修改工厂预设和角色资产', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute() {
      const preset = await state.loadPreset(presetId)
      await state.savePreset({ ...preset!, sampling: { temperature: 0.92, maxTokens: 333, stop: [] } })
      await state.saveCharacter(cardId, { systemPrompt: 'UPDATED-CARD-MAIN', postHistoryInstructions: 'UPDATED-CARD-PHI' })
      config = resolveConfig({ sampling: { temperature: 1.8, maxTokens: 2100, stop: ['UPDATED-GLOBAL-STOP'] },
        prompts: { preferCharacterPrompt: false, preferCharacterInstructions: false } })
      return 'FACTORY-TOOL-RESULT'
    },
  }))
  const input = userMessage('先调用工厂工具再正常回复', true)
  await send(input)
  expect(requests).toHaveLength(2)
  const [first, second] = requests as [GenerateOptions, GenerateOptions]
  for (const request of [first, second]) {
    expect(request.temperature).toBe(0.37)
    expect(request.maxTokens).toBe(777)
    expect(request.stop).toEqual(['PRESET-STOP'])
    expect(systemText(request)).toContain('CARD-MAIN')
    expect(systemText(request)).not.toContain('UPDATED-CARD-MAIN')
    expect(snapshots(request)).toHaveLength(1)
    expect(textOf(snapshots(request)[0]!)).toContain('CARD-PHI')
    expect(textOf(snapshots(request)[0]!)).not.toContain('UPDATED-CARD-PHI')
    expect(request.messages.find(message => message.id === input.id)).toEqual(input)
  }
  expect(systemText(second)).toBe(systemText(first))
  expect(snapshots(second)).toEqual(snapshots(first))
  const toolCall = second.messages.find(message => message.role === 'assistant' && message.content.some(block => block.type === 'tool-call'))!
  const toolResult = second.messages.find(message => message.source.kind === 'tool')!
  expect(toolCall.content).toEqual([{ type: 'tool-call', id: ToolCallId('factory-call'), name: 'factory_edit_preset', arguments: '{}' }])
  expect(toolResult.content).toEqual([{ type: 'tool-result', toolCallId: ToolCallId('factory-call'), content: [{ type: 'text', text: 'FACTORY-TOOL-RESULT' }], isError: false }])
  await send(userMessage('新一轮使用更新预设'))
  expect(requests).toHaveLength(3)
  const third = requests[2]!
  expect(third.temperature).toBe(0.92)
  expect(third.maxTokens).toBe(333)
  expect(third.stop ?? []).toEqual([])
  expect(systemText(third)).toContain('PRESET-MAIN')
  expect(systemText(third)).not.toContain('UPDATED-CARD-MAIN')
  expect(textOf(snapshots(third).at(-1)!)).toContain('PRESET-JAILBREAK')
  expect(textOf(snapshots(third).at(-1)!)).not.toContain('UPDATED-CARD-PHI')
  expect(third.messages.find(message => message.id === toolCall.id)).toEqual(toolCall)
  expect(third.messages.find(message => message.id === toolResult.id)).toEqual(toolResult)
})

it('导入格式和卡字段宏进入真实请求，最近消息宏随新输入更新且保留图片', async () => {
  await state.saveCharacter(cardId, { personality: '冷静', scenario: '山中', systemPrompt: 'CARD-MAIN', postHistoryInstructions: 'CARD-PHI' })
  const { preset } = parseStPreset({ name: '格式请求', identifier: 'request-formats',
    personality_format: '<traits>{{personality}}</traits>', scenario_format: '<scene>{{scenario}}：{{lastmessage}}</scene>',
    prompts: [
      { identifier: 'main', content: 'RULES={{charPrompt}}', forbid_overrides: true },
      { identifier: 'charPersonality', marker: true }, { identifier: 'scenario', marker: true },
      { identifier: 'chatHistory', marker: true },
      { identifier: 'rules', content: 'LATEST={{lastmessage}};USER={{lastusermessage}};CARD={{charInstruction}}' },
      { identifier: 's', role: 'system', content: 'DEPTH-SYSTEM', injection_position: 1, injection_depth: 0, injection_order: 20 },
      { identifier: 'u', role: 'user', content: 'DEPTH-USER', injection_position: 1, injection_depth: 0, injection_order: 20 },
      { identifier: 'a', role: 'assistant', content: 'DEPTH-ASSISTANT', injection_position: 1, injection_depth: 0, injection_order: 20 },
    ],
  })
  const id = await state.savePreset(preset)
  await state.saveBinding({ ...(await state.loadBinding(agent.id))!, presetId: id })
  config = resolveConfig({})
  const first = userMessage('去山顶', true)
  await send(first)
  await send(userMessage('回山脚'))
  expect(requests).toHaveLength(2)
  for (const [index, request] of requests.entries()) {
    const latest = index === 0 ? '去山顶' : '回山脚'
    expect(systemText(request)).toContain('RULES=CARD-MAIN')
    expect(systemText(request)).toContain('<traits>冷静</traits>')
    const snapshot = textOf(snapshots(request).at(-1)!)
    expect(snapshot).toContain(`<scene>山中：${latest}</scene>`)
    expect(snapshot).toContain(`LATEST=${latest};USER=${latest};CARD=CARD-PHI`)
    expect(snapshot).toContain('DEPTH-ASSISTANT\n\nDEPTH-USER\n\nDEPTH-SYSTEM')
    expect(request.messages.find(message => message.id === first.id)).toEqual(first)
  }
})

it.each([undefined, 2500])('分支后清空预设上限，保留真正父级上限 %s 而非上一请求的预设值', async hostMaxTokens => {
  if (hostMaxTokens !== undefined) agent.options.maxTokens = hostMaxTokens
  await send(userMessage('源会话按预设上限生成'))
  expect(requests[0]!.maxTokens).toBe(777)
  expect(agent.session.requestHeader()?.config.maxTokens).toBe(777)

  const childId = SessionId('preset-live-child')
  const sourceBinding = (await state.loadBinding(agent.id))!
  await state.saveBinding({ ...sourceBinding, sessionId: childId, storyId: undefined })
  const seed = agent.session.snapshotEvents()
  const handle = await ctx.agents.create({ sessionId: childId, seed, inheritedEventCount: SessionLogOffset(seed.length),
    meta: { parentSession: agent.id, isSeeded: true }, agentOptions: forkAgentOptions(agent, agent.session),
    setup: childCtx => applyAgent(childCtx),
  })
  children.push(handle)
  expect(handle.agent.options.maxTokens).toBe(hostMaxTokens)
  expect(handle.agent.session.requestHeader()?.config.maxTokens).toBe(777)

  const preset = (await state.loadPreset(presetId))!
  await state.savePreset({ ...preset, sampling: { ...preset.sampling, maxTokens: null } })
  await send(userMessage('分支清空临时预设上限后继续'), handle.agent)
  expect(requests).toHaveLength(2)
  expect(requests[1]!.maxTokens).toBe(hostMaxTokens)
  expect(handle.agent.session.requestHeader()?.config.maxTokens).toBe(hostMaxTokens)
  expect(agent.session.requestHeader()?.config.maxTokens).toBe(777)
})
