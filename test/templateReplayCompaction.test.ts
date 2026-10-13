/** 重放日志体积回归：真实隔离 worker 验证长历史下操作数与体积有界、共享入参无损重建、旧内联日志兼容及坏引用拒绝。 */
import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { defaultPreset } from '../src/core/assemble.js'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { emptyTemplateMessageVariables } from '../src/core/templateMessageVariables.js'
import { parseTemplateReplayShared, templateReplayData, TEMPLATE_REPLAY_SHARE_MIN, type TemplateReplay } from '../src/core/templateReplay.js'
import { DEFAULT_WI_SETTINGS, EMPTY_TIMER_STATE, type ChatMessage } from '../src/core/types.js'
import type { ComputeJobs } from '../src/node/computeWorker.js'
import { isolated } from '../src/node/isolated.js'
import { parseLorebook } from '../src/state/lorebook.js'
import { parseTemplateReplay } from '../src/state/templateGeneration.js'

const json=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T
function chat(floors:number,reply='正文'.repeat(120)):ChatMessage[] {
  const history:ChatMessage[]=[]
  for(let i=0;i<floors;i++) {
    if(i) history.push({role:'assistant',content:`回复${i}：${reply}`,name:'Alice'})
    history.push({role:'user',content:`第${i}句话`,name:'Bob'})
  }
  return history
}
function request(main:string,history:ChatMessage[],lore:Record<string,unknown>[]=[]):ComputeJobs['assemble']['input'] {
  const entries=parseLorebook({entries:lore.map((entry,index)=>({uid:index+1,constant:true,...entry}))},{source:'character',sourceRef:'card'})
  const preset=defaultPreset()
  preset.entries.find(entry=>entry.identifier==='main')!.content=main
  // 历史之后的来源才会带上包含整段历史的累积缓冲。
  preset.entries.find(entry=>entry.identifier==='jailbreak')!.content=main.replaceAll('main','tail')
  const templates:TemplateContext={variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{name:'Alice'},entries,presets:preset.entries,history,
    historyIdentities:history.map((_,index)=>({messageId:'m'+index,swipeId:0})),messageVariables:emptyTemplateMessageVariables(),now:1000,seed:42,phase:'generate'}
  return {preset,card:null,personaDescription:'',history,wi:null,memories:[],worldDeltas:[],regexRules:[],
    macroCtx:{char:'Alice',user:'Bob'},seed:42,budget:{maxTokens:10_000_000,reserveForOutput:0},templates,
    wiEvaluation:{entries,messages:history,settings:DEFAULT_WI_SETTINGS,timerState:EMPTY_TIMER_STATE,contextWindowTokens:10_000_000,reservedTokens:0,seed:42}}
}
async function reply(input:ComputeJobs['assemble']['input'],generation:ComputeJobs['assemble']['output'],replay:TemplateReplay,text:string) {
  const previous=input.templates!,index=previous.history.length
  const history:ChatMessage[]=[...previous.history,{role:'assistant',content:text,name:previous.char}]
  const context:TemplateContext={...previous,phase:'render',history,variables:generation.templateVariables!,
    historyIdentities:[...previous.historyIdentities!,{messageId:'reply',hostMessageId:900,swipeId:0}],
    messageVariables:generation.templateMessageVariables,renderMessages:[{index,role:'assistant',name:previous.char,swipeId:0,hostMessageId:900}]}
  return isolated('template',{texts:[text],context,replay,decorateOutput:true})
}
/** 把共享入参还原成旧版逐条内联的日志形状。 */
function inlined(replay:TemplateReplay):TemplateReplay {
  const data=templateReplayData(replay),{shared:_shared,...rest}=replay
  return json({...rest,operations:replay.operations.map(operation=> {
    if(!('data' in operation)) return operation
    if(operation.kind==='phaseData') return {kind:'phase' as const,context:data(operation) as unknown as TemplateContext,refreshPreload:operation.refreshPreload,hash:operation.hash}
    const {refs:_refs,...plain}=operation
    return {...plain,data:data(operation)}
  })})
}
// 每个来源都读取整份模拟序列与累积缓冲，并把读到的内容留在闭包里供回复阶段核对。
const reader=(name:string)=>`<% define('${name}',(()=>{const seen=[generateData.length,generateBuffer.length,generateData.at(-1).content];return ()=>seen.join('|')})()) %>${name}:<%- generateData.length %>`
// 前三条在历史之前，后三条以深度 0 注入到历史之后。
const lore=Array.from({length:6},(_,index)=>({comment:`来源${index}`,content:reader('lore'+index),...(index<3 ? {} : {position:4,depth:0,role:0})}))

describe('重放日志体积',()=> {
  it('没有临时正则时操作数不随历史增长，多来源共用的模拟序列与缓冲只保存一次',async()=> {
    const short=await isolated('assemble',request(reader('main'),chat(4),lore))
    const longInput=request(reader('main'),chat(200),lore),long=await isolated('assemble',longInput)
    const replay=long.templateReplay!
    expect(replay.operations.length).toBe(short.templateReplay!.operations.length)
    const readers=replay.operations.filter(operation=>operation.kind==='render' && operation.refs?.generateData!==undefined)
    expect(readers.length).toBe(8)
    expect(new Set(readers.map(operation=>operation.kind==='render' && JSON.stringify(operation.refs!.generateData))).size).toBe(1)
    // 缓冲逐条消息累积：历史之后的来源引用同一段只增文本的不同前缀。
    const buffers=readers.flatMap(operation=>operation.kind==='render' && Array.isArray(operation.refs!.generateBuffer) ? [operation.refs!.generateBuffer] : [])
    expect(buffers.length).toBe(4)
    expect(new Set(buffers.map(ref=>ref[0])).size).toBe(1)
    expect(new Set(buffers.map(ref=>ref[1])).size).toBe(4)
    const historyChars=JSON.stringify(longInput.history).length
    expect(historyChars).toBeGreaterThan(40_000)
    // 冻结上下文、模拟序列、缓冲各含一份历史；旧格式每个来源还要各存一份序列，历史后的来源再各存一份缓冲。
    expect(JSON.stringify(replay).length).toBeLessThan(JSON.stringify(replay.context).length+historyChars*3)
    expect(JSON.stringify(inlined(replay)).length).toBeGreaterThan(JSON.stringify(replay).length+historyChars*8)
  },30000)

  it('压缩日志经 JSON 往返后在新 worker 重建，闭包读到的序列与缓冲和生成时一致；旧内联日志得到相同结果',async()=> {
    const input=request(reader('main'),chat(60),lore),generation=await isolated('assemble',input)
    const replay=json(generation.templateReplay!)
    expect(parseTemplateReplay(json(replay))).toEqual(replay)
    const text='<%- main() %>#<%- lore0() %>#<%- lore5() %>#<%- tail() %>'
    const compact=await reply(input,generation,replay,text)
    const [main,before,depth,tail]=compact.texts[0]!.split('#').map(part=>part.split('|'))
    // 序列长度与最后一条消息对所有来源相同，缓冲随求值位置增长并在历史之后包含全部历史。
    expect(new Set([main![0],before![0],depth![0],tail![0]]).size).toBe(1)
    expect(Number(main![0])).toBeGreaterThan(input.history.length)
    expect(new Set([main![2],before![2],depth![2],tail![2]]).size).toBe(1)
    expect(Number(before![1])).toBeLessThan(1000)
    expect(Number(depth![1])).toBeGreaterThan(JSON.stringify(input.history).length/2)
    expect(Number(tail![1])).toBeGreaterThan(Number(depth![1]))
    expect(await reply(input,generation,inlined(replay),text)).toEqual(compact)
  },30000)

  it('注册 generate 正则后只对其后的消息记录变换，替换结果仍进入模拟序列且可重放',async()=> {
    const history=chat(12,'含有 abc 的正文'.repeat(30))
    const input=request(`<% activateRegex(/abc/g,'XYZ',{uuid:'swap',generate:true});define('ready',()=>'ok') %>MAIN`,history)
    const generation=await isolated('assemble',input)
    const assistants=generation.messages.filter(message=>message.role==='assistant')
    expect(assistants.length).toBeGreaterThan(5)
    expect(assistants.every(message=>message.content.includes('XYZ') && !message.content.includes('abc'))).toBe(true)
    const transforms=generation.templateReplay!.operations.filter(operation=>operation.kind==='regexSources')
    expect(transforms.length).toBeGreaterThanOrEqual(history.length)
    expect(transforms.length).toBeLessThan(history.length+8)
    expect((await reply(input,generation,json(generation.templateReplay!),'<%- ready() %>')).texts).toEqual(['ok'])
  },30000)

  it('basic 与 generate 简单规则处理一千楼历史时直接执行，basic 只留下批次日志',async()=> {
    const history=chat(1000,'abc'),input=request(`<% activateRegex(/bcd/g,'done',{uuid:'generate',generate:true});define('ready',()=>'ok') %>MAIN`,history,
      [{comment:'preload',content:`@@only_preload\n<% activateRegex(/abc/g,'bcd',{uuid:'basic',basic:true}) %>`}])
    const generation=await isolated('assemble',input)
    expect(generation.history.filter(message=>message.role==='assistant').every(message=>message.content.includes('done'))).toBe(true)
    expect(generation.templateReplay!.operations.some(operation=>operation.kind==='regexSourcesBatch')).toBe(true)
    expect(generation.templateReplay!.operations.filter(operation=>operation.kind==='regexSourcesBatch').length).toBeLessThan(10)
    expect(generation.templateReplay!.operations.some(operation=>operation.kind==='render' && operation.text.includes('__applyTemporaryRegexSources'))).toBe(false)
    expect((await reply(input,generation,json(generation.templateReplay!),'<%- ready() %>')).texts).toEqual(['ok'])
  },30000)

  it('generate 仍与逐消息 EJS 交错，来源里替换规则后下一条消息立即使用新规则',async()=> {
    const history:ChatMessage[]=[{role:'user',content:'PING'},
      {role:'assistant',content:`<% activateRegex(/P[I]NG/g,()=> 'new',{uuid:'swap',generate:true}) %>middle`},
      {role:'user',content:'PING'}]
    const input=request(`<% activateRegex(/P[I]NG/g,()=> 'old',{uuid:'swap',generate:true});define('ready',()=>'ok') %>MAIN`,history)
    const generation=await isolated('assemble',input)
    expect(generation.history.map(message=>message.content)).toEqual(['old','middle','new'])
    expect((await reply(input,generation,json(generation.templateReplay!),'<%- ready() %>')).texts).toEqual(['ok'])
  },30000)
})

describe('直接来源正则重放兼容',()=> {
  const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
  const context:TemplateContext={variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{},entries:[],presets:[],history:[],now:1,seed:1,phase:'generate'}
  const wrapper='<%- JSON.stringify(__applyTemporaryRegexSources(__tavernParts,__tavernStage,__tavernMeta,__tavernNamespace)) %>'
  const run=(operations:TemplateReplay['operations'],text='ok')=>isolated('template',{texts:[text],context:{...context,phase:'render'},
    replay:{version:2,formatterVersion:2,context,operations,variables:emptyTemplateScopes(),messageVariablesHash:hash(emptyTemplateMessageVariables())}})

  it('旧 EJS 包装日志与新直接指令重建同一回调闭包和变量副作用',async()=> {
    const register={kind:'render' as const,text:`<% let n=0;activateRegex(/abc/g,()=>String(++n),{uuid:'counter',generate:true});define('counter',()=>n) %>`,data:{},hash:hash('')}
    const parts=[{key:'message',text:'abc',start:0}],meta={role:'user',worldinfo:false,depth:0},result=[{key:'message',start:0,text:'1'}]
    const direct:TemplateReplay['operations']=[register,{kind:'regexSources',stage:'generate',meta,namespace:'test',data:{parts},hash:hash(result)}]
    const legacy:TemplateReplay['operations']=[register,{kind:'render',text:wrapper,
      data:{__tavernParts:parts,__tavernStage:'generate',__tavernMeta:meta,__tavernNamespace:'test'},hash:hash(JSON.stringify(result))}]
    expect((await run(direct,'<%- counter() %>')).texts).toEqual(['1'])
    expect(await run(legacy,'<%- counter() %>')).toEqual(await run(direct,'<%- counter() %>'))
  },30000)

  it('旧内联日志超过 4 MiB 时按冻结日志分配资源，完整保留捕获的大入参',async()=> {
    const unused='原样\\"\n😀'.repeat(600_000)
    const operations:TemplateReplay['operations']=[{kind:'render',text:`<% const captured=unused;define('oldSnapshot',()=>JSON.stringify([captured.length,captured.slice(-9)])) %>`,
      data:{unused},hash:hash('')}]
    const replay:TemplateReplay={version:2,formatterVersion:2,context,operations,variables:emptyTemplateScopes(),messageVariablesHash:hash(emptyTemplateMessageVariables())}
    expect(JSON.stringify(replay).length).toBeGreaterThan(4*1024*1024)
    expect(parseTemplateReplay(json(replay))).toEqual(replay)
    expect((await run(operations,'<%- oldSnapshot() %>')).texts).toEqual([JSON.stringify([unused.length,unused.slice(-9)])])
  },30000)

  it('basic 批次与旧逐条日志保持跨来源匹配、规则顺序和角色过滤',async()=> {
    const register={kind:'render' as const,text:`<% activateRegex(/ab/g,'x',{uuid:'first',basic:true,order:1});activateRegex(/xc/g,'Y',{uuid:'second',basic:true,order:2});__prepareTemplateBasicRegex() %>`,data:{},hash:hash('')}
    const items=[{parts:[{key:'a',text:'ab',start:0},{key:'b',text:'c',start:0}],meta:{role:'user',worldinfo:false,depth:0}},
      {parts:[{key:'system',text:'abc',start:0}],meta:{role:'system',worldinfo:false,depth:0}}]
    const results=[[{key:'a',start:0,text:'Y'}],items[1]!.parts]
    const direct:TemplateReplay['operations']=[register,{kind:'regexSourcesBatch',namespace:'basic-test',data:{items},hash:hash(results)}]
    const legacy:TemplateReplay['operations']=[register,...items.map((item,index)=>({kind:'render' as const,text:wrapper,
      data:{__tavernParts:item.parts,__tavernStage:'basic',__tavernMeta:item.meta,__tavernNamespace:'basic-test'},hash:hash(JSON.stringify(results[index]))}))]
    expect(await run(direct)).toEqual(await run(legacy))
    const invalid=json(direct);invalid[1]!.hash='0'.repeat(64)
    await expect(run(invalid)).rejects.toThrow(/重放结果不一致/)
  },30000)
})

describe('重放共享表边界',()=> {
  const context={variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{},entries:[],presets:[],history:[],now:1,seed:1,phase:'generate' as const}
  const hash='0'.repeat(64)
  const base=(shared:unknown,refs:unknown,data:Record<string,unknown>={big:null}):unknown=>({version:2,formatterVersion:2,context,variables:emptyTemplateScopes(),
    messageVariablesHash:hash,shared,operations:[{kind:'render',text:'x',data,refs,hash}]})

  it('整项与文本前缀按原键顺序展开，占位不改变其它入参',()=> {
    const replay=parseTemplateReplay(base([{value:[1,2,3]},{text:['甲乙','丙丁']}],{list:0,buffer:[1,3]},{first:1,list:null,middle:'m',buffer:null}))
    const operation=replay.operations[0]!
    if(operation.kind!=='render') throw new Error('工厂操作类型错误')
    const data=templateReplayData(replay)(operation)
    expect(Object.keys(data)).toEqual(['first','list','middle','buffer'])
    expect(data).toEqual({first:1,list:[1,2,3],middle:'m',buffer:'甲乙丙'})
  })

  it.each([
    ['越界索引',[{value:1}],{big:1}],
    ['整项引用指向文本',[{text:['a']}],{big:0}],
    ['文本引用指向整项',[{value:'a'}],{big:[0,1]}],
    ['前缀超过文本长度',[{text:['ab']}],{big:[0,3]}],
    ['负数长度',[{text:['ab']}],{big:[0,-1]}],
    ['引用缺少占位',[{value:1}],{other:0}],
  ])('存储边界拒绝%s',(_label,shared,refs)=> {
    expect(()=>parseTemplateReplay(base(shared,refs))).toThrow()
  })

  it('共享项只能是单一形状，占位处已有内联值时拒绝引用',()=> {
    expect(()=>parseTemplateReplayShared([{value:1,text:['a']}])).toThrow(/共享项损坏/)
    expect(()=>parseTemplateReplayShared([{text:['a',1]}])).toThrow(/共享文本损坏/)
    expect(()=>parseTemplateReplayShared({})).toThrow(/共享表无效/)
    expect(()=>parseTemplateReplay(base([{value:1}],{big:0},{big:'内联值'}))).toThrow()
    expect(TEMPLATE_REPLAY_SHARE_MIN).toBeGreaterThan(32)
  })

  it('直接来源指令在读取时校验展开后的来源与批次，不把坏共享入参留到执行时',()=> {
    const parts=[{key:'m',text:'abc',start:0}],meta={role:'user',worldinfo:false,depth:0}
    const record={version:2,formatterVersion:2,context,variables:emptyTemplateScopes(),messageVariablesHash:hash,
      shared:[{value:parts}],operations:[{kind:'regexSources',stage:'generate',meta,namespace:'test',data:{parts:null},refs:{parts:0},hash}]}
    expect(parseTemplateReplay(record)).toEqual(record)
    expect(()=>parseTemplateReplay({...record,shared:[{value:[{key:'m',text:'abc',start:-1}]}]})).toThrow(/来源/)
    expect(()=>parseTemplateReplay({...record,operations:[{kind:'regexSourcesBatch',namespace:'test',data:{items:[{parts,meta:{...meta,role:'bad'}}]},hash}]})).toThrow(/批次/)
    expect(()=>parseTemplateReplay({...record,operations:[{...record.operations[0],data:{parts:null,extra:true}}]})).toThrow(/入参/)
  })
})
