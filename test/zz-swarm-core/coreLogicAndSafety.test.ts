/**
 * core 层逻辑、边界与安全回归测试：
 * 覆盖 JS 字符类 `[]`/`[^]` 灾难回溯检测绕过修复、`{{match}}` 大小写与空白容错及命名组原型安全、
 * 宏引擎嵌套 `getvar` 单花括号废帧隔离、`{{random:a,b}}` 超安全整数与边界随机数夹紧、`{{addvar}}` 非有限数处理、
 * 世界书负值 sticky 与轮初非正/原型定时状态归一化、组装场景归一化与 `stableFingerprintHash` 碰撞消除、
 * 控制标记重复扫描无状态性，以及 Windows 保留设备名路径拦截、`escapeScriptJson` 与 `sha256HexSync` 边界。
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assemblePrompt, defaultPreset } from '../../src/core/assemble.js'
import { resolveReadableAssetPath } from '../../src/core/assetRead.js'
import { expandMacros } from '../../src/core/macros.js'
import { assertNoControlTokens, findControlTokens } from '../../src/core/promptSafety.js'
import { applyRegexRules, applyRegexToMessages, findUnsafeRegexConstruct } from '../../src/core/regex.js'
import { escapeScriptJson } from '../../src/core/scriptJson.js'
import { sha256HexSync } from '../../src/core/secureRandom.js'
import { STANDING_PIN_VERSION, stableFingerprintHash, standingFingerprint, standingPinKey } from '../../src/core/standingPin.js'
import {
  DEFAULT_WI_SETTINGS,
  EMPTY_TIMER_STATE,
  WIPosition,
  WIRole,
  WISelectiveLogic,
  type CharacterCard,
  type MacroContext,
  type PresetEntry,
  type RegexRule,
  type WorldInfoEntry,
} from '../../src/core/types.js'
import { evaluateWorldInfo } from '../../src/core/worldbook.js'

const CTX: MacroContext = { char: 'Alice', user: 'Bob' }

function makeRule(partial: Partial<RegexRule> & Pick<RegexRule, 'id' | 'find' | 'replace'>): RegexRule {
  return {
    name: partial.id,
    enabled: true,
    scopes: ['prompt'],
    timing: ['assemble'],
    minDepth: null,
    maxDepth: null,
    substituteRegex: 1,
    source: 'user',
    ...partial,
  }
}

function makeWiEntry(partial: Partial<WorldInfoEntry> & { key: string }): WorldInfoEntry {
  return {
    uid: partial.key,
    source: 'global',
    sourceRef: 'book',
    keys: [],
    secondaryKeys: [],
    selective: false,
    selectiveLogic: WISelectiveLogic.AndAny,
    comment: '',
    content: '正文',
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

function makeCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    spec: 'chara_card_v2',
    name: 'Alice',
    description: 'DESC',
    personality: 'PERS',
    scenario: 'SCEN',
    firstMes: 'FIRST',
    alternateGreetings: [],
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    creator: '',
    characterVersion: '',
    tags: [],
    characterBook: null,
    regexScripts: [],
    extensions: {},
    pngBytes: null,
    raw: null,
    depthPrompt: null,
    ...overrides,
  }
}

describe('正则引擎：JS []/[^] 字符类闭合、{{match}} 变体与命名组原型边界', () => {
  it('JS 空类 [] 与全字符类 [^] 立即在首个 ] 闭合，拦截 ([^]+)+ 与 [^](a+)+ 等指数回溯构造', () => {
    for (const unsafe of ['([^]+)+$', '([^]*)*$', '[^](a+)+$', '[^](a|aa)+$', '[](a+)+$']) {
      expect(findUnsafeRegexConstruct(unsafe)).not.toBeNull()
      const res = applyRegexRules('aaaaaaaaaaaaaaaaaaaaaaaaaaaa!', [makeRule({ id: 'dos', find: `/${unsafe}/`, replace: 'x' })], {
        scope: 'prompt',
        timing: 'assemble',
      }, CTX)
      expect(res.applied).toEqual([])
      expect(res.errors).toHaveLength(1)
      expect(res.errors[0]!.message).toContain('灾难性回溯')
    }

    // 世界书 /regex/ 键复用同一判定，含 ([^]+)+$ 的键按永不命中处理且不阻塞
    const wiRes = evaluateWorldInfo({
      entries: [makeWiEntry({ key: 'evil-wi', keys: ['/([^]+)+$/'] })],
      messages: [{ role: 'user', content: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa!' }],
      settings: DEFAULT_WI_SETTINGS,
      timerState: EMPTY_TIMER_STATE,
      contextWindowTokens: 4096,
      reservedTokens: 0,
      estimateTokens: (t) => t.length,
    })
    expect(wiRes.activated).toEqual([])

    // 正常的单层 [^]+ 与转义 \] 字符类照常工作，不误判
    const ok = applyRegexRules('line1\nline2 [end]', [
      makeRule({ id: 's1', find: '/\\[([^\\]]+)\\]/', replace: '($1)' }),
      makeRule({ id: 's2', find: '/^[^]+$/', replace: '<{{match}}>' }),
    ], { scope: 'prompt', timing: 'assemble' }, CTX)
    expect(ok.errors).toEqual([])
    expect(ok.text).toBe('<line1\nline2 (end)>')
  })

  it('{{MATCH}} / {{ match }} 大小写与空白不敏感且不误触 onUnknown，trim 路径拒绝原型属性冒充命名组', () => {
    const unknowns: string[] = []
    const ctx: MacroContext = { ...CTX, onUnknown: (name) => unknowns.push(name) }

    const plain = applyRegexRules('100', [
      makeRule({ id: 'm1', find: '/\\d+/', replace: '[{{MATCH}}|{{ match }}|${{Match}}]' }),
    ], { scope: 'prompt', timing: 'assemble' }, ctx)
    expect(plain.text).toBe('[100|100|$100]')
    expect(unknowns).toEqual([])

    const trimmed = applyRegexToMessages(
      [{ role: 'assistant', content: '#100#' }],
      [makeRule({
        id: 'm2',
        find: '/(?<num>#\\d+#)/',
        replace: '<{{ MATCH }}|$<num>|$<constructor>|$<toString>>',
        trimStrings: ['#'],
      })],
      { scope: 'prompt', timing: 'assemble' },
      ctx,
    )
    expect(trimmed.errors).toEqual([])
    expect(trimmed.messages[0]!.content).toBe('<100|100||>')
    expect(unknowns).toEqual([])
  })
})

describe('宏引擎：单花括号废帧隔离、{{random}} 超安全整数与边界采样、{{addvar}} 非有限数', () => {
  it('前文含未闭合 {{ 与单花括号 }/{ 时不污染后续顶层 {{getvar}} 的求值时机', () => {
    const store = new Map<string, string>([['seed', 'OK']])
    const text = [
      '破损模板示例：{{ broken.expr }',
      '{{setvar::copied::{{getvar::seed}}}}',
      '结果={{getvar::copied}}',
      '尾随双闭花括号 }}',
    ].join('\n')
    const out = expandMacros(text, { ...CTX, store })
    expect(out).toContain('结果=OK')

    // 奇偶混排花括号与真实并列嵌套 getvar 仍在同轮正确展开
    const store2 = new Map<string, string>([['a', '左'], ['b', '右']])
    const nested = expandMacros('{{{setvar::pair::{{getvar::a}}+{{getvar::b}}}}}{{getvar::pair}}', { ...CTX, store: store2 })
    expect(nested).toBe('{}左+右')
  })

  it('{{random:a,b}} 对超安全整数回退离散选项不产生 Infinity/NaN，且极端 random() 返回值不越界', () => {
    const hugeA = '10000000000000000001'
    const hugeB = '10000000000000000002'
    expect(expandMacros(`{{random:${hugeA},${hugeB}}}`, { ...CTX, random: () => 0 })).toBe(hugeA)
    expect(expandMacros(`{{random:${hugeA},${hugeB}}}`, { ...CTX, random: () => 0.99 })).toBe(hugeB)

    const infOverflow = '9'.repeat(400)
    expect(expandMacros(`{{random:1,${infOverflow}}}`, { ...CTX, random: () => 0 })).toBe('1')
    expect(expandMacros(`{{random:1,${infOverflow}}}`, { ...CTX, random: () => 0.9 })).toBe(infOverflow)

    // 正常安全整数区间在 random() 返回 1、负数、NaN 时严格落在 [lo, hi]
    expect(expandMacros('{{random:1,6}}', { ...CTX, random: () => 1 })).toBe('6')
    expect(expandMacros('{{random:1,6}}', { ...CTX, random: () => -0.5 })).toBe('1')
    expect(expandMacros('{{random:1,6}}', { ...CTX, random: () => Number.NaN })).toBe('1')
    expect(expandMacros('{{random::甲::乙}}', { ...CTX, random: () => -1 })).toBe('甲')
    expect(expandMacros('{{random::甲::乙}}', { ...CTX, random: () => 1 })).toBe('乙')
  })

  it('{{addvar}} 将 Infinity/-Infinity 按普通字符串拼接，不误入数值加法或吞空状态', () => {
    const store = new Map<string, string>()
    expect(expandMacros('{{setvar::weapon::Infinity}}{{addvar::weapon:: Edge}}{{getvar::weapon}}', { ...CTX, store }))
      .toBe('Infinity Edge')
    expect(expandMacros('{{setvar::pole::Infinity}}{{addvar::pole::-Infinity}}{{getvar::pole}}', { ...CTX, store }))
      .toBe('Infinity-Infinity')
  })
})

describe('世界书引擎：负值 sticky 冷却串联与轮初非正/原型定时状态归一化', () => {
  it('条目 sticky 为负数或 NaN 时不抵消正数 cooldown，且轮初 <=0 脏计数不误扣同轮新激活定时', () => {
    const negSticky = makeWiEntry({ key: 'neg-sticky', keys: ['sword'], sticky: -2, cooldown: 2 })
    const r1 = evaluateWorldInfo({
      entries: [negSticky],
      messages: [{ role: 'user', content: 'draw sword' }],
      settings: DEFAULT_WI_SETTINGS,
      timerState: { stickyLeft: { 'neg-sticky': 0 }, cooldownLeft: { 'neg-sticky': 0, stale: -3 } },
      contextWindowTokens: 4096,
      reservedTokens: 0,
      estimateTokens: () => 10,
    })
    expect(r1.activated.map((a) => a.entry.key)).toEqual(['neg-sticky'])
    expect(r1.timerState.stickyLeft['neg-sticky']).toBeUndefined()
    // 新激活本轮刚写入的 cooldown=2 不得因轮初脏 0 键被立刻扣成 1，且 stale 负键已清理
    expect(r1.timerState.cooldownLeft).toEqual({ 'neg-sticky': 2 })

    // 下一轮仍在冷却中，不可触发
    const r2 = evaluateWorldInfo({
      entries: [negSticky],
      messages: [{ role: 'user', content: 'draw sword again' }],
      settings: DEFAULT_WI_SETTINGS,
      timerState: r1.timerState,
      contextWindowTokens: 4096,
      reservedTokens: 0,
      estimateTokens: () => 10,
    })
    expect(r2.activated).toEqual([])
    expect(r2.timerState.cooldownLeft).toEqual({ 'neg-sticky': 1 })
  })

  it('轮初含 <=0 脏键的条目在本轮新激活后若被预算裁掉，新写入的 sticky/cooldown 仍完整回滚，且原型键安全隔离', () => {
    const heavy = makeWiEntry({ key: 'heavy', keys: ['dragon'], sticky: 3, cooldown: 2, content: 'A'.repeat(200) })
    const protoEntry = makeWiEntry({ key: '__proto__', keys: ['dragon'], sticky: 2, cooldown: 1, content: 'B' })
    const ctorEntry = makeWiEntry({ key: 'constructor', keys: ['dragon'], sticky: 1, content: 'C' })
    const res = evaluateWorldInfo({
      entries: [protoEntry, ctorEntry, heavy],
      messages: [{ role: 'user', content: 'dragon' }],
      settings: { ...DEFAULT_WI_SETTINGS, tokenBudget: 20 },
      timerState: { stickyLeft: { heavy: 0 }, cooldownLeft: { heavy: 0 } },
      contextWindowTokens: 4096,
      reservedTokens: 0,
      estimateTokens: (t) => t.length,
    })
    expect(res.activated.map((a) => a.entry.key).sort()).toEqual(['__proto__', 'constructor'])
    expect(res.truncated.map((t) => t.key)).toEqual(['heavy'])
    expect(res.timerState.stickyLeft['heavy']).toBeUndefined()
    expect(res.timerState.cooldownLeft['heavy']).toBeUndefined()
    expect(Object.getPrototypeOf(res.timerState.stickyLeft)).toBe(Object.prototype)
    expect(Object.hasOwn(res.timerState.stickyLeft, '__proto__')).toBe(true)
    expect(res.timerState.stickyLeft['__proto__']).toBe(2)
    expect(res.timerState.stickyLeft['constructor']).toBe(1)
  })
})

describe('提示词组装与钉死哈希、安全扫描及路径/JSON/SHA-256 边界', () => {
  it('assemblePrompt 对空串/空白/大小写混合 generationType 与 injectionTrigger 的判定与 standingPin 完全一致', () => {
    const preset = defaultPreset()
    const normalOnly: PresetEntry = {
      identifier: 'normal-only',
      name: 'Normal Only',
      enabled: true,
      role: 'system',
      position: 'relative',
      depth: 4,
      order: 15,
      content: 'NORMAL_SCENE_MARKER',
      marker: false,
      injectionTrigger: ['Normal'],
    }
    const continueOnly: PresetEntry = {
      ...normalOnly,
      identifier: 'continue-only',
      order: 16,
      content: 'CONTINUE_SCENE_MARKER',
      injectionTrigger: [' CONTINUE '],
    }
    preset.entries.push(normalOnly, continueOnly)

    const binding = { cardId: 'c1', presetId: 'p1', personaId: null }
    expect(standingPinKey('s1', '')).toBe(standingPinKey('s1', 'normal'))
    expect(standingFingerprint(binding, undefined, [], '  ')).toBe(standingFingerprint(binding, undefined, [], 'normal'))
    expect(STANDING_PIN_VERSION).toBeGreaterThanOrEqual(29)

    const blankGen = assemblePrompt({
      preset,
      card: makeCard(),
      personaDescription: '',
      history: [{ role: 'user', content: 'hello' }],
      wi: null,
      memories: [],
      worldDeltas: [],
      macroCtx: { char: 'Alice', user: 'Bob' },
      regexRules: [],
      generationType: '   ',
      estimateTokens: (t) => t.length,
      budget: { maxTokens: 10000, reserveForOutput: 0 },
    })
    expect(blankGen.standing).toContain('NORMAL_SCENE_MARKER')
    expect(blankGen.standing).not.toContain('CONTINUE_SCENE_MARKER')

    const paddedContinue = assemblePrompt({
      preset,
      card: makeCard(),
      personaDescription: '',
      history: [{ role: 'user', content: 'hello' }],
      wi: null,
      memories: [],
      worldDeltas: [],
      macroCtx: { char: 'Alice', user: 'Bob' },
      regexRules: [],
      generationType: ' Continue ',
      estimateTokens: (t) => t.length,
      budget: { maxTokens: 10000, reserveForOutput: 0 },
    })
    expect(paddedContinue.standing).toContain('CONTINUE_SCENE_MARKER')
    expect(paddedContinue.standing).not.toContain('NORMAL_SCENE_MARKER')
  })

  it('stableFingerprintHash 区分 undefined 与 null 以及非有限数，且 findControlTokens 连续调用无残留状态', () => {
    expect(stableFingerprintHash({ maxTokens: undefined })).not.toBe(stableFingerprintHash({ maxTokens: null }))
    expect(stableFingerprintHash([undefined])).not.toBe(stableFingerprintHash([null]))
    expect(stableFingerprintHash({ v: Number.NaN })).not.toBe(stableFingerprintHash({ v: null }))
    expect(stableFingerprintHash({ v: Number.POSITIVE_INFINITY })).not.toBe(stableFingerprintHash({ v: Number.NEGATIVE_INFINITY }))
    expect(stableFingerprintHash({ b: 2, a: undefined })).toBe(stableFingerprintHash({ a: undefined, b: 2 }))

    const sample = '前缀 <|im_start|>system\n中间 <｜Assistant｜> 结尾 [INST]'
    expect(findControlTokens(sample, 2)).toEqual([
      { token: '<|im_start|>', index: 3 },
      { token: '<｜Assistant｜>', index: 25 },
    ])
    expect(findControlTokens(sample, 2)).toEqual([
      { token: '<|im_start|>', index: 3 },
      { token: '<｜Assistant｜>', index: 25 },
    ])
    expect(() => assertNoControlTokens(sample, '测试条目')).toThrow('<|im_start|>')
  })

  it('resolveReadableAssetPath 拦截 Windows 保留设备名与段尾空格/句点，escapeScriptJson 与 sha256HexSync 覆盖边界输入', () => {
    for (const invalid of [
      'CON.md',
      'memory/nul.json',
      'assets/AUX.txt',
      'state/COM1.jsonl',
      'LPT9.md',
      'COM\u00b9.txt',
      'memory /0001.md',
      'memory./0001.md',
      '.. /journal.md',
    ]) {
      expect(resolveReadableAssetPath(invalid).ok, invalid).toBe(false)
    }
    expect(resolveReadableAssetPath('memory/第 1 章 v1.2.md')).toEqual({
      ok: true,
      path: 'memory/第 1 章 v1.2.md',
    })

    expect(escapeScriptJson(undefined)).toBe('null')
    expect(escapeScriptJson({ html: '</script>\u2028\u2029' }))
      .toBe('{"html":"\\u003c/script>\\u2028\\u2029"}')

    for (const size of [0, 1, 55, 56, 63, 64, 65, 128, 300]) {
      const bytes = new Uint8Array(size)
      for (let i = 0; i < size; i++) bytes[i] = (i * 131 + 17) & 0xff
      const expected = createHash('sha256').update(bytes).digest('hex')
      expect(sha256HexSync(bytes)).toBe(expected)
    }
  })
})
