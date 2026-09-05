/**
 * 事务恢复回归：人工修订夹在模型写入之间、世界状态按 id 撤销、归并谱系及旧摘要恢复、
 * 生成摘要期间的编辑/回滚竞态、WAL 与正文替换故障、回滚与写入共享工作区锁。
 * 全部使用临时工作区与手写事实；不调用真实模型、不读用户运行期数据。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { resolveConfig } from '../src/node/config.js'
import { TavernState } from '../src/node/state.js'
import { compressOldestMemories } from '../src/node/memoryMaintenance.js'
import { MemoryStore } from '../src/state/memory.js'
import { WorldDeltaStore } from '../src/state/worlddelta.js'

const fault = vi.hoisted(() => ({ target: '', afterRename: false, gate: null as null | (() => Promise<void>) }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    if (fault.target && String(args[1]).endsWith(fault.target)) {
      fault.target = ''
      if (fault.afterRename) { fault.afterRename = false; await actual.rename(...args); throw new Error('测试：替换后崩溃') }
      if (fault.gate) { const gate = fault.gate; fault.gate = null; await gate() }
      else throw new Error('测试：原子替换失败')
    }
    return actual.rename(...args)
  } }
})

let root: string
let state: TavernState
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-recovery-'))
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'library/lorebooks'),
    presets: join(root, 'library/presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'), sessions: join(root, 'sessions') }, () => resolveConfig({}))
  await state.init()
})
afterEach(async () => {
  fault.target = ''; fault.gate = null; fault.afterRename = false
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

async function setup() {
  const ws = await state.workspace('audit')
  const panel = await state.plainWorkspace('audit')
  await ws.wal.beginFloor('s#t1')
  const fs = ws.fs.withFloor('s#t1')
  return { ws, panel, fs, memory: new MemoryStore(fs), deltas: new WorldDeltaStore(fs),
    rollback: () => ws.wal.rollbackFloor('s#t1', ws.fs.root) }
}
const delta = (content: string) => ({ type: 'add' as const, ref: null, content, keys: [], order: 100, sourceRange: 'test', expires: null })
const model = (text: string, beforeOutput?: () => Promise<unknown>) => ({ async *stream() {
  await beforeOutput?.()
  yield { type: 'text-delta', text }
        yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
} }) as unknown as LlmRuntime

describe('人工修订与楼层逆操作', () => {
  it('同层两次模型更新之间的人工修订在回滚后保留', async () => {
    const { panel, memory, rollback } = await setup()
    const entry = await panel.memory.write({ body: '最初事实' })
    await memory.update(entry.id, { body: '模型第一稿' })
    await panel.memory.update(entry.id, { body: '人工修订' }, { listMode: 'replace' })
    await memory.update(entry.id, { body: '模型第二稿' })
    await rollback()
    expect((await panel.memory.get(entry.id))?.body).toBe('人工修订')
  })

  it('模型创建的记忆经人工修订后，不因撤销创建操作被删掉', async () => {
    const { panel, memory, rollback } = await setup()
    const entry = await memory.write({ body: '模型创建' })
    await panel.memory.update(entry.id, { body: '人工确认的新事实' })
    await memory.update(entry.id, { body: '模型又改了' })
    await rollback()
    expect((await panel.memory.get(entry.id))?.body).toBe('人工确认的新事实')
  })

  it('人工删除不被回滚复活', async () => {
    const { panel, memory, rollback } = await setup()
    const entry = await panel.memory.write({ body: '最初事实' })
    await memory.update(entry.id, { body: '模型修改' })
    await panel.memory.delete(entry.id)
    await rollback()
    expect(await panel.memory.get(entry.id)).toBeNull()
  })

  it('同文件模型 A → 人工 B → 模型 C，回滚仅保留 B', async () => {
    const { panel, deltas, rollback, ws } = await setup()
    await deltas.append(delta('模型 A'))
    await panel.deltas.append(delta('人工 B'))
    await deltas.append(delta('模型 C'))
    await rollback()
    expect((await panel.deltas.list()).map((item) => item.content)).toEqual(['人工 B'])
    expect((await ws.wal.listFloors())[0]?.rolledBack).toBe(true)
  })

  it('不同会话写入同一变化层时，回滚其中一个只撤销它的 id', async () => {
    const { ws, panel, deltas, rollback } = await setup()
    await ws.wal.beginFloor('other#t1')
    const other = new WorldDeltaStore(ws.fs.withFloor('other#t1'))
    await Promise.all([deltas.append(delta('会话 A')), other.append(delta('会话 B'))])
    await rollback()
    expect((await panel.deltas.list()).map((item) => item.content)).toEqual(['会话 B'])
  })
})

describe('原子写入与失败恢复', () => {
  it('WAL 替换失败时正文不变、旧 WAL 仍完整可回滚', async () => {
    const { ws, fs, rollback } = await setup()
    await ws.fs.writeText('journal.md', '原文')
    await fs.writeText('journal.md', '第一稿')
    fault.target = 'records.jsonl'
    await expect(fs.writeText('journal.md', '第二稿')).rejects.toThrow('原子替换失败')
    expect(await ws.fs.readText('journal.md')).toBe('第一稿')
    const records = await readFile(join(ws.fs.root, 'state/wal/s_t1/records.jsonl'), 'utf8')
    expect(records.trim().split('\n').map((line) => JSON.parse(line))).toHaveLength(1)
    await rollback()
    expect(await ws.fs.readText('journal.md')).toBe('原文')
  })

  it('正文替换失败时旧正文完整，预写意图不阻止回滚', async () => {
    const { ws, fs, rollback } = await setup()
    await ws.fs.writeText('journal.md', '原文')
    await fs.writeText('journal.md', '第一稿')
    fault.target = 'journal.md'
    await expect(fs.writeText('journal.md', '第二稿')).rejects.toThrow('原子替换失败')
    expect(await ws.fs.readText('journal.md')).toBe('第一稿')
    await rollback()
    expect(await ws.fs.readText('journal.md')).toBe('原文')
  })

  it('活跃写路径不再依赖写完正文后补记 recordAfter', async () => {
    const { ws, fs, rollback } = await setup()
    await ws.fs.writeText('journal.md', '原文')
    const spy = vi.spyOn(ws.wal, 'recordAfter').mockRejectedValue(new Error('禁止后补'))
    await fs.writeText('journal.md', '第一稿')
    await fs.writeText('journal.md', '第二稿')
    expect(spy).not.toHaveBeenCalled()
    await rollback()
    expect(await ws.fs.readText('journal.md')).toBe('原文')
  })

  it('回滚等正文替换完成后再执行，不与写入穿插', async () => {
    const { ws, fs, rollback } = await setup()
    await ws.fs.writeText('journal.md', '原文')
    let release!: () => void
    let entered!: () => void
    const wait = new Promise<void>((resolve) => { release = resolve })
    const started = new Promise<void>((resolve) => { entered = resolve })
    fault.target = 'journal.md'
    fault.gate = async () => { entered(); await wait }
    const writing = fs.writeText('journal.md', '第一稿')
    await started
    const rollingBack = rollback()
    release()
    await Promise.all([writing, rollingBack])
    expect(await ws.fs.readText('journal.md')).toBe('原文')
  })
})

describe('摘要来源与回滚', () => {
  it('自动压缩后回滚新增事实，活跃库和检索都不再包含它', async () => {
    const { ws, memory, panel, rollback } = await setup()
    await memory.write({ body: '钥匙在塔中' })
    await ws.wal.commitFloor('s#t1')
    expect(await compressOldestMemories(state, model('钥匙在塔中'), 'audit', 'mock', 'mock')).not.toBeNull()
    await rollback()
    expect(await panel.memory.list()).toEqual([])
    expect(await panel.memory.search('钥匙')).toEqual([])
    expect(JSON.parse((await ws.fs.readText('index.json'))!).files).toEqual([])
  })

  it('嵌套归并展开后，只撤销目标楼层事实，保留其他来源', async () => {
    const { panel, memory, rollback } = await setup()
    await panel.memory.write({ body: '原有事实' })
    await memory.write({ body: '本层事实' })
    await panel.memory.mergeBatch(await panel.memory.list(), '第一层摘要', 'compress')
    await panel.memory.write({ body: '面板新增事实' })
    await panel.memory.mergeBatch(await panel.memory.list(), '第二层摘要', 'merge')
    await rollback()
    expect((await panel.memory.list()).map((entry) => entry.body).sort()).toEqual(['原有事实', '面板新增事实'])
  })

  it('回滚已被归并的更新，恢复原事实并保留同批其它事实', async () => {
    const { panel, memory, rollback } = await setup()
    const original = await panel.memory.write({ body: '更新前事实' })
    await memory.update(original.id, { body: '更新后事实' })
    await panel.memory.write({ body: '其它事实' })
    await panel.memory.mergeBatch(await panel.memory.list(), '摘要', 'compress')
    await rollback()
    expect((await panel.memory.list()).map((entry) => entry.body).sort()).toEqual(['其它事实', '更新前事实'])
  })

  it('兼容旧版只有 sourceRange 的手动归并，未关联摘要保持不变', async () => {
    const { panel, memory, rollback } = await setup()
    const item = await memory.write({ body: '本层事实' })
    await panel.memory.write({ body: '旧版摘要', sourceRange: `merge:${item.id}` })
    await panel.memory.archive([item.id])
    const unrelated = await panel.memory.write({ body: '无关来源' })
    await panel.memory.mergeBatch([unrelated], '无关摘要', 'compress')
    await rollback()
    expect((await panel.memory.list()).map((entry) => entry.body)).toEqual(['无关摘要'])
  })

  it('LLM 等待期间来源被编辑，放弃过期摘要且不归档来源', async () => {
    const { memory, panel } = await setup()
    const entry = await memory.write({ body: '旧事实' })
    const llm = model('过期摘要', () => panel.memory.update(entry.id, { body: '人工修订' }))
    expect(await compressOldestMemories(state, llm, 'audit', 'mock', 'mock')).toBeNull()
    expect((await panel.memory.list()).map((item) => item.body)).toEqual(['人工修订'])
  })

  it('LLM 等待期间来源被回滚，不复活摘要或事实', async () => {
    const { memory, panel, rollback } = await setup()
    await memory.write({ body: '即将撤销' })
    expect(await compressOldestMemories(state, model('过期摘要', rollback), 'audit', 'mock', 'mock')).toBeNull()
    expect(await panel.memory.list()).toEqual([])
  })

  it('人工改写的摘要成为独立修订，来源回滚不撤销该修订', async () => {
    const { memory, panel, rollback } = await setup()
    await memory.write({ body: '模型事实' })
    await panel.memory.mergeBatch(await panel.memory.list(), '摘要', 'compress')
    const summary = (await panel.memory.list())[0]!
    await panel.memory.update(summary.id, { body: '人工确认' }, { listMode: 'replace' })
    await rollback()
    expect((await panel.memory.list()).map((entry) => entry.body)).toEqual(['人工确认'])
  })
})


it('回滚在正文替换后崩溃：恢复游标防止重放较新版本', async () => {
  const { ws, panel, memory, rollback } = await setup()
  const entry = await panel.memory.write({ body: '原文' })
  await memory.update(entry.id, { body: '第一次' })
  await memory.update(entry.id, { body: '第二次' })
  await ws.wal.commitFloor('s#t1')
  fault.target = `${entry.id}.md`; fault.afterRename = true
  await expect(rollback()).rejects.toThrow('替换后崩溃')
  const { Wal } = await import('../src/state/wal.js')
  await new Wal(join(ws.fs.root, 'state/wal')).rollbackFloor('s#t1', ws.fs.root)
  expect((await panel.memory.get(entry.id))!.body).toBe('原文')
})

it('共享旧 WAL 不允许越过同一文件的后继写入撤销，避免之后复活已撤销事实', async () => {
  const { ws, panel, memory } = await setup()
  const entry = await panel.memory.write({ body: '原文' })
  await memory.update(entry.id, { body: 'A' })
  await ws.wal.commitFloor('s#t1')
  await ws.wal.beginFloor('other#t1')
  await new MemoryStore(ws.fs.withFloor('other#t1')).update(entry.id, { body: 'B' })
  await ws.wal.commitFloor('other#t1')
  await expect(ws.wal.rollbackFloor('s#t1', ws.fs.root)).rejects.toThrow('后继依赖')
  expect((await panel.memory.get(entry.id))!.body).toBe('B')
  await ws.wal.rollbackAfter(['s#t1', 'other#t1'], ws.fs.root)
  expect((await panel.memory.get(entry.id))!.body).toBe('原文')
})


it('摘要遗漏的关键词仍能命中归档来源，去重写入只针对活跃条目', async () => {
  const { ws, memory, rollback } = await setup()
  await memory.write({ body: '独有暗号：赤铜飞燕' })
  await memory.write({ body: '门打开了' })
  await ws.wal.commitFloor('s#t1')
  await compressOldestMemories(state, model('门打开了'), 'audit', 'test', 'test')
  const hits = await ws.memory.search('赤铜飞燕')
  expect(hits.some((hit) => hit.entry.archived && hit.entry.body.includes('赤铜飞燕'))).toBe(true)
  expect((await ws.memory.findSimilar('赤铜飞燕', [])).every((hit) => !hit.entry.archived)).toBe(true)
  await rollback()
  expect(await ws.memory.search('赤铜飞燕')).toEqual([])
})
