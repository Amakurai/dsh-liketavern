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

  it('剥离行内未闭合/孤立纯样式标签，同时保留不安全标签及其匹配闭标签', () => {
    expect(normalizeHostMarkdown('<font color="#ff6699">「早上好！」')).toBe('「早上好！」')
    expect(normalizeHostMarkdown('「早上好！」</font>')).toBe('「早上好！」')
    expect(normalizeHostMarkdown('<span style="color:#88ccff">（未闭合内心独白）')).toBe('（未闭合内心独白）')
    expect(normalizeHostMarkdown('前缀</span>后缀')).toBe('前缀后缀')
    expect(normalizeHostMarkdown('<small>附注')).toBe('附注')
    expect(normalizeHostMarkdown('<span onclick="alert(1)"><span>内层</span>外层</span>'))
      .toBe('<span onclick="alert(1)">内层外层</span>')
    expect(normalizeHostMarkdown('<span onclick="alert(1)">未闭合危险')).toBe('<span onclick="alert(1)">未闭合危险')
    expect(normalizeHostMarkdown('<span id="mvu-anchor">锚点</span>')).toBe('<span id="mvu-anchor">锚点</span>')
  })

  it('支持同行尾随/未闭合标题、行内/未闭合 <center> 与 <p>/<hr> 组合，不触发 Setext 误判也不吞围栏', () => {
    // 同行标题后跟 <p>/<hr>/<br>/相邻标题/普通正文
    expect(normalizeHostMarkdown('<h3>标题</h3><p>正文</p>')).toBe('### 标题\n\n正文')
    expect(normalizeHostMarkdown('<h3>标题</h3><hr>')).toBe('### 标题\n\n---')
    expect(normalizeHostMarkdown('<h3>标题</h3><br>正文')).toBe('### 标题\n\n正文')
    expect(normalizeHostMarkdown('<h2>第一章</h2><h3>第一节</h3>')).toBe('## 第一章\n### 第一节')
    expect(normalizeHostMarkdown('<h3>标题</h3>正文')).toBe('### 标题\n正文')
    expect(normalizeHostMarkdown('<p><h3>包装标题</h3></p>')).toBe('### 包装标题')
    expect(normalizeHostMarkdown('<h2>\n  多行标题\n</h2><p>后文</p>')).toBe('## 多行标题\n\n后文')

    // 未闭合安全标题与空开标题不吞掉后续代码围栏
    const unclosedHeading = '<h3>角色档案\n```json\n{"hp":100}\n```'
    expect(md.render(unclosedHeading)).not.toContain('<pre><code class="language-json">')
    const normHeading = normalizeHostMarkdown(unclosedHeading)
    expect(normHeading).toBe('### 角色档案\n```json\n{"hp":100}\n```')
    expect(md.render(normHeading)).toContain('<h3>角色档案</h3>')
    expect(md.render(normHeading)).toContain('<pre><code class="language-json">')

    const emptyUnclosedHeading = '<h3>\n```json\n{"hp":100}\n```'
    expect(md.render(normalizeHostMarkdown(emptyUnclosedHeading))).toContain('<pre><code class="language-json">')
    expect(normalizeHostMarkdown('<h2 onclick="x()">危险</h2>')).toBe('<h2 onclick="x()">危险</h2>')
    expect(normalizeHostMarkdown('<h2 onclick="x()">未闭合危险')).toBe('<h2 onclick="x()">未闭合危险')

    // 行内/未闭合/孤立无属性 <center>，保留带属性 <center>
    expect(normalizeHostMarkdown('<center>标题</center><br>副标题')).toBe('标题  \n副标题')
    expect(normalizeHostMarkdown('<center><h3>序章</h3></center><hr>')).toBe('### 序章\n\n---')
    expect(normalizeHostMarkdown('<center>### 序章')).toBe('### 序章')
    expect(normalizeHostMarkdown('### 序章</center>')).toBe('### 序章')
    expect(normalizeHostMarkdown('<center style="color:red">保留样式</center>')).toBe('<center style="color:red">保留样式</center>')
    expect(normalizeHostMarkdown('<center onclick="x()">保留事件</center>')).toBe('<center onclick="x()">保留事件</center>')

    // 行首行内 <hr> 不把前一行变成 Setext 二级标题；不安全 <p onclick> 保留配对闭标签
    const inlineHrAfterText = '第一章正文\n<hr>第二章正文'
    const normHr = normalizeHostMarkdown(inlineHrAfterText)
    expect(normHr).toBe('第一章正文\n\n---\n\n第二章正文')
    expect(md.render(normHr)).not.toContain('<h2>')
    expect(md.render(normHr)).toContain('<hr />')
    expect(normalizeHostMarkdown('第一段\n<p>第二段</p>')).toBe('第一段\n\n第二段')
    expect(normalizeHostMarkdown('<p onclick="x()">危险</p>')).toBe('<p onclick="x()">危险</p>')
  })

  it('处理未闭合/孤立 <blockquote>、脱离列表容器的安全 <li> 以及孤立闭合块标签，防止吞掉代码围栏', () => {
    const unclosedQuote = '<blockquote>夜风很凉。\n```json\n{"hp":100}\n```'
    expect(md.render(unclosedQuote)).not.toContain('<pre><code class="language-json">')
    const normQuote = normalizeHostMarkdown(unclosedQuote)
    expect(normQuote).toBe('> 夜风很凉。\n\n```json\n{"hp":100}\n```')
    expect(md.render(normQuote)).toContain('<blockquote>\n<p>夜风很凉。</p>\n</blockquote>')
    expect(md.render(normQuote)).toContain('<pre><code class="language-json">')

    expect(normalizeHostMarkdown('前文\n<blockquote>\n台词一\n台词二\n\n后文')).toBe('前文\n> 台词一\n> 台词二\n\n后文')
    expect(normalizeHostMarkdown('<blockquote>\n```json\n{"a":1}\n```')).toBe('```json\n{"a":1}\n```')
    expect(normalizeHostMarkdown('</blockquote>\n```json\n{"a":1}\n```')).toBe('```json\n{"a":1}\n```')
    expect(normalizeHostMarkdown('<blockquote onclick="x()">保留</blockquote>')).toBe('<blockquote onclick="x()">保留</blockquote>')

    // 孤立 <li> 转为列表项，<ul>/<ol> 容器内的 <li> 保持不动
    const bareLi = '<li>第一项</li><li>第二项</li>\n<li>未闭合条目\n```json\n{"ok":true}\n```'
    const normLi = normalizeHostMarkdown(bareLi)
    expect(normLi).toBe('- 第一项\n- 第二项\n- 未闭合条目\n```json\n{"ok":true}\n```')
    expect(md.render(normLi)).toContain('<li>第一项</li>')
    expect(md.render(normLi)).toContain('<pre><code class="language-json">')
    expect(normalizeHostMarkdown('<ul>\n<li>保留在容器内</li>\n</ul>')).toBe('<ul>\n<li>保留在容器内</li>\n</ul>')
    expect(normalizeHostMarkdown('<li onclick="x()">保留事件</li>')).toBe('<li onclick="x()">保留事件</li>')

    // 孤立闭合块/格式标签不触发 CommonMark Type 6/7 吞掉围栏；成对标签与缩进代码保持不动
    for (const orphan of ['</div>', '</details>', '</summary>', '</section>', '</b>']) {
      const sample = `${orphan}\n\`\`\`json\n{"hp":100}\n\`\`\``
      expect(md.render(sample)).not.toContain('<pre><code class="language-json">')
      const out = normalizeHostMarkdown(sample)
      expect(out).toBe('```json\n{"hp":100}\n```')
      expect(md.render(out)).toContain('<pre><code class="language-json">')
    }
    expect(normalizeHostMarkdown('<div onclick="x()">\n内容\n</div>')).toBe('<div onclick="x()">\n内容\n</div>')
    expect(normalizeHostMarkdown('代码：\n\n    </div>\n    正文')).toBe('代码：\n\n    </div>\n    正文')
    expect(normalizeHostMarkdown('</script>\n正文')).toBe('</script>\n正文')
  })

  it('支持纯样式属性的 <b>/<i>/<s> 与对称嵌套 <i><b>...</b></i>，并在 CommonMark 下正确贴合渲染', () => {
    expect(normalizeHostMarkdown('<b style="color:#ff6699">重点</b>与<em class="note">旁白</em>与<del style="opacity:.6">旧值</del>'))
      .toBe('**重点**与*旁白*与~~旧值~~')
    expect(normalizeHostMarkdown('<strong style="color:gold">第一行\n第二行</strong>'))
      .toBe('**第一行**\n**第二行**')
    expect(normalizeHostMarkdown('<b onclick="x()">危险</b>')).toBe('<b onclick="x()">危险</b>')
    expect(normalizeHostMarkdown('<b id="anchor">锚点</b>')).toBe('<b id="anchor">锚点</b>')

    // <i><b> 与 <b><i> 对称，且紧邻汉字/英文单词均按三连星内层字符贴合
    expect(normalizeHostMarkdown('<i><b>加粗斜体</b></i>')).toBe('***加粗斜体***')
    expect(normalizeHostMarkdown('中文<i><b>加粗斜体</b></i>中文')).toBe('中文***加粗斜体***中文')
    expect(md.render(normalizeHostMarkdown('中文<i><b>加粗斜体</b></i>中文')))
      .toContain('中文<em><strong>加粗斜体</strong></em>中文')
    expect(normalizeHostMarkdown('foo<b><i>bar</i></b>baz')).toBe('foo***bar***baz')
    expect(md.render(normalizeHostMarkdown('foo<b><i>bar</i></b>baz')))
      .toContain('foo<em><strong>bar</strong></em>baz')
    expect(normalizeHostMarkdown('「<i><b>不要走。</b></i>」')).toBe('「***不要走。***」')
    expect(md.render(normalizeHostMarkdown('「<i><b>不要走。</b></i>」')))
      .toContain('「<em><strong>不要走。</strong></em>」')
    // 中文紧贴标点的三连星在纯 CommonMark 中无法闭合，保持保守不输出裸露 ***
    expect(normalizeHostMarkdown('中文<i><b>「不要走。」</b></i>中文')).not.toContain('***')
    expect(normalizeHostMarkdown('中文<b><i>「不要走。」</i></b>中文')).not.toContain('***')
  })

  it('支持含成对反引号的 <pre>/<code>/<kbd>、混合嵌套粗斜体、空自闭合结构标签与未闭合独占行格式开标签', () => {
    // 含成对反引号的 <pre>/<code>/<kbd> 正常转为围栏或行内代码，不因预掩码被跳过。
    expect(normalizeHostMarkdown('<pre>const s = `hello`;</pre>')).toBe('```\nconst s = `hello`;\n```')
    expect(normalizeHostMarkdown('<pre><code class="language-js">const s = `hello`;</code></pre>'))
      .toBe('```js\nconst s = `hello`;\n```')
    expect(normalizeHostMarkdown('<pre>\n```js\nconsole.log(1)\n```\n</pre>'))
      .toBe('````\n```js\nconsole.log(1)\n```\n````')
    expect(normalizeHostMarkdown('<code>a `b` c</code>')).toBe('``a `b` c``')
    expect(normalizeHostMarkdown('<kbd>`Ctrl`+`C`</kbd>')).toBe('`` `Ctrl`+`C` ``')
    // 含原始尖括号的反引号片段仍保守拒绝。
    expect(normalizeHostMarkdown('<code>`<script>`</code>')).toBe('<code>`<script>`</code>')

    // 混合嵌套粗斜体在 CommonMark 中按内层跨度贴合校验转换；中文无空格标点嵌套保守拒绝。
    expect(normalizeHostMarkdown('<b>加粗 <i>斜体</i> 文本</b>')).toBe('**加粗 *斜体* 文本**')
    expect(md.render(normalizeHostMarkdown('<b>加粗 <i>斜体</i> 文本</b>')))
      .toContain('<strong>加粗 <em>斜体</em> 文本</strong>')
    expect(normalizeHostMarkdown('<i>斜体 <b>加粗</b> 文本</i>')).toBe('*斜体 **加粗** 文本*')
    expect(md.render(normalizeHostMarkdown('<i>斜体 <b>加粗</b> 文本</i>')))
      .toContain('<em>斜体 <strong>加粗</strong> 文本</em>')
    expect(normalizeHostMarkdown('<b><i>斜体</i> 加粗</b>')).toBe('***斜体* 加粗**')
    expect(normalizeHostMarkdown('<b>加粗 <i>斜体</i></b>')).toBe('**加粗 *斜体***')
    expect(normalizeHostMarkdown('<i><b>加粗</b> 斜体</i>')).toBe('***加粗** 斜体*')
    expect(normalizeHostMarkdown('<i>斜体 <b>加粗</b></i>')).toBe('*斜体 **加粗***')
    expect(normalizeHostMarkdown('中文<b>加粗 <i>「斜体」</i> 文本</b>中文'))
      .toBe('中文**加粗 *「斜体」* 文本**中文')
    expect(normalizeHostMarkdown('中文<b>中文<i>「斜体」</i>中文</b>中文'))
      .toBe('中文<b>中文<i>「斜体」</i>中文</b>中文')
    expect(normalizeHostMarkdown('中文<i>中文<b>「加粗」</b>中文</i>中文')).not.toContain('*中文**')

    // 行内 <p/>、同行尾随未闭合标题、空自闭合结构容器、孤立独占行 <b> 与退出引用块的双 <br>。
    expect(normalizeHostMarkdown('前文<p/>后文')).toBe('前文\n\n后文')
    expect(normalizeHostMarkdown('<h3>标题</h3><h3>未闭合标题')).toBe('### 标题\n### 未闭合标题')
    expect(normalizeHostMarkdown('> 第一行<br><br>\n普通正文')).toBe('> 第一行\n\n普通正文')
    for (const sample of [
      '前文\n<div/>\n```json\n{"a":1}\n```',
      '前文\n<section class="gap"/>\n```json\n{"a":1}\n```',
      '<b>\n```json\n{"a":1}\n```',
    ]) {
      const out = normalizeHostMarkdown(sample)
      expect(md.render(out)).toContain('<pre><code class="language-json">')
    }
    // 成对跨行未转换 <b> 与带事件自闭合 <div onclick=.../> 原样保留。
    expect(normalizeHostMarkdown('<b>\n- 列表一\n</b>')).toBe('<b>\n- 列表一\n</b>')
    expect(normalizeHostMarkdown('前文\n<div onclick="x()"/>\n后文')).toBe('前文\n<div onclick="x()"/>\n后文')
  })
})
