/** 宿主认领输入回归：真实 AgentLoop 与剧情文件验证排队输入、身份、取消和续写不会串轮。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type LlmResolvedModelInfo, type Message, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { ToolRuntime } from '@deepseek-ai/dsh-tools'
import { apply as applyAgent } from '../src/agent.js'
import { defaultPreset } from '../src/core/assemble.js'
import { CONTINUE_INSTRUCTION_PREFIX, formatTurnStepNotice } from '../src/core/dshPrompt.js'
import { Marker, type PresetEntry } from '../src/core/types.js'
import type { TemplateContext } from '../src/core/template.js'
import { resolveConfig } from '../src/node/config.js'
import { registerPromptInputTracking } from '../src/node/pendingInputs.js'
import { registerHelperMvuLifecycle } from '../src/node/helperMvuLifecycle.js'
import * as helperMvu from '../src/node/helperMvu.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { loadTemplateState } from '../src/state/template.js'
import { templateGenerationContext } from '../src/state/templateGeneration.js'

vi.mock('../src/node/tools.js', () => ({ registerTavernTools: vi.fn() }))
vi.mock('../src/node/memoryMaintenance.js', () => ({ registerMemoryMaintenance: vi.fn() }))

let root: string, ctx: Context, state: TavernState, agent: Agent, cardId: string, storyId: string
let firstRequest: ReturnType<typeof Promise.withResolvers<void>>, releaseFirst: ReturnType<typeof Promise.withResolvers<void>>
let blockFirst = false
const requests: GenerateOptions[] = []
const persistedContexts: TemplateContext[] = []
const errors: unknown[] = []
const textOf = (message: Message) => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const promptOf = (request: GenerateOptions) => request.messages.map(textOf).join('\n')
const user = (text: string, image = false) => createUserMessage({ source: { kind: 'user' }, content: [
  ...(text ? [{ type: 'text' as const, text }] : []),
  ...(image ? [{ type: 'image' as const, attachment: { attachmentId: AttachmentId('a'.repeat(64)), mediaType: 'image/png' as const,
    bytes: 32, width: 1, height: 1, name: 'factory.png' } }] : []),
] })
const notice = (text: string) => createUserMessage({ source: { kind: 'dsh-tavern', form: 'notice', summary: '工厂通知' },
  content: [{ type: 'text', text }] } as unknown as Parameters<typeof createUserMessage>[0])
const entry = (identifier: string, content: string, extra: Partial<PresetEntry> = {}): PresetEntry => ({ identifier, name: identifier,
  content, role: 'system', enabled: true, position: 'relative', depth: 0, order: 20, marker: false, ...extra })

/** 工厂流只在首请求设置可控闸门，不访问真实模型或附件。 */
class FactoryAdapter extends LlmAdapter {
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return { provider, id: model, name: model, inputModalities: ['text', 'image'], context: { contextWindow: 64_000 } }
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    requests.push(options)
    const generation = (await loadTemplateState((await state.storyWorkspace(cardId, storyId)).fs)).generation
    if (generation?.status === 'prepared') persistedContexts.push(templateGenerationContext(generation))
    if (requests.length === 1 && blockFirst) {
      firstRequest.resolve()
      await releaseFirst.promise
    }
    yield { type: 'text-delta', index: 0, text: '工厂回复' }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

beforeEach(async () => {
  requests.length = 0; persistedContexts.length = 0; errors.length = 0; blockFirst = false
  firstRequest = Promise.withResolvers<void>(); releaseFirst = Promise.withResolvers<void>()
  root = await mkdtemp(join(tmpdir(), 'tavern-pending-turn-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  cardId = (await state.createCharacter('认领输入工厂')).cardId
  await state.saveLorebook('queued-book', { entries: { one: { uid: 1, key: ['QUEUED-KEY'], content: 'QUEUED-LORE', constant: false } } })
  const presetId = await state.savePreset({ ...defaultPreset(), identifier: 'claimed-input-factory', entries: [
    entry('main', 'FACTORY-MAIN'),
    entry(Marker.WorldInfoBefore, '', { marker: true, markerId: Marker.WorldInfoBefore }),
    entry(Marker.ChatHistory, '', { marker: true, markerId: Marker.ChatHistory, order: 30 }),
    entry('latest', 'USER={{lastusermessage}};LAST={{lastmessage}};<% setvar("latest", _.last(getChatMessages(-1)) ?? "") %>'),
    entry('normal', 'NORMAL-ONLY', { injectionTrigger: ['normal'] }),
    entry('continue', 'CONTINUE-ONLY', { injectionTrigger: ['continue'] }),
  ] })
  await state.saveBinding({ sessionId: 'pending-turn-factory', cardId, presetId, personaId: null, lorebookIds: ['queued-book'],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  storyId = (await state.loadBinding('pending-turn-factory'))!.storyId!
  await attachRuntime()
})

/** 通过公开 seed 重建宿主日志时不会重放 inserted 通知；本轮输入须在新 driver 的 claim 恢复。 */
async function attachRuntime(seed?: readonly SessionEvent[]): Promise<void> {
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {}); new ToolRuntime(ctx)
  const llm = new LlmRuntime(ctx); llm.registerAdapter(['factory'], new FactoryAdapter())
  const loop = new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
  agent = seed ? (await ctx.agents.create({ sessionId: SessionId('pending-turn-factory'), seed,
    agentOptions: { provider: 'factory', model: 'factory' } })).agent
    : await loop.create(SessionId('pending-turn-factory'), { provider: 'factory', model: 'factory' })
  if (!seed) agent.session.append('agent-preset/selected', { agentPreset: 'tavern' })
  ctx.provide('tavern', { state })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') void state.enqueueSessionTask(session.id, () => onTurnStart(state, session.id, event.data.turn, session)).catch(error => errors.push(error))
    if (event.type === 'turn/end') {
      const events = session.snapshotEvents()
      void state.enqueueSessionTask(session.id, () => onTurnEnd(state, session.id, { id: session.id, snapshotEvents: () => events })).catch(error => errors.push(error))
    }
  })
  registerPromptInputTracking(ctx, state)
  registerHelperMvuLifecycle(ctx)
  ctx.on('agent/error', ({ error }) => errors.push(error))
  applyAgent(agent.ctx)
}

afterEach(async () => {
  vi.restoreAllMocks()
  releaseFirst?.resolve()
  agent?.cancel({ kind: 'disposed' }, { keepInbox: true })
  await agent?.whenIdle()
  if (state && agent) await state.waitForSessionTasks(agent.id)
  await ctx?.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})

async function idle(): Promise<void> {
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(errors).toEqual([])
}

it('生成期间排队的下一条输入首次组装就更新宏、WI和持久模板历史', async () => {
  blockFirst = true
  agent.followup(user('FIRST'))
  await firstRequest.promise
  const queued = user('QUEUED-KEY')
  agent.followup(queued)
  releaseFirst.resolve()
  await idle()
  expect(requests).toHaveLength(2)
  expect(promptOf(requests[0]!)).toContain('USER=FIRST;LAST=FIRST;')
  expect(promptOf(requests[0]!)).not.toContain('QUEUED-LORE')
  expect(promptOf(requests[1]!)).toContain('USER=QUEUED-KEY;LAST=QUEUED-KEY;')
  expect(promptOf(requests[1]!)).toContain('QUEUED-LORE')
  expect(requests[1]!.messages.some(message => message.id === queued.id)).toBe(true)
  const stored = await loadTemplateState((await state.storyWorkspace(cardId, storyId)).fs)
  expect(stored.variables.message.latest).toBe('QUEUED-KEY')
  expect(persistedContexts[1]!.historyIdentities?.at(-1)?.messageId).toBe(queued.id)
})

it('未认领的后续队列不提前进入首轮，第二轮也保留纯图片身份', async () => {
  const first = user('FIRST'), queued = user('', true)
  agent.followup(first)
  agent.followup(queued)
  await idle()
  expect(requests).toHaveLength(2)
  expect(promptOf(requests[0]!)).toContain('USER=FIRST;LAST=FIRST;')
  expect(persistedContexts[0]!.historyIdentities?.map(value => value.messageId)).toEqual([first.id])
  expect(persistedContexts[1]!.historyIdentities?.at(-1)?.messageId).toBe(queued.id)
  expect(persistedContexts[1]!.history.at(-1)).toMatchObject({ role: 'user', content: '' })
  expect(requests[1]!.messages.find(message => message.id === queued.id)).toEqual(queued)
})

it('取消保留的队列下一轮重新认领，旧步骤通知过滤且续写场景保持', async () => {
  blockFirst = true
  agent.followup(user('FIRST'))
  await firstRequest.promise
  agent.inject(notice(formatTurnStepNotice(2)))
  const queued = user('QUEUED-KEY')
  agent.followup(queued)
  agent.cancel({ kind: 'user' }, { keepInbox: true })
  releaseFirst.resolve()
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  agent.followup(notice(CONTINUE_INSTRUCTION_PREFIX + '继续'))
  await idle()
  expect(requests).toHaveLength(3)
  expect(promptOf(requests[1]!)).toContain('USER=QUEUED-KEY;LAST=QUEUED-KEY;')
  expect(promptOf(requests[1]!)).toContain('NORMAL-ONLY')
  expect(requests[1]!.messages.map(textOf).some(text => text.startsWith('【Tavern 步骤】'))).toBe(false)
  expect(promptOf(requests[2]!)).toContain('CONTINUE-ONLY')
})

it('未认领的队列被取消丢弃后不触发后续输入的世界书或模板', async () => {
  const queued = user('QUEUED-KEY')
  agent.inbox.append('next-turn', queued)
  agent.inbox.remove(queued.id)
  agent.followup(user('AFTER-DISCARD'))
  await idle()
  expect(requests).toHaveLength(1)
  expect(promptOf(requests[0]!)).toContain('USER=AFTER-DISCARD;LAST=AFTER-DISCARD;')
  expect(promptOf(requests[0]!)).not.toContain('QUEUED-LORE')
  expect(persistedContexts[0]!.historyIdentities?.some(value => value.messageId === queued.id)).toBe(false)
})

it('MVU暂缓轮把输入保留原生队列，结束清理后重新认领同一ID', async () => {
  const pending = vi.spyOn(helperMvu, 'helperMvuPending').mockResolvedValue(true)
  const first = user('QUEUED-KEY')
  agent.followup(first)
  await idle()
  expect(requests).toHaveLength(0)
  expect(agent.inbox.nextTurn.map(value => value.id)).toEqual([first.id])
  expect(state.pendingInputs.has(agent.id)).toBe(false)
  expect(state.pendingTemplateInputs.has(agent.id)).toBe(false)
  pending.mockRestore()
  agent.followup(user('AFTER-GATE'))
  await idle()
  expect(requests).toHaveLength(2)
  expect(promptOf(requests[0]!)).toContain('USER=QUEUED-KEY;LAST=QUEUED-KEY;')
  expect(promptOf(requests[0]!)).toContain('QUEUED-LORE')
  expect(persistedContexts[0]!.historyIdentities?.at(-1)?.messageId).toBe(first.id)
  expect(promptOf(requests[1]!)).toContain('USER=AFTER-GATE;LAST=AFTER-GATE;')
})

it('重建宿主和Tavern运行时后，持久inbox未重发inserted仍按认领进入首轮', async () => {
  const queued = user('QUEUED-KEY')
  agent.inbox.append('next-turn', queued)
  const seed = agent.session.snapshotEvents()
  await ctx.fiber.dispose()
  state = new TavernState(state.paths, () => resolveConfig({}))
  await state.init()
  await attachRuntime(seed)
  expect(state.pendingInputs.has(agent.id)).toBe(false)
  agent.followup(user('AFTER-RESTART'))
  await idle()
  expect(requests).toHaveLength(2)
  expect(promptOf(requests[0]!)).toContain('USER=QUEUED-KEY;LAST=QUEUED-KEY;')
  expect(promptOf(requests[0]!)).toContain('QUEUED-LORE')
  expect(persistedContexts[0]!.historyIdentities?.at(-1)?.messageId).toBe(queued.id)
  expect(promptOf(requests[1]!)).toContain('USER=AFTER-RESTART;LAST=AFTER-RESTART;')
})
