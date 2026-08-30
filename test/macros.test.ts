/**
 * 宏展开器单测。
 * 覆盖：角色/用户宏（含大小写不敏感）、身份宏（展示/扫描用）、outlet 命中/未命中/不嵌套、{{trim}} 移除、
 * time/date 经 vars 覆盖、未知宏保留原样、{{setvar}}/{{getvar}}/{{//}} 预处理、
 * {{random}}/{{pick}} 本轮掷骰、由内向外展开嵌套宏、postProcess 只加工宏解析值。
 */
import { describe, expect, it, vi } from 'vitest'
import { expandIdentityMacros, expandMacros, hasTurnLocalMacros, hasUnevaluatedScript, createTurnRandom, type MacroContext } from '../src/core/macros.js'

const ctx: MacroContext = { char: 'Alice', user: 'Bob' }

describe('角色/用户宏', () => {
  it('展开 {{char}}/{{user}}/{{charname}}/{{username}}', () => {
    expect(expandMacros('{{char}} vs {{user}}', ctx)).toBe('Alice vs Bob')
    expect(expandMacros('{{charname}} & {{username}}', ctx)).toBe('Alice & Bob')
  })

  it('大小写不敏感：{{Char}}/{{USER}}', () => {
    expect(expandMacros('{{Char}}/{{USER}}/{{CharName}}', ctx)).toBe('Alice/Bob/Alice')
  })

  it('宏名两侧空白被容忍', () => {
    expect(expandMacros('{{ char }}', ctx)).toBe('Alice')
  })
})

describe('expandIdentityMacros', () => {
  it('只展开 {{user}}/{{char}}，不碰 setvar 与时钟', () => {
    expect(expandIdentityMacros('想你了，{{user}} — {{char}}', ctx)).toBe('想你了，Bob — Alice')
    expect(expandIdentityMacros('{{setvar::x::1}}{{time}}', ctx)).toBe('{{setvar::x::1}}{{time}}')
  })
})

describe('outlet', () => {
  it('命中的 outlet 展开为内容', () => {
    const c: MacroContext = { ...ctx, outlets: { Stats: 'HP 10' } }
    expect(expandMacros('面板:{{outlet::Stats}}', c)).toBe('面板:HP 10')
  })

  it('未命中的 outlet 替换为空串', () => {
    const c: MacroContext = { ...ctx, outlets: { Stats: 'HP 10' } }
    expect(expandMacros('a{{outlet::Missing}}b', c)).toBe('ab')
  })

  it('未提供 outlets 时替换为空串', () => {
    expect(expandMacros('a{{outlet::Stats}}b', ctx)).toBe('ab')
  })

  it('outlet 不嵌套展开（内容中的宏保持原样）', () => {
    const c: MacroContext = { ...ctx, outlets: { A: '{{char}}' } }
    expect(expandMacros('{{outlet::A}}', c)).toBe('{{char}}')
  })
})

describe('trim 与时间宏', () => {
  it('{{trim}} 被静默移除', () => {
    expect(expandMacros('a {{trim}} b', ctx)).toBe('a  b')
  })

  it('{{time}}/{{date}} 默认取当前时间，可经 vars 覆盖为固定值', () => {
    const c: MacroContext = { ...ctx, vars: { time: '10:20', date: '2024-01-02' } }
    expect(expandMacros('{{time}} {{date}}', c)).toBe('10:20 2024-01-02')
  })

  it('vars 未覆盖时回落到 now 参数推导的默认值', () => {
    const now = new Date(2024, 0, 2, 3, 4) // 2024-01-02 03:04
    expect(expandMacros('{{time}}|{{date}}|{{weekday}}', ctx, now)).toBe('03:04|2024-01-02|Tuesday')
  })
})

describe('未知宏', () => {
  it('保留原样并触发 onUnknown（回调收到去空白的宏名）', () => {
    const onUnknown = vi.fn()
    const c: MacroContext = { ...ctx, onUnknown }
    expect(expandMacros('x{{foo}}y', c)).toBe('x{{foo}}y')
    expect(onUnknown).toHaveBeenCalledTimes(1)
    expect(onUnknown).toHaveBeenCalledWith('foo')
  })

  it('回调次数按文本中出现次数计：同一宏出现两次报两次（去重是调用方职责）', () => {
    const onUnknown = vi.fn()
    const c: MacroContext = { ...ctx, onUnknown }
    expandMacros('{{foo}} {{foo}} {{bar}}', c)
    expect(onUnknown).toHaveBeenCalledTimes(3)
    expect(onUnknown.mock.calls.map((c) => c[0])).toEqual(['foo', 'foo', 'bar'])
  })

  it('未提供 onUnknown 时静默保留原文', () => {
    expect(expandMacros('{{unknown}}', ctx)).toBe('{{unknown}}')
  })

  it('Object 原型字段不是时钟宏，保留原文并报告 unknown', () => {
    const onUnknown = vi.fn()
    const c: MacroContext = { ...ctx, onUnknown }
    expect(expandMacros('{{constructor}}|{{__proto__}}', c)).toBe('{{constructor}}|{{__proto__}}')
    expect(onUnknown.mock.calls.map((call) => call[0])).toEqual(['constructor', '__proto__'])
  })
})

describe('卡字段与人设宏', () => {
  const rich: MacroContext = {
    ...ctx,
    description: 'DESC {{user}}',
    personality: 'PERS',
    scenario: 'SCEN',
    persona: 'PERSONA-DESC',
    firstMessage: 'FIRST {{char}}',
    lastCharMessage: 'LAST-CHAR',
  }

  it('{{description}}/{{personality}}/{{scenario}} 取卡字段，内嵌宏随多轮展开', () => {
    expect(expandMacros('{{description}}|{{personality}}|{{scenario}}', rich)).toBe('DESC Bob|PERS|SCEN')
  })

  it('{{persona}} 取当前用户人设描述；{{charFirstMessage}} 取开场白', () => {
    expect(expandMacros('{{persona}}', rich)).toBe('PERSONA-DESC')
    expect(expandMacros('{{charFirstMessage}}', rich)).toBe('FIRST Alice')
    // 兼容社区写法 {{firstMessage}}（ST 拼写为 charFirstMessage）
    expect(expandMacros('{{firstMessage}}', rich)).toBe('FIRST Alice')
  })

  it('字段缺省为空串，不当成未知宏', () => {
    const onUnknown = vi.fn()
    const c: MacroContext = { ...ctx, onUnknown }
    expect(expandMacros('{{description}}{{persona}}{{firstMessage}}', c)).toBe('')
    expect(onUnknown).not.toHaveBeenCalled()
  })

  it('大小写不敏感：{{Description}}/{{LastCharMessage}}', () => {
    expect(expandMacros('{{Description}}/{{LastCharMessage}}', rich)).toBe('DESC Bob/LAST-CHAR')
  })
})

describe('lastCharMessage', () => {
  it('{{lastCharMessage}} 取 ctx.lastCharMessage', () => {
    const c: MacroContext = { ...ctx, lastCharMessage: '上一条回复' }
    expect(expandMacros('<前情>{{lastCharMessage}}</前情>', c)).toBe('<前情>上一条回复</前情>')
  })

  it('hasTurnLocalMacros 识别 lastCharMessage，不把卡字段宏当本轮宏', () => {
    expect(hasTurnLocalMacros('{{lastCharMessage}}')).toBe(true)
    expect(hasTurnLocalMacros('{{last_char_message}}')).toBe(true)
    expect(hasTurnLocalMacros('{{description}} {{persona}} {{charFirstMessage}}')).toBe(false)
  })
})

describe('setvar / getvar / 注释', () => {
  it('同一次调用内 set 后 get', () => {
    const c: MacroContext = { ...ctx, store: new Map() }
    expect(expandMacros('{{setvar::wordsCloud::不少于1500}}正文{{getvar::wordsCloud}}字', c)).toBe('正文不少于1500字')
  })

  it('跨多次 expandMacros 共享 store（模拟预设多条目按序组装）', () => {
    const c: MacroContext = { ...ctx, store: new Map() }
    expect(expandMacros('{{setvar::wordsCloud::不少于1500}}{{//作者注释}}{{trim}}', c)).toBe('')
    expect(expandMacros('剧情{{getvar::wordsCloud}}字', c)).toBe('剧情不少于1500字')
  })

  it('后写的 setvar 覆盖先写的', () => {
    const c: MacroContext = { ...ctx, store: new Map() }
    expandMacros('{{setvar::cotBegin::嗯，}}', c)
    expandMacros('{{setvar::cotBegin::我们需要拆解任务链。}}', c)
    expect(expandMacros('{{getvar::cotBegin}}', c)).toBe('我们需要拆解任务链。')
  })

  it('未赋值的 getvar 为空串，不当成未知宏', () => {
    const onUnknown = vi.fn()
    const c: MacroContext = { ...ctx, store: new Map(), onUnknown }
    expect(expandMacros('x{{getvar::missing}}y', c)).toBe('xy')
    expect(onUnknown).not.toHaveBeenCalled()
  })

  it('宏名与 :: 之间允许空格：{{setvar ::x::v}} / {{getvar ::x}} 不漏进 prompt', () => {
    const onUnknown = vi.fn()
    const c: MacroContext = { ...ctx, store: new Map(), onUnknown }
    expect(expandMacros('{{setvar ::topic::雨}}读{{getvar ::topic}}', c)).toBe('读雨')
    expect(onUnknown).not.toHaveBeenCalled()
  })

  it('由内向外展开：setvar 值里的 {{char}}', () => {
    const c: MacroContext = { ...ctx, store: new Map() }
    expect(expandMacros('{{setvar::who::{{char}}}}{{getvar::who}}', c)).toBe('Alice')
  })

  it('{{lastusermessage}} 取 ctx.lastUserMessage', () => {
    const c: MacroContext = { ...ctx, lastUserMessage: '你好' }
    expect(expandMacros('<最新互动>\n{{lastusermessage}}\n</最新互动>', c)).toBe('<最新互动>\n你好\n</最新互动>')
  })
})

describe('postProcess', () => {
  it('只加工宏解析出来的值，模板原文不动', () => {
    expect(expandMacros('X {{char}}-{{user}} Y', ctx, undefined, (v) => `<${v}>`)).toBe('X <Alice>-<Bob> Y')
  })

  it('未知宏与未提供 postProcess 时行为不变', () => {
    expect(expandMacros('{{foo}}', ctx, undefined, (v) => `<${v}>`)).toBe('{{foo}}')
    expect(expandMacros('{{char}}', ctx)).toBe('Alice')
  })

  it('正则转义用法：getvar 值里的元字符逐值转义（对齐 substituteRegex=2）', () => {
    const c: MacroContext = { ...ctx, store: new Map([['topic', 'C++ (advanced)']]) }
    const escape = (v: string) => v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const source = expandMacros('^{{getvar::topic}}$', c, undefined, escape)
    expect(source).toBe('^C\\+\\+ \\(advanced\\)$')
    expect(new RegExp(source).test('C++ (advanced)')).toBe(true)
  })
})

describe('hasUnevaluatedScript', () => {
  it('识别 EJS 开标签，不误伤普通百分号', () => {
    expect(hasUnevaluatedScript('<%_ const s = getvar("stat_data") _%>')).toBe(true)
    expect(hasUnevaluatedScript('成功率 80%')).toBe(false)
  })
})

describe('random / pick', () => {
  it('{{random::A::B}} 与 {{pick::X,Y}} 用传入 random 选一项', () => {
    let i = 0
    const seq = [0, 0.99]
    const c: MacroContext = { ...ctx, random: () => seq[i++]! }
    expect(expandMacros('{{random::A::B}}', c)).toBe('A')
    expect(expandMacros('{{pick::X,Y}}', c)).toBe('Y')
  })

  it('{{random:1,10}} 数值闭区间；{{pick:1,3}} 只在两项里抽，不当成 1..3', () => {
    expect(expandMacros('{{random:1,10}}', { ...ctx, random: () => 0 })).toBe('1')
    expect(expandMacros('{{random:1,10}}', { ...ctx, random: () => 0.99 })).toBe('10')
    expect(expandMacros('{{pick:1,3}}', { ...ctx, random: () => 0.5 })).toBe('3')
  })

  it('同一种子两份流各自从同样起点掷', () => {
    const left = expandMacros('{{pick::X,Y,Z}} {{pick::X,Y,Z}}', { ...ctx, random: createTurnRandom(42) })
    const right = expandMacros('{{pick::X,Y,Z}} {{pick::X,Y,Z}}', { ...ctx, random: createTurnRandom(42) })
    expect(left).toBe(right)
    expect(left).toMatch(/^(X|Y|Z) (X|Y|Z)$/)
  })

  it('hasTurnLocalMacros 识别 random/pick，不把 {{char}} 当本轮宏', () => {
    expect(hasTurnLocalMacros('{{random::A::B}}')).toBe(true)
    expect(hasTurnLocalMacros('{{pick::A,B}}')).toBe(true)
    expect(hasTurnLocalMacros('{{char}} 在场')).toBe(false)
  })
})
