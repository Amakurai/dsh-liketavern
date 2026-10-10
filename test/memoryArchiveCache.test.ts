/**
 * 真实文件系统验证可达归档的检索缓存：改写、删除和损坏必须即时可见，不扫描无关归档；
 * 活跃集变化后未变的归档不重读，显式 invalidate 与本实例的重新归档仍强制重读，并行加载有界且报错顺序确定。
 * 缓存命中只做一次批量指纹核对；经文件层的写入（含 WAL 回滚）都有登记，不靠 mtime 精度也立即可见，
 * 活跃集变化时只重读变了的那几个文件。只有完全绕过文件层的外部改写才需要显式作废。
 */
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MemoryStore, serializeMemory } from '../src/state/memory.js'
import { Wal } from '../src/state/wal.js'
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
  const statMany = fs.statMany.bind(fs)
  vi.spyOn(fs, 'statMany').mockImplementation(async paths => {
    if (paths.includes('memory/archive/source.md')) throw Object.assign(new Error('测试来源读取故障'), { code: 'EIO' })
    return statMany(paths)
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
  // 用与新正文没有任何共同字的词确认旧正文已不可检索（「蓝宝」会靠单字「宝」命中新正文）
  expect(await memory.search('交给')).toEqual([])
  expect((await memory.search('沉入海底')).map(hit => hit.entry.id)).toEqual(['second'])
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

  it('经文件层的同指纹改写不需要显式作废', async () => {
    await fs.writeText('memory/archive/source.md', serializeMemory(meta, '琥珀钥匙在灯塔'))
    await utimes(archived(), pinned, pinned)
    expect(await memory.search('翡翠')).toEqual([])
    expect((await memory.search('琥珀')).map(hit => hit.entry.body)).toEqual(['琥珀钥匙在灯塔'])
  })

  it('完全绕过文件层的同指纹改写（别的进程或外部编辑器）经显式 invalidate 后重新读盘', async () => {
    await writeFile(archived(), serializeMemory(meta, '琥珀钥匙在灯塔'))
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

describe('缓存命中的开销', () => {
  it('只做一次批量指纹核对：不逐个 stat，也不读任何正文', async () => {
    for (let i = 0; i < 30; i++) await fs.writeText(`memory/archive/bulk-${i}.md`, serializeMemory(meta, `第 ${i} 号仓库存放着硝石`))
    await fs.writeText('memory/bulk.md', serializeMemory({ ...meta,
      sourceRange: `merge:${Array.from({ length: 30 }, (_, i) => `bulk-${i}`).join(',')}` }, '仓库清点摘要'))
    expect(await memory.search('硝石', { topK: 100 })).toHaveLength(30)
    const stat = vi.spyOn(fs, 'stat')
    const statMany = vi.spyOn(fs, 'statMany')
    const read = vi.spyOn(fs, 'readText')
    expect(await memory.search('硝石', { topK: 100 })).toHaveLength(30)
    expect(stat).not.toHaveBeenCalled()
    expect(read).not.toHaveBeenCalled()
    expect(statMany).toHaveBeenCalledTimes(1)
    // 可达的归档来源，加上别名文件：同一批取回
    expect(statMany.mock.calls[0]![0]).toHaveLength(32)
    expect(statMany.mock.calls[0]![0].at(-1)).toBe('memory/aliases.json')
  })
})

describe('同一剧情的多个实例', () => {
  const pinned = new Date('2026-01-03T00:00:00.000Z')
  const active = (id: string): string => join(root, 'memory', `${id}.md`)

  it('另一个实例的同长度改写即使磁盘指纹相同也立即可见', async () => {
    const entry = await memory.write({ body: '北门已开' })
    await utimes(active(entry.id), pinned, pinned)
    expect((await memory.search('已开')).map(hit => hit.entry.id)).toEqual([entry.id])
    // 工具写入用的是另一个带楼层的实例；这里把修改时间钉回去，模拟同一时间刻度内的第二次写入
    const writer = new MemoryStore(fs)
    const updated = await writer.update(entry.id, { body: '北门未开' })
    await utimes(active(entry.id), pinned, pinned)
    expect(Buffer.byteLength(serializeMemory(updated!, updated!.body))).toBe(Buffer.byteLength(serializeMemory(entry, entry.body)))
    // 「已开」「未开」共有一个「开」字，按正文核对而不是按有无命中
    expect((await memory.search('北门')).map(hit => hit.entry.body)).toEqual(['北门未开'])
    expect((await memory.findSimilar('北门未开', []))[0]).toMatchObject({ entry: { id: entry.id }, score: 1 })
    expect((await memory.list()).find(item => item.id === entry.id)?.body).toBe('北门未开')
  })

  it('另一个实例删除后再写回同样指纹的文件，旧正文不残留', async () => {
    const entry = await memory.write({ body: '北门已开' })
    await utimes(active(entry.id), pinned, pinned)
    expect((await memory.list()).some(item => item.id === entry.id)).toBe(true)
    const writer = new MemoryStore(fs)
    await writer.delete(entry.id)
    await fs.writeText(`memory/${entry.id}.md`, serializeMemory(entry, '北门封死'))
    await utimes(active(entry.id), pinned, pinned)
    expect((await memory.list()).find(item => item.id === entry.id)?.body).toBe('北门封死')
  })

  it('活跃集多出一条时只读新文件，其余复用已解析的结果', async () => {
    for (let i = 0; i < 12; i++) await memory.write({ body: `第 ${i} 号岗哨今晚无事` })
    await memory.list()
    const read = vi.spyOn(fs, 'readText')
    const written = await new MemoryStore(fs).write({ body: '船长今晚在灯塔值守' })
    expect((await memory.search('值守')).map(hit => hit.entry.id)).toEqual([written.id])
    expect(read.mock.calls.map(([path]) => path)).toEqual([`memory/${written.id}.md`])
    expect(await memory.list()).toHaveLength(14)
  })

  it('绕过本类的不同长度改写只重读那一个文件', async () => {
    const first = await memory.write({ body: '艾琳受伤' })
    await memory.write({ body: '桥头塌了' })
    await memory.list()
    const read = vi.spyOn(fs, 'readText')
    read.mockClear()
    await fs.writeText(`memory/${first.id}.md`, serializeMemory(first, '艾琳其实已经痊愈了'))
    read.mockClear()
    expect((await memory.list()).find(item => item.id === first.id)?.body).toBe('艾琳其实已经痊愈了')
    expect(read.mock.calls.map(([path]) => path)).toEqual([`memory/${first.id}.md`])
  })

  it('任一实例显式作废后，其它实例也丢掉同指纹的旧正文', async () => {
    const entry = await memory.write({ body: '北门已开' })
    await utimes(active(entry.id), pinned, pinned)
    expect((await memory.list()).find(item => item.id === entry.id)?.body).toBe('北门已开')
    // 完全绕过文件层的同指纹写回（别的进程）：指纹和写入登记都看不出来
    await writeFile(active(entry.id), serializeMemory(entry, '北门未开'))
    await utimes(active(entry.id), pinned, pinned)
    expect((await memory.list()).find(item => item.id === entry.id)?.body).toBe('北门已开')
    new MemoryStore(fs).invalidate()
    expect((await memory.list()).find(item => item.id === entry.id)?.body).toBe('北门未开')
    expect((await memory.search('未开')).map(hit => hit.entry.id)).toEqual([entry.id])
  })

  it('不同剧情根目录的实例互不影响', async () => {
    const otherRoot = await mkdtemp(join(tmpdir(), 'memory-archive-cache-other-'))
    try {
      const other = new MemoryStore(new WorkspaceFs(otherRoot, null))
      await other.write({ body: '另一条剧情的事实' })
      await memory.list()
      const read = vi.spyOn(fs, 'readText')
      await other.write({ body: '另一条剧情的第二个事实' })
      other.invalidate()
      await memory.list()
      expect(read).not.toHaveBeenCalled()
      expect((await memory.search('另一条剧情'))).toEqual([])
    } finally {
      await rm(otherRoot, { recursive: true, force: true })
    }
  })
})

describe('楼层回滚', () => {
  const pinned = new Date('2026-01-04T00:00:00.000Z')

  it('WAL 回滚写回的正文立即可见，即使磁盘指纹与回滚前完全相同', async () => {
    const wal = new Wal(join(root, 'state', 'wal'))
    const base = new WorkspaceFs(root, wal)
    const reader = new MemoryStore(base)
    const gate = await reader.write({ body: '北门已开' })
    const gatePath = join(root, 'memory', `${gate.id}.md`)
    await utimes(gatePath, pinned, pinned)
    expect((await reader.search('已开')).map(hit => hit.entry.id)).toEqual([gate.id])

    // 本楼层：等长更新一条、新写一条
    await wal.beginFloor('s#t1')
    const writer = new MemoryStore(base.withFloor('s#t1'))
    await writer.update(gate.id, { body: '北门未开' })
    const extra = await writer.write({ body: '船长今晚在灯塔值守' })
    await wal.commitFloor('s#t1')
    await utimes(gatePath, pinned, pinned)
    expect((await reader.search('北门')).map(hit => hit.entry.body)).toEqual(['北门未开'])
    expect((await reader.search('值守')).map(hit => hit.entry.id)).toEqual([extra.id])

    // 回滚把旧正文写回；把修改时间钉成与回滚前一致，指纹看不出任何变化
    await wal.rollbackAfter(['s#t1'], root)
    await utimes(gatePath, pinned, pinned)
    expect(await reader.search('值守')).toEqual([])
    expect((await reader.search('北门')).map(hit => hit.entry.body)).toEqual(['北门已开'])
    expect((await reader.findSimilar('北门已开', []))[0]).toMatchObject({ entry: { id: gate.id }, score: 1 })
    // 活跃记忆回到回滚前：开头归并出的摘要，加上恢复原文的这一条
    expect((await reader.list()).map(entry => entry.body).sort()).toEqual(['北门已开', '港口摘要'])
  })
})
