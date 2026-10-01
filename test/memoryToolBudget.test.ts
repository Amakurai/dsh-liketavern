/** 记忆工具完整预算的纯函数回归：正文、展示元数据、定位字段、JSON 转义和极小预算边界均不改变原存储数据。 */
import { expect, it } from 'vitest'
import { budgetMemorySearch } from '../src/core/memoryToolBudget.js'
import { assetOutputTokens } from '../src/core/assetRead.js'
import type { MemoryEntry } from '../src/core/types.js'

const entry = (patch: Partial<MemoryEntry> = {}): MemoryEntry => ({ id: 'm1', file: 'm1.md', created: '2026-01-01T00:00:00.000Z', updated: '2026-01-01T00:00:00.000Z',
  sourceRange: 't1', archived: false, body: '灯塔钥匙已经归还', tags: ['事实'], keys: ['灯塔钥匙'], ...patch })
const hit = (patch: Partial<MemoryEntry> = {}) => ({ entry: entry(patch), score: 1 })

it('正常正文和全部短元数据保持完整，tokensUsed包括包装和自身字段', () => {
  const input = hit(), original = JSON.stringify(input)
  const result = budgetMemorySearch([input], 1200)
  expect(result).toMatchObject({ ok: true, count: 1, omitted: 0, truncated: false, results: [{ id: 'm1', path: 'memory/m1.md', archived: false,
    sourceRange: 't1', body: input.entry.body, tags: ['事实'], keys: ['灯塔钥匙'], metadataTruncated: false, truncated: false }] })
  expect(result.tokensUsed).toBe(assetOutputTokens(result))
  expect(JSON.stringify(input)).toBe(original)
})

it('巨大标签明确展示裁剪，完整元数据 JSON 成本计入预算而原始数组不变', () => {
  const input = hit({ tags: ['界'.repeat(5000)], keys: ['灯塔钥匙'] })
  const result = budgetMemorySearch([input], 1200)
  expect(assetOutputTokens(result)).toBeLessThanOrEqual(1200)
  expect(result.results?.[0]).toMatchObject({ tagsTruncated: true, metadataTruncated: true, body: input.entry.body })
  expect(input.entry.tags).toEqual(['界'.repeat(5000)])
})

it('sourceRange只完整保留或明确省略，归档定位按真实文件路径保留', () => {
  const result = budgetMemorySearch([hit({ file: 'archive/m1.md', archived: true, sourceRange: '来源楼层'.repeat(2000) })], 600)
  expect(result.results?.[0]).toMatchObject({ id: 'm1', path: 'memory/archive/m1.md', archived: true, sourceRangeOmitted: true, metadataTruncated: true })
  expect(result.results?.[0]?.sourceRange).toBeUndefined()
  expect(assetOutputTokens(result)).toBeLessThanOrEqual(600)
})

it('完整定位行不能容纳时整条省略，后续短定位仍可发现', () => {
  const result = budgetMemorySearch([hit({ id: '定位'.repeat(1000), file: `${'定位'.repeat(1000)}.md` }), hit({ id: 'short', file: 'short.md' })], 600)
  expect(result).toMatchObject({ count: 2, omitted: 1, truncated: true, results: [{ id: 'short', path: 'memory/short.md' }] })
  expect(result.results).toHaveLength(1)
  expect(assetOutputTokens(result)).toBeLessThanOrEqual(600)
})

it('转义正文和大量空字符串数组都按整个 pretty JSON 收口', () => {
  for (const patch of [{ body: '\u0000'.repeat(10000), tags: ['超长展示'.repeat(1000)] },
    { body: '短正文', keys: Array.from({ length: 5000 }, () => ''), tags: Array.from({ length: 5000 }, () => '') }]) {
    const result = budgetMemorySearch([hit(patch)], 600)
    expect(assetOutputTokens(result)).toBeLessThanOrEqual(600)
    expect(result.tokensUsed).toBe(assetOutputTokens(result))
    expect(result.truncated).toBe(true)
  }
})

it('正文耗尽后不继续输出其他命中的完整元数据，omitted与实际整条省略数一致', () => {
  const hits = Array.from({ length: 20 }, (_, i) => hit({ id: `m${i}`, file: `m${i}.md`, body: '巨型正文'.repeat(1000), tags: ['标签'.repeat(1000)] }))
  const result = budgetMemorySearch(hits, 600)
  expect(result.omitted).toBe(hits.length - result.results!.length)
  expect(result.omitted).toBeGreaterThan(0)
  expect(assetOutputTokens(result)).toBeLessThanOrEqual(600)
})

it('零或不足响应头的预算固定拒绝，错误用量仍如实计费且不含命中', () => {
  for (const budget of [0, 1, NaN]) {
    const result = budgetMemorySearch([hit()], budget)
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('memory-budget-too-small') })
    expect(result.results).toBeUndefined()
    expect(result.tokensUsed).toBe(assetOutputTokens(result))
    expect(assetOutputTokens(result)).toBeLessThanOrEqual(100)
  }
})
