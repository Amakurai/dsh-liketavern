/** 跨轮模板续存行为：真实隔离 worker 经 JSON 往返重建注册表与共享闭包，验证计数、时钟、资产刷新和失败边界。 */
import { describe, expect, it } from 'vitest'
import { defaultPreset } from '../src/core/assemble.js'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { emptyTemplateMessageVariables, visibleTemplateMessageVariables } from '../src/core/templateMessageVariables.js'
import type { TemplateContinuation } from '../src/core/templateContinuation.js'
import { hasTemplateStickyClosures } from '../src/core/templateSticky.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE, type ChatMessage } from '../src/core/types.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'
import { isolated } from '../src/node/isolated.js'
import { parseLorebook } from '../src/state/lorebook.js'
import { parseTemplateContinuation, resolveTemplateContinuation, templatePreloadRevision } from '../src/state/templateContinuation.js'
import { parseTemplateReplay } from '../src/state/templateGeneration.js'
import type { TemplateState } from '../src/state/template.js'

const json=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T
function request(main:string,lore:Record<string,unknown>[]=[],patch:Partial<TemplateContext>={},carry?:TemplateContinuation):ComputeJobs['assemble']['input'] {
  const entries=parseLorebook({entries:lore.map((entry,index)=>({uid:index+1,constant:true,...entry}))},{source:'character',sourceRef:'card'})
  const preset=defaultPreset();preset.entries=preset.entries.filter(entry=>['main','chatHistory'].includes(entry.identifier))
  preset.entries.find(entry=>entry.identifier==='main')!.content=main
  const history=patch.history??[{role:'user',content:'USER'}]
  const templates:TemplateContext={variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{name:'Alice'},entries,presets:preset.entries,history,
    historyIdentities:history.map((_,index)=>({messageId:'m'+index,swipeId:0})),messageVariables:emptyTemplateMessageVariables(),now:1000,seed:42,phase:'generate',...patch}
  templates.messageVariables=visibleTemplateMessageVariables(templates.messageVariables,templates.historyIdentities!)
  return {preset,card:null,personaDescription:'',history:templates.history,wi:null,memories:[],worldDeltas:[],regexRules:[],
    macroCtx:{char:templates.char,user:templates.user},seed:templates.seed,budget:{maxTokens:100000,reserveForOutput:0},templates,
    wiEvaluation:{entries,messages:templates.history,settings:DEFAULT_WI_SETTINGS,timerState:EMPTY_TIMER_STATE,contextWindowTokens:100000,reservedTokens:0,seed:templates.seed},
    ...(carry?{templateContinuation:json(carry)}:{})}
}
type Generation=ComputeJobs['assemble']['output']
function afterGeneration(generation:Generation):TemplateContinuation {
  const carry=generation.templateContinuation!
  return json({...carry,...(hasTemplateStickyClosures(carry.state)?{replay:generation.templateReplay!}:{})})
}
async function reply(input:ComputeJobs['assemble']['input'],generation:Generation,text:string,turn=1) {
  const previous=input.templates!,index=previous.history.length
  const history:ChatMessage[]=[...previous.history,{role:'assistant',content:text,name:previous.char}]
  const historyIdentities=[...previous.historyIdentities!,{messageId:'reply-'+turn,hostMessageId:turn*100,swipeId:0 as const}]
  const context:TemplateContext={...previous,phase:'render',history,historyIdentities,variables:generation.templateVariables!,
    messageVariables:generation.templateMessageVariables??emptyTemplateMessageVariables(),regexRules:generation.templateRegexRules,
    hasMessageRegex:generation.templateHasMessageRegex,renderMessages:[{index,role:'assistant',name:previous.char,swipeId:0,hostMessageId:turn*100}]}
  const result=await isolated('template',{texts:[text],context,replay:json(generation.templateReplay!),
    templateContinuation:json(generation.templateContinuation!),decorateOutput:true})
  return {result,context}
}

describe('跨轮 sticky 续存',()=>{
  it('prompt sticky=1 覆盖两次生成，重建 preload 不续期、不复活，资产真实刷新才注册新值',async()=>{
    const main='<%- getPromptsInjected("p") %>|BASE'
    const lore=[{comment:'preload',content:'@@only_preload\n<% injectPrompt("p","OLD",100,1,"id") %>'}]
    let carry:TemplateContinuation|undefined
    const outputs:string[]=[]
    for(let turn=0;turn<3;turn++) {
      const result=await isolated('assemble',request(main,lore,{},carry))
      outputs.push(result.messages[0]!.content);carry=json(result.templateContinuation!)
    }
    expect(outputs).toEqual(['OLD|BASE','OLD|BASE','|BASE'])
    expect(carry!.replay).toBeUndefined()
    expect(carry!.state.tombstones.prompts).toEqual([{key:'p',uid:'id'}])
    const refreshed=await isolated('assemble',request(main,[{comment:'preload',content:'@@only_preload\n<% injectPrompt("p","NEW",100,1,"id") %>'}],{},carry))
    expect(refreshed.messages[0]?.content).toBe('NEW|BASE')
    expect(refreshed.templateContinuation?.state.prompts[0]?.sticky).toBe(0)
  })

  it('generate/message sticky=2 使用不同清理时点，生成后的 carry 仍可供当轮回复使用',async()=>{
    const main=`<% if(!getvar('registered')){setvar('registered',true);activateRegex(/G[E]N/g,'generated',{uuid:'g',generate:true,sticky:2});activateRegex(/R[E]PLY/g,'replied',{uuid:'m',message:true,sticky:2})} %>ROOT`
    let carry:TemplateContinuation|undefined,variables=emptyTemplateScopes(),messageVariables=emptyTemplateMessageVariables()
    const found:string[][]=[]
    for(let turn=1;turn<=3;turn++) {
      const input=request(main,[],{variables,messageVariables,history:[{role:'user',content:'GEN'}],historyIdentities:[{messageId:'user-'+turn,swipeId:0}]},carry)
      const generation=await isolated('assemble',input),rendered=await reply(input,generation,'REPLY',turn)
      found.push([generation.history.at(-1)!.content,rendered.result.texts[0]!])
      variables=rendered.result.variables;messageVariables=rendered.result.messageVariables;carry=json(rendered.result.templateContinuation!)
    }
    expect(found).toEqual([['generated','replied'],['generated','replied'],['GEN','REPLY']])
    expect(carry!.state.regex.generate).toEqual([])
    expect(carry!.state.regex.message).toEqual([])
  })

  it('共享 let 闭包经生成、回复、下一轮及 JSON 恢复连续，历史写入不再次累加',async()=>{
    const main=`<% if(!getvar('registered')){setvar('registered',true);let n=0;const next=function(){incvar('calls');return String(++n)+'@'+this.runType};activateRegex(/P[I]NG/g,next,{uuid:'shared',generate:true,message:true,sticky:2,system:false});} %>ROOT`
    const input1=request(main,[],{history:[{role:'user',content:'PING'}],historyIdentities:[{messageId:'user-1',swipeId:0}]})
    const generation1=await isolated('assemble',input1),reply1=await reply(input1,generation1,'PING',1)
    expect(generation1.history[0]?.content).toBe('1@generate')
    expect(reply1.result.texts).toEqual(['2@render'])
    expect(reply1.result.variables.message.calls).toBe(2)
    const input2=request(main,[],{variables:reply1.result.variables,messageVariables:reply1.result.messageVariables,
      history:[...reply1.context.history,{role:'user',content:'PING'}],historyIdentities:[...reply1.context.historyIdentities!,{messageId:'user-2',swipeId:0}]},json(reply1.result.templateContinuation!))
    const generation2=await isolated('assemble',input2),reply2=await reply(input2,generation2,'PING',2)
    // 原始历史里的 user 和 assistant 仍各匹配一次，加上当前 user；重放旧调用本身不得增加当前计数。
    expect(generation2.history.map(message=>message.content)).toEqual(['3@generate','4@generate','5@generate'])
    expect(reply2.result.texts).toEqual(['6@render'])
    expect(reply2.result.variables.message.calls).toBe(6)
    const input3=request(main,[],{variables:reply2.result.variables,messageVariables:reply2.result.messageVariables,
      history:[...reply2.context.history,{role:'user',content:'PING'}],historyIdentities:[...reply2.context.historyIdentities!,{messageId:'user-3',swipeId:0}]},json(reply2.result.templateContinuation!))
    const generation3=await isolated('assemble',input3)
    expect(generation3.templateVariables?.message.calls).toBe(6)
    expect(generation3.templateContinuation?.replay).toBeUndefined()
    expect(generation3.templateContinuation?.state.regex.message).toEqual([])
  })

  it('新一轮重置当前 seed/时钟/资产上下文，旧闭包保留捕获的旧值',async()=>{
    const main=`<% if(!getvar('registered')){setvar('registered',true);const born=Date.now(),original=charName;activateRegex(/T[O]KEN/g,function(){return JSON.stringify([original,born,this.charName,Date.now(),Math.random()])},{uuid:'context',generate:true,assistant:false,system:false,sticky:3});} %>ROOT`
    const input1=request(main,[],{now:1000,seed:10,history:[{role:'user',content:'TOKEN'}],historyIdentities:[{messageId:'user-1',swipeId:0}]})
    const first=await isolated('assemble',input1)
    const input2=request(main,[],{char:'NewName',card:{name:'NewName'},now:9000,seed:7,variables:first.templateVariables!,
      messageVariables:first.templateMessageVariables,history:[{role:'user',content:'TOKEN'}],historyIdentities:[{messageId:'user-2',swipeId:0}]},afterGeneration(first))
    const second=await isolated('assemble',input2)
    expect(JSON.parse(second.history[0]!.content)).toEqual(['Alice',1000,'NewName',9000,((Math.imul(7,1664525)+1013904223)>>>0)/4294967296])
    expect(second.templateVariables?.message.registered).toBe(true)
  })

  it('被篡改的回调身份、缺失日志和日志结果指纹均拒绝，原 carry 保持原字节',async()=>{
    const main=`<% if(!getvar('registered')){setvar('registered',true);const suffix='!';activateRegex(/T[O]KEN/g,()=> 'text'+suffix,{generate:true,sticky:3})} %>ROOT`
    const input=request(main,[],{history:[{role:'user',content:'TOKEN'}]}),first=await isolated('assemble',input)
    const carry=afterGeneration(first),original=JSON.stringify(carry)
    expect(carry.replay).toBeDefined()
    const without=json(carry);delete without.replay
    await expect(isolated('assemble',request(main,[],{variables:first.templateVariables!},without))).rejects.toThrow(/日志|重放|闭包/)
    const bad=json(carry);bad.replay!.operations[0]!.hash='0'.repeat(64)
    await expect(isolated('assemble',request(main,[],{variables:first.templateVariables!},bad))).rejects.toThrow(/重放|不一致/)
    const identity=json(carry),replacement=identity.state.regex.generate[0]!.replacement
    if(replacement.kind!=='callback')throw Error('callback fixture')
    replacement.identity='wrong'
    await expect(isolated('assemble',request(main,[],{variables:first.templateVariables!},identity))).rejects.toThrow(/身份|注册|不一致/)
    expect(JSON.stringify(carry)).toBe(original)
  })

  it('回复也必须核验 carry 注册表、资产指纹和日志，不能悄悄覆盖坏状态',async()=>{
    const input=request(`<% let n=0;activateRegex(/P[I]NG/g,()=>String(++n),{uuid:'reply',message:true,sticky:3}); %>ROOT`)
    const first=await isolated('assemble',input)
    const state=json(first);state.templateContinuation!.state.regex.message[0]!.sticky++
    await expect(reply(input,state,'PING')).rejects.toThrow(/注册|不一致/)
    const revision=json(first);revision.templateContinuation!.preloadRevision='0'.repeat(64)
    await expect(reply(input,revision,'PING')).rejects.toThrow(/指纹|日志|不一致/)
    const malformed=json(first);Object.assign(malformed.templateContinuation!,{unknown:true})
    await expect(reply(input,malformed,'PING')).rejects.toThrow(/损坏/)
    expect((await reply(input,first,'PING')).result.texts).toEqual(['1'])
  })

  it('跨轮可见旧消息的快照缺失或改变时拒绝，历史裁剪允许去除不可见快照',async()=>{
    const main=`<% if(!getvar('registered')){setvar('registered',true);activateRegex(/P[I]NG/g,()=> 'ok',{message:true,sticky:3});} %>ROOT`
    const input=request(main,[],{historyIdentities:[{messageId:'old',swipeId:0}]})
    const first=await isolated('assemble',input),carry=afterGeneration(first)
    const history:ChatMessage[]=[...input.templates!.history,{role:'user',content:'next'}]
    const historyIdentities=[...input.templates!.historyIdentities!,{messageId:'new',swipeId:0 as const}]
    const patch={variables:first.templateVariables!,history,historyIdentities}
    await expect(isolated('assemble',request(main,[],{...patch,messageVariables:emptyTemplateMessageVariables()},carry))).rejects.toThrow(/历史变量.*不一致/)
    const changed=json(first.templateMessageVariables!);changed.snapshots.old!.values.registered=false
    await expect(isolated('assemble',request(main,[],{...patch,messageVariables:changed},carry))).rejects.toThrow(/历史变量.*不一致/)
    const clipped=await isolated('assemble',request(main,[],{variables:first.templateVariables!,history:[{role:'user',content:'next'}],
      historyIdentities:[{messageId:'new',swipeId:0}],messageVariables:emptyTemplateMessageVariables()},carry))
    expect(Object.keys(clipped.templateMessageVariables!.snapshots)).toEqual(['new'])
    expect(clipped.templateContinuation!.state.regex.message[0]!.sticky).toBe(2)
  })

  it('持久化日志必须对应资产、变量和末态可见快照，额外不可见快照不参与校验',async()=>{
    const input=request(`<% let n=0;activateRegex(/P[I]NG/g,()=>String(++n),{message:true,sticky:3});setvar('saved',1) %>ROOT`)
    const first=await isolated('assemble',input),rendered=await reply(input,first,'PING')
    const stored:TemplateState={version:1,variables:json(rendered.result.variables),messageVariables:json(rendered.result.messageVariables),
      continuation:json(rendered.result.templateContinuation!),outputs:{}}
    expect(resolveTemplateContinuation(stored)).toEqual(stored.continuation)
    stored.messageVariables!.snapshots.hidden={values:{private:'kept in story'},initialized:true}
    expect(resolveTemplateContinuation(stored)).toEqual(stored.continuation)
    const revision=json(stored.continuation!);revision.preloadRevision='f'.repeat(64)
    expect(()=>parseTemplateContinuation(revision)).toThrow(/资产指纹.*不一致/)
    const variables=json(stored);variables.variables.message.saved=999
    expect(()=>resolveTemplateContinuation(variables)).toThrow(/已提交变量.*不一致/)
    const message=json(stored);message.messageVariables!.snapshots['reply-1']!.values.saved=999
    expect(()=>resolveTemplateContinuation(message)).toThrow(/已提交消息快照.*不一致/)
    const missing=json(stored);delete missing.messageVariables!.snapshots['reply-1']
    expect(()=>resolveTemplateContinuation(missing)).toThrow(/已提交消息快照.*不一致/)
  })

  it('资产指纹不受对象属性顺序、undefined 和持久化解析影响，仍区分数组次序与正文',async()=>{
    const input=request('ROOT',[{comment:'preload',content:'@@only_preload\n<% activateRegex(/X/,()=>"Y",{message:true,sticky:2}) %>'}],
      {card:{name:'Alice',nested:{z:1,a:2},unknown:undefined}})
    const first=await isolated('assemble',input),revision=first.templateContinuation!.preloadRevision
    const replay=parseTemplateReplay(json(first.templateReplay!))
    expect(templatePreloadRevision(replay.context)).toBe(revision)
    const reordered={...replay.context,card:{nested:{a:2,z:1},name:'Alice'}}
    expect(templatePreloadRevision(reordered)).toBe(revision)
    const changed=json(replay.context);changed.entries[0]!.content+='\nchanged'
    expect(templatePreloadRevision(changed)).not.toBe(revision)
    expect(templatePreloadRevision({...replay.context,presets:[...replay.context.presets].reverse()})).not.toBe(revision)
  })
})
