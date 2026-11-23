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

  it('未闭合 <summary> 在首个空行处切分摘要与正文，并兼容 CRLF、缩进、兄弟块、嵌套块与实体解码', () => {
    const issue31 = [
      '<details>',
      '<summary>你可以从列表中选择一个家庭和地区，或者你可能希望出生在一个与列表中的任何角色都无关的随机家庭中。',
      '',
      '### 中央大陆，菲托亚领地，布耶纳村：',
      '1. 鲁迪乌斯·格雷拉特。……',
      '2. 希露菲叶特。……',
      '</details>',
    ].join('\n')
    expect(parsePlainDetailsBlocks(issue31)).toEqual([
      {
        open: false,
        summary: '你可以从列表中选择一个家庭和地区，或者你可能希望出生在一个与列表中的任何角色都无关的随机家庭中。',
        children: [
          {
            kind: 'markdown',
            text: '### 中央大陆，菲托亚领地，布耶纳村：\n1. 鲁迪乌斯·格雷拉特。……\n2. 希露菲叶特。……',
          },
        ],
      },
    ])
    expect(isPlainDetailsHtml(issue31)).toBe(true)

    const crlfIndented = [
      '<details open>',
      '    <summary>A &amp; B &lt;选择&gt;',
      '  \t  ',
      '    ### 区域',
      '    1. 第一项<br/>补充说明',
      '    参考 `<div class="x">` 与 <https://example.com>',
      '    <UpdateVariable>hidden</UpdateVariable>',
      '</details>',
    ].join('\r\n')
    expect(parsePlainDetailsBlocks(crlfIndented)).toEqual([
      {
        open: true,
        summary: 'A & B <选择>',
        children: [
          {
            kind: 'markdown',
            text: '### 区域\r\n1. 第一项\n补充说明\r\n参考 `<div class="x">` 与 <https://example.com>',
          },
        ],
      },
    ])

    // 紧跟另一个闭合/未闭合 <details> 或内含嵌套 <details> 时，不能误把后续块的 </summary> 当作本块闭合
    const siblingAndNested = [
      '<details>',
      '<summary>外层未闭合标题',
      '',
      '导语说明',
      '<details>',
      '<summary>内层正常标题</summary>',
      '内层正文',
      '</details>',
      '</details>',
      '<details>',
      '<summary>第二个块',
      '',
      '第二段正文',
      '</details>',
    ].join('\n')
    expect(parsePlainDetailsBlocks(siblingAndNested)).toEqual([
      {
        open: false,
        summary: '外层未闭合标题',
        children: [
          { kind: 'markdown', text: '导语说明' },
          {
            kind: 'details',
            block: {
              open: false,
              summary: '内层正常标题',
              children: [{ kind: 'markdown', text: '内层正文' }],
            },
          },
        ],
      },
      {
        open: false,
        summary: '第二个块',
        children: [{ kind: 'markdown', text: '第二段正文' }],
      },
    ])

    // 正常闭合且含空行的 <summary> 维持原样，未闭合摘要内的反引号也不污染正文代码扫描
    expect(parsePlainDetailsBlocks('<details><summary>第一行\n\n第二行</summary>\n正文\n</details>')).toEqual([
      {
        open: false,
        summary: '第一行\n\n第二行',
        children: [{ kind: 'markdown', text: '正文' }],
      },
    ])
    expect(parsePlainDetailsBlocks('<details>\n<summary>\n换行标题\n\n正文内容\n</details>')).toEqual([
      {
        open: false,
        summary: '换行标题',
        children: [{ kind: 'markdown', text: '正文内容' }],
      },
    ])
    expect(parsePlainDetailsBlocks('<details>\n<summary>命令 `help\n\n参考 `<div class="demo">` 写法\n</details>')).toEqual([
      {
        open: false,
        summary: '命令 `help',
        children: [{ kind: 'markdown', text: '参考 `<div class="demo">` 写法' }],
      },
    ])
  })

  it('支持无属性 <hr>、GFM 表格内 <br>、摘要自动链接/行内代码/注释/常见实体、泛型与引用块包裹折叠', () => {
    const hrSample = '<details><summary>章节 &mdash; 启程 &hellip; &starf;</summary>\n第一章\n<hr/>\n第二章\n</details>'
    expect(parsePlainDetailsBlocks(hrSample)).toEqual([
      {
        open: false,
        summary: '章节 — 启程 … ★',
        children: [{ kind: 'markdown', text: '第一章\n\n---\n\n第二章' }],
      },
    ])

    const tableSample = [
      '<details><summary>技能一览</summary>',
      '| 技能 | 说明 |',
      '| --- | --- |',
      '| 火球术 | 火焰伤害<br/>附加灼烧 |',
      '',
      '备注第一行<br/>备注第二行',
      '</details>',
    ].join('\n')
    expect(parsePlainDetailsBlocks(tableSample)).toEqual([
      {
        open: false,
        summary: '技能一览',
        children: [{
          kind: 'markdown',
          text: '| 技能 | 说明 |\n| --- | --- |\n| 火球术 | 火焰伤害 附加灼烧 |\n\n备注第一行\n备注第二行',
        }],
      },
    ])

    // 摘要中允许自动链接、配对行内代码与闭合注释（闭合和未闭合摘要均生效）。
    expect(parsePlainDetailsBlocks('<details><summary>文档 <https://example.com> `<div>` <!-- note --></summary>\n类型 Array<string>\n</details>')).toEqual([
      {
        open: false,
        summary: '文档 <https://example.com> `<div>`',
        children: [{ kind: 'markdown', text: '类型 Array<string>' }],
      },
    ])
    expect(parsePlainDetailsBlocks('<details>\n<summary>参考 `<code>` 与 <https://example.com>\n\n正文内容\n</details>')).toEqual([
      {
        open: false,
        summary: '参考 `<code>` 与 <https://example.com>',
        children: [{ kind: 'markdown', text: '正文内容' }],
      },
    ])

    // 引用块整块包裹 <details> 时剥离外层 > 前缀并保留内层引用。
    const blockquoted = [
      '<details>',
      '> <summary>背景设定</summary>',
      '>',
      '> ### 中央大陆',
      '> > 角色独白',
      '> </details>',
    ].join('\n')
    expect(parsePlainDetailsBlocks(blockquoted)).toEqual([
      {
        open: false,
        summary: '背景设定',
        children: [{ kind: 'markdown', text: '### 中央大陆\n> 角色独白' }],
      },
    ])
  })

  it('未闭合 <summary> 无空行紧跟 Markdown 块、嵌套折叠、<hr>/<br> 或伪标签时准确切分摘要与正文', () => {
    // 紧跟标题、有序/无序列表、引用块、分隔线、GFM 表格、缩进正文与引用包裹折叠
    expect(parsePlainDetailsBlocks([
      '<details>',
      '<summary>点击查看出生地列表',
      '### 中央大陆，菲托亚领地，布耶纳村：',
      '1. 鲁迪乌斯·格雷拉特',
      '</details>',
    ].join('\n'))).toEqual([{
      open: false,
      summary: '点击查看出生地列表',
      children: [{ kind: 'markdown', text: '### 中央大陆，菲托亚领地，布耶纳村：\n1. 鲁迪乌斯·格雷拉特' }],
    }])

    expect(parsePlainDetailsBlocks('<details>\n<summary>可选出生地\n1. 布耶纳村\n2. 罗亚\n</details>')).toEqual([{
      open: false,
      summary: '可选出生地',
      children: [{ kind: 'markdown', text: '1. 布耶纳村\n2. 罗亚' }],
    }])

    expect(parsePlainDetailsBlocks('<details>\n<summary>可选人物\n- 鲁迪乌斯\n- 希露菲\n</details>')).toEqual([{
      open: false,
      summary: '可选人物',
      children: [{ kind: 'markdown', text: '- 鲁迪乌斯\n- 希露菲' }],
    }])

    expect(parsePlainDetailsBlocks('<details>\n<summary>妖精契约\n>契约者: 希尔薇\n</details>')).toEqual([{
      open: false,
      summary: '妖精契约',
      children: [{ kind: 'markdown', text: '>契约者: 希尔薇' }],
    }])

    expect(parsePlainDetailsBlocks('<details>\n<summary>背景设定\n---\n这里是正文\n</details>')).toEqual([{
      open: false,
      summary: '背景设定',
      children: [{ kind: 'markdown', text: '---\n这里是正文' }],
    }])

    expect(parsePlainDetailsBlocks([
      '<details>',
      '    <summary>技能一览',
      '    | 技能 | 说明 |',
      '    | --- | --- |',
      '    | 火球术 | 火焰伤害<br/>附加灼烧 |',
      '</details>',
    ].join('\n'))).toEqual([{
      open: false,
      summary: '技能一览',
      children: [{ kind: 'markdown', text: '| 技能 | 说明 |\n| --- | --- |\n| 火球术 | 火焰伤害 附加灼烧 |' }],
    }])

    expect(parsePlainDetailsBlocks([
      '<details>',
      '<summary>状态栏',
      '```json',
      '{"hp": 100, "note": "</summary>"}',
      '```',
      '</details>',
    ].join('\n'))).toEqual([{
      open: false,
      summary: '状态栏',
      children: [{ kind: 'markdown', text: '```json\n{"hp": 100, "note": "</summary>"}\n```' }],
    }])

    expect(parsePlainDetailsBlocks([
      '<details>',
      '<summary>世界观设定',
      '<details>',
      '<summary>中央大陆',
      '### 菲托亚领地',
      '1. 布耶纳村',
      '</details>',
      '</details>',
    ].join('\n'))).toEqual([{
      open: false,
      summary: '世界观设定',
      children: [{
        kind: 'details',
        block: {
          open: false,
          summary: '中央大陆',
          children: [{ kind: 'markdown', text: '### 菲托亚领地\n1. 布耶纳村' }],
        },
      }],
    }])

    expect(parsePlainDetailsBlocks('<details>\n<summary>章节说明\n<hr/>\n正文内容\n</details>')).toEqual([{
      open: false,
      summary: '章节说明',
      children: [{ kind: 'markdown', text: '---\n\n正文内容' }],
    }])

    expect(parsePlainDetailsBlocks('<details>\n<summary>点击查看状态\n<br/>\nHP: 100\n</details>')).toEqual([{
      open: false,
      summary: '点击查看状态',
      children: [{ kind: 'markdown', text: 'HP: 100' }],
    }])

    expect(parsePlainDetailsBlocks('<details>\n<summary>点击查看状态<br/>\nHP: 100<br/>MP: 50\n</details>')).toEqual([{
      open: false,
      summary: '点击查看状态',
      children: [{ kind: 'markdown', text: 'HP: 100\nMP: 50' }],
    }])

    expect(parsePlainDetailsBlocks('<details>\n<summary>点击查看状态<br><br>\nHP: 100\n</details>')).toEqual([{
      open: false,
      summary: '点击查看状态',
      children: [{ kind: 'markdown', text: 'HP: 100' }],
    }])

    expect(parsePlainDetailsBlocks([
      '<details>',
      '<summary>角色档案',
      '<status1>',
      '```json',
      '{"hp": 10}',
      '```',
      '</status1>',
      '</details>',
    ].join('\n'))).toEqual([{
      open: false,
      summary: '角色档案',
      children: [{ kind: 'markdown', text: '```json\n{"hp": 10}\n```' }],
    }])

    expect(parsePlainDetailsBlocks([
      '<details>',
      '<summary>回合记录',
      '<UpdateVariable>hidden</UpdateVariable>',
      '生命值 +10',
      '</details>',
    ].join('\n'))).toEqual([{
      open: false,
      summary: '回合记录',
      children: [{ kind: 'markdown', text: '生命值 +10' }],
    }])

    // 紧接未闭合摘要的首行装饰短横线标题不误切空摘要；前导空行在存在真实标题时不吞掉标题，无标题时回落空摘要。
    expect(parsePlainDetailsBlocks('<details>\n<summary>\n- 请选择出生地 -\n\n### 中央大陆\n1. 鲁迪乌斯\n</details>')).toEqual([{
      open: false,
      summary: '- 请选择出生地 -',
      children: [{ kind: 'markdown', text: '### 中央大陆\n1. 鲁迪乌斯' }],
    }])
    expect(parsePlainDetailsBlocks('<details>\n<summary>\n\n点击查看出生地\n\n### 中央大陆\n1. 鲁迪乌斯\n</details>')).toEqual([{
      open: false,
      summary: '点击查看出生地',
      children: [{ kind: 'markdown', text: '### 中央大陆\n1. 鲁迪乌斯' }],
    }])
    expect(parsePlainDetailsBlocks('<details>\n<summary>\n\n### 中央大陆\n\n1. 鲁迪乌斯\n</details>')).toEqual([{
      open: false,
      summary: '',
      children: [{ kind: 'markdown', text: '### 中央大陆\n\n1. 鲁迪乌斯' }],
    }])

    // 引用块包裹的未闭合 <summary> 同样生效。
    expect(parsePlainDetailsBlocks([
      '<details>',
      '> <summary>背景设定',
      '> ### 中央大陆',
      '> 1. 鲁迪乌斯',
      '> </details>',
    ].join('\n'))).toEqual([{
      open: false,
      summary: '背景设定',
      children: [{ kind: 'markdown', text: '### 中央大陆\n1. 鲁迪乌斯' }],
    }])
  })

  it('未闭合 <summary> 正文代码中的 </summary> 与 <!-- 不破坏切分；摘要允许安全泛型且无二次复杂度退化', () => {
    expect(parsePlainDetailsBlocks([
      '<details>',
      '<summary>HTML 提示',
      '',
      '记得用 `</summary>` 闭合标题',
      '</details>',
    ].join('\n'))).toEqual([{
      open: false,
      summary: 'HTML 提示',
      children: [{ kind: 'markdown', text: '记得用 `</summary>` 闭合标题' }],
    }])

    expect(parsePlainDetailsBlocks([
      '<details>',
      '<summary>HTML 示例',
      '',
      '```html',
      '第一段',
      '',
      '记得闭合 </summary>',
      '<!-- 注释示例 -->',
      '```',
      '</details>',
    ].join('\n'))).toEqual([{
      open: false,
      summary: 'HTML 示例',
      children: [{ kind: 'markdown', text: '```html\n第一段\n\n记得闭合 </summary>\n<!-- 注释示例 -->\n```' }],
    }])

    expect(parsePlainDetailsBlocks([
      '<details>',
      '<summary>波浪围栏示例',
      '',
      '~~~html',
      '记得闭合 </summary>',
      '<!-- 注释示例 -->',
      '~~~',
      '</details>',
    ].join('\n'))).toEqual([{
      open: false,
      summary: '波浪围栏示例',
      children: [{ kind: 'markdown', text: '~~~html\n记得闭合 </summary>\n<!-- 注释示例 -->\n~~~' }],
    }])

    // 围栏内未闭合的 `<!--` 会改变浏览器 HTML 注释边界，仍保持严格回退 null。
    expect(parsePlainDetailsBlocks([
      '<details>',
      '<summary>未闭合注释示例',
      '',
      '```html',
      '<!-- 未闭合注释',
      '```',
      '</details>',
    ].join('\n'))).toBeNull()

    // 摘要内孤立反引号不跨过无空行正文块起点配对正文行内代码。
    expect(parsePlainDetailsBlocks([
      '<details>',
      '<summary>命令 `help',
      '### 用法',
      '参考 `<div class="demo">` 写法',
      '</details>',
    ].join('\n'))).toEqual([{
      open: false,
      summary: '命令 `help',
      children: [{ kind: 'markdown', text: '### 用法\n参考 `<div class="demo">` 写法' }],
    }])

    // 正常闭合且多行带 Markdown 符号的摘要仍按原样闭合；摘要内支持行内泛型。
    expect(parsePlainDetailsBlocks('<details><summary>标题\n> 副标题</summary>\n正文\n</details>')).toEqual([{
      open: false,
      summary: '标题\n> 副标题',
      children: [{ kind: 'markdown', text: '正文' }],
    }])
    expect(parsePlainDetailsBlocks('<details><summary>类型 Array<string> 说明</summary>\n正文\n</details>')).toEqual([{
      open: false,
      summary: '类型 Array<string> 说明',
      children: [{ kind: 'markdown', text: '正文' }],
    }])
    expect(parsePlainDetailsBlocks('<details>\n<summary>类型 Array<string> 说明\n\n### 字段\n1. name\n</details>')).toEqual([{
      open: false,
      summary: '类型 Array<string> 说明',
      children: [{ kind: 'markdown', text: '### 字段\n1. name' }],
    }])

    // 常见笔误：摘要行尾漏写斜杠写成 `<summary>` 后换行，按闭合边界处理。
    expect(parsePlainDetailsBlocks('<details>\n<summary>点击查看出生地<summary>\n正文说明\n</details>')).toEqual([{
      open: false,
      summary: '点击查看出生地',
      children: [{ kind: 'markdown', text: '正文说明' }],
    }])
    expect(parsePlainDetailsBlocks('<details>\n<summary>点击查看出生地<summary>\n\n### 中央大陆\n1. 鲁迪乌斯\n</details>')).toEqual([{
      open: false,
      summary: '点击查看出生地',
      children: [{ kind: 'markdown', text: '### 中央大陆\n1. 鲁迪乌斯' }],
    }])

    // 大量未配对反引号在 O(n) 时间内快速完成，无二次扫描退化。
    const strayBackticks = `<details><summary>${'a`b '.repeat(3000)}\n正文\n</details>`
    const started = performance.now()
    expect(parsePlainDetailsBlocks(strayBackticks)).toBeNull()
    expect(performance.now() - started).toBeLessThan(200)
  })

  it.each([
    '<details class="card"><summary>标题</summary>内容</details>',
    '<details style="color:red"><summary>标题</summary>内容</details>',
    '<details onclick="alert(1)"><summary>标题</summary>内容</details>',
    '<details open="false"><summary>标题</summary>内容</details>',
    '<details><summary style="color:red">标题</summary>内容</details>',
    '<details><summary><b>加粗标题</b></summary>内容</details>',
    '<details><summary>未闭合注释 <!-- 没关</summary>内容</details>',
    '<details><summary>标题</summary><hr style="border-color:red">内容</details>',
    '<details><summary>标题</summary><div class="content">内容</div></details>',
    '<details><summary>标题</summary><p>段落</p></details>',
    '<details><summary>标题</summary><style>.x{}</style>内容</details>',
    '<details><summary>标题</summary><script>alert(1)</script></details>',
    '<details><summary>标题</summary><br class="sep"/>内容</details>',
    '<details><summary>标题</summary>行内 <my-widget>内容</my-widget></details>',
    '<details><summary>标题</summary><!-- 未闭合注释</details>',
    '<details><summary>标题</summary>内容</details>\n<div>相邻卡片</div>',
    '前置文字\n<details><summary>标题</summary>内容</details>',
    '<details><summary>未闭合且无空行\n正文</details>',
    '<details><summary>未闭合且无空行\n正文</details>\n\n<details><summary>第二块</summary>正文</details>',
    '<details><summary><b>带HTML的未闭合摘要</b>\n\n正文</details>',
    '<details><summary>未闭合摘要\n\n<div class="card">复杂卡片</div></details>',
    '<details><summary>未闭合摘要\n\n<script>alert(1)</script></details>',
    '<details><summary>未闭合摘要\n\n<summary>重复摘要</summary>\n正文</details>',
    '<details><summary>标题<summary>\n副标题</summary>\n正文</details>',
    '<details><summary>标题<summary>另一标题</summary>\n正文</details>',
    '<details><summary><summary>\n正文</details>',
    '<details><summary>标题<summary class="x">\n正文</details>',
    '<details><summary>闭合摘要\n\n<UpdateVariable>hidden</UpdateVariable></summary>\n正文</details>',
    '<details><summary>闭合摘要\n\n第一行<br/>第二行</summary>\n正文</details>',
    '<details><summary>第一行<br/>\n第二行</summary>\n正文</details>',
    '<details><summary>第一行\n<br/>\n第二行</summary>\n正文</details>',
    '<details><summary>闭合摘要\n\n```html\n<div>x</div>\n```\n</summary>\n正文</details>',
    '<details><summary>闭合摘要\n\n记得用 `</summary>` 闭合</summary>\n正文</details>',
    '<details><summary>攻击标题\n\n```\n</details>\n<script>window.pwned=1</script>\n<details><summary>二</summary>\n```\n</details>',
    '<details><summary>攻击标题\n```\n</details>\n<script>window.pwned=1</script>\n<details><summary>二</summary>\n```\n</details>',
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
      '<details><summary>未闭合标题',
      '',
      '### 列表',
      '1. 条目</details>',
      '<details>无标题内容</details>',
      '<details><summary>   </summary></details>',
    ].join('\n')
    const blocks = parsePlainDetailsBlocks(html)
    expect(blocks).not.toBeNull()
    expect(formatPlainDetailsText(blocks!)).toBe([
      '____------妖精契约------____',
      '第一行\n第二行',
      '子项\n> 引用说明',
    ].join('\n') + '\n\n未闭合标题\n### 列表\n1. 条目\n\n无标题内容')
  })

  it('纯 <details> 内引用块里的 <br><br> 延续引用前缀，不让后半段脱离引用块', () => {
    const blocks = parsePlainDetailsBlocks('<details><summary>日记</summary>\n> 第一行<br><br>第二行\n</details>')
    expect(blocks).toEqual([
      {
        open: false,
        summary: '日记',
        children: [{ kind: 'markdown', text: '> 第一行\n>\n> 第二行' }],
      },
    ])
  })
})
