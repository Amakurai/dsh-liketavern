/**
 * 展示层机读标签收起：UpdateVariable / JSONPatch / 流式未闭合尾巴 / 协议标签
 *（customize_HCI、now_plot 等），不误伤普通正文与 HTML。
 */
import { describe, expect, it } from 'vitest'
import { presentRenderedOutput, stripDisplayMeta } from '../src/core/displaySanitize.js'

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
    expect(shown.text).toBe('可见正文。')
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
  })

  it('style 小部件进 htmls，前面的协议标签从正文收起', () => {
    const rendered = '<customize_HCI><style>.x{}</style><div class="x">ui</div>\n可见正文。'
    const shown = presentRenderedOutput(rendered, true)
    expect(shown.html).toContain('<style>')
    expect(shown.text).toBe('可见正文。')
    expect(shown.text).not.toContain('customize_HCI')
  })
})
