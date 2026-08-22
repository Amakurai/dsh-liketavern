/**
 * 世界状态变化层存储（WorldDeltaStore）单元测试。
 * 覆盖：append 生成不依赖行数的唯一 id、并发 append 经互斥队列不丢行、list 过滤 revoked/过期（注入 now）、
 * revoke 行内标记、toEngineEntries 的 order 紧随 ref、三种 type 的 content 标注、空 keys 不命中（constant=false）。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WorldDeltaStore } from '../src/state/worlddelta.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let fs: WorkspaceFs
let store: WorldDeltaStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'worlddelta-test-'))
  fs = new WorkspaceFs(root, null)
  store = new WorldDeltaStore(fs)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const base = { ref: null, keys: ['x'], order: 42, sourceRange: 'msg#1-2', expires: null }

describe('WorldDeltaStore', () => {
  it('append 生成不依赖行数的唯一 id，ts 默认当前 ISO 可覆盖', async () => {
    const d1 = await store.append({ ...base, type: 'add', content: '新增设定' })
    const d2 = await store.append({
      ...base,
      type: 'update',
      ref: 'uid-1',
      content: '变化后',
      ts: '2026-08-01T00:00:00.000Z',
    })
    // id = d-<36 进制毫秒>-<随机 hex>：WAL 回滚把 jsonl 恢复到更短状态后也不复用旧 id
    expect(d1.id).toMatch(/^d-[0-9a-z]+-[0-9a-f]{6}$/)
    expect(d2.id).not.toBe(d1.id)
    expect(Date.parse(d1.ts)).not.toBeNaN()
    expect(d2.ts).toBe('2026-08-01T00:00:00.000Z')
    const raw = await fs.readText('state/world-delta.jsonl')
    expect(raw!.trim().split('\n')).toHaveLength(2)
  })

  it('list 默认过滤 revoked 与已过期（注入 now）', async () => {
    const keep = await store.append({ ...base, type: 'add', content: '常驻' })
    const revoked = await store.append({ ...base, type: 'add', content: '被撤销' })
    const expired = await store.append({
      ...base,
      type: 'add',
      content: '已过期',
      expires: '2026-08-01T00:00:00.000Z',
    })
    const future = await store.append({
      ...base,
      type: 'add',
      content: '未到期',
      expires: '2026-09-01T00:00:00.000Z',
    })
    await store.revoke(revoked.id)

    const now = new Date('2026-08-17T00:00:00.000Z')
    expect((await store.list({ now })).map((d) => d.id)).toEqual([keep.id, future.id])
    // includeRevoked 只放开 revoked，过期过滤仍然生效
    expect((await store.list({ now, includeRevoked: true })).map((d) => d.id)).toEqual([
      keep.id,
      revoked.id,
      future.id,
    ])
    expect(expired.content).toBe('已过期')
  })

  it('revoke 行内标记 revoked: true，不物理删除', async () => {
    const d = await store.append({ ...base, type: 'invalidate', ref: 'uid-9', content: '作废' })
    expect(await store.revoke(d.id)).toBe(true)
    expect(await store.revoke('d-9999')).toBe(false)
    expect(await store.list()).toEqual([])

    const raw = await fs.readText('state/world-delta.jsonl')
    const lines = raw!.trim().split('\n')
    expect(lines).toHaveLength(1) // 行仍在，仅打标记
    expect((JSON.parse(lines[0]!) as Record<string, unknown>).revoked).toBe(true)
    expect((await store.list({ includeRevoked: true }))[0]!.revoked).toBe(true)
  })

  it('并发 append 经互斥队列串行化，不互相覆盖丢行', async () => {
    // 读改写若不串行化，两个并发 append 各自读到 0 行、各写 1 行，最终只剩 1 行
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => store.append({ ...base, type: 'add', content: `并发变化 ${i}` })),
    )
    const ids = new Set(results.map((d) => d.id))
    expect(ids.size).toBe(8)
    const listed = await store.list({ includeRevoked: true })
    expect(listed).toHaveLength(8)
    expect(new Set(listed.map((d) => d.id)).size).toBe(8)
  })

  it('toEngineEntries：order 紧随 ref（resolveRefOrder → 100 时为 100.5）', async () => {
    const upd = await store.append({ ...base, type: 'update', ref: 'uid-a', content: '新状态' })
    const inv = await store.append({ ...base, type: 'invalidate', ref: 'uid-b', content: '旧设定' })
    const add = await store.append({ ...base, type: 'add', content: '新增' })
    const entries = store.toEngineEntries(await store.list(), (ref) => (ref === 'uid-a' ? 100 : null))
    const [eUpd, eInv, eAdd] = entries
    expect(eUpd!.uid).toBe(upd.id)
    expect(eUpd!.order).toBe(100.5) // ref 命中：紧随原条目之后
    expect(eInv!.order).toBe(42) // ref 未命中（resolveRefOrder → null）：用 delta.order
    expect(eAdd!.order).toBe(42) // ref 为 null：用 delta.order
    expect(eUpd!.deltaRef).toBe('uid-a')
    expect(eInv!.deltaRef).toBe('uid-b')
    expect(eAdd!.deltaRef).toBeNull()
    expect(inv.type).toBe('invalidate')
    expect(add.type).toBe('add')
  })

  it('toEngineEntries：三种 type 的 content 标注', async () => {
    await store.append({ ...base, type: 'update', ref: 'uid-a', content: '新状态' })
    await store.append({ ...base, type: 'invalidate', ref: 'uid-b', content: '旧设定' })
    await store.append({ ...base, type: 'add', content: '新增' })
    const entries = store.toEngineEntries(await store.list(), () => null)
    expect(entries[0]!.content).toBe('【当前状态·更新】新状态')
    expect(entries[1]!.content).toBe('【当前状态·已失效】旧设定')
    expect(entries[2]!.content).toBe('新增')
    expect(entries[0]!.comment).toBe('变化层 update')
    expect(entries[1]!.comment).toBe('变化层 invalidate')
    expect(entries[2]!.comment).toBe('变化层 add')
  })

  it('toEngineEntries：引擎字段齐全，空 keys 不命中（constant=false）', async () => {
    const d = await store.append({ ...base, keys: [], type: 'add', content: '无键条目', order: 7 })
    const [e] = store.toEngineEntries(await store.list(), () => null)
    expect(e).toMatchObject({
      key: `delta:world-delta:${d.id}`,
      uid: d.id,
      source: 'delta',
      sourceRef: 'world-delta',
      keys: [], // 空 keys + constant=false → 永不命中
      secondaryKeys: [],
      constant: false,
      enabled: true,
      order: 7,
      position: 1, // afterCharDefs
      depth: 4,
      role: 0, // system
      outletName: '',
      probability: 100,
      useProbability: false,
      selective: false,
      selectiveLogic: 0,
      caseSensitive: null,
      matchWholeWords: null,
      scanDepth: null,
      excludeRecursion: false,
      preventRecursion: false,
      delayUntilRecursion: 0,
      sticky: null,
      cooldown: null,
      delay: null,
      ignoreBudget: false,
      group: '',
      automationId: '',
      groupWeight: 100,
      groupOverride: false,
      comment: '变化层 add',
      deltaType: 'add',
      deltaRef: null,
    })
  })
})
