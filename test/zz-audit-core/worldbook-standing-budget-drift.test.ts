/**
 * 审计回归（C3 修复后）：引擎计费与 assemble 的 standing/turn 分流共用 isStandingBudgetSafe。
 * 读变量的常驻条目不再被整条豁免 tokenBudget：组装会把它送 turn，引擎就先按 turn 计费。
 */
import { expect, it } from 'vitest'
import { assemblePrompt, defaultPreset } from '../../src/core/assemble.js'
import { evaluateWorldInfo, isStandingBudgetSafe, isStandingSafeEntry } from '../../src/core/worldbook.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE, WIPosition, WIRole, WISelectiveLogic, type ChatMessage, type WorldInfoEntry } from '../../src/core/types.js'

function entry(partial: Partial<WorldInfoEntry>): WorldInfoEntry {
  return {
    key: 'global:audit:1', uid: '1', source: 'global', sourceRef: 'audit',
    keys: [], secondaryKeys: [], selective: false, selectiveLogic: WISelectiveLogic.AndAny,
    comment: '', content: '', constant: true, enabled: true, order: 100,
    position: WIPosition.BeforeCharDefs, depth: 4, role: WIRole.System, outletName: '',
    probability: 100, useProbability: false, caseSensitive: null, matchWholeWords: null,
    scanDepth: null, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: 0,
    sticky: null, cooldown: null, delay: null, ignoreBudget: false, group: '', groupWeight: 100,
    groupOverride: false, automationId: '',
    ...partial,
  }
}

const messages: ChatMessage[] = [{ role: 'user', content: '你好' }]

const evaluate = (target: WorldInfoEntry, tokenBudget: number) => evaluateWorldInfo({
  entries: [target], messages, settings: { ...DEFAULT_WI_SETTINGS, tokenBudget },
  timerState: EMPTY_TIMER_STATE, contextWindowTokens: 100000, reservedTokens: 0,
  estimateTokens: () => 1000, random: () => 0,
})

it('共用判定：读变量的常驻条目不算 standing 豁免，静态常驻条目仍豁免', () => {
  const dynamic = entry({ content: '{{getvar::mood}} 的设定正文' })
  const plain = entry({ content: '静态设定正文' })
  expect(isStandingSafeEntry(dynamic)).toBe(true) // 旧口径（只看正文宏）仍认为是常驻
  expect(isStandingBudgetSafe(dynamic)).toBe(false) // 新口径：读变量 → 组装会送 turn，必须计费
  expect(isStandingBudgetSafe(plain)).toBe(true)
  // 组装侧传入自己的依赖判定时，口径与引擎一致
  expect(isStandingBudgetSafe(dynamic, () => true)).toBe(false)
  expect(isStandingBudgetSafe(plain, () => false)).toBe(true)
})

it('tokenBudget 对读变量的常驻条目生效：预算不足时被截断而不是静默豁免', () => {
  const target = entry({ content: '{{getvar::mood}} 的设定正文' })
  const tight = evaluate(target, 1)
  expect(tight.budget.used).toBe(0)
  expect(tight.truncated.map((item) => item.key)).toEqual([target.key])
  expect(tight.byPosition[WIPosition.BeforeCharDefs] ?? []).toHaveLength(0)

  const loose = evaluate(target, 100000)
  expect(loose.budget.used).toBe(1000)
  expect(loose.truncated).toEqual([])

  // 组装仍按宏依赖把同一条目送 turn；现在引擎已经为它计过费，硬顶不再失效
  const assembled = assemblePrompt({
    preset: defaultPreset(), card: null, personaDescription: '',
    history: messages, wi: loose, memories: [], worldDeltas: [],
    macroCtx: { char: 'Alice', user: 'Bob', store: new Map([['mood', 'MOODVAL']]) },
    regexRules: [], estimateTokens: () => 1000, budget: { maxTokens: 100000, reserveForOutput: 0 },
  })
  expect(assembled.turnContext).toContain('MOODVAL 的设定正文')
  expect(assembled.standing).not.toContain('MOODVAL 的设定正文')
})

it('静态常驻条目仍整条豁免（对照，行为不变）', () => {
  const plain = entry({ content: '静态设定正文' })
  const result = evaluate(plain, 1)
  expect(result.budget.used).toBe(0)
  expect(result.truncated).toEqual([])
  expect(result.byPosition[WIPosition.BeforeCharDefs]).toHaveLength(1)

  const assembled = assemblePrompt({
    preset: defaultPreset(), card: null, personaDescription: '',
    history: messages, wi: result, memories: [], worldDeltas: [],
    macroCtx: { char: 'Alice', user: 'Bob' },
    regexRules: [], estimateTokens: () => 1000, budget: { maxTokens: 100000, reserveForOutput: 0 },
  })
  expect(assembled.standing).toContain('静态设定正文')
})
