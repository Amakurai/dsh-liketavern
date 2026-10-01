/** 写工具排队竞态：真实剧情文件和模拟宿主工具注册验证换绑/换层后拒写，复核到提交期间持锁。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { resolveConfig } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'
import { registerTavernTools } from '../src/node/tools.js'
import { withWorkspaceLock } from '../src/state/workspaceLock.js'
import { MemoryStore } from '../src/state/memory.js'

const lockProbe = vi.hoisted(() => ({ root: '', queued: null as (() => void) | null, acquired: null as (() => void) | null }))
vi.mock('../src/state/workspaceLock.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/state/workspaceLock.js')>()
  return { ...actual, withWorkspaceLock: <T>(root: string, task: () => Promise<T>) => {
    if (root === lockProbe.root) lockProbe.queued?.()
    return actual.withWorkspaceLock(root, async () => {
      if (root === lockProbe.root) lockProbe.acquired?.()
      return task()
    })
  } }
})

const roots: string[] = []
afterEach(async () => {
  lockProbe.root = ''; lockProbe.queued = null; lockProbe.acquired = null
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'tool-write-rebind-')); roots.push(root)
  const state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') },
  () => resolveConfig({}))
  await state.init()
  const cardA = await state.createCharacter('原剧情角色'), cardB = await state.createCharacter('换绑角色')
  const sessionId = 'write-rebinding'
  await state.saveBinding({ sessionId, cardId: cardA.cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: false, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  const binding = (await state.loadBinding(sessionId))!, ws = await state.storyWorkspace(binding.cardId, binding.storyId)
  const original = await ws.memory.write({ body: '旧剧情的灯笼仍然点亮' })
  await ws.fs.writeText('index.json', '{"factory":"original"}\n')
  const floor = `${sessionId}#t1`
  await ws.wal.beginFloor(floor)
  state.openFloors.set(sessionId, { cardId: binding.cardId, storyId: binding.storyId, floor })
  state.currentTurns.set(sessionId, 1)
  const definitions = new Map<string, ToolDefinition>()
  const ctx = { tools: { register(definition: ToolDefinition) { definitions.set(definition.name, definition) } } }
  registerTavernTools(ctx as unknown as Context, state)
  const inject = vi.fn()
  const exec = { agent: { id: sessionId, inject } } as unknown as ToolRunContext
  return { state, ws, binding, cardB, original, floor, definitions, exec, inject, sessionId }
}

it.each(['tavern_memory_write', 'tavern_memory_update', 'tavern_worldstate_update'])('%s 等锁期间换绑后拒绝修改旧剧情', async name => {
  const { state, ws, binding, cardB, original, floor, definitions, exec, inject } = await setup()
  const held = Promise.withResolvers<void>(), unlock = Promise.withResolvers<void>(), queued = Promise.withResolvers<void>()
  const holder = withWorkspaceLock(ws.fs.root, async () => { held.resolve(); await unlock.promise })
  await held.promise
  lockProbe.root = ws.fs.root; lockProbe.queued = queued.resolve
  const args = name === 'tavern_memory_update' ? { id: original.id, body: '旧剧情灯笼已熄灭' }
    : name === 'tavern_memory_write' ? { body: '不属于旧剧情的新事实' } : { type: 'add', content: '旧剧情桥梁坍塌' }
  const writing = definitions.get(name)!.execute(args, exec)
  try {
    await queued.promise
    await state.saveBinding({ ...binding, cardId: cardB.cardId, storyId: undefined })
  } finally {
    lockProbe.root = ''; lockProbe.queued = null
    unlock.resolve(); await holder
  }
  const result = await writing as { ok: boolean; error?: string }
  expect(result.ok).toBe(false)
  expect(result.error).toContain('binding-changed')
  expect((await ws.memory.list()).map(entry => entry.body)).toEqual([original.body])
  expect(await ws.deltas.list()).toEqual([])
  expect(await ws.fs.readText('index.json')).toBe('{"factory":"original"}\n')
  expect(await ws.fs.readText(`state/wal/${floor.replace('#', '_')}/records.jsonl`)).toBeNull()
  expect(inject.mock.calls.some(call => JSON.stringify(call).includes('已落盘') || JSON.stringify(call).includes('已更新') || JSON.stringify(call).includes('已记录'))).toBe(false)
  const rebound = (await state.loadBinding(binding.sessionId))!, fresh = await state.storyWorkspace(rebound.cardId, rebound.storyId)
  expect(await fresh.memory.list()).toEqual([])
  expect(await fresh.deltas.list()).toEqual([])
})

it.each(['tavern_memory_write', 'tavern_memory_update', 'tavern_worldstate_update'])('%s 等锁期间旧楼层被替换后拒绝修改', async name => {
  const { state, ws, binding, original, floor, definitions, exec } = await setup()
  const held = Promise.withResolvers<void>(), unlock = Promise.withResolvers<void>(), queued = Promise.withResolvers<void>()
  const holder = withWorkspaceLock(ws.fs.root, async () => { held.resolve(); await unlock.promise })
  await held.promise
  lockProbe.root = ws.fs.root; lockProbe.queued = queued.resolve
  const args = name === 'tavern_memory_update' ? { id: original.id, body: '新轮次改写旧灯笼' }
    : name === 'tavern_memory_write' ? { body: '新轮次旅人抵达桥头' } : { type: 'add', content: '新轮次桥梁坍塌' }
  const writing = definitions.get(name)!.execute(args, exec)
  try {
    await queued.promise
    // 模拟宿主在工具排队时切换活动句柄；旧 WAL 尚未提交，因此仅靠 WAL 的 committed 检查挡不住。
    state.currentTurns.set(binding.sessionId, 2)
    state.openFloors.set(binding.sessionId, { cardId: binding.cardId, storyId: binding.storyId, floor: `${binding.sessionId}#t2` })
  } finally {
    lockProbe.root = ''; lockProbe.queued = null
    unlock.resolve(); await holder
  }
  const result = await writing as { ok: boolean; error?: string }
  expect(result.ok).toBe(false)
  expect(result.error).toContain('floor-stale')
  expect((await ws.memory.list()).map(entry => entry.body)).toEqual([original.body])
  expect(await ws.deltas.list()).toEqual([])
  expect(await ws.fs.readText(`state/wal/${floor.replace('#', '_')}/records.jsonl`)).toBeNull()
})

it('写入复核通过后换绑等待完整提交，随后会话任务也能完成', async () => {
  const { state, ws, binding, cardB, original, definitions, exec, inject } = await setup()
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), queued = Promise.withResolvers<void>()
  const order: string[] = []
  const update = MemoryStore.prototype.update
  vi.spyOn(MemoryStore.prototype, 'update').mockImplementation(async function (...args) {
    entered.resolve(); await release.promise
    return update.apply(this, args)
  })
  inject.mockImplementation(message => {
    if (JSON.stringify(message).includes('已更新')) order.push('write-ack')
  })
  const writing = definitions.get('tavern_memory_update')!.execute({ id: original.id, body: '原剧情已确认的灯笼修订' }, exec)
  await entered.promise
  lockProbe.root = state.paths.sessions; lockProbe.queued = queued.resolve
  lockProbe.acquired = () => { order.push('binding-lock'); lockProbe.acquired = null }
  const rebinding = state.saveBinding({ ...binding, cardId: cardB.cardId, storyId: undefined })
  await queued.promise
  // 模拟更新期间新增的宿主收口任务；写事务不得在锁内再等这个队列。
  const closing = state.enqueueSessionTask(binding.sessionId, () => withWorkspaceLock(ws.fs.root, async () => {}))
  release.resolve()
  const result = await writing as { ok: boolean }
  await Promise.all([rebinding, closing])
  expect(result.ok).toBe(true)
  expect(order).toEqual(['write-ack', 'binding-lock'])
  expect((await ws.memory.get(original.id))?.body).toBe('原剧情已确认的灯笼修订')
  expect((await state.loadBinding(binding.sessionId))?.cardId).toBe(cardB.cardId)
})
