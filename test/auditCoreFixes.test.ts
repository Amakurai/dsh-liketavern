/**
 * Core 层缺陷修复回归测试：
 * 覆盖 <summary> 原型属性实体、世界书原型键 outlet、关闭交互卡 128 片段边界、
 * 展示净化 Markdown 代码示例免截断与 HTML 内机读块仍收起、只读 MVU 宏路径引号/点号解析与写防护、
 * MVU 命令数字键普通对象日志与 /- 追加日志、转义反引号续写与命令解析、脚本库失败后状态收敛，
 * 以及世界书格式模板在非序列模板路径中的 EJS 执行。
 */
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { assemblePrompt, defaultPreset, type AssembleInput } from '../src/core/assemble.js'
import { installCardScriptLibraries } from '../src/core/cardScriptLibraries.js'
import { continuedMarkdown } from '../src/core/continuationMarkdown.js'
import {
  presentRenderedOutput,
  presentStreamingOutput,
  stripDisplayOpaqueMeta,
} from '../src/core/displaySanitize.js'
import { createHelperMvuCommandCodec } from '../src/core/helperMvuCommands.js'
import { helperJson } from '../src/core/helperRuntime.js'
import { expandMacros } from '../src/core/macros.js'
import { markdownCodeScanner } from '../src/core/markdownCode.js'
import { parsePlainDetailsBlocks } from '../src/core/plainDetails.js'
import {
  disableInteractiveParts,
  sanitizeTemplateDisplayParts,
  splitTemplateDisplay,
} from '../src/core/templateDisplay.js'
import {
  EMPTY_TIMER_STATE,
  WIPosition,
  WIRole,
  WISelectiveLogic,
  type CharacterCard,
  type WorldInfoEntry,
} from '../src/core/types.js'
import { evaluateWorldInfo } from '../src/core/worldbook.js'
import { presentTemplateDisplayResult } from '../src/node/templateDisplay.js'

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
    tags: [],
    regexScripts: [],
    ...overrides,
  }
}

function makeWiEntry(overrides: Partial<WorldInfoEntry> = {}): WorldInfoEntry {
  return {
    key: 'book:1',
    uid: '1',
    source: 'global',
    sourceRef: 'book',
    comment: 'entry',
    content: 'LORE',
    keys: ['trigger'],
    secondaryKeys: [],
    selective: false,
    selectiveLogic: WISelectiveLogic.AndAny,
    constant: true,
    enabled: true,
    order: 100,
    position: WIPosition.BeforeCharDefs,
    depth: 4,
    role: WIRole.System,
    outletName: '',
    caseSensitive: null,
    matchWholeWords: null,
    probability: 100,
    useProbability: false,
    sticky: 0,
    cooldown: 0,
    delay: 0,
    group: '',
    groupOverride: false,
    groupWeight: 100,
    useGroupScoring: null,
    excludeRecursion: false,
    preventRecursion: false,
    delayUntilRecursion: 0,
    ignoreBudget: false,
    scanDepth: null,
    ...overrides,
  }
}

describe('Core 层缺陷修复回归', () => {
  it('A1: <summary> 命名实体查表只接受自有键，不解析 Object.prototype 属性', () => {
    const blocks = parsePlainDetailsBlocks(
      '<details><summary>&constructor; &CONSTRUCTOR; &toString; &__proto__; &amp; &lt;ok&gt;</summary>\n正文\n</details>',
    )
    expect(blocks).toHaveLength(1)
    expect(blocks![0]!.summary).toBe('&constructor; &CONSTRUCTOR; &toString; &__proto__; & <ok>')
  })

  it('A2: 世界书 outletName 为原型属性名（toString/constructor/__proto__）时不崩溃且能正确展开', () => {
    const entries = [
      makeWiEntry({ key: 'b:1', uid: '1', position: WIPosition.Outlet, outletName: 'toString', content: 'VAL_TO_STRING' }),
      makeWiEntry({ key: 'b:2', uid: '2', position: WIPosition.Outlet, outletName: 'constructor', content: 'VAL_CTOR' }),
      makeWiEntry({ key: 'b:3', uid: '3', position: WIPosition.Outlet, outletName: '__proto__', content: 'VAL_PROTO' }),
    ]
    const wi = evaluateWorldInfo({
      entries,
      messages: [{ role: 'user', content: 'hi' }],
      settings: {
        scanDepth: 4,
        maxScanDepth: 0,
        tokenBudget: 2048,
        contextPercent: 25,
        recursive: false,
        maxRecursionSteps: 0,
        minActivations: 0,
        caseSensitive: false,
        matchWholeWords: false,
        useGroupScoring: false,
        characterStrategy: 'before',
        overflowWarning: false,
      },
      contextWindowTokens: 8192,
      reservedTokens: 0,
      timerState: EMPTY_TIMER_STATE,
      estimateTokens: (text) => text.length,
      random: () => 0,
    })
    expect(Object.hasOwn(wi.outlets, 'toString')).toBe(true)
    expect(Object.hasOwn(wi.outlets, 'constructor')).toBe(true)
    expect(Object.hasOwn(wi.outlets, '__proto__')).toBe(true)

    const input: AssembleInput = {
      card: makeCard({
        description: '{{outlet::toString}} | {{outlet::constructor}} | {{outlet::__proto__}}',
      }),
      preset: defaultPreset(),
      personaDescription: '',
      macroCtx: { char: 'Alice', user: 'Bob' },
      history: [{ role: 'user', content: 'hello' }],
      regexRules: [],
      memories: [],
      worldDeltas: [],
      budget: { maxTokens: 8192, reserveTokens: 512 },
      estimateTokens: (text) => text.length,
      wi,
    }
    const assembled = assemblePrompt(input)
    const joined = assembled.messages.map((m) => m.content).join('\n')
    expect(joined).toContain('VAL_TO_STRING | VAL_CTOR | VAL_PROTO')
  })

  it('A3: 关闭交互卡时恰好 128 段 HTML 片段正常回退源码，第 129 段才报片段过多', () => {
    const exact128 = Array.from({ length: 128 }, (_, i) => `<div>卡片 ${i}</div>\n台词 ${i}`).join('\n')
    const ok = presentRenderedOutput(exact128, false)
    expect(ok.htmls).toEqual([])
    expect(ok.text).toContain('卡片 0')
    expect(ok.text).toContain('卡片 127')

    const over129 = Array.from({ length: 129 }, (_, i) => `<div>卡片 ${i}</div>\n台词 ${i}`).join('\n')
    expect(() => presentRenderedOutput(over129, false)).toThrow('交互卡展示片段过多')
  })

  it('A4: 展示净化保护 Markdown 代码示例中的机读标签，同时仍清理 HTML 卡片和 HTML 围栏内的机读块', () => {
    const inlineExample = 'Use `<think>` to start.\nRest stays visible!'
    expect(presentRenderedOutput(inlineExample, true).text).toBe(inlineExample)
    expect(presentRenderedOutput(inlineExample, false).text).toBe(inlineExample)
    expect(presentStreamingOutput(inlineExample, true)).toEqual({ text: inlineExample, pendingHtml: false })
    expect(splitTemplateDisplay(inlineExample)).toEqual([{ kind: 'markdown', text: inlineExample }])

    const fencedExample = '```markdown\n<UpdateVariable>example</UpdateVariable>\n```\nVisible tail'
    expect(presentRenderedOutput(fencedExample, true).text).toBe(fencedExample)
    expect(presentRenderedOutput(fencedExample, false).text).toBe(fencedExample)

    const parts = sanitizeTemplateDisplayParts([
      { kind: 'markdown', text: 'Tip: `<think>` is a tag.' },
      { kind: 'html', text: '<div>`literal <think>SECRET</think>`</div>' },
      { kind: 'markdown', text: 'After card.' },
    ])
    expect(parts[0]).toEqual({ kind: 'markdown', text: 'Tip: `<think>` is a tag.' })
    expect(parts[1]!.text).not.toContain('SECRET')
    expect(parts[2]).toEqual({ kind: 'markdown', text: 'After card.' })

    const disabledParts = disableInteractiveParts(parts)
    expect(disabledParts[0]!.text).toBe('Tip: `<think>` is a tag.')
    expect(disabledParts.map((p) => p.text).join('\n')).not.toContain('SECRET')

    const renderedParts = presentTemplateDisplayResult(
      [{ kind: 'markdown', text: 'Doc `<UpdateVariable>demo</UpdateVariable>`\nMore text' }],
      [],
      { char: 'Alice', user: 'Bob', outlets: {} },
    )
    expect(renderedParts.parts).toEqual([{ kind: 'markdown', text: 'Doc `<UpdateVariable>demo</UpdateVariable>`\nMore text' }])

    // 可执行 HTML 围栏内的机读块（即使放在反引号之间）必须仍然被剥除，不能泄漏。
    const htmlFenceSecret = '```html\n<div>`literal <think>LEAK</think>`</div>\n```\nSafe `<think>` doc'
    const shown = presentRenderedOutput(htmlFenceSecret, true)
    expect(JSON.stringify(shown)).not.toContain('LEAK')
    expect(shown.text).toBe('Safe `<think>` doc')
    expect(stripDisplayOpaqueMeta('<div>`<think>LEAK</think>`</div>')).not.toContain('LEAK')
  })

  it('A5: 只读 MVU stat_data 宏路径正确处理含点号/引号/双冒号的键并禁止通过畸形路径绕过只读守卫', () => {
    const ctx = {
      char: 'Alice',
      user: 'Bob',
      readonlyStatData: {
        'v1.0': 42,
        "Alice's HP": 95,
        'He said "hi"': { val: 'ok' },
        'a::b': 'colon-val',
      },
    }
    expect(expandMacros('{{getvar::stat_data["v1.0"]}}', ctx)).toBe('42')
    expect(expandMacros('{{getvar::stat_data["Alice\'s HP"]}}', ctx)).toBe('95')
    expect(expandMacros('{{hasvar::stat_data["Alice\'s HP"]}}', ctx)).toBe('true')
    expect(expandMacros("{{getvar::stat_data['He said \"hi\"'].val}}", ctx)).toBe('ok')
    expect(expandMacros('{{getvar::stat_data["a::b"]}}', ctx)).toBe('colon-val')

    expect(() => expandMacros('{{setvar::stat_data["Alice\'s HP"]::999}}', ctx)).toThrow('MVU stat_data 是只读快照')
    expect(() => expandMacros('{{addvar::stat_data["v1.0"]::1}}', ctx)).toThrow('MVU stat_data 是只读快照')
    expect(() => expandMacros('{{deletevar::stat_data["unterminated}}', ctx)).toThrow('MVU stat_data 是只读快照')
    expect(() => expandMacros('{{getvar::stat_data["unterminated}}', ctx)).toThrow('MVU 宏变量路径无效')
    expect(() => expandMacros('{{getvar::stat_data.__proto__}}', ctx)).toThrow('MVU 宏变量路径无效')
  })

  it('A6: MVU logAt 依据真实 stat 容器类型处理数字键普通对象，且 move/copy 到 /- 解析实际追加下标', () => {
    const codec = createHelperMvuCommandCodec(helperJson, markdownCodeScanner)
    // 大数字键普通对象不再误建稀疏数组并触发 65536 越界。
    const bigKey = codec.apply(
      { obj: { '100000': 1 } },
      [{ type: 'set', full_match: "_.set('obj.100000', 2)", reason: 'test', args: ['obj.100000', '2'] }],
    )
    expect(bigKey.stat_data).toEqual({ obj: { '100000': 2 } })
    expect(Array.isArray((bigKey.delta_data as Record<string, unknown>).obj)).toBe(false)
    expect((bigKey.delta_data as Record<string, Record<string, string>>).obj!['100000']).toContain('1->2')

    // 含 "0" 和非数字键的普通对象连续修改时保留所有字段日志。
    const mixedObj = codec.apply(
      { obj: { '0': { x: 1 }, bar: 2 } },
      [
        { type: 'set', full_match: "_.set('obj.0.x', 9)", reason: 'a', args: ['obj.0.x', '9'] },
        { type: 'set', full_match: "_.set('obj.bar', 8)", reason: 'b', args: ['obj.bar', '8'] },
      ],
    )
    expect(Array.isArray((mixedObj.delta_data as Record<string, unknown>).obj)).toBe(false)
    expect((mixedObj.delta_data as Record<string, Record<string, unknown>>).obj!['0']).toEqual({ x: '1->9 (a)' })
    expect((mixedObj.delta_data as Record<string, Record<string, unknown>>).obj!.bar).toBe('2->8 (b)')

    // JSON Patch copy/move 到 /arr/- 保留数组原项与既有 delta。
    const patchCmds = codec.parse(
      '<JSONPatch>[{"op":"replace","path":"/bag/0","value":"blade"},{"op":"copy","from":"/src","path":"/bag/-"}]</JSONPatch>',
    )
    const copied = codec.apply({ src: 'gem', bag: ['sword', 'shield'] }, patchCmds)
    expect(copied.stat_data).toEqual({ src: 'gem', bag: ['blade', 'shield', 'gem'] })
    expect(Array.isArray((copied.display_data as Record<string, unknown>).bag)).toBe(true)
    expect((copied.display_data as Record<string, unknown[]>).bag![1]).toBe('shield')
    expect(String((copied.display_data as Record<string, unknown[]>).bag![2])).toContain('COPIED')
    expect(Array.isArray((copied.delta_data as Record<string, unknown>).bag)).toBe(true)
    expect(String((copied.delta_data as Record<string, unknown[]>).bag![0])).toContain('sword')
    expect(String((copied.delta_data as Record<string, unknown[]>).bag![2])).toContain('COPIED')
  })

  it('A7: 转义前导反引号时 inlineSpan / continuedMarkdown / MVU 命令解析不丢末尾字符', () => {
    const sample = 'See \\``<div>hello</div>`'
    const scanner = markdownCodeScanner(sample)
    expect(scanner.inlineSpan(5)).toEqual({ start: 6, end: sample.length, width: 1 })
    expect(scanner.inlineSpan(6)).toEqual({ start: 6, end: sample.length, width: 1 })

    const cont = continuedMarkdown('See \\``<div>', 'hello</div>` tail')
    expect(cont).toEqual({ start: 6, text: '` hello</div> ` tail' })

    const codec = createHelperMvuCommandCodec(helperJson, markdownCodeScanner)
    const parsed = codec.parse("<UpdateVariable>\\``_.set('hp', 9);`</UpdateVariable>")
    expect(parsed).toHaveLength(1)
    expect(parsed[0]!.args).toEqual(["'hp'", '9'])
  })

  it('A8: 脚本库保存失败后再次 replaceScriptTrees 保持 error 状态，不卡死在 pending', async () => {
    const posted: unknown[] = []
    const listeners: Array<(event: { source: unknown; data: unknown }) => void> = []
    const parentObj = {
      postMessage(msg: unknown) {
        posted.push(msg)
        const m = msg as Record<string, unknown>
        if (m.action === 'helperScriptLibraryCommit') {
          queueMicrotask(() => {
            for (const fn of listeners) {
              fn({ source: parentObj, data: { source: 'dsh-tavern-card', action: 'helperScriptLibraryResult', requestId: m.requestId, runtimeId: 'rt-1', ok: false, error: '保存冲突' } })
            }
          })
        }
      },
    }
    const sandbox: Record<string, unknown> = {
      parent: parentObj,
      __dshTavernEventRuntimeId: 'rt-1',
      addEventListener(_type: string, fn: (event: { source: unknown; data: unknown }) => void) { listeners.push(fn) },
      removeEventListener() {},
      crypto: { randomUUID: () => 'req-' + Math.random().toString(16).slice(2) },
      setTimeout,
      clearTimeout,
      queueMicrotask,
      Promise,
      Error,
      Object,
      Array,
      JSON,
      Map,
      Set,
      String,
      Number,
      Boolean,
    }
    sandbox.window = sandbox
    const ctx = createContext(sandbox)
    runInContext(
      `(${installCardScriptLibraries.toString()})({ storyId: 's1', bindingRevision: 'b1', libraries: [{ type: 'character', revision: 'r1', trees: [] }] }, x => x, x => x, {})`,
      ctx,
    )
    const api = sandbox as unknown as {
      replaceScriptTrees: (trees: unknown, opts: { type: 'character' }) => void
      flushHelperScripts: (opts?: { retry?: boolean }) => Promise<void>
      getHelperScriptStatus: () => string
    }
    api.replaceScriptTrees([{ type: 'script', value: { id: 'a', name: 'a', content: '1', info: '', enabled: true, button: { enabled: false, buttons: [] }, data: {} } }], { type: 'character' })
    await expect(api.flushHelperScripts()).rejects.toThrow('保存冲突')
    expect(api.getHelperScriptStatus()).toBe('error')

    // 失败后继续修改，不应将状态伪装成永远不会自动刷盘的 pending。
    api.replaceScriptTrees([{ type: 'script', value: { id: 'b', name: 'b', content: '2', info: '', enabled: true, button: { enabled: false, buttons: [] }, data: {} } }], { type: 'character' })
    expect(api.getHelperScriptStatus()).toBe('error')
  })

  it('A9: 非序列模板路径下 preset.formatting.worldInfo 中的 EJS 正常经 renderTemplate 求值', () => {
    const preset = {
      ...defaultPreset(),
      formatting: { worldInfo: '<%="["%>WI:<%=1+1%>]{0}' },
    }
    const wi = {
      activated: [{ entry: makeWiEntry({ content: 'MAGIC' }), matchedKeys: [], via: 'constant' as const, recursionLevel: 0 }],
      byPosition: { [WIPosition.BeforeCharDefs]: [{ entry: makeWiEntry({ content: 'MAGIC' }), matchedKeys: [], via: 'constant' as const, recursionLevel: 0 }] },
      outlets: {},
      log: [],
      budget: { limit: 1000, used: 10, overflowed: false },
      truncated: [],
      timerState: EMPTY_TIMER_STATE,
    }
    const renderedSources: string[] = []
    const assembled = assemblePrompt({
      card: makeCard(),
      preset,
      personaDescription: '',
      macroCtx: { char: 'Alice', user: 'Bob' },
      history: [{ role: 'user', content: 'hi' }],
      regexRules: [],
      memories: [],
      worldDeltas: [],
      budget: { maxTokens: 8192, reserveTokens: 512 },
      estimateTokens: (text) => text.length,
      wi,
      renderTemplate: (text, source) => {
        renderedSources.push(source)
        return text.replace('<%="["%>WI:<%=1+1%>]', '[WI:2]')
      },
    })
    expect(renderedSources).toContain('preset:format:world-info')
    expect(assembled.messages.map((m) => m.content).join('\n')).toContain('[WI:2]MAGIC')
  })
})
