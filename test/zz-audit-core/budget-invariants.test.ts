/** 审计探针：预算/截断类纯函数的契约不变量（结果必须落在给定预算内、不切代理对）。 */
import { expect, it } from 'vitest'
import { clipAssetJsonText, assetOutputTokens } from '../../src/core/assetRead.js'
import { clipToTokenBudget, estimateTokens } from '../../src/core/tokenize.js'
import { clipWorldDeltasForTurn } from '../../src/core/turnBudget.js'
import { budgetMemorySearch } from '../../src/core/memoryToolBudget.js'
import { clipLoreContents, budgetLoreCatalog } from '../../src/core/loreQuery.js'
import type { MemoryEntry, WorldDelta } from '../../src/core/types.js'

const SAMPLES = [
  'abc',
  'a'.repeat(500),
  '汉字测试内容'.repeat(40),
  '😀'.repeat(30),
  '混合 mixed 内容 😀 汉字',
  'x'.repeat(7) + '😀😀😀',
  '\uD83D\uDE00'.repeat(5),
  'ｆｕｌｌｗｉｄｔｈ',
]

const lone = (text: string): boolean => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text)

it('clipToTokenBudget：结果 token 数不超过预算且不产生半个代理对', () => {
  for (const sample of SAMPLES) {
    for (const limit of [0, 1, 2, 3, 4, 5, 8, 16, 40, 120]) {
      const out = clipToTokenBudget(sample, limit)
      expect(out.tokens, `limit=${limit} sample=${JSON.stringify(sample.slice(0, 12))}`).toBeLessThanOrEqual(limit)
      expect(estimateTokens(out.text)).toBeLessThanOrEqual(limit)
      expect(lone(out.text), `limit=${limit} out=${JSON.stringify(out.text)}`).toBe(false)
    }
  }
})

it('clipAssetJsonText：JSON 计费结果不超过预算', () => {
  for (const sample of SAMPLES) {
    for (const limit of [1, 2, 3, 5, 10, 40]) {
      const out = clipAssetJsonText(sample, limit)
      expect(assetOutputTokens(out.text), `limit=${limit} out=${JSON.stringify(out.text.slice(0, 20))}`).toBeLessThanOrEqual(limit)
      expect(lone(out.text)).toBe(false)
    }
  }
})

it('clipWorldDeltasForTurn：保留项总量不超过预算且恢复旧→新顺序', () => {
  const deltas: WorldDelta[] = ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40)].map((content, index) => ({
    id: `d${index}`, content, keys: [], type: 'update', createdAt: index, storyId: 's',
  })) as unknown as WorldDelta[]
  const est = (text: string): number => text.length
  const { kept } = clipWorldDeltasForTurn(deltas, est, 80)
  expect(kept.reduce((sum, d) => sum + est(d.content), 0)).toBeLessThanOrEqual(80)
  expect(kept.map((d) => d.id)).toEqual([...kept.map((d) => d.id)].sort())
})

it('budgetMemorySearch：完整 JSON 不超过预算', () => {
  const entry = (id: string, body: string): MemoryEntry => ({ id, file: `${id}.md`, body, tags: ['t'.repeat(50)], keys: ['k'.repeat(50)], archived: false, sourceRange: '', createdAt: 0 }) as unknown as MemoryEntry
  const hits = [entry('m1', '甲'.repeat(80)), entry('m2', '乙'.repeat(80))].map((item, index) => ({ entry: item, score: 2 - index }))
  for (const limit of [40, 80, 200, 1000]) {
    const res = budgetMemorySearch(hits, limit, { emptyHint: 'hint' })
    expect(res.tokensUsed, `limit=${limit}`).toBeLessThanOrEqual(limit)
  }
})

it('loreQuery 预算：目录与正文输出不超过预算', () => {
  const entries = Array.from({ length: 12 }, (_, index) => ({
    key: `k${index}`, uid: `${index}`, source: 'global' as const, sourceRef: 'audit',
    keys: [`key${index}`], secondaryKeys: [], comment: `c${index}`, content: '正文'.repeat(60),
    enabled: true, constant: false, order: index, position: 0,
  })) as unknown as Parameters<typeof budgetLoreCatalog>[0]
  for (const limit of [300, 800, 2000]) {
    expect(budgetLoreCatalog(entries, limit).tokensUsed, `catalog limit=${limit}`).toBeLessThanOrEqual(limit)
    expect(clipLoreContents(entries, limit).tokensUsed, `content limit=${limit}`).toBeLessThanOrEqual(limit)
  }
})
