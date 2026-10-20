/**
 * 宿主交付面修复回归（task-12）。
 * H1：doctor 必须把 state/wal-coverage.json 与磁盘楼层对账，登记楼层缺失（整目录、仅文件、日志被清空）
 *     一律报 error；连带 backup create 不再放行「哈希自洽但运行时不可用」的数据集。
 * H2：已成功回滚的目录是终态，不再计入 pending，也不再误报 WAL_UNCOMMITTED。
 * H4/H5：README 数据目录树与实际布局一致；发布复核清单包含 backup:check。
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runDoctor } from '../../src/doctor.js'
import { createBackup, verifyBackup } from '../../src/node/backup.js'
import { WAL_COVERAGE_PATH, Wal } from '../../src/state/wal.js'
import { WorkspaceFs } from '../../src/state/workspaceFs.js'

let scratch: string
let home: string
let backup: string
const cardId = 'audit-fix-card-a1b2c3d4'
const storyId = 'story-00000000-0000-4000-8000-000000000000'
const sessionId = 'audit-session'
const cardRoot = () => join(home, 'dsh-tavern', 'characters', cardId)
const story = () => join(cardRoot(), 'stories', storyId)
const walRoot = () => join(story(), 'state/wal')
const coverageFile = () => join(story(), 'state', 'wal-coverage.json')

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'tavern-host-fix-'))
  home = join(scratch, 'home')
  backup = join(scratch, 'backup')
  await Promise.all(['characters', 'library/lorebooks', 'library/presets', 'personas', 'regex', 'sessions']
    .map(path => mkdir(join(home, 'dsh-tavern', path), { recursive: true })))
  await mkdir(story(), { recursive: true })
  await writeFile(join(cardRoot(), 'card.json'), JSON.stringify({ name: 'audit' }))
  await writeFile(join(story(), 'story.json'), JSON.stringify({
    version: 1, id: storyId, sessionId, createdAt: new Date(0).toISOString(), migrated: false,
  }))
})
afterEach(async () => { await rm(scratch, { recursive: true, force: true }) })

async function commitFloors(turns: number[]): Promise<void> {
  const wal = new Wal(walRoot())
  const fs = new WorkspaceFs(story(), wal)
  for (const turn of turns) {
    await wal.beginFloor(`${sessionId}#t${turn}`)
    await fs.withFloor(`${sessionId}#t${turn}`).writeText('journal.md', `body-${turn}`)
    await wal.commitFloor(`${sessionId}#t${turn}`)
  }
}

const report = () => runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '9.8.7' })
const codes = (issues: ReadonlyArray<{ code: string }>) => issues.map(issue => issue.code)

describe('H1 独立楼层清单与磁盘日志对账', () => {
  it('基线：清单与两个已提交楼层一致时健康且无缺失报告', async () => {
    await commitFloors([1, 2])
    const result = await report()
    expect(result.ok).toBe(true)
    expect(result.statistics.wal).toMatchObject({ roots: 1, floors: 2, healthy: 2, committed: 2, pending: 0 })
    expect(codes(result.issues)).not.toContain('WAL_FLOOR_MISSING')
  })

  it('清单未初始化（旧日志）时不误报缺失', async () => {
    await commitFloors([1])
    await rm(coverageFile(), { force: true })
    const result = await report()
    expect(result.ok).toBe(true)
    expect(codes(result.issues)).not.toContain('WAL_FLOOR_MISSING')
  })

  it('删除清单登记的楼层整目录后报 WAL_FLOOR_MISSING 且 doctor 失败', async () => {
    await commitFloors([1, 2])
    await rm(join(walRoot(), `${sessionId}_t1`), { recursive: true, force: true })
    const result = await report()
    expect(result.ok).toBe(false)
    expect(codes(result.issues)).toContain('WAL_FLOOR_MISSING')
    expect(result.issues.find(issue => issue.code === 'WAL_FLOOR_MISSING')).toMatchObject({ severity: 'error', count: 1 })
  })

  it('目录仍在但 meta/records 被清空（日志被洗掉）同样报缺失', async () => {
    await commitFloors([1, 2])
    await rm(join(walRoot(), `${sessionId}_t1`, 'meta.json'), { force: true })
    await rm(join(walRoot(), `${sessionId}_t1`, 'records.jsonl'), { force: true })
    const result = await report()
    expect(result.ok).toBe(false)
    expect(codes(result.issues)).toContain('WAL_FLOOR_MISSING')
  })

  it('整份 state/wal 被删除时仍按清单报告缺失', async () => {
    await commitFloors([1])
    await rm(walRoot(), { recursive: true, force: true })
    const result = await report()
    expect(result.ok).toBe(false)
    expect(codes(result.issues)).toContain('WAL_FLOOR_MISSING')
  })

  it('已回滚副本的身份算数，不误报缺失', async () => {
    await commitFloors([1, 2])
    const wal = new Wal(walRoot())
    await wal.rollbackFloor(`${sessionId}#t2`, story())
    const result = await report()
    expect(codes(result.issues)).not.toContain('WAL_FLOOR_MISSING')
    expect(result.statistics.wal).toMatchObject({ floors: 2, rolledBack: 1 })
  })

  it('清单形状损坏时报 WAL_COVERAGE_INVALID', async () => {
    await commitFloors([1])
    await writeFile(coverageFile(), '{"version":1,"floors":[12]}')
    const result = await report()
    expect(result.ok).toBe(false)
    expect(codes(result.issues)).toContain('WAL_COVERAGE_INVALID')
  })

  it('读取/目录项预算耗尽时不做缺失断言，避免限额造成误报', async () => {
    await commitFloors([1, 2])
    const tightRead = await runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '9.8.7', readBudgetBytes: 64 })
    expect(codes(tightRead.issues)).not.toContain('WAL_FLOOR_MISSING')
    const tightScan = await runDoctor({ home, nodeVersion: '24.0.0', pluginVersion: '9.8.7', scanEntryLimit: 4 })
    expect(codes(tightScan.issues)).not.toContain('WAL_FLOOR_MISSING')
  })

  it('清单登记楼层缺失时 backup create 拒绝而不是报 OK', async () => {
    await commitFloors([1, 2])
    await rm(join(walRoot(), `${sessionId}_t1`), { recursive: true, force: true })
    await expect(createBackup({ home, backup, offline: true })).rejects.toMatchObject({ code: 'STRUCTURE_INVALID' })
    // 未发布备份目录：create 在扫描阶段就拒绝，不能留下半成品
    await expect(readFile(join(backup, 'manifest.json'), 'utf8')).rejects.toBeInstanceOf(Error)
  })

  it('清单登记楼层缺失不影响完好数据的备份与恢复', async () => {
    await commitFloors([1, 2])
    const created = await createBackup({ home, backup, offline: true })
    expect(created).toMatchObject({ ok: true, code: 'OK' })
    const verified = await verifyBackup({ backup })
    expect(verified).toMatchObject({ ok: true, code: 'OK' })
  })
})

describe('H2 已回滚目录不是遗留未收口事务', () => {
  it('未提交楼层回滚成功后 pending=0 且无 WAL_UNCOMMITTED', async () => {
    const wal = new Wal(walRoot())
    const fs = new WorkspaceFs(story(), wal)
    await wal.beginFloor(`${sessionId}#t1`)
    await fs.withFloor(`${sessionId}#t1`).writeText('journal.md', 'pending body')
    await wal.rollbackFloor(`${sessionId}#t1`, story())

    const result = await report()
    expect(result.statistics.wal).toMatchObject({ floors: 1, active: 0, rolledBack: 1, committed: 0, pending: 0, healthy: 1 })
    expect(codes(result.issues)).not.toContain('WAL_UNCOMMITTED')
    expect(result.ok).toBe(true)
  })

  it('活跃的未提交楼层仍按 pending 报告', async () => {
    const wal = new Wal(walRoot())
    const fs = new WorkspaceFs(story(), wal)
    await wal.beginFloor(`${sessionId}#t1`)
    await fs.withFloor(`${sessionId}#t1`).writeText('journal.md', 'still open')

    const result = await report()
    expect(result.statistics.wal.pending).toBe(1)
    expect(codes(result.issues)).toContain('WAL_UNCOMMITTED')
  })
})

describe('H4/H5 文档与实际布局一致', () => {
  it('README 两种语言的数据目录树列出实际布局', async () => {
    for (const file of ['README.md', 'README.en.md']) {
      const text = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8')
      const blocks = [...text.matchAll(/```text\r?\n([\s\S]*?)```/g)].map(match => match[1] ?? '')
      const tree = blocks.find(block => block.includes('characters/'))
      expect(tree, `${file} 缺少数据目录树`).toBeTruthy()
      for (const expected of ['characters/', 'library/', 'presets/', 'lorebooks/', 'personas/', 'regex/', 'sessions/', 'editor-drafts/']) {
        expect(tree, `${file} 目录树缺少 ${expected}`).toContain(expected)
      }
      // 预设与世界书必须挂在 library/ 下，不能退回顶层目录。
      expect(tree!.indexOf('library/')).toBeLessThan(tree!.indexOf('presets/'))
      expect(tree!.indexOf('library/')).toBeLessThan(tree!.indexOf('lorebooks/'))
      // 顶层条目形如 `├── name/`；嵌套在 library/ 下的条目带 `│` 前缀，不算违规。
      expect(tree).not.toMatch(/^(?:├── |└── )presets\//m)
      expect(tree).not.toMatch(/^(?:├── |└── )lorebooks\//m)
      expect(tree).not.toMatch(/^(?:├── |└── )stories\//m)
    }
  })

  it('发布复核清单包含 backup:check', async () => {
    const text = await readFile(new URL('../../docs/RELEASING.md', import.meta.url), 'utf8')
    expect(text).toContain('backup:check')
  })
})
