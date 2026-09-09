/** 展示模板兼容：真实 QuickJS/Showdown、持久化回复和服务重绘验证顺序、隔离交付及只读边界。 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SettingsScope } from '@deepseek-ai/dsh-settings'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { createRequire } from 'node:module'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { parseTemplateDisplayParts, splitTemplateDisplay } from '../src/core/templateDisplay.js'
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
const official=createRequire(import.meta.url)('showdown') as {Converter:new(options:Record<string,unknown>)=>{makeHtml:(text:string)=>string}}

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
    expect(result.parts[0]?.[0]?.text).toContain('<details><summary>内层</summary>内容</details>')
    expect(result.parts[0]?.[1]).toMatchObject({kind:'html',title:'状态'})
    expect(result.parts[0]?.[1]?.text).toContain('<strong>生命</strong>')
    expect(result.parts[0]?.[1]?.text).toContain('<script>')
  })
  it('QuickJS 的捕获适配与官方 Showdown 的代码块、HTML、表格和 emoji 输出一致',async()=>{
    const converter=new official.Converter({emoji:true,literalMidWordUnderscores:true,parseImgDimensions:true,tables:true,underline:true,simpleLineBreaks:true,strikethrough:true,disableForced4SpacesIndentedSublists:true,metadata:false,noHeaderId:true,tablesHeaderId:false})
    const samples=['```html\n<p>代码里的 HTML</p>\n```','`<b>code</b>` :smile: **bold**','<details><summary>标题</summary>内容</details>',
      '| one | two |\n|---|---|\n| ~~strike~~ | __underline__ |','> quote\n\nnext_line\nsecond line']
    for(const sample of samples) {
      const actual=await render('',[{uid:1,comment:'format',content:'@@render_after\n@@message_formatting\n'+sample}])
      expect(actual.parts[0]).toEqual([{kind:'html',text:converter.makeHtml(sample)}])
    }
  })
  it('普通片段拆分保留开头和结尾；展示边界拒绝坏数据及无界输出',()=>{
    expect(splitTemplateDisplay('before\n<html><body>one</body></html>\nmiddle\n```html\n<html><body>two</body></html>\n```\nafter').map(p=>p.kind)).toEqual(['markdown','html','markdown','html','markdown'])
    for(const bad of [[{kind:'script',text:'x'}],[{kind:'markdown',text:'x',title:'bad'}],[{kind:'html',text:'x',title:8}],[{kind:'html',text:'x'.repeat(1024*1024+1)}],Array.from({length:129},()=>({kind:'markdown',text:'x'}))]) expect(()=>parseTemplateDisplayParts(bad)).toThrow()
  })
  it('展示正则逐片段处理，不能跨 iframe 边界删除正文或吞掉折叠标题',async()=>{
    const rule:RegexRule={id:'r',name:'display',find:'/one|two/g',replace:'changed',enabled:true,scopes:['output'],timing:['render'],minDepth:null,maxDepth:null,substituteRegex:0,source:'user'}
    const result=await isolated('display',{parts:[{kind:'markdown',text:'one'},{kind:'html',text:'<b>two</b>',title:'two'},{kind:'markdown',text:'three'}],rules:[rule,{...rule,id:'cross',find:'/changed[\\s\\S]*three/',replace:'wrong'}],macroCtx:{char:'A',user:'B',outlets:{}}})
    expect(result.parts).toEqual([{kind:'markdown',text:'changed'},{kind:'html',text:'<b>changed</b>',title:'two'},{kind:'markdown',text:'three'}])
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
  const events=[{type:'assistant/chunk',seq:4,time:0,data:{turn:1,step:1,chunk:{type:'finish',reason:{kind:'stop'}}}},
    {type:'assistant/message',seq:5,time:0,data:{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text}]})}},
    {type:'turn/end',seq:6,time:0,data:{turn:1,reason:{kind:'completed'}}}] as unknown as SessionEvent[]
  const session={id:'s1' as Session['id'],snapshotEvents:()=>events}
  await onTurnEnd(state,'s1',session)
  const binding=(await state.loadBinding('s1'))!,ws=await state.storyWorkspace(cardId,binding.storyId)
  const stored=await loadTemplateState(ws.fs),before=await ws.fs.readText(TEMPLATE_STATE_PATH)
  expect(stored.outputs['5']?.parts).toEqual([{kind:'html',text:'<p><strong>完成</strong></p>'},{kind:'html',text:'<div>1</div>',title:'状态'}])
  await state.saveCharacter(cardId,{characterBook:{entries:[]}})
  const config=(TavernConfigSchema as (input:unknown)=>TavernConfigRaw)({})
  let live:typeof session|undefined=session
  let storedEvents=events, inspections=0
  const persistence={inspect:async(id:string)=>{inspections++;return {meta:{id},events:storedEvents}},
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
  storedEvents=[{type:'assistant/message',seq:5,time:0,data:{turn:1,step:1,
    message:createAssistantMessage({content:[{type:'text',text:greeting}],source:TAVERN_GREETING_SOURCE})}}] as unknown as SessionEvent[]
  expect((await service.getSessionBinding({sessionId:'s1'})).conversationStarted).toBe(true)
  expect((await service.clearSessionBinding({sessionId:'s1',onlyIfBlank:true})).cleared).toBe(false)
  expect((await service.renderOutputText({sessionId:'s1',text:greeting,messageId:5})).text).toBe('已恢复开场白:42')
  expect(inspections).toBeGreaterThan(0)
  expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
  storedEvents=events
  await expect(service.renderOutputText({sessionId:'s1',text:greeting,messageId:5})).rejects.toThrow(/未成功提交/)
})
