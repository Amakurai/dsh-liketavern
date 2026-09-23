/**
 * 展示层机读标签收起：UpdateVariable / JSONPatch / 流式未闭合尾巴 / 协议标签
 *（customize_HCI、now_plot 等），不误伤普通正文与 HTML。
 */
import { describe, expect, it } from 'vitest'
import { presentRenderedOutput, stripDisplayMeta, stripOpaqueDisplayMeta } from '../src/core/displaySanitize.js'

const SAMPLE = `他点了点头。

<UpdateVariable> <Analysis> notes </Analysis> <JSONPatch> [ { "op": "replace", "path": "/state/flag", "value": true }, { "op": "delta", "path": "/status/score", "value": 2 } ] </JSONPatch> </UpdateVariable>`

describe('stripDisplayMeta', () => {
  it('收起 UpdateVariable（含嵌套 Analysis/JSONPatch），留下正文', () => {
    expect(stripDisplayMeta(SAMPLE)).toBe('他点了点头。')
  })

  it('整段都是机读块时展示为空', () => {
    const only = SAMPLE.slice(SAMPLE.indexOf('<UpdateVariable>'))
    expect(stripDisplayMeta(only)).toBe('')
  })

  it('单独的 JSONPatch / Analysis 也会收起', () => {
    expect(stripDisplayMeta('台词\n<JSONPatch>[{"op":"add"}]</JSONPatch>\n尾')).toBe('台词\n\n尾')
    expect(stripDisplayMeta('<Analysis>内部独白</Analysis>\n可见')).toBe('可见')
  })

  it('流式未闭合时从开标签切到文末', () => {
    expect(stripDisplayMeta('前文\n<UpdateVariable> <Analysis> - 时间流逝：')).toBe('前文')
  })

  it('不误伤普通尖括号台词与 HTML 封面骨架', () => {
    expect(stripDisplayMeta('他说："<你真行>"。')).toBe('他说："<你真行>"。')
    const html = '<!DOCTYPE html><html><body><p>cover</p></body></html>'
    expect(stripDisplayMeta(html)).toBe(html)
  })

  it('邮箱自动链接与相近 custom element 不被当成机读标签', () => {
    for (const text of [
      'contact <think@example.com> visible',
      'contact <Analysis@example.com> visible',
      '<think-box>legit</think-box> after',
      '<think:note>legit</think:note> after',
    ]) expect(stripDisplayMeta(text)).toBe(text)
  })

  it('交互卡 HTML 与后面的正文拆开，正文再收起机读标签', () => {
    const rendered = '```html\n<!DOCTYPE html>\n<html><body>player</body></html>\n```\n可见正文。\n<UpdateVariable>x</UpdateVariable>'
    const shown = presentRenderedOutput(rendered, true)
    expect(shown.html).toContain('player')
    expect(shown.text).toBe('可见正文。')
  })

  it('交互卡关闭时不抽 HTML，仍留下正文', () => {
    const rendered = '```html\n<!DOCTYPE html>\n<html><body>player</body></html>\n```\n可见正文。'
    const shown = presentRenderedOutput(rendered, false)
    expect(shown.html).toBeNull()
    expect(shown.text).toContain('player')
    expect(shown.text).toContain('可见正文。')
    expect(shown.text).toContain('```html')
  })

  it('连续两段封面 HTML 都进 htmls，不把第二段源码当正文', () => {
    const rendered =
      '```html\n<!DOCTYPE html>\n<html><body>cover</body></html>\n```\n```html\n<!DOCTYPE html>\n<html><body>player</body></html>\n```\n{{user}}，你好。'
    const shown = presentRenderedOutput(rendered, true)
    expect(shown.htmls).toHaveLength(2)
    expect(shown.htmls[0]).toContain('cover')
    expect(shown.htmls[1]).toContain('player')
    expect(shown.text).toContain('你好')
    expect(shown.text).not.toContain('<!DOCTYPE')
  })

  it('收起 StatusPlaceHolderImpl 占位', () => {
    expect(stripDisplayMeta('<StatusPlaceHolderImpl/>\n正文')).toBe('正文')
  })

  it('收起未闭合的日志小部件 HTML', () => {
    const story = '可见正文。'
    const widget = `${story}\n\n<div class="foo-stream-log" style="width: 96%"><details class="note-box"><summary>log</summary>`
    expect(stripDisplayMeta(widget)).toBe(story)
  })

  it('收起 HTML 注释', () => {
    expect(stripDisplayMeta('<!--meta: 0,4,3,6,7,16 -->\n可见正文。')).toBe('可见正文。')
  })

  it('收起未转换的协议标签，留下内部正文', () => {
    const raw = `<customize_HCI> <now_plot> <world_situation> <world_status>
时空设定
</world_status> </world_situation>
<now_main_plot>
"台词。"
</now_main_plot>`
    const shown = stripDisplayMeta(raw)
    expect(shown).not.toContain('customize_HCI')
    expect(shown).not.toContain('now_plot')
    expect(shown).not.toContain('world_status')
    expect(shown).toContain('时空设定')
    expect(shown).toContain('"台词。"')
  })

  it('不把普通 HTML 标签当协议标签收起', () => {
    expect(stripDisplayMeta('他说 <div class="note">旁白</div> 完。')).toBe('他说 <div class="note">旁白</div> 完。')
    const upper='第一行<BR>第二行 <B>加粗</B> <DIV><TABLE><TR><TD>数字</TD></TR></TABLE><SVG><PATH d="M0 0"/></SVG></DIV>'
    expect(stripDisplayMeta(upper)).toBe(upper)
  })

  it('style 小部件进 htmls，前面的协议标签从正文收起', () => {
    const rendered = '<customize_HCI><style>.x{}</style><div class="x">ui</div>\n可见正文。'
    const shown = presentRenderedOutput(rendered, true)
    expect(shown.html).toContain('<style>')
    expect(shown.text).toBe('可见正文。')
    expect(shown.text).not.toContain('customize_HCI')
  })
})


/** 审查修复回归：禁用不丢内容，不执行 HTML，不让嵌入反引号逃逸围栏。 */
describe('审查修复回归：交互卡回退', () => {
  it.each([
    '<div class="character-card">关键线索：钥匙在柜子里</div>',
    '<details class="hint-box"><summary>线索</summary>关键线索：钥匙在柜子里</details>',
    '<!doctype html><html><body>关键线索：钥匙在柜子里</body></html>',
  ])('关闭交互卡仍按原顺序显示线索：%s', html => {
    const result = presentRenderedOutput(`前文\n${html}\n后文\n<UpdateVariable>secret</UpdateVariable>`, false)
    expect(result.htmls).toEqual([]); expect(result.html).toBeNull()
    expect(result.text).toContain(html)
    expect(result.text.indexOf('前文')).toBeLessThan(result.text.indexOf('关键线索'))
    expect(result.text.indexOf('关键线索')).toBeLessThan(result.text.indexOf('后文'))
    expect(result.text).not.toContain('secret')
    expect(result.text).toContain('```html')
  })
  it('HTML 内有三反引号时使用更长围栏，不把脚本暴露为 Markdown HTML', () => {
    const html = '<div>```\n<script>untrusted()</script></div>'
    const result = presentRenderedOutput(html, false)
    expect(result.text).toBe(`\`\`\`\`html\n${html}\n\`\`\`\``)
  })

  it.each(['think', 'thinking', 'Analysis', 'UpdateVariable', 'JSONPatch'])(
    '机读块 %s 包住 HTML 时开启或关闭交互卡都不泄漏', tag => {
      const rendered = `<${tag} data-note=">"><div>隐藏推理</div>尾部秘密</${tag}>可见答案`
      for (const allowHtml of [false, true]) {
        const result = presentRenderedOutput(rendered, allowHtml)
        expect(result.text).toBe('可见答案')
        expect(result.htmls).toEqual([])
        expect(JSON.stringify(result)).not.toContain('隐藏推理')
        expect(JSON.stringify(result)).not.toContain('尾部秘密')
      }
    },
  )

  it('HTML 内的机读块与注释在源码回退中隐藏，脚本字符串和合法卡面保持原样', () => {
    const rendered = '<div class="card">公开<Analysis>内部秘密</Analysis><!--注释秘密-->'
      + '<details><summary>线索</summary>可见内容</details>'
      + '<script>const literal = "<think>代码字面量</think>"</script></div>'
    const interactive = presentRenderedOutput(rendered, true)
    expect(interactive.htmls[0]).toContain('可见内容')
    expect(interactive.htmls[0]).toContain('<!--注释秘密-->')
    expect(interactive.htmls[0]).toContain('<think>代码字面量</think>')
    expect(JSON.stringify(interactive)).not.toContain('内部秘密')

    const disabled = presentRenderedOutput(rendered, false)
    expect(disabled.text).toContain('<details><summary>线索</summary>可见内容</details>')
    expect(disabled.text).toContain('<think>代码字面量</think>')
    expect(disabled.text).not.toContain('内部秘密')
    expect(disabled.text).not.toContain('注释秘密')
  })

  it('脚本文字中的畸形伪标签不妨碍脚本后的机读块收起', () => {
    const rendered = `<script>const x = "<foo q='";</script><think><div>SECRET</div>TAIL</think>VISIBLE`
    expect(stripOpaqueDisplayMeta(rendered)).toBe(`<script>const x = "<foo q='";</script>VISIBLE`)
    for (const allowHtml of [true, false]) {
      const result = presentRenderedOutput(rendered, allowHtml)
      expect(JSON.stringify(result)).not.toContain('SECRET')
      expect(JSON.stringify(result)).not.toContain('TAIL')
      expect(JSON.stringify(result)).toContain('VISIBLE')
    }
    expect(stripOpaqueDisplayMeta('<script>未闭合 <think>SECRET</think>VISIBLE'))
      .toBe('<script>未闭合 VISIBLE')
  })

  it('Markdown 邮箱与尖括号文本不被误认成不透明 HTML 元素', () => {
    for (const rendered of [
      'contact <script@example.com> <think><div>SECRET</div>TAIL</think>VISIBLE',
      'x < script> <think><div>SECRET</div>TAIL</think>VISIBLE',
    ]) {
      for (const allowHtml of [true, false]) {
        const result = presentRenderedOutput(rendered, allowHtml)
        expect(JSON.stringify(result)).not.toContain('SECRET')
        expect(JSON.stringify(result)).not.toContain('TAIL')
        expect(JSON.stringify(result)).toContain('VISIBLE')
      }
    }
  })

  it('嵌套与未闭合机读块按隐私优先隐藏到边界或文末', () => {
    expect(stripOpaqueDisplayMeta('<think><Analysis>秘密</Analysis><div>隐藏卡</div></think>公开')).toBe('公开')
    expect(presentRenderedOutput('开头<think><div>未闭合秘密</div>', false).text).toBe('开头')
    expect(stripOpaqueDisplayMeta('公开<think')).toBe('公开')
  })

  it('畸形尖括号不吞掉后续机读开标签', () => {
    for (const rendered of [
      'x < y <think><div>secret</div>tail</think> visible',
      'x <not q="unterminated <think><div>secret</div>tail</think> visible',
      '<think foo=<div>secret</div></think>visible',
    ]) {
      for (const allowHtml of [true, false]) {
        const result = presentRenderedOutput(rendered, allowHtml)
        expect(JSON.stringify(result)).not.toContain('secret')
        expect(JSON.stringify(result)).not.toContain('tail')
      }
    }
  })

  it('错序闭合保持尚未安全闭合的机读边界', () => {
    const rendered = '<think><Analysis>一</think>交叉泄漏</Analysis>公开'
    expect(stripOpaqueDisplayMeta(rendered)).toBe('')
    expect(JSON.stringify(presentRenderedOutput(rendered, true))).not.toContain('交叉泄漏')
    expect(JSON.stringify(presentRenderedOutput(rendered, false))).not.toContain('交叉泄漏')
  })

  it('完整 HTML 直接入口也先清理机读块', () => {
    const rendered = '<think><html><body>隐藏</body></html>尾部秘密</think>公开'
    expect(stripDisplayMeta(rendered)).toBe('公开')
  })

  it('大量短注释按单次线性扫描处理，后续机读块仍收起', () => {
    const comments = '<!---->'.repeat(20_000)
    expect(stripOpaqueDisplayMeta(`${comments}<think>SECRET</think>VISIBLE`)).toBe(`${comments}VISIBLE`)
  })

  it('无尖括号或实体候选的大段正文走零映射快速路径', () => {
    const plain = 'a'.repeat(1024 * 1024)
    expect(stripOpaqueDisplayMeta(plain)).toBe(plain)
  })

  it('大段正文末尾的单个 &amp; 不建立逐字符映射且原样保留', () => {
    const plain = `${'a'.repeat(1024 * 1024)}&amp;`
    const attributed = `<div data-note="${plain}">VISIBLE</div>`
    const started = performance.now()
    for (let run = 0; run < 3; run++) expect(stripOpaqueDisplayMeta(plain)).toBe(plain)
    expect(stripOpaqueDisplayMeta(attributed)).toBe(attributed)
    expect(performance.now() - started).toBeLessThan(300)
  })

  it('轻量预判后仍收起多层实体编码的机读标签', () => {
    const rendered = '&amp;amp;lt;think&amp;amp;gt;SECRET'
      + '&amp;amp;lt;&amp;amp;sol;think&amp;amp;gt;VISIBLE'
    expect(stripOpaqueDisplayMeta(rendered)).toBe('VISIBLE')
  })
})
