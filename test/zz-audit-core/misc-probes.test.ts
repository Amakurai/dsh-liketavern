/** 审计探针（第三批）：相似度自反性、记忆挑选预算、正则 trim 路径的捕获组语义。 */
import { expect, it } from 'vitest'
import { Bm25Index } from '../../src/core/bm25.js'
import { selectMemoryBodies } from '../../src/core/memoryRetrieval.js'
import { applyRegexRules } from '../../src/core/regex.js'
import type { RegexRule } from '../../src/core/types.js'

it('bm25.similarity：正文与自己比较得 1，且 topK 截断与全量前缀一致', () => {
  const index = new Bm25Index()
  const texts = ['凛在码头等樱', '墨弩的怀表停了', '翡翠令牌被偷了', '鲸鱼游过海峡', '药还剩两包']
  texts.forEach((text, i) => index.add({ id: `m${i}`, text }))
  for (const [i, text] of texts.entries()) {
    const hits = index.similarity(text, { topK: 100 })
    expect(hits[0]?.id, text).toBe(`m${i}`)
    expect(hits[0]?.score, text).toBe(1)
  }
  const full = index.similarity('凛 码头 怀表 令牌', { topK: 100 }).map((h) => h.id)
  for (const k of [1, 2, 3]) {
    expect(index.similarity('凛 码头 怀表 令牌', { topK: k }).map((h) => h.id)).toEqual(full.slice(0, k))
  }
})

it('selectMemoryBodies：不超预算、尊重 topK、超大条目仍兜底一条', () => {
  const hit = (id: string, body: string) => ({ entry: { body }, summarySourceIds: undefined })
  const hits = [hit('a', '甲'.repeat(10)), hit('b', '乙'.repeat(10)), hit('c', '丙'.repeat(10))]
  expect(selectMemoryBodies(hits, 15, 3)).toEqual(['甲'.repeat(10)])
  expect(selectMemoryBodies(hits, 1000, 2)).toHaveLength(2)
  expect(selectMemoryBodies([hit('x', '丁'.repeat(50))], 5)).toHaveLength(1)
})

it('applyRegexRules：trimStrings 作用于捕获组、$0 与 {{match}} 语义', () => {
  const rule = (partial: Partial<RegexRule>): RegexRule => ({
    id: 'r', name: 'r', find: '/<(.+?)>/g', replace: '[$1]', enabled: true,
    scopes: ['output'], timing: ['render'], minDepth: null, maxDepth: null,
    substituteRegex: 0, source: 'card', ...partial,
  })
  expect(applyRegexRules('<axb>', [rule({ trimStrings: ['x'] })], { scope: 'output', timing: 'render' }, { char: 'A', user: 'B' }).text).toBe('[ab]')
  expect(applyRegexRules('<axb>', [rule({ replace: '{{match}}' })], { scope: 'output', timing: 'render' }, { char: 'A', user: 'B' }).text).toBe('<axb>')
  expect(applyRegexRules('<axb>', [rule({ replace: '$0' })], { scope: 'output', timing: 'render' }, { char: 'A', user: 'B' }).text).toBe('$0')
  expect(applyRegexRules('<axb>', [rule({ replace: '$$' })], { scope: 'output', timing: 'render' }, { char: 'A', user: 'B' }).text).toBe('$')
})
