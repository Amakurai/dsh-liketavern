/**
 * 批量取文件指纹（WorkspaceFs.statMany / listStats）的行为回归：真实文件系统上结果与逐个 stat 相同，
 * 省掉的只是重复的父目录链接检查；父目录或文件本身是链接时仍然拒绝，越界路径仍然拒绝。
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorkspaceFs, WorkspaceLinkError } from '../src/state/workspaceFs.js'

let base: string
let root: string
let fs: WorkspaceFs

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'tavern-stat-many-'))
  root = join(base, 'story')
  await mkdir(join(root, 'memory', 'archive'), { recursive: true })
  await writeFile(join(root, 'memory', 'a.md'), '甲')
  await writeFile(join(root, 'memory', 'b.md'), '乙乙')
  await writeFile(join(root, 'memory', 'archive', 'old.md'), '旧事实')
  fs = new WorkspaceFs(root, null)
})

afterEach(async () => { await rm(base, { recursive: true, force: true }) })

/** 文件链接在 Windows 上需要额外权限；建不出来就跳过对应用例。 */
async function tryFileLink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path, 'file')
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return false
    throw error
  }
}

describe('statMany', () => {
  it('结果与逐个 stat 逐项相同：存在、缺失、子目录下、父目录缺失、目录本身', async () => {
    const paths = ['memory/a.md', 'memory/missing.md', 'memory/archive/old.md', 'memory/b.md', 'nowhere/x.md', 'memory/archive', 'memory/a.md']
    const many = await fs.statMany(paths)
    expect(many).toHaveLength(paths.length)
    for (const [index, path] of paths.entries()) expect(many[index], path).toEqual(await fs.stat(path))
    expect(many.map((item) => item === null)).toEqual([false, true, false, false, true, false, false])
    expect(many[0]!.size).toBe(Buffer.byteLength('甲'))
    expect(many[3]!.size).toBe(Buffer.byteLength('乙乙'))
  })

  it('空列表返回空数组，不访问磁盘上不存在的根', async () => {
    expect(await fs.statMany([])).toEqual([])
    expect(await new WorkspaceFs(join(base, 'absent'), null).statMany(['memory/a.md'])).toEqual([null])
  })

  it('父目录是链接时整批拒绝，不返回链接另一侧的指纹', async () => {
    const other = join(base, 'other')
    await mkdir(join(other, 'archive'), { recursive: true })
    await writeFile(join(other, 'archive', 'old.md'), '兄弟剧情的事实')
    await rm(join(root, 'memory'), { recursive: true })
    await symlink(other, join(root, 'memory'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(fs.statMany(['memory/archive/old.md'])).rejects.toBeInstanceOf(WorkspaceLinkError)
    await expect(fs.statMany(['index.json', 'memory/archive/old.md'])).rejects.toBeInstanceOf(WorkspaceLinkError)
  })

  it('文件本身是链接时拒绝', async (context) => {
    await writeFile(join(base, 'outside.md'), '工作区外的文件')
    if (!await tryFileLink(join(base, 'outside.md'), join(root, 'memory', 'link.md'))) context.skip('当前环境不能创建文件链接')
    await expect(fs.statMany(['memory/a.md', 'memory/link.md'])).rejects.toBeInstanceOf(WorkspaceLinkError)
    await expect(fs.stat('memory/link.md')).rejects.toBeInstanceOf(WorkspaceLinkError)
  })

  it('越出工作区的路径拒绝', async () => {
    await expect(fs.statMany(['memory/a.md', '../outside.md'])).rejects.toThrow('工作区路径越界')
  })
})

describe('listStats', () => {
  it('只列本层文件，指纹与逐个 stat 相同', async () => {
    const listed = await fs.listStats('memory')
    expect(listed.map((item) => item.name)).toEqual(['a.md', 'b.md'])
    for (const item of listed) {
      expect({ mtimeMs: item.mtimeMs, size: item.size }).toEqual(await fs.stat(`memory/${item.name}`))
    }
    expect(await fs.listStats('nowhere')).toEqual([])
  })

  it('本层的链接条目照旧跳过，其余文件不受影响', async (context) => {
    await writeFile(join(base, 'outside.md'), '工作区外的文件')
    if (!await tryFileLink(join(base, 'outside.md'), join(root, 'memory', 'link.md'))) context.skip('当前环境不能创建文件链接')
    expect((await fs.listStats('memory')).map((item) => item.name)).toEqual(['a.md', 'b.md'])
  })

  it('目录本身是链接时拒绝', async () => {
    const other = join(base, 'other')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'foreign.md'), '兄弟剧情的事实')
    await rm(join(root, 'memory'), { recursive: true })
    await symlink(other, join(root, 'memory'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(fs.listStats('memory')).rejects.toBeInstanceOf(WorkspaceLinkError)
  })
})
