/**
 * 宿主 `MarkdownText` 展示归一化测试：
 * 验证酒馆角色卡与展示正则中常见的安全 HTML 标签可被转为纯净 Markdown，
 * 在 CommonMark 下正确渲染且不触发 Type 6/7 HTML 块吞掉代码围栏，同时严格保护代码区间与拒绝不安全属性。
 */
import MarkdownIt from 'markdown-it'
import { describe, expect, it } from 'vitest'
import { normalizeHostMarkdown } from '../src/core/hostMarkdown.js'

const md = new MarkdownIt('commonmark')

describe('normalizeHostMarkdown', () => {
  it('转换行内、引用内、连续、独立与表格内的 <br>，不吞掉后续代码围栏也不破坏 GFM 表格', () => {
    expect(normalizeHostMarkdown('第一行<br>第二行')).toBe('第一行  \n第二行')
    expect(md.render(normalizeHostMarkdown('第一行<br/>第二行'))).toContain('第一行<br />\n第二行')

    expect(normalizeHostMarkdown('> 契约者: 希尔薇<br/>契约状态: 稳定')).toBe('> 契约者: 希尔薇  \n> 契约状态: 稳定')
    expect(md.render(normalizeHostMarkdown('> 契约者: 希尔薇<br/>契约状态: 稳定')))
      .toContain('<blockquote>\n<p>契约者: 希尔薇<br />\n契约状态: 稳定</p>\n</blockquote>')

    expect(normalizeHostMarkdown('第一段<br><br>第二段')).toBe('第一段\n\n第二段')
    expect(normalizeHostMarkdown('第一行<br>\n第二行')).toBe('第一行  \n第二行')
    expect(normalizeHostMarkdown('结尾行<br>')).toBe('结尾行')

    const brBeforeFence = '角色状态\n\n<br>\n```json\n{"hp": 100}\n```'
    expect(md.render(brBeforeFence)).not.toContain('<pre><code class="language-json">')
    const normalizedFence = normalizeHostMarkdown(brBeforeFence)
    expect(md.render(normalizedFence)).toContain('<pre><code class="language-json">')

    const table = [
      '| 技能 | 效果 |',
      '| --- | --- |',
      '| 火球术 | 造成火焰伤害<br>附加灼烧 |',
      '| 护盾 | 吸收伤害<br/><br/>持续两回合 |',
    ].join('\n')
    expect(normalizeHostMarkdown(table)).toBe([
      '| 技能 | 效果 |',
      '| --- | --- |',
      '| 火球术 | 造成火焰伤害 附加灼烧 |',
      '| 护盾 | 吸收伤害 持续两回合 |',
    ].join('\n'))
  })

  it('将 <hr> 转为带空行分隔的分割线，不把前一行变成 Setext 二级标题', () => {
    const raw = '第一章正文\n<hr>\n第二章正文'
    const out = normalizeHostMarkdown(raw)
    expect(out).toBe('第一章正文\n\n---\n\n第二章正文')
    const html = md.render(out)
    expect(html).toContain('<p>第一章正文</p>')
    expect(html).toContain('<hr />')
    expect(html).not.toContain('<h2>')

    expect(normalizeHostMarkdown('上文<hr style="border-color:red"/>下文')).toBe('上文\n\n---\n\n下文')
  })

  it('只将安全的 http(s) <img> 转为 Markdown 图片语法，拒绝危险协议与事件属性', () => {
    expect(normalizeHostMarkdown('<img src="https://cdn.example.com/cg(1).png?a=1&amp;b=2" alt="立绘 [正面]">'))
      .toBe('![立绘 \\[正面\\]](https://cdn.example.com/cg%281%29.png?a=1&b=2)')
    expect(normalizeHostMarkdown('<img src="http://example.com/a.jpg" />'))
      .toBe('![](http://example.com/a.jpg)')

    const tableImg = '| 头像 | 名称 |\n| --- | --- |\n| <img src="https://example.com/a|b.png" alt="A|B"> | 希尔薇 |'
    expect(normalizeHostMarkdown(tableImg))
      .toBe('| 头像 | 名称 |\n| --- | --- |\n| ![A\\|B](https://example.com/a%7Cb.png) | 希尔薇 |')

    for (const unsafe of [
      '<img src="javascript:alert(1)" alt="x">',
      '<img src="data:image/png;base64,AA==" alt="x">',
      '<img src="/local/path.png" alt="x">',
      '<img src="https://example.com/a.png" onerror="alert(1)">',
    ]) {
      expect(normalizeHostMarkdown(unsafe)).toBe(unsafe)
    }
  })

  it('剥离纯样式 <font> 与 <span> 外壳并释放被吞的代码围栏，保留带事件或功能属性的标签', () => {
    expect(normalizeHostMarkdown('<font color="#ff6699">「早上好！」</font>')).toBe('「早上好！」')
    expect(normalizeHostMarkdown('<span style="color: #88ccff">（她轻轻叹了口气）</span>')).toBe('（她轻轻叹了口气）')

    const fontWrappedFence = '<font color="gold">\n```json\n{"quest": 1}\n```\n</font>'
    expect(md.render(fontWrappedFence)).not.toContain('<pre><code class="language-json">')
    const unwrapped = normalizeHostMarkdown(fontWrappedFence)
    expect(unwrapped).toBe('```json\n{"quest": 1}\n```')
    expect(md.render(unwrapped)).toContain('<pre><code class="language-json">')

    // 跨 HTML 卡片拆分后留下的孤立独占行 <font> / </font> 也要剥离，防止吞掉后续围栏。
    const orphanFont = '<font color="gold">\n```json\n{"lv": 2}\n```'
    expect(md.render(normalizeHostMarkdown(orphanFont))).toContain('<pre><code class="language-json">')

    expect(normalizeHostMarkdown('<span onclick="alert(1)">危险</span>')).toBe('<span onclick="alert(1)">危险</span>')
    expect(normalizeHostMarkdown('<span id="mvu-anchor">锚点</span>')).toBe('<span id="mvu-anchor">锚点</span>')
  })

  it('转换无属性 <center>、<p>、<h1>-<h6> 与 <blockquote>，避免引用懒延续吞掉后文', () => {
    expect(normalizeHostMarkdown('<center>\n### 第一章：星港\n</center>')).toBe('### 第一章：星港')
    expect(normalizeHostMarkdown('<center>**序章**</center>')).toBe('**序章**')
    expect(normalizeHostMarkdown('<p>第一段<br>续行</p><p>第二段</p>')).toBe('第一段  \n续行\n\n第二段')
    expect(normalizeHostMarkdown('<h3><font color="gold"><b>状态摘要</b></font></h3>')).toBe('### **状态摘要**')
    expect(normalizeHostMarkdown('<h2 align="center">序章</h2>')).toBe('## 序章')

    const quoted = '前文\n<blockquote>「夜风很凉。」</blockquote>\n后文'
    const normalizedQuote = normalizeHostMarkdown(quoted)
    expect(normalizedQuote).toBe('前文\n> 「夜风很凉。」\n\n后文')
    const html = md.render(normalizedQuote)
    expect(html).toContain('<blockquote>\n<p>「夜风很凉。」</p>\n</blockquote>\n<p>后文</p>')
  })

  it('按 CommonMark 与 CJK 贴合规则转换 <b>/<i>/<s>，不产生裸露星号', () => {
    expect(normalizeHostMarkdown('<b> 重点 </b>与<strong>提示</strong>')).toBe(' **重点** 与**提示**')
    expect(normalizeHostMarkdown('她轻声道：<b>「不要走。」</b>然后转身')).toBe('她轻声道：**「不要走。」**然后转身')
    expect(normalizeHostMarkdown('<b><i>加粗斜体</i></b>')).toBe('***加粗斜体***')
    expect(normalizeHostMarkdown('「<i>不要走。</i>」')).toBe('「*不要走。*」')
    expect(normalizeHostMarkdown('原价 <s>100</s> <del>80</del> 现价 50')).toBe('原价 ~~100~~ ~~80~~ 现价 50')

    // 宿主 cjkFriendlyStrong 仅对 ** 生效，单 * 在中文+标点紧贴字时无法闭合，必须保持原样不输出坏星号。
    expect(normalizeHostMarkdown('她轻声道：<i>「不要走。」</i>然后转身')).toBe('她轻声道：<i>「不要走。」</i>然后转身')
    expect(normalizeHostMarkdown('中文<i>`code`</i>中文')).toBe('中文<i>`code`</i>中文')
  })

  it('严格保护围栏代码、流式未闭合围栏、行内代码与缩进代码块，但不误跳列表续行', () => {
    const protectedSamples = [
      '```html\n<font color="red"><b>示例</b><br><img src="https://example.com/a.png"></font>\n```',
      '```html\n未闭合流式围栏<br><b>保持原样</b>',
      '行内代码 `<br>` 与 `<font color="red">文本</font>` 保持原样',
      '代码示例：\n\n    第一行<br>第二行\n    <b>代码</b>',
    ]
    for (const sample of protectedSamples) {
      expect(normalizeHostMarkdown(sample)).toBe(sample)
    }

    // 列表项内 4 空格续行不是缩进代码块，应照常转换 <br>。
    expect(normalizeHostMarkdown('- 列表项\n    第一行<br>第二行')).toBe('- 列表项\n    第一行  \n第二行')
  })

  it('支持 <center> 嵌套标题、多行标题、含 <br> 的粗斜体、注音、安全链接、行首 <br> 与修饰壳', () => {
    const md = new MarkdownIt('commonmark')

    // <center> 先于 h1-h6 剥离，避免残留原始 <h2>；多行标题折合后不吞掉紧随代码围栏。
    expect(normalizeHostMarkdown('<center><h2>第一章</h2></center>')).toBe('## 第一章')
    expect(normalizeHostMarkdown('<center>\n<h2>第一章</h2>\n</center>')).toBe('## 第一章')
    const multilineHeading = '<h2 align="center">\n  序章：星港\n</h2>\n```json\n{"a":1}\n```'
    const normalizedHeading = normalizeHostMarkdown(multilineHeading)
    expect(normalizedHeading).toBe('## 序章：星港\n```json\n{"a":1}\n```')
    expect(md.render(normalizedHeading)).toContain('<h2>序章：星港</h2>')
    expect(md.render(normalizedHeading)).toContain('<pre><code class="language-json">')

    // <b>/<i> 内包含安全 <br> 时按段拆分包裹，适配普通段落、引用块与 GFM 表格。
    expect(normalizeHostMarkdown('<b>第一行<br>第二行</b>')).toBe('**第一行**  \n**第二行**')
    expect(normalizeHostMarkdown('<i>第一行<br/>第二行</i>')).toBe('*第一行*  \n*第二行*')
    expect(normalizeHostMarkdown('<b>第一行<br><br>第二行</b>')).toBe('**第一行**\n\n**第二行**')
    expect(normalizeHostMarkdown('> <b>第一行<br>第二行</b>')).toBe('> **第一行**  \n> **第二行**')
    expect(normalizeHostMarkdown('| 标题 | 值 |\n| --- | --- |\n| <b>第一行<br>第二行</b> | 100 |'))
      .toBe('| 标题 | 值 |\n| --- | --- |\n| **第一行** **第二行** | 100 |')
    expect(normalizeHostMarkdown('<b>A<br onclick="x">B</b>')).toBe('<b>A<br onclick="x">B</b>')

    // <ruby> 注音、安全 http(s) <a> 链接及 <small>/<mark>/<u> 纯样式外壳。
    expect(normalizeHostMarkdown('<ruby>星辰<rp>(</rp><rt>ほし</rt><rp>)</rp></ruby>')).toBe('星辰(ほし)')
    expect(normalizeHostMarkdown('<span style="color:gold"><ruby>星辰<rt>ほし</rt></ruby></span>')).toBe('星辰(ほし)')
    expect(normalizeHostMarkdown('<ruby>星辰<rp onclick="x">(</rp><rt>ほし</rt><rp>)</rp></ruby>'))
      .toBe('<ruby>星辰<rp onclick="x">(</rp><rt>ほし</rt><rp>)</rp></ruby>')
    expect(normalizeHostMarkdown('<a href="https://example.com/a(1)" target="_blank">图鉴</a>'))
      .toBe('[图鉴](https://example.com/a%281%29)')
    expect(normalizeHostMarkdown('| 资料 | 说明 |\n| --- | --- |\n| <a href="https://example.com/a|b">A|B</a> | ok |'))
      .toBe('| 资料 | 说明 |\n| --- | --- |\n| [A\\|B](https://example.com/a%7Cb) | ok |')
    expect(normalizeHostMarkdown('<a href="javascript:alert(1)">危险</a>')).toBe('<a href="javascript:alert(1)">危险</a>')
    expect(normalizeHostMarkdown('<a href="https://example.com" onclick="x()">危险</a>'))
      .toBe('<a href="https://example.com" onclick="x()">危险</a>')
    expect(normalizeHostMarkdown('<small>附注</small> <mark>高亮</mark> <u>强调</u>')).toBe('附注 高亮 强调')
    expect(normalizeHostMarkdown('<u onclick="x()">保留</u>')).toBe('<u onclick="x()">保留</u>')

    // 行首与引用首部 <br> 不输出带两个前导空格的空行。
    expect(normalizeHostMarkdown('<br>正文\n> <br>引用正文')).toBe('\n正文\n>\n> 引用正文')
  })

  it('支持 <pre>/<code>/<kbd>、URL 空格、链接包粗体/图片与跨行粗斜删除线', () => {
    const md = new MarkdownIt('commonmark')

    // <pre> 与 <pre><code> 转为围栏代码块，内部实体解码且后续 pass 不改写内部标签。
    expect(normalizeHostMarkdown('<pre>状态面板\nHP: 100 / 100</pre>')).toBe('```\n状态面板\nHP: 100 / 100\n```')
    const preCode = normalizeHostMarkdown('<pre><code class="language-ts">const ok = a &lt; b;\n// ```keep\n</code></pre>')
    expect(preCode).toBe('````ts\nconst ok = a < b;\n// ```keep\n````')
    expect(md.render(preCode)).toContain('<pre><code class="language-ts">')
    expect(normalizeHostMarkdown('<pre onclick="x()">保留</pre>')).toBe('<pre onclick="x()">保留</pre>')

    // 行内 <code>/<kbd> 转为反引号代码并受 mask 保护（<code>&lt;br&gt;</code> 不触发 Pass 5）。
    expect(normalizeHostMarkdown('使用 <code>/help</code> 或 <kbd>Enter</kbd> 继续')).toBe('使用 `/help` 或 `Enter` 继续')
    expect(normalizeHostMarkdown('<b>使用 <code>/help</code></b>')).toBe('**使用 `/help`**')
    expect(normalizeHostMarkdown('标签 <code>&lt;br&gt;</code> 与 <code>a`b</code>')).toBe('标签 `<br>` 与 ``a`b``')
    expect(normalizeHostMarkdown('| 命令 | 说明 |\n| --- | --- |\n| <code>a|b</code> | 管道 |'))
      .toBe('| 命令 | 说明 |\n| --- | --- |\n| `a\\|b` | 管道 |')

    // 含空格的 http(s) 图片/链接 URL、<a> 包裹粗体与图片链接。
    expect(normalizeHostMarkdown('<img src="https://example.com/my image.png" alt="立绘">'))
      .toBe('![立绘](https://example.com/my%20image.png)')
    expect(normalizeHostMarkdown('<a href="https://example.com/my page"><b>查看图鉴</b></a>'))
      .toBe('[**查看图鉴**](https://example.com/my%20page)')
    expect(normalizeHostMarkdown('<a href="https://example.com"><img src="https://example.com/a.png" alt="封面"></a>'))
      .toBe('[![封面](https://example.com/a.png)](https://example.com)')

    // 跨行 <i>/<b>/<s> 按行包裹，跨空行分段与引用块内同样保持合法，含列表块标记时保守跳过。
    expect(normalizeHostMarkdown('<i>「我在这里等了很久了。」\n她抬起头，看着远方的灯塔。</i>'))
      .toBe('*「我在这里等了很久了。」*\n*她抬起头，看着远方的灯塔。*')
    expect(normalizeHostMarkdown('<b>警告：\n\n当前区域处于高危状态。</b>'))
      .toBe('**警告：**\n\n**当前区域处于高危状态。**')
    expect(normalizeHostMarkdown('> <s>旧记录第一行\n> 旧记录第二行</s>'))
      .toBe('> ~~旧记录第一行~~\n> ~~旧记录第二行~~')
    expect(normalizeHostMarkdown('<b>- 列表一\n- 列表二</b>')).toBe('<b>- 列表一\n- 列表二</b>')
  })
})
