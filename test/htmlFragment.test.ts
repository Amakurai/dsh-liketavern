/** 内联样式卡面的识别回归：手写状态栏、嵌套及相邻容器、正文顺序、代码示例与不完整输出。 */
import { expect, it } from 'vitest'
import { splitRenderedHtml } from '../src/core/regex.js'
import { presentRenderedOutput } from '../src/core/displaySanitize.js'
import { splitTemplateDisplay } from '../src/core/templateDisplay.js'

const status = '<div style="display:flex;align-items:center"><span style="width:60px">好感度</span><div style="flex:1"><div style="width:5%;background:linear-gradient(90deg,#9bbde0,#f2a6b0)"></div></div><span>5</span></div>'
const diary = '<div style="padding:16px"><div style="font-weight:bold">日记</div><div style="white-space:pre-wrap">今天去了图书馆。</div></div>'
const expandable = '<div class="record"><details><summary>记录</summary><div class="content" style="opacity:0">内容</div></details></div>'
const revealStyle = '<style>.record details[open] .content{opacity:1!important}</style>'

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
  expect(presentRenderedOutput(html, false)).toEqual({html:null,htmls:[],text:html})
})

it('显式 html 围栏中的裸片段进入沙箱，围栏外两侧正文不遗失', () => {
  expect(splitTemplateDisplay('前文\n```html\n' + status + '\n```\n后文')).toEqual([
    {kind:'markdown',text:'前文'}, {kind:'html',text:status}, {kind:'markdown',text:'后文'},
  ])
  expect(splitTemplateDisplay('前文\n```html\r\n\r\n  ' + status + '\r\n```\n后文')).toEqual([
    {kind:'markdown',text:'前文'}, {kind:'html',text:status}, {kind:'markdown',text:'后文'},
  ])
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
