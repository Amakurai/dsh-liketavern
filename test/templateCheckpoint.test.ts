/** 完整虚拟机检查点的业务恢复：跨越长期闭包、schema 副作用和共享对象，验证冷启动、旧日志迁移及并发副本隔离。 */
import { createHash } from 'node:crypto'
import { afterEach,beforeEach,describe,expect,it } from 'vitest'
import { defaultPreset } from '../src/core/assemble.js'
import { emptyTemplateScopes,type TemplateContext } from '../src/core/template.js'
import { emptyTemplateMessageVariables,visibleTemplateMessageVariables } from '../src/core/templateMessageVariables.js'
import type { TemplateReplay } from '../src/core/templateReplay.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'
import { disposeIdleComputeWorkers,isolated } from '../src/node/isolated.js'

type Input=ComputeJobs['assemble']['input']
type Generation=ComputeJobs['assemble']['output']
type Reply=ComputeJobs['template']['output']
const json=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T
const checkpoint=(replay:TemplateReplay|undefined)=>Boolean(replay && 'checkpoint' in replay && replay.checkpoint)

function generation(main:string):Input {
  const preset=defaultPreset()
  preset.entries=preset.entries.filter(entry=>['main','chatHistory'].includes(entry.identifier))
  preset.entries.find(entry=>entry.identifier==='main')!.content=main
  const history=[{role:'user' as const,content:'USER'}]
  const templates:TemplateContext={variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{name:'Alice'},entries:[],presets:preset.entries,history,
    historyIdentities:[{messageId:'user',swipeId:0}],messageVariables:emptyTemplateMessageVariables(),now:1000,seed:42,phase:'generate',sessionId:'session-checkpoint',cardId:'card'}
  return {preset,card:null,personaDescription:'',history,wi:null,memories:[],worldDeltas:[],regexRules:[],
    macroCtx:{char:'Alice',user:'Bob'},seed:42,budget:{maxTokens:100000,reserveForOutput:0},templates}
}
function reply(input:Input,assembled:Generation,text='TOKEN TOKEN'):ComputeJobs['template']['input'] {
  const context=input.templates!
  return {texts:[text],decorateOutput:true,replay:json(assembled.templateReplay!),templateContinuation:json(assembled.templateContinuation!),
    context:{...context,phase:'render',variables:assembled.templateVariables!,messageVariables:assembled.templateMessageVariables!,
      history:[...context.history,{role:'assistant',content:text}],
      historyIdentities:[...context.historyIdentities!,{messageId:'reply',swipeId:0}],
      renderMessages:[{index:context.history.length,role:'assistant',swipeId:0}],regexRules:assembled.templateRegexRules,hasMessageRegex:assembled.templateHasMessageRegex}}
}
/** 固定可见历史，让增长完全来自存活的执行环境，而不是测试工厂不断追加正文。 */
function next(input:Input,rendered:Reply,turn:number):Input {
  const previous=input.templates!
  return {...input,templates:{...previous,variables:rendered.variables,
    messageVariables:visibleTemplateMessageVariables(rendered.messageVariables,previous.historyIdentities!),now:turn*1000},
    templateContinuation:json(rendered.templateContinuation!)}
}
/** 地址、压缩字节和模块分配可以不同；只比较用户能观察到的业务状态。 */
const business=(result:Reply)=>({texts:result.texts,variables:result.variables,messageVariables:result.messageVariables,sticky:result.templateContinuation?.state})

beforeEach(disposeIdleComputeWorkers)
afterEach(disposeIdleComputeWorkers)

describe('完整 VM 检查点',()=> {
  it('56 轮永久回调、schema 微任务和共享对象跨周期冷启动持续，过期回调留下的值不丢失',async()=> {
    const main=`<%
      if(!getGlobalVar('ready')) {
        setGlobalVar('ready',true);
        const box={calls:0,expired:0};box.self=box;let checks=0,settled=0;
        globalThis.checkpointAlias=box;define('checkpointState',()=>box);
        setVariableSchema(z.looseObject({}).transform(value=>{checks++;Promise.resolve().then(()=>{settled++});return value}));
        activateRegex(/E[X]PIRE/g,()=>{box.expired+=7;return 'gone'},{uuid:'expires',message:true,sticky:1});
        activateRegex(/T[O]KEN/g,()=>JSON.stringify([++box.calls,box.expired,box===checkpointAlias && box.self===box,box===checkpointState(),checks,settled]),
          {uuid:'permanent',message:true,sticky:10000});
      }
      getMessageVar(null,{withMsg:{id:0}}).dirty=(getGlobalVar('round')||0)+1;incGlobalVar('round');
    %>ROOT`
    let input=generation(main),seenCheckpoint=false,previousChecks=0,checkpointsObserved=0
    for(let turn=1;turn<=56;turn++) {
      if(turn%7===0) await disposeIdleComputeWorkers()
      const assembled=await isolated('assemble',input),request=reply(input,assembled,'EXPIRE TOKEN TOKEN')
      if(turn===1) expect(checkpoint(assembled.templateReplay)).toBe(false)
      let rendered=await isolated('template',request)
      const [expired,first,second]=rendered.texts[0]!.split(' ')
      expect(expired).toBe(turn===1?'gone':'EXPIRE')
      const firstState=JSON.parse(first!) as [number,number,boolean,boolean,number,number]
      const secondState=JSON.parse(second!) as [number,number,boolean,boolean,number,number]
      expect(firstState.slice(0,4)).toEqual([turn*2-1,7,true,true])
      expect(secondState.slice(0,4)).toEqual([turn*2,7,true,true])
      expect(firstState[4]).toBeGreaterThan(previousChecks)
      expect(secondState[4]).toBe(firstState[4]);previousChecks=secondState[4]
      expect(firstState[5]).toBeGreaterThan(0)
      expect(firstState[5]).toBeLessThanOrEqual(firstState[4])
      expect(secondState[5]).toBe(firstState[5])
      expect(rendered.variables.global.round).toBe(turn)
      if(turn>1) expect(rendered.templateContinuation!.state.regex.message.map(rule=>rule.uuid)).toEqual(['permanent'])
      for(const replay of [assembled.templateReplay,rendered.templateContinuation?.replay]) {
        if(checkpoint(replay)) {seenCheckpoint=true;checkpointsObserved++}
        // 一个检查点后的尾日志只覆盖近期操作，56 轮不能继续留下所有旧执行步骤。
        if(seenCheckpoint) expect(replay!.operations.length).toBeLessThan(512)
      }
      if(checkpoint(assembled.templateReplay) && turn%14===0) {
        await disposeIdleComputeWorkers()
        const cold=await isolated('template',json(request))
        expect(business(cold)).toEqual(business(rendered))
        rendered=cold
      }
      input=next(input,rendered,turn+1)
    }
    expect(seenCheckpoint).toBe(true)
    expect(checkpointsObserved).toBeGreaterThan(20)
  },120000)

  it('旧无检查点日志在继续执行后迁移，同一检查点并发恢复保持独立计数和后续分支',async()=> {
    const input=generation(`<% if(!getGlobalVar('ready')){setGlobalVar('ready',true);let count=0;activateRegex(/T[O]KEN/g,()=>String(++count),{uuid:'counter',message:true,sticky:10000})} %>ROOT`)
    const assembled=await isolated('assemble',input),legacy=json(assembled.templateReplay!)
    expect(checkpoint(legacy)).toBe(false)
    // 这些是旧格式允许的真实变量查询；无 schema 时每条结果相同，能直接模拟超过检查点间隔的旧日志。
    const hash=createHash('sha256').update(JSON.stringify(legacy.variables)).digest('hex')
    for(let index=0;index<280;index++) legacy.operations.push({kind:'variables',hash})
    await disposeIdleComputeWorkers()
    const migrated=await isolated('template',reply(input,{...assembled,templateReplay:legacy}))
    expect(migrated.texts).toEqual(['1 2'])
    const nextInput=next(input,migrated,2),generated=await isolated('assemble',nextInput),request=reply(nextInput,generated)
    expect(checkpoint(request.replay)).toBe(true)
    expect(request.replay!.operations.length).toBeLessThan(512)
    await disposeIdleComputeWorkers()
    const copies=await Promise.all([isolated('template',json(request)),isolated('template',json(request))])
    expect(copies[0]!.texts).toEqual(['3 4'])
    expect(business(copies[0]!)).toEqual(business(copies[1]!))
    for(const copy of copies) {
      const branch=next(nextInput,copy,3),continued=await isolated('assemble',branch)
      expect((await isolated('template',reply(branch,continued))).texts).toEqual(['5 6'])
    }
  },60000)

  it('单轮共享历史超过一 MiB 时也建立检查点，冷恢复保留捕获的大文本而不等待操作条数增长',async()=> {
    const input=generation(`<% if(!getGlobalVar('ready')){setGlobalVar('ready',true);const captured=generateData.at(-1).content;let count=0;activateRegex(/T[O]KEN/g,()=>captured.length+':'+String(++count),{uuid:'large',message:true,sticky:10000})} %>ROOT`)
    input.history[0]!.content='history'.repeat(160000)
    input.budget={maxTokens:1000000,reserveForOutput:0}
    const first=await isolated('assemble',input)
    expect(checkpoint(first.templateReplay)).toBe(false)
    const rendered=await isolated('template',reply(input,first)),secondInput=next(input,rendered,2)
    expect(rendered.texts).toEqual(['1120000:1 1120000:2'])
    const assembled=await isolated('assemble',secondInput)
    expect(checkpoint(assembled.templateReplay)).toBe(true)
    expect(assembled.templateReplay!.operations.length).toBeLessThan(256)
    const request=reply(secondInput,assembled)
    await disposeIdleComputeWorkers()
    expect((await isolated('template',request)).texts).toEqual(['1120000:3 1120000:4'])
  },30000)
})
