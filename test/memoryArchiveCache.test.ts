/** 真实文件系统验证可达归档的检索缓存：改写、删除和损坏必须即时可见，不扫描无关归档。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
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
