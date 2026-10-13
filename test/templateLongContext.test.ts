/** 百万 token 模型的长历史回归：真实剧情文件、完整 GENERATE 入参、冷恢复冻结计划与闭包，以及正常 stop 的原子提交。 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAssistantMessage, createUserMessage, type LlmRuntime, type Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { saveBinding } from '../src/node/bindings.js'
import { onTurnStart, onTurnEnd } from '../src/node/sessionLifecycle.js'
import { runTavernPipeline, type PipelineResult } from '../src/node/pipeline.js'
import { parseJsonCard } from '../src/state/card.js'
import { importCard } from '../src/state/workspace.js'
import { loadTemplateState, TEMPLATE_GENERATION_PATH } from '../src/state/template.js'
import { openLedger } from '../src/state/writeLedger.js'

const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
const event=(type:string,data:unknown,seq:number):SessionEvent=>({type,data,seq,time:0,...(type.endsWith('/message')?{surfaceOp:'append'}:{})} as unknown as SessionEvent)
const user=(text:string)=>createUserMessage({source:{kind:'user'},content:[{type:'text',text}]})
const assistant=(text:string)=>createAssistantMessage({source:{provider:'factory',model:'million-context'},content:[{type:'text',text}]})
const stop=[{type:'chunk',time:0,chunk:{type:'finish',reason:{kind:'stop'}}}]
const fingerprint=(plan:PipelineResult)=>createHash('sha256').update(JSON.stringify({standing:plan.standing,turnContext:plan.turnContext,
  messages:plan.messages.map(({role,content,name})=>[role,content,name]),history:plan.history.map(({role,content,name})=>[role,content,name])})).digest('hex')

it('大于 1 MiB 的可见历史按模型窗口组装；完整 data/buffer 与词法闭包冷恢复后逐字一致并只提交一次',async()=> {
  const root=await mkdtemp(join(tmpdir(),'tavern-long-context-'));roots.push(root)
  const paths={root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')}
  const fresh=async()=>{const runtime=new TavernState(paths,()=>resolveConfig({}));await runtime.init();return runtime}
  const runtime=await fresh(),count=96,chunkChars=32*1024,turn=count/2+1
  const base='A quiet room, a closed window, and a lamp. '
  const body=base.repeat(Math.ceil(chunkChars/base.length)).slice(0,chunkChars)
  const history=Array.from({length:count},(_,index)=>`HISTORY[${index}]|${body}|END[${index}]`)
  const historyChars=history.reduce((total,text)=>total+text.length,0)
  expect(historyChars).toBeGreaterThan(3*1024*1024)
  // 用短的手写工厂算法逐字校验整份入参，不把完整历史复制进卡片或变量表。
  const expected=`const count=${count},size=${chunkChars},base=${JSON.stringify(base)};
    const body=base.repeat(Math.ceil(size/base.length)).slice(0,size);
    const expected=index=>'HISTORY['+index+']|'+body+'|END['+index+']';`
  const card=parseJsonCard({name:'Alice',description:`<% ${expected}
    const captured=generateData.filter(message=>message.content.startsWith('HISTORY['));
    let calls=0;
    define('checkLongHistory',()=>{
      if(captured.length!==count || captured.some((message,index)=>message.content!==expected(index))) throw Error('generateData lost visible history');
      return 'history:'+captured.reduce((sum,message)=>sum+message.content.length,0)+':'+(++calls);
    });incvar('preparedRuns'); %><%- checkLongHistory() %>`,
    post_history_instructions:`<% ${expected}
    const entireHistory=Array.from({length:count},(_,index)=>expected(index)).join('');
    const capturedBuffer=generateBuffer;let calls=0;
    define('checkLongBuffer',()=>{
      if(!capturedBuffer.includes(entireHistory)) throw Error('generateBuffer lost visible history');
      return 'buffer:'+capturedBuffer.length+':'+(++calls);
    });setvar('bufferChars',capturedBuffer.length); %><%- checkLongBuffer() %>`})
  const {cardId}=await importCard(paths.characters,card)
  await saveBinding(paths,{sessionId:'s1',cardId,cardName:card.name,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
  const binding=(await runtime.loadBinding('s1'))!,ws=await runtime.storyWorkspace(cardId,binding.storyId)
  const messages:Message[]=history.map((text,index)=>index%2===0?user(text):assistant(text))
  const events:SessionEvent[]=messages.map((message,index)=>message.role==='user'
    ? event('user/message',message,index)
    : event('assistant/message',{turn:Math.floor(index/2)+1,step:1,message,stream:stop},index))
  events.push(event('turn/start',{turn},events.length))
  const current=user('Continue the scene.');messages.push(current);events.push(event('user/message',current,events.length))
  const session={id:'s1' as Session['id'],snapshotEvents:()=>events}
  const agent={options:{provider:'factory',model:'million-context'},session:{...session,deriveMessages:()=>messages}} as unknown as Agent
  const resolveModelInfo=vi.fn(async()=>({provider:'factory',id:'million-context',name:'Million Context',context:{contextWindow:1_000_000}}))
  const llm={resolveModelInfo} as unknown as LlmRuntime
  await onTurnStart(runtime,'s1',turn,session)
  const first=(await runTavernPipeline({state:runtime,sessionId:'s1',agent,llm,mode:'live'}))!
  expect(resolveModelInfo).toHaveBeenCalledTimes(1)
  expect(first.history.filter(message=>message.content.startsWith('HISTORY[')).map(message=>message.content)).toEqual(history)
  expect(first.system).toContain(`history:${historyChars}:1`)
  const saved=await loadTemplateState(ws.fs)
  if(saved.generation?.status!=='prepared')throw new Error('缺少工厂生成计划')
  const bufferChars=saved.variables.message.bufferChars
  expect(bufferChars).toBeGreaterThanOrEqual(historyChars)
  expect(first.system).toContain(`buffer:${bufferChars}:1`)
  expect(saved.variables.message.preparedRuns).toBe(1)
  const replayChars=JSON.stringify(saved.generation.replay).length
  expect(replayChars).toBeGreaterThan(4*1024*1024)
  const generationFiles=await ws.fs.list(TEMPLATE_GENERATION_PATH)
  expect(generationFiles).toHaveLength(1)
  // 改掉实时资产并作废存储缓存；恢复必须读取磁盘上的原冻结计划，不能再次运行当前卡片。
  await runtime.saveCharacter(cardId,{description:'<% throw Error("new asset must not run") %>'})
  openLedger(ws.fs.root).epoch++
  const restarted=await fresh()
  await onTurnStart(restarted,'s1',turn,session)
  const restored=(await runTavernPipeline({state:restarted,sessionId:'s1',agent,llm,mode:'live'}))!
  expect(fingerprint(restored)).toBe(fingerprint(first))
  expect(restored.layout).toEqual(first.layout)
  expect(restored.sampling).toEqual(first.sampling)
  expect(restored.logLines).toEqual(first.logLines)
  expect((await loadTemplateState(ws.fs)).variables.message.preparedRuns).toBe(1)
  const reply=assistant('<%- checkLongHistory() %>|<%- checkLongHistory() %>|<%- checkLongBuffer() %>')
  messages.push(reply)
  const replySeq=events.length
  events.push(event('assistant/message',{turn,step:1,message:reply,stream:stop},replySeq))
  events.push(event('turn/end',{turn,reason:{kind:'completed'}},events.length))
  await onTurnEnd(restarted,'s1',session)
  openLedger(ws.fs.root).epoch++
  const completed=await loadTemplateState(ws.fs)
  expect(completed.outputs[String(replySeq)]?.text).toBe(`history:${historyChars}:2|history:${historyChars}:3|buffer:${bufferChars}:2`)
  expect(completed.variables.message.preparedRuns).toBe(1)
  expect(completed.generation?.status).toBe('completed')
  expect((await ws.wal.validateFloor(`s1#t${turn}`)).committed).toBe(true)
  expect(await ws.fs.list(TEMPLATE_GENERATION_PATH)).toEqual([])
  await onTurnEnd(await fresh(),'s1',session)
  expect(await loadTemplateState(ws.fs)).toEqual(completed)
},120000)
