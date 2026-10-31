/** Windows 重命名边界：真实临时文件及故障注入验证短暂占用可恢复、持续拒绝有界、角色/剧情发布与 WAL 回滚不丢原文。 */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { renameWithRetry } from '../src/state/rename.js'
import { parseJsonCard } from '../src/state/card.js'
import { importCard, loadCharacter } from '../src/state/workspace.js'
import { listStories, newStoryId, snapshotStory, storyRoot } from '../src/state/story.js'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

const fault = vi.hoisted(() => ({ platform: 'win32', remaining: 0, attempts: 0, fromIncludes: '', to: '', toIncludes: '',
  observed: [] as string[], error: Object.assign(new Error('工厂短暂拒绝'), { code: 'EPERM' }) }))
vi.mock('node:process', async importOriginal => {
  const actual = await importOriginal<typeof import('node:process')>()
  return { ...actual, get platform() { return fault.platform } }
})
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    const from = String(args[0]).replace(/\\/g, '/'), to = String(args[1]).replace(/\\/g, '/')
    if (fault.fromIncludes && from.includes(fault.fromIncludes) || fault.to && to === fault.to || fault.toIncludes && to.includes(fault.toIncludes)) {
      fault.attempts++
      if (fault.remaining !== 0) {
        if (fault.remaining > 0) fault.remaining--
        if (fault.to) fault.observed.push(await actual.readFile(args[1], 'utf8'))
        throw fault.error
      }
    }
    return actual.rename(...args)
  } }
})

let root: string
beforeEach(async () => {
  Object.assign(fault, { platform: 'win32', remaining: 0, attempts: 0, fromIncludes: '', to: '', toIncludes: '', observed: [],
    error: Object.assign(new Error('工厂短暂拒绝'), { code: 'EPERM' }) })
  root = await mkdtemp(join(tmpdir(), 'tavern-rename-recovery-'))
})
afterEach(async () => { fault.remaining = 0; await rm(root, { recursive: true, force: true }) })
async function files() {
  const from = join(root, 'prepared.md'), to = join(root, 'published.md')
  await writeFile(from, '完整新正文'); await writeFile(to, '旧正文')
  fault.to = to.replace(/\\/g, '/')
  return { from, to }
}

it.each(['EPERM', 'EACCES', 'EBUSY'])('Windows 短暂 %s 后替换成功，等待期间旧正文始终可读', async code => {
  const { from, to } = await files()
  fault.error.code = code; fault.remaining = 2
  await renameWithRetry(from, to)
  expect(await readFile(to, 'utf8')).toBe('完整新正文')
  expect(await readdir(root)).toEqual(['published.md'])
  expect(fault.observed).toEqual(['旧正文', '旧正文'])
})

it('持续占用在有限尝试后抛原错误，两个文件保持原样且不删除目标', async () => {
  const { from, to } = await files()
  fault.remaining = -1
  await expect(renameWithRetry(from, to)).rejects.toBe(fault.error)
  expect(fault.attempts).toBeGreaterThan(1); expect(fault.attempts).toBeLessThanOrEqual(8)
  expect(await readFile(from, 'utf8')).toBe('完整新正文')
  expect(await readFile(to, 'utf8')).toBe('旧正文')
})

it.each(['linux', 'darwin'])('%s 的拒绝立即上报，不重复操作', async platform => {
  const { from, to } = await files()
  fault.platform = platform; fault.remaining = -1
  await expect(renameWithRetry(from, to)).rejects.toBe(fault.error)
  expect(fault.attempts).toBe(1)
  expect(await readFile(to, 'utf8')).toBe('旧正文')
})

it.each(['EIO', 'ENOSPC', 'EEXIST', 'ENOTEMPTY', 'ENOENT'])('Windows 非占用错误 %s 立即保留，不隐藏磁盘故障或冲突', async code => {
  const { from, to } = await files()
  fault.error.code = code; fault.remaining = -1
  await expect(renameWithRetry(from, to)).rejects.toBe(fault.error)
  expect(fault.attempts).toBe(1)
  expect(await readFile(to, 'utf8')).toBe('旧正文')
})

it('角色导入发布遇占用后只发布一份完整角色，不留下准备目录', async () => {
  const characters = join(root, 'characters')
  fault.fromIncludes = '/.importing-'; fault.remaining = 2
  const card = await importCard(characters, parseJsonCard({ name: '重试角色', description: '资产正文' }))
  expect((await loadCharacter(characters, card.cardId))?.card.description).toBe('资产正文')
  expect(await readdir(characters)).toEqual([card.cardId])
  expect(fault.attempts).toBeGreaterThan(1)
})

it('剧情快照发布遇占用后保留来源，子剧情正文完整且没有重复发布', async () => {
  const card = await importCard(join(root, 'characters'), parseJsonCard({ name: '分支来源' }))
  const source = new WorkspaceFs(card.root, null)
  await source.writeText('journal.md', '来源剧情正文')
  fault.fromIncludes = '/.preparing-'; fault.remaining = 2
  const id = newStoryId()
  await snapshotStory({ cardRoot: card.root, sourceRoot: card.root, id, sessionId: 'child', includeWal: true })
  expect(await source.readText('journal.md')).toBe('来源剧情正文')
  expect(await new WorkspaceFs(storyRoot(card.root, id), null).readText('journal.md')).toBe('来源剧情正文')
  expect((await listStories(card.root)).map(story => story.id)).toEqual([id])
  expect(await readdir(join(card.root, 'stories'))).toEqual([id])
})

it.each([false, true])('WAL 撤销归档遇占用不丢恢复进度，持续失败后也可显式恢复（持续=%s）', async persistent => {
  const path = join(root, 'workspace'), wal = new Wal(join(path, 'state', 'wal')), fs = new WorkspaceFs(path, wal)
  await fs.writeText('journal.md', '楼层前正文'); await wal.beginFloor('s#t1')
  await fs.withFloor('s#t1').writeText('journal.md', '楼层后正文'); await wal.commitFloor('s#t1')
  fault.toIncludes = '.rolled-back-'; fault.remaining = persistent ? -1 : 2
  if (persistent) {
    await expect(wal.rollbackFloor('s#t1', path)).rejects.toBe(fault.error)
    expect(await fs.readText('journal.md')).toBe('楼层前正文')
    fault.remaining = 0
  }
  await wal.rollbackFloor('s#t1', path)
  expect(await fs.readText('journal.md')).toBe('楼层前正文')
  expect((await wal.listFloors()).filter(floor => !floor.rolledBack)).toEqual([])
  expect(fault.attempts).toBeGreaterThan(1)
})
