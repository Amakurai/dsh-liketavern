/**
 * Core 层第二轮缺陷修复回归测试（C1–C4、C6–C13）：
 * - C1: hostMarkdown INLINE_FORMAT_MAP 与 cardFrame SKIP_MEASURE_TAGS 防 <constructor> 等原型链键触发 TypeError
 * - C2: collectTagInteriorMeta 遇到 embeddedAttributeNameOpeners 时保留 opened 锚点，不丢弃后续内容
 * - C3: cardMvu mergeLog 在非相邻递增数组下标合并时补 null 占位而非产生稀疏数组空洞
 * - C4: findHtmlFragment / findIncompleteHtmlStart 将前置 <style>/<script>/<template>/<link>/<meta> 与后续截断容器联动
 * - C6: streamingHtmlStart 跳过 x<y 普通文本而不越过真实 <div 起点
 * - C7: macros nested-get 栈扫描（含奇数 { 前缀与并列内层 {{getvar::...}}）正确展开
 * - C8: regex replaceWithGroupTrim 支持两位数捕获组 $10 与 ECMA-262 退化为 $1+'0'，并保留字面 $0
 * - C9: applyRegexToMessages 与 assemblePrompt 按 chatFlags 将非聊天系统/通知条排除在 depth 与身份宏之外
 * - C10: hostMarkdown Pass 3a 单轮安全替换多个相邻顶层 <blockquote>
 * - C11: hostMarkdown Pass 3d 保留非引用块行的原始前导缩进
 * - C12: hostMarkdown Pass 4b 行内标签变短重写时用 endTail.includes('<') 安全检测尾部
 * - C13: plainDetailsSyntax CUSTOM_ELEMENT_NAME_RE 忽略大小写匹配大写自定义元素
 */
import { createContext, runInContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { assemblePrompt, defaultPreset, type AssembleInput } from '../src/core/assemble.js'
import { tavernCardBridgeScript } from '../src/core/cardFrame.js'
import { presentRenderedOutput, presentStreamingOutput } from '../src/core/displaySanitize.js'
import { normalizeHostMarkdown } from '../src/core/hostMarkdown.js'
import { findHtmlFragment } from '../src/core/htmlFragment.js'
import { expandMacros } from '../src/core/macros.js'
import { parsePlainDetailsBlocks } from '../src/core/plainDetails.js'
import { applyRegexRules, applyRegexToMessages } from '../src/core/regex.js'
import type { CharacterCard, RegexRule } from '../src/core/types.js'

function makeCard(overrides: Partial<CharacterCard> = {}): CharacterCard {
  return {
    spec: 'chara_card_v2',
    name: 'Lumen',
    description: 'PRIMARY_CARD_DESCRIPTION',
    personality: 'CALM',
    scenario: 'HARBOR',
    firstMes: 'Hello',
    mesExample: '',
    systemPrompt: '',
    postHistoryInstructions: '',
    creatorNotes: '',
    alternateGreetings: [],
    tags: [],
    creator: 'tester',
    characterVersion: '1',
    regexScripts: [],
    extensions: {},
    ...overrides,
  }
}

describe('Core 层第二轮缺陷修复回归 (C1–C4、C6–C13)', () => {
  it('C1: <constructor> / <toString> 标签不触发原型链方法调用崩溃，iframe 度量亦安全跳过', () => {
    expect(() => normalizeHostMarkdown('<constructor>payload</constructor> and <toString>ok</toString>')).not.toThrow()
    expect(normalizeHostMarkdown('<constructor>payload</constructor>')).toContain('payload')

    const listeners = new Set<(event: unknown) => void>()
    const scope: Record<string, unknown> = {
      parent: { postMessage: () => {} },
      TextEncoder,
      crypto: webcrypto,
      queueMicrotask,
      setTimeout,
      clearTimeout,
      document: {
        readyState: 'complete',
        documentElement: { tagName: 'HTML', scrollHeight: 40, scrollWidth: 200, clientWidth: 200, getBoundingClientRect: () => ({ bottom: 40, right: 200, width: 200, height: 40 }) },
        body: {
          tagName: 'BODY',
          scrollHeight: 40,
          scrollWidth: 200,
          clientWidth: 200,
          children: [{ tagName: 'CONSTRUCTOR', getBoundingClientRect: () => ({ bottom: 90, right: 100, width: 100, height: 90 }) }],
          getBoundingClientRect: () => ({ bottom: 40, right: 200, width: 200, height: 40 }),
        },
        open: () => {},
        write: () => {},
        close: () => {},
        currentScript: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        querySelector: () => null,
      },
      addEventListener: (name: string, fn: (event: unknown) => void) => { if (name === 'message') listeners.add(fn) },
      removeEventListener: (_name: string, fn: (event: unknown) => void) => listeners.delete(fn),
    }
    scope.window = scope
    const ctx = createContext(scope)
    expect(() => {
      runInContext(tavernCardBridgeScript({ greetings: [], greetingIndex: 0 }).replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''), ctx)
      runInContext('__dshTavernBridgeCleanup()', ctx)
    }).not.toThrow()
  })

  it('C2: <UpdateVariable> / <think> 内嵌角括号属性片段不丢失 opened 锚点及正文后文', () => {
    const sample = '<UpdateVariable x="<badge>v</badge>">_.set("a",1)</UpdateVariable>\n保留后续台词！'
    const rendered = presentRenderedOutput(sample, false)
    expect(rendered.text).toContain('保留后续台词！')

    const think = '<think data-note="<hint>">\n推理过程\n</think>\n真实回答正文'
    expect(presentRenderedOutput(think, false).text).toContain('真实回答正文')
  })

  it('C3: cardMvu mergeLog 合并非相邻递增数组更新时以 null 补齐空槽', async () => {
    const listeners = new Set<(event: unknown) => void>()
    const send = (data: Record<string, unknown>) => {
      for (const listener of listeners) listener({ source: parent, data })
    }
    const parent = {
      postMessage: (msg: Record<string, unknown>) => {
        if (msg.action === 'helperEventEmit') {
          queueMicrotask(() => send({ source: 'dsh-tavern-card', action: 'helperEventResult', requestId: msg.requestId, runtimeId: msg.runtimeId, ok: true, args: msg.args }))
        } else if (msg.action === 'helperEventConnect') {
          queueMicrotask(() => send({ source: 'dsh-tavern-card', action: 'helperEventConnect', runtimeId: msg.runtimeId, accepted: true }))
        }
      },
    }
    const scope: Record<string, unknown> = {
      parent,
      TextEncoder,
      crypto: webcrypto,
      queueMicrotask,
      setTimeout,
      clearTimeout,
      document: {
        readyState: 'loading',
        body: null,
        open: () => {},
        write: () => {},
        close: () => {},
        currentScript: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        querySelector: () => null,
      },
      addEventListener: (name: string, fn: (event: unknown) => void) => { if (name === 'message') listeners.add(fn) },
      removeEventListener: (_name: string, fn: (event: unknown) => void) => listeners.delete(fn),
    }
    scope.window = scope
    const ctx = createContext(scope)
    runInContext(
      tavernCardBridgeScript({
        greetings: [],
        greetingIndex: 0,
        helperSnapshot: {
          storyId: 'story-c3',
          historyRevision: 'rev-1',
          currentMessageId: 0,
          writable: true,
          scopes: {},
          messages: [{ message_id: 0, role: 'assistant', name: 'A', message: 'ok', data: {}, extra: {}, is_hidden: false }],
        },
      }).replace(/^<script[^>]*>/, '').replace(/<\/script>$/, ''),
      ctx,
    )
    scope.eventEmit = async () => {}
    const mvu = scope.Mvu as { parseMessage: (msg: string, oldData: unknown) => Promise<{ delta_data: { arr: unknown[] } }> }
    const oldData = runInContext('JSON.parse(\'{"stat_data":{"arr":["x0","x1","x2","x3","x4"]}}\')', ctx)
    const result = await mvu.parseMessage(
      '<UpdateVariable>_.set("arr[1]", "first"); _.set("arr[4]", "fifth");</UpdateVariable>',
      oldData,
    )
    runInContext('__dshTavernBridgeCleanup()', ctx)
    const arr = result.delta_data.arr
    expect(arr.length).toBe(5)
    expect(0 in arr && 1 in arr && 2 in arr && 3 in arr && 4 in arr).toBe(true)
    expect(arr).toEqual([null, 'x1->first ', null, null, 'x4->fifth '])
  })

  it('C4: 前置 <style>/<script> 与后续未闭合容器块在同一 HTML 边界起算与挂起', () => {
    const partial = '前文台词\n<style>.card{color:red}</style>\n<div class="card">正在流式输出'
    const streaming = presentStreamingOutput(partial, true)
    expect(streaming.text).toBe('前文台词')
    expect(streaming.html).toBeFalsy()

    expect(findHtmlFragment('<style>.card{}</style><div>open', 0)).toBeNull()
  })

  it('C6: streamingHtmlStart 跳过 x<y 普通文本并准确定位后续未闭合 <div', () => {
    const text = '条件满足 x<y 所以触发 <div class="panel">加载中'
    const streamed = presentStreamingOutput(text, true)
    expect(streamed.text).toBe('条件满足 x<y 所以触发')
  })

  it('C7: macros nested-get 正确处理奇数连续左花括号及并列内层 getvar', () => {
    const store = new Map<string, string>([
      ['inner1', 'keyA'],
      ['inner2', 'keyB'],
      ['outer_keyA_keyB', 'RESOLVED'],
    ])
    expect(expandMacros('{{getvar::outer_{{getvar::inner1}}_{{getvar::inner2}}}}', { char: 'C', user: 'U', store })).toBe('RESOLVED')
    expect(expandMacros('{{{getvar::inner1}}}', { char: 'C', user: 'U', store })).toBe('{keyA}')
  })

  it('C8: regex replaceWithGroupTrim 支持两位数捕获 $10、退化 $1+"0" 并保留 $0 整段匹配', () => {
    const baseRule: RegexRule = {
      id: 'r1',
      name: 'captures',
      find: '^(a)(b)(c)(d)(e)(f)(g)(h)(i)(j)$',
      replace: '$10|$0',
      enabled: true,
      scopes: ['output'],
      timing: ['render'],
      minDepth: null,
      maxDepth: null,
      substituteRegex: 0,
      source: 'user',
      trimStrings: ['_'],
    }
    const singleGroupRule: RegexRule = {
      ...baseRule,
      id: 'r2',
      find: '^(z)$',
      replace: '$10|$19|$0',
    }
    expect(applyRegexRules('abcdefghij', [baseRule], { scope: 'output', timing: 'render' }, { char: 'C', user: 'U' }).text).toBe('j|abcdefghij')
    expect(applyRegexRules('z', [singleGroupRule], { scope: 'output', timing: 'render' }, { char: 'C', user: 'U' }).text).toBe('z0|z9|z')
  })

  it('C9: 非聊天条不参与正则深度计数也不展开身份宏', () => {
    const depthRule: RegexRule = {
      id: 'd',
      name: 'depth0',
      find: 'WORD',
      replace: 'REPLACED',
      enabled: true,
      scopes: ['prompt'],
      timing: ['send'],
      minDepth: 0,
      maxDepth: 0,
      substituteRegex: 0,
      source: 'user',
    }
    const msgs = [
      { role: 'user' as const, content: 'WORD first' },
      { role: 'system' as const, content: 'trailing system' },
    ]
    const out = applyRegexToMessages(
      msgs,
      [depthRule],
      { scope: 'prompt', timing: 'send', chatFlags: [true, false] },
      { char: 'C', user: 'U' },
    )
    expect(out.messages[0]!.content).toBe('REPLACED first')

    const assembled = assemblePrompt({
      card: makeCard(),
      preset: defaultPreset(),
      personaDescription: '',
      macroCtx: { char: 'Lumen', user: 'Traveler' },
      history: [
        { role: 'system', content: 'KEEP {{user}} LITERAL' },
        { role: 'user', content: 'Hi {{user}}' },
      ],
      regexRules: [],
      memories: [],
      worldDeltas: [],
      budget: { maxTokens: 4096, reserveTokens: 256 },
      estimateTokens: (s) => s.length,
    })
    expect(assembled.messages.some((m) => m.role === 'system' && m.content === 'KEEP {{user}} LITERAL')).toBe(true)
    expect(assembled.messages.some((m) => m.role === 'user' && m.content === 'Hi Traveler')).toBe(true)
  })

  it('C10–C13: normalizeHostMarkdown 多引用块/非引用缩进/行尾收缩安全与大写自定义元素折叠', () => {
    const c10 = normalizeHostMarkdown('<blockquote>first quote</blockquote>\n<blockquote>second quote</blockquote>')
    expect(c10).toContain('> first quote')
    expect(c10).toContain('> second quote')

    const c11 = normalizeHostMarkdown('<blockquote>quoted</blockquote>\n    indented line')
    expect(c11).toContain('\n    indented line')

    const longInline = '<span>' + 'A'.repeat(40) + '</span> tail'
    const c12 = normalizeHostMarkdown(longInline)
    expect(c12).toContain('tail')

    const c13 = parsePlainDetailsBlocks('<My-Widget><details><summary>标题</summary>内容</details></My-Widget>')
    expect(c13).toBeNull()
  })
})
