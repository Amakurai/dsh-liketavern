/**
 * 批量文件操作（WorkspaceFs.readTextMany / writeTextMany / copyFrom 与 Wal.recordChanges）的行为回归：
 * 真实文件系统上结果与逐个操作相同，日志仍先于正文；链接、越界、超限与重复路径明确拒绝。
 */
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs, WorkspaceLinkError, WorkspaceSizeError } from '../src/state/workspaceFs.js'

let base: string
let root: string
let wal: Wal
let fs: WorkspaceFs

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'tavern-fs-batch-'))
  root = join(base, 'story')
  await mkdir(join(root, 'data', 'aa'), { recursive: true })
  await writeFile(join(root, 'data', 'aa', 'one.json'), '甲')
  await writeFile(join(root, 'data', 'two.json'), '乙乙')
  wal = new Wal(join(root, 'state', 'wal'))
  fs = new WorkspaceFs(root, wal)
})
afterEach(async () => { vi.restoreAllMocks(); await rm(base, { recursive: true, force: true }) })

const records = async (floor: string): Promise<Array<{ seq: number; path: string; before: string | null; after: string | null }>> =>
  (await readFile(join(root, 'state', 'wal', floor, 'records.jsonl'), 'utf8')).trim().split('\n').map((line) => JSON.parse(line))

describe('readTextMany', () => {
  it('顺序与入参一致，缺失文件与缺失目录为 null，结果与逐个读取相同', async () => {
    const paths = ['data/two.json', 'data/missing.json', 'data/aa/one.json', 'nowhere/x.json', 'data/two.json']
    const many = await fs.readTextMany(paths)
    expect(many).toEqual(['乙乙', null, '甲', null, '乙乙'])
    for (const [index, path] of paths.entries()) expect(many[index], path).toBe(await fs.readText(path))
    expect(await fs.readTextMany([])).toEqual([])
  })

  it('超过调用方上限的文件不读取，整批以体积错误拒绝', async () => {
    await writeFile(join(root, 'data', 'big.json'), 'x'.repeat(4096))
    await expect(fs.readTextMany(['data/two.json', 'data/big.json'], 1024)).rejects.toBeInstanceOf(WorkspaceSizeError)
    expect(await fs.readTextMany(['data/two.json', 'data/big.json'], 4096)).toEqual(['乙乙', 'x'.repeat(4096)])
  })

  it('父目录是链接或路径越界时拒绝，不返回另一侧的内容', async () => {
    const other = join(base, 'other')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'one.json'), '兄弟剧情的数据')
    await rm(join(root, 'data', 'aa'), { recursive: true })
    await symlink(other, join(root, 'data', 'aa'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(fs.readTextMany(['data/two.json', 'data/aa/one.json'])).rejects.toBeInstanceOf(WorkspaceLinkError)
    await expect(fs.readTextMany(['../outside.json'])).rejects.toThrow('工作区路径越界')
  })
})

describe('writeTextMany', () => {
  it('一批写入只追加一次楼层日志，序号连续且先于正文；回滚恢复原文并删除新建文件', async () => {
    await wal.beginFloor('s#t1')
    const append = vi.spyOn(wal, 'recordChanges')
    await fs.withFloor('s#t1').writeTextMany([['data/aa/one.json', '改'], ['data/new/three.json', '丙'], ['data/four.json', '丁']])
    expect(append).toHaveBeenCalledTimes(1)
    expect((await records('s_t1')).map(({ seq, path, before, after }) => ({ seq, path, before, after }))).toEqual([
      { seq: 1, path: 'data/aa/one.json', before: '甲', after: '改' },
      { seq: 2, path: 'data/new/three.json', before: null, after: '丙' },
      { seq: 3, path: 'data/four.json', before: null, after: '丁' },
    ])
    expect(await fs.readTextMany(['data/aa/one.json', 'data/new/three.json', 'data/four.json'])).toEqual(['改', '丙', '丁'])
    // 同层继续单条写入时序号接着批量记录往后排。
    await fs.withFloor('s#t1').writeText('data/two.json', '续')
    expect((await records('s_t1')).at(-1)).toMatchObject({ seq: 4, path: 'data/two.json', before: '乙乙', after: '续' })
    await wal.commitFloor('s#t1')
    await wal.rollbackFloor('s#t1', root)
    expect(await fs.readTextMany(['data/aa/one.json', 'data/new/three.json', 'data/four.json', 'data/two.json'])).toEqual(['甲', null, null, '乙乙'])
  })

  it('日志写不进去时任何正文都不改动', async () => {
    // 楼层尚未开始：记录阶段失败，必须发生在第一个正文替换之前。
    await expect(fs.withFloor('s#t9').writeTextMany([['data/aa/one.json', '改'], ['data/five.json', '戊']])).rejects.toThrow(/未开始/)
    expect(await fs.readTextMany(['data/aa/one.json', 'data/five.json'])).toEqual(['甲', null])
  })

  it('没有楼层时照常落盘、不记日志；重复路径与空批次分别拒绝和忽略', async () => {
    await fs.writeTextMany([['data/aa/one.json', '直写'], ['data/six.json', '己']])
    expect(await fs.readTextMany(['data/aa/one.json', 'data/six.json'])).toEqual(['直写', '己'])
    expect(await fs.exists('state/wal')).toBe(false)
    await expect(fs.writeTextMany([['data/dup.json', 'a'], ['data/./dup.json', 'b']])).rejects.toThrow(/重复路径/)
    expect(await fs.exists('data/dup.json')).toBe(false)
    await fs.writeTextMany([])
  })

  it('目标目录是链接时整批拒绝，另一侧不被写入', async () => {
    const other = join(base, 'other')
    await mkdir(other, { recursive: true })
    await rm(join(root, 'data', 'aa'), { recursive: true })
    await symlink(other, join(root, 'data', 'aa'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(fs.writeTextMany([['data/seven.json', '庚'], ['data/aa/escape.json', '越界']])).rejects.toBeInstanceOf(WorkspaceLinkError)
    await expect(readFile(join(other, 'escape.json'), 'utf8')).rejects.toThrow()
    expect(await fs.exists('data/seven.json')).toBe(false)
  })
})

describe('Wal.recordChanges', () => {
  it('空批次不产生日志；损坏的既有日志使整批追加失败且不留下半批记录', async () => {
    await wal.beginFloor('s#t1')
    await wal.recordChanges('s#t1', [])
    expect(await fs.exists('state/wal/s_t1/records.jsonl')).toBe(false)
    await wal.recordChange('s#t1', 'data/two.json', '乙乙', '新', 'utf8', 'utf8')
    const file = join(root, 'state', 'wal', 's_t1', 'records.jsonl')
    const broken = await readFile(file, 'utf8') + '{broken\n'
    await writeFile(file, broken)
    await expect(wal.recordChanges('s#t1', [
      { path: 'data/a.json', before: null, after: 'a', beforeEncoding: 'utf8', afterEncoding: 'utf8' },
      { path: 'data/b.json', before: null, after: 'b', beforeEncoding: 'utf8', afterEncoding: 'utf8' },
    ])).rejects.toThrow(/WAL 记录损坏/)
    expect(await readFile(file, 'utf8')).toBe(broken)
  })
})

describe('copyFrom', () => {
  it('按相同相对路径复制普通文件，来源缺失的跳过，目录来源以调用方的错误拒绝', async () => {
    const draft = new WorkspaceFs(join(base, 'draft'), null)
    await draft.copyFrom(fs, ['data/aa/one.json', 'data/missing.json', 'data/two.json'], (path) => new Error(`拒绝 ${path}`))
    expect(await draft.readTextMany(['data/aa/one.json', 'data/missing.json', 'data/two.json'])).toEqual(['甲', null, '乙乙'])
    await expect(draft.copyFrom(fs, ['data/two.json', 'data/aa'], (path) => new Error(`拒绝 ${path}`))).rejects.toThrow('拒绝 data/aa')
  })

  it('来源父目录是链接时拒绝；带楼层的工作区不能用它绕过日志', async () => {
    const other = join(base, 'other')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'one.json'), '兄弟剧情的数据')
    await rm(join(root, 'data', 'aa'), { recursive: true })
    await symlink(other, join(root, 'data', 'aa'), process.platform === 'win32' ? 'junction' : 'dir')
    const draft = new WorkspaceFs(join(base, 'draft'), null)
    await expect(draft.copyFrom(fs, ['data/aa/one.json'], (path) => new Error(path))).rejects.toBeInstanceOf(WorkspaceLinkError)
    expect(await draft.exists('data/aa/one.json')).toBe(false)
    await wal.beginFloor('s#t1')
    await expect(fs.withFloor('s#t1').copyFrom(draft, ['data/two.json'], (path) => new Error(path))).rejects.toThrow(/不记录楼层快照/)
  })
})
