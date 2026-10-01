/** 归档故障后的人工修订回归：真实剧情文件与 WAL 验证活跃摘要清空来源时不被归档旧谱系删除。 */
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
let memory: MemoryStore
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'memory-human-recovery-'))
  wal = new Wal(join(root, 'state/wal'))
  fs = new WorkspaceFs(root, wal)
  memory = new MemoryStore(fs)
  await fs.writeText('memory/target.md', serializeMemory({ created: '2026-01-01T00:00:00.000Z',
    updated: '2026-01-01T00:00:00.000Z', sourceRange: '', tags: [], keys: [] }, '原始事实'))
  await wal.beginFloor('s#t1')
  await new MemoryStore(fs.withFloor('s#t1')).update('target', { body: '本层新增翡翠钥匙事实' })
  await wal.commitFloor('s#t1')
  await memory.mergeBatch([(await memory.get('target'))!], '来源摘要', 'compress')
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

it.each([false, true])('摘要归档删除中断后回滚尊重活跃副本的当前来源；人工修订=%s', async humanEdit => {
  const summary = (await memory.list())[0]!
  const path = `memory/${summary.id}.md`
  const archivePath = `memory/archive/${summary.id}.md`
  const originalDelete = WorkspaceFs.prototype.delete
  const failing = vi.spyOn(WorkspaceFs.prototype, 'delete').mockImplementation(async function (this: WorkspaceFs, candidate) {
    if (candidate === path) {
      failing.mockRestore()
      throw new Error('测试：归档已写入但活跃副本删除失败')
    }
    return originalDelete.call(this, candidate)
  })
  await expect(memory.archive([summary.id])).rejects.toThrow('活跃副本删除失败')
  expect(await fs.readText(archivePath)).toBe(await fs.readText(path))
  if (humanEdit) {
    await memory.update(summary.id, { body: '人工确认船长已离开港口' }, { listMode: 'replace' })
    expect((await memory.get(summary.id))?.sourceRange).toBe('')
  }

  await wal.rollbackFloor('s#t1', root)
  const reopened = new MemoryStore(fs)
  if (humanEdit) {
    expect((await reopened.list()).map(entry => [entry.id, entry.body, entry.sourceRange]))
      .toEqual([[summary.id, '人工确认船长已离开港口', '']])
    expect((await reopened.search('船长')).map(hit => hit.entry.id)).toEqual([summary.id])
    expect(await reopened.search('翡翠钥匙')).toEqual([])
    expect(await fs.readText(path)).toContain('人工确认船长已离开港口')
    expect(JSON.parse((await fs.readText('index.json'))!).files.map((file: { path: string }) => file.path))
      .toEqual([path])
  } else {
    expect((await reopened.list()).map(entry => [entry.id, entry.body])).toEqual([['target', '原始事实']])
    expect(await fs.readText(path)).toBeNull()
    expect(await fs.readText(archivePath)).toBeNull()
  }
  expect((await wal.listFloors())[0]?.rolledBack).toBe(true)
  const after = await reopened.list()
  await expect(wal.rollbackFloor('s#t1', root)).rejects.toThrow('已回滚')
  expect(await new MemoryStore(fs).list()).toEqual(after)
})
