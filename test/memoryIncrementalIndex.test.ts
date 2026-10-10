/**
 * 记忆索引增量更新的等价性回归：真实文件系统上经过一长串写入、更新、删除、归并归档和绕过存储类的改写之后，
 * 长期存活实例（索引跨操作保留、只增删变化的条目）的检索与相似度结果，必须与每次全新构建的实例逐项相同。
 * 另验证来源加载失败时上一份索引不被破坏，以及写入后不再对未变的条目重新分词。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { Bm25Index } from '../src/core/bm25.js'
import { MemoryStore, serializeMemory } from '../src/state/memory.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let fs: WorkspaceFs
let memory: MemoryStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'memory-incremental-'))
  fs = new WorkspaceFs(root, null)
  memory = new MemoryStore(fs)
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

const people = ['艾琳', '罗兰', '凛', '樱', '塞巴斯', '维多利亚']
const places = ['北门', '钟楼', '黑礁酒馆', '灯塔', '码头仓库', '旧图书馆']
const events = ['答应保守秘密', '弄丢了银怀表', '收下一封密信', '修好了断剑', '认出了通缉犯', '发现暗门', '买下一匹灰马']
const queries = ['凛', '樱的药', '北门 钥匙', '艾琳在钟楼修好了断剑', '码头仓库的密信', '维多利亚', '不存在的词', '摘要']

async function compare(): Promise<void> {
  const fresh = new MemoryStore(fs)
  const now = Date.parse('2027-01-01T00:00:00.000Z')
  for (const query of queries) {
    for (const options of [{ topK: 50, now }, { topK: 5, now, halfLifeMs: 86_400_000 }, { topK: 50, now, includeSummarySources: true },
      { topK: 50, now, boost: { query: '凛 北门', weight: 3 } }]) {
      expect(await memory.search(query, options), `search ${query}`).toEqual(await fresh.search(query, options))
    }
    expect(await memory.findSimilar(query, ['北门'], 20), `similar ${query}`).toEqual(await fresh.findSimilar(query, ['北门'], 20))
  }
  expect(await memory.list()).toEqual(await fresh.list())
}

it('一长串增删改与归并之后，结果与全新实例逐项相同', async () => {
  let seed = 0x2f6e
  const next = (n: number): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % n
  }
  const fact = (): string => `${people[next(people.length)]}在${places[next(places.length)]}${events[next(events.length)]}`
  for (let i = 0; i < 6; i++) await memory.write({ body: fact(), keys: [people[next(people.length)]!] })
  await compare()
  for (let step = 0; step < 48; step++) {
    const entries = await memory.list()
    const pick = entries[next(Math.max(1, entries.length))]
    const action = next(9)
    if (action <= 2 || !pick) {
      await memory.write({ body: fact(), keys: next(2) ? [people[next(people.length)]!] : [] })
    } else if (action <= 4) {
      await memory.update(pick.id, { body: fact(), keys: [places[next(places.length)]!] })
    } else if (action === 5) {
      await memory.delete(pick.id)
    } else if (action === 6 && entries.length >= 3) {
      // 归并：最旧三条写成摘要并归档，来源此后经可达归档进入检索
      await memory.mergeBatch(entries.slice(0, 3), `摘要：${fact()}`, 'compress')
    } else if (action === 7) {
      // 由另一个实例写入（工具写入的路径）
      await new MemoryStore(fs).write({ body: fact() })
    } else {
      // 绕过存储类改写正文，长度不同，靠磁盘指纹发现
      await fs.writeText(`memory/${pick.id}.md`, serializeMemory(pick, `${fact()}，此事已经传开`))
    }
    await compare()
  }
  expect((await memory.list()).length).toBeGreaterThan(3)
})

it('来源加载失败不破坏上一份索引：修复后结果仍与全新实例相同', async () => {
  await memory.write({ body: '翡翠钥匙藏在钟楼' })
  await memory.write({ body: '樱在旧图书馆抄书' })
  await memory.mergeBatch(await memory.list(), '旧事摘要', 'compress')
  await memory.write({ body: '凛在北门等人' })
  await compare()
  const archived = (await memory.search('翡翠钥匙', { topK: 5 }))[0]!.entry
  await fs.delete(`memory/archive/${archived.id}.md`)
  await expect(memory.search('翡翠钥匙')).rejects.toThrow('缺失')
  // 活跃记忆的去重索引不依赖归档来源，期间仍可用
  expect((await memory.findSimilar('凛在北门等人', []))[0]?.score).toBe(1)
  await fs.writeText(`memory/archive/${archived.id}.md`, serializeMemory(archived, '翡翠钥匙其实在灯塔'))
  await compare()
  expect((await memory.search('灯塔'))[0]?.entry.body).toBe('翡翠钥匙其实在灯塔')
})

it('写入一条记忆后只对这一条分词入索引，未变的条目不重建', async () => {
  for (let i = 0; i < 20; i++) await memory.write({ body: `第 ${i} 号岗哨今晚无事，换岗照旧` })
  await memory.mergeBatch((await memory.list()).slice(0, 10), '岗哨摘要', 'compress')
  await memory.search('岗哨')
  await memory.findSimilar('岗哨', [])
  const add = vi.spyOn(Bm25Index.prototype, 'add')
  const written = await new MemoryStore(fs).write({ body: '船长今晚在灯塔值守' })
  expect((await memory.search('值守')).map((hit) => hit.entry.id)).toEqual([written.id])
  expect((await memory.findSimilar('船长今晚在灯塔值守', []))[0]?.entry.id).toBe(written.id)
  // 检索索引与去重索引各加一次
  expect(add.mock.calls.map(([doc]) => doc.id)).toEqual([written.id, written.id])
})
