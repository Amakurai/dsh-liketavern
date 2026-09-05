/**
 * 事务层（WAL）单元测试。
 * 覆盖：begin→record→commit 磁盘形态、同层快照去重、单楼层回滚（改/删/最初内容）、
 * 多楼层逆序撤销（含 session turn 的 t1/t2/t10 数字排序）、回滚目录保留与
 * listFloors 标记、重复回滚抛错、prune 过期清理、appendFile 失败后重试仍留下 before 镜像、
 * records.jsonl 单行损坏跳过（坏行不阻断 rollbackAfter 的后续楼层）、人工编辑冲突保护与
 * 历史二进制标记兼容。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { floorNamesForLineageRollback, floorNamesForRollback } from '../src/node/floors.js'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

/** 注入式磁盘故障开关：置 true 后下一次 appendFile 抛错并自动复位。 */
const diskFault = vi.hoisted(() => ({ failNextAppend: false }))

// 只包 appendFile，其余 node:fs/promises 导出照原样透传（测试自身也要用 mkdtemp/readFile 等）
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    default: actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      if (diskFault.failNextAppend) {
        diskFault.failNextAppend = false
        throw new Error('appendFile 失败（测试注入）')
      }
      return actual.appendFile(...args)
    },
  }
})

let root: string
let workspace: string
let walDir: string
let wal: Wal

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wal-test-'))
  workspace = join(root, 'workspace')
  walDir = join(root, 'state', 'wal')
  await mkdir(workspace, { recursive: true })
  wal = new Wal(walDir)
})

afterEach(async () => {
  diskFault.failNextAppend = false
  await rm(root, { recursive: true, force: true })
})

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function readJson(p: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>
}

async function readLines(p: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(p, 'utf8')
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** 找到 <sanitized>.rolled-back-* 目录名。 */
async function rolledBackDirName(sanitized: string): Promise<string | undefined> {
  const names = await readdir(walDir)
  return names.find((n) => n.startsWith(`${sanitized}.rolled-back-`))
}

describe('Wal', () => {
  it('begin → record → commit：磁盘上的文件形态', async () => {
    await wal.beginFloor('floor/1') // 含非法字符，目录名净化为 floor_1
    const dir = join(walDir, 'floor_1')

    const meta = await readJson(join(dir, 'meta.json'))
    expect(meta.floor).toBe('floor/1')
    expect(meta.committed).toBe(false)
    expect(typeof meta.startedAt).toBe('string')

    await wal.record('floor/1', 'memory/a.md', null)
    await wal.record('floor/1', 'index.json', '{"v":1}')

    const lines = await readLines(join(dir, 'records.jsonl'))
    expect(lines).toEqual([
      { seq: 1, path: 'memory/a.md', before: null },
      { seq: 2, path: 'index.json', before: '{"v":1}' },
    ])

    await wal.commitFloor('floor/1')
    const committed = await readJson(join(dir, 'meta.json'))
    expect(committed.committed).toBe(true)
    expect(typeof committed.committedAt).toBe('string')
  })

  it('已存在且未 commit 的同名单元再次 begin 报错', async () => {
    await wal.beginFloor('f1')
    await expect(wal.beginFloor('f1')).rejects.toThrow(/已存在且未提交/)
    // 已提交的同名单元允许重新开始（旧记录清空）
    await wal.commitFloor('f1')
    await expect(wal.beginFloor('f1')).resolves.toBeUndefined()
    expect(await readLines(join(walDir, 'f1', 'records.jsonl'))).toEqual([])
  })

  it('同层同路径重复 record 只保留首次快照', async () => {
    await wal.beginFloor('f1')
    await wal.record('f1', 'a.md', 'first')
    await wal.record('f1', 'a.md', 'second') // 忽略
    await wal.record('f1', 'sub\\b.md', 'win-path') // 反斜杠归一化为正斜杠
    const lines = await readLines(join(walDir, 'f1', 'records.jsonl'))
    expect(lines).toEqual([
      { seq: 1, path: 'a.md', before: 'first' },
      { seq: 2, path: 'sub/b.md', before: 'win-path' },
    ])
  })

  it('rollbackFloor 恢复被改文件、删除新建文件、恢复多次修改的最初内容', async () => {
    await writeFile(join(workspace, 'mem.md'), 'v1')
    await wal.beginFloor('f1')
    // 楼层内：mem.md 被改两次（第二次 record 应被忽略，回滚须回到 v1）
    await wal.record('f1', 'mem.md', 'v1')
    await writeFile(join(workspace, 'mem.md'), 'v2')
    await wal.record('f1', 'mem.md', 'v2')
    await writeFile(join(workspace, 'mem.md'), 'v3')
    // 楼层内新建的文件
    await wal.record('f1', 'new.md', null)
    await writeFile(join(workspace, 'new.md'), 'created')
    // 写回时父目录不存在：回放前需先创建
    await wal.record('f1', 'sub/deep.md', 'deep-before')

    const restored = await wal.rollbackFloor('f1', workspace)

    expect(await readFile(join(workspace, 'mem.md'), 'utf8')).toBe('v1')
    expect(await exists(join(workspace, 'new.md'))).toBe(false)
    expect(await readFile(join(workspace, 'sub', 'deep.md'), 'utf8')).toBe('deep-before')
    expect(restored).toEqual(['sub/deep.md', 'new.md', 'mem.md']) // 逆序回放
  })

  it('对不存在或已回滚的楼层回滚抛错', async () => {
    await expect(wal.rollbackFloor('nope', workspace)).rejects.toThrow(/不存在/)
    await wal.beginFloor('f1')
    await wal.rollbackFloor('f1', workspace)
    await expect(wal.rollbackFloor('f1', workspace)).rejects.toThrow(/已回滚/)
  })

  it('rollbackAfter 按传入顺序的逆序撤销多个楼层', async () => {
    await writeFile(join(workspace, 'a.md'), 'v1')
    // f1：a.md v1 → v2；f2：a.md v2 → v3；f3：新建 b.md
    await wal.beginFloor('f1')
    await wal.record('f1', 'a.md', 'v1')
    await writeFile(join(workspace, 'a.md'), 'v2')
    await wal.commitFloor('f1')

    await wal.beginFloor('f2')
    await wal.record('f2', 'a.md', 'v2')
    await writeFile(join(workspace, 'a.md'), 'v3')
    await wal.commitFloor('f2')

    await wal.beginFloor('f3')
    await wal.record('f3', 'b.md', null)
    await writeFile(join(workspace, 'b.md'), 'created')
    await wal.commitFloor('f3')

    const result = await wal.rollbackAfter(['f1', 'f2', 'f3'], workspace)
    expect(result.skipped).toEqual([])
    expect(result.restored).toEqual(['b.md', 'a.md', 'a.md']) // 逆序：f3 → f2 → f1
    expect(await readFile(join(workspace, 'a.md'), 'utf8')).toBe('v1')
    expect(await exists(join(workspace, 'b.md'))).toBe(false)
  })

  it('session 的 t1/t2/t10 先数字升序再由 rollbackAfter 逆放，最终恢复最初状态', async () => {
    const sessionId = 'session-a'
    await writeFile(join(workspace, 'state.txt'), 'v0')
    for (const [turn, before, after] of [
      [1, 'v0', 'v1'],
      [2, 'v1', 'v2'],
      [10, 'v2', 'v10'],
    ] as const) {
      const floor = `${sessionId}#t${turn}`
      await wal.beginFloor(floor)
      await wal.record(floor, 'state.txt', before)
      await writeFile(join(workspace, 'state.txt'), after)
      await wal.commitFloor(floor)
    }

    const names = floorNamesForRollback(
      (await wal.listFloors()).map((floor) => floor.floor),
      sessionId,
      1,
    )
    expect(names).toEqual([`${sessionId}#t1`, `${sessionId}#t2`, `${sessionId}#t10`])
    await wal.rollbackAfter(names, workspace)
    expect(await readFile(join(workspace, 'state.txt'), 'utf8')).toBe('v0')
  })

  it('跨 fork 祖先楼层按剧情 turn 逆放，恢复到祖先目标楼层之前', async () => {
    await writeFile(join(workspace, 'state.txt'), 'v0')
    for (const [floor, before, after] of [
      ['root#t1', 'v0', 'v1'],
      ['root#t2', 'v1', 'v2'],
      ['child#t3', 'v2', 'v3'],
      ['current#t4', 'v3', 'v4'],
    ] as const) {
      await wal.beginFloor(floor)
      await wal.record(floor, 'state.txt', before)
      await writeFile(join(workspace, 'state.txt'), after)
      await wal.commitFloor(floor)
    }
    const names = floorNamesForLineageRollback(
      (await wal.listFloors()).map((floor) => floor.floor),
      { walLineage: [{ sessionId: 'root', throughTurn: 2 }, { sessionId: 'child', throughTurn: 3 }] },
      'current',
      2,
    )
    expect(names).toEqual(['root#t2', 'child#t3', 'current#t4'])
    await wal.rollbackAfter(names, workspace)
    expect(await readFile(join(workspace, 'state.txt'), 'utf8')).toBe('v1')
  })

  it('rollbackAfter 跳过已不存在的楼层并记入 skipped', async () => {
    await wal.beginFloor('f1')
    await wal.record('f1', 'x.md', null)
    await writeFile(join(workspace, 'x.md'), 'created')

    const result = await wal.rollbackAfter(['gone', 'f1'], workspace)
    expect(result.skipped).toEqual(['gone'])
    expect(result.restored).toEqual(['x.md'])
    expect(await exists(join(workspace, 'x.md'))).toBe(false)
  })

  it('整批 WAL 提前校验：任一行损坏均拒绝，所有正文保持不变', async () => {
    await writeFile(join(workspace, 'a.md'), 'v1')
    await wal.beginFloor('f1')
    await wal.record('f1', 'a.md', 'v1')
    await writeFile(join(workspace, 'a.md'), 'v2')
    await wal.commitFloor('f1')

    await wal.beginFloor('f2')
    await wal.record('f2', 'b.md', null)
    await writeFile(join(workspace, 'b.md'), 'created')
    await wal.commitFloor('f2')

    // f1 的 records.jsonl 尾部混进一行坏 JSON（模拟写盘半途断电）
    const recordsPath = join(walDir, 'f1', 'records.jsonl')
    await writeFile(recordsPath, (await readFile(recordsPath, 'utf8')) + '{"seq":2,"path":"ghost.md",\n', 'utf8')

    await expect(wal.rollbackAfter(['f1', 'f2'], workspace)).rejects.toThrow('WAL 记录损坏')
    expect(await readFile(join(workspace, 'a.md'), 'utf8')).toBe('v2')
    expect(await readFile(join(workspace, 'b.md'), 'utf8')).toBe('created')
    expect((await wal.listFloors()).every((f) => !f.rolledBack)).toBe(true)
  })

  it('元数据损坏也必须在整批回滚前拒绝，不静默隐藏楼层', async () => {
    await wal.beginFloor('f1')
    await wal.record('f1', 'a.md', null)
    await writeFile(join(workspace, 'a.md'), '保留')
    await writeFile(join(walDir, 'f1', 'meta.json'), '{broken')
    await expect(wal.rollbackAfter(['f1'], workspace)).rejects.toThrow('WAL 元数据损坏')
    expect(await readFile(join(workspace, 'a.md'), 'utf8')).toBe('保留')
  })

  it('已回滚目录保留于磁盘且 listFloors 标记 rolledBack', async () => {
    await wal.beginFloor('f1')
    await wal.record('f1', 'a.md', null)
    await wal.commitFloor('f1')
    await wal.rollbackFloor('f1', workspace)

    const rolledBack = await rolledBackDirName('f1')
    expect(rolledBack).toBeDefined()
    // 回滚目录内仍保留 records.jsonl 供调试
    expect(await exists(join(walDir, rolledBack!, 'records.jsonl'))).toBe(true)

    const floors = await wal.listFloors()
    expect(floors).toHaveLength(1)
    expect(floors[0]).toMatchObject({ floor: 'f1', committed: true, rolledBack: true })
  })

  it('prune 删除过期回滚目录，保留近期与活跃目录', async () => {
    await wal.beginFloor('old')
    await wal.rollbackFloor('old', workspace)
    await wal.beginFloor('recent')
    await wal.rollbackFloor('recent', workspace)
    await wal.beginFloor('active')

    // 把 old 的回滚时间改为 10 天前
    const oldDir = join(walDir, (await rolledBackDirName('old'))!)
    const metaPath = join(oldDir, 'meta.json')
    const meta = await readJson(metaPath)
    meta.rolledBackAt = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString()
    await writeFile(metaPath, JSON.stringify(meta))

    const removed = await wal.prune({ keepRolledBackDays: 7 })
    expect(removed).toBe(1)
    expect(await exists(oldDir)).toBe(false)
    expect(await rolledBackDirName('recent')).toBeDefined()
    expect(await exists(join(walDir, 'active'))).toBe(true)

    // 默认 7 天：recent 不到期，不删
    expect(await wal.prune({})).toBe(0)
  })

  it('record 落盘失败不污染内存状态：重试仍写下 before 镜像，回滚可还原', async () => {
    await writeFile(join(workspace, 'mem.md'), 'v1')
    await wal.beginFloor('f1')

    diskFault.failNextAppend = true
    await expect(wal.record('f1', 'mem.md', 'v1')).rejects.toThrow(/测试注入/)

    // 重试同一路径：不能被「同层同路径只留首次快照」的快路径吞掉
    await wal.record('f1', 'mem.md', 'v1')
    await writeFile(join(workspace, 'mem.md'), 'v2')

    // seq 也不能因失败的那次而跳号
    expect(await readLines(join(walDir, 'f1', 'records.jsonl'))).toEqual([
      { seq: 1, path: 'mem.md', before: 'v1' },
    ])

    await wal.rollbackFloor('f1', workspace)
    expect(await readFile(join(workspace, 'mem.md'), 'utf8')).toBe('v1')
  })

  it('WorkspaceFs 无当前楼层时写入不走 WAL，不抛 non-floor', async () => {
    const wfs = new WorkspaceFs(workspace, wal)
    await expect(wfs.writeText('index.json', '{}\n')).resolves.toBeUndefined()
    expect(await readFile(join(workspace, 'index.json'), 'utf8')).toBe('{}\n')
    await expect(wfs.writeBytes('a.bin', new Uint8Array([1, 2]))).resolves.toBeUndefined()
    // 未 beginFloor：不会创建 non-floor 单元
    const names = await readdir(walDir).catch(() => [] as string[])
    expect(names.some((n) => n === 'non-floor' || n.startsWith('non-floor'))).toBe(false)
  })

  it('并发调用经队列串行化，记录不丢失且 seq 单调', async () => {
    await wal.beginFloor('f1')
    await Promise.all([
      wal.record('f1', 'a.md', '1'),
      wal.record('f1', 'b.md', null),
      wal.record('f1', 'a.md', 'ignored'), // 串行化后落在 a.md 首次快照之后，被忽略
      wal.commitFloor('f1'),
    ])
    const lines = await readLines(join(walDir, 'f1', 'records.jsonl'))
    expect(lines).toEqual([
      { seq: 1, path: 'a.md', before: '1' },
      { seq: 2, path: 'b.md', before: null },
    ])
    const meta = await readJson(join(walDir, 'f1', 'meta.json'))
    expect(meta.committed).toBe(true)
  })

  it('writeBytes 二进制写入经 WAL 快照：回滚恢复原字节、删除新建文件', async () => {
    // 导入期写入（wal 传 null）不留快照
    await new WorkspaceFs(workspace, null).writeBytes('avatar.png', new Uint8Array([0x89, 0x50, 0xff]))
    const wfs = new WorkspaceFs(workspace, wal)
    await wfs.beginFloor('f1')
    await wfs.writeBytes('avatar.png', new Uint8Array([1, 2, 3, 4])) // 覆盖已有二进制
    await wfs.writeBytes('new.bin', new Uint8Array([9])) // 楼层内新建
    await wfs.commitFloor()
    expect(new Uint8Array(await readFile(join(workspace, 'avatar.png')))).toEqual(new Uint8Array([1, 2, 3, 4]))

    await wal.rollbackFloor('f1', workspace)
    expect(new Uint8Array(await readFile(join(workspace, 'avatar.png')))).toEqual(new Uint8Array([0x89, 0x50, 0xff]))
    expect(await exists(join(workspace, 'new.bin'))).toBe(false)
  })

  it('delete 二进制文件的快照与 writeBytes 对称：回滚恢复原字节而非有损转码', async () => {
    // 非 UTF-8 字节序列（0x89 0x50 0xff 单独出现不是合法 UTF-8）：按文本记快照会被替换成 U+FFFD
    const original = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x01])
    await new WorkspaceFs(workspace, null).writeBytes('avatar.png', original)
    const wfs = new WorkspaceFs(workspace, wal)
    await wfs.beginFloor('f1')
    await wfs.delete('avatar.png')
    await wfs.commitFloor()
    expect(await exists(join(workspace, 'avatar.png'))).toBe(false)

    await wal.rollbackFloor('f1', workspace)
    expect(new Uint8Array(await readFile(join(workspace, 'avatar.png')))).toEqual(original)
  })

  it('delete 文本文件仍按原文记快照（回滚恢复内容）', async () => {
    const wfs = new WorkspaceFs(workspace, wal)
    await wfs.writeText('journal.md', '第一版正文\n第二行')
    await wfs.beginFloor('f1')
    await wfs.delete('journal.md')
    await wfs.commitFloor()
    const records = await readLines(join(walDir, 'f1', 'records.jsonl'))
    expect(records[0]).toMatchObject({ path: 'journal.md', before: '第一版正文\n第二行' })

    await wal.rollbackFloor('f1', workspace)
    expect(await readFile(join(workspace, 'journal.md'), 'utf8')).toBe('第一版正文\n第二行')
  })

  it('回滚前发现楼层外修改时保留人工编辑', async () => {
    const wfs = new WorkspaceFs(workspace, wal)
    await wfs.writeText('journal.md', '原始内容')
    await wfs.beginFloor('f1')
    await wfs.writeText('journal.md', '模型写入')

    // 面板使用无楼层文件面，编辑发生在模型写入之后。
    await new WorkspaceFs(workspace, null).writeText('journal.md', '面板修订')
    await wfs.commitFloor()
    await wal.rollbackFloor('f1', workspace)

    expect(await readFile(join(workspace, 'journal.md'), 'utf8')).toBe('面板修订')
  })

  it('普通文本以历史二进制标记开头时仍按 UTF-8 恢复', async () => {
    const markerText = 'binary-base64:SGVsbG8='
    const plain = new WorkspaceFs(workspace, null)
    await plain.writeText('marker.txt', markerText)
    const wfs = new WorkspaceFs(workspace, wal)
    await wfs.beginFloor('f1')
    await wfs.writeText('marker.txt', 'changed')
    await wfs.commitFloor()
    await wal.rollbackFloor('f1', workspace)

    expect(await readFile(join(workspace, 'marker.txt'), 'utf8')).toBe(markerText)
  })

  it('delete 不存在的文件不记快照（无楼层时也不抛）', async () => {
    const wfs = new WorkspaceFs(workspace, wal)
    await wfs.beginFloor('f1')
    await wfs.delete('missing.md')
    await wfs.commitFloor()
    // 没有任何 record，records.jsonl 根本不会被创建
    expect(await exists(join(walDir, 'f1', 'records.jsonl'))).toBe(false)

    const plain = new WorkspaceFs(workspace, null)
    await expect(plain.delete('missing.md')).resolves.toBeUndefined()
  })
})

describe('WorkspaceFs.list / listStats', () => {
  it('list 默认递归，recursive: false 只列本层文件', async () => {
    const fs = new WorkspaceFs(workspace, null)
    await fs.writeText('memory/a.md', 'a')
    await fs.writeText('memory/b.md', 'b')
    await fs.writeText('memory/archive/old.md', 'old')

    expect(await fs.list('memory')).toEqual(['a.md', 'archive/old.md', 'b.md'])
    expect(await fs.list('memory', { recursive: false })).toEqual(['a.md', 'b.md'])
  })

  it('listStats 只列本层文件并带 mtime/size；内容变化后指纹随之变化', async () => {
    const fs = new WorkspaceFs(workspace, null)
    await fs.writeText('memory/a.md', 'hello')
    await fs.writeText('memory/archive/old.md', 'old')

    const before = await fs.listStats('memory')
    expect(before.map((f) => f.name)).toEqual(['a.md'])
    expect(before[0]!.size).toBe(5)
    expect(before[0]!.mtimeMs).toBeGreaterThan(0)

    await fs.writeText('memory/a.md', 'hello world')
    const after = await fs.listStats('memory')
    expect(after[0]!.size).toBe(11)
  })

  it('list / listStats 对不存在的目录返回空数组', async () => {
    const fs = new WorkspaceFs(workspace, null)
    expect(await fs.list('nope')).toEqual([])
    expect(await fs.listStats('nope')).toEqual([])
  })
})
