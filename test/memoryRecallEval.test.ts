/**
 * 记忆检索评测（开发集）：在手写的 52 条剧情记忆上，按场景衡量应召回的记忆是否进入前 5，以及无关短句会不会带出命中。
 * 口径与自动入模一致——memoryQuery 构造查询、Bm25Index 检索；另用真实剧情文件和组装管线验证代表场景。
 * 五个库：基础库、加 152 条干扰项、把一个单字名变成常见字、只留十几条的小库、一组英文记忆。
 * 断言的是已达到的下限，用来发现检索质量回退，不代表语义召回；不调用模型，不读取真实剧情。
 * 规则是对着这一份调出来的，是否只对它好看由留出集（memoryRecallHoldout.test.ts）检查。
 *
 * 只用 bigram、不给最新输入加权时，同一评测的结果（通过场景数 / 场景数）：
 *   基础库      single 0/14  focus 6/7  context 10/11  mixed 2/4  20 句无关短句里 0 句有命中
 *   加干扰项    single 0/14  focus 6/7  context 10/11  mixed 2/4  20 句里 2 句有命中（平均 1.15 条，都是共有的 bigram）
 *   英文        focus 1/2  context 3/3  mixed 0/1  2 句无关短句都有命中（平均 10.5 条，功能词）
 * 单字只看「左右邻接多样」而不看是否单独成词时，基础库 20 句无关短句里有 10 句带出命中。
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Bm25Index } from '../src/core/bm25.js'
import { memoryQuery } from '../src/core/memoryRetrieval.js'
import { resolveConfig } from '../src/node/config.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { TavernState } from '../src/node/state.js'
import { serializeMemory } from '../src/state/memory.js'
import {
  EVAL_COMMON_NAME_MEMORIES, EVAL_EN_MEMORIES, EVAL_EN_SCENARIOS, EVAL_MEMORIES, EVAL_SCENARIOS, EVAL_SMALL_IDS, evalDistractors,
  type EvalMemory, type EvalScenario,
} from './memoryRecallEval.fixture.js'

const QUERY_MESSAGES = 4
const TOP = 5

interface Outcome {
  scenario: EvalScenario
  /** 按得分排好的全部命中。 */
  ranked: string[]
  /** 各条期望记忆的名次（1 起），未命中为 Infinity。 */
  ranks: number[]
  passed: boolean
}

function indexOf(memories: readonly EvalMemory[]): Bm25Index {
  const index = new Bm25Index()
  for (const memory of memories) index.add({ id: memory.id, text: memory.body, keys: memory.keys })
  return index
}

function evaluate(memories: readonly EvalMemory[], scenarios: readonly EvalScenario[] = EVAL_SCENARIOS): Outcome[] {
  const index = indexOf(memories)
  const body = new Map(memories.map((memory) => [memory.id, memory.body]))
  return scenarios.map((scenario) => {
    const { query, boost } = memoryQuery(scenario.messages, QUERY_MESSAGES)
    const ranked = index.search(query, { topK: memories.length, ...(boost ? { boost } : {}) }).map((hit) => hit.id)
    const ranks = scenario.expected.map((id) => (ranked.includes(id) ? ranked.indexOf(id) + 1 : Infinity))
    const top = ranked.slice(0, TOP)
    // 首要期望进前 5；指定了 mention 的场景还要求前 5 非空且每条都含那个字
    const passed = (ranks.length === 0 || ranks[0]! <= TOP)
      && (scenario.mention === undefined || (top.length > 0 && top.every((id) => body.get(id)!.includes(scenario.mention!))))
    return { scenario, ranked, ranks, passed }
  })
}

const ofKind = (outcomes: readonly Outcome[], kind: EvalScenario['kind']): Outcome[] =>
  outcomes.filter((outcome) => outcome.scenario.kind === kind)
const failed = (outcomes: readonly Outcome[]): string[] =>
  outcomes.filter((outcome) => !outcome.passed).map((outcome) => outcome.scenario.id)
const average = (values: readonly number[]): number => values.reduce((sum, value) => sum + value, 0) / values.length

const BASE = EVAL_MEMORIES
const CROWDED = [...EVAL_MEMORIES, ...evalDistractors(152)]
const COMMON_NAME = [...EVAL_MEMORIES, ...EVAL_COMMON_NAME_MEMORIES]
const SMALL = EVAL_MEMORIES.filter((memory) => EVAL_SMALL_IDS.includes(memory.id))

describe('评测集自检', () => {
  it('记忆与干扰项 id、正文唯一，场景期望都指向存在的记忆', () => {
    const all = [...CROWDED, ...EVAL_COMMON_NAME_MEMORIES]
    expect(new Set(all.map((memory) => memory.id)).size).toBe(all.length)
    expect(new Set(all.map((memory) => memory.body)).size).toBe(all.length)
    const ids = new Set(EVAL_MEMORIES.map((memory) => memory.id))
    for (const scenario of EVAL_SCENARIOS) {
      if (scenario.kind === 'none') expect(scenario.expected, scenario.id).toEqual([])
      else expect(scenario.expected.length > 0 || scenario.mention !== undefined, scenario.id).toBe(true)
      for (const id of scenario.expected) expect(ids.has(id), `${scenario.id} → ${id}`).toBe(true)
    }
    expect(new Set(EVAL_SCENARIOS.map((scenario) => scenario.id)).size).toBe(EVAL_SCENARIOS.length)
    for (const id of EVAL_SMALL_IDS) expect(ids.has(id), id).toBe(true)
  })

  it('各类场景的数量与文件头记录的基线口径一致', () => {
    const count = (kind: EvalScenario['kind']): number => EVAL_SCENARIOS.filter((scenario) => scenario.kind === kind).length
    expect({ single: count('single'), focus: count('focus'), context: count('context'), mixed: count('mixed'), none: count('none') })
      .toEqual({ single: 14, focus: 7, context: 11, mixed: 4, none: 20 })
  })

  it('干扰项不含评测用的单字名，也不重复评测记忆的关键物件', () => {
    for (const memory of evalDistractors(152)) {
      expect(memory.body).not.toMatch(/[凛樱雪墨弩岩茉鲸]|翡翠|怀表|航海图|令牌|霜牙/)
    }
  })

  it('补充记忆让「凛」出现在约四成的记忆里，小库包含全部前文场景的期望', () => {
    const mentions = COMMON_NAME.filter((memory) => memory.body.includes('凛')).length
    expect(mentions / COMMON_NAME.length).toBeGreaterThan(0.35)
    for (const scenario of EVAL_SCENARIOS.filter((item) => item.kind === 'context')) {
      for (const id of scenario.expected) expect(EVAL_SMALL_IDS, scenario.id).toContain(id)
    }
  })
})

describe.each([
  { label: '基础库 52 条', memories: BASE },
  { label: '加干扰项 204 条', memories: CROWDED },
  { label: '常见单字名 66 条', memories: COMMON_NAME },
])('检索评测：$label', ({ memories }) => {
  const outcomes = evaluate(memories)
  const rankOf = (id: string): number[] => outcomes.find((outcome) => outcome.scenario.id === id)!.ranks

  it('单字场景全部通过：单字名、单字名词、常见单字名、单字 key 声明的名字、只出现过一次的名字', () => {
    expect(failed(ofKind(outcomes, 'single'))).toEqual([])
    for (const id of ['single-once-named', 'single-once-object', 'single-once-nickname']) expect(rankOf(id)[0], id).toBeLessThanOrEqual(TOP)
    // 只有一个字的查询以前返回空
    for (const id of ['single-name-query', 'single-pet-query', 'single-informant-query']) expect(rankOf(id)[0], id).toBe(1)
    expect(rankOf('single-declared-key')[0]).toBe(1)
  })

  it('焦点场景：最新输入问到的记忆排在第一', () => {
    const focus = ofKind(outcomes, 'focus')
    expect(failed(focus)).toEqual([])
    for (const outcome of focus) expect(outcome.ranks[0], outcome.scenario.id).toBe(1)
  })

  it('前文场景全部通过：闲聊输入不挤掉场景相关的记忆', () => {
    expect(failed(ofKind(outcomes, 'context'))).toEqual([])
    // 这几句闲聊带着记忆正文里也有的功能词，场景记忆仍须全部留在前 5
    for (const id of ['context-tavern-negation', 'context-tavern-know', 'context-lighthouse-now', 'context-ballroom-nobody', 'context-warehouse-what']) {
      expect(Math.max(...rankOf(id)), id).toBeLessThanOrEqual(TOP)
    }
  })

  it('混合场景全部通过', () => {
    expect(failed(ofKind(outcomes, 'mixed'))).toEqual([])
  })

  it('续写时最后一条是助手：不加权，场景记忆照常召回', () => {
    const index = indexOf(memories)
    const tavern = EVAL_SCENARIOS.find((scenario) => scenario.id === 'context-tavern')!
    const { query, boost } = memoryQuery(tavern.messages.slice(0, -1), QUERY_MESSAGES)
    expect(boost).toBeUndefined()
    const top = index.search(query, { topK: TOP }).map((hit) => hit.id)
    expect(top).toEqual(expect.arrayContaining(tavern.expected))
  })
})

describe('无关短句', () => {
  const none = (memories: readonly EvalMemory[]): Outcome[] => ofKind(evaluate(memories), 'none')
  const hit = (outcomes: readonly Outcome[]): string[] => outcomes.filter((outcome) => outcome.ranked.length > 0).map((outcome) => outcome.scenario.id)

  it('基础库与常见单字名库：20 句里只有含被 key 声明的「七」的那一句带出命中', () => {
    for (const memories of [BASE, COMMON_NAME]) {
      const outcomes = none(memories)
      expect(outcomes).toHaveLength(20)
      // 「明早七点叫我起床」：m49 把「七」声明成了名字，这是声明的代价
      expect(hit(outcomes)).toEqual(['none-alarm'])
      expect(outcomes.find((outcome) => outcome.scenario.id === 'none-alarm')!.ranked.sort()).toEqual(['m05', 'm49'])
    }
  })

  it('加干扰项后带出命中的句子不超过 4 句，其中两句是与干扰项共有的 bigram', () => {
    const outcomes = none(CROWDED)
    expect(hit(outcomes).sort()).toEqual(['none-alarm', 'none-birthday', 'none-umbrella', 'none-weather'])
    const bodyOf = (id: string): string => CROWDED.find((memory) => memory.id === id)!.body
    // 「不错」「下雨」是 bigram 命中，引入单字之前同样存在
    expect(outcomes.find((outcome) => outcome.scenario.id === 'none-weather')!.ranked.every((id) => bodyOf(id).includes('不错'))).toBe(true)
    expect(outcomes.find((outcome) => outcome.scenario.id === 'none-umbrella')!.ranked.every((id) => bodyOf(id).includes('下雨'))).toBe(true)
    // 「生日快乐」的「乐」在干扰项「闷闷不乐了」里被两个虚词夹住，算单独成词
    expect(outcomes.find((outcome) => outcome.scenario.id === 'none-birthday')!.ranked.every((id) => bodyOf(id).includes('不乐'))).toBe(true)
    expect(average(outcomes.map((outcome) => outcome.ranked.length))).toBeLessThanOrEqual(2.5)
  })

  it('有 bigram 命中的查询不因单字多出命中', () => {
    const index = indexOf(CROWDED)
    expect(index.search('翡翠钥匙在哪', { topK: CROWDED.length }).map((hit) => hit.id).sort()).toEqual(['m08', 'm09', 'm30'])
  })
})

describe('英文记忆 14 条', () => {
  const outcomes = evaluate(EVAL_EN_MEMORIES, EVAL_EN_SCENARIOS)

  it('焦点、前文、混合场景全部通过', () => {
    expect(outcomes.filter((outcome) => outcome.scenario.kind !== 'none')).toHaveLength(6)
    expect(failed(outcomes.filter((outcome) => outcome.scenario.kind !== 'none'))).toEqual([])
  })

  it('只有功能词与库无关的内容词的句子没有命中', () => {
    for (const outcome of ofKind(outcomes, 'none')) expect(outcome.ranked, outcome.scenario.id).toEqual([])
  })

  it('闲聊输入里的功能词不把含 no、not、has 的无关记忆顶上来', () => {
    for (const id of ['en-context-go-on', 'en-context-not-yet']) {
      const top = outcomes.find((outcome) => outcome.scenario.id === id)!.ranked.slice(0, TOP)
      expect(top, id).toEqual(expect.arrayContaining(['e05', 'e06']))
    }
  })
})

describe('小库 18 条', () => {
  it('前文场景全部通过：库越小功能词越显得稀有，闲聊输入加权后仍不挤掉场景记忆', () => {
    const outcomes = evaluate(SMALL, EVAL_SCENARIOS.filter((scenario) => scenario.kind === 'context'))
    expect(outcomes).toHaveLength(11)
    expect(failed(outcomes)).toEqual([])
  })
})

describe('评测场景经真实剧情文件与组装管线', () => {
  let root: string
  let state: TavernState

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'memory-recall-eval-'))
    const config = resolveConfig({ memory: { halfLifeDays: 0 } })
    state = new TavernState({ root, characters: join(root, 'characters'), lorebooks: join(root, 'lorebooks'),
      presets: join(root, 'presets'), personas: join(root, 'personas'), regexDir: join(root, 'regex'),
      sessions: join(root, 'sessions') }, () => config)
    await state.init()
    const cardId = (await state.createCharacter('雾港巡夜人')).cardId
    await state.saveBinding({ sessionId: 'eval', cardId, presetId: null, personaId: null, lorebookIds: [],
      characterLorebookId: null, interactiveCards: null, greetingIndex: 0, createdAt: new Date(0).toISOString() })
    const ws = await state.storyWorkspace(cardId, (await state.loadBinding('eval'))!.storyId)
    const stamp = '2026-09-01T00:00:00.000Z'
    for (const memory of EVAL_MEMORIES) {
      await ws.fs.writeText(`memory/${memory.id}.md`, serializeMemory({ created: stamp, updated: stamp,
        sourceRange: '', tags: [], keys: memory.keys ?? [] }, memory.body))
    }
    ws.memory.invalidate()
  })

  afterEach(async () => { await rm(root, { recursive: true, force: true }) })

  const body = (id: string): string => EVAL_MEMORIES.find((memory) => memory.id === id)!.body
  async function injected(id: string, messages = EVAL_SCENARIOS.find((scenario) => scenario.id === id)!.messages): Promise<string> {
    const result = await runTavernPipeline({ state, sessionId: 'eval', agent: null, mode: 'preview', historyOverride: messages })
    expect(result).not.toBeNull()
    return result!.turnContext
  }

  it('最新输入问到的记忆入模，即使前文是一长段别的场景', async () => {
    // 只用 bigram、不加权时这两条在检索里排第 8 和第 12，进不了默认的 5 条
    const context = await injected('focus-watch')
    expect(context).toContain(body('m10'))
    expect(context).toContain(body('m11'))
  })

  it('单字线人名所在的记忆入模', async () => {
    // 「墨上次说的那艘船」与这条记忆没有共同 bigram，只用 bigram 时排第 24
    expect(await injected('single-informant-after-scene')).toContain(body('m43'))
  })

  it('一长段场景之后问到单字名和单字名词，对应记忆入模', async () => {
    expect(await injected('single-name-after-scene')).toContain(body('m05'))
  })

  it('闲聊输入时仍注入场景相关的记忆，无关短句不注入任何记忆', async () => {
    const context = await injected('context-tavern-negation')
    expect(context).toContain(body('m16'))
    expect(context).toContain(body('m36'))
    const unrelated = await injected('none-dragon')
    for (const memory of EVAL_MEMORIES) expect(unrelated, memory.id).not.toContain(memory.body)
  })

  it('续写（最后一条是助手）时照常注入场景记忆', async () => {
    const tavern = EVAL_SCENARIOS.find((scenario) => scenario.id === 'context-tavern')!
    const context = await injected(tavern.id, tavern.messages.slice(0, -1))
    expect(context).toContain(body('m16'))
    expect(context).toContain(body('m36'))
  })
})
