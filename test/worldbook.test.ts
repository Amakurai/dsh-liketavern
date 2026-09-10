/**
 * 世界书触发引擎单测。
 * 覆盖：明文/正则键、{{user}}/{{char}} 身份宏、大小写与整词（全局与条目级）、scanDepth（全局与条目级）、
 * inclusion group（一组一条、sticky 占用、override、计分/加权、落选条目正文不再喂给后续递归轮次、
 * 递归轮新晋组员可翻盘）、selective 四逻辑、
 * constant、probability（standing-safe 常驻条目豁免掷骰、恒定注入；含本轮宏的 constant 不豁免）、
 * 递归（excludeRecursion/preventRecursion/delayUntilRecursion/
 * maxRecursionSteps）、定时（sticky/cooldown/delay，跨轮回传 timerState）、
 * 落选回滚（未注入条目清本轮写入的 sticky/cooldown；sticky 延续条目被预算裁掉也清 stickyLeft、保留 cooldown）、
 * 预算截断（优先级/ignoreBudget/overflowWarning；固定预算为绝对上限、百分比按 128K 基数
 * 折算并扣减 reservedTokens；standing 侧常驻豁免计费，被裁条目进 truncated 清单）、
 * 位置分桶、多来源排序、includeNames、
 * 键安全（超长键与灾难回溯正则键永不命中；绕过归一化的非字符串键塌缩不炸）。
 *
 * 定时语义约定（types.ts）：sticky=N = 激活后再保持 N 轮；cooldown=N = 激活后 N 轮内不再触发。
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WI_SETTINGS,
  EMPTY_TIMER_STATE,
  WIPosition,
  WIRole,
  WISelectiveLogic,
  type ChatMessage,
  type WIEngineInput,
  type WIEngineResult,
  type WILogEntry,
  type WITimerState,
  type WorldInfoEntry,
  type WorldInfoGlobalSettings,
} from '../src/core/types.js'
import { evaluateWorldInfo, isStandingSafeEntry } from '../src/core/worldbook.js'

// ---------------------------------------------------------------------------
// 构造辅助
// ---------------------------------------------------------------------------

/** WorldInfoEntry 全字段默认值工厂。 */
function makeEntry(partial: Partial<WorldInfoEntry> & { key: string }): WorldInfoEntry {
  return {
    uid: partial.key,
    source: 'global',
    sourceRef: 'book',
    keys: [],
    secondaryKeys: [],
    selective: false,
    selectiveLogic: WISelectiveLogic.AndAny,
    comment: '',
    content: '',
    constant: false,
    enabled: true,
    order: 100,
    position: WIPosition.BeforeCharDefs,
    depth: 4,
    role: WIRole.System,
    outletName: '',
    probability: 100,
    useProbability: false,
    caseSensitive: null,
    matchWholeWords: null,
    scanDepth: null,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    sticky: null,
    cooldown: null,
    delay: null,
    ignoreBudget: false,
    group: '',
    groupWeight: 100,
    groupOverride: false,
    automationId: '',
    ...partial,
  }
}

function makeSettings(overrides: Partial<WorldInfoGlobalSettings> = {}): WorldInfoGlobalSettings {
  return { ...DEFAULT_WI_SETTINGS, ...overrides }
}

function run(overrides: Partial<WIEngineInput> & Pick<WIEngineInput, 'entries'>): WIEngineResult {
  return evaluateWorldInfo({
    messages: [],
    settings: makeSettings(),
    timerState: EMPTY_TIMER_STATE,
    contextWindowTokens: 1000,
    reservedTokens: 0,
    estimateTokens: () => 10,
    random: () => 0.5,
    ...overrides,
  })
}

/** 以「每条消息一轮」的方式连续评估，跨轮回传 timerState。 */
function runChain(
  entries: WorldInfoEntry[],
  textsPerRound: string[],
  overrides: Partial<WIEngineInput> = {},
): WIEngineResult[] {
  let timerState: WITimerState = EMPTY_TIMER_STATE
  const results: WIEngineResult[] = []
  for (const text of textsPerRound) {
    const res = evaluateWorldInfo({
      entries,
      messages: [{ role: 'user', content: text }],
      settings: makeSettings(),
      timerState,
      contextWindowTokens: 1000,
      reservedTokens: 0,
      estimateTokens: () => 10,
      random: () => 0.5,
      ...overrides,
    })
    results.push(res)
    timerState = res.timerState
  }
  return results
}

const userMsg = (content: string, name?: string): ChatMessage => (name === undefined ? { role: 'user', content } : { role: 'user', content, name })
const activatedKeys = (res: WIEngineResult): string[] => res.activated.map((a) => a.entry.key)
const logsOf = (res: WIEngineResult, kind: WILogEntry['kind']): WILogEntry[] => res.log.filter((l) => l.kind === kind)

// ---------------------------------------------------------------------------
// 触发键
// ---------------------------------------------------------------------------

describe('触发键匹配', () => {
  it('明文键命中', () => {
    const res = run({ entries: [makeEntry({ key: 'e', keys: ['apple'] })], messages: [userMsg('I ate an apple')] })
    expect(activatedKeys(res)).toEqual(['e'])
    expect(res.activated[0]!.via).toBe('keyword')
    expect(res.activated[0]!.matchedKeys).toEqual(['apple'])
  })

  it('明文键未命中', () => {
    const res = run({ entries: [makeEntry({ key: 'e', keys: ['apple'] })], messages: [userMsg('nothing here')] })
    expect(activatedKeys(res)).toEqual([])
  })

  it('键 {{user}} 展开后匹配人设名', () => {
    const res = run({
      entries: [makeEntry({ key: 'e', keys: ['{{user}}'] })],
      messages: [userMsg('Bob 来了')],
      macroCtx: { char: 'Alice', user: 'Bob' },
    })
    expect(activatedKeys(res)).toEqual(['e'])
  })

  it('正文里的 {{user}} 展开后匹配明文键', () => {
    const res = run({
      entries: [makeEntry({ key: 'e', keys: ['Bob'] })],
      messages: [userMsg('我想你了，{{user}}')],
      macroCtx: { char: 'Alice', user: 'Bob' },
    })
    expect(activatedKeys(res)).toEqual(['e'])
  })

  it('无 macroCtx 时 {{user}} 按字面匹配', () => {
    const res = run({
      entries: [makeEntry({ key: 'e', keys: ['{{user}}'] })],
      messages: [userMsg('看见 {{user}} 了')],
    })
    expect(activatedKeys(res)).toEqual(['e'])
  })

  it('/regex/ 键命中，flags 生效', () => {
    const res = run({
      entries: [
        makeEntry({ key: 'a', keys: ['/c.t/'] }),
        makeEntry({ key: 'b', keys: ['/DOG/i'] }), // i flag → 命中 'dog'
        makeEntry({ key: 'c', keys: ['/DOG/'] }), // 无 i flag → 不命中
      ],
      messages: [userMsg('the cat feeds the dog')],
    })
    expect(activatedKeys(res).sort()).toEqual(['a', 'b'])
  })

  it('/regex/g 键在多个扫描文本间不会因 lastIndex 漏命中', () => {
    const res = run({
      entries: [makeEntry({ key: 'global-regex', keys: ['/apple/g'] })],
      // includeNames=true 会为带名字的消息生成三种文本，足以暴露
      // RegExp.test() 未复位时的交替漏匹配。
      messages: [userMsg('apple apple', 'Bob')],
    })
    expect(activatedKeys(res)).toEqual(['global-regex'])
  })

  it('非法正则键视为永不命中且不抛错', () => {
    const res = run({ entries: [makeEntry({ key: 'e', keys: ['/(unclosed/'] })], messages: [userMsg('anything')] })
    expect(activatedKeys(res)).toEqual([])
  })

  it('大小写：默认不敏感；全局敏感后 key 大小写不符不命中', () => {
    const entry = makeEntry({ key: 'e', keys: ['Apple'] })
    expect(activatedKeys(run({ entries: [entry], messages: [userMsg('apple')] }))).toEqual(['e'])
    const res = run({ entries: [entry], messages: [userMsg('apple')], settings: makeSettings({ caseSensitive: true }) })
    expect(activatedKeys(res)).toEqual([])
  })

  it('大小写：条目级覆盖全局（双向）', () => {
    // 全局敏感 + 条目放宽 → 命中
    const loose = makeEntry({ key: 'loose', keys: ['Apple'], caseSensitive: false })
    const r1 = run({ entries: [loose], messages: [userMsg('apple')], settings: makeSettings({ caseSensitive: true }) })
    expect(activatedKeys(r1)).toEqual(['loose'])
    // 全局不敏感 + 条目收紧 → 不命中
    const strict = makeEntry({ key: 'strict', keys: ['Apple'], caseSensitive: true })
    const r2 = run({ entries: [strict], messages: [userMsg('apple')] })
    expect(activatedKeys(r2)).toEqual([])
  })

  it('整词匹配：cat 不命中 catalog；条目级可覆盖全局', () => {
    const entry = makeEntry({ key: 'e', keys: ['cat'] })
    const whole = makeSettings({ matchWholeWords: true })
    expect(activatedKeys(run({ entries: [entry], messages: [userMsg('catalog')], settings: whole }))).toEqual([])
    expect(activatedKeys(run({ entries: [entry], messages: [userMsg('my cat')], settings: whole }))).toEqual(['e'])
    // 条目级关闭整词 → catalog 可命中
    const partial = makeEntry({ key: 'p', keys: ['cat'], matchWholeWords: false })
    expect(activatedKeys(run({ entries: [partial], messages: [userMsg('catalog')], settings: whole }))).toEqual(['p'])
  })
})

// ---------------------------------------------------------------------------
// scanDepth
// ---------------------------------------------------------------------------

describe('scanDepth', () => {
  const entry = makeEntry({ key: 'e', keys: ['apple'] })
  const messages = [userMsg('apple'), userMsg('nothing'), userMsg('nothing')]

  it('只扫最近 N 条：N=2 时最旧一条不在窗口内', () => {
    expect(activatedKeys(run({ entries: [entry], messages, settings: makeSettings({ scanDepth: 2 }) }))).toEqual([])
    expect(activatedKeys(run({ entries: [entry], messages, settings: makeSettings({ scanDepth: 3 }) }))).toEqual(['e'])
  })

  it('条目级 scanDepth 覆盖全局：1 只扫最近一条，0 不扫消息', () => {
    const messages = [userMsg('apple'), userMsg('nothing'), userMsg('nothing')]
    const global = makeSettings({ scanDepth: 3 })
    expect(activatedKeys(run({ entries: [makeEntry({ key: 'shallow', keys: ['apple'], scanDepth: 1 })], messages, settings: global }))).toEqual([])
    expect(activatedKeys(run({ entries: [makeEntry({ key: 'follow', keys: ['apple'] })], messages, settings: global }))).toEqual(['follow'])
    expect(activatedKeys(run({ entries: [makeEntry({ key: 'zero', keys: ['apple'], scanDepth: 0 })], messages: [userMsg('apple')], settings: global }))).toEqual([])
  })

  it('scanDepth=0：关键词条目不命中，但 constant 仍激活', () => {
    const res = run({
      entries: [entry, makeEntry({ key: 'c', constant: true })],
      messages,
      settings: makeSettings({ scanDepth: 0 }),
    })
    expect(activatedKeys(res)).toEqual(['c'])
  })
})

// ---------------------------------------------------------------------------
// selective 次级键
// ---------------------------------------------------------------------------

describe('selective 次级键逻辑', () => {
  const entry = (logic: (typeof WISelectiveLogic)[keyof typeof WISelectiveLogic]) =>
    makeEntry({ key: 'e', keys: ['apple'], secondaryKeys: ['pie', 'crust'], selective: true, selectiveLogic: logic })

  it('AND ANY(0)：任一次级键命中即可', () => {
    expect(activatedKeys(run({ entries: [entry(0)], messages: [userMsg('apple pie')] }))).toEqual(['e'])
    expect(activatedKeys(run({ entries: [entry(0)], messages: [userMsg('apple')] }))).toEqual([])
  })

  it('NOT ALL(1)：次级键未全部命中才可激活', () => {
    expect(activatedKeys(run({ entries: [entry(1)], messages: [userMsg('apple pie')] }))).toEqual(['e'])
    expect(activatedKeys(run({ entries: [entry(1)], messages: [userMsg('apple pie crust')] }))).toEqual([])
  })

  it('NOT ANY(2)：次级键全部不命中才可激活', () => {
    expect(activatedKeys(run({ entries: [entry(2)], messages: [userMsg('apple')] }))).toEqual(['e'])
    expect(activatedKeys(run({ entries: [entry(2)], messages: [userMsg('apple pie')] }))).toEqual([])
  })

  it('AND ALL(3)：次级键全部命中才可激活', () => {
    expect(activatedKeys(run({ entries: [entry(3)], messages: [userMsg('apple pie crust')] }))).toEqual(['e'])
    expect(activatedKeys(run({ entries: [entry(3)], messages: [userMsg('apple pie')] }))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// constant 与 probability
// ---------------------------------------------------------------------------

describe('constant 与 probability', () => {
  it('constant 无需键即可激活', () => {
    const res = run({ entries: [makeEntry({ key: 'c', constant: true })] })
    expect(res.activated[0]!.via).toBe('constant')
  })

  it('probability=0 必跳过并记 probability-skip（random 注入 0.99）', () => {
    const res = run({
      entries: [makeEntry({ key: 'e', keys: ['apple'], useProbability: true, probability: 0 })],
      messages: [userMsg('apple')],
      random: () => 0.99,
    })
    expect(activatedKeys(res)).toEqual([])
    expect(logsOf(res, 'probability-skip').map((l) => l.entryKey)).toEqual(['e'])
  })

  it('probability=100 必中（random 0.99 也不受影响）', () => {
    const res = run({
      entries: [makeEntry({ key: 'e', keys: ['apple'], useProbability: true, probability: 100 })],
      messages: [userMsg('apple')],
      random: () => 0.99,
    })
    expect(activatedKeys(res)).toEqual(['e'])
  })

  it('概率为零的常驻条目仍不得激活', () => {
    // constant 且无本轮宏 → 落 standing 钉死段；掷骰早已被钉死冻结成「每会话一次」，
    // 而 fork 分支换种子重掷会打穿整个 system 前缀缓存——改为恒定注入。
    const res = run({
      entries: [makeEntry({ key: 'c', constant: true, useProbability: true, probability: 0, content: 'CONST' })],
      random: () => 0.99,
    })
    expect(activatedKeys(res)).toEqual([])
    expect(logsOf(res, 'probability-skip')).toHaveLength(1)
  })

  it('含本轮宏的 constant 条目不豁免（落 turn 层）：仍按概率掷骰', () => {
    const res = run({
      entries: [makeEntry({ key: 'c', constant: true, useProbability: true, probability: 0, content: '看 {{lastusermessage}}' })],
      random: () => 0.99,
    })
    expect(activatedKeys(res)).toEqual([])
    expect(logsOf(res, 'probability-skip').map((l) => l.entryKey)).toEqual(['c'])
  })
})

// ---------------------------------------------------------------------------
// 递归扫描
// ---------------------------------------------------------------------------

describe('递归扫描', () => {
  const a = makeEntry({ key: 'A', keys: ['apple'], content: 'banana bread' })
  const b = makeEntry({ key: 'B', keys: ['banana'] })

  it('A 内容含 B 的键 → B 经 recursion 激活（recursionLevel=1）', () => {
    const res = run({ entries: [a, b], messages: [userMsg('apple')] })
    expect(activatedKeys(res).sort()).toEqual(['A', 'B'])
    const actB = res.activated.find((x) => x.entry.key === 'B')!
    expect(actB.via).toBe('recursion')
    expect(actB.recursionLevel).toBe(1)
  })

  it('B 标 excludeRecursion：只能直接命中，不能被递归激活', () => {
    const res = run({ entries: [a, makeEntry({ ...b, excludeRecursion: true })], messages: [userMsg('apple')] })
    expect(activatedKeys(res)).toEqual(['A'])
  })

  it('A 标 preventRecursion：内容不进入递归扫描并记 recursion-stop', () => {
    const res = run({ entries: [makeEntry({ ...a, preventRecursion: true }), b], messages: [userMsg('apple')] })
    expect(activatedKeys(res)).toEqual(['A'])
    expect(logsOf(res, 'recursion-stop').map((l) => l.entryKey)).toEqual(['A'])
  })

  it('delayUntilRecursion=1：首轮不可激活，仅在递归层激活', () => {
    const delayed = makeEntry({ ...b, delayUntilRecursion: 1 })
    // 键直接出现在消息里也不激活（首轮 level 0 被门槛拦住）
    expect(activatedKeys(run({ entries: [delayed], messages: [userMsg('banana')] }))).toEqual([])
    // 经 A 递归 → level 1 达到门槛
    const res = run({ entries: [a, delayed], messages: [userMsg('apple')] })
    expect(activatedKeys(res).sort()).toEqual(['A', 'B'])
    expect(res.activated.find((x) => x.entry.key === 'B')!.recursionLevel).toBe(1)
  })

  it('maxRecursionSteps=1 关闭递归', () => {
    const res = run({ entries: [a, b], messages: [userMsg('apple')], settings: makeSettings({ maxRecursionSteps: 1 }) })
    expect(activatedKeys(res)).toEqual(['A'])
  })

  it('maxRecursionSteps 计的是总扫描轮数（含首轮）：2 只跑一轮递归，3 才跑到第二层', () => {
    // A(apple) → 内容含 banana → B；B 内容含 cherry → C
    const chainB = makeEntry({ ...b, content: 'cherry tart' })
    const c = makeEntry({ key: 'C', keys: ['cherry'] })
    const entries = [a, chainB, c]
    const two = run({ entries, messages: [userMsg('apple')], settings: makeSettings({ maxRecursionSteps: 2 }) })
    expect(activatedKeys(two).sort()).toEqual(['A', 'B'])
    const three = run({ entries, messages: [userMsg('apple')], settings: makeSettings({ maxRecursionSteps: 3 }) })
    expect(activatedKeys(three).sort()).toEqual(['A', 'B', 'C'])
    expect(three.activated.find((x) => x.entry.key === 'C')!.recursionLevel).toBe(2)
    // 0 = 不限，同样跑满整条链
    const unlimited = run({ entries, messages: [userMsg('apple')], settings: makeSettings({ maxRecursionSteps: 0 }) })
    expect(activatedKeys(unlimited).sort()).toEqual(['A', 'B', 'C'])
  })

  it('recursiveScan=false 同样关闭递归', () => {
    const res = run({ entries: [a, b], messages: [userMsg('apple')], settings: makeSettings({ recursiveScan: false }) })
    expect(activatedKeys(res)).toEqual(['A'])
  })
})

// ---------------------------------------------------------------------------
// 定时效果（跨轮回传 timerState）
// ---------------------------------------------------------------------------

describe('定时效果', () => {
  it('sticky=2：首轮 key 激活后再经 sticky 保持两轮（期间跳过概率），第四轮不再激活', () => {
    const entry = makeEntry({ key: 'e', keys: ['apple'], sticky: 2, useProbability: true, probability: 50 })
    // 第 1 轮 random=0.1 通过概率；第 2/3 轮 random=0.99 若判定概率必失败——
    // sticky 延续期跳过概率判定，故仍应激活。
    const seq = [0.1, 0.99, 0.99, 0.99]
    let calls = 0
    const results = runChain([entry], ['apple', 'x', 'x', 'x'], {
      random: () => seq[Math.min(calls++, seq.length - 1)]!,
    })
    expect(results.map((r) => r.activated[0]?.via ?? null)).toEqual(['keyword', 'sticky', 'sticky', null])
    // sticky 延续轮不出现 probability-skip
    expect(logsOf(results[1]!, 'probability-skip')).toEqual([])
    expect(logsOf(results[2]!, 'probability-skip')).toEqual([])
  })

  it('cooldown=2：激活后两轮内即使 key 命中也 cooldown-skip，第三轮可再激活', () => {
    const entry = makeEntry({ key: 'e', keys: ['apple'], cooldown: 2 })
    const results = runChain([entry], ['apple', 'apple', 'apple', 'apple'])
    expect(results.map((r) => r.activated[0]?.via ?? null)).toEqual(['keyword', null, null, 'keyword'])
    expect(logsOf(results[1]!, 'cooldown-skip').map((l) => l.entryKey)).toEqual(['e'])
    expect(logsOf(results[2]!, 'cooldown-skip').map((l) => l.entryKey)).toEqual(['e'])
  })

  it('delay=3：消息数 <3 不激活并记 delay-skip，≥3 激活', () => {
    const entry = makeEntry({ key: 'e', keys: ['apple'], delay: 3 })
    const two = [userMsg('hi'), userMsg('apple')]
    const three = [userMsg('hi'), userMsg('hey'), userMsg('apple')]
    const r1 = run({ entries: [entry], messages: two })
    expect(activatedKeys(r1)).toEqual([])
    expect(logsOf(r1, 'delay-skip').map((l) => l.entryKey)).toEqual(['e'])
    expect(activatedKeys(run({ entries: [entry], messages: three }))).toEqual(['e'])
  })

  it('timerState 不回传则 sticky 不延续（状态由调用方持久化）', () => {
    const entry = makeEntry({ key: 'e', keys: ['apple'], sticky: 2 })
    // 两轮都传 EMPTY_TIMER_STATE：第二轮无 sticky 状态，key 不命中 → 不激活
    const r2 = run({ entries: [entry], messages: [userMsg('x')], timerState: EMPTY_TIMER_STATE })
    expect(activatedKeys(r2)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 预算截断
// ---------------------------------------------------------------------------

describe('预算截断', () => {
  const budget = (tokenBudget: number) => makeSettings({ tokenBudget })

  it('计费的 constant（含本轮宏）优先于关键词条目保留，被裁条目记 budget-trim 并进 truncated', () => {
    const res = run({
      entries: [
        makeEntry({ key: 'kw', keys: ['apple'], order: 999 }),
        // {{time}} 是本轮宏：这条 constant 落 turn 侧、仍参与预算排序
        makeEntry({ key: 'const', constant: true, content: '{{time}}', order: 10 }),
      ],
      messages: [userMsg('apple')],
      settings: budget(15), // 每条 10 tokens，只放得下一条
    })
    expect(activatedKeys(res)).toEqual(['const'])
    expect(logsOf(res, 'budget-trim').map((l) => l.entryKey)).toEqual(['kw'])
    expect(res.truncated.map((t) => t.key)).toEqual(['kw'])
    expect(res.budget).toEqual({ limit: 15, used: 10, overflowed: true })
  })

  it('落 standing 的常驻条目（constant 且无本轮宏）豁免 turn 层预算', () => {
    const res = run({
      entries: [
        // 5000 tokens 的常驻条目：豁免计费（走钉死的 standing 段），不挤占触发层额度
        makeEntry({ key: 'const', constant: true, content: 'x'.repeat(5000) }),
        makeEntry({ key: 'kw', keys: ['apple'], content: 'y'.repeat(10) }),
      ],
      messages: [userMsg('apple')],
      settings: budget(15),
      estimateTokens: (t) => t.length,
    })
    expect(activatedKeys(res).sort()).toEqual(['const', 'kw'])
    expect(res.budget).toEqual({ limit: 15, used: 10, overflowed: false })
    expect(res.truncated).toEqual([])
  })

  it('含本轮宏的 constant 不豁免：超预算被裁且进 truncated', () => {
    const res = run({
      entries: [
        makeEntry({ key: 'safe', constant: true, content: 's'.repeat(5000) }),
        makeEntry({ key: 'macro', constant: true, content: `{{time}}${'m'.repeat(20)}` }),
      ],
      settings: budget(15),
      estimateTokens: (t) => t.length,
    })
    expect(activatedKeys(res)).toEqual(['safe'])
    expect(res.truncated.map((t) => t.key)).toEqual(['macro'])
    expect(res.budget.overflowed).toBe(true)
  })

  it('truncated 的 label 依次取 注释 > 首个触发键 > uid', () => {
    const res = run({
      entries: [
        makeEntry({ key: 'e1', keys: ['apple'], comment: '城门设定', order: 100 }),
        makeEntry({ key: 'e2', keys: ['apple'], order: 200 }),
        // 无注释无键仍计费的条目：含本轮宏的 constant，label 回退到 uid（= key）
        makeEntry({ key: 'e3', constant: true, content: '{{time}}', order: 50 }),
      ],
      messages: [userMsg('apple')],
      settings: budget(5), // 全部裁掉
    })
    // 排序：constant 优先，再 order 降序 → e3、e2、e1
    expect(res.truncated.map((t) => t.label)).toEqual(['e3', 'apple', '城门设定'])
    expect(res.truncated.map((t) => t.uid)).toEqual(['e3', 'e2', 'e1'])
  })

  it('同类条目按 order 降序保留', () => {
    const res = run({
      entries: [
        makeEntry({ key: 'low', keys: ['apple'], order: 100 }),
        makeEntry({ key: 'high', keys: ['apple'], order: 200 }),
      ],
      messages: [userMsg('apple')],
      settings: budget(15),
    })
    expect(activatedKeys(res)).toEqual(['high'])
    expect(logsOf(res, 'budget-trim').map((l) => l.entryKey)).toEqual(['low'])
  })

  it('同 order 时直接命中优先于递归命中', () => {
    const res = run({
      entries: [
        makeEntry({ key: 'direct', keys: ['apple'], content: 'banana', order: 100 }),
        makeEntry({ key: 'rec', keys: ['banana'], order: 100 }),
      ],
      messages: [userMsg('apple')],
      settings: budget(15),
    })
    expect(activatedKeys(res)).toEqual(['direct'])
    expect(logsOf(res, 'budget-trim').map((l) => l.entryKey)).toEqual(['rec'])
  })

  it('ignoreBudget 条目豁免截断（但仍计入 used）', () => {
    const res = run({
      entries: [
        makeEntry({ key: 'plain', keys: ['apple'], order: 200 }),
        makeEntry({ key: 'free', keys: ['apple'], order: 100, ignoreBudget: true }),
      ],
      messages: [userMsg('apple')],
      settings: budget(15),
    })
    expect(activatedKeys(res).sort()).toEqual(['free', 'plain'])
    expect(logsOf(res, 'budget-trim')).toEqual([])
    expect(res.truncated).toEqual([])
    expect(res.budget.used).toBe(20)
    expect(res.budget.overflowed).toBe(false)
  })

  it('overflowWarning 开启且发生截断时记 budget-overflow', () => {
    const res = run({
      entries: [makeEntry({ key: 'a', keys: ['apple'], order: 200 }), makeEntry({ key: 'b', keys: ['apple'], order: 100 })],
      messages: [userMsg('apple')],
      settings: budget(15),
    })
    expect(logsOf(res, 'budget-overflow')).toHaveLength(1)
    expect(res.truncated.map((t) => t.key)).toEqual(['b'])
    // 关闭告警则无 budget-overflow（截断日志仍在）
    const res2 = run({
      entries: [makeEntry({ key: 'a', keys: ['apple'], order: 200 }), makeEntry({ key: 'b', keys: ['apple'], order: 100 })],
      messages: [userMsg('apple')],
      settings: makeSettings({ tokenBudget: 15, overflowWarning: false }),
    })
    expect(logsOf(res2, 'budget-overflow')).toEqual([])
    expect(logsOf(res2, 'budget-trim')).toHaveLength(1)
  })

  it('tokenBudget=0 时按 contextPercent 折算预算', () => {
    const res = run({
      entries: [makeEntry({ key: 'a', keys: ['apple'] }), makeEntry({ key: 'b', keys: ['apple'] })],
      messages: [userMsg('apple')],
      contextWindowTokens: 80,
      settings: makeSettings({ tokenBudget: 0, contextPercent: 25 }), // limit = 20
    })
    expect(res.budget.limit).toBe(20)
    expect(activatedKeys(res).sort()).toEqual(['a', 'b'])
  })

  it('reservedTokens 只从百分比预算扣减；固定预算是绝对上限，不随历史缩水', () => {
    const entries = [makeEntry({ key: 'a', keys: ['apple'] })]
    const percent = run({
      entries,
      messages: [userMsg('apple')],
      contextWindowTokens: 80,
      reservedTokens: 12,
      settings: makeSettings({ tokenBudget: 0, contextPercent: 25 }),
    })
    const fixed = run({
      entries,
      messages: [userMsg('apple')],
      reservedTokens: 12,
      settings: makeSettings({ tokenBudget: 15 }),
    })
    const fixedLongChat = run({
      entries,
      messages: [userMsg('apple')],
      reservedTokens: 999,
      settings: makeSettings({ tokenBudget: 15 }),
    })

    expect(percent.budget.limit).toBe(8)
    expect(fixed.budget.limit).toBe(15)
    expect(fixedLongChat.budget.limit).toBe(15)
    expect(activatedKeys(percent)).toEqual([])
    expect(percent.truncated.map((t) => t.key)).toEqual(['a'])
    // 固定预算不再被历史吃掉：长会话里世界书层仍保得住
    expect(activatedKeys(fixedLongChat)).toEqual(['a'])
  })

  it('百分比预算的折算基数 clamp 到 128K：1M 窗口不会把预算放大成 25 万', () => {
    const res = run({
      entries: [makeEntry({ key: 'a', constant: true })],
      contextWindowTokens: 1_000_000,
      settings: makeSettings({ tokenBudget: 0, contextPercent: 25 }),
    })
    // floor(131072 * 25%) = 32768，而不是 250000
    expect(res.budget.limit).toBe(32768)
  })
})

// ---------------------------------------------------------------------------
// 位置分桶
// ---------------------------------------------------------------------------

describe('位置分桶', () => {
  it('before/afterCharDefs、AN top/bottom、@D、EM top/bottom 各就各位', () => {
    const at = (position: (typeof WIPosition)[keyof typeof WIPosition]) => makeEntry({ key: `p${position}`, constant: true, position })
    const res = run({
      entries: [
        at(WIPosition.BeforeCharDefs),
        at(WIPosition.AfterCharDefs),
        at(WIPosition.AuthorNoteTop),
        at(WIPosition.AuthorNoteBottom),
        at(WIPosition.AtDepth),
        at(WIPosition.BeforeExampleMessages),
        at(WIPosition.AfterExampleMessages),
      ],
    })
    for (const pos of [0, 1, 2, 3, 4, 5, 6] as const) {
      expect(res.byPosition[pos]?.map((a) => a.entry.key)).toEqual([`p${pos}`])
    }
  })

  it('同位置按 order 升序', () => {
    const res = run({
      entries: [
        makeEntry({ key: 'b', constant: true, order: 200 }),
        makeEntry({ key: 'a', constant: true, order: 100 }),
      ],
    })
    expect(res.byPosition[WIPosition.BeforeCharDefs]!.map((x) => x.entry.key)).toEqual(['a', 'b'])
  })

  it('outlet 按名分组；无名 outlet 条目被丢弃', () => {
    const res = run({
      entries: [
        makeEntry({ key: 'o1', constant: true, position: WIPosition.Outlet, outletName: 'stats', order: 200 }),
        makeEntry({ key: 'o2', constant: true, position: WIPosition.Outlet, outletName: 'stats', order: 100 }),
        makeEntry({ key: 'o3', constant: true, position: WIPosition.Outlet, outletName: 'inv' }),
        makeEntry({ key: 'dropped', constant: true, position: WIPosition.Outlet, outletName: '' }),
      ],
    })
    expect(Object.keys(res.outlets).sort()).toEqual(['inv', 'stats'])
    expect(res.outlets['stats']!.map((a) => a.entry.key)).toEqual(['o2', 'o1'])
    expect(res.outlets['inv']!.map((a) => a.entry.key)).toEqual(['o3'])
    // 无名 outlet 不进任何桶
    expect(res.byPosition[WIPosition.Outlet]).toBeUndefined()
    expect(activatedKeys(res)).not.toContain('dropped')
  })
})

// ---------------------------------------------------------------------------
// 多来源合并
// ---------------------------------------------------------------------------

describe('多来源合并排序', () => {
  const sources = () => [
    makeEntry({ key: 'g', source: 'global', constant: true, order: 100 }),
    makeEntry({ key: 'c', source: 'character', constant: true, order: 100 }),
    makeEntry({ key: 'p', source: 'persona', constant: true, order: 100 }),
    makeEntry({ key: 'ch', source: 'chat', constant: true, order: 100 }),
  ]

  it('strategy 1（character_first）：chat > persona > character > global', () => {
    const res = run({ entries: sources(), settings: makeSettings({ characterStrategy: 1 }) })
    expect(activatedKeys(res)).toEqual(['ch', 'p', 'c', 'g'])
  })

  it('strategy 2（global_first）：chat > persona > global > character', () => {
    const res = run({ entries: sources(), settings: makeSettings({ characterStrategy: 2 }) })
    expect(activatedKeys(res)).toEqual(['ch', 'p', 'g', 'c'])
  })

  it('strategy 0（sorted_evenly）：character/global 同 tier，纯按 order 交错', () => {
    const entries = [
      makeEntry({ key: 'character-late', source: 'character', constant: true, order: 200 }),
      makeEntry({ key: 'global-early', source: 'global', constant: true, order: 100 }),
    ]
    const even = run({ entries, settings: makeSettings({ characterStrategy: 0 }) })
    const characterFirst = run({ entries, settings: makeSettings({ characterStrategy: 1 }) })
    expect(activatedKeys(even)).toEqual(['global-early', 'character-late'])
    expect(activatedKeys(characterFirst)).toEqual(['character-late', 'global-early'])
  })

  it('chat 来源永远最前（strategy 0/1/2 均成立）', () => {
    for (const characterStrategy of [0, 1, 2] as const) {
      const res = run({ entries: sources(), settings: makeSettings({ characterStrategy }) })
      expect(activatedKeys(res)[0]).toBe('ch')
    }
  })
})

// ---------------------------------------------------------------------------
// includeNames
// ---------------------------------------------------------------------------

describe('includeNames', () => {
  const entry = makeEntry({ key: 'e', keys: ['Bob: 喜欢吃苹果'] })
  const messages = [userMsg('喜欢吃苹果', 'Bob')]

  it('开启时键 `Name: 关键词` 命中带 name 前缀的消息', () => {
    expect(activatedKeys(run({ entries: [entry], messages, settings: makeSettings({ includeNames: true }) }))).toEqual(['e'])
  })

  it('关闭时同样的键不命中（正文不含名前缀）', () => {
    expect(activatedKeys(run({ entries: [entry], messages, settings: makeSettings({ includeNames: false }) }))).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 其他
// ---------------------------------------------------------------------------

describe('其他行为', () => {
  it('disabled 条目不激活并记 disabled 日志', () => {
    const res = run({ entries: [makeEntry({ key: 'e', constant: true, enabled: false })] })
    expect(activatedKeys(res)).toEqual([])
    expect(logsOf(res, 'disabled').map((l) => l.entryKey)).toEqual(['e'])
  })

  it('无键且非 constant 的条目不激活', () => {
    expect(activatedKeys(run({ entries: [makeEntry({ key: 'e' })], messages: [userMsg('anything')] }))).toEqual([])
  })

  it('引擎为纯函数：不修改入参 entries/messages/timerState', () => {
    const entries = [makeEntry({ key: 'e', keys: ['apple'], sticky: 2 })]
    const timerState: WITimerState = { stickyLeft: {}, cooldownLeft: {} }
    run({ entries, messages: [userMsg('apple')], timerState })
    expect(timerState).toEqual({ stickyLeft: {}, cooldownLeft: {} })
  })
})

// ---------------------------------------------------------------------------
// inclusion group
// ---------------------------------------------------------------------------

describe('inclusion group', () => {
  it('同组只留一条；权重随机：0 取第一条，接近 1 取第二条', () => {
    const entries = [
      makeEntry({ key: 'a', keys: ['x'], group: 'g', groupWeight: 100 }),
      makeEntry({ key: 'b', keys: ['x'], group: 'g', groupWeight: 100 }),
    ]
    expect(activatedKeys(run({ entries, messages: [userMsg('x')], random: () => 0 }))).toEqual(['a'])
    expect(activatedKeys(run({ entries, messages: [userMsg('x')], random: () => 0.99 }))).toEqual(['b'])
    expect(logsOf(run({ entries, messages: [userMsg('x')], random: () => 0 }), 'group-skip').map((l) => l.entryKey)).toEqual(['b'])
  })

  it('groupOverride 压过同组无 override 的条目', () => {
    const entries = [
      makeEntry({ key: 'a', keys: ['x'], group: 'g', groupWeight: 100 }),
      makeEntry({ key: 'b', keys: ['x'], group: 'g', groupWeight: 1, groupOverride: true }),
    ]
    expect(activatedKeys(run({ entries, messages: [userMsg('x')], random: () => 0 }))).toEqual(['b'])
  })

  it('useGroupScoring 按命中键数挑选，不看随机', () => {
    const entries = [
      makeEntry({ key: 'a', keys: ['x'], group: 'g' }),
      makeEntry({ key: 'b', keys: ['x', 'y'], group: 'g' }),
    ]
    const res = run({
      entries,
      messages: [userMsg('x y')],
      settings: makeSettings({ useGroupScoring: true }),
      random: () => 0,
    })
    expect(activatedKeys(res)).toEqual(['b'])
  })

  it('sticky 延续占用组，同组新命中记 group-skip', () => {
    const entries = [
      makeEntry({ key: 'a', keys: ['apple'], group: 'g', sticky: 2 }),
      makeEntry({ key: 'b', keys: ['banana'], group: 'g' }),
    ]
    const results = runChain(entries, ['apple', 'banana'])
    expect(activatedKeys(results[0]!)).toEqual(['a'])
    expect(activatedKeys(results[1]!)).toEqual(['a'])
    expect(results[1]!.activated[0]!.via).toBe('sticky')
    expect(logsOf(results[1]!, 'group-skip').map((l) => l.entryKey)).toEqual(['b'])
  })

  it('同组落选条目不写入 sticky/cooldown，避免下一轮占组', () => {
    const entries = [
      makeEntry({ key: 'a', keys: ['x'], group: 'g', sticky: 2, cooldown: 3 }),
      makeEntry({ key: 'b', keys: ['x'], group: 'g', sticky: 2, cooldown: 3 }),
    ]
    const res = run({ entries, messages: [userMsg('x')], random: () => 0 })
    expect(activatedKeys(res)).toEqual(['a'])
    expect(res.timerState.stickyLeft['a']).toBe(2)
    expect(res.timerState.stickyLeft['b']).toBeUndefined()
    expect(res.timerState.cooldownLeft['b']).toBeUndefined()
  })

  it('落选组员的正文不喂给后续递归轮次（不再让落选者决定别人是否被激活）', () => {
    // a、b 同组且首轮同时命中；a 胜出后，b 的正文（含 D 的键）不得再进入递归扫描
    const entries = [
      makeEntry({ key: 'a', keys: ['apple'], group: 'g', content: 'banana' }),
      makeEntry({ key: 'b', keys: ['apple'], group: 'g', content: 'cherry' }),
      makeEntry({ key: 'C', keys: ['banana'] }),
      makeEntry({ key: 'D', keys: ['cherry'] }),
    ]
    const res = run({ entries, messages: [userMsg('apple')], random: () => 0 })
    // a 胜出 → 其正文触发 C；b 落选 → cherry 不进入递归，D 不激活
    expect(activatedKeys(res).sort()).toEqual(['C', 'a'])
    expect(logsOf(res, 'group-skip').map((l) => l.entryKey)).toEqual(['b'])
    expect(res.log.some((l) => l.entryKey === 'D' && l.kind === 'activated')).toBe(false)
  })

  it('递归轮新晋组员与现任胜者重新角逐：override 翻盘后，落选的正文不再喂更深层递归', () => {
    // level 0：X 与 a 激活（a 独占组暂为胜者）；level 1：b 被 X 的正文递归命中，以 override 翻盘；
    // a 落选后其正文不再喂 level 2；b 作为新胜者正文 date 正常触发 D（level 2）。
    // C 在 level 1 经当时仍在位的 a 正文激活——裁决发生在每轮扫描之后，属既定时序语义。
    const entries = [
      makeEntry({ key: 'X', keys: ['apple'], content: 'banana' }),
      makeEntry({ key: 'a', keys: ['apple'], group: 'g', content: 'cherry' }),
      makeEntry({ key: 'b', keys: ['banana'], group: 'g', groupOverride: true, content: 'date' }),
      makeEntry({ key: 'C', keys: ['cherry'] }),
      makeEntry({ key: 'D', keys: ['date'] }),
    ]
    const res = run({ entries, messages: [userMsg('apple')], random: () => 0 })
    expect(activatedKeys(res).sort()).toEqual(['C', 'D', 'X', 'b'])
    expect(logsOf(res, 'group-skip').map((l) => l.entryKey)).toEqual(['a'])
    expect(res.activated.find((x) => x.entry.key === 'b')!.via).toBe('recursion')
    expect(res.activated.find((x) => x.entry.key === 'D')!.recursionLevel).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 落选回滚（未注入条目不得留下定时状态）
// ---------------------------------------------------------------------------

describe('未注入条目的定时状态回滚', () => {
  it('被预算截断的条目不写入 sticky/cooldown（否则下一轮免概率回来占组）', () => {
    const res = run({
      entries: [
        // {{time}} 让这条 constant 落 turn 侧参与计费（无本轮宏的 constant 已豁免预算）
        makeEntry({ key: 'win', constant: true, content: '{{time}}', order: 200, sticky: 3, cooldown: 5 }),
        makeEntry({ key: 'trimmed', keys: ['apple'], order: 100, sticky: 3, cooldown: 5 }),
      ],
      messages: [userMsg('apple')],
      settings: makeSettings({ tokenBudget: 15 }), // 每条 10 tokens，只放得下一条
    })
    expect(activatedKeys(res)).toEqual(['win'])
    expect(logsOf(res, 'budget-trim').map((l) => l.entryKey)).toEqual(['trimmed'])
    expect(res.timerState.stickyLeft['win']).toBe(3)
    expect(res.timerState.cooldownLeft['win']).toBe(8)
    expect(res.timerState.stickyLeft['trimmed']).toBeUndefined()
    expect(res.timerState.cooldownLeft['trimmed']).toBeUndefined()
  })

  it('被截断的条目下一轮不经 sticky 复活，同组兄弟仍可竞争', () => {
    const entries = [
      makeEntry({ key: 'trimmed', keys: ['apple'], order: 100, sticky: 3 }),
      makeEntry({ key: 'sibling', keys: ['apple'], order: 100, group: 'g' }),
      makeEntry({ key: 'win', constant: true, content: '{{time}}', order: 200 }),
    ]
    const results = runChain(entries, ['apple', 'apple'], { settings: makeSettings({ tokenBudget: 15 }) })
    expect(activatedKeys(results[0]!)).toEqual(['win'])
    expect(activatedKeys(results[1]!)).toEqual(['win'])
    expect(results[1]!.log.some((l) => l.entryKey === 'trimmed' && l.kind === 'activated' && l.detail.includes('via=sticky'))).toBe(false)
  })

  it('无出口的 outlet 条目不写入 sticky/cooldown', () => {
    const res = run({
      entries: [makeEntry({ key: 'dropped', constant: true, position: WIPosition.Outlet, outletName: '', sticky: 3, cooldown: 5 })],
    })
    expect(activatedKeys(res)).toEqual([])
    expect(res.timerState.stickyLeft['dropped']).toBeUndefined()
    expect(res.timerState.cooldownLeft['dropped']).toBeUndefined()
  })

  it('sticky 延续条目本轮被预算裁掉时清 stickyLeft（cooldown 保留），下一轮同组兄弟可竞争', () => {
    const entries = [
      makeEntry({ key: 'a', keys: ['apple'], group: 'g', sticky: 3, cooldown: 5, order: 100 }),
      makeEntry({ key: 'b', keys: ['banana'], group: 'g', order: 100 }),
      // {{time}} 让这条 constant 落 turn 侧参与计费，order 大在预算排序里先占额度
      makeEntry({ key: 'win', constant: true, content: '{{time}}', order: 200 }),
    ]
    let timerState: WITimerState = EMPTY_TIMER_STATE
    const runRound = (text: string, tokenBudget: number): WIEngineResult => {
      const res = evaluateWorldInfo({
        entries,
        messages: [userMsg(text)],
        settings: makeSettings({ tokenBudget }),
        timerState,
        contextWindowTokens: 1000,
        reservedTokens: 0,
        estimateTokens: () => 10,
        random: () => 0.5,
      })
      timerState = res.timerState
      return res
    }

    // 第 1 轮：a 命中注入，sticky=3 写入（cooldown 串联为 5+3=8）
    const r1 = runRound('apple', 100)
    expect(activatedKeys(r1)).toEqual(['a', 'win'])
    expect(r1.timerState.stickyLeft['a']).toBe(3)

    // 第 2 轮：a 经 via='sticky' 免概率回归并占住组（b 记 group-skip），但被预算裁掉。
    // 计时是第 1 轮写入的，仍必须清 stickyLeft；cooldown 保留（轮末 8→7）。
    const r2 = runRound('banana', 15)
    expect(activatedKeys(r2)).toEqual(['win'])
    expect(logsOf(r2, 'group-skip').map((l) => l.entryKey)).toEqual(['b'])
    expect(logsOf(r2, 'budget-trim').map((l) => l.entryKey)).toEqual(['a'])
    expect(r2.timerState.stickyLeft['a']).toBeUndefined()
    expect(r2.timerState.cooldownLeft['a']).toBe(7)

    // 第 3 轮：a 不再 sticky 复活（cooldown 仍在，记 cooldown-skip；win 的正文触发一层递归故记两次），同组 b 正常命中注入
    const r3 = runRound('banana', 100)
    expect(activatedKeys(r3)).toEqual(['b', 'win'])
    expect(logsOf(r3, 'cooldown-skip').some((l) => l.entryKey === 'a')).toBe(true)
    expect(r3.log.some((l) => l.entryKey === 'a' && l.kind === 'activated' && l.detail.includes('via=sticky'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 键安全（主事件循环扫描第三方键，防 DoS）
// ---------------------------------------------------------------------------

describe('键安全', () => {
  it('超长键（>500 字符）与灾难回溯正则键按「永不命中」处理', () => {
    const res = run({
      entries: [
        makeEntry({ key: 'long', keys: ['x'.repeat(501)] }),
        makeEntry({ key: 'evil', keys: ['/(a+)+$/'] }),
      ],
      messages: [userMsg(`${'x'.repeat(600)} ${'a'.repeat(30)}b`)],
    })
    expect(activatedKeys(res)).toEqual([])
    // 也不该留下任何激活日志
    expect(res.log.some((l) => l.kind === 'activated')).toBe(false)
  })

  it('恰好 500 字符的键与合法正则键不受影响', () => {
    const key500 = 'k'.repeat(500)
    const res = run({
      entries: [makeEntry({ key: 'edge', keys: [key500] }), makeEntry({ key: 're', keys: ['/c.t/'] })],
      messages: [userMsg(`${key500} and a cat`)],
    })
    expect(activatedKeys(res).sort()).toEqual(['edge', 're'])
  })

  it('绕过归一化的调用方传入非字符串键/非数组 keys：塌缩为安全形态，不炸在 .map/.trim', () => {
    const mixed = makeEntry({ key: 'mixed', keys: ['ok'] })
    ;(mixed as { keys: unknown }).keys = ['ok', 42, null]
    expect(activatedKeys(run({ entries: [mixed], messages: [userMsg('ok fine')] }))).toEqual(['mixed'])

    const bad = makeEntry({ key: 'bad', keys: ['ok'] })
    ;(bad as { keys: unknown }).keys = 'not-an-array'
    expect(activatedKeys(run({ entries: [bad], messages: [userMsg('ok')] }))).toEqual([])

    const badGroup = makeEntry({ key: 'bg', keys: ['ok'], group: 'g' })
    ;(badGroup as { group: unknown }).group = 42
    const res = run({ entries: [badGroup], messages: [userMsg('ok')] })
    expect(activatedKeys(res)).toEqual(['bg']) // 非字符串 group 视为不分组
  })
})


it('AN/outlet 和条件常驻不得豁免 turn 预算', () => {
  for (const position of [WIPosition.AuthorNoteTop, WIPosition.AuthorNoteBottom, WIPosition.Outlet]) {
    expect(isStandingSafeEntry(makeEntry({ key: 'test', constant: true, position }))).toBe(false)
  }
  expect(isStandingSafeEntry(makeEntry({ key: 'test', constant: true, group: 'g' }))).toBe(false)
  expect(isStandingSafeEntry(makeEntry({ key: 'test', constant: true, probability: 0, useProbability: true }))).toBe(false)
})

it('条目计分覆盖全局：启用时低分淘汰，显式关闭仍参与权重选择',()=>{
  const entries=[makeEntry({key:'low',keys:['x'],group:'g',useGroupScoring:true}),makeEntry({key:'high',keys:['x','y'],group:'g'})]
  expect(activatedKeys(run({entries,messages:[userMsg('x y')],settings:makeSettings({useGroupScoring:false}),random:()=>0}))).toEqual(['high'])
  entries[0]!.useGroupScoring=false
  expect(activatedKeys(run({entries,messages:[userMsg('x y')],settings:makeSettings({useGroupScoring:true}),random:()=>0}))).toEqual(['low'])
})
it('同分计分组保留权重选择，低分 override 不绕过已启用的计分过滤',()=>{
  const equal=[makeEntry({key:'a',keys:['x'],group:'g',groupWeight:1}),makeEntry({key:'b',keys:['x'],group:'g',groupWeight:100})]
  expect(activatedKeys(run({entries:equal,messages:[userMsg('x')],settings:makeSettings({useGroupScoring:true}),random:()=>0}))).toEqual(['a'])
  equal[1]!.keys=['x','y'];equal[0]!.groupOverride=true
  expect(activatedKeys(run({entries:equal,messages:[userMsg('x y')],settings:makeSettings({useGroupScoring:true}),random:()=>0}))).toEqual(['b'])
})

/** 最少激活扩展与递归共用一次评估，不能重复定时/概率或越过条目深度。 */
describe('最少激活历史扩展',()=>{
  const messages=[userMsg('old'),userMsg('middle'),userMsg('latest')]
  it('扩深不能重置总扫描预算：两轮只扫描最近两条消息',()=>{
    const entries=[makeEntry({key:'oldest',keys:['old']})]
    const settings=makeSettings({scanDepth:1,minActivations:1,maxRecursionSteps:2,recursiveScan:false})
    expect(activatedKeys(run({entries,messages,settings}))).toEqual([])
  })
  it('逐条扩深到目标，最大深度与条目深度独立约束',()=>{
    const entries=[makeEntry({key:'a',keys:['middle']}),makeEntry({key:'b',keys:['old']}),makeEntry({key:'fixed',keys:['old'],scanDepth:1})]
    const evaluate=(settings:Partial<WorldInfoGlobalSettings>)=>activatedKeys(run({entries,messages,settings:makeSettings({scanDepth:1,recursiveScan:false,...settings})}))
    expect(evaluate({})).toEqual([])
    expect(evaluate({minActivations:1})).toEqual(['a'])
    expect(evaluate({minActivations:3,maxScanDepth:2})).toEqual(['a'])
    expect(evaluate({minActivations:3})).toEqual(['a','b'])
    expect(evaluate({minActivations:3,maxRecursionSteps:1})).toEqual([])
  })
  it('扩深找到的条目继续递归，递归排除不阻止直接历史命中',()=>{
    const entries=[makeEntry({key:'a',keys:['middle'],content:'recurse',excludeRecursion:true}),makeEntry({key:'b',keys:['recurse']})]
    expect(activatedKeys(run({entries,messages,settings:makeSettings({scanDepth:1,minActivations:2,recursiveScan:true})}))).toEqual(['a','b'])
    // 扩深可以触发递归，但初始、扩深、递归三次扫描仍受同一个总预算约束。
    expect(activatedKeys(run({entries,messages,settings:makeSettings({scanDepth:1,minActivations:2,recursiveScan:true,maxRecursionSteps:2})}))).toEqual(['a'])
    expect(activatedKeys(run({entries,messages,settings:makeSettings({scanDepth:1,minActivations:2,recursiveScan:true,maxRecursionSteps:3})}))).toEqual(['a','b'])
  })
  it('扩展轮的递归门槛与首轮同口径：delayUntilRecursion=1 的条目在扩展轮递归可激活',()=>{
    const entries=[makeEntry({key:'direct',keys:['latest']}),makeEntry({key:'delayed',keys:['recurse'],delayUntilRecursion:1}),makeEntry({key:'feeder',keys:['older'],content:'recurse'})]
    const history=[userMsg('older'),userMsg('latest')]
    // 无扩展：direct 直接命中，无递归输入 → delayed 不可达
    expect(activatedKeys(run({entries,messages:history,settings:makeSettings({scanDepth:1,recursiveScan:true})}))).toEqual(['direct'])
    // 扩展轮 feeder 经扩深命中后其内容进入递归 level=1：delayed 应与正常递归路径同口径激活
    expect(activatedKeys(run({entries,messages:history,settings:makeSettings({scanDepth:1,recursiveScan:true,minActivations:2,maxRecursionSteps:3})}))).toEqual(['delayed','direct','feeder'])
    // 对照：直接递归路径下 delayed 在首轮递归激活
    const direct=[makeEntry({key:'delayed',keys:['recurse'],delayUntilRecursion:1}),makeEntry({key:'feeder',keys:['latest'],content:'recurse'})]
    expect(activatedKeys(run({entries:direct,messages:[userMsg('latest')],settings:makeSettings({scanDepth:1,recursiveScan:true,maxRecursionSteps:2})}))).toEqual(['delayed','feeder'])
  })
  it('空内容递归轮不消耗递归步数',()=>{
    // direct 命中但 content 为空：递归轮无可扫文本即终止，level 不 +1；
    // 否则 maxRecursionSteps=2 的预算被空轮吃掉，minActivations 扩展轮被挡死。
    const entries=[makeEntry({key:'direct',keys:['latest']}),makeEntry({key:'older',keys:['old'],content:'x'})]
    const history=[userMsg('old'),userMsg('latest')]
    expect(activatedKeys(run({entries,messages:history,settings:makeSettings({scanDepth:1,recursiveScan:true,minActivations:2,maxRecursionSteps:2})}))).toEqual(['direct','older'])
  })
  it('扩深不会重复掷骰或扣减旧定时器，达到预算溢出后停止扩深',()=>{
    let rolls=0
    const entries=[makeEntry({key:'roll',keys:['latest'],probability:50,useProbability:true}),makeEntry({key:'sticky',sticky:3}),makeEntry({key:'old',keys:['old']})]
    const result=run({entries,messages,random:()=>{rolls++;return 0.9},timerState:{stickyLeft:{sticky:3},cooldownLeft:{unrelated:4}},settings:makeSettings({scanDepth:1,minActivations:9})})
    expect(rolls).toBe(1);expect(result.timerState.stickyLeft.sticky).toBe(2);expect(result.timerState.cooldownLeft.unrelated).toBe(3)
    expect(activatedKeys(result)).toEqual(['old','sticky'])
    const limited=run({entries:[makeEntry({key:'large',keys:['latest']}),makeEntry({key:'older',keys:['old']})],messages,settings:makeSettings({scanDepth:1,minActivations:3,tokenBudget:1})})
    expect(limited.truncated.map(item=>item.key)).toEqual(['large'])
    expect(limited.log.some(item=>item.entryKey==='older'&&item.kind==='activated')).toBe(false)
  })
})
