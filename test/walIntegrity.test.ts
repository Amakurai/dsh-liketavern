/** WAL 完整性回归：损坏快照与恢复游标必须在整批回滚前拒绝，真实文件与楼层状态保持原样。 */
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Wal, WAL_BINARY_MARK } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let wal: Wal
let fs: WorkspaceFs
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-wal-integrity-'))
  wal = new Wal(join(root, 'state/wal'))
  fs = new WorkspaceFs(root, wal)
  await fs.writeText('a.txt', '旧原文')
  await wal.beginFloor('f1')
  await fs.withFloor('f1').writeText('a.txt', '旧楼层正文')
  await wal.commitFloor('f1')
  await wal.beginFloor('f2')
  await fs.withFloor('f2').writeText('b.txt', '新楼层正文')
  await wal.commitFloor('f2')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function expectIntact(): Promise<void> {
  expect(await fs.readText('a.txt')).toBe('旧楼层正文')
  expect(await fs.readText('b.txt')).toBe('新楼层正文')
  expect((await wal.listFloors()).every(floor => !floor.rolledBack && floor.committed)).toBe(true)
}

describe('快照编码完整性', () => {
  it.each([
    { before: '%%%损坏%%%', beforeEncoding: 'base64' },
    { after: 'YQ', afterEncoding: 'base64' },
    { before: 'YR==', beforeEncoding: 'base64' },
    { before: WAL_BINARY_MARK + '%%%损坏%%%', beforeEncoding: undefined },
  ])('拒绝损坏或截断的二进制快照：%j', async patch => {
    const path = join(root, 'state/wal/f1/records.jsonl')
    const record = JSON.parse((await readFile(path, 'utf8')).trim())
    await writeFile(path, JSON.stringify({ ...record, ...patch }) + '\n')
    await expect(wal.rollbackAfter(['f1', 'f2'], root)).rejects.toThrow(/WAL.*编码/)
    await expectIntact()
  })

  it('有效二进制、空文件与旧标记仍可完整恢复', async () => {
    const binary = Buffer.from([0, 0xff, 0x89, 0x50])
    await fs.writeBytes('binary.bin', binary)
    await fs.writeBytes('empty.bin', new Uint8Array())
    await wal.beginFloor('f3')
    await fs.withFloor('f3').writeBytes('binary.bin', Buffer.from([1, 2]))
    await fs.withFloor('f3').writeBytes('empty.bin', Buffer.from([3]))
    await wal.record('f3', 'legacy.bin', WAL_BINARY_MARK + binary.toString('base64'))
    await fs.writeBytes('legacy.bin', Buffer.from([4]))
    await wal.commitFloor('f3')
    await wal.rollbackFloor('f3', root)
    expect(await fs.readBytes('binary.bin')).toEqual(binary)
    expect(await fs.readBytes('empty.bin')).toEqual(Buffer.alloc(0))
    expect(await fs.readBytes('legacy.bin')).toEqual(binary)
  })
})

describe('批量回滚预检恢复游标', () => {
  it.each([
    '{broken',
    'null',
    JSON.stringify({ hash: 'stale', next: 0, restored: [], preserved: [] }),
  ])('旧楼层游标损坏时，新楼层也不能先被撤销：%s', async raw => {
    await writeFile(join(root, 'state/wal/f1/rollback-progress.json'), raw)
    await expect(wal.rollbackAfter(['f1', 'f2'], root)).rejects.toThrow(/WAL.*恢复/)
    await expectIntact()
  })

  it.each([
    { pending: { path: 'a.txt', from: '%%%损坏%%%', to: '' } },
    { pending: { path: 'a.txt', from: '', to: 'YQ' } },
    { pending: { path: 'other.txt', from: '', to: null } },
    { pending: null },
    { restored: [42] },
    { preserved: ['../outside.txt'] },
    { next: -1 },
    { next: -1, pending: { path: 'a.txt', from: '', to: null } },
  ])('拒绝恢复记录中的非法字段：%j', async patch => {
    const records = (await readFile(join(root, 'state/wal/f1/records.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const hash = createHash('sha256').update(JSON.stringify(records)).digest('hex')
    await writeFile(join(root, 'state/wal/f1/rollback-progress.json'), JSON.stringify({ hash, next: 0, restored: [], preserved: [], ...patch }))
    await expect(wal.rollbackAfter(['f1', 'f2'], root)).rejects.toThrow(/WAL.*恢复/)
    await expectIntact()
  })
})
