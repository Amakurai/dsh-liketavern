/** 真实 worker 的活闭包缓存：暖恢复与持久日志冷恢复逐项等价，并覆盖并发重试、篡改、跨会话隔离和超时淘汰。 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { defaultPreset } from '../src/core/assemble.js'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { emptyTemplateMessageVariables } from '../src/core/templateMessageVariables.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'
import { isolated, isolatedWorkerStats, disposeIdleComputeWorkers } from '../src/node/isolated.js'
import { TemplateSandbox } from '../src/node/templateSandbox.js'
import { TEMPLATE_REPLAY_LIMIT, type TemplateReplay } from '../src/core/templateReplay.js'

const json=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T
function generation():ComputeJobs['assemble']['input'] {
  const preset=defaultPreset()
  preset.entries=preset.entries.filter(entry=>['main','chatHistory'].includes(entry.identifier))
  preset.entries.find(entry=>entry.identifier==='main')!.content=`<% if(!getvar('ready')){setvar('ready',true);let n=0;activateRegex(/T[O]KEN/g,()=>String(++n),{uuid:'counter',message:true,sticky:100})} %>ROOT`
  const history=[{role:'user' as const,content:'USER'}]
  const templates:TemplateContext={variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{name:'Alice'},entries:[],presets:preset.entries,history,
    historyIdentities:[{messageId:'user',swipeId:0}],messageVariables:emptyTemplateMessageVariables(),now:1000,seed:42,phase:'generate',sessionId:'session-a',cardId:'card'}
  return {preset,card:null,personaDescription:'',history,wi:null,memories:[],worldDeltas:[],regexRules:[],
    macroCtx:{char:'Alice',user:'Bob'},seed:42,budget:{maxTokens:100000,reserveForOutput:0},templates}
}
function reply(input:ComputeJobs['assemble']['input'],assembled:ComputeJobs['assemble']['output']):ComputeJobs['template']['input'] {
  const context=input.templates!
  return {texts:['TOKEN TOKEN'],decorateOutput:true,replay:json(assembled.templateReplay!),templateContinuation:json(assembled.templateContinuation!),
    context:{...context,phase:'render',variables:assembled.templateVariables!,messageVariables:assembled.templateMessageVariables!,
      history:[...context.history,{role:'assistant',content:'TOKEN TOKEN'}],
      historyIdentities:[...context.historyIdentities!,{messageId:'reply-'+context.history.length,swipeId:0}],
      renderMessages:[{index:context.history.length,role:'assistant',swipeId:0}],regexRules:assembled.templateRegexRules,hasMessageRegex:assembled.templateHasMessageRegex}}
}

beforeEach(disposeIdleComputeWorkers)
afterEach(disposeIdleComputeWorkers)

describe('活沙箱单次续接',()=> {
  it('已到容量边缘的旧日志仍能先清理到期闭包，校验尾部不会放宽下一次脚本操作的预算',()=> {
    // 用计量桩模拟大日志，只执行宿主编排方法，不在主线程运行第三方 JS，也不分配 64 MiB 测试数据。
    const sandbox=Object.create(TemplateSandbox.prototype) as TemplateSandbox
    const variables=emptyTemplateScopes(),messageVariables=emptyTemplateMessageVariables()
    const state={version:1 as const,revision:0,callbackSerial:0,prompts:[],regex:{basic:[],generate:[],message:[]},tombstones:{prompts:[],basic:[],generate:[],message:[]}}
    let queries=0
    Object.assign(sandbox,{recording:true,operations:[],operationChars:TEMPLATE_REPLAY_LIMIT,
      variables:()=>{queries++;return variables},messageVariables:()=>{queries++;return messageVariables},
      resume:()=>{},sticky:()=>state,evaluate:()=>null})
    const replay:TemplateReplay={version:2,formatterVersion:2,context:generation().templates!,operations:[],variables,
      messageVariablesHash:createHash('sha256').update(JSON.stringify(messageVariables)).digest('hex')}
    expect(()=>sandbox.verifyReplayState(replay)).not.toThrow()
    expect(queries).toBe(2)
    expect(sandbox.advanceGeneration(replay.context,false)).toEqual(state)
    expect(()=>sandbox.setOutletsDeferred(false)).toThrow(/重放记录超过上限/)
  })

  it('schema 导出校验中的闭包副作用在冷暖恢复中次数相同',async()=> {
    const input=generation()
    input.preset!.entries.find(entry=>entry.identifier==='main')!.content=`<% let checks=0;setVariableSchema(z.looseObject({}).transform(value=>{checks++;return value}));getMessageVar(null,{withMsg:{id:0}}).dirty=1;activateRegex(/T[O]KEN/g,()=>String(checks),{uuid:'schema-counter',message:true,sticky:100}); %>ROOT`
    input.templates!.presets=input.preset!.entries
    const assembled=await isolated('assemble',input),request=reply(input,assembled),before=isolatedWorkerStats()
    const warm=await isolated('template',request)
    expect(isolatedWorkerStats().cacheHits).toBe(before.cacheHits+1)
    await disposeIdleComputeWorkers()
    const cold=await isolated('template',json(request))
    expect(cold).toEqual(warm)
    expect(Number(warm.texts[0]!.split(' ')[0])).toBeGreaterThan(0)
  })

  it('多轮 schema 的导出副作用随日志保存，重启不会丢掉历次恢复校验产生的闭包状态',async()=> {
    let input=generation(),request:ComputeJobs['template']['input']|undefined
    input.preset!.entries.find(entry=>entry.identifier==='main')!.content=`<% if(!getvar('ready')){setvar('ready',true);let checks=0;setVariableSchema(z.looseObject({}).transform(value=>{checks++;return value}));activateRegex(/T[O]KEN/g,()=>String(checks),{uuid:'schema-counter',message:true,sticky:100})}getMessageVar(null,{withMsg:{id:0}}).dirty=(getvar('round')||0)+1;incvar('round'); %>ROOT`
    input.templates!.presets=input.preset!.entries
    for(let turn=1;turn<=3;turn++) {
      const assembled=await isolated('assemble',input)
      request=reply(input,assembled)
      if(turn===3)break
      const rendered=await isolated('template',request)
      input={...input,history:request.context.history,
        templates:{...request.context,phase:'generate',variables:rendered.variables,messageVariables:rendered.messageVariables,now:1000*(turn+1)},
        templateContinuation:json(rendered.templateContinuation!)}
    }
    const warm=await isolated('template',request!)
    await disposeIdleComputeWorkers()
    expect(await isolated('template',json(request!))).toEqual(warm)
  })

  it('完整 replay 命中后直接延续闭包；同一输入再试从日志冷恢复，结果逐项相同',async()=> {
    const input=generation(),assembled=await isolated('assemble',input),request=reply(input,assembled)
    const before=isolatedWorkerStats()
    // 旧沙箱截止时间已经过去，下一任务必须获得自身预算。
    await new Promise(resolve=>setTimeout(resolve,800))
    const warm=await isolated('template',request)
    expect(warm.texts).toEqual(['1 2'])
    expect(isolatedWorkerStats().cacheHits).toBe(before.cacheHits+1)
    expect(isolatedWorkerStats().workersStarted).toBe(before.workersStarted)
    const cold=await isolated('template',json(request))
    expect(cold).toEqual(warm)
    expect(isolatedWorkerStats().cacheHits).toBe(before.cacheHits+1)
  })

  it('回复末态继续下一轮也命中，清空 worker 后同一持久状态仍恢复相同闭包',async()=> {
    const input=generation(),assembled=await isolated('assemble',input),request=reply(input,assembled)
    const rendered=await isolated('template',request),before=isolatedWorkerStats()
    const next:ComputeJobs['assemble']['input']={...input,history:request.context.history,
      templates:{...request.context,phase:'generate',variables:rendered.variables,messageVariables:rendered.messageVariables,now:2000},
      templateContinuation:json(rendered.templateContinuation!)}
    const warm=await isolated('assemble',next)
    expect(isolatedWorkerStats().cacheHits).toBe(before.cacheHits+1)
    await disposeIdleComputeWorkers()
    const cold=await isolated('assemble',json(next))
    expect(cold).toEqual(warm)
  })

  it('并发提交同一生成快照只消费一次缓存，各自回复保持独立计数',async()=> {
    const input=generation(),assembled=await isolated('assemble',input),request=reply(input,assembled),before=isolatedWorkerStats()
    const results=await Promise.all([isolated('template',json(request)),isolated('template',json(request))])
    expect(results[0]).toEqual(results[1])
    expect(results[0]!.texts).toEqual(['1 2'])
    expect(isolatedWorkerStats().cacheHits).toBe(before.cacheHits+1)
    expect(isolatedWorkerStats().idle).toBeLessThanOrEqual(2)
  })

  it('气泡展示和普通正则渲染不清掉待提交回复的闭包缓存',async()=> {
    const input=generation(),assembled=await isolated('assemble',input),request=reply(input,assembled),before=isolatedWorkerStats()
    await isolated('render',{text:'plain',rules:[],macroCtx:{char:'Alice',user:'Bob'}})
    await isolated('display',{parts:[{kind:'markdown',text:'plain'}],rules:[],macroCtx:{char:'Alice',user:'Bob'}})
    expect((await isolated('template',request)).texts).toEqual(['1 2'])
    expect(isolatedWorkerStats().cacheHits).toBe(before.cacheHits+1)
  })

  it('相同日志换会话不会复用 VM，修改任一操作指纹仍由冷重放拒绝',async()=> {
    const input=generation(),assembled=await isolated('assemble',input),request=reply(input,assembled),before=isolatedWorkerStats()
    const other=json(request)
    other.context.sessionId='session-b'
    expect((await isolated('template',other)).texts).toEqual(['1 2'])
    expect(isolatedWorkerStats().cacheHits).toBe(before.cacheHits)
    const bad=json(request)
    bad.replay!.operations[0]!.hash='0'.repeat(64)
    await expect(isolated('template',bad)).rejects.toThrow(/重放结果不一致/)
    expect(isolatedWorkerStats().idle).toBe(0)
    expect((await isolated('template',request)).texts).toEqual(['1 2'])
  })

  it('暖恢复后的脚本超时淘汰整 worker，后续重试不会继承半执行的闭包',async()=> {
    const input=generation(),assembled=await isolated('assemble',input),request=reply(input,assembled),before=isolatedWorkerStats()
    const bad=json(request)
    bad.texts=['TOKEN <% while(true){} %>']
    await expect(isolated('template',bad,80)).rejects.toThrow(/超时/)
    expect(isolatedWorkerStats().idle).toBe(0)
    expect((await isolated('template',request)).texts).toEqual(['1 2'])
    expect(isolatedWorkerStats().workersStarted).toBe(before.workersStarted+1)
  })

  it('32 轮增长历史保留共享闭包，暖续接与清空进程缓存后的完整恢复一致',async()=> {
    let input=generation(),request:ComputeJobs['template']['input']|undefined
    for(let turn=1;turn<=32;turn++) {
      if(turn>1) {
        input.history=[...input.history,{role:'user',content:`第 ${turn} 轮：`+'历史正文'.repeat(2048)}]
        input.templates={...input.templates!,history:input.history,
          historyIdentities:[...input.templates!.historyIdentities!,{messageId:'user-'+turn,swipeId:0}],now:1000*turn}
      }
      const assembled=await isolated('assemble',input)
      request=reply(input,assembled)
      if(turn===32)break
      const rendered=await isolated('template',request)
      input={...input,history:request.context.history,templates:{...request.context,phase:'generate',variables:rendered.variables,messageVariables:rendered.messageVariables},
        templateContinuation:json(rendered.templateContinuation!)}
    }
    const before=isolatedWorkerStats(),warmStarted=performance.now()
    const warm=await isolated('template',request!)
    const warmMs=performance.now()-warmStarted
    expect(isolatedWorkerStats().cacheHits).toBe(before.cacheHits+1)
    await disposeIdleComputeWorkers()
    const coldStarted=performance.now(),cold=await isolated('template',json(request!)),coldMs=performance.now()-coldStarted
    expect(cold).toEqual(warm)
    expect(warm.texts).toEqual(['63 64'])
    console.info(JSON.stringify({fixture:'32-turn-live-closure',historyChars:request!.context.history.reduce((n,message)=>n+message.content.length,0),
      replayChars:JSON.stringify(request!.replay).length,operations:request!.replay!.operations.length,warmMs:Math.round(warmMs),coldMs:Math.round(coldMs)}))
  },60_000)
})
