/**
 * core 层深度审计回归测试：
 * 覆盖空历史深度注入、可变上下文 WeakMap 缓存一致性、引用块内未闭合围栏边界、
 * 展示净化（孤立闭标签代码示例、CRLF 排版、HTML5 数值字符引用、四列制表位缩进、反二次退化）、
 * 原生 <details> 跨块反引号/围栏与多行自定义标签沙箱边界、卡面持久化 -0 收敛、
 * 以及世界书/资产/记忆预算在 NaN/负值与缺省可选字段下的精确不变量。
 */
import { createContext, runInContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assemblePrompt, defaultPreset, type AssembleInput } from '../src/core/assemble.js'
import {
  budgetAssetFiles,
  budgetPresetCatalog,
  collapseWhitespacePreview,
} from '../src/core/assetRead.js'
import { installCardPersistence } from '../src/core/cardPersistence.js'
import { continuedMarkdown } from '../src/core/continuationMarkdown.js'
import {
  isKnownHtmlElementName,
  presentRenderedOutput,
  presentStreamingOutput,
  stripDisplayMeta,
  stripOpaqueDisplayMeta,
} from '../src/core/displaySanitize.js'
import { createHelperMvuCommandCodec } from '../src/core/helperMvuCommands.js'
import { helperJson, type HelperSnapshot } from '../src/core/helperRuntime.js'
import { findHtmlFence } from '../src/core/htmlFence.js'
import { budgetLoreCatalog, clipLoreContents } from '../src/core/loreQuery.js'
import { createMacroDependencyTracker } from '../src/core/macroDependencies.js'
import { expandMacros, hasTurnLocalMacros } from '../src/core/macros.js'
import { markdownCodeScanner } from '../src/core/markdownCode.js'
import { budgetMemorySearch } from '../src/core/memoryToolBudget.js'
import { isPlainDetailsHtml, parsePlainDetailsBlocks } from '../src/core/plainDetails.js'
import { promptDepthPlacement, type PromptHistoryAnchor } from '../src/core/promptLayout.js'
import {
  EMPTY_TIMER_STATE,
  WIPosition,
  WIRole,
  WISelectiveLogic,
  type CharacterCard,
  type MacroContext,
  type MemoryEntry,
  type PresetEntry,
  type RegexRule,
  type WorldInfoEntry,
} from '../src/core/types.js'

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
    content: '',
    constant: true,
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

function makePresetEntry(partial: Partial<PresetEntry> & Pick<PresetEntry, 'identifier'>): PresetEntry {
  return {
    name: partial.identifier,
    enabled: true,
    role: 'system',
    position: 'relative',
    depth: 4,
    order: 100,
    content: '',
    marker: false,
    ...partial,
  }
}

describe('assemblePrompt 空历史与可变上下文缓存一致性', () => {
  it('history 为空数组时保留 depth > 0 的预设 in-chat、世界书 @D 与角色 depthPrompt 注入', () => {
    const preset = defaultPreset()
    preset.entries.push(
      makePresetEntry({
        identifier: 'inchat-d2',
        position: 'in-chat',
        role: 'system',
        depth: 2,
        order: 10,
        content: 'INCHAT_D2_MARKER',
      }),
    )
    const atDepthEntry = makeWiEntry({
      key: 'wi-at-depth',
      position: WIPosition.AtDepth,
      depth: 1,
      order: 20,
      role: WIRole.User,
      content: 'WI_AT_DEPTH_1',
    })
    const templateSeen: string[] = []
    const input: AssembleInput = {
      preset,
      card: makeCard({
        depthPrompt: { prompt: 'CARD_DEPTH_PROMPT_1', depth: 1, role: 'system' },
      }),
      personaDescription: '',
      history: [],
      wi: {
        activated: [{ entry: atDepthEntry, matchedKeys: [], via: 'constant', recursionLevel: 0 }],
        byPosition: {
          [WIPosition.AtDepth]: [{ entry: atDepthEntry, matchedKeys: [], via: 'constant', recursionLevel: 0 }],
        },
        outlets: {},
        log: [],
        budget: { limit: 1000, used: 10, overflowed: false },
        truncated: [],
        timerState: EMPTY_TIMER_STATE,
      },
      memories: [],
      worldDeltas: [],
      macroCtx: { char: 'Alice', user: 'Bob' },
      regexRules: [],
      estimateTokens: (t) => t.length,
      budget: { maxTokens: 100000, reserveForOutput: 0 },
      renderTemplate: (t) => t,
      processTemplateSequence: (seq) => {
        for (const item of seq) templateSeen.push(item.message.content)
        return { tailInsertions: [] }
      },
    }

    const assembled = assemblePrompt(input)
    const allMessagesText = assembled.messages.map(m => m.content).join('\n')
    expect(allMessagesText).toContain('INCHAT_D2_MARKER')
    expect(allMessagesText).toContain('WI_AT_DEPTH_1')
    expect(allMessagesText).toContain('CARD_DEPTH_PROMPT_1')
    expect(assembled.standing).toContain('INCHAT_D2_MARKER')
    expect(assembled.standing).toContain('WI_AT_DEPTH_1')
    expect(assembled.standing).toContain('CARD_DEPTH_PROMPT_1')
    expect(assembled.layout?.entries.map(e => e.content).join('\n')).toContain('INCHAT_D2_MARKER')
    expect(templateSeen.join('\n')).toContain('WI_AT_DEPTH_1')
  })

  it('MacroContext 原地挂载 outlets 或修改字段时不复用过期静态标记缓存，assemblePrompt 全链路保留内部标记原文', () => {
    const hazard = '\uE000tavernFrozenOpen0\uE001'
    const ctx: MacroContext = { char: 'Alice', user: 'Bob', store: new Map() }
    expect(expandMacros('Hello {{char}}', ctx)).toBe('Hello Alice')

    ctx.outlets = { card: `${hazard}{{user}}` }
    expect(expandMacros('{{setvar::saved::{{outlet::card}}}}{{getvar::saved}}', ctx)).toBe(`${hazard}{{user}}`)

    ctx.char = `${hazard}`
    expect(expandMacros('{{char}}', ctx)).toBe(hazard)

    // 复现 assemblePrompt 先跑 prompt 正则（outlets 未挂载）再挂载 outlets 展开预设条目的真实路径
    const preset = defaultPreset()
    preset.entries.push(
      makePresetEntry({
        identifier: 'outlet-holder',
        content: '{{setvar::slot::{{outlet:: portal }}}}{{getvar::slot}}',
      }),
    )
    const outletWi = makeWiEntry({
      key: 'wi-outlet',
      position: WIPosition.Outlet,
      outletName: 'portal',
      content: `${hazard}{{user}}`,
    })
    const promptRegex: RegexRule = {
      id: 'r1',
      name: 'prompt-touch-macro',
      find: '^hi$',
      replace: '{{char}}: hi',
      enabled: true,
      scopes: ['prompt'],
      timing: ['assemble'],
      minDepth: null,
      maxDepth: null,
      substituteRegex: 0,
      source: 'preset',
    }
    const result = assemblePrompt({
      preset,
      card: makeCard(),
      personaDescription: '',
      history: [{ role: 'user', content: 'hi' }],
      wi: {
        activated: [{ entry: outletWi, matchedKeys: [], via: 'constant', recursionLevel: 0 }],
        byPosition: {},
        outlets: { portal: [{ entry: outletWi, matchedKeys: [], via: 'constant', recursionLevel: 0 }] },
        log: [],
        budget: { limit: 1000, used: 10, overflowed: false },
        truncated: [],
        timerState: EMPTY_TIMER_STATE,
      },
      memories: [],
      worldDeltas: [],
      macroCtx: { char: 'Alice', user: 'Bob' },
      regexRules: [promptRegex],
      estimateTokens: (t) => t.length,
      budget: { maxTokens: 100000, reserveForOutput: 0 },
    })
    expect(result.turnContext).toContain(`${hazard}Bob`)
  })

  it('hasTurnLocalMacros 识别带尾随 :: 参数的 stat_data 读取，createMacroDependencyTracker 与 promptDepthPlacement 感知原地变更', () => {
    expect(hasTurnLocalMacros('{{getvar::stat_data::unused}}')).toBe(true)
    expect(hasTurnLocalMacros('{{haslocalvar::stat_data::fallback}}')).toBe(true)

    const vars: Record<string, string> = { note: 'plain' }
    const ctx: MacroContext = { char: 'Static text', user: 'Bob', vars, store: new Map([['hp', '10']]) }
    const tracker = createMacroDependencyTracker(ctx)
    expect(tracker.isDynamic('{{char}} {{note}}', ctx)).toBe(false)
    vars.note = '{{getvar::hp}}'
    expect(tracker.isDynamic('{{char}} {{note}}', ctx)).toBe(true)

    const anchors: PromptHistoryAnchor[] = [
      { inputIndex: 0, messageId: 'm1', role: 'user', chat: true },
      { inputIndex: 1, messageId: 'm2', role: 'assistant', chat: true },
    ]
    const firstPlacement = promptDepthPlacement(anchors, 1, 0)
    expect(firstPlacement.kind === 'depth' ? firstPlacement.previous?.messageId : undefined).toBe('m1')
    anchors.push({ inputIndex: 2, messageId: 'm3', role: 'user', chat: true })
    const secondPlacement = promptDepthPlacement(anchors, 1, 0)
    expect(secondPlacement.kind === 'depth' ? secondPlacement.previous?.messageId : undefined).toBe('m2')
    anchors[2]!.chat = false
    const thirdPlacement = promptDepthPlacement(anchors, 1, 0)
    expect(thirdPlacement.kind === 'depth' ? thirdPlacement.previous?.messageId : undefined).toBe('m1')
  })
})

describe('引用块内未闭合围栏的 CommonMark 边界与沙箱自包含性', () => {
  it('引用块结束即终止块内未闭合围栏：不泄漏后续机读块、不丢后续 HTML 围栏、不误包续写正文', () => {
    const withSecret = '> ```js\n> const demo = 1;\n可见台词\n<UpdateVariable>_.set("secret", 1);</UpdateVariable>'
    expect(stripDisplayMeta(withSecret)).toBe('> ```js\n> const demo = 1;\n可见台词')

    const nestedQuote = '> > ```py\n> > x = 1\n> 外层引用恢复正文 <think>内层思考</think>'
    expect(stripDisplayMeta(nestedQuote)).toBe('> > ```py\n> > x = 1\n> 外层引用恢复正文')

    const fenceAfterQuote = '> ```js\n> const x = 1;\n\n```html\n<div class="card">面板</div>\n```\n尾段'
    expect(findHtmlFence(fenceAfterQuote)?.contentStart).toBeGreaterThan(0)
    const rendered = presentRenderedOutput(fenceAfterQuote, true)
    expect(rendered.htmls).toEqual(['<div class="card">面板</div>'])
    expect(rendered.text).toBe('> ```js\n> const x = 1;\n尾段')

    // 共享 markdownCodeScanner 先扫过已闭合引用围栏 + 尾部未闭合引用围栏后，第二轮从头定位片段卡面不误判首段未闭合
    const closedQuoteCardThenUnclosedQuote = [
      '> ```js',
      '> const ok = 1;',
      '> ```',
      '',
      '<div class="card">REAL CARD</div>',
      '',
      '> ```js',
      '> const unclosed = 2;',
    ].join('\n')
    const multiPassRendered = presentRenderedOutput(closedQuoteCardThenUnclosedQuote, true)
    expect(multiPassRendered.htmls).toEqual(['<div class="card">REAL CARD</div>'])
    expect(multiPassRendered.text).toBe('> ```js\n> const ok = 1;\n> ```\n> ```js\n> const unclosed = 2;')

    // 即使不走同起点 memo，按后序再前序查询同一扫描器也不会用后段 unclosedCache 污染前段已闭合围栏
    const sharedScanner = markdownCodeScanner(closedQuoteCardThenUnclosedQuote)
    const lateOpen = closedQuoteCardThenUnclosedQuote.lastIndexOf('```js')
    const earlyOpen = closedQuoteCardThenUnclosedQuote.indexOf('```js')
    expect(sharedScanner.fence(lateOpen)?.closed).toBe(false)
    expect(sharedScanner.fence(earlyOpen)?.closed).toBe(true)

    // 先查 4 反引号未闭合（跨过 3 反引号闭行），再查后段 3 反引号未闭合，随后回查中间 3 反引号仍正确闭合
    const mixedLengths = '````a\n```b\n```\n```c\nunclosed'
    const mixedScanner = markdownCodeScanner(mixedLengths)
    expect(mixedScanner.fence(0)?.closed).toBe(false)
    expect(mixedScanner.fence(mixedLengths.indexOf('```c'))?.closed).toBe(false)
    expect(mixedScanner.fence(mixedLengths.indexOf('```b'))?.closed).toBe(true)

    expect(continuedMarkdown('> ```js\n> const a = 1;\n前段普通台词', '后段普通台词')).toBeUndefined()
  })

  it('MVU 解析器在引用块空围栏处不死循环，且 markdownCodeScanner / codec 可纯字符串注入空 VM 执行', () => {
    const codec = createHelperMvuCommandCodec(helperJson, markdownCodeScanner)
    const insideUpdate = '<UpdateVariable>\n> ```\n_.set("hp", 25);\n</UpdateVariable>'
    expect(codec.apply({ hp: 10 }, codec.parse(insideUpdate)).stat_data.hp).toBe(25)

    const outsideThenUpdate = '> ```js\n> _.add("hp", 999);\n<UpdateVariable>_.add("hp", 2);</UpdateVariable>'
    expect(codec.apply({ hp: 10 }, codec.parse(outsideThenUpdate)).stat_data.hp).toBe(12)

    const vmCtx = createContext({ TextEncoder })
    const vmResult = runInContext(
      `const helperRecord = ${((v: unknown) => typeof v === 'object' && v !== null && !Array.isArray(v)).toString()};
       const helperJson = ${helperJson.toString()};
       const scanner = ${markdownCodeScanner.toString()};
       const createCodec = ${createHelperMvuCommandCodec.toString()};
       const c = createCodec(helperJson, scanner);
       c.apply({ hp: 1 }, c.parse(${JSON.stringify(insideUpdate)})).stat_data.hp`,
      vmCtx,
    )
    expect(vmResult).toBe(25)
  })
})

describe('展示净化：孤立闭标签代码示例、CRLF、HTML5 数值实体、四列制表位与线性复杂度', () => {
  it('外层无未闭合块时保留含孤立闭标签的行内代码与闭合围栏，且闭合围栏尾不反转后续机读收起', () => {
    expect(stripDisplayMeta('不要写 `</think>` 或 `</now_plot>`')).toBe('不要写 `</think>` 或 `</now_plot>`')

    const closedFenceWithCloseTag = [
      '```js',
      'const tpl = "</div></think>";',
      '```',
      '<UpdateVariable>_.set("secret", "leaked");</UpdateVariable>',
      '可见正文',
    ].join('\n')
    expect(stripDisplayMeta(closedFenceWithCloseTag)).toBe('```js\nconst tpl = "</div></think>";\n```\n\n可见正文')

    expect(stripDisplayMeta('如果 a<b 则用 `</b>` 或 `<think>` 标签')).toBe('如果 a<b 则用 `</b>` 或 `<think>` 标签')
  })

  it('注释、script 与引号属性内的散落反引号不破坏后续行内代码保护', () => {
    expect(stripDisplayMeta('<!-- 注释 ` 反引号 -->正文 `<UpdateVariable>示例</UpdateVariable>` <UpdateVariable>秘密</UpdateVariable>'))
      .toBe('正文 `<UpdateVariable>示例</UpdateVariable>`')
    expect(stripDisplayMeta('<div data-tip="a ` b">正文 `<UpdateVariable>示例</UpdateVariable>` <UpdateVariable>秘密</UpdateVariable></div>'))
      .toBe('<div data-tip="a ` b">正文 `<UpdateVariable>示例</UpdateVariable>` </div>')
    expect(stripDisplayMeta('<script>const q = "`";</script>\n正文 `<UpdateVariable>示例</UpdateVariable>`\n<UpdateVariable>秘密</UpdateVariable>'))
      .toContain('正文 `<UpdateVariable>示例</UpdateVariable>`')
    expect(stripDisplayMeta('<think foo=`bar />正文 `<UpdateVariable>示例</UpdateVariable>` <UpdateVariable>秘密</UpdateVariable>'))
      .toBe('正文 `<UpdateVariable>示例</UpdateVariable>`')
  })

  it('CRLF 文本的尾随空白与连续空行按原换行符折叠，数值字符引用按 HTML5 替换 NUL/代理对/越界码点', () => {
    expect(stripDisplayMeta('第一段   \r\n\r\n\r\n<think>秘密</think>\r\n\r\n第二段\t\r\n结尾'))
      .toBe('第一段\r\n\r\n第二段\r\n结尾')

    const entitySample = '&#0;&#xD83D;&#xDE00;&#x110000;&lt;think&gt;SECRET&lt;/think&gt;VISIBLE'
    const stripped = stripOpaqueDisplayMeta(entitySample)
    expect(stripped).toBe('&#0;&#xD83D;&#xDE00;&#x110000;VISIBLE')

    // 当坏码点实体夹在机读块内部时，映射区间精确且不抛出 RangeError 或拼出伪造字符
    expect(stripOpaqueDisplayMeta('&lt;think&gt;&#0;&#xD800;&#x110000;SECRET&lt;/think&gt;OK')).toBe('OK')
  })

  it('四列制表位缩进代码与新增标准 SVG/MathML 元素不被误删或误判为流式卡面', () => {
    for (const sample of [
      '示例：\n\n  \t<status1>',
      '示例：\n\n \t<Adventurer Profile>',
      '>\t  <status1>',
      '<svg><defs><filter id="f"><feBlend mode="multiply"/></filter></defs><text><tspan>字</tspan></text></svg>',
      '<math><semantics><mtable><mtr><mtd><msub><mi>x</mi><mn>1</mn></msub></mtd></mtr></mtable><annotation-xml encoding="MathML-Content"></annotation-xml></semantics></math>',
    ]) {
      expect(isKnownHtmlElementName('feBlend')).toBe(true)
      expect(isKnownHtmlElementName('annotation-xml')).toBe(true)
      expect(stripDisplayMeta(sample)).toBe(sample)
    }

    expect(presentStreamingOutput('  \t<div>缩进代码</div>', true)).toEqual({
      text: '<div>缩进代码</div>',
      pendingHtml: false,
    })
    expect(presentRenderedOutput('  \t<div>缩进代码</div>', true)).toEqual({
      html: null,
      htmls: [],
      text: '<div>缩进代码</div>',
    })
  })

  it('外层机读块内包含数千行未闭合围栏时保持线性耗时且不泄漏秘密', () => {
    const heavy = `<think>\n${'```lang\n'.repeat(4000)}内部秘密\n</think>\n公开结论`
    const start = performance.now()
    const result = stripDisplayMeta(heavy)
    expect(performance.now() - start).toBeLessThan(300)
    expect(result).toBe('公开结论')
  })
})

describe('parsePlainDetailsBlocks 沙箱回退与跨块隔离边界', () => {
  it('跨 </details> 的反引号或未闭合围栏绝不吞并相邻脚本或合并独立折叠块', () => {
    const backtickBypass = [
      '<details><summary>一</summary>',
      '`',
      '</details>',
      '<script>window.pwned = 1</script>',
      '<details><summary>二</summary>',
      '`',
      '</details>',
    ].join('\n')
    expect(parsePlainDetailsBlocks(backtickBypass)).toBeNull()
    expect(isPlainDetailsHtml(backtickBypass)).toBe(false)

    const fenceBypass = [
      '<details><summary>一</summary>',
      '```',
      '</details>',
      '<script>window.pwned = 1</script>',
      '<details><summary>二</summary>',
      '```',
      '</details>',
    ].join('\n')
    expect(parsePlainDetailsBlocks(fenceBypass)).toBeNull()
    expect(isPlainDetailsHtml(fenceBypass)).toBe(false)

    const twoWithStrayBackticks = [
      '<details><summary>第一条</summary>',
      '孤立反引号 ` 甲',
      '</details>',
      '<details><summary>第二条</summary>',
      '孤立反引号 ` 乙',
      '</details>',
    ].join('\n')
    const parsed = parsePlainDetailsBlocks(twoWithStrayBackticks)
    expect(parsed).toHaveLength(2)
    expect(parsed?.[0]?.summary).toBe('第一条')
    expect(parsed?.[1]?.summary).toBe('第二条')
  })

  it('<summary> 内的反引号不污染正文行内代码，独立行自定义元素、多行标签及带属性伪标签严格回退 null', () => {
    const summaryBacktick = [
      '<details><summary>命令 `help 说明</summary>',
      '请参考 `<div class="demo">` 的写法',
      '</details>',
    ].join('\n')
    expect(parsePlainDetailsBlocks(summaryBacktick)).toEqual([
      {
        open: false,
        summary: '命令 `help 说明',
        children: [{ kind: 'markdown', text: '请参考 `<div class="demo">` 的写法' }],
      },
    ])

    for (const unsafe of [
      '<details><summary>标题</summary>\n<my-widget>\n内容\n</my-widget>\n</details>',
      '<details><summary>标题</summary>\n<my-widget\n  onclick="alert(1)" />\n</details>',
      '<details><summary>标题</summary>\n<CustomCard onclick="alert(1)">\n内容\n</CustomCard>\n</details>',
      '<details><summary>外层</summary>\n`\n<details onclick="alert(1)">\n`\n</details>',
    ]) {
      expect(parsePlainDetailsBlocks(unsafe)).toBeNull()
      expect(isPlainDetailsHtml(unsafe)).toBe(false)
    }
  })
})

describe('installCardPersistence -0 收敛与工具预算/JSON 结构边界', () => {
  it('卡面变量写入 -0（负零）后提交一次即收敛为 saved，不因 Object.is(+0, -0) 陷入无限 IPC 循环', async () => {
    const listeners = new Set<(event: { source: unknown; data: unknown }) => void>()
    const parentWindow = {}
    let commitCount = 0
    const sandboxWindow: Record<string, unknown> = {
      __dshTavernEventRuntimeId: 'rt-audit-1',
      addEventListener: (_type: string, fn: (event: { source: unknown; data: unknown }) => void) => {
        listeners.add(fn)
      },
      removeEventListener: (_type: string, fn: (event: { source: unknown; data: unknown }) => void) => {
        listeners.delete(fn)
      },
    }
    const parent = {
      postMessage: (msg: Record<string, unknown>) => {
        if (msg.action === 'helperVariablesCommit') {
          commitCount++
          if (commitCount > 4) throw new Error('检测到负零导致的无限变量提交循环')
          const clonedScopes = JSON.parse(JSON.stringify({ chat: { temp: 0 } })) as Record<string, unknown>
          queueMicrotask(() => {
            for (const fn of listeners) {
              fn({
                source: parent,
                data: {
                  source: 'dsh-tavern-card',
                  action: 'helperVariablesResult',
                  requestId: msg.requestId,
                  runtimeId: 'rt-audit-1',
                  ok: true,
                  scopes: clonedScopes,
                },
              })
            }
          })
        }
      },
    }
    void parentWindow
    const snapshot: HelperSnapshot = {
      storyId: 'story-1',
      historyRevision: 'rev-1',
      currentMessageId: 0,
      writable: true,
      scopes: { chat: { temp: 1 } },
      messages: [],
    }
    const vmCtx = createContext({
      window: sandboxWindow,
      parent,
      crypto: webcrypto,
      setTimeout,
      clearTimeout,
      queueMicrotask,
    })
    const dispose = runInContext(
      `(${installCardPersistence.toString()})(${JSON.stringify(snapshot)}, 'dsh-tavern-card', { saving: 's', saved: 'ok', failed: 'err' })`,
      vmCtx,
    ) as () => void

    try {
      const holder = sandboxWindow.__dshTavernVariables as { scopes: { chat: { temp: number } } }
      holder.scopes.chat.temp = -0
      const flush = sandboxWindow.flushHelperVariables as () => Promise<void>
      await flush()
      expect(commitCount).toBe(1)
      expect((sandboxWindow.getHelperPersistenceStatus as () => string)()).toBe('saved')
    } finally {
      dispose()
    }
  })

  it('世界书与资产目录拒绝 NaN 预算绕过，collapseWhitespacePreview 夹紧非正数，记忆命中不残留 undefined 自有键', () => {
    const entries = [makeWiEntry({ key: 'lore-1', content: '长设定正文'.repeat(100) })]
    expect(() => budgetLoreCatalog(entries, Number.NaN)).toThrow('世界书输出预算不足以容纳响应元数据')
    expect(() => clipLoreContents(entries, Number.NaN)).toThrow('世界书输出预算不足以容纳响应元数据')
    expect(() => budgetAssetFiles(['notes/a.md'], Number.NaN)).toThrow('资产目录元数据超过输出预算')
    expect(() => budgetPresetCatalog(defaultPreset(), Number.NaN)).toThrow('资产目录元数据超过输出预算')

    expect(collapseWhitespacePreview('hello world', -3)).toBe('')
    expect(collapseWhitespacePreview('hello world', 0)).toBe('')
    expect(collapseWhitespacePreview('hello world', Number.NaN)).toBe('')

    const baseEntry: MemoryEntry = {
      id: 'mem-1',
      file: '0001.md',
      body: '关键事实：钥匙在钟楼里',
      tags: ['线索'],
      keys: ['钥匙'],
      archived: false,
      sourceRange: '',
      created: '2026-01-01T00:00:00.000Z',
      updated: '2026-01-01T00:00:00.000Z',
    }
    const entryWithoutRange = { ...baseEntry, sourceRange: undefined as unknown as string }
    const okRes = budgetMemorySearch([{ entry: entryWithoutRange, score: 1 }], 500)
    expect(okRes.ok).toBe(true)
    expect(okRes.results).toHaveLength(1)
    expect('sourceRange' in okRes.results![0]!).toBe(false)
    expect(okRes).toEqual(JSON.parse(JSON.stringify(okRes)))

    // 预算仅够空响应壳但容不下第一条结果时，无 sourceRange 的条目直接省略且不污染结果
    const tightRes = budgetMemorySearch([{ entry: entryWithoutRange, score: 1 }], 45)
    expect(tightRes.ok).toBe(true)
    expect(tightRes.results).toEqual([])
    expect(tightRes.omitted).toBe(1)
    expect(tightRes.tokensUsed).toBeLessThanOrEqual(45)
  })
})
