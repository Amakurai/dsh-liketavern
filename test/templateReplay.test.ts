/** 跨阶段闭包重建：真实隔离 worker 回放、JSON 传输、来源指纹与剧情 WAL，不重复提交生成变量。 */
import { describe,expect,it,afterEach } from 'vitest'
import { mkdtemp,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultPreset } from '../src/core/assemble.js'
import { DEFAULT_WI_SETTINGS,EMPTY_TIMER_STATE } from '../src/core/types.js'
import { emptyTemplateScopes } from '../src/core/template.js'
import { parseLorebook } from '../src/state/lorebook.js'
import { isolated } from '../src/node/isolated.js'
import { parseJsonCard } from '../src/state/card.js'
import { importCard } from '../src/state/workspace.js'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { saveBinding } from '../src/node/bindings.js'
import { onTurnStart,onTurnEnd } from '../src/node/sessionLifecycle.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { completeTemplateOutput } from '../src/node/templateOutput.js'
import { loadTemplateState,TEMPLATE_STATE_PATH } from '../src/state/template.js'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Session,SessionEvent } from '@deepseek-ai/dsh-session'

async function generation(script:string) {
  const entries=parseLorebook({entries:[{uid:1,comment:'[GENERATE:BEFORE]',constant:true,content:script}]},{source:'character',sourceRef:'card'})
  const history=[{role:'user' as const,content:'hello'}]
  const context={variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{},entries,presets:[],history,now:1000,seed:42,phase:'generate' as const}
  const result=await isolated('assemble',{preset:defaultPreset(),card:null,personaDescription:'',history,wi:null,memories:[],worldDeltas:[],regexRules:[],
    macroCtx:{char:'Alice',user:'Bob'},seed:42,budget:{maxTokens:100000,reserveForOutput:0},templates:context,
    wiEvaluation:{entries,messages:history,settings:DEFAULT_WI_SETTINGS,timerState:EMPTY_TIMER_STATE,contextWindowTokens:100000,reservedTokens:0,seed:42}})
  return {context,result}
}

describe('跨阶段模板回放',()=> {
  it('日期构造器、函数调用与原型路径均保持冻结时钟，无法取回原生实时构造器',async()=> {
    const {context,result}=await generation(`<% const date=new Date();define('clock',()=>[
      Date.now(),+new Date(),+new date.constructor(),+Reflect.construct(Date,[]),
      Date()===new Date(1000).toString(),Object.getPrototypeOf(Date)===Function.prototype,typeof NativeDate,
    ]); %>`)
    const reply=await isolated('template',{texts:['<%- JSON.stringify(clock()) %>'],replay:result.templateReplay,context:{...context,variables:result.templateVariables!,phase:'render'}})
    expect(JSON.parse(reply.texts[0]!)).toEqual([1000,1000,1000,1000,true,true,'undefined'])
  })
  it('JSON 往返后的记录在新 worker 重建局部闭包、schema、随机源与数组引用',async()=> {
    const {context,result}=await generation(`<%
      let calls=0; const limit=5; const values=[]; const random=Math.random();
      define('next',()=>{values.push(++calls);return values.join(',')});
      define('random',()=>random);
      setVariableSchema({hp:z.number().max(limit)});setvar('hp',1);incvar('runs');
      activateRegex(/word/g,()=>next(),{message:true});
    %>`)
    const replay=JSON.parse(JSON.stringify(result.templateReplay))
    const replyContext={...context,variables:result.templateVariables!,phase:'render' as const}
    const input={context:replyContext,replay,decorateOutput:true,texts:['<% incvar("hp") %><%- next() %>|word|<%- random() %>']}
    const reply=await isolated('template',input)
    expect(reply.texts[0]).toMatch(/^1,2\|1\|0\./)
    expect(reply.variables.message).toEqual({hp:2,runs:1})
    expect(await isolated('template',input)).toEqual(reply)
    await expect(isolated('template',{...input,texts:['<% setvar("hp",6) %>']})).rejects.toThrow()
    expect(result.templateVariables!.message).toEqual({hp:1,runs:1})
  })
  it('结果指纹不一致、已提交变量不一致均明确失败',async()=> {
    const {context,result}=await generation('<% define("value",()=>42);setvar("count",1) %>')
    const replay=structuredClone(result.templateReplay!)
    replay.operations.find(operation=>operation.kind==='render')!.hash='0'.repeat(64)
    await expect(isolated('template',{texts:['<%- value() %>'],context:{...context,variables:result.templateVariables!,phase:'render'},replay})).rejects.toThrow(/重放结果不一致/)
    await expect(isolated('template',{texts:['<%- value() %>'],context:{...context,variables:{...result.templateVariables!,message:{count:9}},phase:'render'},replay:result.templateReplay})).rejects.toThrow(/已提交状态不一致/)
  })
  it('主动激活重组的来源缓存不会让重放重复执行定义或变量增量',async()=> {
    const {context,result}=await generation('<% let n=0;define("closure",()=>++n);incvar("runs");await activewi("[GENERATE:BEFORE]") %>')
    const reply=await isolated('template',{texts:['<%- closure() %>/<%- closure() %>'],context:{...context,variables:result.templateVariables!,phase:'render'},replay:result.templateReplay})
    expect(reply.texts).toEqual(['1/2'])
    expect(reply.variables.message).toEqual({runs:1})
  })
})

const roots:string[]=[]
afterEach(async()=>{for(const root of roots.splice(0)) await rm(root,{recursive:true,force:true})})
function output(text:string,finish='stop'):Pick<Session,'id'|'snapshotEvents'> {
  return {id:'s1' as Session['id'],snapshotEvents:()=>[
    {type:'assistant/chunk',seq:4,time:0,data:{turn:1,step:1,chunk:{type:'finish',reason:{kind:finish}}}},
    {type:'assistant/message',seq:5,time:0,data:{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text}]})}},
    {type:'turn/end',seq:6,time:0,data:{turn:1,reason:{kind:'completed'}}},
  ] as unknown as SessionEvent[]}
}

describe('闭包剧情提交',()=> {
  it('冻结生成脚本支持回复回调，失败/重试不重写状态，最后随楼层回滚',async()=> {
    const root=await mkdtemp(join(tmpdir(),'tavern-replay-'));roots.push(root)
    const paths={root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')}
    const state=new TavernState(paths,()=>resolveConfig({}));await state.init()
    const card=parseJsonCard({name:'Alice',description:`<% const max=2;let uses=0;define('bump',()=>++uses);setVariableSchema({hp:z.number().max(max)});setvar('hp',1);incvar('runs');activateRegex(/word/g,()=>String(bump()),{message:true}) %>`})
    const {cardId}=await importCard(paths.characters,card)
    await saveBinding(paths,{sessionId:'s1',cardId,cardName:card.name,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
    const binding=(await state.loadBinding('s1'))!,ws=await state.storyWorkspace(cardId,binding.storyId)
    await onTurnStart(state,'s1',1)
    await runTavernPipeline({state,sessionId:'s1',agent:null,mode:'live',historyOverride:[{role:'user',content:'hello'}]})
    await state.saveCharacter(cardId,{description:'新资产'})
    await completeTemplateOutput(state,output('<% incvar("hp",9) %>','length'))
    expect((await loadTemplateState(ws.fs)).outputs).toEqual({})
    await expect(completeTemplateOutput(state,output('<% setvar("hp",3) %>word'))).rejects.toThrow()
    expect((await loadTemplateState(ws.fs)).variables.message).toEqual({hp:1,runs:1})
    const success=output('<% incvar("hp") %>word/<%- bump() %>')
    await completeTemplateOutput(state,success)
    await onTurnEnd(state,'s1',success)
    const stored=await loadTemplateState(ws.fs)
    expect(stored.variables.message).toEqual({hp:2,runs:1})
    expect(stored.outputs['5']?.text).toBe('1/2')
    await ws.wal.rollbackFloor('s1#t1',ws.fs.root)
    expect(await ws.fs.readText(TEMPLATE_STATE_PATH)).toBeNull()
  })
})
