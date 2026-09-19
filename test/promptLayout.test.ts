/** 可重放布局回归：真实历史只留身份，角色/深度及隔离模板注入在 JSON 重放后仍有准确位置。 */
import { describe, expect, it } from 'vitest'
import { assemblePrompt, defaultPreset, type AssembleInput } from '../src/core/assemble.js'
import { parsePromptLayout, promptHistoryAnchors } from '../src/core/promptLayout.js'
import { emptyTemplateScopes } from '../src/core/template.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE, Marker, type ChatMessage, type PresetEntry } from '../src/core/types.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'
import { isolated } from '../src/node/isolated.js'
import { parseLorebook } from '../src/state/lorebook.js'

const entry=(identifier:string,content:string,options:Partial<PresetEntry>={}):PresetEntry=>({identifier,name:identifier,content,
  role:'system',enabled:true,position:'relative',depth:0,order:10,marker:false,...options})
const historyMarker=()=>entry(Marker.ChatHistory,'',{marker:true,markerId:Marker.ChatHistory,order:20})
function input(entries:PresetEntry[],history:ChatMessage[]=[{role:'user',content:'PRIVATE-HISTORY'}]):AssembleInput {
  return {preset:{...defaultPreset(),entries},history,historyMessageIds:history.map((_,index)=>`message-${index}`),
    card:null,personaDescription:'',wi:null,memories:[],worldDeltas:[],regexRules:[],macroCtx:{char:'Alice',user:'Bob'},
    estimateTokens:text=>text.length,budget:{maxTokens:100000,reserveForOutput:0}}
}
function worker(lore:Record<string,unknown>[],main='<% incvar("mainRuns") %>MAIN'):ComputeJobs['assemble']['input'] {
  const value=input([entry('main',main),entry(Marker.WorldInfoBefore,'',{marker:true,markerId:Marker.WorldInfoBefore,order:15}),historyMarker()])
  const entries=parseLorebook({entries:lore.map((item,index)=>({uid:index+1,constant:true,...item}))},{source:'character',sourceRef:'card'})
  const {estimateTokens:_,...request}=value
  return {...request,seed:42,templates:{variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{},entries,
    presets:value.preset.entries,history:value.history,now:1000,seed:42,phase:'generate'},
    wiEvaluation:{entries,messages:value.history,settings:DEFAULT_WI_SETTINGS,timerState:EMPTY_TIMER_STATE,
      contextWindowTokens:100000,reservedTokens:0,seed:42}}
}

describe('真实历史锚点与冻结片段',()=> {
  it('保留相同正文的不同身份、角色、order、尾部 assistant，不复制历史正文',()=> {
    const request=input([entry('opening','RULE',{role:'user',order:2}),historyMarker(),
      entry('tail','ANSWER-START',{role:'assistant',order:30})],
    [{role:'user',content:'SAME-PRIVATE'},{role:'assistant',content:'SAME-PRIVATE'}])
    const original=structuredClone({...request,estimateTokens:undefined})
    const result=assemblePrompt(request),layout=result.layout!
    expect(layout.entries.map(value=>[value.role,value.content,value.placement.kind])).toEqual([
      ['user','RULE','before-history'],['assistant','ANSWER-START','after-history']])
    expect(layout.entries[0]!.placement).toMatchObject({order:2,anchor:{messageId:'message-0'}})
    expect(layout.entries[1]!.placement).toMatchObject({order:30,anchor:{messageId:'message-1'}})
    expect(layout.entries[0]!.sourceKeys).toContain('preset:opening')
    expect(JSON.stringify(layout)).not.toContain('SAME-PRIVATE')
    expect(JSON.stringify(layout)).not.toContain('prefill')
    expect(parsePromptLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout)
    expect({...request,estimateTokens:undefined}).toEqual(original)
  })

  it('深度只数真实聊天，包括纯图片空正文；system 与插件输入不挤占位置',()=> {
    const request=input([historyMarker(),entry('deep','DEPTH',{position:'in-chat',depth:2,order:9,role:'assistant'}),
      entry('zero','ZERO',{position:'in-chat',depth:0,order:2,role:'user'})],
    [{role:'system',content:'HOST'},{role:'user',content:'FIRST'},{role:'user',content:'PLUGIN'},
      {role:'assistant',content:''},{role:'user',content:'LAST'}])
    request.historyChatFlags=[false,true,false,true,true]
    const result=assemblePrompt(request)
    expect(result.layout!.entries.find(value=>value.content==='DEPTH')!.placement).toMatchObject({kind:'depth',depth:2,order:9,
      previous:{messageId:'message-1'},next:{messageId:'message-3'}})
    expect(result.layout!.entries.find(value=>value.content==='ZERO')!.placement).toMatchObject({kind:'depth',depth:0,
      previous:{messageId:'message-4'}})
    expect(result.layout!.history.map(value=>value.chat)).toEqual([false,true,false,true,true])
  })

  it('历史模板正则的 depth 元数据同样不计插件输入',()=> {
    const request=input([historyMarker()],[{role:'user',content:'A'},{role:'assistant',content:'B'},
      {role:'user',content:'NOTICE'},{role:'user',content:'C'}])
    request.historyChatFlags=[true,true,false,true]
    const seen:Array<[string,number]>=[]
    request.transformPrompt=(text,meta)=>{seen.push([text,meta.depth]);return text}
    assemblePrompt(request)
    expect(seen).toEqual([['A',2],['B',1],['NOTICE',1],['C',0]])
  })

  it('宏缺省值沿同一真实聊天标志取末条，插件用户与助手消息都不会替代台词',()=> {
    const request=input([entry('latest','LAST={{lastMessage}};USER={{lastUserMessage}};CHAR={{lastCharMessage}}'),historyMarker()],
      [{role:'user',content:'USER-LINE'},{role:'assistant',content:'CHAR-LINE'},
        {role:'user',content:'PLUGIN-USER'},{role:'assistant',content:'PLUGIN-ASSISTANT'}])
    request.historyChatFlags=[true,true,false,false]
    const result=assemblePrompt(request)
    expect(result.turnContext).toContain('LAST=CHAR-LINE;USER=USER-LINE;CHAR=CHAR-LINE')
    expect(result.standing).not.toContain('LAST=')
  })

  it('模拟裁剪与正文改写不改变布局锚点，不把本轮宏的值错归入稳定层',()=> {
    const request=input([entry('main','RULE'),historyMarker(),entry('latest','LAST={{lastMessage}}',{position:'in-chat',depth:1})],
      [{role:'user',content:'OLD-HISTORY'},{role:'assistant',content:'CURRENT'}])
    request.budget.maxTokens=1
    request.transformPrompt=text=>text==='OLD-HISTORY'?'CHANGED-HISTORY':text
    const result=assemblePrompt(request)
    expect(result.stats.trimmedSections).toContain('history')
    expect(result.layout!.history).toHaveLength(2)
    expect(result.layout!.entries.find(value=>value.content==='LAST=CURRENT')).toMatchObject({turnLocal:true,
      placement:{kind:'depth',previous:{messageId:'message-0'},next:{messageId:'message-1'}}})
    expect(result.messageProvenance).toHaveLength(result.messages.length)
    expect(JSON.stringify(result.layout)).not.toContain('CHANGED-HISTORY')
  })

  it('缺失 ID 只保留明确未映射项；数量不符与重复 ID 拒绝，不用正文猜测',()=> {
    expect(promptHistoryAnchors([{role:'user',content:''}],[undefined])[0]).not.toHaveProperty('messageId')
    expect(()=>promptHistoryAnchors([{role:'user',content:''}],[])).toThrow(/数量/)
    expect(()=>promptHistoryAnchors([{role:'user',content:'same'},{role:'assistant',content:'same'}],['one','one'])).toThrow(/重复/)
    expect(()=>promptHistoryAnchors([{role:'user',content:''}],['one'],[])).toThrow(/标志/)
  })

  it('旧 GENERATE 回调只给扁平文字时明确标记不可精确重放',()=> {
    const request=input([historyMarker()])
    request.renderTemplate=text=>text
    request.processTemplateSequence=()=>({turnContext:['LEGACY-INJECTION']})
    const layout=assemblePrompt(request).layout!
    expect(layout.entries).toEqual([expect.objectContaining({content:'LEGACY-INJECTION',compatibilityFallback:true})])
  })
})

describe('隔离模板的最终布局',()=> {
  it('GENERATE 的求值位置与冻结深度一致，非聊天通知不改变模板缓冲或历史 depth',async()=> {
    const request=worker([])
    const history:ChatMessage[]=[{role:'user',content:'USER_A|'},{role:'assistant',content:'ASSISTANT_B|'},
      {role:'user',content:'PLUGIN_NOTICE|'},{role:'user',content:'USER_C|'}]
    request.history=history;request.historyMessageIds=['a','b','notice','c'];request.historyChatFlags=[true,true,false,true]
    request.templates!.history=history;request.wiEvaluation!.messages=history
    request.preset.entries.push(entry('depth-buffer','DEPTH-BUFFER=<%- generateBuffer %>',{position:'in-chat',depth:2,order:3}),
      entry('near','NEAR',{position:'in-chat',depth:1,order:2}))
    const result=await isolated('assemble',request)
    expect(result.messages.map(value=>value.content)).toEqual(['MAIN','USER_A|','DEPTH-BUFFER=MAINUSER_A|','ASSISTANT_B|','PLUGIN_NOTICE|','NEAR','USER_C|'])
    expect(result.layout!.entries.find(value=>value.content.startsWith('DEPTH-BUFFER='))!.placement).toMatchObject({kind:'depth',
      previous:{messageId:'a'},next:{messageId:'b'}})
  })

  it('纯图片空正文保留后置 INSERT 的目标身份，不错误匹配上一条文字用户消息',async()=> {
    const request=worker([{comment:'@INJECT target=user,index=-1,at=before,role=assistant',content:'IMAGE-GUIDE'}])
    const history:ChatMessage[]=[{role:'user',content:'OLDER-TEXT'},{role:'user',content:''}]
    request.history=history;request.historyMessageIds=['older','current-image'];request.historyChatFlags=[true,true]
    request.templates!.history=history;request.wiEvaluation!.messages=history
    const result=await isolated('assemble',request)
    expect(result.layout!.entries.find(value=>value.content==='IMAGE-GUIDE')!.placement).toMatchObject({kind:'history-relative',
      anchor:{messageId:'current-image'},side:'before'})
    expect(result.messageProvenance!.at(-1)).toMatchObject({kind:'history',anchor:{messageId:'current-image'}})
  })

  it('空序列的全局 GENERATE 仍产生明确尾部片段，不误标为无法定位的旧回调',async()=> {
    const request=worker([{comment:'[GENERATE:BEFORE]',content:'BEGIN|'},{comment:'[GENERATE:AFTER]',content:'END'}],'')
    request.history=[];request.historyMessageIds=[]
    request.templates!.history=[];request.wiEvaluation!.messages=[]
    const result=await isolated('assemble',request)
    expect(result.layout!.entries).toEqual([expect.objectContaining({role:'system',content:'BEGIN|END',placement:{kind:'after-history'}})])
    expect(result.layout!.entries[0]).not.toHaveProperty('compatibilityFallback')
  })

  it('GENERATE 精确保留历史前后片段及全局尾部，重放不携带历史正文或旧通道副本',async()=> {
    const result=await isolated('assemble',worker([
      {comment:'[GENERATE:1:BEFORE]',content:'<% incvar("beforeRuns") %>BEFORE|'},
      {comment:'[GENERATE:1:AFTER]',content:'<% incvar("afterRuns") %>AFTER|'},
      {comment:'[GENERATE:AFTER]',content:'END'},
    ]))
    const layout=parsePromptLayout(JSON.parse(JSON.stringify(result.layout)))
    expect(layout.entries.map(value=>value.content)).toEqual(['MAIN','BEFORE|','AFTER|END'])
    expect(layout.entries[1]!.placement).toMatchObject({kind:'history-relative',anchor:{messageId:'message-0'},side:'before'})
    expect(layout.entries[2]!.placement).toMatchObject({kind:'history-relative',anchor:{messageId:'message-0'},side:'after'})
    expect(layout.entries.every(value=>!value.compatibilityFallback)).toBe(true)
    expect(JSON.stringify(layout)).not.toContain('PRIVATE-HISTORY')
    expect(JSON.stringify(layout)).not.toContain('tavern-source:')
    expect(result.templateVariables?.message).toMatchObject({mainRuns:1,beforeRuns:1,afterRuns:1})
  })

  it('INSERT 角色及对已生成片段的边界保留，后置命名出口同步最终正文',async()=> {
    const result=await isolated('assemble',worker([
      {comment:'[GENERATE:1:BEFORE]',content:'BEFORE|'},
      {comment:'@INJECT target=user,index=1,at=before,role=assistant',content:'<% incvar("insertRuns");injectPrompt("notes","FINAL") %>INSERT'},
      {comment:'@INJECT regex="INSERT",at=after,role=user',content:'AFTER-INSERT'},
    ],'RULE:<%- getPromptsInjected("notes") %>'))
    const layout=parsePromptLayout(JSON.parse(JSON.stringify(result.layout)))
    const before=layout.entries.find(value=>value.content==='BEFORE|')!
    const inserted=layout.entries.find(value=>value.content==='INSERT')!
    const after=layout.entries.find(value=>value.content==='AFTER-INSERT')!
    expect(layout.entries.some(value=>value.content==='RULE:FINAL')).toBe(true)
    expect(inserted).toMatchObject({role:'assistant',turnLocal:true,placement:{kind:'entry-relative',entryKey:before.key,side:'before'}})
    expect(after).toMatchObject({role:'user',placement:{kind:'entry-relative',entryKey:before.key,side:'before'}})
    expect(layout.entries.indexOf(after)).toBeGreaterThan(layout.entries.indexOf(inserted))
    expect(layout.entries.indexOf(after)).toBeLessThan(layout.entries.indexOf(before))
    expect(result.messageProvenance?.map(value=>value.kind)).toEqual(['layout','layout','layout','history'])
    expect(JSON.stringify(layout)).not.toContain('outletPromptsInjected:')
    expect(result.templateVariables?.message.insertRuns).toBe(1)
  })

  it('activewi 重组后的格式化世界书及全部新来源进入最终布局，副作用仍只执行一次',async()=> {
    const request=worker([
      {comment:'first',content:'<% incvar("firstRuns");await activewi("extra") %>FIRST'},
      {comment:'extra',constant:false,key:['never'],content:'<% incvar("extraRuns") %>EXTRA'},
    ])
    request.preset.formatting={worldInfo:'<lore>{0}</lore>'}
    const result=await isolated('assemble',request)
    const lore=result.layout!.entries.find(value=>value.content.includes('FIRST'))!
    expect(lore.content).toContain('<lore>FIRST')
    expect(lore.content).toContain('EXTRA</lore>')
    expect(lore.sourceKeys).toEqual(expect.arrayContaining(request.wiEvaluation!.entries.map(value=>value.key)))
    expect(JSON.stringify(result.layout)).not.toContain('tavern-source:')
    expect(result.templateVariables?.message).toMatchObject({mainRuns:1,firstRuns:1,extraRuns:1})
  })
})
