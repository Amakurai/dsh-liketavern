/** 结构共享的真实隔离恢复：长期回调在变化的系统提示词与消息快照下保持闭包捕获和旧日志行为。 */
import { describe, expect, it } from 'vitest'
import { defaultPreset } from '../src/core/assemble.js'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { emptyTemplateMessageVariables, visibleTemplateMessageVariables } from '../src/core/templateMessageVariables.js'
import type { TemplateContinuation } from '../src/core/templateContinuation.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE, type ChatMessage } from '../src/core/types.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'
import { isolated } from '../src/node/isolated.js'
import { parseLorebook } from '../src/state/lorebook.js'
import { parseTemplateReplay } from '../src/state/templateGeneration.js'
import { templateReplayData } from '../src/core/templateReplay.js'

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
/** 长期存活回调在历史首项每轮改变、消息快照增长时仍逐字节恢复；同时覆盖旧展开格式。 */
describe('结构共享实际闭包恢复',()=> {
  it('十六轮共享非前缀序列和消息变量，冷重建与旧内联日志保持闭包计数及捕获值',async()=> {
    const code=`<% setvar('payload','长期消息变量'.repeat(90));if(!getvar('registered')){setvar('registered',true);let n=0;const born=generateData.at(-1).content;activateRegex(/T[O]KEN/g,function(){return JSON.stringify([++n,born,this.lastUserMessage])},{uuid:'long',message:true,sticky:10000})} %>`
    let carry:TemplateContinuation|undefined,variables=emptyTemplateScopes(),messageVariables=emptyTemplateMessageVariables()
    let history:ChatMessage[]=[],historyIdentities:NonNullable<TemplateContext['historyIdentities']>=[]
    let latest:Generation|undefined,lastInput:ComputeJobs['assemble']['input']|undefined
    for(let turn=1;turn<=16;turn++) {
      const user='第'+turn+'轮'+('正文'.repeat(250))
      history=[...history,{role:'user',content:user}];historyIdentities=[...historyIdentities,{messageId:'user-'+turn,swipeId:0}]
      const input=request(code+'本轮提示词 '+turn,[],{variables,messageVariables,history,historyIdentities,now:turn*1000},carry)
      const generation=await isolated('assemble',input),rendered=await reply(input,generation,'TOKEN',turn)
      expect(JSON.parse(rendered.result.texts[0]!)).toEqual([turn,'第1轮'+('正文'.repeat(250)),user])
      variables=rendered.result.variables;messageVariables=rendered.result.messageVariables;carry=json(rendered.result.templateContinuation!)
      history=rendered.context.history;historyIdentities=rendered.context.historyIdentities!
      latest=generation;lastInput=input
    }
    const replay=latest!.templateReplay!,expand=templateReplayData(replay),{shared:_shared,...base}=replay
    expect(replay.shared!.some(item=>'jsonObjectPages' in item || 'jsonObject' in item)).toBe(true)
    expect(replay.operations.some(operation=>'refs' in operation && typeof operation.refs?.generateData==='number')).toBe(true)
    const inline=json({...base,operations:replay.operations.map(operation=> {
      if(!('data' in operation)) return operation
      const data=expand(operation)
      if(operation.kind==='phaseData')return {kind:'phase' as const,context:data as unknown as TemplateContext,refreshPreload:operation.refreshPreload,hash:operation.hash}
      const {refs:_refs,...rest}=operation;return {...rest,data}
    })})
    // 完整堆是两种恢复共同的基线；此用例比较检查点之后的结构共享尾日志，不能把相同堆正文重复计入压缩率。
    const {checkpoint:_sharedCheckpoint,...sharedTail}=replay
    const {checkpoint:_inlineCheckpoint,...inlineTail}=inline
    expect(JSON.stringify(sharedTail).length).toBeLessThan(JSON.stringify(inlineTail).length*0.35)
    expect(parseTemplateReplay(json(replay))).toEqual(replay)
    const old=(await reply(lastInput!,{...latest!,templateReplay:inline},'TOKEN',16)).result
    const current=(await reply(lastInput!,latest!,'TOKEN',16)).result
    expect(current.texts).toEqual(old.texts)
    expect(current.variables).toEqual(old.variables)
    expect(current.messageVariables).toEqual(old.messageVariables)
    expect(current.templateContinuation!.state).toEqual(old.templateContinuation!.state)
  },60000)
})
