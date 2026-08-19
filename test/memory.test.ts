/**
 * 记忆存储（MemoryStore）单元测试。
 * 覆盖：write/get/list 往返（frontmatter 字段完整）、overLength 软提示、update 合并/替换 tags/keys、
 * delete、archive 移动、findSimilar 命中相似条目、search 时间衰减（注入 now）、
 * stats token 累加、oldest 顺序、坏文件容错、serialize/parse 往返。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { estimateTokens } from '../src/core/tokenize.js'
import { MemoryStore, parseMemory, serializeMemory } from '../src/state/memory.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let fs: WorkspaceFs
let store: MemoryStore

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'memory-test-'))
  fs = new WorkspaceFs(root, null)
  store = new MemoryStore(fs)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** 直接落盘一条记忆（绕过 write，以便控制 created/updated 时间）。 */
async function putMemory(id: string, created: string, body: string, updated = created): Promise<void> {
  await fs.writeText(`memory/${id}.md`, serializeMemory({ created, updated, sourceRange: '', tags: [], keys: [] }, body))
}

describe('MemoryStore', () => {
  it('write → get/list 往返：frontmatter 字段完整', async () => {
    const entry = await store.write({
      body: '艾琳在桥头受了轻伤，左臂包扎。',
      tags: ['伤势', '艾琳'],
      keys: ['艾琳', '桥头'],
      sourceRange: 'msg#12-18',
    })
    expect(entry.id).toMatch(/^m-[a-z0-9]+-[a-z0-9]{2}$/)
    expect(entry.file).toBe(`${entry.id}.md`)
    expect(entry.archived).toBe(false)
    expect(entry.overLength).toBe(false)
    expect(Date.parse(entry.created)).not.toBeNaN()
    expect(entry.updated).toBe(entry.created)

    // 磁盘上的 frontmatter 字段完整
    const raw = await fs.readText(`memory/${entry.id}.md`)
    expect(raw).toContain('created: ')
    expect(raw).toContain('updated: ')
    expect(raw).toContain('source_range: msg#12-18')
    expect(raw).toContain('tags: ["伤势","艾琳"]')
    expect(raw).toContain('keys: ["艾琳","桥头"]')

    // get 往返：与写入值一致
    const got = await store.get(entry.id)
    expect(got).toMatchObject({
      id: entry.id,
      file: entry.file,
      created: entry.created,
      updated: entry.updated,
      sourceRange: 'msg#12-18',
      tags: ['伤势', '艾琳'],
      keys: ['艾琳', '桥头'],
      body: '艾琳在桥头受了轻伤，左臂包扎。',
      archived: false,
    })
    // list 往返：仅一条且内容一致
    expect(await store.list()).toEqual([got])
  })

  it('正文超过 200 字时软提示 overLength（不拒绝，仍落盘）', async () => {
    const entry = await store.write({ body: '字'.repeat(201) })
    expect(entry.overLength).toBe(true)
    expect((await store.get(entry.id))?.body).toHaveLength(201)
  })

  it('update 合并 tags/keys（去重）、替换 body、刷新 updated', async () => {
    const entry = await store.write({ body: '旧正文', tags: ['a'], keys: ['x'] })
    const updated = await store.update(entry.id, { body: '新正文', tags: ['a', 'b'], keys: ['y', 'x'] })
    expect(updated).not.toBeNull()
    expect(updated!.body).toBe('新正文')
    expect(updated!.tags).toEqual(['a', 'b'])
    expect(updated!.keys).toEqual(['x', 'y'])
    expect(updated!.created).toBe(entry.created)
    expect(Date.parse(updated!.updated)).toBeGreaterThanOrEqual(Date.parse(entry.updated))

    // patch 未给的字段保持原值
    const again = await store.update(entry.id, {})
    expect(again!.body).toBe('新正文')
    expect(again!.tags).toEqual(['a', 'b'])
    expect(again!.keys).toEqual(['x', 'y'])

    expect(await store.update('m-nope', { body: 'x' })).toBeNull()
  })

  it('update replace 模式允许设置面板删除或清空 tags/keys', async () => {
    const entry = await store.write({ body: '正文', tags: ['a', 'b'], keys: ['x', 'y'] })
    const updated = await store.update(
      entry.id,
      { tags: ['b'], keys: [] },
      { listMode: 'replace' },
    )
    expect(updated?.tags).toEqual(['b'])
    expect(updated?.keys).toEqual([])
  })

  it('delete 事务删除，重复删除返回 false', async () => {
    const entry = await store.write({ body: '待删' })
    expect(await store.delete(entry.id)).toBe(true)
    expect(await store.list()).toEqual([])
    expect(await fs.readText(`memory/${entry.id}.md`)).toBeNull()
    expect(await store.delete(entry.id)).toBe(false)
  })

  it('archive 移入 memory/archive/，返回移动条数', async () => {
    const a = await store.write({ body: '旧记忆' })
    const b = await store.write({ body: '新记忆' })
    const moved = await store.archive([a.id, 'm-missing'])
    expect(moved).toBe(1)
    expect((await store.list()).map((e) => e.id)).toEqual([b.id])
    expect(await fs.readText(`memory/${a.id}.md`)).toBeNull()
    const archivedText = await fs.readText(`memory/archive/${a.id}.md`)
    expect(archivedText).not.toBeNull()
    const parsed = parseMemory(`archive/${a.id}.md`, archivedText!)
    expect(parsed.archived).toBe(true)
    expect(parsed.body).toBe('旧记忆')
  })

  it('findSimilar 命中相似条目（keys 加权内建）', async () => {
    const target = await store.write({
      body: '艾琳把断剑寄存在铁匠铺重铸',
      keys: ['艾琳', '断剑'],
    })
    await store.write({ body: '今天的面包涨价了两个铜板', keys: ['面包'] })
    const hits = await store.findSimilar('断剑送去铁匠铺重铸了', ['断剑'])
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0]!.entry.id).toBe(target.id)
    expect(hits[0]!.score).toBeGreaterThan(0)
  })

  it('search 时间衰减：同分文本新近条目靠前（注入 now 与 halfLifeMs）', async () => {
    // 旧条目 id 字典序更小，用于区分「无衰减按 id 并列」与「衰减后按分数」两种排序
    await putMemory('m-aaa', '2026-08-01T00:00:00.000Z', '旅店地窖藏着走私火药')
    await putMemory('m-zzz', '2026-08-16T00:00:00.000Z', '旅店地窖藏着走私火药')
    const now = Date.parse('2026-08-17T00:00:00.000Z')
    const halfLifeMs = 24 * 60 * 60 * 1000

    const decayed = await store.search('旅店地窖火药', { topK: 2, halfLifeMs, now })
    expect(decayed.map((h) => h.entry.id)).toEqual(['m-zzz', 'm-aaa'])
    expect(decayed[0]!.score).toBeGreaterThan(decayed[1]!.score)

    // 不传 halfLifeMs：无衰减，同分按 id 字典序
    const plain = await store.search('旅店地窖火药', { topK: 2, now })
    expect(plain.map((h) => h.entry.id)).toEqual(['m-aaa', 'm-zzz'])
  })

  it('stats 累加 body 的 token 估算', async () => {
    await store.write({ body: '甲' })
    await store.write({ body: 'hello world' })
    const stats = await store.stats()
    expect(stats.count).toBe(2)
    expect(stats.tokens).toBe(estimateTokens('甲') + estimateTokens('hello world'))
  })

  it('oldest 按 created 升序取最旧批次', async () => {
    await putMemory('m-0', '2026-08-03T00:00:00.000Z', '第三条')
    await putMemory('m-1', '2026-08-01T00:00:00.000Z', '第一条')
    await putMemory('m-2', '2026-08-02T00:00:00.000Z', '第二条')
    const oldest = await store.oldest(2)
    expect(oldest.map((e) => e.body)).toEqual(['第一条', '第二条'])
    expect((await store.oldest(10)).map((e) => e.body)).toEqual(['第一条', '第二条', '第三条'])
  })

  it('坏文件容错跳过，不影响正常条目', async () => {
    const good = await store.write({ body: '正常条目' })
    await fs.writeText('memory/broken.md', '没有 frontmatter 的正文')
    await fs.writeText(
      'memory/bad-tags.md',
      '---\ncreated: 2026-08-01T00:00:00.000Z\ntags: [not json]\n---\n\nx\n',
    )
    await fs.writeText('memory/no-date.md', '---\ntags: []\n---\n\nx\n')
    expect((await store.list()).map((e) => e.id)).toEqual([good.id])
    expect((await store.stats()).count).toBe(1)
    expect(await store.get('broken')).toBeNull()
  })

  it('serializeMemory/parseMemory 往返（多行正文、特殊字符转义）', () => {
    const text = serializeMemory(
      {
        created: '2026-08-01T00:00:00.000Z',
        updated: '2026-08-02T00:00:00.000Z',
        sourceRange: 'msg#1-2',
        tags: ['a', 'b"c'],
        keys: ['k'],
      },
      '第一行\n第二行',
    )
    const entry = parseMemory('m-x.md', text)
    expect(entry).toMatchObject({
      id: 'm-x',
      file: 'm-x.md',
      created: '2026-08-01T00:00:00.000Z',
      updated: '2026-08-02T00:00:00.000Z',
      sourceRange: 'msg#1-2',
      tags: ['a', 'b"c'],
      keys: ['k'],
      body: '第一行\n第二行',
      archived: false,
    })
  })
})
