/** 剧情隔离集成：真实文件存储 + 模拟宿主，覆盖分支、编辑、迁移、失败发布、并发卡片修改。 */
import { mkdir, mkdtemp, rm, readFile, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { adoptHostFork, regenerate, editAssistantMessage, rollbackToFloor, getFloorSiblings } from '../src/node/floors.js'
import { saveBinding, type SessionBinding } from '../src/node/bindings.js'
import * as bindingStorage from '../src/node/bindings.js'
import { appendSiblingFork, loadSiblingForks } from '../src/state/siblings.js'
import { MemoryStore } from '../src/state/memory.js'
import { resolveReadableAssetPath } from '../src/core/assetRead.js'
import { CONTINUE_INSTRUCTION_PREFIX } from '../src/core/dshPrompt.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'
import { registerMemoryMaintenance } from '../src/node/memoryMaintenance.js'
import { recordRequestDiagnostics, registerRequestDiagnostics } from '../src/node/requestDiagnostics.js'

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
    { type: 'user/message', surfaceOp: 'append', data: createUserMessage({ content: [{ type: 'text', text: '开门' }], source: { kind: 'user' } }) },
    { type: 'assistant/message', surfaceOp: 'append', data: {stream: [],  turn: number, step: 1, message: createAssistantMessage({ content: [{ type: 'text', text: '门打开了' }], source: { provider: 'test', model: 'test' } }) } },
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

it('导航清理与新分支登记并发时保留新分支，只删除已确认的悬空记录', async () => {
  addSession('old-child', turn(1))
  const fork = (childSessionId: string) => ({ parentSessionId: 'parent', childSessionId, turn: 1, createdAt: '2026-01-01' })
  await appendSiblingFork(root, fork('old-child'))
  await appendSiblingFork(root, fork('missing-child'))
  let entered!: () => void, release!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const original = bindingStorage.loadBinding
  const probe = vi.spyOn(bindingStorage, 'loadBinding').mockImplementation(async (paths, sessionId) => {
    if (sessionId === 'missing-child') { entered(); await gate }
    return original(paths, sessionId)
  })
  try {
    const reading = getFloorSiblings({ ctx, state }, 'parent', undefined, 1)
    await started
    addSession('new-child', turn(1))
    const adding = appendSiblingFork(root, fork('new-child'))
    release()
    await Promise.all([reading, adding])
    expect((await loadSiblingForks(root)).map(fork => fork.childSessionId).sort()).toEqual(['new-child', 'old-child'])
    expect((await getFloorSiblings({ ctx, state }, 'parent', undefined, 1)).swipe?.siblings).toEqual(['parent', 'new-child', 'old-child'])
  } finally { release(); probe.mockRestore() }
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

it.each(['binding', 'metadata'] as const)('读取时拒绝 %s 中错误的剧情所属会话，不能开启写入另一会话的楼层', async mode => {
  await state.saveBinding(binding('other'))
  const parentBinding = (await state.loadBinding('parent'))!
  const otherBinding = (await state.loadBinding('other'))!
  const parent = await workspace('parent'), other = await workspace('other')
  await parent.fs.writeText('journal.md', 'parent 原文')
  await other.fs.writeText('journal.md', 'other 原文')
  if (mode === 'binding') {
    await saveBinding(state.paths, { ...parentBinding, storyId: otherBinding.storyId })
  } else {
    const path = join(parent.fs.root, 'story.json')
    const metadata = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...metadata, sessionId: 'other' }))
  }
  await expect(state.loadBinding('parent')).rejects.toThrow(/剧情状态属于另一会话/)
  await expect(onTurnStart(state, 'parent', 2)).rejects.toThrow(/剧情状态属于另一会话/)
  expect(state.openFloors.has('parent')).toBe(false)
  expect(await parent.fs.readText('journal.md')).toBe('parent 原文')
  expect(await other.fs.readText('journal.md')).toBe('other 原文')
  expect(await parent.wal.listFloors()).toEqual([])
  expect(await other.wal.listFloors()).toEqual([])
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

it('来源剧情含链接目录时拒绝分支，不悄悄发布缺文件的子剧情', async () => {
  const ws = await workspace('parent')
  const outside = join(root, 'outside-memory')
  await mkdir(outside)
  await writeFile(join(outside, 'private.md'), '不属于剧情的文件')
  await mkdir(join(ws.fs.root, 'memory'), { recursive: true })
  await symlink(outside, join(ws.fs.root, 'memory', 'linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(regenerate({ ctx, state }, 'parent')).rejects.toThrow('链接')
  expect(created).not.toHaveBeenCalled()
  expect(await state.listStories(cardId)).toHaveLength(1)
  expect(await readFile(join(outside, 'private.md'), 'utf8')).toBe('不属于剧情的文件')
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

it.each(['host', 'tavern-adapter'] as const)('请求诊断在序列化前剥除新旧私有布局，保留其它来源和图片：%s', stage => {
  const privatePlan = { version: 1 as const, sessionId: 'parent', turn: 1, standingText: 'PRIVATE-LAYOUT', contextText: '',
    layout: { version: 1 as const, history: [], entries: [] }, toJSON: vi.fn(() => { throw new Error('私有布局不应被序列化') }) }
  const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '实际原文' },
    { type: 'image', attachment: { attachmentId: AttachmentId('a'.repeat(64)), mediaType: 'image/png', bytes: 32, width: 1, height: 1, name: 'factory.png' } }] })
  const attached = Object.freeze({ ...original, source: Object.freeze({ ...original.source, tavernPromptPlan: privatePlan, factory: { keep: true } }) })
  const legacy = { ...createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '旧载体标记' }] }),
    source: { kind: 'tavern-prompt-plan' as const, plan: privatePlan } }
  const request = { sessionId: 'parent', provider: 'test', model: 'test', messages: [attached, legacy],
    tools: [{ name: 'factory_tool', description: '保留工具', parameters: {} }] }
  recordRequestDiagnostics(state, 'parent', request, stage)
  const recorded = state.requestDiagnostics.get('parent')!
  const data = JSON.parse(recorded.text)
  expect(data.stage).toBe(stage)
  expect(data.request.messages[0]).toEqual({ ...original, source: { kind: 'user', factory: { keep: true } } })
  expect(data.request.messages[1].source).toEqual({ kind: 'tavern-prompt-plan' })
  expect(data.request.tools).toEqual(request.tools)
  expect(recorded.text).not.toContain('PRIVATE-LAYOUT')
  expect(recorded.text).not.toContain('tavernPromptPlan')
  expect(recorded.truncated).toBe(false)
  expect(privatePlan.toJSON).not.toHaveBeenCalled()
  expect(attached.source.tavernPromptPlan).toBe(privatePlan)
  expect(legacy.source.plan).toBe(privatePlan)
})

it('诊断遇到其它来源的循环元数据时记录失败提示，宿主和适配器调用仍能继续', () => {
  let observe: (options: unknown, next: () => unknown) => unknown = () => {}
  const scoped = { ...ctx, on: (_name: string, fn: typeof observe) => { observe = fn } } as unknown as Context
  registerRequestDiagnostics(scoped, state)
  const circular: Record<string, unknown> = {}; circular.self = circular
  const original = createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: '正常请求正文' }] })
  const request = { sessionId: 'parent', provider: 'test', model: 'test',
    messages: [{ ...original, source: { ...original.source, foreign: circular } }] }
  const sentinel = {}, next = vi.fn(() => sentinel)
  expect(observe(request, next)).toBe(sentinel)
  expect(next).toHaveBeenCalledExactlyOnceWith()
  expect(JSON.parse(state.requestDiagnostics.get('parent')!.text)).toMatchObject({ stage: 'host', error: expect.stringContaining('生成继续') })
  expect(() => recordRequestDiagnostics(state, 'parent', request, 'tavern-adapter')).not.toThrow()
  expect(JSON.parse(state.requestDiagnostics.get('parent')!.text)).toMatchObject({ stage: 'tavern-adapter', error: expect.stringContaining('生成继续') })
})

/** 宿主原生「在新对话中分支」：只复制日志前缀，子会话头带 parentSession/isSeeded 与继承长度。 */
function hostFork(id: string, events: SessionEvent[], inherited: number, header: Record<string, unknown> = {}): Session {
  const child = { id, header: { agentPreset: 'tavern', parentSession: 'parent', isSeeded: true, ...header },
    inheritedEventCount: inherited, snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'test', model: 'test' } }) } as unknown as Session
  sessions.set(id, child)
  return child
}
const bodies = async (id: string) => (await (await workspace(id)).memory.list()).map((m) => m.body).sort()

it('宿主原生分支按继承边界准备独立剧情并绑定；来源剧情不变', async () => {
  addSession('parent', [...turn(1), ...turn(2)])
  await writeFact('parent', 1, '门打开了')
  await writeFact('parent', 2, '钥匙丢了')
  const child = hostFork('host-child', turn(1), 4)
  expect(await adoptHostFork({ ctx, state }, child)).toBe(true)
  const adopted = (await state.loadBinding('host-child'))!
  expect(adopted.storyId).not.toBe((await state.loadBinding('parent'))!.storyId)
  expect(adopted.walLineage).toEqual([{ sessionId: 'parent', throughTurn: 1 }])
  expect(await bodies('host-child')).toEqual(['门打开了'])
  expect(await bodies('parent')).toEqual(['钥匙丢了', '门打开了'])
  // 子剧情继续写入不回流来源。
  await writeFact('host-child', 2, '窗户开着')
  expect(await bodies('parent')).toEqual(['钥匙丢了', '门打开了'])
})

it('宿主分支停在某轮最终回复处保留该层；停在多步轮次中途则撤销该层派生事实', async () => {
  const closed = [...turn(1), ...turn(2)]
  addSession('parent', closed)
  await writeFact('parent', 2, '钥匙丢了')
  // 前缀含第 2 轮的最终回复但没有 turn/end：来源其后只有收口帧，写入完全属于子会话。
  expect(await adoptHostFork({ ctx, state }, hostFork('at-reply', closed.slice(0, 7), 7))).toBe(true)
  expect(await bodies('at-reply')).toEqual(['钥匙丢了'])

  const reply = closed[6]!
  const multiStep = [...closed.slice(0, 6), { ...reply, data: { ...reply.data, step: 1 } },
    { type: 'tool/call', seq: 7, time: 7, data: { turn: 2, step: 1, callId: 'c', name: 'run_code', arguments: '{}' } },
    { ...reply, seq: 8, data: { ...reply.data, step: 2 } },
    { type: 'turn/end', seq: 9, time: 9, data: { turn: 2, reason: { kind: 'completed' } } }] as SessionEvent[]
  addSession('parent', multiStep)
  expect(await adoptHostFork({ ctx, state }, hostFork('mid-turn', multiStep.slice(0, 7), 7))).toBe(true)
  expect(await bodies('mid-turn')).toEqual([])
  expect((await state.loadBinding('mid-turn'))!.walLineage).toEqual([{ sessionId: 'parent', throughTurn: 1 }])
  expect(await bodies('parent')).toEqual(['钥匙丢了'])
})

it('插件自身分支创建期间触发的接管让位，子会话只有一份剧情；读取绑定会等待接管完成', async () => {
  await writeFact('parent', 1, '门打开了')
  const adoptions: Promise<boolean>[] = []
  const create = (ctx as unknown as { agents: { create: (opts: { sessionId: string }) => Promise<unknown> } }).agents.create
  ;(ctx as unknown as { agents: { create: unknown } }).agents.create = async (opts: { sessionId: string }) => {
    const handle = await create(opts)
    // 宿主在 create 内同步广播 session/created；此时插件绑定尚未落盘。让接管先跑完，覆盖最不利的时序。
    const adoption = state.trackBindingAdoption(opts.sessionId, () => adoptHostFork({ ctx, state }, sessions.get(opts.sessionId)!))
    adoptions.push(adoption)
    await adoption
    return handle
  }
  const storiesBefore = (await state.listStories(cardId)).length
  const result = await rollbackToFloor({ ctx, state }, 'parent', undefined, 1)
  expect(await Promise.all(adoptions)).toEqual([false])
  // 只有插件分支自己的一份新剧情，接管没有另建草稿或覆盖绑定。
  expect((await state.listStories(cardId)).length).toBe(storiesBefore + 1)
  expect(await bodies(result.childSessionId)).toEqual(['门打开了'])

  const pending = state.trackBindingAdoption('late-child', () => adoptHostFork({ ctx, state }, hostFork('late-child', turn(1), 4)))
  expect((await state.loadBinding('late-child'))?.cardId).toBe(cardId)
  expect(await pending).toBe(true)
})

it('来源未绑定、子代理或已有绑定的会话不接管', async () => {
  sessions.set('loose', { id: 'loose', header: { agentPreset: 'tavern' }, snapshotEvents: () => [] } as unknown as Session)
  expect(await adoptHostFork({ ctx, state }, hostFork('orphan', turn(1), 4, { parentSession: 'loose' }))).toBe(false)
  expect(await state.loadBinding('orphan')).toBeNull()
  expect(await adoptHostFork({ ctx, state }, hostFork('subagent', turn(1), 4, { delegationDepth: 1 }))).toBe(false)
  expect(await state.loadBinding('subagent')).toBeNull()
  await state.saveBinding(binding('bound-child'))
  const before = (await state.loadBinding('bound-child'))!.storyId
  expect(await adoptHostFork({ ctx, state }, hostFork('bound-child', turn(1), 4))).toBe(false)
  expect((await state.loadBinding('bound-child'))!.storyId).toBe(before)
})
