/**
 * WAL 缺行回归：首条或中间记录丢失时拒绝整批回滚、追加和提交，避免残留未来事实却标记成功；
 * 使用真实文件与只读 doctor 检查，兼容旧 before-only 日志和合法空白行。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDoctor } from '../src/doctor.js'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let home: string
let root: string
let wal: Wal
let fs: WorkspaceFs
let original: string
const recordPath = () => join(root, 'state/wal/f1/records.jsonl')

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'tavern-wal-sequence-'))
  root = join(home, 'dsh-tavern/characters/sequence-card-a1b2c3d4')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'card.json'), JSON.stringify({ name: '序号完整性' }))
  wal = new Wal(join(root, 'state/wal'))
  fs = new WorkspaceFs(root, wal)
  await wal.beginFloor('f1')
  await fs.withFloor('f1').writeTextMany([['first.txt', '第一条事实'], ['middle.txt', '第二条事实'], ['last.txt', '第三条事实']])
  await wal.commitFloor('f1')
  original = await readFile(recordPath(), 'utf8')
  await wal.beginFloor('f2')
  await fs.withFloor('f2').writeText('newest.txt', '较新楼层事实')
  await wal.commitFloor('f2')
})

afterEach(async () => { await rm(home, { recursive: true, force: true }) })

async function expectUnchanged(): Promise<void> {
  expect(await fs.readTextMany(['first.txt', 'middle.txt', 'last.txt', 'newest.txt']))
    .toEqual(['第一条事实', '第二条事实', '第三条事实', '较新楼层事实'])
  expect((await wal.listFloors()).every(floor => floor.committed && !floor.rolledBack)).toBe(true)
  expect(await fs.exists('state/wal/f1/rollback-progress.json')).toBe(false)
  expect(await fs.exists('state/wal/f2/rollback-progress.json')).toBe(false)
}

describe('WAL 序号必须从 1 连续递增', () => {
  it.each([0, 1])('第 %i 条记录丢失时，在整批正文修改前拒绝回滚，doctor 同样报告损坏', async index => {
    const lines = original.trimEnd().split('\n')
    lines.splice(index, 1)
    const damaged = lines.join('\n') + '\n'
    await writeFile(recordPath(), damaged)

    await expect(new Wal(join(root, 'state/wal')).rollbackAfter(['f1', 'f2'], root)).rejects.toThrow(/WAL.*序号/)
    await expectUnchanged()
    const report = await runDoctor({ home, nodeVersion: '24.0.0' })
    expect(report.statistics.wal).toMatchObject({ floors: 2, healthy: 1, unhealthy: 1 })
    expect(report.issues.map(issue => issue.code)).toContain('WAL_INVALID')
    expect(await readFile(recordPath(), 'utf8')).toBe(damaged)
  })

  it.each(['append', 'commit', 'validate', 'reopen'] as const)('%s 不接受跳号的日志，不把损坏固化为完成证明', async operation => {
    const damaged = original.replace('"seq":2', '"seq":20').replace('"seq":3', '"seq":21')
    await writeFile(recordPath(), damaged)
    const action = operation === 'append' ? fs.withFloor('f1').writeText('extra.txt', '不应保存')
      : operation === 'commit' ? wal.commitFloor('f1')
      : operation === 'reopen' ? wal.reopenFloor('f1') : wal.validateFloor('f1')
    await expect(action).rejects.toThrow(/WAL.*序号/)
    await expectUnchanged()
    expect(await fs.readText('extra.txt')).toBeNull()
    expect(await readFile(recordPath(), 'utf8')).toBe(damaged)
  })

  it('旧 before-only 记录与空白行仍可按原始顺序回滚', async () => {
    const lines = original.trimEnd().split('\n').map(line => {
      const { after: _after, afterEncoding: _encoding, ...record } = JSON.parse(line)
      return JSON.stringify(record)
    })
    await writeFile(recordPath(), '\n' + lines.join('\n\n') + '\n\n')
    await expect(wal.validateFloor('f1')).resolves.toMatchObject({ committed: true })
    await wal.rollbackAfter(['f1', 'f2'], root)
    expect(await fs.readTextMany(['first.txt', 'middle.txt', 'last.txt', 'newest.txt'])).toEqual([null, null, null, null])
  })
})
