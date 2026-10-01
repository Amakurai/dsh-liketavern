/**
 * 工作区链接边界回归：真实剧情 A/B 的记忆目录 junction 不得成为跨剧情读写入口；
 * 普通查询、事务写入与摘要展开均明确拒绝，安装根的祖先 junction 仍保持合法。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../src/state/memory.js'
import { expandAffectedMemories } from '../src/state/memoryRollback.js'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs, WorkspaceLinkError } from '../src/state/workspaceFs.js'

let root: string
let storyA: string
let storyB: string
let fs: WorkspaceFs
let wal: Wal
let memories: MemoryStore
let foreignId: string
let foreignText: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-workspace-links-'))
  storyA = join(root, 'stories', 'a')
  storyB = join(root, 'stories', 'b')
  await mkdir(storyA, { recursive: true })
  await mkdir(storyB, { recursive: true })
  const foreign = await new MemoryStore(new WorkspaceFs(storyB, null)).write({
    body: '兄弟剧情独有的蓝色钥匙', keys: ['蓝色钥匙'],
  })
  foreignId = foreign.id
  foreignText = await readFile(join(storyB, 'memory', `${foreignId}.md`), 'utf8')
  await symlink(join(storyB, 'memory'), join(storyA, 'memory'), process.platform === 'win32' ? 'junction' : 'dir')
  wal = new Wal(join(storyA, 'state', 'wal'))
  await wal.beginFloor('a#t1')
  fs = new WorkspaceFs(storyA, wal).withFloor('a#t1')
  memories = new MemoryStore(fs)
})

afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function expectForeignIntact(): Promise<void> {
  expect(await readdir(join(storyB, 'memory'))).toEqual([`${foreignId}.md`])
  expect(await readFile(join(storyB, 'memory', `${foreignId}.md`), 'utf8')).toBe(foreignText)
  const records = await readFile(join(storyA, 'state', 'wal', 'a_t1', 'records.jsonl'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return ''
    throw error
  })
  expect(records).toBe('')
}

describe('普通剧情记忆入口拒绝内部链接', () => {
  it.each(['list', 'search', 'get', 'stats', 'findSimilar'] as const)('%s 不读取兄弟剧情', async operation => {
    const result = operation === 'list' ? memories.list()
      : operation === 'search' ? memories.search('蓝色钥匙')
      : operation === 'get' ? memories.get(foreignId)
      : operation === 'stats' ? memories.stats()
      : memories.findSimilar('蓝色钥匙', [])
    await expect(result).rejects.toBeInstanceOf(WorkspaceLinkError)
    await expectForeignIntact()
  })

  it.each(['write', 'update', 'delete', 'archive'] as const)('%s 不写入兄弟剧情，也不记录伪快照', async operation => {
    const result = operation === 'write' ? memories.write({ body: '来自 A 的污染事实' })
      : operation === 'update' ? memories.update(foreignId, { body: '来自 A 的覆盖' })
      : operation === 'delete' ? memories.delete(foreignId)
      : memories.archive([foreignId])
    await expect(result).rejects.toBeInstanceOf(WorkspaceLinkError)
    await expectForeignIntact()
  })

  it('摘要回滚规划拒绝根链接，来源与原摘要不受影响', async () => {
    await expect(expandAffectedMemories(storyA, [`memory/${foreignId}.md`])).rejects.toBeInstanceOf(WorkspaceLinkError)
    await expectForeignIntact()
  })

  it('摘要图拒绝链接子目录，不能跳过来源链后宣称规划完整', async () => {
    await rm(join(storyA, 'memory'))
    const own = await new MemoryStore(new WorkspaceFs(storyA, null)).write({ body: 'A 原有事实' })
    const ownPath = join(storyA, 'memory', `${own.id}.md`)
    const ownText = await readFile(ownPath, 'utf8')
    await symlink(join(storyB, 'memory'), join(storyA, 'memory', 'archive'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(expandAffectedMemories(storyA, [`memory/${own.id}.md`])).rejects.toBeInstanceOf(WorkspaceLinkError)
    expect(await readFile(ownPath, 'utf8')).toBe(ownText)
    await expectForeignIntact()
  })
})

describe('通用文件面默认保护所有直接目标与父目录', () => {
  it.each(['readText', 'readBytes', 'exists', 'stat', 'list', 'listStats', 'ensureDir', 'writeText', 'writeBytes', 'delete'] as const)(
    '%s 不沿内部目录链接操作', async operation => {
      const path = `memory/${foreignId}.md`
      const result = operation === 'readText' ? fs.readText(path)
        : operation === 'readBytes' ? fs.readBytes(path)
        : operation === 'exists' ? fs.exists(path)
        : operation === 'stat' ? fs.stat(path)
        : operation === 'list' ? fs.list('memory')
        : operation === 'listStats' ? fs.listStats('memory')
        : operation === 'ensureDir' ? fs.ensureDir('memory/new')
        : operation === 'writeText' ? fs.writeText(path, '覆盖')
        : operation === 'writeBytes' ? fs.writeBytes(path, new Uint8Array([1, 2, 3]))
        : fs.delete(path)
      await expect(result).rejects.toBeInstanceOf(WorkspaceLinkError)
      await expectForeignIntact()
    },
  )

  it('工作区根的安装祖先 junction 仍可正常读写与列举', async () => {
    const installed = join(root, 'installed')
    const linked = join(root, 'mounted-installation')
    await mkdir(join(installed, 'workspace'), { recursive: true })
    await symlink(installed, linked, process.platform === 'win32' ? 'junction' : 'dir')
    const mounted = new WorkspaceFs(join(linked, 'workspace'), null)
    await mounted.writeText('memory/own.md', '合法安装目录下的剧情正文')
    expect(await mounted.readText('memory/own.md', { rejectLinks: true })).toBe('合法安装目录下的剧情正文')
    expect(await mounted.list('memory', { rejectLinks: true })).toEqual(['own.md'])
    expect(await mounted.stat('memory/own.md')).toMatchObject({ size: expect.any(Number) })
  })
})
