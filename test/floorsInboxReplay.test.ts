/** 楼层分支输入重放：真实 AgentLoop、Session 与工厂模型，验证截断前入队的旧输入不会在分支续聊时复活。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type LlmResolvedModelInfo, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { editUserMessage, forkEditedHistory, regenerate, rollbackToFloor } from '../src/node/floors.js'
import { editedHistorySeed } from '../src/node/helperChatSeed.js'
import { resolveConfig } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'

let root: string, ctx: Context, state: TavernState, agent: Agent
const requests: GenerateOptions[] = [], errors: unknown[] = []
const publishedSeeds = new Map<string, readonly SessionEvent[]>()
let gate: { entered: ReturnType<typeof Promise.withResolvers<void>>; released: ReturnType<typeof Promise.withResolvers<void>> } | undefined
const textOf = (message: Message) => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const ordinaryInputs = (request: GenerateOptions) => request.messages.filter(message => message.role === 'user' && message.source.kind === 'user').map(textOf)
const user = (text: string) => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })

/** 第一轮可控挂起，确保下一条 followup 的持久入队发生在回退边界之前；不访问网络。 */
class FactoryAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 64_000 } }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    requests.push(options)
    if (requests.length === 1 && gate) { gate.entered.resolve(); await gate.released.promise }
    yield { type: 'text-delta', index: 0, text: `工厂回复：${ordinaryInputs(options).at(-1)}` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

beforeEach(async () => {
  requests.length = 0; errors.length = 0; publishedSeeds.clear(); gate = undefined
  root = await mkdtemp(join(tmpdir(), 'tavern-floor-inbox-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  const cardId = (await state.createCharacter('输入重放工厂角色')).cardId
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  new LlmRuntime(ctx).registerAdapter(['factory'], new FactoryAdapter())
  new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
  ctx.provide('agentPresets', { composedPreset: () => 'tavern', resolve: async () => ({ id: 'tavern' }), mount: async () => {} })
  ctx.on('agent/error', ({ error }) => errors.push(error))
  ctx.on('agent/created', ({ agent: created }) => {
    if (created.session.header.parentSession) publishedSeeds.set(created.id, created.session.snapshotEvents())
  })
  agent = (await ctx.agents.create({ sessionId: SessionId('session-inbox-parent'), meta: { agentPreset: 'tavern' }, agentOptions: { provider: 'factory', model: 'factory' } })).agent
  await state.saveBinding({ sessionId: agent.id, cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null,
    interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
})

afterEach(async () => { gate?.released.resolve(); await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }) })

async function send(text: string, target = agent): Promise<void> {
  target.followup(user(text)); await target.whenIdle(); expect(errors).toEqual([])
}

function firstReplyId(): string {
  const event = agent.session.snapshotEvents().find(event => event.type === 'assistant/message')
  if (!event || event.type !== 'assistant/message') throw new Error('工厂会话缺少回复')
  return event.data.message.id
}

function assertColdInboxEmpty(target: Agent): void {
  const cold = Session.create(SessionId('session-cold-inbox-check'), target.session.snapshotEvents())
  expect.soft(ctx.sessionProjections.stateOf(cold, 'inbox')).toEqual({ 'next-turn': [], 'next-step': [] })
  expect.soft(target.inbox.nextTurn).toEqual([])
  expect.soft(target.inbox.nextStep).toEqual([])
}

function assertPublishedInboxEmpty(target: Agent): void {
  const seed = publishedSeeds.get(target.id)
  expect(seed).toBeDefined()
  const cold = Session.create(SessionId('session-published-inbox-check'), seed)
  expect(ctx.sessionProjections.stateOf(cold, 'inbox')).toEqual({ 'next-turn': [], 'next-step': [] })
}

it('回退前已排队的后续输入不随分支复活，冷重放及续聊后队列均为空', async () => {
  gate = { entered: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() }
  agent.followup(user('保留的第一轮'))
  await gate.entered.promise
  agent.followup(user('应该丢弃的后续输入'))
  gate.released.resolve(); await agent.whenIdle()
  expect(requests).toHaveLength(2)
  const parentBefore = agent.session.snapshotEvents()
  const result = await rollbackToFloor({ ctx, state }, agent.id, firstReplyId())
  const child = ctx.agents.get(SessionId(result.childSessionId))!
  assertColdInboxEmpty(child)
  const requestCount = requests.length
  await send('回退后的新输入', child)
  expect(requests.slice(requestCount).map(ordinaryInputs)).toEqual([['保留的第一轮', '回退后的新输入']])
  assertColdInboxEmpty(child)
  assertPublishedInboxEmpty(child)
  expect(agent.session.snapshotEvents()).toEqual(parentBefore)
})

it.each(['regenerate', 'edit-user'] as const)('%s 只处理一次明确驱动的输入，不重放截断前的入队副本', async kind => {
  await send('原始工厂输入')
  const parentBefore = agent.session.snapshotEvents(), replyId = firstReplyId(), requestCount = requests.length
  const result = kind === 'regenerate'
    ? await regenerate({ ctx, state }, agent.id, replyId)
    : await editUserMessage({ ctx, state }, agent.id, replyId, '编辑后的工厂输入')
  const child = ctx.agents.get(SessionId(result.childSessionId))!
  await child.whenIdle()
  expect(errors).toEqual([])
  expect(requests.slice(requestCount).map(ordinaryInputs)).toEqual([[kind === 'regenerate' ? '原始工厂输入' : '编辑后的工厂输入']])
  assertColdInboxEmpty(child)
  assertPublishedInboxEmpty(child)
  expect(agent.session.snapshotEvents()).toEqual(parentBefore)
})

it('助手删除分支取消两类旧队列，已删除正文不会从完整 seed 中再次进入模型请求', async () => {
  await send('保留的工厂台词')
  await send('将被删除的工厂台词')
  const sourceEvents = agent.session.snapshotEvents()
  const secondUser = sourceEvents.filter(event => event.type === 'user/message' && event.data.source.kind === 'user').at(-1)!
  const secondReply = sourceEvents.filter(event => event.type === 'assistant/message').at(-1)!
  // 用公开 API 停放新输入而不唤醒 driver，覆盖完整历史分支携带待办队列的情形。
  agent.send(user('将被删除的工厂台词'), 'next-turn', false)
  agent.send(user('旧步骤的排队指令'), 'next-step', false)
  const parentBefore = agent.session.snapshotEvents(), requestCount = requests.length
  const binding = (await state.loadBinding(agent.id))!
  const seed = editedHistorySeed(parentBefore, new Map(), new Set([secondUser.seq, secondReply.seq]))
  const result = await forkEditedHistory({ ctx, state }, agent.id, binding.storyId!, seed, 2, async () => {}, undefined, '删除聊天消息')
  const child = ctx.agents.get(SessionId(result.childSessionId))!
  assertColdInboxEmpty(child)
  assertPublishedInboxEmpty(child)
  await send('删除后的新台词', child)
  expect(requests.slice(requestCount).map(ordinaryInputs)).toEqual([['保留的工厂台词', '删除后的新台词']])
  expect(child.session.deriveMessages().map(textOf).join('\n')).not.toContain('将被删除的工厂台词')
  expect(child.session.deriveMessages().map(textOf).join('\n')).not.toContain('旧步骤的排队指令')
  assertColdInboxEmpty(child)
  expect(agent.session.snapshotEvents()).toEqual(parentBefore)
  expect(agent.inbox.nextTurn.map(textOf)).toEqual(['将被删除的工厂台词'])
  expect(agent.inbox.nextStep.map(textOf)).toEqual(['旧步骤的排队指令'])
})
