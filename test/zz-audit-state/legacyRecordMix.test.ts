/**
 * S6 回归：遗留 WAL 协议（record/recordAfter）与新协议（recordChanges）的混用守卫。
 *
 * 修复前：同层已有新协议记录（每写一次一条、带 after）时，遗留 recordAfter 会把该路径所有记录的
 * after 改写成最终值；回滚把较早记录误判为“人工修改”而保留，楼层却标记已回滚——静默漏撤。
 * 修复后：同路径已存在带 after 的新协议记录时，record()/recordAfter() 直接拒绝且日志不变；
 * 纯遗留协议（同路径一条记录 + 一次 recordAfter）继续可用。
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Wal } from '../../src/state/wal.js'
import { WorkspaceFs } from '../../src/state/workspaceFs.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'audit-wal-legacy-mix-'))
  roots.push(root)
  const wal = new Wal(join(root, 'state', 'wal'))
  const fs = new WorkspaceFs(root, wal)
  return { root, wal, fs, records: () => readFile(join(root, 'state', 'wal', 's_t1', 'records.jsonl'), 'utf8') }
}

describe('遗留 WAL 协议守卫', () => {
  it('新协议记录存在时 recordAfter/record 直接拒绝，日志与正文都不变', async () => {
    const { wal, fs, records } = await setup()
    await wal.beginFloor('s#t1')
    await fs.withFloor('s#t1').writeText('x.txt', 'A1')
    await fs.withFloor('s#t1').writeText('x.txt', 'B1')
    const before = await records()
    expect(before.trim().split('\n')).toHaveLength(2)

    await expect(wal.recordAfter('s#t1', 'x.txt', 'B1')).rejects.toThrow(/新协议写后镜像/)
    await expect(wal.record('s#t1', 'x.txt', 'B1')).rejects.toThrow(/新协议 WAL 记录/)
    expect(await records()).toBe(before)

    await wal.commitFloor('s#t1')
    await wal.rollbackFloor('s#t1', fs.root)
    // 两条新协议记录都正常回放：第一次写入被完整撤销。
    expect(await fs.withFloor(null).readText('x.txt')).toBeNull()
  })

  it('纯遗留协议（record + 一次 recordAfter）仍可回滚到最初内容', async () => {
    const { wal, fs } = await setup()
    await fs.withFloor(null).writeText('legacy.txt', '最初')
    await wal.beginFloor('s#t1')
    await wal.record('s#t1', 'legacy.txt', '最初')
    await fs.withFloor(null).writeText('legacy.txt', '本层正文')
    await wal.recordAfter('s#t1', 'legacy.txt', '本层正文')
    await wal.commitFloor('s#t1')

    const lines = (await readFile(join(fs.root, 'state', 'wal', 's_t1', 'records.jsonl'), 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(1)
    await wal.rollbackFloor('s#t1', fs.root)
    expect(await fs.withFloor(null).readText('legacy.txt')).toBe('最初')
  })
})
