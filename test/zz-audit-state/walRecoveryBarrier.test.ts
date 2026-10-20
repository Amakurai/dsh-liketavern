/**
 * S1 回归：回滚恢复期间的工作区级写屏障与受控重置。
 *
 * 修复前：某层回滚中断（rollback-progress.json 留有 pending）后，其它楼层与 floor=null 的
 * 面板/维护写入仍会成功；改到 pending 路径后每次重试都抛「WAL 恢复期间文件又被修改」，
 * 游标无法推进也没有清除入口，回退/分支永久卡死。
 * 修复后：标记存在期间所有外部写入与开层都被明确拒绝；回滚自身经内部放行仍可完成；
 * 外部改盘造成的冲突可用 resetRollbackCursor 解除。
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Wal } from '../../src/state/wal.js'
import { WorkspaceFs } from '../../src/state/workspaceFs.js'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'audit-wal-recovery-'))
  roots.push(root)
  const wal = new Wal(join(root, 'state', 'wal'))
  const fs = new WorkspaceFs(root, wal)
  const plain = new WorkspaceFs(root, null)
  return { root, wal, fs, plain }
}

/** 让第一次恢复指定路径的写入失败，留下带 pending 的恢复游标。 */
function failRestoreOnce(path: string): void {
  const original = WorkspaceFs.prototype.writeBytes
  const spy = vi.spyOn(WorkspaceFs.prototype, 'writeBytes').mockImplementation(async function (this: WorkspaceFs, relPath: string, bytes: Uint8Array) {
    if (relPath === path) {
      spy.mockRestore()
      throw new Error(`模拟恢复写入失败: ${relPath}`)
    }
    return original.call(this, relPath, bytes)
  })
}

async function progressOf(root: string, floorDir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(root, 'state', 'wal', floorDir, 'rollback-progress.json'), 'utf8')) as Record<string, unknown>
}

describe('回滚恢复写屏障', () => {
  it('恢复中断后其它楼层与无楼层写入都被拒绝，回滚自身仍能完成并清除标记', async () => {
    const { root, wal, fs, plain } = await setup()
    await plain.writeText('memory/x.md', '原始事实')
    await wal.beginFloor('s#t1')
    await fs.withFloor('s#t1').writeText('memory/x.md', '楼层事实')
    await wal.commitFloor('s#t1')

    failRestoreOnce('memory/x.md')
    await expect(wal.rollbackFloor('s#t1', root)).rejects.toThrow('模拟恢复写入失败')
    expect(await progressOf(root, 's_t1')).toMatchObject({ pending: { path: 'memory/x.md' } })
    await expect(wal.recoveringFloors()).resolves.toEqual(['s#t1'])

    // 屏障：其它楼层开层、楼层写入与 floor=null 面板写入全部明确拒绝。
    await expect(wal.beginFloor('other#t9')).rejects.toThrow(/回滚恢复/)
    await expect(fs.withFloor('other#t9').writeText('journal.md', '恢复期间的新事实')).rejects.toThrow(/回滚恢复/)
    await expect(plain.writeText('memory/y.md', '恢复期间的面板写入')).rejects.toThrow(/回滚恢复/)
    await expect(plain.delete('memory/x.md')).rejects.toThrow(/回滚恢复/)
    expect(await plain.readText('journal.md')).toBeNull()
    expect(await plain.readText('memory/y.md')).toBeNull()

    // 回滚自身不被屏障挡住：重试完成，正文还原，标记与游标一起消失。
    await expect(wal.rollbackFloor('s#t1', root)).resolves.toBeDefined()
    expect(await plain.readText('memory/x.md')).toBe('原始事实')
    expect((await wal.listFloors())[0]?.rolledBack).toBe(true)
    await expect(wal.recoveringFloors()).resolves.toEqual([])
    await expect(plain.writeText('memory/y.md', '恢复完成后可写')).resolves.toBeUndefined()
  })

  it('外部改盘造成的 pending 冲突可由 resetRollbackCursor 解除，不再是永久死锁', async () => {
    const { root, wal, fs, plain } = await setup()
    await plain.writeText('memory/x.md', '原始事实')
    await wal.beginFloor('s#t1')
    await fs.withFloor('s#t1').writeText('memory/x.md', '楼层事实')
    await wal.commitFloor('s#t1')

    failRestoreOnce('memory/x.md')
    await expect(wal.rollbackFloor('s#t1', root)).rejects.toThrow('模拟恢复写入失败')

    // 模拟进程外编辑（编辑器/其它进程直接写盘，绕过 WorkspaceFs 屏障）。
    await writeFile(join(root, 'memory', 'x.md'), '外部改写', 'utf8')
    await expect(wal.rollbackFloor('s#t1', root)).rejects.toThrow(/WAL 恢复期间文件又被修改/)
    await expect(wal.commitFloor('s#t1')).rejects.toThrow(/回滚恢复/)

    // 受控重置：删除游标并注销标记；写入恢复可用。
    await expect(wal.resetRollbackCursor('s#t1')).resolves.toBeUndefined()
    await expect(wal.recoveringFloors()).resolves.toEqual([])
    await expect(plain.writeText('memory/y.md', '重置后可写')).resolves.toBeUndefined()

    // 重置不等于跳过回滚：重新回滚会完成，外部修订按既有「保留人工修订」语义留下。
    await expect(wal.rollbackFloor('s#t1', root)).resolves.toBeDefined()
    expect(await plain.readText('memory/x.md')).toBe('外部改写')
    expect((await wal.listFloors())[0]?.rolledBack).toBe(true)
  })

  it('重置不存在或已回滚的楼层明确报错', async () => {
    const { root, wal, fs } = await setup()
    await expect(wal.resetRollbackCursor('s#missing')).rejects.toThrow(/不存在/)
    await wal.beginFloor('s#t1')
    await fs.withFloor('s#t1').writeText('a.txt', 'A')
    await wal.commitFloor('s#t1')
    await wal.rollbackFloor('s#t1', root)
    await expect(wal.resetRollbackCursor('s#t1')).rejects.toThrow(/不存在或已回滚/)
  })

  it('游标已随归档消失的失效标记不挡面板写入；游标仍在时照常拒绝', async () => {
    const { root, wal, fs, plain } = await setup()
    await plain.writeText('memory/x.md', '原始事实')
    await wal.beginFloor('s#t1')
    await fs.withFloor('s#t1').writeText('memory/x.md', '楼层事实')
    await wal.commitFloor('s#t1')
    // 模拟崩溃在「已改名归档、未注销标记」之间：标记还在，游标目录已不存在。
    await writeFile(join(root, 'state', 'wal-recovery.json'), JSON.stringify({ version: 1, floors: ['s#gone'], dirs: ['s_gone'], walDir: join(root, 'state', 'wal') }))
    await expect(plain.writeText('journal.md', '面板写入')).resolves.toBeUndefined()

    failRestoreOnce('memory/x.md')
    await expect(wal.rollbackFloor('s#t1', root)).rejects.toThrow('模拟恢复写入失败')
    await expect(plain.writeText('journal.md', '恢复中')).rejects.toThrow(/回滚恢复/)
  })
})
