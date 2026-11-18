/**
 * 纯文本/Markdown `<details>` 折叠块解析测试：
 * 验证无脚本/样式的折叠块结构提取、公共缩进剥离、嵌套 `<details>`、实体解码，
 * 以及包含任意其它 HTML、样式或事件属性时严格回退 `null` 的安全边界。
 */
import { describe, expect, it } from 'vitest'
import { formatPlainDetailsText, isPlainDetailsHtml, parsePlainDetailsBlocks } from '../src/core/plainDetails.js'

describe('parsePlainDetailsBlocks', () => {
  it('解析单个与连续多个纯文本/Markdown 折叠块', () => {
    const single = '<details><summary>____------妖精契约------____</summary>\n>契约者: 希尔薇\n</details>'
    expect(parsePlainDetailsBlocks(single)).toEqual([
      {
        open: false,
        summary: '____------妖精契约------____',
        children: [{ kind: 'markdown', text: '>契约者: 希尔薇' }],
      },
    ])
    expect(isPlainDetailsHtml(single)).toBe(true)

    const five = Array.from({ length: 5 }, (_, index) =>
      `<details><summary>条目 ${index + 1}</summary>\n\`\`\`json\n{"idx": ${index}}\n\`\`\`\n</details>`,
    ).join('\n')
    const parsed = parsePlainDetailsBlocks(five)
    expect(parsed).toHaveLength(5)
    expect(parsed?.[4]).toEqual({
      open: false,
      summary: '条目 5',
      children: [{ kind: 'markdown', text: '```json\n{"idx": 4}\n```' }],
    })
  })

  it('支持 open 布尔属性、省略 summary、空 summary 与实体一次解码', () => {
    expect(parsePlainDetailsBlocks('<details open><summary>A &amp; B &lt;1&gt; &#39;ok&#39; &amp;lt;</summary>\n内容\n</details>')).toEqual([
      {
        open: true,
        summary: "A & B <1> 'ok' &lt;",
        children: [{ kind: 'markdown', text: '内容' }],
      },
    ])
    expect(parsePlainDetailsBlocks('<details open="open">\n无标题内容\n</details>')).toEqual([
      {
        open: true,
        summary: null,
        children: [{ kind: 'markdown', text: '无标题内容' }],
      },
    ])
    expect(parsePlainDetailsBlocks('<details><summary>   </summary></details>')).toEqual([
      {
        open: false,
        summary: '',
        children: [],
      },
    ])
  })

  it('剥离 HTML 习惯的公共缩进，同时保留内部围栏代码与嵌套纯折叠块', () => {
    const indented = [
      '<details>',
      '    <summary>嵌套状态</summary>',
      '    第一行<br/>第二行',
      '    <status1>',
      '    ```json',
      '    {"hp": 10}',
      '    ```',
      '    </status1>',
      '    <details open>',
      '      <summary>子项</summary>',
      '      > 引用说明',
      '      <UpdateVariable>hidden</UpdateVariable>',
      '    </details>',
      '</details>',
    ].join('\n')

    expect(parsePlainDetailsBlocks(indented)).toEqual([
      {
        open: false,
        summary: '嵌套状态',
        children: [
          {
            kind: 'markdown',
            text: '第一行\n第二行\n\n```json\n{"hp": 10}\n```',
          },
          {
            kind: 'details',
            block: {
              open: true,
              summary: '子项',
              children: [{ kind: 'markdown', text: '> 引用说明' }],
            },
          },
        ],
      },
    ])
  })

  it('代码块与行内代码内的 HTML 标签示例不影响原生折叠识别，自动链接照常保留', () => {
    const sample = [
      '<details><summary>用法示例</summary>',
      '参考 `<div class="x">` 与 <https://example.com>',
      '```html',
      '<div class="card"><script>alert(1)</script></div>',
      '```',
      '</details>',
    ].join('\n')
    expect(parsePlainDetailsBlocks(sample)).toEqual([
      {
        open: false,
        summary: '用法示例',
        children: [
          {
            kind: 'markdown',
            text: '参考 `<div class="x">` 与 <https://example.com>\n```html\n<div class="card"><script>alert(1)</script></div>\n```',
          },
        ],
      },
    ])
  })

  it.each([
    '<details class="card"><summary>标题</summary>内容</details>',
    '<details style="color:red"><summary>标题</summary>内容</details>',
    '<details onclick="alert(1)"><summary>标题</summary>内容</details>',
    '<details open="false"><summary>标题</summary>内容</details>',
    '<details><summary style="color:red">标题</summary>内容</details>',
    '<details><summary><b>加粗标题</b></summary>内容</details>',
    '<details><summary>标题</summary><div class="content">内容</div></details>',
    '<details><summary>标题</summary><p>段落</p></details>',
    '<details><summary>标题</summary><style>.x{}</style>内容</details>',
    '<details><summary>标题</summary><script>alert(1)</script></details>',
    '<details><summary>标题</summary><br class="sep"/>内容</details>',
    '<details><summary>标题</summary>行内 <my-widget>内容</my-widget></details>',
    '<details><summary>标题</summary><!-- 未闭合注释</details>',
    '<details><summary>标题</summary>内容</details>\n<div>相邻卡片</div>',
    '前置文字\n<details><summary>标题</summary>内容</details>',
  ])('含样式/脚本/属性/HTML 或混杂顶层内容时严格返回 null：%s', html => {
    expect(parsePlainDetailsBlocks(html)).toBeNull()
    expect(isPlainDetailsHtml(html)).toBe(false)
  })
})

describe('formatPlainDetailsText', () => {
  it('按标题、正文、<br> 换行与嵌套折叠展开纯文本，空块跳过', () => {
    const html = [
      '<details><summary>____------妖精契约------____</summary>',
      '第一行<br/>第二行',
      '<details><summary>子项</summary>> 引用说明</details>',
      '</details>',
      '<details>无标题内容</details>',
      '<details><summary>   </summary></details>',
    ].join('\n')
    const blocks = parsePlainDetailsBlocks(html)
    expect(blocks).not.toBeNull()
    expect(formatPlainDetailsText(blocks!)).toBe([
      '____------妖精契约------____',
      '第一行\n第二行',
      '子项\n> 引用说明',
    ].join('\n') + '\n\n无标题内容')
  })
})
