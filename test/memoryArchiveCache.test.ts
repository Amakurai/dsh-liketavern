/**
 * 真实文件系统验证可达归档的检索缓存：改写、删除和损坏必须即时可见，不扫描无关归档；
 * 活跃集变化后未变的归档不重读，显式 invalidate 与本实例的重新归档仍强制重读，并行加载有界且报错顺序确定。
 */
import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore, serializeMemory } from '../src/state/memory.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string, fs: WorkspaceFs, memory: MemoryStore
const meta = { created: '2026-01-01', updated: '2026-01-01', sourceRange: '', tags: [], keys: [] }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'memory-archive-cache-'))
  fs = new WorkspaceFs(root, null)
  memory = new MemoryStore(fs)
  await fs.writeText('memory/source.md', serializeMemory(meta, '翡翠钥匙在灯塔'))
  await memory.mergeBatch(await memory.list(), '港口摘要', 'compress')
  expect((await memory.search('翡翠'))[0]?.entry.id).toBe('source')
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

it('活跃摘要不变时，归档原文修改仍刷新检索结果', async () => {
  await fs.writeText('memory/archive/source.md', serializeMemory(meta, '琥珀钥匙已销毁，船长确认'))
  expect(await memory.search('翡翠')).toEqual([])
  expect((await memory.search('琥珀钥匙')).map(hit => hit.entry.body)).toEqual(['琥珀钥匙已销毁，船长确认'])
})

it.each(['delete', 'corrupt'] as const)('归档来源 %s 后不能继续返回缓存的旧事实', async mode => {
  if (mode === 'delete') await fs.delete('memory/archive/source.md')
  else await fs.writeText('memory/archive/source.md', '损坏的来源正文，没有 frontmatter')
  await expect(memory.search('翡翠钥匙')).rejects.toThrow(mode === 'delete' ? '来源 source 缺失' : 'frontmatter')
})

it('归档未变时仍复用正文缓存，不递归读取无关归档', async () => {
  await fs.writeText('memory/archive/unreachable.md', serializeMemory(meta, '不可达旧事实'))
  const read = vi.spyOn(fs, 'readText')
  const list = vi.spyOn(fs, 'list')
  expect((await memory.search('翡翠钥匙'))[0]?.entry.id).toBe('source')
  expect(read).not.toHaveBeenCalled()
  expect(list.mock.calls.every(([path, options]) => path === 'memory' && options?.recursive === false)).toBe(true)
})

it('归档中间摘要改换来源后重新遍历可达图，不遗漏新叶事实', async () => {
  await fs.writeText('memory/archive/replacement.md', serializeMemory(meta, '蓝宝石信物交给了船长'))
  await fs.writeText('memory/archive/source.md', serializeMemory({ ...meta, sourceRange: 'merge:replacement' }, '新的中间摘要'))
  expect((await memory.search('蓝宝石')).map(hit => hit.entry.id)).toEqual(['replacement'])
  expect(await memory.search('翡翠')).toEqual([])
})

it('缓存命中前核对来源时，真实 I/O 故障不能被旧结果掩盖', async () => {
  const stat = fs.stat.bind(fs)
  vi.spyOn(fs, 'stat').mockImplementation(async path => {
    if (path === 'memory/archive/source.md') throw Object.assign(new Error('测试来源读取故障'), { code: 'EIO' })
    return stat(path)
  })
  await expect(memory.search('翡翠')).rejects.toThrow('测试来源读取故障')
})

/** 只统计归档正文的读取；活跃记忆在活跃集变化后本来就要重读。 */
function archiveReads(): () => string[] {
  const read = vi.spyOn(fs, 'readText')
  return () => read.mock.calls.map(([path]) => path).filter(path => path.startsWith('memory/archive/'))
}

it('本实例写入活跃记忆后重建索引，未变的归档来源不重读', async () => {
  const reads = archiveReads()
  await memory.write({ body: '船长今晚在灯塔值守' })
  expect((await memory.search('值守')).map(hit => hit.entry.body)).toEqual(['船长今晚在灯塔值守'])
  expect((await memory.search('翡翠'))[0]?.entry.id).toBe('source')
  expect(reads()).toEqual([])
})

it('其它实例改变活跃集后，本实例同样只重读活跃记忆', async () => {
  const written = await new MemoryStore(fs).write({ body: '船长今晚在灯塔值守' })
  const reads = archiveReads()
  expect((await memory.search('值守')).map(hit => hit.entry.id)).toEqual([written.id])
  await new MemoryStore(fs).delete(written.id)
  expect(await memory.search('值守')).toEqual([])
  expect((await memory.search('翡翠'))[0]?.entry.id).toBe('source')
  expect(reads()).toEqual([])
})

it('活跃集变化的同时归档被改写，只重读指纹变化的那一份', async () => {
  await fs.writeText('memory/archive/second.md', serializeMemory(meta, '蓝宝石信物交给了船长'))
  await fs.writeText('memory/extra.md', serializeMemory({ ...meta, sourceRange: 'merge:second' }, '信物摘要'))
  expect((await memory.search('蓝宝石')).map(hit => hit.entry.id)).toEqual(['second'])
  const reads = archiveReads()
  await fs.writeText('memory/archive/second.md', serializeMemory(meta, '红宝石信物已经沉入海底，无人知晓'))
  await memory.write({ body: '船长今晚在灯塔值守' })
  expect(await memory.search('蓝宝')).toEqual([])
  expect((await memory.search('红宝')).map(hit => hit.entry.id)).toEqual(['second'])
  expect((await memory.search('翡翠'))[0]?.entry.id).toBe('source')
  expect(reads()).toEqual(['memory/archive/second.md'])
})

describe('磁盘指纹无法区分的归档改写', () => {
  const pinned = new Date('2026-01-02T00:00:00.000Z')
  const archived = (): string => join(root, 'memory', 'archive', 'source.md')
  /** 把归档的修改时间钉在整秒上并按该指纹重新缓存；之后同长度改写再钉回去，指纹完全相同。 */
  beforeEach(async () => {
    await utimes(archived(), pinned, pinned)
    expect((await memory.search('翡翠'))[0]?.entry.id).toBe('source')
  })

  it('绕过本类的同指纹改写（模拟 WAL 回滚）经显式 invalidate 后重新读盘', async () => {
    await fs.writeText('memory/archive/source.md', serializeMemory(meta, '琥珀钥匙在灯塔'))
    await utimes(archived(), pinned, pinned)
    // 前提核对：指纹确实没变，改动前后都要靠 invalidate，而不是碰巧被指纹发现
    expect((await memory.search('翡翠'))[0]?.entry.id).toBe('source')
    memory.invalidate()
    expect(await memory.search('翡翠')).toEqual([])
    expect((await memory.search('琥珀')).map(hit => hit.entry.body)).toEqual(['琥珀钥匙在灯塔'])
  })

  it('本实例重新归档同一条目后不沿用上一份归档正文', async () => {
    await fs.writeText('memory/source.md', serializeMemory(meta, '琥珀钥匙在灯塔'))
    expect(await memory.archive(['source'])).toBe(1)
    await utimes(archived(), pinned, pinned)
    expect(await memory.search('翡翠')).toEqual([])
    expect((await memory.search('琥珀')).map(hit => hit.entry.id)).toEqual(['source'])
  })
})

describe('同一层来源并行加载', () => {
  const ids = Array.from({ length: 40 }, (_, i) => `leaf-${String(i).padStart(2, '0')}`)
  beforeEach(async () => {
    for (const id of ids) await fs.writeText(`memory/archive/${id}.md`, serializeMemory(meta, `${id} 号仓库存放着硝石`))
  })
  const summarize = (sources: string[]): Promise<void> =>
    fs.writeText('memory/wide.md', serializeMemory({ ...meta, sourceRange: `merge:${sources.join(',')}` }, '仓库清点摘要'))

  it('全部来源都进入索引，同时打开的归档文件不超过上限', async () => {
    await summarize(ids)
    const read = fs.readText.bind(fs)
    let open = 0
    let peak = 0
    vi.spyOn(fs, 'readText').mockImplementation(async path => {
      if (!path.startsWith('memory/archive/')) return read(path)
      peak = Math.max(peak, ++open)
      try { return await read(path) } finally { open-- }
    })
    const hits = await memory.search('硝石', { topK: 100 })
    expect(hits.map(hit => hit.entry.id).sort()).toEqual(ids)
    expect(peak).toBeLessThanOrEqual(8)
  })

  it.each([
    { order: ['leaf-00', 'gone', 'broken', 'leaf-01'], message: '来源 gone 缺失' },
    { order: ['leaf-00', 'broken', 'gone', 'leaf-01'], message: 'frontmatter' },
  ])('多个来源同时故障时报告顺序最靠前的那个：$message', async ({ order, message }) => {
    await fs.writeText('memory/archive/broken.md', '损坏的来源正文，没有 frontmatter')
    await summarize(order)
    for (let attempt = 0; attempt < 3; attempt++) {
      await expect(memory.search('硝石')).rejects.toThrow(message)
    }
  })

  it('来源格式损坏排在更早来源的读取故障之后报告', async () => {
    await fs.writeText('memory/first.md', serializeMemory({ ...meta, created: '2025-01-01', sourceRange: 'merge:gone' }, '较早摘要'))
    await fs.writeText('memory/second.md', serializeMemory({ ...meta, created: '2025-06-01', sourceRange: 'merge-json:[' }, '较晚摘要'))
    await expect(memory.search('摘要')).rejects.toThrow('来源 gone 缺失')
  })
})
