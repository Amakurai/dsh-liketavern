/** 内联样式卡面的识别回归：手写状态栏、嵌套及相邻容器、正文顺序、代码示例与不完整输出。 */
import { expect, it } from 'vitest'
import { splitRenderedHtml } from '../src/core/regex.js'
import { isFullHtmlDocument } from '../src/core/htmlFragment.js'
import { presentRenderedOutput } from '../src/core/displaySanitize.js'
import { splitTemplateDisplay } from '../src/core/templateDisplay.js'

const status = '<div style="display:flex;align-items:center"><span style="width:60px">好感度</span><div style="flex:1"><div style="width:5%;background:linear-gradient(90deg,#9bbde0,#f2a6b0)"></div></div><span>5</span></div>'
const diary = '<div style="padding:16px"><div style="font-weight:bold">日记</div><div style="white-space:pre-wrap">今天去了图书馆。</div></div>'
const expandable = '<div class="record"><details><summary>记录</summary><div class="content" style="opacity:0">内容</div></details></div>'
const revealStyle = '<style>.record details[open] .content{opacity:1!important}</style>'

it('完整文档判断跳过代码与脚本字符串，只识别实际文档边界',()=>{
  expect(isFullHtmlDocument('<!DOCTYPE html><html><body>卡面</body></html>')).toBe(true)
  expect(isFullHtmlDocument('<html lang="zh"><body class="cover">省略 html 闭标签</body>\n')).toBe(true)
  expect(isFullHtmlDocument('<body class="cover">卡面</body>')).toBe(true)
  expect(isFullHtmlDocument('<html><body>仍在流式输出')).toBe(false)
  expect(isFullHtmlDocument('<html><body>卡面</body>后续台词')).toBe(false)
  expect(isFullHtmlDocument('```html\n<html><body>示例</body></html>\n```')).toBe(false)
  expect(isFullHtmlDocument('<script>const sample="<html><body>x</body></html>"</script><div>部件</div>')).toBe(false)
})

it('template 与 noscript 内容保持惰性，后续真实卡面仍按原字节识别',()=>{
  const inert='<template id="samples"><script>const close="</template><div>伪卡</div>"</script>'
    +'<template><html><body>文档示例</body></html></template><div>片段示例</div></template>'
  expect(isFullHtmlDocument(inert)).toBe(false)
  expect(splitRenderedHtml(inert)).toEqual({html:null,rest:inert})
  const card=inert+'\n<div class="real-card">真实卡面</div>'
  expect(splitRenderedHtml(card)).toEqual({html:card,rest:''})

  const noScript='<noscript><html><body>回退文档</body></html><div>回退片段</div></noscript>'
  expect(isFullHtmlDocument(noScript)).toBe(false)
  expect(splitRenderedHtml(noScript+'\n<section>真实状态</section>')).toEqual({
    html:noScript+'\n<section>真实状态</section>',rest:'',
  })
})

it.each([
  expandable + '\n' + revealStyle,
  revealStyle + '\n' + expandable,
  expandable + '\n<!-- 组件依赖 -->\n' + revealStyle + '\n<script>document.querySelector(".record").dataset.ready="yes"</script>',
])('组件及前后相邻样式脚本留在同一沙箱，正文不会被吞入：%s', html => {
  expect(splitTemplateDisplay('前文\n' + html + '\n后文')).toEqual([
    {kind:'markdown',text:'前文'}, {kind:'html',text:html}, {kind:'markdown',text:'后文'},
  ])
  expect(presentRenderedOutput(html, true)).toEqual({html,htmls:[html],text:''})
})

it('样式片段不吞入下一张独立文档，正文和显式围栏仍保留各自边界', () => {
  const widget = expandable + '\n' + revealStyle
  const page = '<!DOCTYPE html><html><body><div>独立状态页</div></body></html>'
  expect(splitTemplateDisplay(widget + '\n' + page + '\n后文')).toEqual([
    {kind:'html',text:widget}, {kind:'html',text:page}, {kind:'markdown',text:'后文'},
  ])
  expect(splitTemplateDisplay('```html\n'+expandable+'\n```\n'+revealStyle)).toEqual([
    {kind:'html',text:expandable}, {kind:'html',text:revealStyle},
  ])
  expect(splitTemplateDisplay(widget+'\n中间台词\n'+diary)).toEqual([
    {kind:'html',text:widget}, {kind:'markdown',text:'中间台词'}, {kind:'html',text:diary},
  ])
})

it('无 html/style/script 外壳的内联样式状态栏进入 HTML，嵌套与相邻块原字节保留', () => {
  const html = status + ' ' + diary
  expect(presentRenderedOutput(html, true)).toEqual({html, htmls:[html], text:''})
  expect(splitTemplateDisplay('前文\n' + html + '\n后文')).toEqual([
    {kind:'markdown',text:'前文'}, {kind:'html',text:html}, {kind:'markdown',text:'后文'},
  ])
  expect(presentRenderedOutput(html, false)).toEqual({html:null,htmls:[],text:'```html\n'+html+'\n```'})
})

it('显式 html 围栏中的裸片段进入沙箱，围栏外两侧正文不遗失', () => {
  expect(splitTemplateDisplay('前文\n```html\n' + status + '\n```\n后文')).toEqual([
    {kind:'markdown',text:'前文'}, {kind:'html',text:status}, {kind:'markdown',text:'后文'},
  ])
  expect(splitTemplateDisplay('前文\n```html\r\n\r\n  ' + status + '\r\n```\n后文')).toEqual([
    {kind:'markdown',text:'前文'}, {kind:'html',text:status}, {kind:'markdown',text:'后文'},
  ])
  const controls='<button type="button">继续</button>\n<p>没有 div 外壳</p>'
  expect(splitTemplateDisplay('前文\n```html\n'+controls+'\n```\n后文')).toEqual([
    {kind:'markdown',text:'前文'}, {kind:'html',text:controls}, {kind:'markdown',text:'后文'},
  ])
  expect(splitTemplateDisplay('```xml\n<status-card hp="7"/>\n```')).toEqual([
    {kind:'html',text:'<status-card hp="7"/>'},
  ])
})

it('样式或脚本前导与相邻普通元素、空元素保持在同一个卡面',()=>{
  const styled='<style>p{color:red}.portrait{width:32px}</style>\n<p>状态</p>\n<img class="portrait" src="data:image/png;base64,AA==">'
  expect(splitTemplateDisplay('前文\n'+styled+'\n后文')).toEqual([
    {kind:'markdown',text:'前文'},{kind:'html',text:styled},{kind:'markdown',text:'后文'},
  ])
  // 没有明确围栏或前导卡面时仍不把普通段落从 Markdown 提升为脚本沙箱。
  expect(splitRenderedHtml('<p>普通 HTML 段落</p>')).toEqual({html:null,rest:'<p>普通 HTML 段落</p>'})
  const selfClosing='<style>.portrait{width:32px}</style><img class="portrait" src="data:image/png;base64,AA=="/>'
  expect(splitTemplateDisplay(selfClosing)).toEqual([{kind:'html',text:selfClosing}])
})

it('多个片段之间的台词保留 Markdown 顺序，根容器大小写和属性内闭标签不影响边界', () => {
  const first = '<DIV title="a > b </DIV>"><div>一</div><!-- </DIV> --></DIV>'
  expect(splitTemplateDisplay(first+'\n中间台词\n<section><div>二</div></section>\n结尾')).toEqual([
    {kind:'html',text:first}, {kind:'markdown',text:'中间台词'},
    {kind:'html',text:'<section><div>二</div></section>'}, {kind:'markdown',text:'结尾'},
  ])
})

it.each([
  '`<div style="color:red">示例</div>`',
  '```javascript\nconst example = "<div>示例</div>";\n```',
  '~~~javascript\nconst example = "<div>示例</div>";\n~~~',
  '    <div>缩进代码</div>',
  '`<style>.example{color:red}</style>`',
  '```javascript\nconst example = "<script>alert(1)</script>";\n```',
  '    <style>.example{color:red}</style>',
  '<!-- <div>注释</div> -->',
  '<div style="color:red"><div>未完成的外层</div>',
  '他说：<你真行>。',
  '&lt;div&gt;转义示例&lt;/div&gt;',
])('普通台词、代码或未完成片段不被当成卡面：%s', text => {
  expect(splitRenderedHtml(text)).toEqual({html:null,rest:text.trim()})
})

it('前面的代码示例不阻止后面的真实片段被识别，textarea 内标签不提前结束容器', () => {
  const example = '`<div>示例</div>`', html = '<div><textarea></div></textarea><span>真实卡面</span></div>'
  expect(splitRenderedHtml(example+'\n'+html+'\n正文')).toEqual({html,rest:example+'\n正文'})
  const same='<div>同文</div>'
  expect(splitTemplateDisplay('`'+same+'`\n'+same)).toEqual([{kind:'markdown',text:'`'+same+'`'},{kind:'html',text:same}])
})

/** 文档识别也必须遵守代码与注释边界，不能把示例字符串提升成正在运行的卡片。 */
it.each([
  '`<html><body>文档示例</body></html>`',
  '<!-- <html><body>注释示例</body></html> -->',
  '```javascript\nconst sample = "<html><body>代码示例</body></html>";\n```',
  '    <html><body>缩进示例</body></html>',
  '    <html><body><div>缩进卡片示例</div></body></html>',
  '<!--\n```html\n<html><body>注释卡片示例</body></html>\n```\n-->',
  '````markdown\n```html\n<html><body>代码里的围栏</body></html>\n```\n````',
])('完整 HTML 出现在非卡面代码或注释时仍保留原文：%s', text => {
  expect(splitRenderedHtml(text)).toEqual({html:null,rest:text.trim()})
})

it('整页卡面脚本里的结束标签字符串不会截断文档，也不会吞掉后续正文', () => {
  const html='<html><head><script>const example="</html>";</script></head><body><div>实际卡片</div></body></html>'
  expect(splitTemplateDisplay('前文\n'+html+'\n后文')).toEqual([
    {kind:'markdown',text:'前文'},{kind:'html',text:html},{kind:'markdown',text:'后文'},
  ])
})

it('没有外层 div 的折叠卡与配套样式仍在一个沙箱', () => {
  const html='<details><summary>记录</summary><p style="opacity:0">内容</p></details>\n<style>details[open]>p{opacity:1!important}</style>'
  expect(splitTemplateDisplay(html)).toEqual([{kind:'html',text:html}])
})

it.each(['~~~html','````html','```HTML'])('完整识别不同围栏标记，后续台词不残留关闭符号：%s', opening => {
  const marker=opening.replace(/html/i,'')
  expect(splitTemplateDisplay('前文\n'+opening+'\n'+diary+'\n'+marker+'\n后文')).toEqual([
    {kind:'markdown',text:'前文'},{kind:'html',text:diary},{kind:'markdown',text:'后文'},
  ])
})

it('前面的普通代码块不会挡住后面的真实 HTML 围栏', () => {
  const code='```text\n这是一段纯文本\n```'
  expect(splitTemplateDisplay(code+'\n```html\n'+diary+'\n```\n后文')).toEqual([
    {kind:'markdown',text:code},{kind:'html',text:diary},{kind:'markdown',text:'后文'},
  ])
})

/** 正文标点不能永久开启代码状态；文档和片段都必须在刷新时稳定恢复同一张卡。 */
it.each([diary,'<!DOCTYPE html><html><body><div>实际状态页</div></body></html>'])('未成对反引号和行中波浪不阻断后续 HTML：%s',html=>{
  for(const prefix of ['他说：`这是什么。','他说：``这是什么。','价格是 ~~~ 元。','价格是 ~~~~ 元。','他说：\\`这是什么。']) {
    const source=prefix+'\n\n'+html+'\n后文'
    expect(splitRenderedHtml(source)).toEqual({html,rest:prefix+'\n后文'})
    expect(presentRenderedOutput(source,true).htmls).toEqual([html])
    expect(splitTemplateDisplay(source)).toEqual([
      {kind:'markdown',text:prefix},{kind:'html',text:html},{kind:'markdown',text:'后文'},
    ])
  }
})

it.each([diary,'<html><body>文档示例</body></html>'])('真正的代码跨度、围栏及缩进仍不提升为卡面：%s',html=>{
  for(const source of [
    '`'+html+'`',
    '``前文 ` '+html+' 后文``',
    '`前文\n'+html+'\n后文`',
    '```javascript\n'+html+'\n```',
    '~~~javascript\n'+html+'\n~~~~',
    '```javascript\n'+html,
    '~~~javascript\n'+html,
    '```html\n'+html,
    '    '+html,
    '\t'+html,
    '> ```javascript\n> '+html+'\n> ```',
    '- ```javascript\n  '+html+'\n  ```',
    '> ```html\n> '+html+'\n> ```',
    '- ```html\n  '+html+'\n  ```',
    '```javascript\n> ```\n'+html+'\n```',
    '> ```javascript\n>> ```\n> '+html+'\n> ```',
    '- ```javascript\n```\n  '+html+'\n  ```',
  ]) expect(splitRenderedHtml(source)).toEqual({html:null,rest:source.trim()})
})

/** 列表标记后的 Tab 到达下一制表位；缩进不足的伪闭符不能把示例内容提升成可执行卡面。 */
it.each(['```','~~~'])('列表 Tab 缩进按列计算，较浅的 %s 标记不能提前结束代码保护',marker=>{
  for(const html of [diary,'<html><body>文档示例</body></html>']) {
    const source='-\t'+marker+'javascript\n  '+marker+'\n'+html+'\n  '+marker
    expect(splitRenderedHtml(source)).toEqual({html:null,rest:source})
    expect(splitTemplateDisplay(source)).toEqual([{kind:'markdown',text:source}])
    const closed='-\t'+marker+'javascript\n\t<div>代码示例</div>\n\t'+marker
    expect(splitRenderedHtml(closed+'\n\n'+html)).toEqual({html,rest:closed})
  }
})

/** 引用前缀占据真实列位置，列表后的 Tab 与闭围栏必须从同一制表位口径计算。 */
it.each(['```','~~~'])('引用中的列表 Tab 围栏 %s 正常闭合，后续真实卡面仍可显示',marker=>{
  for(const [opening,body,closing] of [['> -\t','> \t','> \t'],['> -\t','>   ','>   '],['>\t-\t','>\t\t','>\t\t']]) {
    const code=opening+marker+'javascript\n'+body+'<div>代码示例</div>\n'+closing+marker
    expect(splitRenderedHtml(code+'\n\n'+diary)).toEqual({html:diary,rest:code})
    expect(splitTemplateDisplay(code+'\n\n'+diary)).toEqual([{kind:'markdown',text:code},{kind:'html',text:diary}])
  }
})

it('inline 代码总以最近的等长标记结束，内部不同长度标记与转义不改变边界',()=>{
  const samples=[
    '`<div>一</div>` ``<div>二</div>``',
    '``<div>`一`</div>`` `<div>二</div>`',
    '\\``<div>一</div>`',
    '`<div>一</div>\\`',
  ]
  for(const sample of samples)expect(splitRenderedHtml(sample+'\n\n'+diary)).toEqual({html:diary,rest:sample})
})

it.each([diary,'<!DOCTYPE html><html><body>实际文档</body></html>'])('成对代码之后仍识别真实卡片与 HTML 围栏：%s',html=>{
  for(const example of ['`<div>代码示例</div>`','```javascript\n<div>代码示例</div>\n````','~~~javascript\n<div>代码示例</div>\n~~~~']) {
    expect(splitRenderedHtml(example+'\n\n'+html)).toEqual({html,rest:example})
  }
  for(const marker of ['```','~~~']) {
    expect(splitTemplateDisplay('正文包含 ` 标点\n\n'+marker+'html\n'+html+'\n'+marker+'\n后文 ` 符号')).toEqual([
      {kind:'markdown',text:'正文包含 ` 标点'},{kind:'html',text:html},{kind:'markdown',text:'后文 ` 符号'},
    ])
  }
})
