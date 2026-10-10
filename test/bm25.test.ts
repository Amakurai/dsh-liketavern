/**
 * BM25 索引的行为测试：相关度排序、keys 字段加权（不计入文档长度）、时间衰减、索引维护与确定性，
 * 以及写入去重用的相似度——相同正文为 1、不同事实远低于阈值，且同一对文本的得分不随库规模漂移。
 */
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

  it('只写在 keys 里的词比正文里出现一次的词得分更高', () => {
    const index = new Bm25Index()
    index.add({ id: 'body', text: '她把幽灵船的事告诉了船长' })
    index.add({ id: 'key', text: '她把那艘船的事告诉了船长', keys: ['幽灵船'] })
    index.add({ id: 'other', text: '港口的面包涨价了两个铜板' })
    expect(index.search('幽灵船').map(h => h.id)).toEqual(['key', 'body'])
  })

  it('keys 不计入文档长度：合并了大量 keys 的条目不会在正文词上被压到同分以下', () => {
    const index = new Bm25Index()
    const manyKeys = ['艾琳', '莉莉丝', '罗兰', '塞巴斯', '维多利亚', '白石', '千夏', '诺瓦', '北门', '魔法塔', '港口酒馆', '王都', '地下墓穴', '学院']
    index.add({ id: 'few', text: '艾琳在北门答应保守秘密', keys: ['艾琳'] })
    index.add({ id: 'many', text: '艾琳在北门答应保守秘密', keys: manyKeys })
    index.add({ id: 'weak', text: '罗兰在集市上听说有人要保守秘密，但他并不在意这些传闻，转身就走了' })
    const hits = index.search('保守秘密')
    const score = (id: string): number => hits.find(h => h.id === id)!.score
    // 查询词只出现在正文里，两条正文相同的条目应同分，且都高于只顺带提到的长条目
    expect(score('many')).toBe(score('few'))
    expect(score('many')).toBeGreaterThan(score('weak'))
  })

  it('全库只有 keys、没有正文时仍给出有限分数', () => {
    const index = new Bm25Index()
    index.add({ id: 'a', text: '', keys: ['幽灵船'] })
    index.add({ id: 'b', text: '', keys: ['灯塔'] })
    const hits = index.search('幽灵船')
    expect(hits.map(h => h.id)).toEqual(['a'])
    expect(Number.isFinite(hits[0]!.score)).toBe(true)
    expect(hits[0]!.score).toBeGreaterThan(0)
  })
})

describe('写入去重相似度', () => {
  const fillers = ['港口的面包涨价了两个铜板', '学院今年举办炼金术大赛', '黑猫喜欢在窗台晒太阳', '守卫在午夜换岗',
    '旅店地窖藏着走私火药', '河岸的渡船明晨开航', '铁匠铺收了一个新学徒', '温室里的月光花开了']
  /** 已有条目外加 size - 1 条无关记忆；无关条目带序号，保证各不相同。 */
  function indexOf(existing: string, size: number): Bm25Index {
    const index = new Bm25Index()
    index.add({ id: 'base', text: existing })
    for (let i = 1; i < size; i++) index.add({ id: `m${i}`, text: `${fillers[i % fillers.length]}，这是第${i}件琐事` })
    return index
  }
  const scoreOf = (index: Bm25Index, text: string): number =>
    index.similarity(text, { topK: 1000 }).find(h => h.id === 'base')?.score ?? 0
  const existing = '诺瓦在钟楼修好了断剑，代价是三枚金币。'

  it.each([1, 5, 30, 200])('库规模 %i：相同正文恰好为 1，标点差异不影响', (size) => {
    const index = indexOf(existing, size)
    expect(scoreOf(index, existing)).toBe(1)
    expect(scoreOf(index, '诺瓦在钟楼修好了断剑 代价是三枚金币')).toBe(1)
  })

  it.each([1, 5, 30, 200])('库规模 %i：近似重复高于默认阈值，不同事实低于默认阈值', (size) => {
    const index = indexOf(existing, size)
    const threshold = 0.75
    expect(scoreOf(index, '诺瓦在钟楼修好了断剑，代价是五枚金币。')).toBeGreaterThanOrEqual(threshold)
    expect(scoreOf(index, '诺瓦在钟楼修好了断剑，代价是三枚金币，她很满意。')).toBeGreaterThanOrEqual(threshold)
    // 同人同地的另一件事：旧的 BM25 绝对分在各规模下都把它判成重复
    expect(scoreOf(index, '诺瓦在钟楼捡到一张从没见过的旧地图，决定先瞒着所有人。')).toBeLessThan(0.3)
    expect(scoreOf(index, '诺瓦其实是北境流亡贵族的后裔，这件事还没人知道。')).toBeLessThan(0.1)
    expect(scoreOf(index, '城里新开的裁缝店每天清晨排起长队')).toBe(0)
  })

  it('同一对文本的得分不随库规模漂移', () => {
    const variant = '诺瓦在钟楼修好了断剑，代价是五枚金币。'
    const scores = [1, 5, 30, 200].map(size => scoreOf(indexOf(existing, size), variant))
    expect(Math.max(...scores) - Math.min(...scores)).toBeLessThan(0.02)
  })

  it('长名字加短事件的不同事实仍低于默认阈值', () => {
    for (const size of [1, 30, 200]) {
      expect(scoreOf(indexOf('维多利亚在港口酒馆喝醉了', size), '维多利亚在港口酒馆赢了一局牌')).toBeLessThan(0.75)
    }
  })

  it('双向取小：只是长条目的一小部分，或把短条目扩写成长事实，都不算相同', () => {
    const long = '诺瓦在钟楼修好了断剑，代价是三枚金币，随后她把剑交给了守夜人，并约定月底之前取回。'
    expect(scoreOf(indexOf(long, 30), '诺瓦在钟楼修好了断剑')).toBeLessThan(0.5)
    expect(scoreOf(indexOf('诺瓦在钟楼修好了断剑', 30), long)).toBeLessThan(0.5)
  })

  it('keys 参与比较但不重复加权；结果按分数降序、同分按 id，并遵守 topK', () => {
    const index = new Bm25Index<string>()
    index.add({ id: 'b', text: '幽灵船停在港口', keys: ['幽灵船', '幽灵船'], data: 'B' })
    index.add({ id: 'a', text: '幽灵船停在港口', keys: ['幽灵船'], data: 'A' })
    index.add({ id: 'c', text: '幽灵船停在港口，船长已经失踪三天' })
    const hits = index.similarity('幽灵船停在港口')
    expect(hits.map(h => h.id)).toEqual(['a', 'b', 'c'])
    expect(hits[0]).toEqual({ id: 'a', score: 1, data: 'A' })
    expect(hits[1]!.score).toBe(1)
    expect(hits[2]!.score).toBeLessThan(1)
    expect(index.similarity('幽灵船停在港口', { topK: 1 }).map(h => h.id)).toEqual(['a'])
    expect(index.similarity('幽灵船停在港口', { topK: 0 })).toEqual([])
  })

  it('空索引、无法成词的查询和无共同词时返回空数组', () => {
    expect(new Bm25Index().similarity('幽灵船')).toEqual([])
    const index = indexOf(existing, 3)
    expect(index.similarity('')).toEqual([])
    expect(index.similarity('火')).toEqual([])
    expect(index.similarity('zzz qqq')).toEqual([])
  })

  it('删除与覆盖后不再与旧正文比较', () => {
    const index = indexOf(existing, 5)
    index.add({ id: 'base', text: '完全改写后的另一段话' })
    expect(scoreOf(index, existing)).toBe(0)
    expect(scoreOf(index, '完全改写后的另一段话')).toBe(1)
    index.remove('base')
    expect(scoreOf(index, '完全改写后的另一段话')).toBe(0)
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
