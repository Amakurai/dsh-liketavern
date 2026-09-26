/** 资产导入、导出及宏/世界书匹配的独立缺陷复现；使用手写数据验证用户可见行为。 */
import { expect, it } from 'vitest'
import { expandMacros } from '../src/core/macros.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE, type MacroContext } from '../src/core/types.js'
import { evaluateWorldInfo } from '../src/core/worldbook.js'
import { exportLorebook, parseLorebook } from '../src/state/lorebook.js'
import { parseStPreset } from '../src/state/presetStore.js'

const scope = { source: 'global' as const, sourceRef: 'audit' }

it('首选角色的空预设顺序不回退到旧角色并重新开启提示词', () => {
  const { preset } = parseStPreset({ prompts: [{ identifier: 'hidden', content: '不应启用' }],
    prompt_order: [{ character_id: 100000, order: [{ identifier: 'hidden', enabled: true }] },
      { character_id: 100001, order: [] }] })
  expect(preset.entries[0]?.enabled).toBe(false)
})

it.each([{ position: '1' }, { position: 1, extensions: { vendor: 'metadata' } }])('原生世界书 %j 不被误判为角色书而丢掉触发词和禁用状态', fields => {
  const [entry] = parseLorebook({ entries: { '7': { ...fields, key: ['北门'], content: '关闭', disable: true, order: 42 } } }, scope)
  expect(entry).toMatchObject({ keys: ['北门'], enabled: false, order: 42, position: 1 })
})

it('特殊 uid 的世界书条目导出再导入不丢失', () => {
  const entries = parseLorebook(JSON.parse('{"entries":{"__proto__":{"key":["北门"],"content":"关闭"}}}'), scope)
  const exported = JSON.parse(JSON.stringify(exportLorebook(entries, 'audit')))
  expect(parseLorebook(exported, scope)).toEqual(entries)
})

it.each(['café', 'éclair', 'Москва'])('整词匹配支持非 ASCII 词 %s 且不匹配更长词的一部分', word => {
  const entries = parseLorebook({ entries: [{ key: [word], content: '设定', matchWholeWords: true }] }, scope)
  const run = (content: string) => evaluateWorldInfo({ entries, messages: [{ role: 'user', content }],
    settings: DEFAULT_WI_SETTINGS, timerState: EMPTY_TIMER_STATE, contextWindowTokens: 1000,
    reservedTokens: 0, estimateTokens: () => 1, random: () => 0 }).activated
  expect(run(`「${word}」`)).toHaveLength(1)
  expect(run(`x${word}x`)).toHaveLength(0)
})

it('不存在的 outlet 名称与对象原型同名时仍按空内容处理', () => {
  expect(expandMacros('A{{outlet::constructor}}B{{outlet::__proto__}}C', { char: '角色', user: '玩家', outlets: {} })).toBe('ABC')
})

it('宏展开保留正文、身份与 outlet 中的私用区字符，并保持 outlet 不二次展开', () => {
  expect(expandMacros('\uE000 {{char}} {{outlet::card}}', { char: '角色\uE000', user: '玩家',
    outlets: { card: '\uE000 {{user}}' } })).toBe('\uE000 角色\uE000 \uE000 {{user}}')
})

it('outlet 暂存到宏变量后不泄漏内部标记，候选标记与正文重名也保持原文', () => {
  const marker = '\uE000tavernFrozenOpen0\uE001'
  const ctx: MacroContext = { char: '角色', user: '玩家', outlets: { card: `${marker}{{user}}` }, store: new Map() }
  expect(expandMacros('{{setvar::card::{{outlet::card}}}}{{getvar::card}}', ctx)).toBe(`${marker}{{user}}`)
  expect(ctx.store?.get('card')).toBe(`${marker}{{user}}`)
  expect(expandMacros('{{char}}', { ...ctx, char: marker })).toBe(marker)
})
