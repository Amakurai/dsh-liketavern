/**
 * 手写中文剧情的记忆覆盖率回归：真实剧情文件和组装管线验证候选补位、预算、来源与同轮冻结。
 * 查询词与期望事实人工指定，不调用模型，不把别名词面命中误称为语义召回。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { selectMemoryBodies } from '../src/core/memoryRetrieval.js'
import { resolveConfig } from '../src/node/config.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'
import { TavernState } from '../src/node/state.js'
import { MemoryStore, serializeMemory } from '../src/state/memory.js'
import { Wal } from '../src/state/wal.js'
import type { WorkspaceFs } from '../src/state/workspaceFs.js'

let root: string
let state: TavernState
let cardId: string
let config: ReturnType<typeof resolveConfig>
let ws: Awaited<ReturnType<TavernState['storyWorkspace']>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'memory-coverage-'))
  config = resolveConfig({ memory: { retrievalTopK: 2, retrievalTokenBudget: 100, halfLifeDays: 0 } })
  state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'),
    presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'),
    sessions: join(root, 'sessions') }, () => config)
  await state.init()
  cardId = (await state.createCharacter('星港记录员')).cardId
  await state.saveBinding({ sessionId: 'parent', cardId, presetId: null, personaId: null, lorebookIds: [],
    characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
  ws = await state.storyWorkspace(cardId, (await state.loadBinding('parent'))!.storyId)
})

afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

async function put(id: string, body: string, options: { keys?: string[]; sourceRange?: string; updated?: string; fs?: WorkspaceFs } = {}) {
  const created = options.updated ?? '2026-09-01T00:00:00.000Z'
  await (options.fs ?? ws.fs).writeText(`memory/${id}.md`, serializeMemory({ created, updated: created,
    sourceRange: options.sourceRange ?? '', tags: [], keys: options.keys ?? [] }, body))
  ws.memory.invalidate()
}

async function run(query: string, sessionId = 'parent', mode: 'live' | 'preview' = 'preview') {
  const result = await runTavernPipeline({ state, sessionId, agent: null, mode,
    historyOverride: [{ role: 'user', content: query }] })
  expect(result).not.toBeNull()
  return result!
}

describe('入模记忆候选补位', () => {
  it('复现旧 topK 截断只留下一个事实；超取后补入独立事实且最终最多两条', async () => {
    for (let i = 0; i < 3; i++) await put(`duplicate-${i}`, '星港船票售罄')
    await put('watch', '星港的守卫会在午夜换岗。')
    await put('doctor', '星港的医师每逢周二才会到岗。')
    const oldHits = await ws.memory.search('星港', { topK: 2 })
    expect(selectMemoryBodies(oldHits, 100)).toEqual(['星港船票售罄'])
    const result = await run('星港')
    expect(result.turnContext).toContain('星港船票售罄')
    expect(result.turnContext).toContain('星港的守卫会在午夜换岗。')
    expect(result.turnContext).not.toContain('星港的医师每逢周二才会到岗。')
  })

  it('排名首位的超长正文不会挤掉候选窗口外可完整注入的事实', async () => {
    config.memory.retrievalTopK = 1
    config.memory.retrievalTokenBudget = 20
    await put('long', '星港'.repeat(300))
    await put('short', '星港渡船明晨开航。')
    expect((await ws.memory.search('星港', { topK: 1 }))[0]!.entry.id).toBe('long')
    const result = await run('星港')
    expect(result.turnContext).toContain('星港渡船明晨开航。')
    expect(result.turnContext).not.toContain('已截断')
  })

  it('topK=0 或正文预算=0 时不读取来源索引', async () => {
    await put('broken', '星港摘要', { sourceRange: 'compress:missing' })
    const search = vi.spyOn(ws.memory, 'search')
    config.memory.retrievalTopK = 0
    expect((await run('星港')).turnContext).not.toContain('星港摘要')
    config.memory.retrievalTopK = 2
    config.memory.retrievalTokenBudget = 0
    expect((await run('星港')).turnContext).not.toContain('星港摘要')
    expect(search).not.toHaveBeenCalled()
  })

  it('候选超取始终有 200 条硬上限', async () => {
    config.memory.retrievalTopK = Number.MAX_VALUE
    await put('first', '星港渡船开航。')
    const search = vi.spyOn(ws.memory, 'search')
    await run('星港')
    expect(search.mock.calls[0]![1]!.topK).toBe(200)
  })

  it('多代同源摘要不能一起挤占最终条数，原始明细仍可按关键词入模', async () => {
    await put('origin', '陆青把翡翠钥匙藏在钟楼第三块砖后。')
    await ws.memory.mergeBatch(await ws.memory.list(), '星港旧事摘要', 'compress')
    await ws.memory.mergeBatch(await ws.memory.list(), '星港旧事记录', 'compress')
    await ws.memory.mergeBatch(await ws.memory.list(), '星港旧事回顾', 'compress')
    await put('watch', '星港的守卫会在午夜换岗。')
    const oldHits = await ws.memory.search('星港', { topK: 2 })
    expect(oldHits.every((hit) => hit.entry.sourceRange.startsWith('compress:'))).toBe(true)
    const selected = await run('星港')
    expect(selected.turnContext).toContain(oldHits[0]!.entry.body)
    expect(selected.turnContext).toContain('星港的守卫会在午夜换岗。')
    expect(selected.turnContext).not.toContain(oldHits[1]!.entry.body)
    expect((await run('翡翠钥匙')).turnContext).toContain('钟楼第三块砖后')
    const candidates = await ws.memory.search('星港 翡翠钥匙', { topK: 8, includeSummarySources: true })
    for (const hit of candidates.filter((hit) => hit.entry.sourceRange.startsWith('compress:'))) {
      expect(hit.summarySourceIds).toEqual(['origin'])
    }
    expect(candidates.find((hit) => hit.entry.id === 'origin')!.summarySourceIds).toBeUndefined()
  })
})

describe('手写中文剧情与状态边界', () => {
  it('别名 keys 可以召回；无共同词的指代不会凭空发明召回', async () => {
    await put('alias', '陆青把翡翠钥匙藏在钟楼。', { keys: ['夜鸦'] })
    expect((await run('夜鸦')).turnContext).toContain('翡翠钥匙藏在钟楼')
    expect((await run('他把那个放在哪里')).turnContext).not.toContain('翡翠钥匙')
  })

  it('相似的肯定与否定事实不被正文或来源多样性误合并', async () => {
    await put('yes', '黎明时北门已开。', { sourceRange: 'msg#1' })
    await put('no', '宵禁时北门未开。', { sourceRange: 'msg#2' })
    const result = await run('北门')
    expect(result.turnContext).toContain('黎明时北门已开。')
    expect(result.turnContext).toContain('宵禁时北门未开。')
  })

  it('事实 update 后旧正文不再检索；已冻结轮次仍重放首次快照，下一轮读取新事实', async () => {
    await put('gate', '星港北门关闭。')
    await onTurnStart(state, 'parent', 1)
    const first = await run('星港北门', 'parent', 'live')
    await new MemoryStore(ws.fs.withFloor('parent#t1')).update('gate', { body: '星港北门开放。' })
    expect((await run('星港北门', 'parent', 'live')).turnContext).toBe(first.turnContext)
    await onTurnEnd(state, 'parent')
    await onTurnStart(state, 'parent', 2)
    const next = await run('星港北门', 'parent', 'live')
    expect(next.turnContext).toContain('星港北门开放。')
    expect(next.turnContext).not.toContain('星港北门关闭。')
    await onTurnEnd(state, 'parent')
  })

  it('分支内回退更新只恢复子剧情；兄弟事实与孤立归档不会泄漏', async () => {
    await put('gate', '星港北门关闭。')
    await ws.wal.beginFloor('parent#t1')
    await new MemoryStore(ws.fs.withFloor('parent#t1')).update('gate', { body: '星港北门开放。' })
    await ws.wal.commitFloor('parent#t1')
    const parent = (await state.loadBinding('parent'))!
    const childStory = await state.forkStory(parent, 'child', async (fs) => {
      const wal = new Wal(join(fs.root, 'state', 'wal'))
      await wal.rollbackAfter(['parent#t1'], fs.root)
    })
    await state.saveBinding({ ...parent, sessionId: 'child', storyId: childStory })
    const child = await state.storyWorkspace(cardId, childStory)
    await child.memory.write({ body: '星港密道仅在子剧情出现。' })
    const orphan = await child.memory.write({ body: '星港不存在的藏宝图。' })
    await child.memory.archive([orphan.id])
    const childResult = await run('星港北门', 'child')
    expect(childResult.turnContext).toContain('星港北门关闭。')
    expect(childResult.turnContext).not.toContain('星港北门开放。')
    expect(childResult.turnContext).not.toContain('藏宝图')
    const parentResult = await run('星港北门')
    expect(parentResult.turnContext).toContain('星港北门开放。')
    expect(parentResult.turnContext).not.toContain('星港密道')
  })

  it('多代摘要遗漏的关键细节仍通过可达归档原文入模，工具搜索保留原始结果', async () => {
    await put('key', '陆青把翡翠钥匙藏在钟楼第三块砖后。')
    await ws.memory.mergeBatch(await ws.memory.list(), '陆青妥善保管物品。', 'compress')
    await ws.memory.mergeBatch(await ws.memory.list(), '旧日旅途平安。', 'compress')
    const result = await run('翡翠钥匙')
    expect(result.turnContext).toContain('钟楼第三块砖后')
    const hits = await ws.memory.search('翡翠钥匙')
    expect(hits).toHaveLength(1)
    expect(hits[0]!.entry.archived).toBe(true)
    expect(Object.keys(hits[0]!)).toEqual(['entry', 'score'])
  })

  it('摘要相关性最高时仍允许原文补充摘要未保留的关键细节', async () => {
    await put('detail', '星港钥匙藏在钟楼第三块砖后，只有陆青知道暗号。')
    await ws.memory.mergeBatch(await ws.memory.list(), '星港钥匙', 'compress')
    const hits = await ws.memory.search('星港钥匙', { topK: 2 })
    expect(hits[0]!.entry.archived).toBe(false)
    const result = await run('星港钥匙')
    expect(result.turnContext).toContain('钟楼第三块砖后')
    expect(result.turnContext).toContain('只有陆青知道暗号')
  })

  it('交叉多代来源展开为同一去重叶集合，兼容特殊文件名 JSON 来源', async () => {
    await put('甲,旧事', '钟楼暗号。')
    await put('乙.旧事', '北门暗号。')
    await put('summary-first', '星港摘要一', { sourceRange: 'merge-json:["甲,旧事","乙.旧事"]' })
    await put('summary-second', '星港摘要二', { sourceRange: 'compress-json:["summary-first","乙.旧事"]' })
    await ws.memory.archive(['甲,旧事', '乙.旧事', 'summary-first'])
    const hits = await ws.memory.search('星港', { includeSummarySources: true })
    expect(hits).toHaveLength(2)
    expect(hits.every((hit) => JSON.stringify(hit.summarySourceIds) === JSON.stringify(['乙.旧事', '甲,旧事']))).toBe(true)
  })

  it('来源展开不改变 BM25 分数、半衰期或未来时间戳排序', async () => {
    await put('old', '星港近况：北门关闭。', { updated: '2026-01-01T00:00:00.000Z' })
    await put('new', '星港近况：北门开放。', { updated: '2026-09-01T00:00:00.000Z' })
    await put('future', '星港近况：北门修葺。', { updated: '2026-12-01T00:00:00.000Z' })
    const options = { topK: 8, halfLifeMs: 30 * 86_400_000, now: Date.parse('2026-09-01T00:00:00.000Z') }
    const plain = await ws.memory.search('星港近况', options)
    const candidates = await ws.memory.search('星港近况', { ...options, includeSummarySources: true })
    expect(candidates).toEqual(plain)
    expect(plain.at(-1)!.entry.id).toBe('old')
    expect(plain[0]!.score).toBe(plain[1]!.score)
    config.memory.retrievalTopK = 1
    config.memory.halfLifeDays = 30
    expect((await run('星港近况')).turnContext).not.toContain('北门关闭')
  })

  it('有循环的摘要来源明确拒绝自动入模，不能伪装成互不重复的事实', async () => {
    await put('cycle-a', '星港摘要一', { sourceRange: 'compress:cycle-b' })
    await put('cycle-b', '星港摘要二', { sourceRange: 'compress:cycle-a' })
    await expect(run('星港')).rejects.toThrow('记忆归并来源存在循环')
  })
})
