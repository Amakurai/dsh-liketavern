/** 开场白持久兼容：真实文件、Session/AgentLoop 与发布版迁移器验证首节点、首次输入和分支重载。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage, LlmAdapter, LlmRuntime, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionFormatArtifact, SessionFormatEvent, SessionFormatMigrationContext } from '@deepseek-ai/dsh-session-format'
import { createSessionFormatV3ToV4, RELEASED_V3_EVENT_TYPES, restoreReleasedV4Artifact } from '@deepseek-ai/dsh-session-format-v3-to-v4'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { ensureGreeting, enterGreetingConversation, sessionPrefixEvents, swipeGreeting } from '../src/node/floors.js'
import { greetingTurnEvents } from '../src/node/greetingSeed.js'
import { reserveHelperMvuMaintenance } from '../src/node/helperMvuLifecycle.js'

let root: string, ctx: Context, state: TavernState, agent: Agent
const errors: unknown[] = []
beforeEach(async () => {
  errors.length = 0
  root = await mkdtemp(join(tmpdir(), 'tavern-greeting-migration-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'), presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  const { cardId } = await state.createCharacter('迁移测试')
  await state.saveCharacter(cardId, { firstMes: '开场白' })
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {})
  agent = await new AgentLoop(ctx, AgentLoop.Config({ agents: [] })).create(SessionId('session-greeting-migration'))
  agent.session.append('agent-preset/selected', { agentPreset: 'tavern' })
  await state.saveBinding({ sessionId: agent.id, cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null, greetingIndex: 0, interactiveCards: false, helperMvu: false, createdAt: new Date(0).toISOString() })
  class FactoryAdapter extends LlmAdapter {
    async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text: '回复' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  new LlmRuntime(ctx).registerAdapter(['factory'], new FactoryAdapter())
  ctx.systemPrompt.section({ name: 'factory', order: 1, text: '真实宿主提示词与工具说明' })
  ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'factory', model: 'factory' }))
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
})
afterEach(async () => {
  agent.cancel({ kind: 'disposed' }, { keepInbox: true })
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id); await ctx.fiber.dispose()
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

/** 经磁盘 JSON 往返和发布版 v3→v4 迁移，不能仅用较宽松的 Session.create 冒充重载验证。 */
async function migrate(events: readonly unknown[], inheritedEventCount = 0): Promise<SessionFormatArtifact> {
  const path = join(root, 'factory-session.json')
  await writeFile(path, JSON.stringify({ header: { version: 3, id: agent.id, createdAt: 1, isSeeded: inheritedEventCount > 0, delegationDepth: 0 }, inheritedEventCount, events }))
  const source = JSON.parse(await readFile(path, 'utf8')) as SessionFormatArtifact
  const result: SessionFormatEvent[] = []
  const migration = createSessionFormatV3ToV4([])
  const header = migration.migrateHeader(source.header)
  const output: SessionFormatMigrationContext = { emitEvent: event => { result.push(event) }, emitRun: run => { result.push(...run.expand()) } }
  const stage = migration.createStage({ sourceHeader: source.header, targetHeader: header, sourceInheritedEventCount: source.inheritedEventCount, sourceKind: 'decoded' })
  for (const event of source.events) stage.transformEvent(event, output)
  return restoreReleasedV4Artifact({ header, inheritedEventCount: stage.finish(output), events: result }, RELEASED_V3_EVENT_TYPES)
}

it.each(['点击进入', '首条输入补偿', '切换开场白'] as const)('%s：开场白、真实生成、回退前缀均可迁移重载', async mode => {
  if (mode === '点击进入') expect(await enterGreetingConversation({ ctx, state }, agent.id)).toBe(true)
  if (mode === '切换开场白') {
    const handle = await ctx.agents.create({ sessionId: SessionId('session-greeting-swipe'), seed: greetingTurnEvents('另一个开场白') })
    agent = handle.agent
  }
  if (mode === '首条输入补偿') ctx.on('agent/inbox/inserted', ({ agent: source }) => {
    void state.enqueueSessionTask(source.id, () => ensureGreeting({ ctx, state }, source.id)).catch(error => errors.push(error))
    reserveHelperMvuMaintenance(state, source, error => errors.push(error))
  })
  else await migrate(agent.session.snapshotEvents())
  agent.followup(createUserMessage({ content: [{ type: 'text', text: '继续' }], source: { kind: 'user' } }))
  await agent.whenIdle(); await state.waitForSessionTasks(agent.id)
  expect(errors).toEqual([])
  const events = agent.session.snapshotEvents()
  expect(events.filter(e => e.type === 'turn/start').map(e => e.data.turn)).toEqual([1, 2])
  expect(events.filter(e => e.type === 'assistant/message')).toHaveLength(2)
  const head = agent.session.eventAt(agent.session.surface.nodes[0]!)
  expect(head.type).toBe('system/message')
  expect(JSON.stringify(head.data)).toContain('真实宿主提示词与工具说明')
  await migrate(events)
  const end = events.find(e => e.type === 'turn/end')!
  const prefix = sessionPrefixEvents(events, end.seq)
  const child = await ctx.agents.create({ sessionId: SessionId('session-greeting-rollback'), seed: prefix,
    inheritedEventCount: prefix.length as typeof agent.session.inheritedEventCount, meta: { isSeeded: true } })
  await migrate(child.agent.session.snapshotEvents(), prefix.length)
  await child.dispose()
  // 重现旧顺序：删去首部占位系统消息，后续系统消息仍然存在；校验器必须识别此缺陷。
  const broken = events.filter(e => e.type !== 'system/message' || e.data.turn !== 1)
    .map((e, seq) => ({ ...e, seq, ...(e.type === 'system/message' ? { surfaceOp: 'append', sourceEventSeqs: undefined } : {}) }))
  await expect(migrate(broken)).rejects.toThrow('protected first surface head')
})

it('已开真实轮次时首条输入补偿不写游离 turn 0，也不抢占宿主 step', async () => {
  agent.session.append('turn/start', { turn: 1 })
  const before = agent.session.snapshotEvents()
  expect(await ensureGreeting({ ctx, state }, agent.id)).toBe(false)
  expect(agent.session.snapshotEvents()).toEqual(before)
})

it('读取角色期间宿主开轮，迟到的开场白初始化不改变日志', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const load = state.loadCharacter.bind(state)
  vi.spyOn(state, 'loadCharacter').mockImplementationOnce(async id => {
    entered.resolve(); await release.promise; return load(id)
  })
  const pending = enterGreetingConversation({ ctx, state }, agent.id)
  await entered.promise
  agent.session.append('turn/start', { turn: 1 })
  const before = agent.session.snapshotEvents()
  release.resolve()
  expect(await pending).toBe(false)
  expect(agent.session.snapshotEvents()).toEqual(before)
})

it.each(['已经生成', '读取角色', '准备分支'] as const)('切换开场白遇到%s期间的新输入，拒绝发布分支并保留来源剧情', async timing => {
  await enterGreetingConversation({ ctx, state }, agent.id)
  const binding = (await state.loadBinding(agent.id))!
  const ws = await state.storyWorkspace(binding.cardId, binding.storyId)
  await ws.fs.writeText('journal.md', '来源笔记')
  const create = vi.spyOn(ctx.agents, 'create')
  const start = () => { agent.session.append('turn/start', { turn: 2 }) }
  if (timing === '已经生成') start()
  if (timing === '读取角色') {
    const load = state.resolvePersona.bind(state)
    const loadBinding = state.loadBinding.bind(state)
    vi.spyOn(state, 'loadBinding').mockImplementationOnce(async id => {
      const value = await loadBinding(id)
      vi.spyOn(state, 'resolvePersona').mockImplementationOnce(async personaId => { start(); return load(personaId) })
      return value
    })
  }
  if (timing === '准备分支') {
    const fork = state.forkStory.bind(state)
    vi.spyOn(state, 'forkStory').mockImplementationOnce((source, id, prepare) => fork(source, id, async fs => {
      start(); await prepare(fs)
    }))
  }
  await expect(swipeGreeting({ ctx, state }, agent.id, 0)).rejects.toThrow(timing === '已经生成' ? '生成期间' : '对话已改变')
  expect(create).not.toHaveBeenCalled()
  expect(await state.loadBinding(agent.id)).toEqual(binding)
  expect(await ws.fs.readText('journal.md')).toBe('来源笔记')
  expect(agent.session.snapshotEvents().filter(e => e.type === 'assistant/message')).toHaveLength(1)
})
