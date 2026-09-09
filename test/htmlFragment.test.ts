/** 内联样式卡面的识别回归：手写状态栏、嵌套及相邻容器、正文顺序、代码示例与不完整输出。 */
import { expect, it } from 'vitest'
import { splitRenderedHtml } from '../src/core/regex.js'
import { presentRenderedOutput } from '../src/core/displaySanitize.js'
import { splitTemplateDisplay } from '../src/core/templateDisplay.js'

const status = '<div style="display:flex;align-items:center"><span style="width:60px">好感度</span><div style="flex:1"><div style="width:5%;background:linear-gradient(90deg,#9bbde0,#f2a6b0)"></div></div><span>5</span></div>'
const diary = '<div style="padding:16px"><div style="font-weight:bold">日记</div><div style="white-space:pre-wrap">今天去了图书馆。</div></div>'

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
