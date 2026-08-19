/**
 * 长期记忆检索治理测试。
 * 覆盖：半衰期天数换算/关闭，以及超大首条不会挡住后续可用记忆、全超限时截取首条。
 */
import { describe, expect, it } from 'vitest'
import { memorySearchOptions, selectMemoryBodies } from '../src/core/memoryRetrieval.js'
import { estimateTokens } from '../src/core/tokenize.js'

const hit = (body: string) => ({ entry: { body } })

describe('memorySearchOptions', () => {
  it('把正数天数换成毫秒，0 表示关闭衰减', () => {
    expect(memorySearchOptions(5.9, 30)).toEqual({ topK: 5, halfLifeMs: 30 * 24 * 60 * 60 * 1000 })
    expect(memorySearchOptions(5, 0)).toEqual({ topK: 5 })
  })
})

describe('selectMemoryBodies', () => {
  it('跳过装不下的高分大条目，继续选择后续完整小条目', () => {
    expect(selectMemoryBodies([hit('汉'.repeat(100)), hit('短记忆'), hit('另一条')], 5)).toEqual(['短记忆'])
  })

  it('没有任何完整条目可用时截取最高相关条目且不超预算', () => {
    const selected = selectMemoryBodies([hit('汉'.repeat(100)), hit('字'.repeat(80))], 12)
    expect(selected).toHaveLength(1)
    expect(selected[0]).toContain('已截断')
    expect(estimateTokens(selected[0]!)).toBeLessThanOrEqual(12)
  })

  it('预算为零时不注入', () => {
    expect(selectMemoryBodies([hit('记忆')], 0)).toEqual([])
  })
})
