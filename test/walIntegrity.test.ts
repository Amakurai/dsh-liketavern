/**
 * WAL 完整性回归：损坏快照与恢复游标必须在整批回滚前拒绝，真实文件与楼层状态保持原样；
 * 开始楼层时崩溃留下的空目录按未开始处理，不能阻断整个剧情的回退。
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Wal, WAL_BINARY_MARK } from '../src/state/wal.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let wal: Wal
let fs: WorkspaceFs
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tavern-wal-integrity-'))
  wal = new Wal(join(root, 'state/wal'))
  fs = new WorkspaceFs(root, wal)
  await fs.writeText('a.txt', '旧原文')
  await wal.beginFloor('f1')
  await fs.withFloor('f1').writeText('a.txt', '旧楼层正文')
  await wal.commitFloor('f1')
  await wal.beginFloor('f2')
  await fs.withFloor('f2').writeText('b.txt', '新楼层正文')
  await wal.commitFloor('f2')
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

async function expectIntact(): Promise<void> {
  expect(await fs.readText('a.txt')).toBe('旧楼层正文')
  expect(await fs.readText('b.txt')).toBe('新楼层正文')
  expect((await wal.listFloors()).every(floor => !floor.rolledBack && floor.committed)).toBe(true)
}

/** 恢复游标用磁盘中的真实记录集合计算身份，便于区分合法编码与记录来源关系损坏。 */
async function putPending(floor: string, pending: { path: string; from: string | null; to: string | null }): Promise<void> {
  const records = (await readFile(join(root, `state/wal/${floor}/records.jsonl`), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  const hash = createHash('sha256').update(JSON.stringify(records)).digest('hex')
  await writeFile(join(root, `state/wal/${floor}/rollback-progress.json`), JSON.stringify({
    hash, next: records.length - 1, restored: [], preserved: [], pending,
  }))
}
const bytes = (text: string) => Buffer.from(text).toString('base64')

describe('快照编码完整性', () => {
  it.each([
    { before: '%%%损坏%%%', beforeEncoding: 'base64' },
    { after: 'YQ', afterEncoding: 'base64' },
    { before: 'YR==', beforeEncoding: 'base64' },
    { before: WAL_BINARY_MARK + '%%%损坏%%%', beforeEncoding: undefined },
  ])('拒绝损坏或截断的二进制快照：%j', async patch => {
    const path = join(root, 'state/wal/f1/records.jsonl')
    const record = JSON.parse((await readFile(path, 'utf8')).trim())
    await writeFile(path, JSON.stringify({ ...record, ...patch }) + '\n')
    await expect(wal.rollbackAfter(['f1', 'f2'], root)).rejects.toThrow(/WAL.*编码/)
    await expectIntact()
  })

  it('有效二进制、空文件与旧标记仍可完整恢复', async () => {
    const binary = Buffer.from([0, 0xff, 0x89, 0x50])
    await fs.writeBytes('binary.bin', binary)
    await fs.writeBytes('empty.bin', new Uint8Array())
    await wal.beginFloor('f3')
    await fs.withFloor('f3').writeBytes('binary.bin', Buffer.from([1, 2]))
    await fs.withFloor('f3').writeBytes('empty.bin', Buffer.from([3]))
    await wal.record('f3', 'legacy.bin', WAL_BINARY_MARK + binary.toString('base64'))
    await fs.writeBytes('legacy.bin', Buffer.from([4]))
    await wal.commitFloor('f3')
    await wal.rollbackFloor('f3', root)
    expect(await fs.readBytes('binary.bin')).toEqual(binary)
    expect(await fs.readBytes('empty.bin')).toEqual(Buffer.alloc(0))
    expect(await fs.readBytes('legacy.bin')).toEqual(binary)
  })
})

describe('批量回滚预检恢复游标', () => {
  it('合法 base64 但与原记录不符的 pending 目标在整批正文修改前拒绝', async () => {
    await putPending('f1', { path: 'a.txt', from: bytes('旧楼层正文'), to: bytes('伪造恢复目标') })
    const error = await wal.rollbackAfter(['f1', 'f2'], root).then(() => '', reason => String(reason))
    // 同时检查正文，回归失败会明确展示旧实现实际写入了伪造目标、并先删除较新楼层。
    expect({ error, a: await fs.readText('a.txt'), b: await fs.readText('b.txt') }).toEqual({
      error: expect.stringMatching(/WAL.*恢复/), a: '旧楼层正文', b: '新楼层正文',
    })
    await expectIntact()
  })

  it.each([
    { from: bytes('旧楼层正文'), to: null },
    { from: bytes('伪造撤销前正文'), to: bytes('旧原文') },
  ])('pending 不能借合法编码改成删除或伪造来源：%j', async pending => {
    await putPending('f1', { path: 'a.txt', ...pending })
    await expect(wal.rollbackAfter(['f1', 'f2'], root)).rejects.toThrow(/WAL.*恢复/)
    await expectIntact()
  })

  it.each([false, true])('合法 pending 在正文替换前后中断均可继续恢复（已替换：%s）', async applied => {
    if (applied) await fs.writeText('a.txt', '旧原文')
    await putPending('f1', { path: 'a.txt', from: bytes('旧楼层正文'), to: bytes('旧原文') })
    await wal.rollbackFloor('f1', root)
    expect(await fs.readText('a.txt')).toBe('旧原文')
    expect(await fs.readText('b.txt')).toBe('新楼层正文')
    expect((await wal.listFloors()).find(floor => floor.floor === 'f1')?.rolledBack).toBe(true)
  })

  it.each([
    { next: 1, restored: ['x.txt'], preserved: [] },
    { next: 0, restored: ['y.txt', 'x.txt'], preserved: [] },
  ])('已完成数组总数正确但路径与处理后缀矛盾时拒绝恢复：%j', async patch => {
    await wal.beginFloor('f3')
    const scoped = fs.withFloor('f3')
    await scoped.writeText('x.txt', 'X 本层事实')
    await scoped.writeText('y.txt', 'Y 第一稿')
    await scoped.writeText('y.txt', 'Y 第二稿')
    await wal.commitFloor('f3')
    const records = (await fs.readText('state/wal/f3/records.jsonl'))!.trim().split('\n').map(line => JSON.parse(line))
    const hash = createHash('sha256').update(JSON.stringify(records)).digest('hex')
    await fs.writeText('state/wal/f3/rollback-progress.json', JSON.stringify({ hash, ...patch }))
    await expect(wal.rollbackAfter(['f3'], root)).rejects.toThrow(/WAL.*恢复.*进度/)
    expect(await fs.readText('x.txt')).toBe('X 本层事实')
    expect(await fs.readText('y.txt')).toBe('Y 第二稿')
    expect((await wal.listFloors()).find(floor => floor.floor === 'f3')?.rolledBack).toBe(false)
  })

  it('合法游标的同路径多重记录可分别恢复和保留人工修订，继续撤销更早路径', async () => {
    await fs.writeText('x.txt', 'X 原文')
    await wal.beginFloor('f3')
    const scoped = fs.withFloor('f3')
    await scoped.writeText('x.txt', 'X 本层事实')
    await scoped.writeText('y.txt', 'Y 第一稿')
    await fs.writeText('y.txt', 'Y 人工修订')
    await scoped.writeText('y.txt', 'Y 第二稿')
    await wal.commitFloor('f3')
    // 模拟逆序恢复最后一条后保留倒数第二条，并在处理 X 前中断。
    await fs.writeText('y.txt', 'Y 人工修订')
    const records = (await fs.readText('state/wal/f3/records.jsonl'))!.trim().split('\n').map(line => JSON.parse(line))
    const hash = createHash('sha256').update(JSON.stringify(records)).digest('hex')
    await fs.writeText('state/wal/f3/rollback-progress.json', JSON.stringify({ hash, next: 0, restored: ['y.txt'], preserved: ['y.txt'] }))
    await wal.rollbackFloor('f3', root)
    expect(await fs.readText('x.txt')).toBe('X 原文')
    expect(await fs.readText('y.txt')).toBe('Y 人工修订')
  })

  it('旧 before-only 记录的合法 pending 仍可恢复原文', async () => {
    await wal.beginFloor('f3')
    await wal.record('f3', 'legacy.txt', '旧协议原文')
    await fs.writeText('legacy.txt', '旧协议正文')
    await wal.commitFloor('f3')
    await putPending('f3', { path: 'legacy.txt', from: bytes('旧协议正文'), to: bytes('旧协议原文') })
    await wal.rollbackFloor('f3', root)
    expect(await fs.readText('legacy.txt')).toBe('旧协议原文')
  })

  const deltaPath = 'state/world-delta.jsonl'
  const originalDelta = '{"id":"d1","content":"原事实"}\n'
  const firstDelta = '{"id":"d1","content":"第一步"}\n'
  const secondDelta = '{"id":"d1","content":"第二步"}\n'
  const keptDelta = '{"id":"kept","content":"人工事实"}\n'
  async function changedDelta(path = deltaPath): Promise<void> {
    await fs.writeText(path, originalDelta)
    await wal.beginFloor('f3')
    await fs.withFloor('f3').writeText(path, firstDelta)
    await fs.withFloor('f3').writeText(path, secondDelta)
    await wal.commitFloor('f3')
    await fs.writeText(path, secondDelta + keptDelta)
  }

  it('世界变化 pending 目标必须由原记录和来源正文推导，不能丢掉人工条目', async () => {
    await changedDelta()
    await wal.beginFloor('f4')
    await fs.withFloor('f4').writeText('c.txt', '后继楼层正文')
    await wal.commitFloor('f4')
    await putPending('f3', { path: deltaPath, from: bytes(secondDelta + keptDelta), to: bytes(firstDelta) })
    await expect(wal.rollbackAfter(['f3', 'f4'], root)).rejects.toThrow(/WAL.*恢复/)
    expect(await fs.readText(deltaPath)).toBe(secondDelta + keptDelta)
    expect(await fs.readText('c.txt')).toBe('后继楼层正文')
    expect((await wal.listFloors()).every(floor => !floor.rolledBack)).toBe(true)
  })

  it.each([false, true])('世界变化派生 pending 恢复保留人工条目，并继续撤销同层前一次操作（已替换：%s）', async applied => {
    await changedDelta()
    if (applied) await fs.writeText(deltaPath, firstDelta + keptDelta)
    await putPending('f3', { path: deltaPath, from: bytes(secondDelta + keptDelta), to: bytes(firstDelta + keptDelta) })
    await wal.rollbackFloor('f3', root)
    expect(await fs.readText(deltaPath)).toBe(originalDelta + keptDelta)
  })

  it.skipIf(process.platform !== 'win32')('Windows 世界变化路径别名的派生 pending 保持同一撤销语义', async () => {
    const path = 'STATE/WORLD-DELTA.JSONL'
    await changedDelta(path)
    await putPending('f3', { path, from: bytes(secondDelta + keptDelta), to: bytes(firstDelta + keptDelta) })
    await wal.rollbackFloor('f3', root)
    expect(await fs.readText(deltaPath)).toBe(originalDelta + keptDelta)
  })

  it('原始楼层身份净化后同名仍不能撤销其它楼层，整批正文保持原样', async () => {
    await wal.beginFloor('s#t1')
    await fs.withFloor('s#t1').writeText('c.txt', '真实楼层正文')
    await wal.commitFloor('s#t1')

    await expect(wal.rollbackFloor('s_t1', root)).rejects.toThrow(/WAL.*元数据/)
    await expect(wal.rollbackAfter(['s_t1', 'f2'], root)).rejects.toThrow(/WAL.*元数据/)
    expect(await fs.readText('c.txt')).toBe('真实楼层正文')
    await expectIntact()
    expect(await fs.readText('state/wal/s_t1/rollback-progress.json')).toBeNull()

    await wal.rollbackFloor('s#t1', root)
    expect(await fs.readText('c.txt')).toBeNull()
  })

  it.each([
    '{broken',
    'null',
    JSON.stringify({ hash: 'stale', next: 0, restored: [], preserved: [] }),
  ])('旧楼层游标损坏时，新楼层也不能先被撤销：%s', async raw => {
    await writeFile(join(root, 'state/wal/f1/rollback-progress.json'), raw)
    await expect(wal.rollbackAfter(['f1', 'f2'], root)).rejects.toThrow(/WAL.*恢复/)
    await expectIntact()
  })

  it.each([
    { pending: { path: 'a.txt', from: '%%%损坏%%%', to: '' } },
    { pending: { path: 'a.txt', from: '', to: 'YQ' } },
    { pending: { path: 'other.txt', from: '', to: null } },
    { pending: null },
    { restored: [42] },
    { preserved: ['../outside.txt'] },
    { next: -1 },
    { next: -1, pending: { path: 'a.txt', from: '', to: null } },
  ])('拒绝恢复记录中的非法字段：%j', async patch => {
    const records = (await readFile(join(root, 'state/wal/f1/records.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const hash = createHash('sha256').update(JSON.stringify(records)).digest('hex')
    await writeFile(join(root, 'state/wal/f1/rollback-progress.json'), JSON.stringify({ hash, next: 0, restored: [], preserved: [], ...patch }))
    await expect(wal.rollbackAfter(['f1', 'f2'], root)).rejects.toThrow(/WAL.*恢复/)
    await expectIntact()
  })
})

describe('开始楼层崩溃遗留', () => {
  it('建目录后、写元数据前崩溃的空楼层不阻断列举与回退，并可重新开始', async () => {
    await mkdir(join(root, 'state/wal/f3'), { recursive: true })
    await writeFile(join(root, 'state/wal/f3/meta.json.0123-tmp.tmp'), '{"floor":')
    expect((await wal.listFloors()).map(floor => floor.floor)).toEqual(['f1', 'f2'])
    await wal.rollbackFloor('f2', root)
    expect(await fs.readText('b.txt')).toBeNull()
    await wal.beginFloor('f3')
    await fs.withFloor('f3').writeText('c.txt', '重新开始')
    await wal.commitFloor('f3')
    await wal.rollbackFloor('f3', root)
    expect(await fs.readText('c.txt')).toBeNull()
  })

  it('空楼层回滚中途崩溃只留下游标时仍按恢复中拒绝，不能静默复用', async () => {
    await mkdir(join(root, 'state/wal/f3'), { recursive: true })
    await writeFile(join(root, 'state/wal/f3/rollback-progress.json'), '{}')
    await expect(wal.listFloors()).rejects.toThrow('WAL 元数据缺失')
    await expect(wal.beginFloor('f3')).rejects.toThrow('拒绝重复开始')
  })

  it('缺元数据但已有记录仍视为损坏，拒绝列举与重新开始', async () => {
    await rm(join(root, 'state/wal/f2/meta.json'))
    await expect(wal.listFloors()).rejects.toThrow('WAL 元数据缺失')
    await expect(wal.beginFloor('f2')).rejects.toThrow('拒绝重复开始')
    await expect(wal.rollbackFloor('f1', root)).rejects.toThrow()
    expect(await fs.readText('a.txt')).toBe('旧楼层正文')
    expect(await fs.readText('b.txt')).toBe('新楼层正文')
  })
})
