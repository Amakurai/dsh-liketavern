/** 展示模板兼容：真实 QuickJS/Markdown、持久化回复和服务重绘验证顺序、隔离交付及只读边界。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import {
  disableInteractiveParts,
  parseTemplateDisplayParts,
  sanitizeTemplateDisplayParts,
  splitTemplateDisplay,
  TEMPLATE_DISPLAY_PARTS_VERSION,
} from '../src/core/templateDisplay.js'
import type { RegexRule } from '../src/core/types.js'
import { isolated } from '../src/node/isolated.js'
import { parseLorebook } from '../src/state/lorebook.js'
import { TavernState } from '../src/node/state.js'
import { resolveConfig, TavernConfigSchema, type TavernConfigRaw } from '../src/node/config.js'
import { parseJsonCard } from '../src/state/card.js'
import { importCard } from '../src/state/workspace.js'
import { saveBinding } from '../src/node/bindings.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { TavernService } from '../src/node/service.js'
import { loadTemplateState, TEMPLATE_STATE_PATH } from '../src/state/template.js'
import { TAVERN_GREETING_SOURCE } from '../src/core/greetingLog.js'

const context=(patch:Partial<TemplateContext>={}):TemplateContext=>({variables:emptyTemplateScopes(),char:'A',user:'B',card:{},entries:[],presets:[],history:[],now:1000,seed:1,phase:'render',...patch})
const lore=(entries:unknown[])=>parseLorebook({entries},{source:'character',sourceRef:'card'})
const render=(text:string,entries:unknown[]=[])=>isolated('template',{texts:[text],context:context({entries:lore(entries)}),decorateOutput:true})

describe('有序展示与真实消息格式化',()=>{
  it('BEFORE、正文内卡面和 AFTER 按原位置交付，非空 iframe 标题单独保存',async()=>{
    const result=await render('正文前\n```html\n<html><body>正文卡</body></html>\n```\n正文后',[
      {uid:1,comment:'first',order:1,content:'@@render_before\n@@iframe <b>折叠标题</b>\n<button>前置卡</button>'},
      {uid:2,comment:'hidden',content:'@@render_before\n@@if false\n@@iframe\n<% throw Error("hidden") %>'},
      {uid:3,comment:'last',content:'@@render_after\n@@iframe\n<div>后置卡</div>'},
    ])
    expect(result.parts[0]).toEqual([
      {kind:'html',title:'<b>折叠标题</b>',text:'<button>前置卡</button>'},
      {kind:'markdown',text:'正文前'}, {kind:'html',text:'<html><body>正文卡</body></html>'},
      {kind:'markdown',text:'正文后'}, {kind:'html',text:'<div>后置卡</div>'},
    ])
  })
  it('RENDER 的 <%= 和 message_formatting 使用真实 Markdown；GENERATE 输出保持原样',async()=>{
    const source='<%= "**加粗**" %>'
    const rendered=await render(source,[{uid:1,comment:'table',content:'@@render_after\n@@message_formatting\n| 标题 | 值 |\n|---|---|\n| 条目 | ~~删除~~ |'}])
    expect(rendered.texts[0]).toContain('<p><strong>加粗</strong></p>')
    expect(rendered.parts[0]?.[0]).toEqual({kind:'html',text:'<p><strong>加粗</strong></p>'})
    expect(rendered.parts[0]?.[1]?.text).toContain('<table>')
    expect(rendered.parts[0]?.[1]?.text).toContain('<del>删除</del>')
    expect(rendered.parts[0]?.[1]?.kind).toBe('html')
    const generated=await isolated('template',{context:context({phase:'generate'}),texts:[source]})
    expect(generated.texts).toEqual(['**加粗**'])
  })
  it('格式化 iframe 保留折叠标题；原始 HTML 和混合输出不会进入 Markdown 主页面',async()=>{
    const result=await render('前 <%= "**粗体**" %> <%- "<details><summary>内层</summary>内容</details>" %> 后',[
      {uid:1,comment:'status',content:'@@render_after\n@@message_formatting\n@@iframe 状态\n**生命**\n\n<script>parent.postMessage("unsafe","*")</script>'},
    ])
    expect(result.parts[0]?.[0]?.kind).toBe('html')
    expect(result.parts[0]?.filter(part=>part.kind==='html').map(part=>part.text).join('')).toContain('<details><summary>内层</summary>内容</details>')
    expect(result.parts[0]?.filter(part=>part.kind==='markdown').some(part=>/<details|<script/.test(part.text))).toBe(false)
    expect(result.parts[0]?.at(-1)).toMatchObject({kind:'html',title:'状态'})
    expect(result.parts[0]?.at(-1)?.text).toContain('<strong>生命</strong>')
    expect(result.parts[0]?.at(-1)?.text).toContain('<script>')
  })
  it('隔离格式化保留代码转义、原始 HTML、表格、下划线、换行和 emoji 的展示语义',async()=>{
    const samples=[
      {source:'```html\n<p>代码里的 HTML</p>\n```',fragments:['<pre><code','&lt;p&gt;代码里的 HTML&lt;/p&gt;','</code></pre>']},
      {source:'`<b>code</b>` :smile: **bold**',fragments:['<code>&lt;b&gt;code&lt;/b&gt;</code>','😄','<strong>bold</strong>']},
      {source:'<details><summary>标题</summary>内容</details>',fragments:['<details><summary>标题</summary>内容</details>']},
      {source:'| one | two |\n|---|---|\n| ~~strike~~ | __underline__ |',fragments:['<table>','<th>one</th>','<del>strike</del>','<u>underline</u>']},
      {source:'> quote\n\nnext_line\nsecond line',fragments:['<blockquote>','<p>quote</p>','next_line<br','second line']},
    ]
    for(const {source:sample,fragments} of samples) {
      const actual=await render('',[{uid:1,comment:'format',content:'@@render_after\n@@message_formatting\n'+sample}])
      expect(actual.parts[0]).toHaveLength(1)
      expect(actual.parts[0]?.[0]?.kind).toBe('html')
      for(const fragment of fragments) expect(actual.parts[0]?.[0]?.text).toContain(fragment)
    }
  })
  it('普通片段拆分保留开头和结尾；展示边界拒绝坏数据及无界输出',()=>{
    expect(splitTemplateDisplay('before\n<html><body>one</body></html>\nmiddle\n```html\n<html><body>two</body></html>\n```\nafter').map(p=>p.kind)).toEqual(['markdown','html','markdown','html','markdown'])
    expect(splitTemplateDisplay('before\n```html\n<button>继续</button><p>状态</p>\n```\nafter')).toEqual([
      {kind:'markdown',text:'before'},{kind:'html',text:'<button>继续</button><p>状态</p>'},{kind:'markdown',text:'after'},
    ])
    const styled='<style>.status{color:red}</style><p class="status">正常</p>'
    expect(splitTemplateDisplay(styled)).toEqual([{kind:'html',text:styled}])
    for(const bad of [[{kind:'script',text:'x'}],[{kind:'markdown',text:'x',title:'bad'}],[{kind:'html',text:'x',title:8}],[{kind:'html',text:'x'.repeat(1024*1024+1)}],Array.from({length:129},()=>({kind:'markdown',text:'x'}))]) expect(()=>parseTemplateDisplayParts(bad)).toThrow()
  })
  it('惰性模板内的围栏与文档示例不被提升，模板后的真实卡仍在同一沙箱',()=>{
    const inert='<template id="card-template"><template><html><body>示例文档</body></html></template>\n'
      +'```html\n<button>示例按钮</button>\n```\n</template>'
    expect(splitTemplateDisplay(inert)).toEqual([{kind:'markdown',text:inert}])
    const live=inert+'\n<script>document.body.dataset.ready="yes"</script><button type="button">真实按钮</button>'
    expect(splitTemplateDisplay('前文\n'+live+'\n后文')).toEqual([
      {kind:'markdown',text:'前文'},{kind:'html',text:live},{kind:'markdown',text:'后文'},
    ])

    const fallback='<noscript>```html\n<div>回退示例</div>\n```</noscript>'
    expect(splitTemplateDisplay(fallback)).toEqual([{kind:'markdown',text:fallback}])
    expect(splitTemplateDisplay(fallback+'\n<div>真实状态</div>')).toEqual([
      {kind:'html',text:fallback+'\n<div>真实状态</div>'},
    ])
  })
  it('机读块先于 HTML 拆分收起，跨片段清理后只降级真正可见的卡面',()=>{
    const raw='<think><div>隐藏推理</div>尾部秘密</think>可见答案'
    expect(splitTemplateDisplay(raw)).toEqual([{kind:'markdown',text:'可见答案'}])
    expect(splitTemplateDisplay(raw,true)).toEqual([{kind:'markdown',text:'可见答案'}])

    const parts=[
      {kind:'markdown' as const,text:'前文<think>'},
      {kind:'html' as const,text:'<div>跨段秘密</div>',title:'隐藏标题'},
      {kind:'markdown' as const,text:'尾部秘密</think>中间'},
      {kind:'html' as const,text:'<details><summary>线索</summary>可见卡面</details>',title:'可见标题'},
      {kind:'markdown' as const,text:'后文'},
    ]
    expect(sanitizeTemplateDisplayParts(parts)).toEqual([
      {kind:'markdown',text:'前文'}, {kind:'markdown',text:'中间'},
      {kind:'html',text:'<details><summary>线索</summary>可见卡面</details>',title:'可见标题'},
      {kind:'markdown',text:'后文'},
    ])
    const disabled=disableInteractiveParts(parts)
    expect(disabled.map(part=>part.kind)).toEqual(['markdown','markdown','markdown','markdown'])
    expect(disabled.map(part=>part.text)).toEqual([
      '前文', '中间', '```html\n<details><summary>线索</summary>可见卡面</details>\n```', '后文',
    ])
    expect(JSON.stringify(disabled)).not.toContain('跨段秘密')
    expect(JSON.stringify(disabled)).not.toContain('尾部秘密')

    const truncated=sanitizeTemplateDisplayParts([{kind:'markdown',text:'前文<think'},
      {kind:'html',text:'<div>截断标签后的秘密</div>'},{kind:'markdown',text:'</think>公开'}])
    expect(truncated).toEqual([{kind:'markdown',text:'前文'}])
  })
  it('禁用模板卡时移除 HTML 内机读块与注释，但保留脚本中的标签字面量',()=>{
    const [part]=disableInteractiveParts([{kind:'html',text:'<div>公开<Analysis>内部秘密</Analysis><!--注释秘密-->'
      + '<script>const value="<think>字面量</think>"</script></div>'}])
    expect(part?.text).toContain('公开')
    expect(part?.text).toContain('<think>字面量</think>')
    expect(part?.text).not.toContain('内部秘密')
    expect(part?.text).not.toContain('注释秘密')
  })
  it.each([
    ['未闭合脚本','<script>window.x=1'],
    ['未闭合注释','<!-- unclosed'],
  ])('%s 的 HTML 词法状态不跨 part 遮蔽后续机读边界',(_label,broken)=>{
    const parts=[{kind:'html' as const,text:broken},{kind:'markdown' as const,text:'<think>'},
      {kind:'html' as const,text:'<div>SECRET</div>'},{kind:'markdown' as const,text:'TAIL</think>VISIBLE'}]
    for(const projected of [sanitizeTemplateDisplayParts(parts),disableInteractiveParts(parts)]) {
      expect(JSON.stringify(projected)).not.toContain('SECRET')
      expect(JSON.stringify(projected)).not.toContain('TAIL')
      expect(JSON.stringify(projected)).toContain('VISIBLE')
    }
  })
  it.each(['<!-->','<!--->','<!--x--!>'])('畸形注释 %s 后的内容按本片段末尾安全隐藏',(comment)=>{
    const parts=[{kind:'html' as const,text:`<div>公开</div>${comment}<think><div>SECRET</div></think>VISIBLE--><p>诱饵后正文</p>`}]
    for(const projected of [sanitizeTemplateDisplayParts(parts),disableInteractiveParts(parts)]) {
      expect(JSON.stringify(projected)).toContain('公开')
      expect(JSON.stringify(projected)).not.toContain('SECRET')
      expect(JSON.stringify(projected)).not.toContain('VISIBLE')
      expect(JSON.stringify(projected)).not.toContain('诱饵后正文')
    }
  })
  it.each(['pre','code','textarea','title'])('%s 的可见或文档文本不遮蔽机读块',(tag)=>{
    const parts=[{kind:'html' as const,text:`<${tag}>前文<think>SECRET</think>后文</${tag}>`}]
    for(const projected of [sanitizeTemplateDisplayParts(parts),disableInteractiveParts(parts)]) {
      expect(JSON.stringify(projected)).toContain('前文')
      expect(JSON.stringify(projected)).toContain('后文')
      expect(JSON.stringify(projected)).not.toContain('SECRET')
    }
  })
  it.each([
    ['textarea','script'],['textarea','style'],['title','script'],['xmp','script'],['plaintext','style'],
  ])('%s 可见文本容器里的字面 %s 不开启 opaque 旁路',(container,raw)=>{
    const close=container==='plaintext'?'':`</${container}>`
    const parts=[{kind:'html' as const,text:`<${container}><${raw}><think>SECRET</think></${raw}>VISIBLE${close}`}]
    for(const projected of [sanitizeTemplateDisplayParts(parts),disableInteractiveParts(parts)]) {
      expect(JSON.stringify(projected)).not.toContain('SECRET')
      expect(JSON.stringify(projected)).toContain('VISIBLE')
    }
  })
  it.each(['textarea','xmp','plaintext'])('%s 的 HTML 自闭合斜线不阻止可见文本语境开启',(container)=>{
    const parts=[{kind:'html' as const,text:`<${container}/><script><think>SECRET</think></script>VISIBLE`}]
    for(const projected of [sanitizeTemplateDisplayParts(parts),disableInteractiveParts(parts)]) {
      expect(JSON.stringify(projected)).not.toContain('SECRET')
      expect(JSON.stringify(projected)).toContain('VISIBLE')
    }
  })
  it('custom 机读元素的自闭合斜线仅在没有后续闭标签时按独立占位处理',()=>{
    expect(sanitizeTemplateDisplayParts([{kind:'html',text:'<think/>SECRET</think>VISIBLE'}]))
      .toEqual([{kind:'html',text:'VISIBLE'}])
    expect(sanitizeTemplateDisplayParts([{kind:'markdown',text:'<think/>'},{kind:'html',text:'<div>跨段秘密</div>'},
      {kind:'markdown',text:'TAIL</think>VISIBLE'}])).toEqual([{kind:'markdown',text:'VISIBLE'}])
    expect(sanitizeTemplateDisplayParts([{kind:'html',text:'<think/>VISIBLE'}]))
      .toEqual([{kind:'html',text:'VISIBLE'}])
  })
  it('NBSP 不是 HTML 标签空白，不能让伪 script 或伪自闭机读标签绕过清理',()=>{
    for(const html of [`<script\u00a0><think>SECRET</think></script>VISIBLE`,`<think/\u00a0>SECRET`]) {
      expect(JSON.stringify(sanitizeTemplateDisplayParts([{kind:'html',text:html}]))).not.toContain('SECRET')
    }
  })
  it.each(["'",'"'])('只有等号后的 %s 才开启属性引号语境',(quote)=>{
    for(const malformed of [
      `<div ${quote}><think>SECRET</think>${quote}>VISIBLE`,
      `<div =${quote}><think>SECRET</think>${quote}>VISIBLE`,
      `<div /=${quote}><think>SECRET</think>${quote}>VISIBLE`,
      `<div a /=${quote}><think>SECRET</think>${quote}>VISIBLE`,
      `<div a/=${quote}><think>SECRET</think>${quote}>VISIBLE`,
      `<script>code</script a /=${quote}><think>SECRET</think>${quote}>VISIBLE`,
      `<script>code</script a/=${quote}><think>SECRET</think>${quote}>VISIBLE`,
    ]) {
      const projected=sanitizeTemplateDisplayParts([{kind:'html',text:malformed}])
      expect(JSON.stringify(projected)).not.toContain('SECRET')
      expect(JSON.stringify(projected)).toContain('VISIBLE')
    }
    const valid=`<div data-value=${quote}<think-box>属性字面量</think-box>${quote}>VISIBLE</div>`
    expect(sanitizeTemplateDisplayParts([{kind:'html',text:valid}])).toEqual([{kind:'html',text:valid}])
  })
  it('属性值经实体解码或二次展示也不能恢复机读内容',()=>{
    const samples=[
      '<style>.x::after{content:attr(data-secret)}</style><div class="x" data-secret="<think>SECRET</think>">VISIBLE</div>',
      '<input value="&lt;t&#104;ink&gt;SECRET&lt;/think&gt;">VISIBLE',
      '<div data-secret="&lt;think&Tab;x&gt;SECRET&lt;/think&gt;">VISIBLE</div>',
      '<iframe srcdoc="&amp;lt;think&amp;gt;SECRET&amp;lt;/think&amp;gt;"></iframe>VISIBLE',
      '<iframe srcdoc="&#38;lt;think&#38;gt;SECRET&#38;lt;/think&#38;gt;"></iframe>VISIBLE',
      '<iframe srcdoc="&#x26;lt;think&#x26;gt;SECRET&#x26;lt;/think&#x26;gt;"></iframe>VISIBLE',
      '<iframe srcdoc="&amp;#38;lt;think&amp;#38;gt;SECRET&amp;#38;lt;/think&amp;#38;gt;"></iframe>VISIBLE',
      '<iframe srcdoc="&amp;&num;60&semi;think&amp;&num;62&semi;SECRET&amp;&num;60&semi;/think&amp;&num;62&semi;"></iframe>VISIBLE',
      '<iframe srcdoc="&amp;&num;x3c&semi;think&amp;&num;x3e&semi;SECRET&amp;&num;x3c&semi;/think&amp;&num;x3e&semi;"></iframe>VISIBLE',
      '<div data=x<think>SECRET</think>VISIBLE</div>',
    ]
    for(const html of samples) for(const projected of [
      sanitizeTemplateDisplayParts([{kind:'html',text:html}]),
      disableInteractiveParts([{kind:'html',text:html}]),
    ]) {
      expect(JSON.stringify(projected)).not.toContain('SECRET')
      expect(JSON.stringify(projected)).toContain('VISIBLE')
    }
  })
  it('属性中的伪 script、bogus comment 与 raw 关闭标签不能遮蔽后续机读块',()=>{
    const samples=[
      '<div data=x<script><think>SECRET</think></script>VISIBLE</div>',
      '<?foo <script><think>SECRET</think></script>VISIBLE',
      '<!foo <script><think>SECRET</think></script>VISIBLE',
      '</?foo <script><think>SECRET</think></script>VISIBLE',
    ]
    for(const html of samples) for(const projected of [
      sanitizeTemplateDisplayParts([{kind:'html',text:html}]),
      disableInteractiveParts([{kind:'html',text:html}]),
    ]) {
      expect(JSON.stringify(projected)).not.toContain('SECRET')
      expect(JSON.stringify(projected)).toContain('VISIBLE')
    }
  })
  it('普通 data 文本中的实体机读标签按浏览器可见值清理',()=>{
    const samples=[
      '<!DOCTYPE html><html><body><div>&lt;t&#104;ink&gt;SECRET&lt;/think&gt;</div>VISIBLE</body></html>',
      '<div>&#60;Analysis&#62;SECRET&#60;/Analysis&#62;</div>VISIBLE',
      'plain &lt;think&gt;SECRET&lt;/think&gt; VISIBLE',
    ]
    for(const html of samples) for(const projected of [
      sanitizeTemplateDisplayParts([{kind:'html',text:html}]),
      disableInteractiveParts([{kind:'html',text:html}]),
    ]) {
      expect(JSON.stringify(projected)).not.toContain('SECRET')
      expect(JSON.stringify(projected)).toContain('VISIBLE')
    }
  })
  it('实体机读边界可跨普通标签与 RCDATA 配对，闭合后的公开正文仍保留',()=>{
    const samples=[
      '&lt;think&gt;SECRET<span>X</span>&lt;/think&gt;VISIBLE',
      '<think>SECRET<textarea>&lt;/think&gt;</textarea>VISIBLE',
    ]
    for(const html of samples) {
      const projected=sanitizeTemplateDisplayParts([{kind:'html',text:html}])
      expect(JSON.stringify(projected)).not.toMatch(/SECRET|>X</)
      expect(JSON.stringify(projected)).toContain('VISIBLE')
    }
    for(const html of [
      '<think>SECRET<div data="</think>"></div>TAIL',
      '<think>SECRET<select><option data="</think>">TAIL</option></select>VISIBLE',
    ]) expect(sanitizeTemplateDisplayParts([{kind:'html',text:html}])).toEqual([])
  })
  it('不可见声明与 select 脚本字面量里的 closer 不能关闭外层机读边界',()=>{
    const samples=[
      '<think>SECRET_A<!DOCTYPE html PUBLIC "</think>">SECRET_B',
      '<think>SECRET_A<![CDATA[</think>]]>SECRET_B',
      '<think>SECRET_A<select><script>const x="</think>"</script><option>SECRET_B</option></select>SECRET_C',
    ]
    for(const html of samples) {
      const serialized=JSON.stringify(sanitizeTemplateDisplayParts([{kind:'html',text:html}]))
      expect(serialized).not.toMatch(/SECRET_[ABC]/)
    }
  })
  it('select/option 的属性伪闭标签不能提前退出可见文本扫描',()=>{
    const samples=[
      '<select><option data="</select><script>">X<think>SECRET</think></script>VISIBLE</option></select>',
      '<option label="</option><script><think>SECRET</think></script>">VISIBLE</option>',
    ]
    for(const html of samples) for(const projected of [
      sanitizeTemplateDisplayParts([{kind:'html',text:html}]),
      disableInteractiveParts([{kind:'html',text:html}]),
    ]) {
      expect(JSON.stringify(projected)).not.toContain('SECRET')
      expect(JSON.stringify(projected)).toContain('VISIBLE')
    }
  })
  it.each(['PUBLIC','SYSTEM'])('DOCTYPE %s 标识的引号内大于号不提前结束声明',(kind)=>{
    const html=`<!DOCTYPE html ${kind} "x> <script>"><html><body><think>SECRET</think></script>VISIBLE</body></html>`
    for(const projected of [sanitizeTemplateDisplayParts([{kind:'html',text:html}]),disableInteractiveParts([{kind:'html',text:html}])]) {
      expect(JSON.stringify(projected)).not.toContain('SECRET')
      expect(JSON.stringify(projected)).toContain('VISIBLE')
    }
  })
  it('嵌套 MathML 中的 script 是可见外来元素，不能开启 HTML raw-text 豁免',()=>{
    const samples=[
      '<math><mrow><math><mtext>INNER</mtext></math><script><mtext><think>SECRET</think></mtext></script>'
        + '<mtext>VISIBLE</mtext></mrow></math>',
      '<math><![CDATA[<x></math><script><think>SECRET</think></script>]]></math>VISIBLE',
    ]
    for(const html of samples) for(const projected of [
      sanitizeTemplateDisplayParts([{kind:'html',text:html}]),disableInteractiveParts([{kind:'html',text:html}]),
    ]) {
      expect(JSON.stringify(projected)).not.toContain('SECRET')
      expect(JSON.stringify(projected)).toContain('VISIBLE')
    }
  })
  it('SVG title 属性里的伪闭标签不能退出外来可见文本语境',()=>{
    const html='<svg><title><g data="</title><script>"></g><think>SECRET</think></script>VISIBLE</title>'
      + '<rect width="1" height="1"/></svg>'
    for(const projected of [sanitizeTemplateDisplayParts([{kind:'html',text:html}]),disableInteractiveParts([{kind:'html',text:html}])]) {
      expect(JSON.stringify(projected)).not.toContain('SECRET')
      expect(JSON.stringify(projected)).toContain('VISIBLE')
    }
  })
  it('CDATA 与可见 raw-text 容器中的机读边界不会被 script/style 字面量遮蔽',()=>{
    const samples=[
      '<svg><text><![CDATA[<script><think>SECRET</think></script>VISIBLE]]></text></svg>',
      '<style>body::before{content:"<script><think>SECRET</think></script>VISIBLE"}</style>',
      '<select><option><style><think>SECRET</think></style>VISIBLE</option></select>',
      '<datalist><option><style><think>SECRET</think></style>VISIBLE</option></datalist>',
      '<textarea>前文&lt;t&#104;ink&gt;SECRET&lt;/think&gt;后文</textarea>',
      '<title>前文&lt;think&gt;SECRET&lt;/think&gt;后文</title>',
      '<select><option>前文&lt;think&gt;SECRET&lt;/think&gt;后文</option></select>',
    ]
    for(const html of samples) for(const projected of [
      sanitizeTemplateDisplayParts([{kind:'html',text:html}]),
      disableInteractiveParts([{kind:'html',text:html}]),
    ]) {
      const serialized=JSON.stringify(projected)
      expect(serialized).not.toContain('SECRET')
      expect(serialized).toMatch(/VISIBLE|前文|后文/)
    }
  })
  it('CDATA 内未闭合机读 opener 与外层及后续 part 共用隐私边界',()=>{
    for(const parts of [
      [{kind:'html' as const,text:'<svg><![CDATA[<think>SECRET_A]]></svg>SECRET_B</think>VISIBLE'}],
      [{kind:'html' as const,text:'<svg><![CDATA[<think>SECRET_A]]></svg>SECRET_B'},
        {kind:'markdown' as const,text:'SECRET_C</think>VISIBLE'}],
    ]) for(const projected of [sanitizeTemplateDisplayParts(parts),disableInteractiveParts(parts)]) {
      const serialized=JSON.stringify(projected)
      expect(serialized).not.toMatch(/SECRET_[ABC]/)
      expect(serialized).toContain('VISIBLE')
    }
  })
  it.each(['<think data=x/>SECRET','<think data=/>SECRET','<think / >SECRET'])(
    '属性值末尾斜线不伪造自闭机读标签：%s',(html)=>{
      expect(sanitizeTemplateDisplayParts([{kind:'html',text:html}])).toEqual([])
    })
  it('大量普通 ampersand 属性仍按线性边界完成清理',()=>{
    const padding='&x'.repeat(50_000)
    const result=sanitizeTemplateDisplayParts([{kind:'html',text:`<div data-value="${padding}<think>SECRET</think>">VISIBLE</div>`}])
    expect(JSON.stringify(result)).not.toContain('SECRET')
    expect(JSON.stringify(result)).toContain('VISIBLE')
  })
  it('单个畸形标签内大量机读属性名候选不重复向后扫描',()=>{
    const html=`<div ${'<think '.repeat(10_000)}>SECRET`
    expect(JSON.stringify(sanitizeTemplateDisplayParts([{kind:'html',text:html}]))).not.toContain('SECRET')
  })
  it('展示正则逐片段处理，不能跨 iframe 边界删除正文或吞掉折叠标题',async()=>{
    const rule:RegexRule={id:'r',name:'display',find:'/one|two/g',replace:'changed',enabled:true,scopes:['output'],timing:['render'],minDepth:null,maxDepth:null,substituteRegex:0,source:'user'}
    const result=await isolated('display',{parts:[{kind:'markdown',text:'one'},{kind:'html',text:'<b>two</b>',title:'two'},{kind:'markdown',text:'three'}],rules:[rule,{...rule,id:'cross',find:'/changed[\\s\\S]*three/',replace:'wrong'}],macroCtx:{char:'A',user:'B',outlets:{}}})
    expect(result.parts).toEqual([{kind:'markdown',text:'changed'},{kind:'html',text:'<b>changed</b>',title:'two'},{kind:'markdown',text:'three'}])
  })
  it('展示正则跨片段生成机读边界时先整体收起，再拆出真正可见的卡面',async()=>{
    const base:RegexRule={id:'open',name:'display',find:'OPEN',replace:'<think>隐藏开头',enabled:true,scopes:['output'],timing:['render'],minDepth:null,maxDepth:null,substituteRegex:0,source:'user'}
    const result=await isolated('display',{parts:[
      {kind:'markdown',text:'OPEN'}, {kind:'html',text:'<div>跨段秘密</div>',title:'隐藏标题'}, {kind:'markdown',text:'CLOSE'},
    ],rules:[base,{...base,id:'close',find:'CLOSE',replace:'尾部秘密</think>公开\n[card]'},
      {...base,id:'card',find:'\\[card\\]',replace:'<div>可见卡</div>'}],macroCtx:{char:'A',user:'B',outlets:{}}})
    expect(result.parts).toEqual([{kind:'markdown',text:'公开'},{kind:'html',text:'<div>可见卡</div>'}])
    expect(JSON.stringify(result)).not.toMatch(/跨段秘密|尾部秘密|隐藏标题/)
  })
  it('BEFORE、正文与 AFTER 跨来源机读边界在 HTML 定位前整体收起',async()=>{
    const result=await render('<div>跨源隐藏卡</div>',[
      {uid:1,comment:'before',content:'@@render_before\n<think>隐藏开头'},
      {uid:2,comment:'after',content:'@@render_after\n尾部秘密</think>公开\n<div>可见卡</div>'},
    ])
    expect(result.parts[0]).toEqual([{kind:'markdown',text:'公开'},{kind:'html',text:'<div>可见卡</div>'}])
    expect(JSON.stringify(result.parts[0])).not.toMatch(/跨源隐藏卡|尾部秘密|隐藏开头/)
  })
  it('展示正则生成的折叠日志与末尾样式在同一个卡面交付',async()=>{
    const widget='<div class="record"><details><summary>变更记录</summary><div style="opacity:0">测试条目</div></details></div>\n<style>.record details[open]>div{opacity:1!important}</style>'
    const rule:RegexRule={id:'log',name:'log',find:'\\[record\\]',replace:widget,enabled:true,scopes:['output'],timing:['render'],minDepth:null,maxDepth:null,substituteRegex:0,source:'user'}
    const result=await isolated('display',{parts:[{kind:'markdown',text:'前文\n[record]\n后文'}],rules:[rule],macroCtx:{char:'A',user:'B',outlets:{}}})
    expect(result.parts).toEqual([{kind:'markdown',text:'前文'},{kind:'html',text:widget},{kind:'markdown',text:'后文'}])
  })
})

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true})})
it('真实剧情落盘后按顺序重绘，资产修改和重复读取不重跑脚本，关闭卡面不泄漏原始 EJS',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tavern-display-')); roots.push(root)
  const paths={root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')}
  const state=new TavernState(paths,()=>resolveConfig({}));await state.init()
  const {cardId}=await importCard(paths.characters,parseJsonCard({name:'A',description:'角色',character_book:{entries:[
    {uid:1,comment:'status',content:'@@render_after\n@@iframe 状态\n<div><%- getvar("count") %></div>'},
  ]}}))
  await saveBinding(paths,{sessionId:'s1',cardId,cardName:'A',presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
  await onTurnStart(state,'s1',1)
  await runTavernPipeline({state,sessionId:'s1',agent:null,mode:'live',historyOverride:[{role:'user',content:'hi'}]})
  const text='<% incvar("count") %><%= "**完成**" %>'
  const events=[
    {type:'assistant/message',seq:5,time:0,data:{stream: [{type:'chunk',time:0,chunk:{type:'finish',reason:{kind:'stop'}}}], turn:1,step:1,message:createAssistantMessage({source:{provider:'factory',model:'factory'},content:[{type:'text',text}]})}},
    {type:'turn/end',seq:6,time:0,data:{turn:1,reason:{kind:'completed'}}}] as unknown as SessionEvent[]
  const session={id:'s1' as Session['id'],snapshotEvents:()=>events}
  await onTurnEnd(state,'s1',session)
  const binding=(await state.loadBinding('s1'))!,ws=await state.storyWorkspace(cardId,binding.storyId)
  const stored=await loadTemplateState(ws.fs),before=await ws.fs.readText(TEMPLATE_STATE_PATH)
  expect(stored.outputs['5']?.parts).toEqual([{kind:'html',text:'<p><strong>完成</strong></p>'},{kind:'html',text:'<div>1</div>',title:'状态'}])
  expect(stored.outputs['5']?.partsVersion).toBe(TEMPLATE_DISPLAY_PARTS_VERSION)
  await state.saveCharacter(cardId,{characterBook:{entries:[]}})
  const config=(TavernConfigSchema as (input:unknown)=>TavernConfigRaw)({})
  let live:typeof session|undefined=session
  let storedEvents=events, inspections=0
  const persistence={open:async(id:string,access:string)=>{expect(access).toBe('read');inspections++;return {id,header:{id},read:async()=>({events:storedEvents}),close:async()=>{}}},
    load:()=>{throw new Error('展示不能修复或落盘宿主日志')}}
  const ctx={reflect:{provide:()=>{}},get:(key:string)=>key==='sessionPersistence'?persistence:undefined,sessions:{get:()=>live}} as unknown as Context
  const service=new TavernService(ctx,state,{get:()=>config} as unknown as SettingsScope<TavernConfigRaw>)
  for(let i=0;i<2;i++) expect((await service.renderOutputText({sessionId:'s1',text,messageId:5})).parts).toEqual(stored.outputs['5']?.parts)
  config.interactiveCards=false
  const disabled=await service.renderOutputText({sessionId:'s1',text,messageId:5})
  expect(disabled.userName).toBe('User')
  expect(disabled.text).toContain('完成')
  expect(disabled.text).not.toContain('<%')
  expect(disabled.htmls).toEqual([])
  expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBe(before)
  expect((await loadTemplateState(ws.fs)).variables.message.count).toBe(1)
  await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
  expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
  // 重启后旧会话可只存在持久日志；展示不能把开场白误认成未提交回复。
  live=undefined
  const greeting='<% setvar("preview",42) %>已恢复开场白:<%- getvar("preview") %>'
  storedEvents=[{type:'assistant/message',seq:5,time:0,data:{stream: [], turn:1,step:1,
    message:createAssistantMessage({content:[{type:'text',text:greeting}],source:TAVERN_GREETING_SOURCE})}}] as unknown as SessionEvent[]
  expect((await service.getSessionBinding({sessionId:'s1'})).conversationStarted).toBe(true)
  expect((await service.clearSessionBinding({sessionId:'s1',onlyIfBlank:true})).cleared).toBe(false)
  expect((await service.renderOutputText({sessionId:'s1',text:greeting,messageId:5})).text).toBe('已恢复开场白:42')
  expect(inspections).toBeGreaterThan(0)
  expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
  storedEvents=events
  await expect(service.renderOutputText({sessionId:'s1',text:greeting,messageId:5})).rejects.toThrow(/未成功提交/)
})
