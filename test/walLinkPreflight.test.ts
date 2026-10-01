/** WAL 链接边界回归：正文、摘要/索引派生入口与日志自身均在整批修改前拒绝跨剧情链接。 */
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { serializeMemory } from '../src/state/memory.js'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs, WorkspaceLinkError } from '../src/state/workspaceFs.js'

let root: string, ownRoot: string, foreignRoot: string, fs: WorkspaceFs, foreign: WorkspaceFs, wal: Wal
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wal-link-preflight-'))
  ownRoot = join(root, 'own')
  foreignRoot = join(root, 'foreign')
  wal = new Wal(join(ownRoot, 'state/wal'))
  fs = new WorkspaceFs(ownRoot, wal)
  foreign = new WorkspaceFs(foreignRoot, null)
  await fs.writeText('notes/a.txt', '原笔记')
  await fs.writeText('journal.md', '原日志')
  await wal.beginFloor('f1')
  await fs.withFloor('f1').writeText('notes/a.txt', '本层笔记')
  await wal.commitFloor('f1')
  await wal.beginFloor('f2')
  await fs.withFloor('f2').writeText('journal.md', '后继日志')
  await wal.commitFloor('f2')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const directoryLink = (target: string, path: string) => symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')

async function foreignLogs(): Promise<Array<[string, string | null]>> {
  return Promise.all((await foreign.list('state/wal')).map(async path => [path, await foreign.readText(`state/wal/${path}`)] as [string, string | null]))
}

it('旧楼层正文父目录变成兄弟目录链接时，整批拒绝且不先撤销新楼层', async () => {
  await foreign.writeText('notes/a.txt', '本层笔记')
  await rename(join(ownRoot, 'notes'), join(root, 'saved-notes'))
  await directoryLink(join(foreignRoot, 'notes'), join(ownRoot, 'notes'))
  await expect(wal.rollbackAfter(['f1', 'f2'], ownRoot)).rejects.toBeInstanceOf(WorkspaceLinkError)
  expect(await fs.readText('journal.md')).toBe('后继日志')
  expect(await foreign.readText('notes/a.txt')).toBe('本层笔记')
  expect(await fs.readText('state/wal/f2/rollback-progress.json')).toBeNull()
})

it('旧记忆楼层的归档目录链接也在新日志楼层撤销之前被发现', async () => {
  await wal.beginFloor('f3')
  const memory = serializeMemory({ created: '2026-01-01', updated: '2026-01-01', sourceRange: '', tags: [], keys: [] }, '本层事实')
  await fs.withFloor('f3').writeText('memory/source.md', memory)
  await wal.commitFloor('f3')
  await wal.beginFloor('f4')
  await fs.withFloor('f4').writeText('journal.md', '最新日志')
  await wal.commitFloor('f4')
  await foreign.ensureDir('archive')
  await directoryLink(join(foreignRoot, 'archive'), join(ownRoot, 'memory/archive'))
  await expect(wal.rollbackAfter(['f3', 'f4'], ownRoot)).rejects.toBeInstanceOf(WorkspaceLinkError)
  expect(await fs.readText('journal.md')).toBe('最新日志')
  expect(await fs.readText('memory/source.md')).toBe(memory)
  expect(await fs.readText('state/wal/f4/rollback-progress.json')).toBeNull()
})

it.each(['state', 'state/wal'])('普通楼层写入和恢复均拒绝日志根 %s 指向兄弟剧情', async path => {
  const foreignWal = new Wal(join(foreignRoot, 'state/wal'))
  await foreignWal.beginFloor('foreign')
  await foreignWal.commitFloor('foreign')
  const before = await foreignLogs()
  await rename(join(ownRoot, path), join(root, 'saved-wal-root'))
  await directoryLink(join(foreignRoot, path), join(ownRoot, path))
  await expect(wal.beginFloor('f3')).rejects.toBeInstanceOf(WorkspaceLinkError)
  await expect(wal.recordChange('f1', 'notes/a.txt', '本层笔记', '污染正文', 'utf8', 'utf8')).rejects.toBeInstanceOf(WorkspaceLinkError)
  await expect(wal.commitFloor('f1')).rejects.toBeInstanceOf(WorkspaceLinkError)
  await expect(wal.listFloors()).rejects.toBeInstanceOf(WorkspaceLinkError)
  await expect(wal.rollbackAfter(['f1', 'f2'], ownRoot)).rejects.toBeInstanceOf(WorkspaceLinkError)
  expect(await foreignLogs()).toEqual(before)
  expect(await fs.readText('notes/a.txt')).toBe('本层笔记')
  expect(await fs.readText('journal.md')).toBe('后继日志')
})

it('楼层日志目录链接拒绝追加、提交、重开、列举与恢复，不触碰兄弟日志', async () => {
  const foreignWal = new Wal(join(foreignRoot, 'state/wal'))
  await foreignWal.beginFloor('f1')
  await foreignWal.recordChange('f1', 'notes/a.txt', '原笔记', '本层笔记', 'utf8', 'utf8')
  await foreignWal.commitFloor('f1')
  const before = await foreignLogs()
  await rename(join(ownRoot, 'state/wal/f1'), join(root, 'saved-floor'))
  await directoryLink(join(foreignRoot, 'state/wal/f1'), join(ownRoot, 'state/wal/f1'))
  await expect(wal.beginFloor('f1')).rejects.toBeInstanceOf(WorkspaceLinkError)
  await expect(wal.recordChange('f1', 'notes/a.txt', '本层笔记', '污染正文', 'utf8', 'utf8')).rejects.toBeInstanceOf(WorkspaceLinkError)
  await expect(wal.commitFloor('f1')).rejects.toBeInstanceOf(WorkspaceLinkError)
  await expect(wal.reopenFloor('f1')).rejects.toBeInstanceOf(WorkspaceLinkError)
  await expect(wal.validateFloor('f1')).rejects.toBeInstanceOf(WorkspaceLinkError)
  await expect(wal.listFloors()).rejects.toBeInstanceOf(WorkspaceLinkError)
  await expect(wal.rollbackAfter(['f1', 'f2'], ownRoot)).rejects.toBeInstanceOf(WorkspaceLinkError)
  expect(await foreignLogs()).toEqual(before)
  expect(await fs.readText('journal.md')).toBe('后继日志')
})

it.for(['meta.json', 'records.jsonl', 'rollback-progress.json'])('日志标记 %s 的文件链接不能被正常写入或恢复读取', async (marker, ctx) => {
  const file = join(ownRoot, 'state/wal/f1', marker)
  const target = join(foreignRoot, marker)
  await mkdir(foreignRoot, { recursive: true })
  const original = await readFile(file, 'utf8').catch(() => '{"private":"foreign"}')
  await writeFile(target, original)
  await rm(file, { force: true })
  try { await symlink(target, file, 'file') }
  catch (error) {
    // 无文件链接权限的 Windows 环境由目录 junction 用例覆盖边界。
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) ctx.skip('当前环境无文件 symlink 权限')
    throw error
  }
  await expect(wal.recordChange('f1', 'notes/a.txt', '本层笔记', '污染正文', 'utf8', 'utf8')).rejects.toBeInstanceOf(WorkspaceLinkError)
  await expect(wal.commitFloor('f1')).rejects.toBeInstanceOf(WorkspaceLinkError)
  await expect(wal.rollbackAfter(['f1', 'f2'], ownRoot)).rejects.toBeInstanceOf(WorkspaceLinkError)
  expect(await readFile(target, 'utf8')).toBe(original)
  expect(await fs.readText('journal.md')).toBe('后继日志')
})

it.for(['journal.md', 'index.json', 'state/world-delta.jsonl'])('索引派生入口 %s 的链接在任何正文恢复前被拒绝', async (path, ctx) => {
  await wal.beginFloor('f3')
  await fs.withFloor('f3').writeText('memory/source.md', serializeMemory({ created: '2026-01-01', updated: '2026-01-01', sourceRange: '', tags: [], keys: [] }, '本层事实'))
  await wal.commitFloor('f3')
  await wal.beginFloor('f4')
  await fs.withFloor('f4').writeText('notes/later.txt', '最新笔记')
  await wal.commitFloor('f4')
  const target = join(foreignRoot, 'private.txt')
  await foreign.writeText('private.txt', '兄弟正文')
  await mkdir(join(ownRoot, 'state'), { recursive: true })
  await rm(join(ownRoot, path), { force: true })
  try { await symlink(target, join(ownRoot, path), 'file') }
  catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) ctx.skip('当前环境无文件 symlink 权限')
    throw error
  }
  await expect(wal.rollbackAfter(['f3', 'f4'], ownRoot)).rejects.toBeInstanceOf(WorkspaceLinkError)
  expect(await fs.readText('notes/later.txt')).toBe('最新笔记')
  expect(await fs.readText('memory/source.md')).not.toBeNull()
  expect(await foreign.readText('private.txt')).toBe('兄弟正文')
  expect(await fs.readText('state/wal/f4/rollback-progress.json')).toBeNull()
})
