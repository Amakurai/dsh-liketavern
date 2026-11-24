/**
 * 展示/Markdown/HTML/Details/Regex 管线第三轮审计缺陷修复回归测试（Bug #1–#12、#14，覆盖 #31 与 #28 残余边界）：
 * - Bug #1: 外层机读块内含自闭合机读标签（如 `<StatusPlaceHolderImpl/>`）不卡死外层闭标签匹配
 * - Bug #2: `<blockquote>` 包裹多行代码围栏或 `<pre>` 时逐行补齐 `> ` 引用前缀
 * - Bug #3: `markdownCodeRanges` 仅追踪机读与容器级 HTML 边界，不因自定义伪标签/行内标签破坏 JSON 围栏保护
 * - Bug #4: 相邻行内格式化标签不拼成非法 `*a**b*`/`**a****b**`/`~~a~~~~b~~`，多行嵌套 `<i><b>...</b></i>` 多趟完整转换
 * - Bug #5: 已闭合独立 `<template>` 不触发 `pendingHtml` 吞掉后续正文，未闭合及前导挂起语义不变
 * - Bug #6: 纯 `<details>` 含 Markdown 代码内 `<script>`/`<style>` 不被 `htmlFragment` 误吞闭合
 * - Bug #7: `isPlainDetailsStructure` 与 `parsePlainDetailsBlocks` 共用扫描/清理口径，零漂移
 * - Bug #8: 与纯 `<details>` 紧邻（无正文隔开）的宿主 DOM `<style>` 及 `<style>+<div>+<details>` 正确拆分收起
 * - Bug #9: 未闭合 `<summary>` 遇到 `~~~{lang="html"}` / `~~~示例` 等非字母信息串波浪围栏仍跳过内部 `</summary>`
 * - Bug #10: `<link>`/`<meta>`/`<template>`/`<noscript>` + `<br>`/`<hr>` 不升级为空白 iframe
 * - Bug #11: GFM 表格单元格内 `<pre>`/`<p>`/`<hr>`/`<blockquote>` 不拆行破坏表格结构
 * - Bug #12: `presentRenderedOutput(..., false)` 跨 HTML 拆分段共享自定义伪标签名清理尾部闭标签
 * - Bug #14: `findUnsafeRegexConstruct` 放行固定长度量词 `(\d{2})+`，仍拦截可变嵌套量词 `(\d{2,})+`
 */
import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'
import {
  presentRenderedOutput,
  presentStreamingOutput,
  stripDisplayMeta,
  stripOpaqueDisplayMeta,
} from '../src/core/displaySanitize.js'
import { normalizeHostMarkdown } from '../src/core/hostMarkdown.js'
import { findHtmlFragment } from '../src/core/htmlFragment.js'
import { isPlainDetailsHtml, parsePlainDetailsBlocks } from '../src/core/plainDetails.js'
import { isPlainDetailsStructure } from '../src/core/plainDetailsSyntax.js'
import { findUnsafeRegexConstruct } from '../src/core/regex.js'
import { splitTemplateDisplay } from '../src/core/templateDisplay.js'

const md = new MarkdownIt('commonmark', { html: false })
const issue31Fold = '<details>\n<summary>你可以从列表中选择一个家庭和地区\n\n### 中央大陆\n1. 鲁迪乌斯\n</details>'

describe('展示/Markdown/HTML/Details/Regex 第三轮审计修复回归', () => {
  it('Bug #1: 外层机读块内含自闭合机读占位符时正常配对闭标签且保持交叉嵌套隐私边界', () => {
    expect(stripOpaqueDisplayMeta('<think>秘密<StatusPlaceHolderImpl/></think>可见正文')).toBe('可见正文')
    expect(stripDisplayMeta('<UpdateVariable><initvar/>_.set("hp", 10)</UpdateVariable>\n可见回复')).toBe('可见回复')
    expect(stripOpaqueDisplayMeta('<think><initvar/><StatusPlaceHolderImpl/>内层</think>保留')).toBe('保留')
    expect(stripOpaqueDisplayMeta('<textarea><think>秘密<StatusPlaceHolderImpl/></think>可见</textarea>'))
      .toBe('<textarea>可见</textarea>')
    expect(stripOpaqueDisplayMeta('<div data-v="<think>秘密<StatusPlaceHolderImpl/></think>">ok</div>'))
      .toBe('<div data-v="">ok</div>')
    // 既有隐私边界回归：非自闭合交叉嵌套仍整段隐藏，未闭合仍隐到文末，孤立自闭合仍放行后续正文。
    expect(stripOpaqueDisplayMeta('<think><Analysis>一</think>交叉泄漏</Analysis>公开')).toBe('')
    expect(stripOpaqueDisplayMeta('<think>未闭合秘密<StatusPlaceHolderImpl/>残余')).toBe('')
    expect(stripOpaqueDisplayMeta('<think/>SECRET</think>VISIBLE')).toBe('VISIBLE')
    expect(stripOpaqueDisplayMeta('<think/>VISIBLE')).toBe('VISIBLE')
  })

  it('Bug #2: <blockquote> 包裹代码围栏与 <pre> 逐行补齐引用前缀，CommonMark 正确渲染且不吞后文', () => {
    const fencedQuote = '<blockquote>\n```json\n{"a": 1}\n```\n</blockquote>\n后续普通正文'
    const normalized = normalizeHostMarkdown(fencedQuote)
    expect(normalized).toBe('> ```json\n> {"a": 1}\n> ```\n\n后续普通正文')
    const rendered = md.render(normalized)
    expect(rendered).toContain('<blockquote>\n<pre><code class="language-json">{&quot;a&quot;: 1}\n</code></pre>\n</blockquote>')
    expect(rendered).toContain('<p>后续普通正文</p>')

    const preQuote = '<blockquote><pre>line1\n  indented\n\nline4</pre></blockquote>\n后续'
    const preNorm = normalizeHostMarkdown(preQuote)
    expect(preNorm).toContain('> ```\n> line1\n>   indented\n>\n> line4\n> ```')
    const preHtml = md.render(preNorm)
    expect(preHtml).toContain('<blockquote>\n<pre><code>line1\n  indented\n\nline4\n</code></pre>\n</blockquote>')
    expect(preHtml).toContain('<p>后续</p>')

    const nested = '<blockquote>\n<blockquote>\n```js\nconst x = 1\n```\n</blockquote>\n</blockquote>\n后文'
    const nestedHtml = md.render(normalizeHostMarkdown(nested))
    expect(nestedHtml).toContain('<blockquote>\n<blockquote>\n<pre><code class="language-js">const x = 1\n</code></pre>\n</blockquote>\n</blockquote>')
    expect(nestedHtml).toContain('<p>后文</p>')

    const inMdQuote = '> <blockquote>\n> ```json\n> {"ok": true}\n> ```\n> </blockquote>'
    expect(normalizeHostMarkdown(inMdQuote)).toBe('> > ```json\n> > {"ok": true}\n> > ```')

    const preInMdQuote = '> <blockquote><pre>a\nb</pre></blockquote>'
    expect(normalizeHostMarkdown(preInMdQuote)).toBe('> > ```\n> > a\n> > b\n> > ```')
  })

  it('Bug #3: 自定义伪标签与行内/标题 HTML 标签不破坏后续 JSON 围栏保护，容器内隐私剥离仍生效', () => {
    const customWrapped = '<status1>\n```json\n{"close": "</status1>", "meta": "<UpdateVariable>keep</UpdateVariable>"}\n```\n</status1>'
    const stripped = stripDisplayMeta(customWrapped)
    expect(stripped).toBe('```json\n{"close": "</status1>", "meta": "<UpdateVariable>keep</UpdateVariable>"}\n```')
    expect(presentRenderedOutput(customWrapped, true)).toEqual({
      html: null,
      htmls: [],
      text: '```json\n{"close": "</status1>", "meta": "<UpdateVariable>keep</UpdateVariable>"}\n```',
    })

    const unclosedH3 = '<h3>角色档案\n```json\n{"tag": "<think>示例</think>"}\n```'
    const h3Out = presentRenderedOutput(unclosedH3, true)
    expect(h3Out.text).toContain('"<think>示例</think>"')
    expect(normalizeHostMarkdown(h3Out.text)).toContain('### 角色档案\n```json\n{"tag": "<think>示例</think>"}\n```')

    const fontWrapped = '<font color="gold">\n```json\n{"tag": "<think>unclosed"}\n```\n</font>'
    expect(presentRenderedOutput(fontWrapped, true).text).toContain('"<think>unclosed"')

    // 真实容器内的反引号机读块仍继续剥离。
    expect(presentRenderedOutput('<div class="card">`<think>SECRET</think>`</div>', true).htmls[0])
      .toBe('<div class="card">``</div>')
  })

  it('Bug #4: 相邻行内格式标签不合并成破损星号/波浪线，多行嵌套 <i><b>...</b></i> 完整转换', () => {
    const adjI = normalizeHostMarkdown('<i>a</i><i>b</i>')
    expect(adjI).not.toContain('*a**b*')
    expect(md.renderInline(adjI)).not.toContain('**')

    const adjB = normalizeHostMarkdown('<b>a</b><b>b</b>')
    expect(adjB).not.toContain('**a****b**')
    expect(md.renderInline(adjB)).not.toContain('**')

    const fontAdjB = normalizeHostMarkdown('<font color="red"><b>A</b></font><font color="blue"><b>B</b></font>')
    expect(fontAdjB).not.toContain('**A****B**')
    expect(md.renderInline(fontAdjB)).not.toContain('**')

    const adjS = normalizeHostMarkdown('<s>a</s><s>b</s>')
    expect(adjS).not.toContain('~~~~')

    // 带空白间隔的相邻标签仍正常各自转换。
    expect(normalizeHostMarkdown('<i>a </i><i>b</i>')).toBe('*a* *b*')
    expect(normalizeHostMarkdown('<b>a</b> <b>b</b>')).toBe('**a** **b**')

    // 多行嵌套 <i><b>...</b></i> 与 <b><i>...</i></b> 经多趟处理完整转换并在 CommonMark 正确渲染。
    const multiNested = normalizeHostMarkdown('<i><b>第一行\n第二行</b></i>')
    expect(multiNested).toBe('***第一行***\n***第二行***')
    expect(md.render(multiNested)).toContain('<em><strong>第一行</strong></em>\n<em><strong>第二行</strong></em>')

    const multiNestedRev = normalizeHostMarkdown('<b><i>第一行\n第二行</i></b>')
    expect(multiNestedRev).toBe('***第一行***\n***第二行***')
  })

  it('Bug #5: 独立闭合 <template> 不误触发 pendingHtml，未闭合与前导挂起仍正常保护', () => {
    const closedTemplate = '<template id="sample"><div>示例</div></template>\n普通正文'
    expect(presentRenderedOutput(closedTemplate, true)).toEqual({
      html: null,
      htmls: [],
      text: closedTemplate,
    })
    expect(presentStreamingOutput(closedTemplate, true)).toEqual({
      text: closedTemplate,
      pendingHtml: false,
    })

    const multiClosed = '<template>a</template>\n<template>b</template>\n普通正文'
    expect(presentRenderedOutput(multiClosed, true)).toEqual({
      html: null,
      htmls: [],
      text: multiClosed,
    })

    const linkThenTemplate = '<link rel="stylesheet" href="https://example.com/a.css">\n<template>x</template>\n普通正文'
    expect(presentRenderedOutput(linkThenTemplate, true).pendingHtml).toBeUndefined()
    expect(presentRenderedOutput(linkThenTemplate, true).text).toContain('普通正文')

    // 未闭合 <template> 或紧接未闭合 <div> 仍触发 pendingHtml。
    expect(presentRenderedOutput('<template id="sample"><div>未闭合', true)).toEqual({
      html: null,
      htmls: [],
      text: '',
      pendingHtml: true,
    })
    expect(presentRenderedOutput('前文\n<template id="sample"><div>x</div></template>\n<div class="card">未闭合', true))
      .toEqual({ html: null, htmls: [], text: '前文', pendingHtml: true })

    // 紧接完整卡片时照常与卡片合并进同一沙箱。
    const mergedCard = '<template id="sample"><div>x</div></template>\n<div class="card">完整卡</div>'
    expect(presentRenderedOutput(mergedCard, true)).toEqual({
      html: mergedCard,
      htmls: [mergedCard],
      text: '',
    })
  })

  it('Bug #6: 纯 <details> 中含 Markdown 代码内的 <script>/<style> 正常识别为原生折叠块', () => {
    const inlineCodeDetails = '<details><summary>代码说明</summary>\n用 `<script>` 开启脚本标签，用 `<style>` 编写样式。\n</details>'
    expect(isPlainDetailsHtml(inlineCodeDetails)).toBe(true)
    expect(presentRenderedOutput(inlineCodeDetails, true)).toEqual({
      html: inlineCodeDetails,
      htmls: [inlineCodeDetails],
      text: '',
    })
    expect(splitTemplateDisplay(inlineCodeDetails)).toEqual([
      { kind: 'html', text: inlineCodeDetails },
    ])

    const fencedCodeDetails = '<details><summary>脚本示例</summary>\n```html\n<script>console.log(1)</script>\n<style>.x{color:red}</style>\n```\n</details>'
    expect(isPlainDetailsHtml(fencedCodeDetails)).toBe(true)
    expect(presentRenderedOutput(fencedCodeDetails, true)).toEqual({
      html: fencedCodeDetails,
      htmls: [fencedCodeDetails],
      text: '',
    })

    const adjacentCard = `${inlineCodeDetails}\n<div class="card">状态栏</div>`
    expect(splitTemplateDisplay(adjacentCard)).toEqual([
      { kind: 'html', text: inlineCodeDetails },
      { kind: 'html', text: '<div class="card">状态栏</div>' },
    ])
  })

  it('Bug #7: isPlainDetailsStructure 与 parsePlainDetailsBlocks 在 6 类边界样本上完全一致且不拖累相邻纯折叠块', () => {
    const edgeSamples = [
      '<details><summary>A</summary><a:b:c>内容</details>',
      '<details><summary>A</summary>\n    </status1>\n正文</details>',
      '<details><summary>A</summary>\n>\t  <status1>\n正文</details>',
      '<details><summary>A</summary><status1><!-- c -->\n正文</details>',
      '<details><summary>A</summary><status1><br/>\n正文</details>',
      '<details><summary>A</summary><status1/> <status2/>\n正文</details>',
    ]
    for (const sample of edgeSamples) {
      const parsed = parsePlainDetailsBlocks(sample)
      expect(isPlainDetailsStructure(sample)).toBe(parsed !== null)

      // 无论当前边缘块是纯折叠还是非纯折叠，与合法 #31 纯折叠块紧邻时，合法 #31 块始终保持原生折叠。
      const parts = splitTemplateDisplay(`${sample}\n${issue31Fold}`)
      const foldPart = parts.find(p => p.kind === 'html' && p.text.includes('鲁迪乌斯'))
      expect(foldPart).toBeDefined()
      expect(isPlainDetailsHtml(foldPart!.text)).toBe(true)
    }
  })

  it('Bug #8: 与纯 <details> 紧邻的前置/后置宿主 DOM <style> 与无关卡片样式正确拆分并收起', () => {
    const beforeHostCss = `<style>.mes_text { font-family: serif; }</style>\n${issue31Fold}`
    expect(presentRenderedOutput(beforeHostCss, true)).toEqual({
      html: issue31Fold,
      htmls: [issue31Fold],
      text: '',
    })
    expect(splitTemplateDisplay(beforeHostCss)).toEqual([
      { kind: 'html', text: issue31Fold },
    ])

    const afterHostCss = `${issue31Fold}\n<style>.mes_text { font-family: serif; }</style>`
    expect(presentRenderedOutput(afterHostCss, true)).toEqual({
      html: issue31Fold,
      htmls: [issue31Fold],
      text: '',
    })
    expect(splitTemplateDisplay(afterHostCss)).toEqual([
      { kind: 'html', text: issue31Fold },
    ])

    const styledCardThenFold = `<style>.card { color: red; }</style>\n<div class="card">状态</div>\n${issue31Fold}`
    expect(presentRenderedOutput(styledCardThenFold, true).htmls).toEqual([
      '<style>.card { color: red; }</style>\n<div class="card">状态</div>',
      issue31Fold,
    ])

    // 显式作用到 details、带外部 <link> 或 <div>+<details>+尾样式共享时保持合并回归。
    const detailsTargeted = `<style>details { border: 1px solid gold; }</style>\n${issue31Fold}`
    expect(presentRenderedOutput(detailsTargeted, true).htmls).toEqual([detailsTargeted])

    const linkTargeted = `<link rel="stylesheet" href="https://example.com/a.css">\n<style>.x{}</style>\n${issue31Fold}`
    expect(presentRenderedOutput(linkTargeted, true).htmls).toEqual([linkTargeted])

    const cardDetailsSharedTail = '<div class="bar">状态</div>\n<details><summary>详情</summary>内容</details>\n<!-- style -->\n<style>.bar{color:red}</style>'
    expect(splitTemplateDisplay(cardDetailsSharedTail)).toEqual([
      { kind: 'html', text: cardDetailsSharedTail },
    ])
  })

  it('Bug #9: 未闭合 <summary> 识别非字母/中文信息串波浪围栏，不被围栏内 </summary> 误截断', () => {
    const braceInfo = '<details>\n<summary>标题\n~~~{lang="html"}\n</summary>\n~~~\n</details>'
    const parsedBrace = parsePlainDetailsBlocks(braceInfo)
    expect(parsedBrace).not.toBeNull()
    expect(parsedBrace![0]!.summary).toBe('标题')
    expect(parsedBrace![0]!.children).toEqual([
      { kind: 'markdown', text: '~~~{lang="html"}\n</summary>\n~~~' },
    ])

    const cjkInfo = '<details>\n<summary>标题\n~~~示例\n</summary>\n~~~\n</details>'
    const parsedCjk = parsePlainDetailsBlocks(cjkInfo)
    expect(parsedCjk).not.toBeNull()
    expect(parsedCjk![0]!.summary).toBe('标题')
    expect(parsedCjk![0]!.children).toEqual([
      { kind: 'markdown', text: '~~~示例\n</summary>\n~~~' },
    ])
  })

  it('Bug #10: <link>/<meta>/<template>/<noscript> 后接 <br>/<hr> 不被升级为独立空白 iframe', () => {
    const samples = [
      '<link rel="stylesheet" href="https://example.com/a.css">\n<br>\n普通正文',
      '<meta charset="utf-8">\n<hr>\n普通正文',
      '<template id="t"><div>示例</div></template>\n<br>\n普通正文',
      '<noscript>回退</noscript>\n<hr>\n普通正文',
    ]
    for (const sample of samples) {
      expect(findHtmlFragment(sample)).toBeNull()
      const out = presentRenderedOutput(sample, true)
      expect(out.htmls).toEqual([])
      expect(out.pendingHtml).toBeUndefined()
      expect(out.text).toContain('普通正文')
    }

    // 已有激活 <style> 卡面时的紧邻 <p>/<br> 与 <template>+<div> 仍按原语义合并。
    expect(findHtmlFragment('<style>p{color:red}</style><p>状态</p><br>')).not.toBeNull()
    expect(findHtmlFragment('<template>x</template>\n<div class="card">真卡</div>')).not.toBeNull()
  })

  it('Bug #11: GFM 表格单元格内的 <pre>/<p>/<hr>/<blockquote> 保持单行不拆表', () => {
    const table = [
      '| 项目 | 内容 |',
      '| --- | --- |',
      '| 代码 | <pre>a</pre> |',
      '| 段落 | <p>A</p><p>B</p> |',
      '| 分割 | <hr> |',
      '| 引用 | <blockquote>引文</blockquote> |',
    ].join('\n')
    const normalized = normalizeHostMarkdown(table)
    expect(normalized.split('\n')).toHaveLength(6)
    expect(normalized).toBe(table)
  })

  it('Bug #12: 交互卡关闭模式（allowHtml=false）跨 HTML 拆分段共享自定义伪标签名清理尾标签', () => {
    const sample = '<Adventurer Profile>\n```json\n{"hp":100}\n```\n<details><summary>契约</summary>希尔薇</details>\n正文</Adventurer Profile>'
    const disabled = presentRenderedOutput(sample, false)
    expect(disabled.html).toBeNull()
    expect(disabled.htmls).toEqual([])
    expect(disabled.text).toContain('```json\n{"hp":100}\n```')
    expect(disabled.text).toContain('```html\n<details><summary>契约</summary>希尔薇</details>\n```')
    expect(disabled.text).toContain('正文')
    expect(disabled.text).not.toContain('<Adventurer Profile>')
    expect(disabled.text).not.toContain('</Adventurer Profile>')
  })

  it('Bug #14: 正则安全检查放行外层重复内的固定长度量词 {n}，仍拦截可变嵌套量词', () => {
    expect(findUnsafeRegexConstruct('(\\d{2})+')).toBeNull()
    expect(findUnsafeRegexConstruct('(?:[0-9a-f]{2}){4}')).toBeNull()
    expect(findUnsafeRegexConstruct('(a{3})+')).toBeNull()
    expect(findUnsafeRegexConstruct('([A-Z]{2}\\d{2})+')).toBeNull()

    // 可变嵌套量词仍严格拦截。
    expect(findUnsafeRegexConstruct('(\\d{2,})+')).not.toBeNull()
    expect(findUnsafeRegexConstruct('(\\d{2,4})+')).not.toBeNull()
    expect(findUnsafeRegexConstruct('(a+)+')).not.toBeNull()
    expect(findUnsafeRegexConstruct('((a+){2})+')).not.toBeNull()
  })
})
