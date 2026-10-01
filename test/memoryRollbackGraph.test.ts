/** 用真实文件与楼层 WAL 验证交叉摘要来源回滚，以及损坏来源拒绝前不改写记忆。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryStore, serializeMemory } from '../src/state/memory.js'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let fs: WorkspaceFs
let wal: Wal
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'memory-rollback-graph-'))
  wal = new Wal(join(root, 'state/wal'))
  fs = new WorkspaceFs(root, wal)
  await wal.beginFloor('s#t1')
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

async function put(id: string, sourceRange = '', scoped = fs) {
  await scoped.writeText(`memory/${id}.md`, serializeMemory({ created: '2026-01-01',
    updated: '2026-01-01', sourceRange, tags: [], keys: [] }, id))
}

async function snapshot() {
  return Promise.all((await fs.list('memory')).map(async path => [path, await fs.readText(`memory/${path}`)]))
}

async function sharedSummaries() {
  await put('target', '', fs.withFloor('s#t1'))
  await put('kept')
  await put('middle', 'merge:target,kept')
  await put('a', 'merge:middle')
  await put('b', 'merge:middle')
  const memory = new MemoryStore(fs)
  await memory.archive(['target', 'kept', 'middle'])
  await wal.commitFloor('s#t1')
  return memory
}

it('两个活跃摘要共享中间摘要时完整展开，撤销目标事实并保留其它来源', async () => {
  const memory = await sharedSummaries()
  await wal.rollbackFloor('s#t1', root)
  expect((await memory.list()).map(entry => entry.id)).toEqual(['kept'])
  expect(await memory.search('target')).toEqual([])
})

it.skipIf(process.platform !== 'win32')('Windows 记忆 id 的大小写别名更新归入同一来源，回滚先展开摘要', async () => {
  await put('target')
  const scoped = new MemoryStore(fs.withFloor('s#t1'))
  expect((await scoped.update('TARGET', { body: '本层新增翡翠钥匙事实' }))?.body).toBe('本层新增翡翠钥匙事实')
  await wal.commitFloor('s#t1')
  const memory = new MemoryStore(fs)
  // 工具/面板可以按原 id 读取；Windows 上它与替换后的大写文件名是同一条记忆。
  await memory.mergeBatch([(await memory.get('target'))!], '钥匙已经找到', 'merge')

  await wal.rollbackFloor('s#t1', root)
  expect((await memory.list()).map(entry => [entry.id.toLowerCase(), entry.body])).toEqual([['target', 'target']])
  expect(await memory.search('翡翠钥匙')).toEqual([])
})

it.each(['memory/archive/kept.md', 'memory/a.md', 'memory/middle.md'])('删除 %s 中断后重启仍能恢复共享来源图', async path => {
  await sharedSummaries()
  const original = WorkspaceFs.prototype.delete
  const failing = vi.spyOn(WorkspaceFs.prototype, 'delete').mockImplementation(async function (this: WorkspaceFs, candidate) {
    if (candidate === path) {
      failing.mockRestore()
      throw new Error('测试：删除中断')
    }
    await original.call(this, candidate)
  })
  await expect(wal.rollbackFloor('s#t1', root)).rejects.toThrow('删除中断')
  await expect(wal.validateFloor('s#t1')).rejects.toThrow('回滚恢复')
  await expect(fs.withFloor('s#t1').writeText('journal.md', '恢复中迟到的写入')).rejects.toThrow('回滚恢复')
  expect(await fs.readText('journal.md')).toBeNull()
  await new Wal(join(root, 'state/wal')).rollbackFloor('s#t1', root)
  expect((await new MemoryStore(fs).list()).map(entry => entry.id)).toEqual(['kept'])
})

it.each(['cycle', 'missing'] as const)('来源图 %s 在回滚修改任何记忆之前被拒绝', async mode => {
  await put('target', '', fs.withFloor('s#t1'))
  await put('a', 'merge:target,b')
  if (mode === 'cycle') await put('b', 'merge:a')
  await new MemoryStore(fs).archive(['target', ...(mode === 'cycle' ? ['b'] : [])])
  await wal.commitFloor('s#t1')
  const before = await snapshot()

  await expect(wal.rollbackFloor('s#t1', root)).rejects.toThrow(mode === 'cycle' ? '循环' : '缺失')
  expect(await snapshot()).toEqual(before)
  expect((await wal.listFloors())[0]?.rolledBack).toBe(false)
})
