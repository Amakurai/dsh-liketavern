/** 楼层续写并发回归：真实文件系统与公开 AgentLoop 验证读取绑定期间的历史变化不能让旧回复的续写驱动新楼层。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent, type AgentHandle } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, LlmAdapter, LlmRuntime, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { continueFloor } from '../src/node/floors.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'

let root: string, state: TavernState, ctx: Context, agent: Agent, handle: AgentHandle
const requests: GenerateOptions[] = [], errors: unknown[] = []
let holdSecond = false
let secondEntered: PromiseWithResolvers<void>, releaseSecond: PromiseWithResolvers<void>
class FactoryAdapter extends LlmAdapter {
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    requests.push(options)
    if (holdSecond && requests.length === 2) { secondEntered.resolve(); await releaseSecond.promise }
    yield { type: 'text-delta', index: 0, text: `工厂回复 ${requests.length}` }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
beforeEach(async () => {
  requests.length = 0; errors.length = 0; holdSecond = false
  secondEntered = Promise.withResolvers<void>(); releaseSecond = Promise.withResolvers<void>()
  root = await mkdtemp(join(tmpdir(), 'floor-continue-race-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'),
    personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  const cardId = (await state.createCharacter('续写并发工厂')).cardId
  await state.saveBinding({ sessionId: 'continue-factory', cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {})
  const llm = new LlmRuntime(ctx); llm.registerAdapter(['factory'], new FactoryAdapter())
  new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
  handle = await ctx.agents.create({ sessionId: SessionId('continue-factory'), agentOptions: { provider: 'factory', model: 'factory' } })
  agent = handle.agent
  agent.session.append('agent-preset/selected', { agentPreset: 'tavern' })
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') void state.enqueueSessionTask(session.id, () => onTurnStart(state, session.id, event.data.turn, session)).catch(error => errors.push(error))
    if (event.type === 'turn/end') {
      const events = session.snapshotEvents()
      void state.enqueueSessionTask(session.id, () => onTurnEnd(state, session.id, { id: session.id, snapshotEvents: () => events })).catch(error => errors.push(error))
    }
  })
  await send('第一轮用户输入')
})
afterEach(async () => {
  releaseSecond.resolve()
  vi.restoreAllMocks()
  agent?.cancel({ kind: 'disposed' }, { keepInbox: true }); await agent?.whenIdle()
  await state?.waitForSessionTasks(agent.id); await handle?.dispose(); await ctx?.fiber.dispose()
  await rm(root, { recursive: true, force: true })
})
async function send(text: string): Promise<void> {
  agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] }))
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
}
function replyId(): string {
  const event = agent.session.snapshotEvents().findLast(event => event.type === 'assistant/message')
  if (event?.type !== 'assistant/message') throw new Error('工厂缺少回复')
  return event.data.message.id
}
function bindingBarrier() {
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>()
  const original = state.loadBinding.bind(state)
  let held = false
  vi.spyOn(state, 'loadBinding').mockImplementation(async (...args) => {
    if (!held) { held = true; entered.resolve(); await released.promise }
    return original(...args)
  })
  return { entered, released }
}

it.each(['completed', 'running'] as const)('读取绑定期间第二轮 %s 时旧回复续写拒绝，不多发第三轮', async stage => {
  const firstReply = replyId(), barrier = bindingBarrier()
  const continuing = continueFloor({ ctx, state }, agent.id, firstReply).then(value => ({ value }), error => ({ error }))
  await barrier.entered.promise
  if (stage === 'completed') await send('已经改变历史的第二轮输入')
  else {
    holdSecond = true
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '正在生成的第二轮输入' }] }))
    await secondEntered.promise
  }
  barrier.released.resolve()
  const result = await continuing
  releaseSecond.resolve()
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(requests).toHaveLength(2)
  expect(result).toHaveProperty('error')
  expect(String('error' in result ? result.error : '')).toContain('对话已改变')
  expect(errors).toEqual([])
  const binding = (await state.loadBinding(agent.id))!, ws = await state.storyWorkspace(binding.cardId, binding.storyId)
  expect((await ws.wal.listFloors()).map(floor => floor.floor)).toEqual([agent.id + '#t1', agent.id + '#t2'])
})

it('历史未变的最后回复仍可续写，指令保持 notice 来源', async () => {
  const result = await continueFloor({ ctx, state }, agent.id, replyId())
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(result).toEqual({ continued: true })
  expect(requests).toHaveLength(2)
  const continuation = agent.session.snapshotEvents().filter(event => event.type === 'user/message').at(-1)
  expect(continuation?.type === 'user/message' ? continuation.data.source : undefined).toMatchObject({ kind: 'dsh-tavern', form: 'notice' })
  expect(errors).toEqual([])
})

it('读取绑定期间同 ID 会话重建，不向新运行时续写旧回复', async () => {
  const firstReply = replyId(), source = agent.session, seed = source.snapshotEvents()
  const barrier = bindingBarrier()
  const continuing = continueFloor({ ctx, state }, agent.id, firstReply).then(value => ({ value }), error => ({ error }))
  await barrier.entered.promise
  await handle.dispose()
  handle = await ctx.agents.create({ sessionId: SessionId('continue-factory'), seed, agentOptions: { provider: 'factory', model: 'factory' } })
  agent = handle.agent
  expect(agent.session).not.toBe(source)
  barrier.released.resolve()
  const result = await continuing
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(requests).toHaveLength(1)
  expect(String('error' in result ? result.error : '')).toContain('对话已改变')
  expect(errors).toEqual([])
})
