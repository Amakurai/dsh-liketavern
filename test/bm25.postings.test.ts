/**
 * 倒排索引的行为回归：增删覆盖后对照独立全扫描评分，确保加速不改变召回、分数和顺序。
 * 参考实现每次从原始文档重建词频，不依赖被测索引的内部统计或私有字段。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { Bm25Index, type Bm25Doc, type Bm25Hit, type Bm25SearchOptions } from '../src/core/bm25.js'
import { tokenize } from '../src/core/tokenize.js'

function scanSearch<D>(
  docs: readonly Bm25Doc<D>[], query: string, options: Bm25SearchOptions = {}, k1 = 1.5, b = 0.75,
): Array<Bm25Hit<D>> {
  const topK = options.topK ?? 10
  if (!docs.length || topK <= 0) return []
  const terms = [...new Set(tokenize(query))]
  const entries = docs.map((doc) => {
    const tokens = [...tokenize(doc.text), ...tokenize((doc.keys ?? []).join(' '))]
    const tf = new Map<string, number>()
    for (const term of tokens) tf.set(term, (tf.get(term) ?? 0) + 1)
    return { doc, tf, length: tokens.length }
  })
  const avgdl = entries.reduce((sum, entry) => sum + entry.length, 0) / entries.length
  const hits: Array<Bm25Hit<D>> = []
  for (const entry of entries) {
    let score = 0
    for (const term of terms) {
      const tf = entry.tf.get(term)
      if (tf === undefined) continue
      const df = entries.filter((candidate) => candidate.tf.has(term)).length
      const idf = Math.log(1 + (entries.length - df + 0.5) / (df + 0.5))
      const norm = 1 - b + (b * entry.length) / avgdl
      score += (idf * tf * (k1 + 1)) / (tf + k1 * norm)
    }
    if (score <= 0) continue
    const halfLifeMs = options.halfLifeMs ?? 0
    const elapsed = (options.now ?? Date.now()) - (entry.doc.ts ?? Infinity)
    if (halfLifeMs > 0 && elapsed > 0) score *= Math.pow(0.5, elapsed / halfLifeMs)
    const hit: Bm25Hit<D> = { id: entry.doc.id, score }
    if (entry.doc.data !== undefined) hit.data = entry.doc.data
    hits.push(hit)
  }
  return hits.sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).slice(0, topK)
}

describe('BM25 倒排索引', () => {
  it('覆盖与删除同步清理正文及 keys，重新加入后不留下旧词频', () => {
    const index = new Bm25Index()
    index.add({ id: 'a', text: '魔法 魔法', keys: ['幽灵船'] })
    index.add({ id: 'b', text: '魔法' })
    index.add({ id: 'a', text: '港口', keys: ['灯塔'] })
    assert.deepEqual(index.search('幽灵船'), [])
    assert.deepEqual(index.search('魔法').map((hit) => hit.id), ['b'])
    assert.deepEqual(index.search('灯塔').map((hit) => hit.id), ['a'])
    index.remove('a')
    index.remove('missing')
    assert.deepEqual(index.search('港口 灯塔'), [])
    index.add({ id: 'a', text: '魔法' })
    assert.deepEqual(index.search('魔法'), scanSearch([{ id: 'a', text: '魔法' }, { id: 'b', text: '魔法' }], '魔法'))
  })

  it('空文档仍参与平均长度，重复词不重复增加文档频率', () => {
    const docs = [
      { id: 'empty', text: '' },
      { id: 'a', text: 'magic magic magic', keys: ['magic', 'magic'] },
      { id: 'b', text: 'magic harbor' },
      { id: 'keys-only', text: '', keys: ['magic'] },
    ]
    const index = new Bm25Index()
    docs.forEach((doc) => index.add(doc))
    assert.deepEqual(index.search('magic magic'), scanSearch(docs, 'magic'))
  })

  it('clear 后重新建立索引，与全新实例一致', () => {
    const index = new Bm25Index()
    index.add({ id: 'old', text: '魔法 幽灵船' })
    index.clear()
    assert.equal(index.size, 0)
    index.add({ id: 'new', text: '港口 灯塔' })
    assert.deepEqual(index.search('魔法 幽灵船'), [])
    assert.deepEqual(index.search('港口 灯塔'), scanSearch([{ id: 'new', text: '港口 灯塔' }], '港口 灯塔'))
  })

  it('稀疏/稠密命中、keys、时间衰减和 topK 均保持原有结果', () => {
    const now = 1_000_000
    const docs = Array.from({ length: 200 }, (_, i) => ({
      id: `m-${i}`, text: `共同记忆 harbor ${i % 25 === 0 ? '幽灵船' : '灯塔'}`,
      keys: i % 10 === 0 ? ['魔法', '幽灵船'] : [], ts: now + (i - 100) * 1_000, data: { i },
    }))
    const index = new Bm25Index<{ i: number }>()
    docs.forEach((doc) => index.add(doc))
    for (const query of ['幽灵船', '共同记忆 harbor', '魔法 灯塔 幽灵船', '不存在', '']) {
      for (const topK of [0, 1, 7, 10, 200, Infinity]) {
        const options = { topK, halfLifeMs: 20_000, now }
        assert.deepEqual(index.search(query, options), scanSearch(docs, query, options))
      }
    }
  })

  it('固定种子的增删覆盖序列逐步与全扫描结果一致', () => {
    const words = ['魔法', '幽灵船', '灯塔', '港口', 'harbor', 'Café', 'Привет', '안녕하세요', 'かな', '', '!!!']
    const queries = ['魔法 幽灵船', 'harbor Café', 'Привет 안녕하세요', '灯塔 灯塔 かな', '不存在', '']
    let seed = 0x51a7
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % n
    }
    for (const parameters of [{ k1: 1.5, b: 0.75 }, { k1: 0, b: 0 }, { k1: 1.2, b: 1 }]) {
      const index = new Bm25Index<number>(parameters)
      const docs = new Map<string, Bm25Doc<number>>()
      for (let step = 0; step < 250; step++) {
        const id = `m-${next(50)}`
        if (step > 0 && step % 83 === 0) {
          index.clear()
          docs.clear()
        } else if (next(5) === 0) {
          index.remove(id)
          docs.delete(id)
        } else {
          const doc: Bm25Doc<number> = {
            id, text: Array.from({ length: next(8) }, () => words[next(words.length)]!).join(' '),
            keys: [words[next(words.length)]!], data: step,
            ...(next(3) === 0 ? {} : { ts: 1_000_000 + next(100_000) - 50_000 }),
          }
          index.add(doc)
          docs.set(id, doc)
        }
        assert.equal(index.size, docs.size)
        for (const query of queries) {
          const options = { now: 1_000_000, halfLifeMs: next(2) ? 20_000 : 0, topK: next(12) }
          assert.deepEqual(index.search(query, options), scanSearch([...docs.values()], query, options, parameters.k1, parameters.b))
        }
      }
    }
  })
})
