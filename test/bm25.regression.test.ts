/**
 * BM25 查询边界回归：停用词只屏蔽所在位置，撇号变体不丢失人名；
 * 有界选取必须保留完整评分后的前 K 条、同分顺序和文档数据，包括删改后的槽位复用。
 */
import { describe, expect, it } from 'vitest'
import { Bm25Index } from '../src/core/bm25.js'

describe('查询里的停用词与独立单字', () => {
  it('功能词里的字不连带屏蔽其它位置独立出现的同字', () => {
    const index = new Bm25Index()
    index.add({ id: 'dao', text: '道是守桥人，曾经救过船长' })
    const expected = index.search('道去哪了')
    expect(expected.map((hit) => hit.id)).toEqual(['dao'])
    for (const query of ['不知道，道去哪了', '道去哪了，不知道', '不知道\n道去哪了\n不知道']) {
      expect(index.search(query), query).toEqual(expected)
    }
    expect(index.search('不知道')).toEqual([])
  })

  it('被屏蔽位置的词边界不能借给其它位置的构词成分', () => {
    const index = new Bm25Index()
    index.add({ id: 'dao', text: '道是守桥人' })
    expect(index.search('隧道工程')).toEqual([])
    expect(index.search('不知道，隧道工程')).toEqual([])
  })

  it('强调片段也按位置过滤，被 key 或名字声明的单字仍然可检索', () => {
    const index = new Bm25Index()
    index.add({ id: 'dao', text: '道是守桥人' })
    expect(index.search('', { boost: { query: '不知道，道去哪了', weight: 4 } }))
      .toEqual(index.search('', { boost: { query: '道去哪了', weight: 4 } }))
    index.add({ id: 'seven', text: '他替船长保管地图', keys: ['七'] })
    expect(index.search('七点').map((hit) => hit.id)).toEqual(['seven'])
    expect(index.search('不知道', { names: ['道'] }).map((hit) => hit.id)).toEqual(['dao'])
  })
})

describe('英文撇号变体', () => {
  it('人名所有格的撇号变体检索一致，写入去重同样归一', () => {
    const index = new Bm25Index()
    index.add({ id: 'mara', text: "Mara's brass key" })
    index.add({ id: 'letter', text: 'S guards the tower' })
    const expected = index.search('Mara')
    expect(expected.map((hit) => hit.id)).toEqual(['mara'])
    for (const apostrophe of ["'", '’', 'ʼ', '＇']) {
      expect(index.search(`Mara${apostrophe}s`)).toEqual(expected)
      expect(index.similarity(`Mara${apostrophe}s brass key`)[0]).toEqual({ id: 'mara', score: 1 })
      expect(index.search(`it${apostrophe}s`)).toEqual([])
    }
  })
})

describe('单词声明的完整性', () => {
  it('中英混合关键词不把其中的英文功能词提升为全库检索词', () => {
    const index = new Bm25Index()
    index.add({ id: 'lab', text: '实验室收藏了试剂', keys: ['I型'] })
    index.add({ id: 'key', text: 'I buried the brass key near the harbor' })
    expect(index.search('I am here')).toEqual([])
    expect(index.search('I型').map((hit) => hit.id)).toEqual(['lab'])
    // 真正的单项声明仍可解除过滤，删除声明后也必须恢复。
    index.add({ id: 'name', text: '代号', keys: ['I'] })
    expect(index.search('I')).toHaveLength(3)
    index.remove('name')
    expect(index.search('I')).toEqual([])
  })

  it('多个中文片段的 key 或别名不能把其中的功能词当成独立声明', () => {
    for (const labels of [{ keys: ['现在 凛'] }, { aliases: ['现在 凛'] }]) {
      const index = new Bm25Index()
      index.add({ id: 'guard', text: '守桥人', ...labels })
      expect(index.search('现在')).toEqual([])
      expect(index.search('凛').map((hit) => hit.id)).toEqual(['guard'])
      index.add({ id: 'declared', text: '代号', keys: ['现在'] })
      expect(index.search('现在')).toHaveLength(2)
    }
  })
})

describe('有界前 K 条结果', () => {
  it('大量同分与不同长度命中、衰减、强调和槽位复用后仍等于完整排序的前缀', () => {
    const index = new Bm25Index<{ revision: number }>()
    // 倒序入库，让同分较优项最后到达；长正文、关键词和时间共同影响排序。
    for (let i = 399; i >= 0; i--) {
      index.add({ id: `m-${i.toString().padStart(3, '0')}`, text: `harbor ${'cargo '.repeat(i % 9)}`,
        keys: i % 4 === 0 ? ['harbor'] : [], ts: 1_000_000 - (i % 7) * 1000, data: { revision: 0 } })
    }
    for (let i = 0; i < 400; i += 7) index.remove(`m-${i.toString().padStart(3, '0')}`)
    for (let i = 0; i < 400; i += 11) {
      index.add({ id: `m-${i.toString().padStart(3, '0')}`, text: 'harbor cargo', ts: 1_000_000, data: { revision: 1 } })
    }
    for (const options of [{}, { now: 1_000_000, halfLifeMs: 2000, boost: { query: 'cargo', weight: 4 } }]) {
      const all = index.search('harbor', { ...options, topK: Infinity })
      const similar = index.similarity('harbor cargo', { topK: Infinity })
      expect(all.length).toBeGreaterThan(300)
      for (const topK of [1, 2, 5, 17, 200, 399, 1000, 2.9, 0.9, 0, -1, NaN, Infinity, -Infinity]) {
        const count = Math.max(0, topK)
        expect(index.search('harbor', { ...options, topK })).toEqual(all.slice(0, count))
        expect(index.similarity('harbor cargo', { topK })).toEqual(similar.slice(0, count))
      }
    }
  })
})
