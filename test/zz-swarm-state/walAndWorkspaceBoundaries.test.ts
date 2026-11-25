/**
 * 状态层边界与热路径回归测试（WAL 目录碰撞、重复楼层批量回滚、恢复写屏障租约与工作区隔离、
 * WorkspaceFs 冒号/尾点空白保留路径防护、siblings 原地修改落盘与链接拒绝、预设大顺序栈溢出防护、记忆别名缓存复用）。
 */
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { MemoryStore } from '../../src/state/memory.js'
import { parseStPreset } from '../../src/state/presetStore.js'
import { appendSiblingFork, loadSiblingForks, mutateSiblingForks } from '../../src/state/siblings.js'
import { Wal, WAL_COVERAGE_PATH } from '../../src/state/wal.js'
import {
  isReservedWalPath,
  WAL_RECOVERY_PATH,
  withRecoveryWriteAccess,
  WorkspaceFs,
  WorkspaceLinkError,
  WORKSPACE_RECOVERING_MESSAGE,
} from '../../src/state/workspaceFs.js'
import { closeLedger } from '../../src/state/writeLedger.js'

const tempRoots: string[] = []

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  tempRoots.push(dir)
  return dir
}

afterEach(async () => {
  while (tempRoots.length > 0) {
    const dir = tempRoots.pop()!
    closeLedger(dir, { prefix: true })
    await rm(dir, { recursive: true, force: true })
  }
})

async function createRecoveringWorkspace(root: string, floor = 's1#t1'): Promise<WorkspaceFs> {
  const wal = new Wal(join(root, 'state', 'wal'))
  const fs = new WorkspaceFs(root, wal)
  await wal.beginFloor(floor)
  await fs.withFloor(floor).writeText('journal.md', 'v1')
  await wal.commitFloor(floor)
  const dirName = floor.replace(/[^A-Za-z0-9_.-]/g, '_')
  await writeFile(
    join(root, 'state', 'wal', dirName, 'rollback-progress.json'),
    JSON.stringify({ hash: '0'.repeat(64), next: 0, restored: [], preserved: [] }),
    'utf8',
  )
  await writeFile(
    join(root, WAL_RECOVERY_PATH),
    JSON.stringify({ version: 1, floors: [floor], dirs: [dirName], walDir: join(root, 'state', 'wal') }) + '\n',
    'utf8',
  )
  return new WorkspaceFs(root, null)
}

describe('withRecoveryWriteAccess 工作区隔离与租约生命周期', () => {
  it('仅放行目标恢复工作区，不跨工作区穿透其它恢复中目录，且退出后延迟回调立即失去写权限', async () => {
    const rootA = await makeTempDir('tavern-rec-scope-a-')
    const rootB = await makeTempDir('tavern-rec-scope-b-')
    const fsA = await createRecoveringWorkspace(rootA, 'sa#t1')
    const fsB = await createRecoveringWorkspace(rootB, 'sb#t1')

    let escapedWrite!: () => Promise<void>
    await withRecoveryWriteAccess(rootA, async () => {
      await expect(fsA.writeText('journal.md', 'recovered-a')).resolves.toBeUndefined()
      // 同一异步调用链内对另一恢复中工作区的写入仍必须被拦截
      await expect(fsB.writeText('journal.md', 'bypass-b')).rejects.toThrow(WORKSPACE_RECOVERING_MESSAGE)
      escapedWrite = () => fsA.writeText('journal.md', 'late-after-lease')
    })

    // 离开 withRecoveryWriteAccess 后租约已失效，恢复标记仍在时不得继续写入
    await expect(escapedWrite()).rejects.toThrow(WORKSPACE_RECOVERING_MESSAGE)
    expect(await fsA.readText('journal.md')).toBe('recovered-a')
    expect(await fsB.readText('journal.md')).toBe('v1')
  })
})

describe('WorkspaceFs 路径边界与批量复制守卫', () => {
  it('拒绝含空字节或冒号（Windows 盘符相对路径与 NTFS 备用数据流）的路径，并拦截尾点空白保留 WAL 路径', async () => {
    const root = await makeTempDir('tavern-fs-ads-')
    const wal = new Wal(join(root, 'state', 'wal'))
    await wal.beginFloor('s#t1')
    const plain = new WorkspaceFs(root, null)
    const scoped = new WorkspaceFs(root, wal).withFloor('s#t1')
    await plain.writeText('card.json', '{"name":"Alice"}\n')

    for (const unsafe of ['card.json::$DATA', 'memory/note.md:hidden', 'C:escape.txt', 'memory/bad\0name.md']) {
      await expect(plain.readText(unsafe)).rejects.toThrow(/工作区路径越界/)
      await expect(plain.writeText(unsafe, 'x')).rejects.toThrow(/工作区路径越界/)
      await expect(plain.delete(unsafe)).rejects.toThrow(/工作区路径越界/)
      await expect(scoped.writeText(unsafe, 'x')).rejects.toThrow(/工作区路径越界/)
    }

    for (const reservedAlias of [
      'state/wal-recovery.json ',
      'state/wal-coverage.json...',
      'state./wal/s_t1/records.jsonl',
      'state\\WAL-RECOVERY.JSON .',
    ]) {
      expect(isReservedWalPath(reservedAlias)).toBe(true)
      await expect(scoped.writeText(reservedAlias, '{}')).rejects.toThrow(/无法记录快照/)
      await expect(scoped.delete(reservedAlias)).rejects.toThrow(/无法记录快照/)
    }
  })

  it('copyFrom 空列表无副作用，且拒绝重复或大小写同目标路径的并发自竞争', async () => {
    const srcRoot = await makeTempDir('tavern-copy-src-')
    const dstRoot = await makeTempDir('tavern-copy-dst-')
    const src = new WorkspaceFs(srcRoot, null)
    const dst = new WorkspaceFs(dstRoot, null)
    await src.writeText('memory/a.md', 'fact-a')

    await expect(dst.copyFrom(src, [], (p) => new Error(p))).resolves.toBeUndefined()
    expect(await dst.readTextMany([])).toEqual([])

    await expect(dst.copyFrom(src, ['memory/a.md', './memory/a.md'], (p) => new Error(p))).rejects.toThrow(/重复路径/)
    if (process.platform === 'win32') {
      await expect(dst.copyFrom(src, ['memory/a.md', 'MEMORY/A.MD'], (p) => new Error(p))).rejects.toThrow(/重复路径/)
    }
  })
})

describe('WAL 目录名碰撞保护与重复楼层批量回滚', () => {
  it('清单中其它楼层映射到同一 WAL 目录且日志被清空时，拒绝以碰撞楼层 ID 覆盖目录；完成回滚后允许开层', async () => {
    const root = await makeTempDir('tavern-wal-collide-')
    const wal = new Wal(join(root, 'state', 'wal'))
    const fs = new WorkspaceFs(root, wal)

    // `a/1#t1` 与 `a:1#t1` 均净化为 `a_1_t1`
    await wal.beginFloor('a/1#t1')
    await fs.withFloor('a/1#t1').writeText('journal.md', '来自 a/1#t1')
    await wal.commitFloor('a/1#t1')

    const coverageBefore = await fs.readText(WAL_COVERAGE_PATH)
    const metaBackup = await readFile(join(root, 'state', 'wal', 'a_1_t1', 'meta.json'))
    const recordsBackup = await readFile(join(root, 'state', 'wal', 'a_1_t1', 'records.jsonl'))

    // 模拟 `a_1_t1` 内文件被外部清空只剩空目录：碰撞的 `a:1#t1` 不得把空目录当作崩溃遗留直接覆盖
    await rm(join(root, 'state', 'wal', 'a_1_t1', 'meta.json'))
    await rm(join(root, 'state', 'wal', 'a_1_t1', 'records.jsonl'))
    const restarted = new Wal(join(root, 'state', 'wal'))
    await expect(restarted.beginFloor('a:1#t1')).rejects.toThrow(/WAL 已登记楼层缺失或未完成回滚：a\/1#t1/)
    expect(await fs.readText(WAL_COVERAGE_PATH)).toBe(coverageBefore)
    expect(await readdir(join(root, 'state', 'wal', 'a_1_t1'))).toEqual([])

    // 恢复完整日志并正式回滚 `a/1#t1` 后，碰撞目录名上的新楼层 `a:1#t1` 可以正常开启
    await writeFile(join(root, 'state', 'wal', 'a_1_t1', 'meta.json'), metaBackup)
    await writeFile(join(root, 'state', 'wal', 'a_1_t1', 'records.jsonl'), recordsBackup)
    const cleanWal = new Wal(join(root, 'state', 'wal'))
    await cleanWal.rollbackFloor('a/1#t1', root)
    await expect(cleanWal.beginFloor('a:1#t1')).resolves.toBeUndefined()
    await fs.withFloor('a:1#t1').writeText('journal.md', '来自 a:1#t1')
    await cleanWal.commitFloor('a:1#t1')
    expect(await fs.readText('journal.md')).toBe('来自 a:1#t1')
  })

  it('rollbackAfter 含重复楼层 ID 时按实际执行位次预检记忆展开与后继依赖', async () => {
    const root = await makeTempDir('tavern-wal-dup-')
    const wal = new Wal(join(root, 'state', 'wal'))
    const fs = new WorkspaceFs(root, wal)
    const plainMemory = new MemoryStore(new WorkspaceFs(root, null))

    await wal.beginFloor('s#t1')
    const m1 = await new MemoryStore(fs.withFloor('s#t1')).write({ body: '第一层线索：银怀表', keys: ['银怀表'] })
    await fs.withFloor('s#t1').writeText('journal.md', '第一层笔记')
    await wal.commitFloor('s#t1')

    await wal.beginFloor('s#t2')
    const m2 = await new MemoryStore(fs.withFloor('s#t2')).write({ body: '第二层线索：红信封', keys: ['红信封'] })
    await fs.withFloor('s#t2').writeText('journal.md', '第二层笔记')
    await wal.commitFloor('s#t2')

    await plainMemory.mergeBatch([m1, m2], '银怀表与红信封摘要', 'compress')

    // ['s#t1', 's#t2', 's#t1'] 会先执行末尾的 s#t1（早于依赖它的 s#t2），预检必须拒绝且不改写磁盘
    await expect(wal.rollbackAfter(['s#t1', 's#t2', 's#t1'], root)).rejects.toThrow(/后继依赖/)
    expect(await fs.readText('journal.md')).toBe('第二层笔记')

    // ['s#t1', 's#t1', 's#t2', 's#t2'] 按逆序各执行一次，早先重复项记入 skipped，记忆摘要正常展开并撤销
    const res = await wal.rollbackAfter(['s#t1', 's#t1', 's#t2', 's#t2'], root)
    expect(res.skipped).toEqual(['s#t2', 's#t1'])
    expect(await fs.readText('journal.md')).toBeNull()
    expect(await plainMemory.list()).toEqual([])
  })
})

describe('siblings 原地修改持久化与链接防护', () => {
  it('mutateSiblingForks 在回调原地修改原数组并返回同一引用时仍能落盘，且拒绝符号链接', async () => {
    const root = await makeTempDir('tavern-siblings-inplace-')
    await appendSiblingFork(root, {
      parentSessionId: 'p1',
      turn: 1,
      childSessionId: 'c1',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    await appendSiblingFork(root, {
      parentSessionId: 'p1',
      turn: 1,
      childSessionId: 'c2',
      createdAt: '2026-01-01T00:00:01.000Z',
    })

    // 模拟读路径剪枝直接 splice 原数组并返回同一引用
    await mutateSiblingForks(root, (forks) => {
      const idx = forks.findIndex((f) => f.childSessionId === 'c1')
      if (idx >= 0) forks.splice(idx, 1)
      return forks
    })

    const reloaded = JSON.parse(await readFile(join(root, 'siblings.json'), 'utf8')) as Array<{ childSessionId: string }>
    expect(reloaded.map((f) => f.childSessionId)).toEqual(['c2'])
    expect((await loadSiblingForks(root)).map((f) => f.childSessionId)).toEqual(['c2'])

    // 把 siblings.json 换成外部文件链接时必须拒绝读取和覆盖
    const linkedRoot = await makeTempDir('tavern-siblings-link-')
    const outside = join(root, 'outside-siblings.json')
    await writeFile(outside, '[]\n', 'utf8')
    try {
      await symlink(outside, join(linkedRoot, 'siblings.json'))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') return
      throw error
    }
    await expect(loadSiblingForks(linkedRoot)).rejects.toBeInstanceOf(WorkspaceLinkError)
    await expect(mutateSiblingForks(linkedRoot, (forks) => forks)).rejects.toBeInstanceOf(WorkspaceLinkError)
  })
})

describe('presetStore 大型嵌套栈安全与 MemoryStore 别名写入缓存稳定性', () => {
  it('parseStPreset 处理十万项嵌套 prompt_order 不触发调用栈溢出，按业务上限报错，且优先 100001 跳过无关角色块', () => {
    const hugeFolder = {
      identifier: 'folder',
      enabled: true,
      items: Array.from({ length: 100_000 }, (_, i) => ({ identifier: `item-${i}`, enabled: true })),
    }
    // 非首选角色块即使含十万项，存在 100001 时直接跳过不展开
    const fast = parseStPreset({
      prompts: [{ identifier: 'main', content: 'hello' }],
      prompt_order: [
        { character_id: 999999, order: [hugeFolder] },
        { character_id: 100001, order: [{ identifier: 'main', enabled: true }] },
      ],
    })
    expect(fast.preset.entries.map((e) => e.identifier)).toEqual(['main'])

    // 100001 自身超限时抛业务上限错误而非 RangeError: Maximum call stack size exceeded
    expect(() =>
      parseStPreset({
        prompts: [{ identifier: 'main', content: 'hello' }],
        prompt_order: [{ character_id: 100001, order: [hugeFolder] }],
      }),
    ).toThrow(/prompt_order 条目数 100001 超过上限/)
  })

  it('MemoryStore.saveAliases 写 aliases.json 后保持活跃条目快照稳定且新别名立即参与检索', async () => {
    const root = await makeTempDir('tavern-mem-alias-stable-')
    const fs = new WorkspaceFs(root, null)
    const store = new MemoryStore(fs)

    const written = await store.write({ body: '止痛剂少了两箱', keys: ['仓库'] })
    await store.findSimilar('止痛剂少了两箱', ['仓库'])
    const activeIndexBefore = (store as unknown as { activeIndex: { synced: unknown } | null }).activeIndex
    expect(activeIndexBefore).not.toBeNull()

    expect(await store.search('偷药')).toEqual([])
    const candidates = await store.aliasCandidates(10)
    expect(candidates.map((c) => c.id)).toEqual([written.id])
    expect(await store.saveAliases([{ entry: candidates[0]!, aliases: ['偷药', '药品失窃'] }])).toBe(1)

    // 新别名立即在 search 中生效
    const hits = await store.search('偷药')
    expect(hits.map((h) => h.entry.id)).toEqual([written.id])

    // 仅写 aliases.json 不改变任何活跃 .md，去重索引复用的活跃快照引用保持同一个数组
    await store.findSimilar('止痛剂少了两箱', ['仓库'])
    const activeIndexAfter = (store as unknown as { activeIndex: { synced: unknown } | null }).activeIndex
    expect(activeIndexAfter?.synced).toBe(activeIndexBefore?.synced)
  })
})
