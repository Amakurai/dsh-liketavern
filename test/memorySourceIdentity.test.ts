/** 记忆来源身份回归：真实文件系统验证 Windows 大小写别名不复活归档旧事实，也不重复索引来源。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryStore, serializeMemory } from '../src/state/memory.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let fs: WorkspaceFs
let memory: MemoryStore
const meta = { created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z',
  sourceRange: '', tags: [], keys: [] }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'memory-source-identity-'))
  fs = new WorkspaceFs(root)
  memory = new MemoryStore(fs)
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

it.for(['Target', 'target'])('归档删除中断后，活跃来源覆盖归档旧副本；引用=%s', async (reference, context) => {
  if (reference === 'target' && process.platform !== 'win32') context.skip('仅 Windows 文件名别名')
  await fs.writeText('memory/Target.md', serializeMemory(meta, '旧事实：翡翠钥匙留在灯塔'))
  const source = (await memory.get(reference))!
  const originalDelete = WorkspaceFs.prototype.delete
  const fail = vi.spyOn(WorkspaceFs.prototype, 'delete').mockImplementation(async function (this: WorkspaceFs, path) {
    if (path === `memory/${reference}.md`) throw new Error('测试：归档来源删除中断')
    return originalDelete.call(this, path)
  })
  await expect(memory.mergeBatch([source], '港口摘要', 'compress')).rejects.toThrow('归档来源删除中断')
  fail.mockRestore()
  await memory.update('Target', { body: '人工确认：琥珀钥匙已经销毁' }, { listMode: 'replace' })
  const reopened = new MemoryStore(fs)
  expect(await reopened.search('翡翠')).toEqual([])
  expect((await reopened.search('琥珀')).map(hit => hit.entry.id)).toEqual(['Target'])
  const summary = (await reopened.search('港口摘要', { includeSummarySources: true }))[0]!
  expect(summary.summarySourceIds).toEqual(['Target'])
  expect(await reopened.findSimilar('翡翠', [])).toEqual([])
  expect(await fs.readText(`memory/archive/${reference}.md`)).toContain('翡翠钥匙')
})

it('摘要来源的文件别名只检索一次；大小写敏感系统仍保留不同来源', async () => {
  await fs.writeText('memory/archive/Source.md', serializeMemory(meta, '归档事实：蓝宝石钥匙'))
  if (process.platform !== 'win32') {
    await fs.writeText('memory/archive/source.md', serializeMemory(meta, '另一事实：红宝石钥匙'))
  }
  await fs.writeText('memory/summary.md', serializeMemory({ ...meta, sourceRange: 'compress:Source,source' }, '港口归档摘要'))
  const hits = await memory.search('蓝宝')
  expect(hits.map(hit => hit.entry.body)).toEqual(['归档事实：蓝宝石钥匙'])
  const summary = (await memory.search('港口归档摘要', { includeSummarySources: true }))[0]!
  expect(summary.summarySourceIds).toEqual(process.platform === 'win32' ? ['Source'] : ['Source', 'source'])
  if (process.platform !== 'win32') {
    expect((await memory.search('红宝')).map(hit => hit.entry.id)).toEqual(['source'])
  }
})

it('交叉多代来源保留活跃叶事实的权威正文，归档旧副本与不可达文件不会补回旧事实', async () => {
  await fs.writeText('memory/Target.md', serializeMemory(meta, '现行事实：琥珀钥匙已销毁'))
  await fs.writeText('memory/archive/Target.md', serializeMemory(meta, '撤销事实：翡翠钥匙留在灯塔'))
  await fs.writeText('memory/archive/Second.md', serializeMemory(meta, '补充事实：蓝宝石钥匙交给船长'))
  await fs.writeText('memory/archive/Unreachable.md', serializeMemory(meta, '不可达事实：翠玉钥匙仍可使用'))
  await fs.writeText('memory/archive/Middle.md', serializeMemory({ ...meta,
    sourceRange: `compress:${process.platform === 'win32' ? 'target' : 'Target'}` }, '中间压缩摘要'))
  await fs.writeText('memory/Root.md', serializeMemory({ ...meta,
    sourceRange: process.platform === 'win32' ? 'merge:Middle,middle,Target,Second' : 'merge:Middle,Target,Second' }, '新剧情摘要'))
  expect(await memory.search('翡翠')).toEqual([])
  expect(await memory.search('翠玉')).toEqual([])
  expect((await memory.search('琥珀')).map(hit => hit.entry.id)).toEqual(['Target'])
  expect((await memory.search('蓝宝')).map(hit => hit.entry.id)).toEqual(['Second'])
  const result = (await memory.search('新剧情摘要', { includeSummarySources: true }))[0]!
  expect(result.entry.id).toBe('Root')
  expect(result.summarySourceIds).toEqual(['Second', 'Target'])
})

it('跨代循环经过文件别名返回活跃摘要时仍明确拒绝循环', async () => {
  await fs.writeText('memory/Summary.md', serializeMemory({ ...meta, sourceRange: 'compress:Bridge' }, '循环剧情摘要'))
  await fs.writeText('memory/archive/Bridge.md', serializeMemory({ ...meta,
    sourceRange: `merge:${process.platform === 'win32' ? 'SUMMARY' : 'Summary'}` }, '中间循环摘要'))
  await expect(memory.search('循环剧情摘要', { includeSummarySources: true })).rejects.toThrow('记忆归并来源存在循环')
})

/** 真实活跃根文件配生成的只读归档链：不落盘一万份文件，仍经过实际索引、解析与完整叶展开。 */
it('一万个不同来源身份允许完整展开，重复别名不额外计数，下一身份仍拒绝超限', async () => {
  const id = (number: number) => `N${String(number).padStart(5, '0')}`
  const refs = (number: number) => process.platform === 'win32' ? `${id(number)},${id(number).toLowerCase()}` : id(number)
  let last = 9_999
  const originalRead = fs.readText.bind(fs)
  let archivedReads = 0
  vi.spyOn(fs, 'readText').mockImplementation(async path => {
    const match = /^memory\/archive\/N(\d+)\.md$/.exec(path)
    if (!match) return originalRead(path)
    archivedReads++
    const number = Number(match[1])
    return serializeMemory({ ...meta, sourceRange: number < last ? `compress:${refs(number + 1)}` : '' }, '生成归档事实')
  })
  await fs.writeText('memory/Root.md', serializeMemory({ ...meta, sourceRange: `compress:${refs(1)}` }, '预算边界摘要'))
  const result = (await memory.search('预算边界摘要', { includeSummarySources: true }))[0]!
  expect(result.summarySourceIds).toEqual([id(last)])
  expect(archivedReads).toBe(9_999)
  last = 10_000
  archivedReads = 0
  await expect(new MemoryStore(fs).search('预算边界摘要', { includeSummarySources: true })).rejects.toThrow('记忆来源索引超过 10000 条')
  expect(archivedReads).toBe(9_999)
})
