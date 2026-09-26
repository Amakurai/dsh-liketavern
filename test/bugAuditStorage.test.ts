/** 真实临时文件验证日志跨实例、异步锁生命周期、分支索引损坏及变化层边界，不使用用户数据。 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { appendSiblingFork, loadSiblingForks, mutateSiblingForks } from '../src/state/siblings.js'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { withWorkspaceLock } from '../src/state/workspaceLock.js'
import { WorldDeltaStore } from '../src/state/worlddelta.js'

let root: string
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'bug-audit-storage-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
const fork = (childSessionId: string) => ({ parentSessionId: 'parent', childSessionId, turn: 1, createdAt: '2026-01-01' })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it('同一楼层的多个 WAL 句柄交错写入后日志仍有效且完整回滚', async () => {
  const walA = new Wal(join(root, 'state/wal')), walB = new Wal(join(root, 'state/wal'))
  const fsA = new WorkspaceFs(root, walA).withFloor('s#t1'), fsB = new WorkspaceFs(root, walB).withFloor('s#t1')
  await walA.beginFloor('s#t1')
  await fsA.writeText('journal.md', '第一稿')
  await fsB.writeText('journal.md', '第二稿')
  await fsA.writeText('journal.md', '第三稿')
  await walB.commitFloor('s#t1')
  await expect(walA.validateFloor('s#t1')).resolves.toMatchObject({ committed: true })
  await walA.rollbackFloor('s#t1', root)
  expect(await fsA.readText('journal.md')).toBeNull()
})

it('多个 WAL 句柄并发追加不同路径时不覆盖日志记录', async () => {
  const handles = Array.from({ length: 8 }, () => new Wal(join(root, 'state/wal')))
  await handles[0]!.beginFloor('s#t1')
  await Promise.all(handles.map((wal, index) => wal.recordChange('s#t1', `memory/${index}.md`, null, '正文', 'utf8', 'utf8')))
  await handles[0]!.validateFloor('s#t1')
  const lines = (await readFile(join(root, 'state/wal/s_t1/records.jsonl'), 'utf8')).trim().split('\n')
  expect(lines).toHaveLength(handles.length)
  expect(new Set(lines.map(line => (JSON.parse(line) as { path: string }).path)).size).toBe(handles.length)
})

it('锁内注册但释放锁后才执行的回调不能继承已过期的写权限', async () => {
  const trigger = deferred(), holding = deferred(), release = deferred()
  const fs = new WorkspaceFs(root, null)
  await fs.writeText('journal.md', '初始')
  let delayed!: Promise<void>
  await withWorkspaceLock(root, async () => {
    delayed = trigger.promise.then(() => withWorkspaceLock(root, () => fs.writeText('journal.md', '延迟写入')))
  })
  const current = withWorkspaceLock(root, async () => {
    holding.resolve()
    await release.promise
    await fs.writeText('journal.md', '当前事务')
  })
  await holding.promise
  trigger.resolve()
  // 让已触发回调执行；即便 I/O 尚未完成，正确实现也必须在当前事务之后落盘。
  await new Promise<void>(done => setTimeout(done, 30))
  const during = await fs.readText('journal.md')
  release.resolve()
  await Promise.all([current, delayed])
  expect(during).toBe('初始')
  expect(await fs.readText('journal.md')).toBe('延迟写入')
})

it.each(['null', '{"parentSessionId":"parent"}', '[{"broken":true}]'])('有效 JSON 但损坏的分支索引 %s 不得被新增操作覆盖', async raw => {
  await writeFile(join(root, 'siblings.json'), raw)
  await expect(appendSiblingFork(root, fork('child'))).rejects.toThrow('损坏')
  expect(await readFile(join(root, 'siblings.json'), 'utf8')).toBe(raw)
})

it('同一路径的不同拼写并发登记分支不会丢掉先写入的记录', async () => {
  const entered = deferred(), release = deferred()
  const first = mutateSiblingForks(root, async forks => { entered.resolve(); await release.promise; return [...forks, fork('a')] })
  await entered.promise
  const second = appendSiblingFork(root + '/', fork('b'))
  await new Promise<void>(done => setTimeout(done, 30))
  release.resolve()
  await Promise.all([first, second])
  expect((await loadSiblingForks(root)).map(item => item.childSessionId).sort()).toEqual(['a', 'b'])
})

const delta = { type: 'add' as const, ref: null, content: '北门关闭', keys: ['北门'], order: 100, sourceRange: 't1', expires: null }
it('变化层跳过字段错型的损坏行且后续写入保留原始坏行', async () => {
  const fs = new WorkspaceFs(root, null), store = new WorldDeltaStore(fs)
  const bad = JSON.stringify({ ...delta, id: 'bad', ts: '2026-01-01', content: { text: '错误类型' } })
  await fs.writeText('state/world-delta.jsonl', bad + '\n')
  const good = await store.append(delta)
  expect((await store.list()).map(item => item.id)).toEqual([good.id])
  expect(await fs.readText('state/world-delta.jsonl')).toContain(bad)
})

it('变化恰好到期时不再激活，与固化导出的到期边界一致', async () => {
  const store = new WorldDeltaStore(new WorkspaceFs(root, null))
  const expires = '2026-01-01T00:00:00.000Z'
  await store.append({ ...delta, expires })
  expect(await store.list({ now: new Date(expires) })).toEqual([])
})
