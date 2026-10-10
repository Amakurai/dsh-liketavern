/**
 * 记忆检索留出集：规则定稿之后才写的另一个故事世界（32 条记忆、35 个场景），用来检查规则是否只对开发集好看。
 * 口径与开发集相同（memoryQuery + Bm25Index，前 5）。记忆正文、查询和期望自写成后没有改动；
 * 这里按实际结果断言，包括没通过的场景——哪天通过了，说明行为变了，同样应当被注意到。
 *
 * 首次运行（规则未作任何调整）：single 7/9、focus 6/6、context 3/4、mixed 3/3、无关短句 0/8 有命中、换说法 2/5。
 * 之后有两处规则是看着它的失败改的，所以 single 一类已经不能算独立检验：
 * - 被剔除的功能 bigram（「现在」）里的字（「现」）仍被单独拿去匹配——修正后 single 8/9；
 * - 只有孤立单字的查询（「豆在哪」）放宽库内证据：一处开头、另一处收尾即可——修正后 single 9/9。
 * 剩下没通过的四个场景靠字面匹配解决不了，原因分别写在对应的用例里。
 */
import { describe, expect, it } from 'vitest'
import { Bm25Index } from '../src/core/bm25.js'
import { memoryQuery } from '../src/core/memoryRetrieval.js'
import { HOLDOUT_MEMORIES, HOLDOUT_SCENARIOS, type HoldoutScenario } from './memoryRecallHoldout.fixture.js'
import type { EvalMemory } from './memoryRecallEval.fixture.js'

const TOP = 5

function indexOf(memories: readonly EvalMemory[]): Bm25Index {
  const index = new Bm25Index()
  for (const memory of memories) index.add({ id: memory.id, text: memory.body, keys: memory.keys })
  return index
}

const index = indexOf(HOLDOUT_MEMORIES)
const bodyOf = new Map(HOLDOUT_MEMORIES.map((memory) => [memory.id, memory.body]))
const scenarioOf = (id: string): HoldoutScenario => HOLDOUT_SCENARIOS.find((scenario) => scenario.id === id)!

function rank(scenario: HoldoutScenario, target: Bm25Index = index): string[] {
  const { query, boost } = memoryQuery(scenario.messages, 4)
  return target.search(query, { topK: HOLDOUT_MEMORIES.length, ...(boost ? { boost } : {}) }).map((hit) => hit.id)
}

function passed(scenario: HoldoutScenario): boolean {
  const ranked = rank(scenario)
  const top = ranked.slice(0, TOP)
  return (scenario.expected.length === 0 || top.includes(scenario.expected[0]!))
    && (scenario.mention === undefined || (top.length > 0 && top.every((id) => bodyOf.get(id)!.includes(scenario.mention!))))
}

const failedOf = (kind: HoldoutScenario['kind']): string[] =>
  HOLDOUT_SCENARIOS.filter((scenario) => scenario.kind === kind && !passed(scenario)).map((scenario) => scenario.id)
const countOf = (kind: HoldoutScenario['kind']): number => HOLDOUT_SCENARIOS.filter((scenario) => scenario.kind === kind).length

describe('留出集', () => {
  it('场景期望都指向存在的记忆', () => {
    for (const scenario of HOLDOUT_SCENARIOS) {
      for (const id of scenario.expected) expect(bodyOf.has(id), `${scenario.id} → ${id}`).toBe(true)
    }
    expect({ single: countOf('single'), focus: countOf('focus'), context: countOf('context'), mixed: countOf('mixed'),
      none: countOf('none'), paraphrase: countOf('paraphrase') }).toEqual({ single: 9, focus: 6, context: 4, mixed: 3, none: 8, paraphrase: 5 })
  })

  it('单字场景 9/9：从未被两侧同时夹住的单字名，单独问起时也能找到', () => {
    expect(failedOf('single')).toEqual([])
    // 「豆」只出现在「流浪猫豆是」「豆抓伤过」「种的豆子」里，没有一处两侧都是边界，也没有写进 keys
    expect(rank(scenarioOf('single-cat-where')).sort()).toEqual(['h05', 'h25', 'h26'])
    // 查询里还有别的实词时不放宽；这只猫在有前文时（温室场景后问「豆今天吃东西了吗」）靠场景里的词找到
    expect(index.search('豆今天吃东西了吗')).toEqual([])
    expect(rank(scenarioOf('single-cat-after-scene')).slice(0, TOP)).toEqual(expect.arrayContaining(['h25', 'h26']))
  })

  it('焦点与混合场景全部通过', () => {
    expect(failedOf('focus')).toEqual([])
    expect(failedOf('mixed')).toEqual([])
  })

  it('前文场景 3/4：没通过的那条记忆与四百字的场景只共有一个词', () => {
    expect(failedOf('context')).toEqual(['context-engine'])
    // 期望的是「岚的义肢需要校准」：场景里义肢只出现一次，而另有十几条记忆与场景共有同样多或更多的词
    //（轮机舱、小满、补给、过滤……）。试过给场景里反复出现的词加权、减弱长度归一、去掉只加分的单字证据，
    // 都没能把它带进前 10，其中几种还让开发集的场景退步；这是字面检索给不出的排序。
    const ranked = rank(scenarioOf('context-engine'))
    expect(ranked.indexOf('h24')).toBeGreaterThanOrEqual(TOP)
    // 同一场景的次要期望（小满给禾带草莓）在前 10 以内
    expect(ranked.indexOf('h19')).toBeLessThan(10)
    // 排在前面的确实是场景提到的人和地方
    expect(ranked.slice(0, 2)).toEqual(['h15', 'h01'])
  })

  it('无关短句全部没有命中', () => {
    for (const scenario of HOLDOUT_SCENARIOS.filter((item) => item.kind === 'none')) {
      expect(rank(scenario), scenario.id).toEqual([])
    }
  })

  it('换了说法的问法 2/5：与记忆没有共同字词的三句找不到，这是字面检索的边界', () => {
    expect(failedOf('paraphrase')).toEqual(['paraphrase-theft', 'paraphrase-allergy', 'paraphrase-shutdown'])
    for (const id of ['paraphrase-theft', 'paraphrase-allergy', 'paraphrase-shutdown']) expect(rank(scenarioOf(id)), id).toEqual([])
  })

  it('写入时把同义说法和类别写进 keys，能补上其中两句；第三句没有可写的词', () => {
    // 这些 keys 是看过查询之后写的，只说明机制成立，不代表模型实际会写出什么
    const keys: Record<string, string[]> = {
      h13: ['医务室', '止痛剂', '药', '失窃'],
      h05: ['禾', '过敏', '食物'],
      h27: ['灰烬站', '关闭', '总部'],
    }
    const keyed = indexOf(HOLDOUT_MEMORIES.map((memory) => (keys[memory.id] ? { ...memory, keys: keys[memory.id] } : memory)))
    expect(rank(scenarioOf('paraphrase-theft'), keyed)[0]).toBe('h13')
    expect(rank(scenarioOf('paraphrase-allergy'), keyed)[0]).toBe('h05')
    // 「这里还能开多久」与「计划明年关闭」之间没有同义词可写，只能靠理解意思
    expect(rank(scenarioOf('paraphrase-shutdown'), keyed)).not.toContain('h27')
    // 加了 keys 不影响无关短句
    for (const scenario of HOLDOUT_SCENARIOS.filter((item) => item.kind === 'none')) expect(rank(scenario, keyed), scenario.id).toEqual([])
  })
})
