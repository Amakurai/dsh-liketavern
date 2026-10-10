/**
 * 记忆入模选择的边界回归：空正文不能吞掉截断兜底，重复正文不能挤占其它事实的预算。
 * 只验证选择视图，不修改输入或把相似但不同的事实当作重复记忆。
 * 另含自动入模查询的构造：取最近若干条消息，并只在合适的时候强调最新用户输入。
 */
import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { MEMORY_FOCUS_BOOST, memoryCandidateCount, memoryQuery, memorySearchOptions, selectMemoryBodies } from '../src/core/memoryRetrieval.js'
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

describe('自动入模的查询构造', () => {
  const user = (content: string) => ({ role: 'user', content })
  const assistant = (content: string) => ({ role: 'assistant', content })

  it('取最近 N 条非空消息拼接，最后一条用户输入作为强调片段', () => {
    const messages = [user('最早的话'), assistant('第一段叙述'), user(''), assistant('第二段叙述'), user('钥匙在哪')]
    assert.deepEqual(memoryQuery(messages, 4), {
      query: '第一段叙述\n第二段叙述\n钥匙在哪',
      boost: { query: '钥匙在哪', weight: MEMORY_FOCUS_BOOST },
    })
  })

  it('续写或重新生成时最后一条是助手，不强调任何片段', () => {
    assert.deepEqual(memoryQuery([user('钥匙在哪'), assistant('一段叙述')], 4), { query: '钥匙在哪\n一段叙述' })
  })

  it('窗口里只有这一条输入时不强调：全部词等比放大不改变排序', () => {
    assert.deepEqual(memoryQuery([user('钥匙在哪')], 4), { query: '钥匙在哪' })
    assert.deepEqual(memoryQuery([assistant('一段叙述'), user('钥匙在哪')], 1), { query: '钥匙在哪' })
    assert.deepEqual(memoryQuery([assistant('  '), user('钥匙在哪')], 4), { query: '钥匙在哪' })
  })

  it('最新输入为空白（例如只有图片）时不强调，空历史返回空查询', () => {
    assert.deepEqual(memoryQuery([assistant('一段叙述'), assistant('又一段'), user('  ')], 4), { query: '一段叙述\n又一段' })
    assert.deepEqual(memoryQuery([], 4), { query: '' })
  })

  it('条数按正整数处理，非法值退回 1 条', () => {
    const messages = [assistant('甲'), assistant('乙'), user('丙')]
    assert.equal(memoryQuery(messages, 2.9).query, '乙\n丙')
    for (const count of [0, -3, Number.NaN, Infinity]) assert.equal(memoryQuery(messages, count).query, '丙')
  })

  it('不修改传入的消息', () => {
    const messages = Object.freeze([Object.freeze(assistant('一段叙述')), Object.freeze(user('钥匙在哪'))])
    memoryQuery(messages, 4)
    assert.deepEqual(messages, [assistant('一段叙述'), user('钥匙在哪')])
  })
})

describe('记忆检索参数归一化', () => {
  it('入模候选为最终条数四倍且最多 200；零、非法和极小值保持关闭', () => {
    for (const topK of [NaN, Infinity, -Infinity, -1, 0, 0.9]) expectCandidate(topK, 0)
    expectCandidate(1, 4)
    expectCandidate(5.9, 20)
    expectCandidate(50, 200)
    expectCandidate(Number.MAX_VALUE, 200)
  })

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

function expectCandidate(topK: number, expected: number): void {
  assert.equal(memoryCandidateCount(topK), expected)
}

describe('最终条数与保守来源多样性', () => {
  const summary = (body: string, sources: string[]) => ({ entry: { body }, summarySourceIds: sources })

  it('同一来源集合的重复摘要延后补位，保留相关性最高摘要与另一独立事实', () => {
    const hits = [summary('星港摘要一', ['a', 'b']), summary('星港摘要二', ['b', 'a', 'a']), hit('北门关闭')]
    assert.deepEqual(selectMemoryBodies(hits, 100, 2), ['星港摘要一', '北门关闭'])
    assert.deepEqual(selectMemoryBodies(hits, 100, 3), ['星港摘要一', '北门关闭', '星港摘要二'])
  })

  it('只判断完整来源集合相同；交叠来源、归档原文和否定事实仍可补充', () => {
    const hits = [summary('北门已开', ['a', 'b']), summary('南门关闭', ['b', 'c']), hit('北门未开')]
    assert.deepEqual(selectMemoryBodies(hits, 100, 3), ['北门已开', '南门关闭', '北门未开'])
  })

  it('装不下的摘要不提前占据来源，后面的短摘要仍可用', () => {
    assert.deepEqual(selectMemoryBodies([summary('星港'.repeat(100), ['a']), summary('北门已开', ['a'])], 5, 1), ['北门已开'])
  })

  it('最终条数为零或非法时也不能触发超长兜底', () => {
    for (const limit of [0, -1, 0.9, NaN, Infinity]) assert.deepEqual(selectMemoryBodies([hit('古城'.repeat(100))], 10, limit), [])
  })

  it('不同条数和预算下，完整和截断结果都遵守条数、正文去重与预算', () => {
    const hits = [summary('星港'.repeat(100), ['a']), summary('北门关闭', ['a']), summary('北门仍关闭', ['a']),
      hit('钟楼钥匙'), hit('钟楼钥匙'), hit('桥头受伤'), hit(' ') ]
    for (let topK = 0; topK < 8; topK++) {
      for (let budget = 0; budget < 140; budget++) {
        const selected = selectMemoryBodies(hits, budget, topK)
        assert.ok(selected.length <= topK)
        assert.equal(new Set(selected.map((body) => body.trim())).size, selected.length)
        assert.ok(selected.reduce((sum, body) => sum + estimateTokens(body), 0) <= budget)
      }
    }
  })
})
