/**
 * WAL 后继依赖判定的方向性与记录路径的可读回性回归：
 * 只有「在被撤销楼层开始前已完成」的写入才能排除，更早完成楼层的同值 before（每轮重写相同定时器、
 * 标志位来回切换）不能阻止撤销最新楼层；旧路径定时器同内容不重复记 WAL；
 * 楼层写入的路径先规范化再记录，模型给出的记忆 id 不能是路径；世界状态坏行不让预检抛原始解析错误。
 * 全部使用临时目录与手写内容，不调用真实模型。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Wal } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'
import { saveTemplateTimers } from '../src/state/template.js'
import { MemoryStore } from '../src/state/memory.js'

let root: string
let wal: Wal
let shared: WorkspaceFs
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-wal-order-'))
  wal = new Wal(join(root, 'state', 'wal'))
  shared = new WorkspaceFs(root, wal)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 开一层、写完给定文件、提交；startedAt 单调递增靠真实时钟，间隔一毫秒以上即可。 */
async function turn(floor: string, writes: Record<string, string | null>): Promise<void> {
  await wal.beginFloor(floor)
  const fs = shared.withFloor(floor)
  for (const [path, content] of Object.entries(writes)) {
    if (content === null) await fs.delete(path)
    else await fs.writeText(path, content)
  }
  await wal.commitFloor(floor)
  await new Promise((resolve) => setTimeout(resolve, 2))
}

const TIMERS = 'state/wi-timers/s.json'

it('每轮重写相同定时器内容后，仍可只撤销最新楼层', async () => {
  const same = '{"stickyLeft":{},"cooldownLeft":{}}\n'
  await turn('s#t1', { [TIMERS]: same })
  await turn('s#t2', { [TIMERS]: same })
  await turn('s#t3', { [TIMERS]: same, 'journal.md': '第三层笔记' })
  const result = await wal.rollbackAfter(['s#t3'], root)
  expect(result.skipped).toEqual([])
  expect(await shared.readText('journal.md')).toBeNull()
  expect(await shared.readText(TIMERS)).toBe(same)
})

it('文件内容来回切换时，更早楼层的同值 before 不算后继依赖', async () => {
  await turn('s#t1', { 'state/helper.json': 'A' })
  await turn('s#t2', { 'state/helper.json': 'B' })
  await turn('s#t3', { 'state/helper.json': 'A' })
  await wal.rollbackAfter(['s#t3'], root)
  expect(await shared.readText('state/helper.json')).toBe('B')
  await wal.rollbackAfter(['s#t2'], root)
  expect(await shared.readText('state/helper.json')).toBe('A')
  await wal.rollbackAfter(['s#t1'], root)
  expect(await shared.readText('state/helper.json')).toBeNull()
})

it('更晚开始的楼层叠写同一文件时仍拒绝越过它撤销', async () => {
  await turn('s#t1', { 'memory/m1.md': '原文' })
  await turn('s#t2', { 'memory/m1.md': 'A' })
  await turn('other#t1', { 'memory/m1.md': 'B' })
  await expect(wal.rollbackAfter(['s#t2'], root)).rejects.toThrow('后继依赖')
  expect(await shared.readText('memory/m1.md')).toBe('B')
  await wal.rollbackAfter(['s#t2', 'other#t1'], root)
  expect(await shared.readText('memory/m1.md')).toBe('原文')
})

it.each([false, true])('更早开始但更晚写入的交错楼层仍是后继依赖（已提交：%s）', async (committed) => {
  await wal.beginFloor('other#t1')
  await new Promise((resolve) => setTimeout(resolve, 2))
  await turn('s#t1', { 'journal.md': '待撤销事实' })
  await shared.withFloor('other#t1').writeText('journal.md', '后续修订')
  if (committed) await wal.commitFloor('other#t1')
  await expect(wal.rollbackAfter(['s#t1'], root)).rejects.toThrow('后继依赖')
  expect(await shared.readText('journal.md')).toBe('后续修订')
  await wal.rollbackAfter(['s#t1', 'other#t1'], root)
  expect(await shared.readText('journal.md')).toBeNull()
})

it('更早完成的楼层重新打开并追加写入后仍须检查后继依赖', async () => {
  await turn('other#t1', { 'journal.md': '初始事实' })
  await turn('s#t1', { 'journal.md': '待撤销事实' })
  await wal.reopenFloor('other#t1')
  await shared.withFloor('other#t1').writeText('journal.md', '后续修订')
  await expect(wal.rollbackAfter(['s#t1'], root)).rejects.toThrow('后继依赖')
  expect(await shared.readText('journal.md')).toBe('后续修订')
  await wal.commitFloor('other#t1')
  await expect(wal.rollbackAfter(['s#t1'], root)).rejects.toThrow('后继依赖')
  expect(await shared.readText('journal.md')).toBe('后续修订')
})

it('未迁移会话的定时器内容未变时不写文件、不记 WAL', async () => {
  const timers = { stickyLeft: { 'a:b:1': 2 }, cooldownLeft: {} }
  await wal.beginFloor('s#t1')
  await saveTemplateTimers(shared.withFloor('s#t1'), 's', timers)
  await wal.commitFloor('s#t1')
  await wal.beginFloor('s#t2')
  await saveTemplateTimers(shared.withFloor('s#t2'), 's', structuredClone(timers))
  await wal.commitFloor('s#t2')
  expect(await shared.list('state/wal/s_t2')).toEqual(['meta.json'])
  await wal.beginFloor('s#t3')
  await saveTemplateTimers(shared.withFloor('s#t3'), 's', { stickyLeft: {}, cooldownLeft: {} })
  await wal.commitFloor('s#t3')
  expect(await shared.list('state/wal/s_t3')).toEqual(['meta.json', 'records.jsonl'])
  expect(JSON.parse((await shared.readText(TIMERS))!)).toEqual({ stickyLeft: {}, cooldownLeft: {} })
  await wal.rollbackAfter(['s#t3'], root)
  expect(JSON.parse((await shared.readText(TIMERS))!)).toEqual(timers)
})

it('楼层写入的路径先规范化再记 WAL，带 ./ 或重复斜杠的写入不会让日志无法读回', async () => {
  await wal.beginFloor('s#t1')
  const fs = shared.withFloor('s#t1')
  await fs.writeText('memory/./m-a.md', '甲')
  await fs.writeText('memory//m-b.md', '乙')
  await fs.delete('./memory/m-a.md')
  await wal.commitFloor('s#t1')
  await expect(wal.validateFloor('s#t1')).resolves.toMatchObject({ committed: true })
  await expect(fs.writeText('state/wal/s_t1/records.jsonl', 'x')).rejects.toThrow('无法记录快照')
  await wal.rollbackAfter(['s#t1'], root)
  expect(await shared.readText('memory/m-b.md')).toBeNull()
})

it('模型给出的记忆 id 只能是单个文件名段：路径式 id 视为不存在，归档来源不能借 id 改写', async () => {
  await wal.beginFloor('s#t1')
  const memory = new MemoryStore(shared.withFloor('s#t1'))
  const entry = await memory.write({ body: '原始事实' })
  await memory.archive([entry.id])
  expect(await shared.readText(`memory/archive/${entry.id}.md`)).not.toBeNull()
  expect(await memory.get(`./${entry.id}`)).toBeNull()
  expect(await memory.update(`archive/${entry.id}`, { body: '篡改' })).toBeNull()
  expect(await memory.delete(`archive/${entry.id}`)).toBe(false)
  expect(await memory.update(`..\\${entry.id}`, { body: '篡改' })).toBeNull()
  expect((await shared.readText(`memory/archive/${entry.id}.md`))!).toContain('原始事实')
  await wal.commitFloor('s#t1')
  await expect(wal.validateFloor('s#t1')).resolves.toMatchObject({ committed: true })
})

it('世界状态文件夹带无法解析的行时，预检仍按 id 判断重叠而不抛原始解析错误', async () => {
  const delta = 'state/world-delta.jsonl'
  await turn('s#t1', { [delta]: '{"id":"d1","content":"甲"}\n' })
  await turn('s#t2', { [delta]: '{"id":"d1","content":"甲"}\n损坏的一行\n{"id":"d2","content":"乙"}\n' })
  await turn('s#t3', { [delta]: '{"id":"d1","content":"甲"}\n损坏的一行\n{"id":"d2","content":"乙改"}\n' })
  await wal.rollbackAfter(['s#t3'], root)
  expect(await shared.readText(delta)).toBe('{"id":"d1","content":"甲"}\n损坏的一行\n{"id":"d2","content":"乙"}\n')
})
