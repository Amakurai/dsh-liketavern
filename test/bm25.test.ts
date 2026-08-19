import { describe, expect, it } from 'vitest'
import { Bm25Index } from '../src/core/bm25.js'

interface Memory {
  title: string
}

/** 构造 4 条中文记忆：m1 高频命中「魔法/符文」，m3 仅一次「魔法」，m2/m4 不相关。 */
function makeIndex(): Bm25Index<Memory> {
  const index = new Bm25Index<Memory>()
  index.add({ id: 'm1', text: '艾琳在魔法塔里研究古代魔法符文，每天都练习魔法', data: { title: '魔法研究' } })
  index.add({ id: 'm2', text: '港口酒馆里流传着幽灵船与水手的传说', data: { title: '酒馆传闻' } })
  index.add({ id: 'm3', text: '魔法学院今年举办炼金术大赛', data: { title: '学院赛事' } })
  index.add({ id: 'm4', text: '艾琳的黑猫喜欢在窗台晒太阳', data: { title: '日常琐事' } })
  return index
}

describe('Bm25Index 相关度排序', () => {
  it('query 命中排序：高频文档在前，无命中文档不出现', () => {
    const hits = makeIndex().search('魔法')
    expect(hits.map(h => h.id)).toEqual(['m1', 'm3'])
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
    // data 透传
    expect(hits[0]!.data).toEqual({ title: '魔法研究' })
  })

  it('多 term 查询：同时命中「符文」的文档进一步领先', () => {
    const hits = makeIndex().search('魔法符文')
    expect(hits.map(h => h.id)).toEqual(['m1', 'm3'])
  })

  it('单字查询不成词，返回空数组', () => {
    expect(makeIndex().search('魔')).toEqual([])
  })
})

describe('keys 加权', () => {
  it('相同文本下带 keys 的文档排名更高', () => {
    const index = new Bm25Index()
    index.add({ id: 'a', text: '酒馆里流传着幽灵船的传说' })
    index.add({ id: 'b', text: '酒馆里流传着幽灵船的传说', keys: ['幽灵船'] })
    const hits = index.search('幽灵船')
    expect(hits.map(h => h.id)).toEqual(['b', 'a'])
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score)
  })
})

describe('时间衰减', () => {
  const now = 1_000_000_000

  function makeTimedIndex(): Bm25Index {
    const index = new Bm25Index()
    index.add({ id: 'new', text: '幽灵船的传说', ts: now })
    index.add({ id: 'old', text: '幽灵船的传说', ts: now - 2000 })
    return index
  }

  it('旧文档分数按半衰期降低，固定 now 结果确定', () => {
    const index = makeTimedIndex()
    const base = index.search('幽灵船')
    // 无衰减时两者同分，按 id 字典序 new < old
    expect(base.map(h => h.id)).toEqual(['new', 'old'])

    const decayed = index.search('幽灵船', { halfLifeMs: 1000, now })
    expect(decayed.map(h => h.id)).toEqual(['new', 'old'])
    // old 经过 2 个半衰期 → ×0.25；new 不衰减
    const baseOld = base.find(h => h.id === 'old')!.score
    const decayedOld = decayed.find(h => h.id === 'old')!.score
    const decayedNew = decayed.find(h => h.id === 'new')!.score
    expect(decayedOld).toBeCloseTo(baseOld * 0.25, 10)
    expect(decayedNew).toBeCloseTo(base[0]!.score, 10)
    expect(decayedOld).toBeLessThan(decayedNew)
  })

  it('未来时间戳不放大（衰减因子为 1）', () => {
    const index = new Bm25Index()
    index.add({ id: 'future', text: '幽灵船的传说', ts: now + 60_000 })
    const plain = index.search('幽灵船', { now })
    const decayed = index.search('幽灵船', { halfLifeMs: 1000, now })
    expect(decayed[0]!.score).toBeCloseTo(plain[0]!.score, 10)
  })

  it('文档不带 ts 时不参与衰减', () => {
    const index = new Bm25Index()
    index.add({ id: 'a', text: '幽灵船的传说' })
    const plain = index.search('幽灵船', { now })
    const decayed = index.search('幽灵船', { halfLifeMs: 1000, now })
    expect(decayed[0]!.score).toBeCloseTo(plain[0]!.score, 10)
  })
})

describe('索引维护', () => {
  it('同 id 重复 add = 覆盖', () => {
    const index = new Bm25Index()
    index.add({ id: 'a', text: '魔法塔' })
    index.add({ id: 'a', text: '幽灵船' })
    expect(index.size).toBe(1)
    expect(index.search('魔法')).toEqual([])
    expect(index.search('幽灵').map(h => h.id)).toEqual(['a'])
  })

  it('remove / has / size', () => {
    const index = new Bm25Index()
    index.add({ id: 'a', text: '魔法塔' })
    index.add({ id: 'b', text: '幽灵船' })
    expect(index.size).toBe(2)
    expect(index.has('a')).toBe(true)
    index.remove('a')
    expect(index.has('a')).toBe(false)
    expect(index.size).toBe(1)
    // df 同步撤除：被删文档的专有词不再命中
    expect(index.search('魔法')).toEqual([])
    expect(index.search('幽灵').map(h => h.id)).toEqual(['b'])
    // 删除不存在的 id 不报错
    index.remove('missing')
    expect(index.size).toBe(1)
  })

  it('clear 清空索引', () => {
    const index = makeIndex()
    index.clear()
    expect(index.size).toBe(0)
    expect(index.search('魔法')).toEqual([])
  })

  it('空索引搜索返回空数组', () => {
    expect(new Bm25Index().search('魔法')).toEqual([])
  })
})

describe('确定性', () => {
  it('并列分按 id 字典序升序，且多次搜索一致', () => {
    const index = new Bm25Index()
    index.add({ id: 'c', text: '幽灵船' })
    index.add({ id: 'a', text: '幽灵船' })
    index.add({ id: 'b', text: '幽灵船' })
    const first = index.search('幽灵')
    expect(first.map(h => h.id)).toEqual(['a', 'b', 'c'])
    expect(index.search('幽灵').map(h => h.id)).toEqual(['a', 'b', 'c'])
  })

  it('topK 截断', () => {
    const index = new Bm25Index()
    index.add({ id: 'c', text: '幽灵船' })
    index.add({ id: 'a', text: '幽灵船' })
    index.add({ id: 'b', text: '幽灵船' })
    expect(index.search('幽灵', { topK: 2 }).map(h => h.id)).toEqual(['a', 'b'])
  })
})
