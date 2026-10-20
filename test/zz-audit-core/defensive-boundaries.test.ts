/**
 * 审计回归（C4/C5/C6 修复后）：
 * A. worldbook 对「绕过归一化的调用方」的塌缩：缺 keys / secondaryKeys 时不抛 TypeError；
 *    keys 缺失 = 永不命中；secondaryKeys 缺失 = 与空数组同口径（selective 不生效）。
 * B. characterDataExtras 不得丢弃 data 根的污染键，也不得改写返回对象的原型。
 * C. loreQuery 预算不足时返回结构化 ok:false，而不是被末尾 throw 覆盖。
 */
import { expect, it } from 'vitest'
import { characterDataExtras } from '../../src/core/characterData.js'
import { budgetLoreCatalog } from '../../src/core/loreQuery.js'
import { evaluateWorldInfo } from '../../src/core/worldbook.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE, WIPosition, WIRole, WISelectiveLogic, type CharacterCard, type WorldInfoEntry } from '../../src/core/types.js'

function entry(partial: Partial<WorldInfoEntry>): WorldInfoEntry {
  return {
    key: 'global:audit:1', uid: '1', source: 'global', sourceRef: 'audit',
    keys: [], secondaryKeys: [], selective: false, selectiveLogic: WISelectiveLogic.AndAny,
    comment: '', content: 'x', constant: false, enabled: true, order: 100,
    position: WIPosition.BeforeCharDefs, depth: 4, role: WIRole.System, outletName: '',
    probability: 100, useProbability: false, caseSensitive: null, matchWholeWords: null,
    scanDepth: null, excludeRecursion: false, preventRecursion: false, delayUntilRecursion: 0,
    sticky: null, cooldown: null, delay: null, ignoreBudget: false, group: '', groupWeight: 100,
    groupOverride: false, automationId: '',
    ...partial,
  }
}

const run = (entries: WorldInfoEntry[], content = 'x') => evaluateWorldInfo({
  entries, messages: [{ role: 'user', content }], settings: DEFAULT_WI_SETTINGS,
  timerState: EMPTY_TIMER_STATE, contextWindowTokens: 1000, reservedTokens: 0,
  estimateTokens: () => 1, random: () => 0,
})

it('A1. selective 条目的 secondaryKeys 缺失：与空数组同口径，不抛 TypeError', () => {
  const selective = entry({ keys: ['x'], selective: true })
  ;(selective as { secondaryKeys: unknown }).secondaryKeys = undefined
  expect(run([selective]).activated.map((item) => item.entry.key)).toEqual(['global:audit:1'])
  // 与显式空数组逐字一致（selective 在无次级键时不生效）
  const empty = entry({ keys: ['x'], selective: true, secondaryKeys: [] })
  expect(run([empty]).activated.map((item) => item.entry.key)).toEqual(['global:audit:1'])
})

it('A2. keys 缺失：塌缩为永不命中，而不是 TypeError', () => {
  const missing = entry({})
  ;(missing as { keys: unknown }).keys = undefined
  expect(run([missing]).activated).toEqual([])
})

it('A3. keys 非数组/含非字符串的既有塌缩口径不变', () => {
  const mixed = entry({ keys: ['ok'] })
  ;(mixed as { keys: unknown }).keys = ['ok', 42, null]
  expect(run([mixed], 'ok fine').activated.map((item) => item.entry.key)).toEqual(['global:audit:1'])
  const notArray = entry({ keys: ['ok'] })
  ;(notArray as { keys: unknown }).keys = 'not-an-array'
  expect(run([notArray], 'ok fine').activated).toEqual([])
})

it('B. data 根的 __proto__ 字段保留为自有属性，返回对象原型不被改写', () => {
  const card = {
    spec: 'chara_card_v2', name: 'n',
    raw: { data: JSON.parse('{"__proto__":{"direct":1},"extensions":{"__proto__":{"nested":1},"nested":2}}') },
    extensions: JSON.parse('{"__proto__":{"direct":1},"nested":2}'),
  } as unknown as CharacterCard
  const { fields, extensions } = characterDataExtras(card)
  for (const value of [fields, extensions]) {
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
    expect((value as Record<string, unknown>).polluted).toBeUndefined()
  }
  expect(Object.hasOwn(fields, '__proto__')).toBe(true)
  expect(Object.hasOwn(extensions, '__proto__')).toBe(true)
  expect(Object.keys(fields)).toContain('__proto__')
  // 往返不丢字段：展开后仍是自有 __proto__ 数据属性，JSON 序列化保留该键
  expect(JSON.stringify({ ...fields })).toContain('"__proto__"')
  expect(JSON.parse(JSON.stringify({ ...fields }))['__proto__']).toEqual({ direct: 1 })
})

it('C. 预算容不下条目正文时返回结构化 ok:false，而不是抛错', () => {
  const entries = [{
    key: 'k', uid: '1', source: 'global', sourceRef: 'audit', keys: ['a'.repeat(200)],
    secondaryKeys: [], comment: 'c'.repeat(200), content: '正文', enabled: true, constant: false,
    order: 0, position: 0,
  }] as unknown as Parameters<typeof budgetLoreCatalog>[0]
  const result = budgetLoreCatalog(entries, 70)
  expect(result.ok).toBe(false)
  expect(result.error).toContain('lore-output-too-large')
})
