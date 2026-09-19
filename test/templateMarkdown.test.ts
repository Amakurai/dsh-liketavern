/**
 * 消息格式化替换回归：所有样例经真实隔离 worker + QuickJS，验证展示语义、代码/属性边界与尺寸安全。
 * 不在宿主线程调用 Markdown 库；期望来自手写业务样例，不依赖旧 Showdown 作为测试真源。
 */
import { describe, expect, it } from 'vitest'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { isolated } from '../src/node/isolated.js'

const context = (): TemplateContext => ({ variables: emptyTemplateScopes(), char: '记录员', user: '访客',
  card: {}, entries: [], presets: [], history: [], now: 1000, seed: 1, phase: 'render' })

async function format(...texts: string[]): Promise<string[]> {
  const result = await isolated('template', { texts: texts.map(text => `<%= ${JSON.stringify(text)} %>`), context: context() })
  return result.texts
}

describe('QuickJS 消息 Markdown', () => {
  it('基本段落保留精确常见输出，不附加末尾换行', async () => {
    expect(await format('**加粗**', '*斜体*', '__下划线__', '~~删除线~~', '普通文本', '_plain_', '___下划线___', '中文__划线__中文'))
      .toEqual(['<p><strong>加粗</strong></p>', '<p><em>斜体</em></p>', '<p><u>下划线</u></p>', '<p><del>删除线</del></p>', '<p>普通文本</p>',
        '<p>_plain_</p>', '<p><u>下划线</u></p>', '<p>中文<u>划线</u>中文</p>'])
  })

  it('单换行与表格继续展示，不生成标题或表头 ID', async () => {
    const [breaks, table, heading] = await format('第一行\n第二行', '| 姓名 | 状态 |\n|---|---|\n| 阿青 | ~~负伤~~ |', '# 城门')
    expect(breaks).toBe('<p>第一行<br />\n第二行</p>')
    expect(table).toContain('<table>')
    expect(table).toContain('<th>姓名</th>')
    expect(table).toContain('<td><del>负伤</del></td>')
    expect(table).not.toContain(' id=')
    expect(heading).toBe('<h1>城门</h1>')
  })

  it('emoji 名称转换，额外 ASCII 表情保持普通文本', async () => {
    expect(await format(':smile: :) :-) :D :unknown_emoji:')).toEqual(['<p>😄 :) :-) :D :unknown_emoji:</p>'])
  })

  it('两空格子列表保持嵌套；不会吞并后续顶级项目', async () => {
    const [list] = await format('- 外层\n  - 内层\n- 后项')
    expect(list).toBe('<ul>\n<li>外层\n<ul>\n<li>内层</li>\n</ul>\n</li>\n<li>后项</li>\n</ul>')
  })

  it('两空格有序和混合子列表保持嵌套，代码围栏仍按代码处理', async () => {
    const [ordered, mixed, code] = await format('1. 外层\n  1. 内层\n2. 后项', '1. 外层\n  - 内层\n2. 后项',
      '1. 外层\n\n  ```text\n  __代码__\n  ```')
    expect(ordered).toBe('<ol>\n<li>外层\n<ol>\n<li>内层</li>\n</ol>\n</li>\n<li>后项</li>\n</ol>')
    expect(mixed).toContain('<li>外层\n<ul>\n<li>内层</li>\n</ul>\n</li>')
    expect(code).toContain('<pre><code class="language-text">__代码__\n</code></pre>')
    expect(code).not.toContain('<u>')
  })

  it('有序列表缩进代码保留字面，退出列表后顶级段落及代码不被吸入', async () => {
    const [code, outside, wide] = await format('1. 外层\n\n      __代码__\n\n2. 后项',
      '1. 外层\n  1. 内层\n\n退出列表\n\n    __顶级代码__', '10. 外层\n  1. 内层\n11. 后项')
    expect(code).toContain('<pre><code>__代码__\n</code></pre>')
    expect(code).toContain('</li>\n<li>\n<p>后项</p>\n</li>')
    expect(code).not.toContain('<u>')
    expect(outside).toContain('</ol>\n<p>退出列表</p>\n<pre><code>__顶级代码__\n</code></pre>')
    expect(wide).toContain('<ol start="10">')
    expect(wide).toContain('<li>外层\n<ol>\n<li>内层</li>\n</ol>\n</li>')
    expect(wide).toContain('<li>后项</li>')
  })

  it('单词内下划线、HTML 属性及代码不参加下划线格式替换', async () => {
    const [words, html, inline, fenced] = await format('snake_case a__b__c',
      '<span data-name="__keep__">标签</span>', '`__代码__ :smile: ![图](image.png =100x200)`',
      '```html\n<span title="__keep__">__代码__</span>\n```')
    expect(words).toBe('<p>snake_case a__b__c</p>')
    expect(html).toContain('data-name="__keep__"')
    expect(inline).toContain('<code>__代码__ :smile: ![图](image.png =100x200)</code>')
    expect(fenced).toContain('<pre><code class="language-html">')
    expect(fenced).toContain('&lt;span title=&quot;__keep__&quot;&gt;__代码__&lt;/span&gt;')
    expect(fenced).not.toContain('<u>')
  })

  it('raw inline code 内的下划线、emoji、删除线和图片全部保留字面', async () => {
    const source = '<code title="x > __keep__">__代码__ :smile: ~~删除~~ ![图](image.png =100x200)</code>'
    expect(await format(source, '前 <CODE>__x__</CODE> 后')).toEqual([`<p>${source}</p>`, '<p>前 <CODE>__x__</CODE> 后</p>'])
  })

  it('大量未闭合 raw code 标记不会反复扫描没有闭标签的后缀', async () => {
    const source = '正文 ' + '<code>'.repeat(3000)
    const [output] = await format(source)
    expect(output).toBe(`<p>${source}</p>`)
  })

  it('保留原始 HTML 区块和脚本；格式化结果只作为 HTML 沙箱片段交付', async () => {
    const source = '<details><summary>标题</summary><div data-name="__keep__">内容</div></details>'
    const result = await isolated('template', { texts: [`<%= ${JSON.stringify(source)} %>`], context: context(), decorateOutput: true })
    expect(result.texts).toEqual([source])
    expect(result.parts[0]).toEqual([{ kind: 'html', text: source }])
    expect(await format('<script>const name="__keep__";</script>')).toEqual(['<script>const name="__keep__";</script>'])
  })

  it('图片数字尺寸、星号自适应及可选标题使用独立属性', async () => {
    expect(await format('![状态](image.png =100x200)', '![状态](image.png =*x200 "__标题__")', '![状态](image.png =100x*)'))
      .toEqual(['<p><img src="image.png" alt="状态" width="100" height="200" /></p>',
        '<p><img src="image.png" alt="状态" title="__标题__" width="auto" height="200" /></p>',
        '<p><img src="image.png" alt="状态" width="100" height="auto" /></p>'])
  })

  it('有界常用单位保留；非法尺寸不能注入属性或绕过图片 URL 校验', async () => {
    const [units, badSize, badProtocol, tooLarge] = await format('![图](image.png =50%x20px)',
      '![图](image.png =100x200onerror)', '![图](javascript:alert(1) =100x200)', '![图](image.png =1234567x200)')
    expect(units).toContain('width="50%" height="20px"')
    for (const output of [badSize, badProtocol, tooLarge]) expect(output).not.toContain('<img')
  })

  it('图片扩展不改普通链接、引用图片、转义图片或地址中合法括号', async () => {
    const [link, reference, escaped, nestedUrl] = await format('[说明](https://example.test/a__b "__标题__")',
      '![图][pic]\n\n[pic]: image.png "标题"', '\\![图](image.png =100x200)', '![图](https://example.test/a(b).png =100x200)')
    expect(link).toBe('<p><a href="https://example.test/a__b" title="__标题__">说明</a></p>')
    expect(reference).toContain('<img src="image.png" alt="图" title="标题" />')
    expect(escaped).not.toContain('<img')
    expect(nestedUrl).toContain('src="https://example.test/a(b).png"')
    expect(nestedUrl).toContain('width="100" height="200"')
  })

  it('引用尺寸同时支持完整、折叠和短引用图片，共用定义的普通链接不附加尺寸', async () => {
    const [full, collapsed, shortcut, mixed] = await format('![图][1]\n\n[1]: image.png =100x80',
      '![图][]\n\n[图]: image.png =*x80', '![图]\n\n[图]: image.png =100x* "标题"',
      '![图][1] [链接][1]\n\n[1]: https://example.test/a__b =100x80')
    expect(full).toBe('<p><img src="image.png" alt="图" width="100" height="80" /></p>')
    expect(collapsed).toContain('width="auto" height="80"')
    expect(shortcut).toContain('title="标题" width="100" height="auto"')
    expect(mixed).toContain('<a href="https://example.test/a__b">链接</a>')
    expect(mixed).not.toContain('<a width=')
  })

  it('引用定义位于列表或引用块、标题换行及重复定义时遵循首定义优先', async () => {
    const [quote, list, title, plainFirst, sizedFirst] = await format('> ![图][pic]\n>\n> [pic]: image.png =100x80',
      '- ![图][pic]\n\n  [pic]: image.png =100x80', '![图][pic]\n\n[pic]: image.png =100x80\n  "下一行标题"',
      '![图][pic]\n\n[pic]: plain.png\n[pic]: sized.png =100x80',
      '![图][pic]\n\n[pic]: sized.png =100x80\n[pic]: plain.png')
    for (const output of [quote, list]) expect(output).toContain('width="100" height="80"')
    expect(title).toContain('title="下一行标题"')
    expect(plainFirst).toContain('src="plain.png"')
    expect(plainFirst).not.toContain('width=')
    expect(sizedFirst).toContain('src="sized.png"')
    expect(sizedFirst).toContain('width="100"')
  })

  it('尺寸引用规则不处理代码或转义定义，不吞掉非法 URL 或尺寸正文', async () => {
    const [code, escaped, invalidUrl, invalidSize] = await format('```text\n[pic]: image.png =100x80\n```\n\n![图][pic]',
      '\\[pic]: image.png =100x80\n\n![图][pic]', '![图][pic]\n\n[pic]: javascript:alert(1) =100x80',
      '![图][pic]\n\n[pic]: image.png =100x80onerror')
    for (const output of [code, escaped, invalidUrl, invalidSize]) expect(output).not.toContain('<img')
    expect(code).toContain('[pic]: image.png =100x80')
    expect(invalidSize).toContain('=100x80onerror')
  })

  it('混合粗体、下划线与链接保留嵌套 token，不靠 HTML 替换', async () => {
    const [result] = await format('__外层 **粗体** [链接](/a__b)__')
    expect(result).toBe('<p><u>外层 <strong>粗体</strong> <a href="/a__b">链接</a></u></p>')
  })

  it('双/三下划线混用时只消费共同标记，不丢额外字面下划线', async () => {
    expect(await format('__x___', '___x__', '__a_ b__')).toEqual(['<p><u>x_</u></p>', '<p><u>_x</u></p>', '<p><u>a_ b</u></p>'])
  })
})
