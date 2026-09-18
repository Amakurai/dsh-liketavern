/**
 * 记忆入模选择的边界回归：空正文不能吞掉截断兜底，重复正文不能挤占其它事实的预算。
 * 只验证选择视图，不修改输入或把相似但不同的事实当作重复记忆。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { memorySearchOptions, selectMemoryBodies } from '../src/core/memoryRetrieval.js'
import { estimateTokens } from '../src/core/tokenize.js'

const hit = (body: string) => ({ entry: { body } })

describe('记忆检索预算边界', () => {
  it('相同正文只占一次预算，给后续不同事实留出空间', () => {
    assert.deepEqual(selectMemoryBodies([hit('古城'), hit('古城'), hit('盟约')], 4), ['古城', '盟约'])
  })

  it('去重忽略首尾空白，但保留首个选中正文的原始格式', () => {
    assert.deepEqual(selectMemoryBodies([hit('  古城  '), hit('古城'), hit('盟约')], 5), ['  古城  ', '盟约'])
  })

  it('超限且未选中的条目，不阻止后续更短的同正文条目', () => {
    assert.deepEqual(selectMemoryBodies([hit(`${' '.repeat(40)}古城`), hit('古城')], 2), ['古城'])
  })

  it('不做语义去重，不合并否定事实或正文内部空白', () => {
    const bodies = ['北门已开', '北门未开', 'A  B', 'A B']
    assert.deepEqual(selectMemoryBodies(bodies.map(hit), 20), bodies)
  })

  it('空正文和纯空白不能抑制最高相关超长条目的截断兜底', () => {
    const selected = selectMemoryBodies([hit('汉'.repeat(100)), hit(''), hit(' \n\t ')], 12)
    assert.equal(selected.length, 1)
    assert.ok(selected[0]!.startsWith('汉'))
    assert.ok(selected[0]!.includes('已截断'))
    assert.ok(estimateTokens(selected[0]!) <= 12)
  })

  it('只有空正文时不注入记忆', () => {
    assert.deepEqual(selectMemoryBodies([hit(''), hit(' \n\t ')], 20), [])
  })

  it('非法、非有限或不足一个 token 的预算不注入', () => {
    for (const budget of [NaN, Infinity, -Infinity, -1, 0, 0.9]) {
      assert.deepEqual(selectMemoryBodies([hit('古城')], budget), [])
    }
    assert.deepEqual(selectMemoryBodies([hit('古城'), hit('盟约')], 4.9), ['古城', '盟约'])
  })

  it('候选是只读快照，选择不改变输入', () => {
    const hits = Object.freeze([Object.freeze({ entry: Object.freeze({ body: '古城' }) }), hit('古城'), hit('盟约')])
    const before = JSON.stringify(hits)
    selectMemoryBodies(hits, 4)
    assert.equal(JSON.stringify(hits), before)
  })

  it('不同预算下始终非空、去重，且正文 token 总量不超预算', () => {
    const hits = ['', '古城', '古城', '盟约', ' \n ', '汉'.repeat(100), 'another fact', '  盟约  '].map(hit)
    for (let budget = 0; budget < 140; budget++) {
      const selected = selectMemoryBodies(hits, budget)
      assert.ok(selected.every((body) => body.trim().length > 0))
      assert.equal(new Set(selected.map((body) => body.trim())).size, selected.length)
      assert.ok(selected.reduce((sum, body) => sum + estimateTokens(body), 0) <= budget)
    }
  })
})

describe('记忆检索参数归一化', () => {
  it('topK 拒绝非有限值，有限值按非负整数处理', () => {
    for (const topK of [NaN, Infinity, -Infinity, -1, 0.9]) {
      assert.deepEqual(memorySearchOptions(topK, 0), { topK: 0 })
    }
    assert.deepEqual(memorySearchOptions(5.9, 30), { topK: 5, halfLifeMs: 30 * 86_400_000 })
  })

  it('半衰期天数非法或换算溢出时关闭衰减', () => {
    for (const days of [NaN, Infinity, -Infinity, -1, 0, Number.MAX_VALUE]) {
      assert.deepEqual(memorySearchOptions(5, days), { topK: 5 })
    }
    assert.deepEqual(memorySearchOptions(5, 0.5), { topK: 5, halfLifeMs: 43_200_000 })
  })
})
