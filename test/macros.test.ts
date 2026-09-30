/**
 * 宏展开器单测。
 * 覆盖：角色/用户宏（含大小写不敏感）、身份宏（展示/扫描用）、outlet 命中/未命中/不嵌套、{{trim}} 移除、
 * time/date 经 vars 覆盖、未知宏保留原样、{{setvar}}/{{getvar}}/{{//}} 预处理、
 * {{random}} 本轮掷骰、{{pick}} 按聊天身份稳定、ST 旧式 <USER>/<BOT>/<CHAR> 宏、由内向外展开嵌套宏、postProcess 只加工宏解析值。
 */
import { describe, expect, it, vi } from 'vitest'
import { expandIdentityMacros, expandMacros, hasTurnLocalMacros, hasUnevaluatedScript, createTurnRandom, type MacroContext } from '../src/core/macros.js'
import { createMacroDependencyTracker } from '../src/core/macroDependencies.js'

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

  it('ST 旧式 <USER>/<BOT>/<CHAR>/<CHARIFNOTGROUP>/<GROUP> 大小写不敏感地展开，闭合标签不受影响', () => {
    expect(expandMacros('<USER>对<bot>说：<Char>、<CHARIFNOTGROUP>、<group>', ctx)).toBe('Bob对Alice说：Alice、Alice、Alice')
    expect(expandMacros('<user>和</user><users>', ctx)).toBe('Bob和</user><users>')
    // 与花括号宏混用、值同样经过 postProcess
    expect(expandMacros('<USER>{{char}}', ctx, undefined, (value) => `[${value}]`)).toBe('[Bob][Alice]')
  })
})

describe('expandIdentityMacros', () => {
  it('只展开 {{user}}/{{char}}，不碰 setvar 与时钟', () => {
    expect(expandIdentityMacros('想你了，{{user}} — {{char}}', ctx)).toBe('想你了，Bob — Alice')
    expect(expandIdentityMacros('{{setvar::x::1}}{{time}}', ctx)).toBe('{{setvar::x::1}}{{time}}')
  })

  it('旧式 <USER>/<BOT> 也是身份宏：老卡开场白与世界书键按人设名匹配', () => {
    expect(expandIdentityMacros('<BOT>向<USER>招手，{{user}}', ctx)).toBe('Alice向Bob招手，Bob')
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

  it('charPrompt / charInstruction 取卡级覆盖，并继续展开字段里的身份宏', () => {
    const c: MacroContext = { ...rich, charPrompt: 'MAIN {{char}}', charInstruction: 'TAIL {{user}}' }
    expect(expandMacros('{{charPrompt}}|{{CHARINSTRUCTION}}', c)).toBe('MAIN Alice|TAIL Bob')
    expect(expandMacros('{{charPrompt}}|{{charInstruction}}', ctx)).toBe('|')
  })
})

describe('lastMessage', () => {
  it('与最后用户消息分开，使用调用方提供的最后真实消息', () => {
    const c: MacroContext = { ...ctx, lastUserMessage: 'user question', lastCharMessage: 'assistant answer', lastMessage: 'assistant answer' }
    expect(expandMacros('{{LastMessage}}|{{lastUserMessage}}|{{lastCharMessage}}', c)).toBe('assistant answer|user question|assistant answer')
    expect(expandMacros('{{lastMessage}}', { ...c, lastMessage: 'new user question' })).toBe('new user question')
  })

  it('缺少最后消息时为空，不把最后用户消息误当成当前位置', () => {
    expect(expandMacros('{{lastMessage}}', { ...ctx, lastUserMessage: 'older user question' })).toBe('')
    expect(hasTurnLocalMacros('{{LastMessage}}')).toBe(true)
    expect(hasTurnLocalMacros('{{charPrompt}}/{{charInstruction}}')).toBe(false)
  })
})

describe('卡级覆盖宏的通道依赖', () => {
  it('纯静态字段仍稳定，字段内 lastMessage 与间接字段引用属于本轮', () => {
    const stable: MacroContext = { ...ctx, charPrompt: 'Write about {{char}}', charInstruction: 'Use a calm tone' }
    expect(createMacroDependencyTracker(stable).isDynamic('{{charPrompt}}|{{charInstruction}}', stable)).toBe(false)
    const dynamic: MacroContext = { ...stable, charPrompt: 'Respond to {{lastMessage}}', charInstruction: '{{charPrompt}}' }
    expect(createMacroDependencyTracker(dynamic).isDynamic('{{charInstruction}}', dynamic)).toBe(true)
  })

  it('两个字段中的变量写入及潜在来源传递到后续 getvar', () => {
    const c: MacroContext = { ...ctx, charPrompt: '{{setvar::topic::{{lastMessage}}}}', charInstruction: '{{charPrompt}}' }
    const tracker = createMacroDependencyTracker(c, [{ text: '{{charInstruction}}', turnLocal: false }])
    expect(tracker.isDynamic('RULE={{getvar::topic}}', c)).toBe(true)
    tracker.record('{{setvar::copy::{{getvar::topic}}}}', c, false)
    expect(tracker.isDynamic('COPY={{getvar::copy}}', c)).toBe(true)
    expect(tracker.isDynamic('STYLE={{getvar::style}}', c)).toBe(false)
  })

  it('卡字段循环依赖只检查一次，含 lastMessage 时仍能找出动态依赖', () => {
    const c: MacroContext = { ...ctx, charPrompt: '{{charInstruction}}', charInstruction: '{{charPrompt}} {{lastMessage}}' }
    expect(createMacroDependencyTracker(c).isDynamic('{{charPrompt}}', c)).toBe(true)
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
  it('stat_data 只读快照读取属于本轮宏，普通变量名仍可用于稳定规则', () => {
    for (const text of ['{{getvar::stat_data}}', '{{ getlocalvar :: stat_data.hp }}', '{{getglobalvar::stat_data["hp"]}}']) {
      expect(hasTurnLocalMacros(text)).toBe(true)
    }
    expect(hasTurnLocalMacros('{{getvar::stat_database}}')).toBe(false)
    expect(hasTurnLocalMacros('{{getvar::writingStyle}}')).toBe(false)
  })

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

  it('hasTurnLocalMacros 识别 random；pick 按聊天确定，不算本轮宏；{{char}} 也不是', () => {
    expect(hasTurnLocalMacros('{{random::A::B}}')).toBe(true)
    expect(hasTurnLocalMacros('{{pick::A,B}}')).toBe(false)
    expect(hasTurnLocalMacros('{{char}} 在场')).toBe(false)
  })

  it('有聊天身份时 {{pick}} 跨轮、跨调用稳定，不消费本轮 random', () => {
    const options = Array.from({ length: 20 }, (_, i) => `o${i}`).join('::')
    const text = `发色：{{pick::${options}}}`
    const turnRandom = vi.fn(() => 0)
    const first = expandMacros(text, { ...ctx, pickSeed: 'chat-a', random: turnRandom })
    // 另一轮换了本轮随机流，结果仍相同
    expect(expandMacros(text, { ...ctx, pickSeed: 'chat-a', random: () => 0.99 })).toBe(first)
    expect(turnRandom).not.toHaveBeenCalled()
    // 20 个选项、多个聊天身份不可能全部抽到同一项：结果确实随聊天变化
    const chats = ['chat-a', 'chat-b', 'chat-c', 'chat-d', 'chat-e', 'chat-f']
    expect(new Set(chats.map(seed => expandMacros(text, { ...ctx, pickSeed: seed }))).size).toBeGreaterThan(1)
  })

  it('同一段原文中重复的同组 pick 各自取值，但每次展开都按出现次序得到同一结果', () => {
    const options = Array.from({ length: 20 }, (_, i) => `o${i}`).join(',')
    const text = Array.from({ length: 6 }, () => `{{pick:${options}}}`).join(' ')
    const once = expandMacros(text, { ...ctx, pickSeed: 'chat-a' })
    expect(expandMacros(text, { ...ctx, pickSeed: 'chat-a' })).toBe(once)
    expect(new Set(once.split(' ')).size).toBeGreaterThan(1)
    // 前面的本轮宏长度变化不移动 pick 结果（不按字符偏移取种子）
    const withTurnMacro = (last: string) => expandMacros(`{{lastUserMessage}}|${text}`, { ...ctx, pickSeed: 'chat-a', lastUserMessage: last }).split('|')[1]
    expect(withTurnMacro('短')).toBe(withTurnMacro('一句长得多的本轮台词'))
  })
})

describe('ST 常用宏补全', () => {
  const at = new Date(2026, 0, 2, 3, 4)
  it('roll 骰子按确定性随机流取值，支持 NdM±K / dM / M，非法表达式为空串', () => {
    expect(expandMacros('{{roll:1d20}}', { ...ctx, random: () => 0 })).toBe('1')
    expect(expandMacros('{{roll:d20}}', { ...ctx, random: () => 0.999 })).toBe('20')
    expect(expandMacros('{{roll:2d6+3}}', { ...ctx, random: () => 0.5 })).toBe('11')
    expect(expandMacros('{{roll:20}}', { ...ctx, random: () => 0 })).toBe('1')
    expect(expandMacros('[{{roll:abc}}][{{roll:1000d6}}]', { ...ctx, random: () => 0 })).toBe('[][]')
  })

  it('roll 也接受 ST 的空格写法，且同样是本轮宏；{{rollback}} 之类不是骰子', () => {
    expect(expandMacros('{{roll 1d6}}|{{roll d20+1}}', { ...ctx, random: () => 0 })).toBe('1|2')
    expect(hasTurnLocalMacros('{{roll 1d6}}')).toBe(true)
    expect(hasTurnLocalMacros('{{rollback}}')).toBe(false)
  })

  it('isodate / isotime 使用组装时钟，standing 冻结时可被 vars 覆盖', () => {
    expect(expandMacros('{{isodate}} {{isotime}}', ctx, at)).toBe('2026-01-02 03:04')
    expect(expandMacros('{{isodate}}', { ...ctx, vars: { isodate: '' } }, at)).toBe('')
  })

  it('incvar / decvar / hasvar 读写同一变量表；hasvar 在同串 setvar 之后求值', () => {
    // 对齐 ST：incvar/decvar 输出新值，卡片常写「第{{incvar::day}}天」。
    expect(expandMacros('{{incvar::n}},{{incvar::n}},{{decvar::n}}|{{getvar::n}}', { ...ctx })).toBe('1,2,1|1')
    expect(expandMacros('第{{incvar::day}}天', { ...ctx, store: new Map([['day', '3']]) })).toBe('第4天')
    expect(expandMacros('{{hasvar::x}}|{{setvar::x::1}}{{hasvar::x}}', { ...ctx })).toBe('true|true')
    expect(expandMacros('{{hasvar::y}}', { ...ctx })).toBe('false')
  })

  it('add/inc/dec/has 的 global 拼写与 setglobalvar 共用同一变量表', () => {
    const store = new Map<string, string>()
    expect(expandMacros('{{setglobalvar::g::5}}{{addglobalvar::g::2}}{{incglobalvar::g}}|{{decglobalvar::g}}|{{hasglobalvar::g}}',
      { ...ctx, store })).toBe('8|7|true')
    expect(store.get('g')).toBe('7')
    const tracker = createMacroDependencyTracker(ctx, [{ text: '{{incglobalvar::hp}}', turnLocal: true }])
    expect(tracker.isDynamic('{{getglobalvar::hp}}', ctx)).toBe(true)
  })

  it('hasvar 读取 MVU stat_data 只读快照，并且是本轮宏；写入仍被拒绝', () => {
    const mvu = { ...ctx, readonlyStatData: { hp: 0, bag: { key: 'x' } } }
    expect(expandMacros('{{hasvar::stat_data.hp}}|{{hasvar::stat_data.bag.key}}|{{hasvar::stat_data.mp}}', mvu)).toBe('true|true|false')
    expect(hasTurnLocalMacros('{{hasvar::stat_data.hp}}')).toBe(true)
    expect(() => expandMacros('{{incglobalvar::stat_data.hp}}', mvu)).toThrow(/只读/)
  })

  it('简单别名：space / reverse / banned / charJailbreak / group / notChar', () => {
    expect(expandMacros('a{{space}}b|{{reverse:abc}}|{{banned "x"}}|{{charJailbreak}}|{{group}}|{{notChar}}',
      { ...ctx, charInstruction: 'PHI' })).toBe('a b|cba||PHI|Alice|Bob')
  })

  it('字段别名内的动态宏与变量写入继续参与依赖传播', () => {
    const context = { ...ctx, charInstruction: '{{setvar::topic::{{lastMessage}}}}', char: '{{isodate}}', user: '{{lastUserMessage}}' }
    const tracker = createMacroDependencyTracker(context, [{ text: '{{charJailbreak}}', turnLocal: false }])
    for (const text of ['{{charJailbreak}}', '{{group}}', '{{groupNotMuted}}', '{{notChar}}', '{{getvar::topic}}']) {
      expect(tracker.isDynamic(text, context), text).toBe(true)
    }
    const stable = { ...ctx, charInstruction: '固定规则' }
    expect(createMacroDependencyTracker(stable).isDynamic('{{charJailbreak}}', stable)).toBe(false)
  })

  it('骰子与 ISO 时钟是本轮宏，不能进 standing；增减变量的写入参与依赖传播', () => {
    expect(hasTurnLocalMacros('{{roll:1d6}}')).toBe(true)
    expect(hasTurnLocalMacros('{{isodate}}')).toBe(true)
    const tracker = createMacroDependencyTracker(ctx, [{ text: '{{incvar::hp}}', turnLocal: true }])
    expect(tracker.isDynamic('{{getvar::hp}}', ctx)).toBe(true)
    expect(tracker.isDynamic('{{hasvar::hp}}', ctx)).toBe(true)
  })
})
