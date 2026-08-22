/**
 * 正则引擎单测。
 * 覆盖：裸 find 语义（区分大小写、只替换首个）、/pattern/flags 字面形式、
 * 替换串 $1/$<name>/{{match}}/宏展开（含宏值里的 $ 保护）、find 中宏的 substituteRegex 0/1/2
 *（转义在展开后逐值进行，覆盖 getvar/persona 等非 char/user 宏）、
 * minDepth/maxDepth 深度过滤、规则编译失败容错、trim 路径的越界 $N 与 '0'/'' 组值、
 * compileCardRegexScripts / compilePresetRegexScripts 归一化（含 md/po 改写 scopes 后 roles 复核）、
 * 消息角色过滤、封面 HTML 与正文拆分
 *（含无 doctype 的 style 片段、卡内 markdownOnly+promptOnly 仍启用展示向）。
 */
import { describe, expect, it } from 'vitest'
import {
  applyRegexRules,
  applyRegexToMessages,
  compileCardRegexScripts,
  compilePresetRegexScripts,
  extractRenderedHtml,
  splitRenderedHtml,
  collectRenderedHtml,
  type MacroContext,
} from '../src/core/regex.js'
import { expandIdentityMacros } from '../src/core/macros.js'
import type { CardRegexScript, ChatMessage, RegexFilter, RegexRule } from '../src/core/types.js'

const FILTER: RegexFilter = { scope: 'prompt', timing: 'assemble' }
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

function run(text: string, rules: RegexRule[], ctx: MacroContext = CTX) {
  return applyRegexRules(text, rules, FILTER, ctx)
}

describe('find 形式', () => {
  it('裸源码：区分大小写、只替换首个匹配', () => {
    const res = run('cat Cat cat', [makeRule({ id: 'r', find: 'cat', replace: 'dog' })])
    expect(res.text).toBe('dog Cat cat')
    expect(res.applied).toEqual(['r'])
  })

  it('/pattern/gi 字面形式：flags 生效（全量 + 忽略大小写）', () => {
    const res = run('cat Cat CAT', [makeRule({ id: 'r', find: '/cat/gi', replace: 'dog' })])
    expect(res.text).toBe('dog dog dog')
  })

  it('规则未命中时不计入 applied', () => {
    const res = run('nothing', [makeRule({ id: 'r', find: 'cat', replace: 'dog' })])
    expect(res.applied).toEqual([])
  })
})

describe('替换串', () => {
  it('$1 捕获组', () => {
    const res = run('foobar', [makeRule({ id: 'r', find: '/(foo)(bar)/', replace: '$2$1' })])
    expect(res.text).toBe('barfoo')
  })

  it('$<name> 命名捕获组', () => {
    const res = run('2024 年', [makeRule({ id: 'r', find: '/(?<year>\\d{4})/', replace: '[$<year>]' })])
    expect(res.text).toBe('[2024] 年')
  })

  it('{{match}} 等价 $0', () => {
    const res = run('a cat b', [makeRule({ id: 'r', find: 'cat', replace: '<{{match}}>' })])
    expect(res.text).toBe('a <cat> b')
  })

  it('replace 中 {{char}}/{{user}} 宏展开', () => {
    const res = run('greet', [makeRule({ id: 'r', find: 'greet', replace: 'hi {{char}} & {{user}}' })])
    expect(res.text).toBe('hi Alice & Bob')
  })

  it('宏值里的 $& / $1 / $$ 是字面文本，不被 String.replace 再解释一次', () => {
    const res = run('NAME', [makeRule({ id: 'r', find: 'NAME', replace: '{{user}}' })], {
      ...CTX,
      user: 'Cash$$Money $& $1',
    })
    expect(res.text).toBe('Cash$$Money $& $1')
  })

  it('宏值里的 $& 与 {{match}} 各归各：{{match}} 仍是整体匹配', () => {
    const res = run('a cat b', [makeRule({ id: 'r', find: 'cat', replace: '<{{match}}|{{user}}>' })], {
      ...CTX,
      user: '$&',
    })
    expect(res.text).toBe('a <cat|$&> b')
  })

  it('先展开身份宏再匹配：开场白里的 {{user}} 才能被人设名命中', () => {
    const named = expandIdentityMacros('{{user}}，你好。', CTX)
    const res = applyRegexRules(
      named,
      [makeRule({ id: 'r', find: 'Bob', replace: 'test', scopes: ['output'], timing: ['render'] })],
      { scope: 'output', timing: 'render' },
      CTX,
    )
    expect(named).toBe('Bob，你好。')
    expect(res.text).toBe('test，你好。')
  })
})

describe('find 中宏展开（substituteRegex）', () => {
  it('0 = 不展开：只匹配字面 {{char}}，不匹配角色名', () => {
    const rule = makeRule({ id: 'r', find: '{{char}}', replace: 'X', substituteRegex: 0 })
    expect(run('Alice left', [rule]).text).toBe('Alice left')
    expect(run('{{char}} left', [rule]).text).toBe('X left')
  })

  it('1 = 原样代入：用户名片中的正则元字符按正则语义生效', () => {
    // char = 'A.B' 原样代入后 `.` 匹配任意字符，故先命中 'AXB'
    const res = run('AXB and A.B', [makeRule({ id: 'r', find: '{{char}}', replace: 'X', substituteRegex: 1 })], {
      ...CTX,
      char: 'A.B',
    })
    expect(res.text).toBe('X and A.B')
  })

  it('2 = 转义代入：正则元字符被转义，只匹配字面量', () => {
    const res = run('AXB and A.B', [makeRule({ id: 'r', find: '{{char}}', replace: 'X', substituteRegex: 2 })], {
      ...CTX,
      char: 'A.B',
    })
    expect(res.text).toBe('AXB and X')
  })

  it('2 = 转义代入对 char/user 以外的宏同样生效（{{getvar}} 带元字符不再编译失败）', () => {
    const ctx: MacroContext = { ...CTX, store: new Map([['topic', 'C++ (advanced)']]) }
    const res = run(
      '课程 C++ (advanced) 结束',
      [makeRule({ id: 'r', find: '{{getvar::topic}}', replace: 'X', substituteRegex: 2 })],
      ctx,
    )
    expect(res.text).toBe('课程 X 结束')
    expect(res.errors).toEqual([])
  })

  it('2 = 转义代入：{{persona}} 里的 .* 不再匹配一切', () => {
    const ctx: MacroContext = { ...CTX, persona: '.*' }
    const res = run('随便什么 .* 文本', [
      makeRule({ id: 'r', find: '{{persona}}', replace: '<X>', substituteRegex: 2 }),
    ], ctx)
    expect(res.text).toBe('随便什么 <X> 文本')
  })

  it('1 = 原样代入时元字符仍按正则语义生效（记录未转义路径的差异）', () => {
    const ctx: MacroContext = { ...CTX, store: new Map([['topic', 'C++ (advanced)']]) }
    const res = run(
      '课程 C++ (advanced) 结束',
      [makeRule({ id: 'r', find: '{{getvar::topic}}', replace: 'X', substituteRegex: 1 })],
      ctx,
    )
    expect(res.text).toBe('课程 C++ (advanced) 结束')
    expect(res.errors).toHaveLength(1)
  })
})

describe('深度过滤（applyRegexToMessages，depth 0 = 数组末尾）', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'cat' }, // depth 2
    { role: 'assistant', content: 'cat' }, // depth 1
    { role: 'user', content: 'cat' }, // depth 0
  ]

  it('maxDepth=0 只作用于最后一条', () => {
    const res = applyRegexToMessages(
      messages,
      [makeRule({ id: 'r', find: 'cat', replace: 'dog', maxDepth: 0 })],
      FILTER,
      CTX,
    )
    expect(res.messages.map((m) => m.content)).toEqual(['cat', 'cat', 'dog'])
  })

  it('minDepth=1 跳过 depth 0 的最新消息', () => {
    const res = applyRegexToMessages(
      messages,
      [makeRule({ id: 'r', find: '/cat/g', replace: 'dog', minDepth: 1 })],
      FILTER,
      CTX,
    )
    expect(res.messages.map((m) => m.content)).toEqual(['dog', 'dog', 'cat'])
  })

  it('null = 不限深度', () => {
    const res = applyRegexToMessages(
      messages,
      [makeRule({ id: 'r', find: '/cat/g', replace: 'dog' })],
      FILTER,
      CTX,
    )
    expect(res.messages.map((m) => m.content)).toEqual(['dog', 'dog', 'dog'])
  })

  it('未命中的消息保持原对象（不复制），命中的返回新对象', () => {
    const res = applyRegexToMessages(
      messages,
      [makeRule({ id: 'r', find: 'cat', replace: 'dog', maxDepth: 0 })],
      FILTER,
      CTX,
    )
    expect(res.messages[0]).toBe(messages[0])
    expect(res.messages[2]).not.toBe(messages[2])
    expect(messages[2]!.content).toBe('cat') // 输入不被改写
  })

  it('runtime context 快照不占 depth，maxDepth=1 仍包真实最新用户句', () => {
    const snapshot: ChatMessage = {
      role: 'user',
      content: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nWIB',
    }
    const withSnap: ChatMessage[] = [
      { role: 'user', content: '旧的' },
      { role: 'assistant', content: '回' },
      { role: 'user', content: '新的' },
      snapshot,
    ]
    const res = applyRegexToMessages(
      withSnap,
      [makeRule({ id: 'r', find: '^([\\s\\S]*)$', replace: '<最新互动>\n$1\n</最新互动>', maxDepth: 1, roles: ['user'] })],
      FILTER,
      CTX,
    )
    expect(res.messages.map((m) => m.content)).toEqual([
      '旧的',
      '回',
      '<最新互动>\n新的\n</最新互动>',
      snapshot.content,
    ])
  })
})

describe('规则容错', () => {
  it('单条规则编译失败不中断后续规则，记入 errors', () => {
    const res = run('cat', [
      makeRule({ id: 'bad', find: '/(unclosed/gi', replace: 'x' }),
      makeRule({ id: 'good', find: 'cat', replace: 'dog' }),
    ])
    expect(res.text).toBe('dog')
    expect(res.applied).toEqual(['good'])
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]!.ruleId).toBe('bad')
  })

  it('disabled / scope / timing 不匹配的规则被跳过', () => {
    const res = run('cat', [
      makeRule({ id: 'off', find: 'cat', replace: 'dog', enabled: false }),
      makeRule({ id: 'scope', find: 'cat', replace: 'dog', scopes: ['input'] }),
      makeRule({ id: 'timing', find: 'cat', replace: 'dog', timing: ['send'] }),
    ])
    expect(res.text).toBe('cat')
    expect(res.applied).toEqual([])
  })
})

describe('trimStrings / trimStringsRegex（ST 语义：从代入的捕获组值里删除）', () => {
  it('trimStrings 从 $1 组值里删字面串；替换结果其余部分不动', () => {
    const res = run('秘密[foo]尾巴[foo]', [
      makeRule({ id: 'r', find: '/秘密\\[(.*?)\\]/', replace: '<$1>', trimStrings: ['foo'] }),
    ])
    // 组值 'foo' 被删空；「尾巴[foo]」不在捕获组里，保留
    expect(res.text).toBe('<>尾巴[foo]')
    expect(res.applied).toEqual(['r'])
  })

  it('trimStrings 作用于 {{match}}（$0 整体匹配）', () => {
    const res = run('ab[noise]cd', [
      makeRule({ id: 'r', find: '/\\[noise\\]/', replace: '<{{match}}>', trimStrings: ['[', ']'] }),
    ])
    // $0 = '[noise]'，trims 删掉方括号后代入
    expect(res.text).toBe('ab<noise>cd')
  })

  it('trimStrings 先宏展开再删（{{char}}）', () => {
    const res = run('Alice 说 AliceAlice 走了', [
      makeRule({ id: 'r', find: '/Alice 说 (.*?) 走了/', replace: '$1', trimStrings: ['{{char}}'] }),
    ])
    expect(res.text).toBe('')
  })

  it('trimStringsRegex 从组值里删正则命中片段，缺省全局', () => {
    const res = run('数据 hp12mp34', [
      makeRule({ id: 'r', find: '/数据 (\\w+)/', replace: '[$1]', trimStringsRegex: ['\\d+'] }),
    ])
    expect(res.text).toBe('[hpmp]')
  })

  it('trimStringsRegex 支持 /pattern/flags 形式', () => {
    const res = run('x AB ab', [
      makeRule({ id: 'r', find: '/x (\\w+ \\w+)/', replace: '$1', trimStringsRegex: ['/ab/i'] }),
    ])
    expect(res.text).toBe(' ')
  })

  it('find 未命中时 trim 不影响文本', () => {
    const res = run('foo bar', [makeRule({ id: 'r', find: 'zzz', replace: '$0', trimStrings: ['foo'] })])
    expect(res.text).toBe('foo bar')
    expect(res.applied).toEqual([])
  })

  it('越界的 $N 原样输出（对齐原生 replace），不泄露 offset 与整段原文', () => {
    const res = run('a [foo] b', [
      makeRule({ id: 'r', find: '/\\[(\\w+)\\]/g', replace: '[$1|$2|$3]', trimStrings: ['zzz'] }),
    ])
    // $2 是 offset、$3 是整段原文；越界 $N 必须留字面量
    expect(res.text).toBe('a [foo|$2|$3] b')
    expect(res.errors).toEqual([])
  })

  it("组值 '0' / 空串不被当成未命中：零值统计不会消失", () => {
    const res = run('HP:0', [makeRule({ id: 'r', find: '/HP:(\\d+)/', replace: 'HP=$1', trimStrings: ['x'] })])
    expect(res.text).toBe('HP=0')
    const empty = run('[]尾', [makeRule({ id: 'e', find: '/\\[(\\w*)\\]/', replace: '<$1>', trimStrings: ['x'] })])
    expect(empty.text).toBe('<>尾')
  })

  it('未参与匹配的可选组仍代入空串', () => {
    const res = run('ab', [makeRule({ id: 'r', find: '/a(x)?b/', replace: '<$1>', trimStrings: ['x'] })])
    expect(res.text).toBe('<>')
  })

  it('非法 trimStringsRegex 记 errors，整条规则失败但不中断后续规则', () => {
    const res = run('cat', [
      makeRule({ id: 'bad-trim', find: 'cat', replace: '[$0]', trimStringsRegex: ['/(unclosed/'] }),
      makeRule({ id: 'good', find: 'cat', replace: 'dog' }),
    ])
    expect(res.errors).toHaveLength(1)
    expect(res.errors[0]!.ruleId).toBe('bad-trim')
    expect(res.text).toBe('dog')
  })

  it('compileRegexScripts 透传 trimStrings / trimStringsRegex 并过滤空串', () => {
    const rules = compilePresetRegexScripts(
      [{ findRegex: 'a', replaceString: 'b', trimStrings: ['x', ''], trimStringsRegex: ['\\d+'] }],
      'p',
    )
    expect(rules[0]!.trimStrings).toEqual(['x'])
    expect(rules[0]!.trimStringsRegex).toEqual(['\\d+'])
    const bare = compilePresetRegexScripts([{ findRegex: 'a', replaceString: 'b' }], 'p')
    expect(bare[0]!.trimStrings).toBeUndefined()
    expect(bare[0]!.trimStringsRegex).toBeUndefined()
  })
})

describe('compileCardRegexScripts', () => {
  const base: CardRegexScript = { findRegex: 'cat', replaceString: 'dog' }

  it('placement [1]/[2]/[5] 分别映射 input/send、output/render、prompt/assemble', () => {
    const rules = compileCardRegexScripts(
      [
        { ...base, scriptName: 'p1', placement: [1] },
        { ...base, scriptName: 'p2', placement: [2] },
        { ...base, scriptName: 'p5', placement: [5] },
      ],
      'card1',
    )
    expect(rules).toHaveLength(3)
    expect(rules[0]!.scopes).toEqual(['input'])
    expect(rules[0]!.timing).toEqual(['send'])
    expect(rules[0]!.roles).toEqual(['user'])
    expect(rules[1]!.scopes).toEqual(['output'])
    expect(rules[1]!.timing).toEqual(['render'])
    expect(rules[1]!.roles).toEqual(['assistant'])
    expect(rules[2]!.scopes).toEqual(['prompt'])
    expect(rules[2]!.timing).toEqual(['assemble'])
    expect(rules[2]!.roles).toBeUndefined()
  })

  it('无对应物的 placement（0/3/4/6）整条忽略', () => {
    expect(compileCardRegexScripts([{ ...base, placement: [0, 3, 4, 6] }], 'c')).toEqual([])
  })

  it('markdownOnly 覆盖为仅 output/render', () => {
    const rules = compileCardRegexScripts([{ ...base, placement: [1, 5], markdownOnly: true }], 'c')
    expect(rules).toHaveLength(1)
    expect(rules[0]!.scopes).toEqual(['output'])
    expect(rules[0]!.timing).toEqual(['render'])
  })

  it('markdownOnly 把 placement:[1] 的 roles 从 user 复核成 assistant，规则不再永不命中', () => {
    const rules = compileCardRegexScripts([{ ...base, placement: [1], markdownOnly: true }], 'c')
    expect(rules[0]!.scopes).toEqual(['output'])
    expect(rules[0]!.roles).toEqual(['assistant'])
    const res = applyRegexToMessages(
      [{ role: 'assistant', content: 'cat' }],
      rules,
      { scope: 'output', timing: 'render' },
      CTX,
    )
    expect(res.messages.map((m) => m.content)).toEqual(['dog'])
    expect(res.applied).toEqual([rules[0]!.id])
  })

  it('promptOnly 覆盖为 prompt 作用域（assemble + send）', () => {
    const rules = compileCardRegexScripts([{ ...base, placement: [2], promptOnly: true }], 'c')
    expect(rules).toHaveLength(1)
    expect(rules[0]!.scopes).toEqual(['prompt'])
    expect(rules[0]!.timing).toEqual(['assemble', 'send'])
  })

  it('缺省 placement [2] 为展示规则，默认启用', () => {
    const rules = compileCardRegexScripts([base], 'c')
    expect(rules).toHaveLength(1)
    expect(rules[0]!.enabled).toBe(true)
    expect(rules[0]!.scopes).toEqual(['output'])
  })

  it('prompt/input 规则默认关闭；卡内 disabled 的展示规则也关闭', () => {
    const prompt = compileCardRegexScripts([{ findRegex: 'a', replaceString: 'b', placement: [5] }], 'c')
    expect(prompt[0]!.enabled).toBe(false)
    const off = compileCardRegexScripts([{ findRegex: 'a', replaceString: 'b', placement: [2], disabled: true }], 'c')
    expect(off[0]!.enabled).toBe(false)
  })

  it('卡内 markdownOnly+promptOnly 仍启用展示向，不把封面正则整条关掉', () => {
    const rules = compileCardRegexScripts(
      [{ findRegex: '<widget>', replaceString: '<style></style><div>ui</div>', placement: [2], markdownOnly: true, promptOnly: true }],
      'c',
    )
    expect(rules).toHaveLength(1)
    expect(rules[0]!.enabled).toBe(true)
    expect(rules[0]!.scopes).toEqual(['output'])
    expect(rules[0]!.timing).toEqual(['render'])
  })

  it('卡内 placement 同时含输入和输出时只启用展示向', () => {
    const rules = compileCardRegexScripts([{ findRegex: 'a', replaceString: 'b', placement: [1, 2] }], 'c')
    expect(rules[0]!.enabled).toBe(true)
    expect(rules[0]!.scopes).toEqual(['output'])
    expect(rules[0]!.timing).toEqual(['render'])
    expect(rules[0]!.roles).toEqual(['assistant'])
  })

  it('substituteRegex 透传：0/2 保留，其余归一为 1', () => {
    const rules = compileCardRegexScripts(
      [
        { ...base, scriptName: 's0', substituteRegex: 0 },
        { ...base, scriptName: 's2', substituteRegex: 2 },
        { ...base, scriptName: 's1', substituteRegex: 1 },
        { ...base, scriptName: 's9', substituteRegex: 9 },
        { ...base, scriptName: 'sd' },
      ],
      'c',
    )
    expect(rules.map((r) => r.substituteRegex)).toEqual([0, 2, 1, 1, 1])
  })

  it('空 findRegex 的脚本被跳过；id/名称/深度按缺省填充', () => {
    const rules = compileCardRegexScripts([{ replaceString: 'x' }, { ...base, minDepth: 1, maxDepth: 3 }], 'c9')
    expect(rules).toHaveLength(1)
    expect(rules[0]!.id).toBe('card:c9:regex:1')
    expect(rules[0]!.minDepth).toBe(1)
    expect(rules[0]!.maxDepth).toBe(3)
    expect(rules[0]!.source).toBe('card')
  })
})

describe('compilePresetRegexScripts', () => {
  const wrap: CardRegexScript = {
    id: 'wrap-1',
    scriptName: '包裹最新指示',
    findRegex: '^([\\s\\S]*)$',
    replaceString: '<最新互动>\n$1\n</最新互动>',
    placement: [1],
    disabled: false,
    markdownOnly: false,
    promptOnly: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: 1,
  }

  it('promptOnly + placement 1：入模、仅 user、跟 disabled 启用', () => {
    const rules = compilePresetRegexScripts([wrap], 'xiajin')
    expect(rules).toHaveLength(1)
    expect(rules[0]!.enabled).toBe(true)
    expect(rules[0]!.source).toBe('preset')
    expect(rules[0]!.id).toBe('wrap-1')
    expect(rules[0]!.scopes).toEqual(['prompt'])
    expect(rules[0]!.timing).toEqual(['assemble', 'send'])
    expect(rules[0]!.roles).toEqual(['user'])
    expect(rules[0]!.maxDepth).toBe(1)
  })

  it('disabled: true 的预设正则保持关闭', () => {
    const rules = compilePresetRegexScripts([{ ...wrap, disabled: true }], 'p')
    expect(rules[0]!.enabled).toBe(false)
  })

  it('markdownOnly 与 promptOnly 同时勾选 → 展示 + 入模', () => {
    const rules = compilePresetRegexScripts(
      [{ findRegex: '突然', replaceString: '', placement: [2], markdownOnly: true, promptOnly: true }],
      'p',
    )
    expect(rules[0]!.enabled).toBe(true)
    expect(rules[0]!.scopes.sort()).toEqual(['output', 'prompt'])
    expect(rules[0]!.timing.sort()).toEqual(['assemble', 'render', 'send'])
    expect(rules[0]!.roles).toEqual(['assistant'])
  })
})

describe('消息角色过滤', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'cat' },
    { role: 'assistant', content: 'cat' },
    { role: 'user', content: 'cat' },
  ]

  it('roles: user 不改 assistant', () => {
    const res = applyRegexToMessages(
      messages,
      [makeRule({ id: 'r', find: 'cat', replace: 'dog', roles: ['user'] })],
      FILTER,
      CTX,
    )
    expect(res.messages.map((m) => m.content)).toEqual(['dog', 'cat', 'dog'])
  })

  it('input 作用域跳过 assistant 消息', () => {
    const res = applyRegexToMessages(
      messages,
      [makeRule({ id: 'r', find: 'cat', replace: 'dog', scopes: ['input'], timing: ['send'] })],
      { scope: 'input', timing: 'send' },
      CTX,
    )
    expect(res.messages.map((m) => m.content)).toEqual(['dog', 'cat', 'dog'])
  })
})

describe('extractRenderedHtml', () => {
  it('抽出 ```text 围栏里的完整 HTML', () => {
    const html = extractRenderedHtml('```text\n<!DOCTYPE html>\n<html><body>封面</body></html>\n```')
    expect(html).toContain('<!DOCTYPE html>')
    expect(html).toContain('封面')
  })

  it('普通开场白返回 null', () => {
    expect(extractRenderedHtml('你好，旅人。')).toBeNull()
  })

  it('无 doctype 的 style+div 小部件也抽进 html', () => {
    const html = extractRenderedHtml('<style>.x{color:red}</style><div class="x">封面</div>')
    expect(html).toContain('<style>')
    expect(html).toContain('封面')
  })

  it('```html 围栏里无 doctype 的片段也抽出', () => {
    const html = extractRenderedHtml('```html\n<style>.a{}</style><div>player</div>\n```\n后面正文')
    expect(html).toContain('<style>')
    expect(html).toContain('player')
  })
})

describe('splitRenderedHtml', () => {
  it('围栏 HTML 后面的正文留在 rest', () => {
    const split = splitRenderedHtml(
      '```html\n<!DOCTYPE html>\n<html><body>player</body></html>\n```\n<!--meta: 0,4-->\n后面还有正文',
    )
    expect(split.html).toContain('<!DOCTYPE html>')
    expect(split.html).toContain('player')
    expect(split.rest).toContain('后面还有正文')
    expect(split.rest).toContain('<!--meta: 0,4-->')
    expect(split.rest).not.toContain('<!DOCTYPE')
  })

  it('无围栏时 </html> 之后的正文留在 rest', () => {
    const split = splitRenderedHtml('<!DOCTYPE html><html><body>ui</body></html>\n正文还在')
    expect(split.html).toContain('<body>ui</body>')
    expect(split.rest).toBe('正文还在')
  })

  it('协议标签在 HTML 小部件之前时进 rest，不挡抽取', () => {
    const split = splitRenderedHtml('<customize_HCI><now_plot><style>.w{}</style><div class="w">world</div>')
    expect(split.html).toContain('<style>')
    expect(split.html).toContain('world')
    expect(split.rest).toContain('customize_HCI')
  })

  it('小部件后面的正文拆进 rest', () => {
    const split = splitRenderedHtml('<style>.x{}</style><div class="x">ui</div>\n可见正文')
    expect(split.html).toContain('<style>')
    expect(split.html).not.toContain('可见正文')
    expect(split.rest).toBe('可见正文')
  })

  it('整页封面没有 rest', () => {
    const split = splitRenderedHtml('<!DOCTYPE html><html><body>封面</body></html>')
    expect(split.html).toContain('封面')
    expect(split.rest).toBe('')
  })

  it('标记被正则换成 HTML 后正文仍可拆出', () => {
    const rendered = applyRegexRules(
      '<widget>\n<!--meta: 0,4-->\n后面还有正文',
      [
        makeRule({
          id: 'player',
          find: '<widget>',
          replace: '```html\n<!DOCTYPE html>\n<html><body>WIDGET</body></html>\n```\n',
          scopes: ['output'],
          timing: ['render'],
        }),
      ],
      { scope: 'output', timing: 'render' },
      CTX,
    )
    const split = splitRenderedHtml(rendered.text)
    expect(split.html).toContain('WIDGET')
    expect(split.rest).toContain('后面还有正文')
    expect(split.rest).not.toContain('WIDGET')
  })

  it('连续两段围栏 HTML 都能抽出，正文不进第一段', () => {
    const split = collectRenderedHtml(
      '```html\n<!DOCTYPE html>\n<html><body>cover</body></html>\n```\n```html\n<!DOCTYPE html>\n<html><body>player</body></html>\n```\n正文',
    )
    expect(split.htmls).toHaveLength(2)
    expect(split.htmls[0]).toContain('cover')
    expect(split.htmls[1]).toContain('player')
    expect(split.rest).toBe('正文')
  })
})
