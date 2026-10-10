/**
 * 空闲时补记忆检索别名的集成回归：真实 AgentLoop 的维护通道与剧情文件，模型用手写的工厂适配器代替。
 * 验证：一次空闲只发一次辅助请求，成功后换说法的问法能检索到；截断、取消、出错不保存任何东西并在下一个结束的轮次重试；
 * 回复不合格式时不反复请求；压缩优先于别名；设置关闭后不发请求。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentRegistry, type Agent } from '@deepseek-ai/dsh-agent'
import { AgentLoop } from '@deepseek-ai/dsh-agent-loop'
import type { GenerateOptions, LlmRuntime, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import { resolveConfig } from '../src/node/config.js'
import { registerMemoryMaintenance } from '../src/node/memoryMaintenance.js'
import { TavernState } from '../src/node/state.js'

type Reply = (options: Readonly<GenerateOptions>) => AsyncIterable<StreamChunk>
const text = (body: string): Reply => async function* () {
  yield { type: 'text-delta', text: body } as StreamChunk
  yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
}
const truncated = (body: string): Reply => async function* () {
  yield { type: 'text-delta', text: body } as StreamChunk
  yield { type: 'finish', reason: { kind: 'length' } } as StreamChunk
}

let root: string, ctx: Context, agent: Agent, state: TavernState, turn = 0
const requests: Array<Readonly<GenerateOptions>> = []
let replies: Reply[] = []

afterEach(async () => {
  agent?.cancel({ kind: 'disposed' }, { keepInbox: true })
  await agent?.whenIdle()
  await ctx?.fiber.dispose()
  if (root) await rm(root, { recursive: true, force: true })
  requests.length = 0; replies = []; turn = 0
})

async function setup(memory: Record<string, unknown> = {}) {
  root = await mkdtemp(join(tmpdir(), 'memory-alias-maintenance-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') },
  () => resolveConfig({ memory }))
  await state.init()
  const { cardId } = await state.createCharacter('别名维护工厂角色')
  await state.saveBinding({ sessionId: 'alias-maintenance', cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  const binding = (await state.loadBinding('alias-maintenance'))!
  const ws = await state.storyWorkspace(cardId, binding.storyId)
  ctx = new Context()
  new SessionStore(ctx); new AgentRegistry(ctx); new SessionProjectionRegistry(ctx); new SystemPrompt(ctx, {})
  const loop = new AgentLoop(ctx, AgentLoop.Config({ agents: [] }))
  agent = await loop.create(SessionId('alias-maintenance'), { provider: 'factory', model: 'factory-model' })
  const llm = { stream(options: GenerateOptions) {
    requests.push(options)
    const reply = replies.shift()
    if (!reply) throw new Error('工厂适配器没有准备这次回复')
    return reply(options)
  } } as unknown as LlmRuntime
  registerMemoryMaintenance(ctx, state, llm)
  return { ws, binding }
}

/** 结束一个轮次并进入空闲，等维护任务跑完。 */
async function idle(): Promise<void> {
  turn++
  agent.session.append('turn/start', { turn }); agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await state.waitForSessionTasks(agent.id); await agent.whenIdle()
}

const promptOf = (options: Readonly<GenerateOptions>): string =>
  (options.messages[0]!.content as Array<{ type: string; text?: string }>).map((part) => part.text ?? '').join('')
const found = async (ws: Awaited<ReturnType<typeof setup>>['ws'], query: string): Promise<string[]> =>
  (await ws.memory.search(query, { topK: 20 })).map((hit) => hit.entry.body)

const PILLS = '医务室的止痛剂上个月少了两箱，值班记录被人改过。'
const HE = '禾对合成蛋白过敏，只能吃温室种的豆子。'

it('空闲时用会话模型为新记忆补别名，之后换说法的问法能检索到；没有新记忆时不再请求', async () => {
  const { ws } = await setup()
  await ws.memory.write({ body: PILLS })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await ws.memory.write({ body: HE })
  expect(await found(ws, '谁在偷药')).toEqual([])
  expect(await found(ws, '那个小女孩不能碰什么食物')).toEqual([])
  // 候选按最新在前：序号 1 是禾，序号 2 是止痛剂
  replies = [text('1: 禾、过敏、食物、饮食禁忌\n2: 药、药品、失窃、偷药')]
  await idle()
  expect(requests).toHaveLength(1)
  expect(requests[0]).toMatchObject({ provider: 'factory', model: 'factory-model' })
  expect(promptOf(requests[0]!)).toContain(`【1】${HE}`)
  expect(promptOf(requests[0]!)).toContain(`【2】${PILLS}`)
  expect(await found(ws, '谁在偷药')).toEqual([PILLS])
  expect(await found(ws, '那个小女孩不能碰什么食物')).toEqual([HE])
  // 记忆文件本身没有变化；别名不在楼层 WAL 里
  expect((await ws.memory.list()).map((entry) => entry.body).sort()).toEqual([HE, PILLS].sort())
  expect(await ws.fs.list('state/wal')).toEqual([])
  // 全部补过之后，后面的空闲不再请求
  await idle(); await idle()
  expect(requests).toHaveLength(1)
  // 再写一条：只为新的这条请求
  await ws.memory.write({ body: '总部计划明年关闭灰烬站。' })
  replies = [text('1: 关站、停运、撤离')]
  await idle()
  expect(requests).toHaveLength(2)
  expect(promptOf(requests[1]!)).not.toContain(PILLS)
  expect(await found(ws, '什么时候停运')).toEqual(['总部计划明年关闭灰烬站。'])
})

it('回复被截断或出错时不保存任何东西；同一个结束的轮次不重试，下一个轮次重试', async () => {
  const { ws } = await setup()
  await ws.memory.write({ body: PILLS })
  replies = [truncated('1: 药、失窃')]
  await idle()
  expect(requests).toHaveLength(1)
  expect(await ws.fs.exists('memory/aliases.json')).toBe(false)
  expect(await found(ws, '谁在偷药')).toEqual([])
  // 同一个轮次再次进入空闲：不重发
  ctx.emit('agent/status', { agent, status: 'idle' })
  await state.waitForSessionTasks(agent.id); await agent.whenIdle()
  expect(requests).toHaveLength(1)
  // 适配器直接抛错
  replies = [() => { throw new Error('工厂适配器故障') }]
  await idle()
  expect(requests).toHaveLength(2)
  expect(await ws.fs.exists('memory/aliases.json')).toBe(false)
  replies = [text('1: 药、失窃')]
  await idle()
  expect(requests).toHaveLength(3)
  expect(await found(ws, '谁在偷药')).toEqual([PILLS])
})

it('回复正常结束但不合格式：这批记忆记为没有别名，不反复请求；正文改动后才再请求', async () => {
  const { ws } = await setup()
  const entry = await ws.memory.write({ body: PILLS })
  replies = [text('抱歉，我无法完成这个请求。')]
  await idle()
  expect(requests).toHaveLength(1)
  const file = JSON.parse(await readFile(join(ws.fs.root, 'memory', 'aliases.json'), 'utf8')) as { entries: Record<string, { aliases: string[] }> }
  expect(file.entries[entry.id]!.aliases).toEqual([])
  await idle(); await idle()
  expect(requests).toHaveLength(1)
  await ws.memory.update(entry.id, { body: '医务室的止痛剂又少了一箱。' })
  replies = [text('1: 药、失窃')]
  await idle()
  expect(requests).toHaveLength(2)
  expect(await found(ws, '谁在偷药')).toEqual(['医务室的止痛剂又少了一箱。'])
})

it('用户取消维护时，迟到的正常回复也不保存', async () => {
  const { ws } = await setup()
  await ws.memory.write({ body: PILLS })
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  replies = [async function* () {
    entered.resolve()
    // 工厂适配器故意忽略取消信号
    await release.promise
    yield { type: 'text-delta', text: '1: 药、失窃' } as StreamChunk
    yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
  }]
  turn++
  agent.session.append('turn/start', { turn }); agent.session.append('turn/end', { turn, reason: { kind: 'completed' } })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await entered.promise
  agent.cancel({ kind: 'user' })
  release.resolve()
  await state.waitForSessionTasks(agent.id); await agent.whenIdle()
  expect(requests[0]!.signal?.aborted).toBe(true)
  expect(await ws.fs.exists('memory/aliases.json')).toBe(false)
  replies = [text('1: 药、失窃')]
  await idle()
  expect(await found(ws, '谁在偷药')).toEqual([PILLS])
})

it('有待压缩的批次时这次空闲只做压缩，别名留到下一次空闲', async () => {
  const { ws } = await setup({ maxEntries: 1, compressBatch: 2 })
  await ws.memory.write({ body: PILLS })
  await ws.memory.write({ body: HE })
  replies = [text('止痛剂少了两箱；禾对合成蛋白过敏。')]
  await idle()
  expect(requests).toHaveLength(1)
  expect(promptOf(requests[0]!)).toContain('合并为一条')
  expect((await ws.memory.list()).map((entry) => entry.body)).toEqual(['止痛剂少了两箱；禾对合成蛋白过敏。'])
  expect(await ws.fs.exists('memory/aliases.json')).toBe(false)
  replies = [text('1: 药、失窃、食物')]
  await idle()
  expect(requests).toHaveLength(2)
  expect(promptOf(requests[1]!)).toContain('【1】止痛剂少了两箱；禾对合成蛋白过敏。')
  expect((await found(ws, '谁在偷药'))[0]).toBe('止痛剂少了两箱；禾对合成蛋白过敏。')
})

it('设置关闭后不发送别名请求，已有别名继续生效', async () => {
  const { ws } = await setup({ aliasExpansion: false })
  const entry = await ws.memory.write({ body: PILLS })
  await idle(); await idle()
  expect(requests).toHaveLength(0)
  const plain = await state.plainWorkspace((await state.loadBinding('alias-maintenance'))!.cardId, (await state.loadBinding('alias-maintenance'))!.storyId)
  await plain.memory.saveAliases([{ entry, aliases: ['药', '失窃'] }])
  expect(await found(ws, '谁在偷药')).toEqual([PILLS])
  await idle()
  expect(requests).toHaveLength(0)
})
