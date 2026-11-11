/**
 * S6 回归：遗留 WAL 协议（record/recordAfter）移除守卫与历史磁盘日志回滚兼容。
 *
 * 修复前：同层已有新协议记录（每写一次一条、带 after）时，遗留 recordAfter 会把该路径所有记录的
 * after 改写成最终值；回滚把较早记录误判为“人工修改”而保留，楼层却标记已回滚——静默漏撤。
 * 现行边界：Wal 已彻底移除遗留 record()/recordAfter() 写入入口，运行期写入一律经 withFloor + recordChanges；
 * 同时纯遗留磁盘日志（同路径一条记录 + 一次 after 补写）仍可正常回滚。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Wal } from '../../src/state/wal.js'
import { WorkspaceFs } from '../../src/state/workspaceFs.js'
import { appendLegacyRecord, patchLegacyAfter } from '../legacyWalFactory.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'audit-wal-legacy-mix-'))
  roots.push(root)
  const walDir = join(root, 'state', 'wal')
  const wal = new Wal(walDir)
  const fs = new WorkspaceFs(root, wal)
  return { root, walDir, wal, fs, records: () => readFile(join(walDir, 's_t1', 'records.jsonl'), 'utf8') }
}

describe('遗留 WAL 协议守卫', () => {
  it('遗留 record/recordAfter 写入入口已移除，同路径连续新协议写入完整回滚到最初状态', async () => {
    const { wal, fs, records } = await setup()
    expect('record' in wal).toBe(false)
    expect('recordAfter' in wal).toBe(false)

    await wal.beginFloor('s#t1')
    await fs.withFloor('s#t1').writeText('x.txt', 'A1')
    await fs.withFloor('s#t1').writeText('x.txt', 'B1')
    const before = await records()
    expect(before.trim().split('\n')).toHaveLength(2)

    await wal.commitFloor('s#t1')
    await wal.rollbackFloor('s#t1', fs.root)
    // 两条新协议记录都正常回放：第一次写入被完整撤销。
    expect(await fs.withFloor(null).readText('x.txt')).toBeNull()
  })

  it('纯遗留协议磁盘日志（record + 一次 recordAfter）仍可回滚到最初内容', async () => {
    const { walDir, wal, fs } = await setup()
    await fs.withFloor(null).writeText('legacy.txt', '最初')
    await wal.beginFloor('s#t1')
    await appendLegacyRecord(walDir, 's#t1', 'legacy.txt', '最初')
    await fs.withFloor(null).writeText('legacy.txt', '本层正文')
    await patchLegacyAfter(walDir, 's#t1', 'legacy.txt', '本层正文')
    await wal.commitFloor('s#t1')

    const lines = (await readFile(join(walDir, 's_t1', 'records.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    await wal.rollbackFloor('s#t1', fs.root)
    expect(await fs.withFloor(null).readText('legacy.txt')).toBe('最初')
  })
})
