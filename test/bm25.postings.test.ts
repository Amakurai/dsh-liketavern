/**
 * 倒排索引的行为回归：增删覆盖后对照独立全扫描评分，确保加速不改变召回、分数和顺序。
 * 参考实现每次从原始文档重建词频，不依赖被测索引的内部统计或私有字段；
 * 单字词的资格（库内或查询内单独成词、功能字、keys 与别名的声明、查询给出的名字、纯单字查询、只有孤立单字的查询）、只给已有命中加分的次级证据、
 * 半权重评分、中英文功能词的剔除、功能字 bigram 的减半与强调片段的加权，也都从原始文档重新推出，
 * 逐项对照被测索引在增删过程中增量维护的结果。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { Bm25Index, type Bm25Doc, type Bm25Hit, type Bm25SearchOptions } from '../src/core/bm25.js'
import { isSeparatorChar, isStopBigram, isStopChar, isStopWord, isWeakBigram } from '../src/core/stopwords.js'
import { analyzeText, isBigramTerm, isKana } from '../src/core/tokenize.js'

/** 一段只含一个字或一个词的文本所声明的词。 */
function single(tokens: ReturnType<typeof analyzeText>): string[] {
  return tokens.terms.length === 0 && tokens.chars.length === 1 ? [tokens.chars[0]!] : tokens.terms.length === 1 ? [tokens.terms[0]!] : []
}

function scanSearch<D>(
  docs: readonly Bm25Doc<D>[], query: string, options: Bm25SearchOptions = {}, k1 = 1.5, b = 0.75,
): Array<Bm25Hit<D>> {
  const topK = options.topK ?? 10
  if (!docs.length || topK <= 0) return []
  const entries = docs.map((doc) => {
    const body = analyzeText(doc.text)
    const keys = (doc.keys ?? []).map((key) => analyzeText(key))
    const aliases = (doc.aliases ?? []).map((alias) => analyzeText(alias))
    const tf = new Map<string, number>()
    const charTf = new Map<string, number>()
    for (const term of body.terms) tf.set(term, (tf.get(term) ?? 0) + 1)
    for (const char of body.chars) charTf.set(char, (charTf.get(char) ?? 0) + 1)
    // 关键词每出现一次折算 2 次词频，且不计入文档长度
    for (const key of keys) {
      for (const term of key.terms) tf.set(term, (tf.get(term) ?? 0) + 2)
      for (const char of key.chars) charTf.set(char, (charTf.get(char) ?? 0) + 2)
    }
    // 别名按 1 倍词频计，同样不计入文档长度
    for (const alias of aliases) {
      for (const term of alias.terms) tf.set(term, (tf.get(term) ?? 0) + 1)
      for (const char of alias.chars) charTf.set(char, (charTf.get(char) ?? 0) + 1)
    }
    const all = [body, ...keys, ...aliases]
    return { doc, tf, charTf, length: body.terms.length,
      initials: new Set(all.flatMap((tokens) => tokens.initials)),
      finals: new Set(all.flatMap((tokens) => tokens.finals)),
      words: new Set(all.flatMap((tokens) => tokens.words)),
      lefts: new Set(all.flatMap((tokens) => tokens.lefts)),
      rights: new Set(all.flatMap((tokens) => tokens.rights)),
      // 整个 key 或别名只有一个字或一个词：声明它是一个词
      declared: new Set([...keys, ...aliases].flatMap(single)) }
  })
  // 本次查询给出的名字按分隔符拆开后各自声明；功能词和单个虚词不算
  const named = new Set((options.names ?? []).flatMap((name) => name.split(/[\s·・•‧]+/u)).flatMap((part) => single(analyzeText(part)))
    .filter((token) => !isStopWord(token) && !isStopBigram(token) && !(token.length === 1 && isSeparatorChar(token))))
  const declared = (token: string): boolean => named.has(token) || entries.some((entry) => entry.declared.has(token))
  // 能产的构词成分：左右两侧各至少两种邻接——不同的相邻字，或紧挨边界的文档
  const bigrams = [...new Set(entries.flatMap((entry) => [...entry.tf.keys()].filter(isBigramTerm)))]
  const productive = (char: string): boolean =>
    bigrams.filter((term) => term[1] === char).length + entries.filter((entry) => entry.initials.has(char)).length >= 2
    && bigrams.filter((term) => term[0] === char).length + entries.filter((entry) => entry.finals.has(char)).length >= 2
  const charDf = (char: string): number => entries.filter((entry) => entry.charTf.has(char)).length
  const evidence = (char: string, isolated: boolean, lone: boolean, wordInQuery: boolean, edgeInQuery: boolean): 'primary' | 'secondary' | undefined => {
    const df = charDf(char)
    if (df === 0) return undefined
    // 明确给出的检索词只有孤立的单字时按字面匹配
    if (declared(char) || (options.explicit === true && isolated)) return 'primary'
    if (isKana(char) || isStopChar(char)) return undefined
    if (isolated) return 'primary'
    // 超过半数文档才排除，且至少要超过 10 条：小库里这个比例没有意义
    if (df > Math.max(10, 0.5 * entries.length)) return undefined
    // 主证据：库里单独成词过，且在这段查询里至少一侧是边界
    const wordInStore = entries.some((entry) => entry.words.has(char))
    if (wordInStore && edgeInQuery) return 'primary'
    // 查询只有孤立的单字时，库里一处开头、另一处收尾即可
    if (lone && entries.some((entry) => entry.lefts.has(char)) && entries.some((entry) => entry.rights.has(char))) return 'primary'
    return wordInStore || wordInQuery || productive(char) ? 'secondary' : undefined
  }
  // 主查询的词权重 1、单字权重 0.5；强调片段在此之上再加 weight 倍；功能词不参与，
  // 两个功能字组成的其它 bigram 减半，被 key 声明的词不受这两条影响
  const termWeights = new Map<string, number>()
  const charWeights = new Map<string, number>()
  const extraWeights = new Map<string, number>()
  const weigh = (text: string, weight: number): void => {
    const tokens = analyzeText(text)
    // 被剔除的功能 bigram 里的字不再单独作证据
    const functional = new Set<string>()
    for (const term of new Set(tokens.terms)) {
      if ((isStopBigram(term) || isStopWord(term)) && !declared(term)) {
        if (isBigramTerm(term)) for (const char of term) functional.add(char)
        continue
      }
      termWeights.set(term, (termWeights.get(term) ?? 0) + weight * (isWeakBigram(term) && !declared(term) ? 0.5 : 1))
    }
    const words = new Set(tokens.words)
    const sides = new Set(tokens.sides)
    for (const char of new Set(tokens.chars)) {
      if (functional.has(char) && !declared(char)) continue
      const kind = evidence(char, tokens.terms.length === 0, tokens.lone, words.has(char), sides.has(char))
      if (!kind) continue
      // 任一段文本里算主证据，就整体按主证据计
      if (kind === 'primary' || charWeights.has(char)) {
        charWeights.set(char, (charWeights.get(char) ?? 0) + (extraWeights.get(char) ?? 0) + weight * 0.5)
        extraWeights.delete(char)
      } else {
        extraWeights.set(char, (extraWeights.get(char) ?? 0) + weight * 0.5)
      }
    }
  }
  weigh(query, 1)
  const boost = options.boost && Number.isFinite(options.boost.weight) && options.boost.weight > 0 ? options.boost : undefined
  if (boost) weigh(boost.query, boost.weight)
  const avgdl = entries.reduce((sum, entry) => sum + entry.length, 0) / entries.length
  const hits: Array<Bm25Hit<D>> = []
  for (const entry of entries) {
    let score = 0
    let matched = false
    // 全库正文为空（只有 keys）时没有长度信息，归一化因子取 1
    const norm = avgdl > 0 ? 1 - b + (b * entry.length) / avgdl : 1
    const add = (tf: number | undefined, df: number, weight: number): void => {
      if (tf === undefined) return
      const idf = Math.log(1 + (entries.length - df + 0.5) / (df + 0.5))
      score += weight * ((idf * tf * (k1 + 1)) / (tf + k1 * norm))
      matched = true
    }
    for (const [term, weight] of termWeights) {
      add(entry.tf.get(term), entries.filter((candidate) => candidate.tf.has(term)).length, weight)
    }
    for (const [char, weight] of charWeights) add(entry.charTf.get(char), charDf(char), weight)
    // 次级证据只加到已有主证据命中的文档上
    if (matched) for (const [char, weight] of extraWeights) add(entry.charTf.get(char), charDf(char), weight)
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

describe('别名与查询选项对照全扫描', () => {
  it('别名、查询给出的名字、按字面检索与增删覆盖交错时，结果与从原始文档重算一致', () => {
    const docs: Bm25Doc[] = [
      { id: 'a', text: '医务室的止痛剂上个月少了两箱，值班记录被人改过', aliases: ['药', '失窃', '偷药'] },
      { id: 'b', text: '他是凛早年的搭档，三年前在南方失踪', aliases: ['七'] },
      { id: 'c', text: '七天后补给船才会到', keys: ['补给船'] },
      { id: 'd', text: '日向在练剑，樱在旁边看', aliases: ['剑道'] },
      { id: 'e', text: '北门每晚亥时落锁' },
      { id: 'f', text: 'Mara keeps the brass key in a hollow book', aliases: ['hiding place', 'Key'] },
    ]
    const index = new Bm25Index()
    for (const doc of docs) index.add(doc)
    const queries: Array<[string, Bm25SearchOptions]> = [
      ['谁在偷药', {}], ['七后来找到了吗', {}], ['七', { explicit: true }], ['日向', { names: ['日向'] }], ['日向和樱', {}],
      ['月呢', { names: ['月', '我'] }], ['where is the key', {}], ['失窃的药品', { boost: { query: '药', weight: 4 } }], ['的', { explicit: true }],
    ]
    const check = (current: readonly Bm25Doc[]): void => {
      for (const [query, options] of queries) {
        const expected = scanSearch(current, query, { topK: 50, ...options })
        const actual = index.search(query, { topK: 50, ...options })
        assert.deepEqual(actual.map((hit) => hit.id), expected.map((hit) => hit.id), query)
        actual.forEach((hit, i) => assert.ok(Math.abs(hit.score - expected[i]!.score) < 1e-9, `${query} ${hit.id}`))
      }
    }
    check(docs)
    // 去掉别名、换一组别名、删除带声明的文档
    const stripped = docs.map((doc) => (doc.id === 'a' ? { id: 'a', text: doc.text } : doc))
    index.add(stripped[0]!)
    check(stripped)
    const swapped = stripped.map((doc) => (doc.id === 'd' ? { ...doc, aliases: ['日向', '樱'] } : doc))
    index.add(swapped[3]!)
    check(swapped)
    index.remove('b')
    check(swapped.filter((doc) => doc.id !== 'b'))
  })
})

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
    for (const query of ['幽灵船', '共同记忆 harbor', '魔法 灯塔 幽灵船', '不存在', '', '船', '魔']) {
      for (const topK of [0, 1, 7, 10, 200, Infinity]) {
        for (const boost of [undefined, { query: '幽灵船', weight: 3 }, { query: '灯', weight: 2 }]) {
          const options = { topK, halfLifeMs: 20_000, now, ...(boost ? { boost } : {}) }
          assert.deepEqual(index.search(query, options), scanSearch(docs, query, options))
        }
      }
    }
  })

  it('固定种子的增删覆盖序列逐步与全扫描结果一致', () => {
    const words = ['魔法', '幽灵船', '灯塔', '港口', 'harbor', 'Café', 'Привет', '안녕하세요', 'かな', '', '!!!', '凛', '凛的剑', '没有', '七', '叫樱，', 'the', 'is', '打听', '打开', '在打', '，现在', '发现']
    const queries = ['魔法 幽灵船', 'harbor Café', 'Привет 안녕하세요', '灯塔 灯塔 かな', '不存在', '', '船', '魔 塔 か', '港湾的灯', '凛去哪了', '没有船的港口', '七', '七的剑呢', '樱的剑还在吗', 'the harbor is the café', '周末打算去港口', '船打魔法', '现在知道凛在港口', '凛现在在哪']
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
            keys: next(4) === 0 ? [words[next(words.length)]!, '七'] : next(9) === 0 ? ['the'] : [words[next(words.length)]!], data: step,
            ...(next(3) === 0 ? {} : { ts: 1_000_000 + next(100_000) - 50_000 }),
          }
          index.add(doc)
          docs.set(id, doc)
        }
        assert.equal(index.size, docs.size)
        for (const query of queries) {
          const options: Bm25SearchOptions = { now: 1_000_000, halfLifeMs: next(2) ? 20_000 : 0, topK: next(12),
            // 权重 0 的片段应被忽略
            ...(next(3) === 0 ? { boost: { query: queries[next(queries.length)]!, weight: next(4) } } : {}) }
          assert.deepEqual(index.search(query, options), scanSearch([...docs.values()], query, options, parameters.k1, parameters.b))
        }
      }
    }
  })
})
