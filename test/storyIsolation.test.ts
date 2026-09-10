/** 剧情隔离集成：真实文件存储 + 模拟宿主，覆盖分支、编辑、迁移、失败发布、并发卡片修改。 */
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { regenerate, editAssistantMessage, rollbackToFloor } from '../src/node/floors.js'
import { saveBinding, type SessionBinding } from '../src/node/bindings.js'
import { MemoryStore } from '../src/state/memory.js'
import { resolveReadableAssetPath } from '../src/core/assetRead.js'
import { CONTINUE_INSTRUCTION_PREFIX } from '../src/core/dshPrompt.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'
import { registerMemoryMaintenance } from '../src/node/memoryMaintenance.js'
import { registerRequestDiagnostics } from '../src/node/requestDiagnostics.js'

let root: string, state: TavernState, cardId: string, ctx: Context
const sessions = new Map<string, Session>()
const agents = new Map<string, unknown>()
const created = vi.fn()

function binding(sessionId: string): SessionBinding {
  return { sessionId, cardId, presetId: null, personaId: null, lorebookIds: [], characterLorebookId: null,
    interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() }
}
function addSession(id: string, events: SessionEvent[], header = { agentPreset: 'tavern' }): void {
  sessions.set(id, { id, header, inheritedEventCount: 0, snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'test', model: 'test' } }) } as unknown as Session)
  agents.set(id, { ctx: {}, options: { provider: 'test', model: 'test' }, followup: vi.fn(), dispose: vi.fn() })
}
function turn(number: number): SessionEvent[] {
  const events = [
    { type: 'turn/start', data: { turn: number } },
    { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: '开门' }], source: { kind: 'user' } }) },
    { type: 'assistant/message', data: { turn: number, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '门打开了' }], source: { provider: 'test', model: 'test' } }) } },
    { type: 'turn/end', data: { turn: number, reason: { kind: 'completed' } } },
  ]
  return events.map((e, seq) => ({ ...e, seq: (number - 1) * 4 + seq, time: seq })) as SessionEvent[]
}
async function workspace(id: string) {
  const b = await state.loadBinding(id)
  return state.storyWorkspace(cardId, b!.storyId)
}
async function writeFact(id: string, n: number, body: string) {
  const ws = await workspace(id)
  const floor = `${id}#t${n}`
  await ws.wal.beginFloor(floor)
  const result = await new MemoryStore(ws.fs.withFloor(floor)).write({ body })
  await ws.wal.commitFloor(floor)
  return result
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-stories-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'),
    presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
  cardId = (await state.createCharacter('工厂角色')).cardId
  sessions.clear(); agents.clear(); created.mockReset()
  const presets = { composedPreset: () => 'tavern', resolve: async () => ({ id: 'tavern' }), mount: vi.fn() }
  ctx = { get: (key: string) => key === 'agentPresets' ? presets : undefined,
    sessions: { get: (id: string) => sessions.get(id) }, logger: { warn: vi.fn() },
    agents: { get: (id: string) => agents.get(id), withoutInitiator: (fn: () => unknown) => fn(),
      create: async (opts: { sessionId: string; seed?: SessionEvent[]; meta: { agentPreset: string } }) => {
        created(opts); addSession(opts.sessionId, opts.seed ?? [], opts.meta)
        return { dispose: vi.fn() }
      } },
  } as unknown as Context
  addSession('parent', turn(1))
  await state.saveBinding(binding('parent'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('连续重生成兄弟分支：原会话的事实不变，兄弟新事实不会串入下一分支', async () => {
  await writeFact('parent', 1, '门打开了')
  const first = await regenerate({ ctx, state }, 'parent')
  expect((await (await workspace('parent')).memory.list()).map((m) => m.body)).toEqual(['门打开了'])
  expect(await (await workspace(first.childSessionId)).memory.list()).toEqual([])
  await writeFact(first.childSessionId, 1, '门锁住了')
  const second = await regenerate({ ctx, state }, 'parent')
  expect(await (await workspace(second.childSessionId)).memory.list()).toEqual([])
  expect((await (await workspace(first.childSessionId)).memory.list())[0]!.body).toBe('门锁住了')
  expect((await state.workspace(cardId)).fs.root).not.toBe((await workspace('parent')).fs.root)
})

it('重生成续写轮时驱动消息保留插件 notice 来源，不把续写指令变成用户台词', async () => {
  const instruction = createUserMessage({ content: [{ type: 'text', text: `${CONTINUE_INSTRUCTION_PREFIX}请继续` }],
    source: { kind: 'plugin', plugin: 'dsh-tavern', form: 'notice', summary: '续写指令' } })
  const events = [...turn(1), ...turn(2).map((e) => e.type === 'user/message' ? { ...e, data: instruction } : e)] as SessionEvent[]
  addSession('parent', events)
  const child = await regenerate({ ctx, state }, 'parent')
  const followup = (agents.get(child.childSessionId) as { followup: ReturnType<typeof vi.fn> }).followup
  expect(followup).toHaveBeenCalledTimes(1)
  const driven = followup.mock.calls[0]![0] as { content: unknown; source: unknown }
  expect(driven.source).toEqual(instruction.source)
  expect(driven.content).toEqual(instruction.content)
  const plain = await regenerate({ ctx, state }, 'parent', undefined, 1)
  const plainDriven = (agents.get(plain.childSessionId) as { followup: ReturnType<typeof vi.fn> }).followup.mock.calls[0]![0] as { source: unknown }
  expect(plainDriven.source).toEqual({ kind: 'user' })
})

it('编辑 assistant 撤销该层派生事实，保留新正文；再次回退祖先仍使用各自副本', async () => {
  await writeFact('parent', 1, '门打开了')
  const event = sessions.get('parent')!.snapshotEvents()[2]!
  const messageId = (event.data as { message: { id: string } }).message.id
  const child = await editAssistantMessage({ ctx, state }, 'parent', messageId, '门一直关着')
  expect(await (await workspace(child.childSessionId)).memory.list()).toEqual([])
  expect(JSON.stringify(sessions.get(child.childSessionId)!.snapshotEvents())).toContain('门一直关着')
  expect((await (await workspace('parent')).memory.list())[0]!.body).toBe('门打开了')
  const kept = await rollbackToFloor({ ctx, state }, 'parent', messageId)
  expect((await (await workspace(kept.childSessionId)).memory.list())[0]!.body).toBe('门打开了')
})

it('新会话复制初始状态；旧绑定只迁移一次并保留原目录', async () => {
  const template = await state.workspace(cardId)
  await template.memory.write({ body: '初始事实' })
  await state.saveBinding(binding('fresh'))
  await saveBinding(state.paths, binding('legacy'))
  const legacy = await state.loadBinding('legacy')
  await template.memory.write({ body: '后来的模板编辑' })
  expect((await (await workspace('fresh')).memory.list()).map((m) => m.body)).toEqual(['初始事实'])
  expect((await state.loadBinding('legacy'))!.storyId).toBe(legacy!.storyId)
  expect((await (await workspace('legacy')).memory.list()).map((m) => m.body)).toEqual(['初始事实'])
  expect((await template.memory.list()).length).toBe(2)
  expect(resolveReadableAssetPath(`stories/${legacy!.storyId}/memory/a.md`).ok).toBe(false)
})

it('子会话已创建但绑定落盘失败时，用创建句柄移除子会话并丢弃草稿剧情', async () => {
  const handle = { dispose: vi.fn(async () => undefined) }
  const registry = ctx.agents as unknown as { create: (opts: { sessionId: string; seed?: SessionEvent[]; meta: { agentPreset: string } }) => Promise<unknown> }
  registry.create = async (opts) => { created(opts); addSession(opts.sessionId, opts.seed ?? [], opts.meta); return handle }
  const original = state.saveBinding.bind(state)
  vi.spyOn(state, 'saveBinding').mockImplementation(async (b) => {
    if (b.sessionId !== 'parent') throw new Error('磁盘故障')
    return original(b)
  })
  await expect(regenerate({ ctx, state }, 'parent')).rejects.toThrow('准备分支失败')
  expect(created).toHaveBeenCalledTimes(1)
  expect(handle.dispose).toHaveBeenCalledTimes(1)
  expect(await state.listStories(cardId)).toHaveLength(1)
})

it('源 WAL 损坏时拒绝分支，宿主尚未创建子会话且原状态完整', async () => {
  await writeFact('parent', 1, '门打开了')
  const ws = await workspace('parent')
  const file = join(ws.fs.root, 'state/wal/parent_t1/records.jsonl')
  await writeFile(file, await readFile(file, 'utf8') + '{broken\n')
  await expect(regenerate({ ctx, state }, 'parent')).rejects.toThrow('WAL 记录损坏')
  expect(created).not.toHaveBeenCalled()
  expect((await (await workspace('parent')).memory.list())[0]!.body).toBe('门打开了')
  expect(await state.listStories(cardId)).toHaveLength(1)
})

it('并发卡片 patch 锁住完整读改写，不丢另一字段', async () => {
  await Promise.all([state.saveCharacter(cardId, { name: '新名字' }), state.saveCharacter(cardId, { description: '新描述' })])
  expect((await state.loadCharacter(cardId))!.card).toMatchObject({ name: '新名字', description: '新描述' })
})

it('宿主 turn 事件开启独立 WAL；提交按原绑定，且清理每轮缓存', async () => {
  await onTurnStart(state, 'parent', 2)
  const b = await state.loadBinding('parent')
  expect(state.openFloors.get('parent')?.storyId).toBe(b!.storyId)
  const ws = await workspace('parent')
  await new MemoryStore(ws.fs.withFloor('parent#t2')).write({ body: '当前轮事实' })
  await onTurnEnd(state, 'parent')
  expect((await ws.wal.listFloors()).find((f) => f.floor === 'parent#t2')?.committed).toBe(true)
  expect(state.currentTurns.has('parent')).toBe(false)
  expect(state.turnPlans.has('parent')).toBe(false)
})

it('维护失败保留 pending；自身 idle 不循环重试，下一个结束轮次才再试', async () => {
  const b = await state.loadBinding('parent')
  state.pendingMemoryCompress.add(b!.storyId!)
  let idle: (payload: unknown) => void = () => {}
  const maintenance = vi.fn(async (task: () => Promise<void>) => { await task(); idle({ agent, status: 'idle' }) })
  const agent = { id: 'parent', session: sessions.get('parent'), options: {}, runMaintenance: maintenance }
  const scoped = { ...ctx, on: (_name: string, fn: typeof idle) => { idle = fn } } as unknown as Context
  registerMemoryMaintenance(scoped, state, undefined)
  idle({ agent, status: 'idle' })
  await state.waitForSessionTasks('parent'); await state.waitForSessionTasks('parent')
  expect(maintenance).toHaveBeenCalledTimes(1)
  expect(state.pendingMemoryCompress.has(b!.storyId!)).toBe(true)
  addSession('parent', [...turn(1), ...turn(2)])
  agent.session = sessions.get('parent')
  idle({ agent, status: 'idle' })
  await state.waitForSessionTasks('parent'); await state.waitForSessionTasks('parent')
  expect(maintenance).toHaveBeenCalledTimes(2)
})

it('请求诊断只读捕获冻结请求，保留真实消息与工具，并原样执行 next', () => {
  let observe: (options: unknown, next: () => unknown) => unknown = () => {}
  const scoped = { ...ctx, on: (_name: string, fn: typeof observe) => { observe = fn } } as unknown as Context
  registerRequestDiagnostics(scoped, state)
  const request = Object.freeze({ sessionId: 'parent', provider: 'test', model: 'test', system: 'host tools + standing',
    messages: Object.freeze([{ role: 'user', content: [{ type: 'text', text: '实际原文' }] }]), tools: [{ name: 'tool' }] })
  const sentinel = {}; const next = vi.fn(() => sentinel)
  expect(observe(request, next)).toBe(sentinel)
  expect(next).toHaveBeenCalledExactlyOnceWith()
  const recorded = state.requestDiagnostics.get('parent')!
  expect(JSON.parse(recorded.text).request).toEqual(request)
  expect(recorded.truncated).toBe(false)
})
