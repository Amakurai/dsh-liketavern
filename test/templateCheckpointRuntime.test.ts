/** 检查点运行时升级边界：真实剧情文件与模拟宿主证明不兼容堆在开 WAL、恢复计划和结束提交前拒绝，不创建虚假的成功进度。 */
import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { emptyTemplateScopes, type TemplateContext } from '../src/core/template.js'
import { emptyTemplateMessageVariables } from '../src/core/templateMessageVariables.js'
import { TEMPLATE_CHECKPOINT_ENGINE, TEMPLATE_CHECKPOINT_WASM_HASH, TEMPLATE_CHECKPOINT_MEMORY_MIN_BYTES, TEMPLATE_CHECKPOINT_PAGE_BYTES } from '../src/core/templateCheckpoint.js'
import { templateReplayGenerationContext, type TemplateReplay } from '../src/core/templateReplay.js'
import type { TemplateStickyState } from '../src/core/templateSticky.js'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { saveBinding } from '../src/node/bindings.js'
import { onTurnEnd, onTurnStart } from '../src/node/sessionLifecycle.js'
import { runTavernPipeline } from '../src/node/pipeline.js'
import { completeTemplateOutput } from '../src/node/templateOutput.js'
import * as templateOutputModule from '../src/node/templateOutput.js'
import { loadTemplateRuntime } from '../src/node/templateRuntime.js'
import { parseJsonCard } from '../src/state/card.js'
import { importCard } from '../src/state/workspace.js'
import * as templateStateModule from '../src/state/template.js'
import { loadTemplateState, saveTemplateState, templateTextHash, TEMPLATE_STATE_PATH, type TemplateMetadata, type TemplateState } from '../src/state/template.js'
import { templatePreloadRevision } from '../src/state/templateContinuation.js'
import { prepareTemplateDocument, TEMPLATE_DATA_PATH } from '../src/state/templateStorage.js'
import { openLedger } from '../src/state/writeLedger.js'
import type { WorkspaceFs } from '../src/state/workspaceFs.js'

const roots:string[]=[]
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true})})
const fingerprint=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const start=(turn:number):SessionEvent=>({type:'turn/start',seq:0,time:0,data:{turn}} as SessionEvent)
const end:SessionEvent={type:'turn/end',seq:1,time:0,data:{turn:1,reason:{kind:'completed'}}} as SessionEvent
const session=(events:SessionEvent[]):Pick<Session,'id'|'snapshotEvents'>=>({id:'s1' as Session['id'],snapshotEvents:()=>events})
const activeSticky:TemplateStickyState={version:1,revision:1,callbackSerial:1,prompts:[],regex:{basic:[],generate:[],message:[{
  uuid:'persistent',source:'TOKEN',flags:'g',sticky:100,revision:1,replacement:{kind:'callback',id:1,identity:'factory-closure'},
  options:{user:false,assistant:true,system:false,worldinfo:false,message:true,generate:false,basic:false,order:0,before:false,after:false,minDepth:null,maxDepth:null},
}]},tombstones:{prompts:[],basic:[],generate:[],message:[]}}

/** 工厂只用合法结构与完整压缩页；零堆不实际恢复，测试必须先因 runtimeHash 拒绝。 */
function oldReplay(context:TemplateContext):TemplateReplay {
  const memory=Buffer.alloc(TEMPLATE_CHECKPOINT_MEMORY_MIN_BYTES)
  const page=gzipSync(memory.subarray(0,TEMPLATE_CHECKPOINT_PAGE_BYTES)).toString('base64')
  return {version:2,formatterVersion:2,context,operations:[],variables:context.variables,
    messageVariablesHash:fingerprint(emptyTemplateMessageVariables()),checkpoint:{version:1,runtimeHash:'0'.repeat(64),context,
      resourceChars:1024,outputInputChars:1024,image:{version:1,engine:TEMPLATE_CHECKPOINT_ENGINE,wasmHash:TEMPLATE_CHECKPOINT_WASM_HASH,
        memoryBytes:memory.length,memoryHash:createHash('sha256').update(memory).digest('hex'),
        payload:Array.from({length:memory.length/TEMPLATE_CHECKPOINT_PAGE_BYTES},()=>page),
        handles:{runtime:4,context:8,uint32:12,global:16,undefined:20,null:24,false:28,true:32}}}}
}

async function disk(fs:WorkspaceFs):Promise<Record<string,string|null>> {
  return Object.fromEntries(await Promise.all((await fs.list()).sort().map(async path=>[path,await fs.readText(path)])))
}

async function fixture(kind:'prepared'|'continuation'|'empty',adjust?:(replay:TemplateReplay)=>Promise<void>) {
  const root=await mkdtemp(join(tmpdir(),'tavern-checkpoint-runtime-'));roots.push(root)
  const paths={root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')}
  const fresh=async()=>{const state=new TavernState(paths,()=>resolveConfig({}));await state.init();return state}
  const state=await fresh(),card=parseJsonCard({name:'Alice',description:kind==='empty' ? '<% incGlobalVar("runs") %>运行=<%- getGlobalVar("runs") %>' : '工厂角色'}),{cardId}=await importCard(paths.characters,card)
  await saveBinding(paths,{sessionId:'s1',cardId,cardName:card.name,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
  const binding=(await state.loadBinding('s1'))!,ws=await state.storyWorkspace(cardId,binding.storyId)
  if(kind==='empty')return {state,ws,binding,fresh}
  const context:TemplateContext={variables:emptyTemplateScopes(),char:'Alice',user:'Bob',card:{name:'Alice'},entries:[],presets:[],history:[],
    now:1000,seed:1,phase:'generate',sessionId:'s1',cardId}
  const replay=oldReplay(context),owner={version:1 as const,sessionId:'s1',cardId,storyId:binding.storyId!,turn:1,floor:'s1#t1'}
  await adjust?.(replay)
  const stored:TemplateState={version:1,variables:context.variables,messageVariables:emptyTemplateMessageVariables(),outputs:{}}
  if(kind==='prepared') stored.generation={...owner,status:'prepared',replay,plan:{standingKey:'factory-plan',standing:'冻结角色设定',turnContext:'旧轮上下文',messages:[],history:[],logLines:[],
    userName:'Bob',personaDescription:'',personaLorebookId:null,wiBudget:{limit:1000,used:0,overflowed:false},sampling:state.config.sampling,
    assembleLog:[],stats:{tokensBefore:0,tokensAfter:0,trimmedSections:[]}}}
  else {
    stored.generation={...owner,status:'completed'}
    stored.continuation={version:1,preloadRevision:templatePreloadRevision(context),state:activeSticky,replay}
  }
  await ws.wal.beginFloor('s1#t1')
  await saveTemplateState(ws.fs.withFloor('s1#t1'),stored)
  if(kind==='continuation')await ws.wal.commitFloor('s1#t1')
  // 读取/备份允许保存不兼容版本；拒绝发生在宿主运行路径，而不是伪装成状态损坏。
  expect(await loadTemplateState(ws.fs)).toEqual(stored)
  return {state,ws,binding,fresh}
}

it('旧 continuation 在新轮开层前拒绝，真实根和 WAL 没有新楼层或改写',async()=>{
  const {ws,fresh}=await fixture('continuation'),before=await disk(ws.fs),restarted=await fresh()
  await expect(onTurnStart(restarted,'s1',2,session([start(2)]))).rejects.toThrow(/检查点运行时不兼容/)
  expect(await disk(ws.fs)).toEqual(before)
  expect((await ws.wal.listFloors()).map(floor=>floor.floor)).toEqual(['s1#t1'])
  expect(restarted.openFloors.has('s1')).toBe(false)
})

it('即使实现指纹是当前版本，未知通信 ABI 仍在开层前拒绝，原根和 WAL 不变',async()=>{
  const {ws,fresh}=await fixture('continuation',async replay=>{
    replay.checkpoint!.runtimeHash=(await loadTemplateRuntime()).hash
    replay.checkpoint!.runtimeAbi='unsupported-runtime/v99'
  })
  const before=await disk(ws.fs),restarted=await fresh()
  await expect(onTurnStart(restarted,'s1',2,session([start(2)]))).rejects.toThrow(/ABI 不匹配/)
  expect(await disk(ws.fs)).toEqual(before)
  expect(restarted.openFloors.has('s1')).toBe(false)
})

it('旧 prepared 重复开始时拒绝，不能先恢复开层句柄',async()=>{
  const {ws,fresh}=await fixture('prepared'),before=await disk(ws.fs),restarted=await fresh()
  await expect(onTurnStart(restarted,'s1',1,session([start(1)]))).rejects.toThrow(/检查点运行时不兼容/)
  expect(await disk(ws.fs)).toEqual(before)
  expect(restarted.openFloors.has('s1')).toBe(false)
  expect((await ws.wal.validateFloor('s1#t1')).committed).toBe(false)
})

it('prepared 计划冷恢复在发布缓存和开层句柄前拒绝，不能向宿主返回旧计划',async()=>{
  const {ws,fresh}=await fixture('prepared'),before=await disk(ws.fs),restarted=await fresh()
  const agent={options:{},session:{id:'s1',snapshotEvents:()=>[start(1)],deriveMessages:()=>[]}} as unknown as Agent
  await expect(runTavernPipeline({state:restarted,sessionId:'s1',agent,mode:'live'})).rejects.toThrow(/检查点运行时不兼容/)
  expect(restarted.turnPlans.has('s1')).toBe(false)
  expect(restarted.openFloors.has('s1')).toBe(false)
  expect(restarted.currentTurns.has('s1')).toBe(false)
  expect(await disk(ws.fs)).toEqual(before)
})

it.each([false,true])('结束预检与最终提交均保护旧 prepared，不得把不兼容状态提交成功（有结束帧=%s）',async withEnding=>{
  const {ws,binding,fresh}=await fixture('prepared'),before=await disk(ws.fs),restarted=await fresh()
  restarted.openFloors.set('s1',{cardId:binding.cardId,storyId:binding.storyId,floor:'s1#t1'})
  await expect(onTurnEnd(restarted,'s1',withEnding?session([start(1),end]):undefined)).rejects.toThrow(/检查点运行时不兼容/)
  expect(await disk(ws.fs)).toEqual(before)
  expect((await ws.wal.validateFloor('s1#t1')).committed).toBe(false)
  expect(restarted.openFloors.get('s1')?.floor).toBe('s1#t1')
})

/** 用真实模板求值得到缓存与变量指纹；故障工厂只更换检查点，不伪造重放变量或消息快照。 */
async function liveFixture() {
  const value=await fixture('empty')
  await onTurnStart(value.state,'s1',1)
  const run=()=>runTavernPipeline({state:value.state,sessionId:'s1',agent:null,mode:'live',historyOverride:[{role:'user',content:'工厂输入'}]})
  return {...value,run}
}

function incompatibleReplay(replay:TemplateReplay):TemplateReplay {
  const copy=structuredClone(replay)
  copy.checkpoint=oldReplay(copy.context).checkpoint
  return copy
}

function incompatibleStored(stored:TemplateState,kind:'prepared'|'continuation'):TemplateState {
  const copy=structuredClone(stored)
  if(copy.generation?.status!=='prepared')throw new Error('工厂缺少真实 prepared 计划')
  const replay=incompatibleReplay(copy.generation.replay)
  if(kind==='prepared')copy.generation.replay=replay
  else copy.continuation={version:1,preloadRevision:templatePreloadRevision(templateReplayGenerationContext(replay)),state:structuredClone(activeSticky),replay}
  return copy
}

function normalStopSession():Pick<Session,'id'|'snapshotEvents'> {
  const events=[start(1),{
    type:'assistant/message',seq:5,time:0,data:{turn:1,step:1,
      stream:[{type:'chunk',time:0,chunk:{type:'finish',reason:{kind:'stop'}}}],
      message:createAssistantMessage({source:{provider:'factory',model:'factory'},content:[{type:'text',text:'<% incGlobalVar("outputs") %>正常回复'}]}),
    },
  },{type:'turn/end',seq:6,time:0,data:{turn:1,reason:{kind:'completed'}}}] as unknown as SessionEvent[]
  return session(events)
}

it.each(['prepared','continuation'] as const)('已有 warm 计划后维护恢复未知 %s，返回计划与直接处理回复均拒绝且不推进 WAL',async kind=>{
  const {state,ws,run}=await liveFixture(),warm=await run(),healthy=await loadTemplateState(ws.fs)
  expect(healthy.variables.global.runs).toBe(1)
  await ws.fs.withFloor(null).writeText(TEMPLATE_STATE_PATH,JSON.stringify(incompatibleStored(healthy,kind)))
  const before=await disk(ws.fs),open=state.openFloors.get('s1'),plan=state.turnPlans.get('s1')
  await expect(run()).rejects.toThrow(/检查点运行时不兼容/)
  expect(await disk(ws.fs)).toEqual(before)
  await expect(completeTemplateOutput(state,normalStopSession())).rejects.toThrow(/检查点运行时不兼容/)
  expect(await disk(ws.fs)).toEqual(before)
  expect(state.turnPlans.get('s1')).toBe(plan)
  expect(plan?.result).toBe(warm)
  expect(state.openFloors.get('s1')).toBe(open)
  expect(state.currentTurns.get('s1')).toBe(1)
  expect((await ws.wal.validateFloor('s1#t1')).committed).toBe(false)
})

it('磁盘 prepared 健康但实际选择的 warm 日志未知，正常结束帧也必须保留原层与缓存供恢复',async()=>{
  const {state,ws,run}=await liveFixture(),warm=await run()
  expect(warm?.templateReplay).toBeDefined()
  warm!.templateReplay=incompatibleReplay(warm!.templateReplay!)
  const before=await disk(ws.fs),open=state.openFloors.get('s1'),plan=state.turnPlans.get('s1')
  await expect(run()).rejects.toThrow(/检查点运行时不兼容/)
  await expect(completeTemplateOutput(state,normalStopSession())).rejects.toThrow(/检查点运行时不兼容/)
  expect(await disk(ws.fs)).toEqual(before)
  await expect(onTurnEnd(state,'s1',normalStopSession())).rejects.toThrow(/检查点运行时不兼容/)
  expect(await disk(ws.fs)).toEqual(before)
  expect(state.turnPlans.get('s1')).toBe(plan)
  expect(state.openFloors.get('s1')).toBe(open)
  expect(state.currentTurns.get('s1')).toBe(1)
  expect((await ws.wal.validateFloor('s1#t1')).committed).toBe(false)
})

it('回复已成功保存后最终提交前维护恢复未知 prepared，最终预检拒绝且不能先清理楼层缓存',async()=>{
  const {state,ws,run}=await liveFixture()
  await run()
  const healthy=await loadTemplateState(ws.fs),open=state.openFloors.get('s1'),plan=state.turnPlans.get('s1')
  let maintainedDisk:Awaited<ReturnType<typeof disk>>|undefined
  const complete=templateOutputModule.completeTemplateOutput
  // 先完成真实回复与 WAL 写入，再模拟两次持锁之间的楼层外维护；最终提交必须复核这个新根。
  const output=vi.spyOn(templateOutputModule,'completeTemplateOutput').mockImplementationOnce(async(...args)=>{
    await complete(...args)
    const completed=await loadTemplateState(ws.fs)
    expect(completed.generation?.status).toBe('completed')
    expect(completed.outputs['5']?.text).toBe('正常回复')
    await ws.fs.withFloor(null).writeText(TEMPLATE_STATE_PATH,JSON.stringify(incompatibleStored(healthy,'prepared')))
    maintainedDisk=await disk(ws.fs)
  })
  await expect(onTurnEnd(state,'s1',normalStopSession())).rejects.toThrow(/检查点运行时不兼容/)
  expect(output).toHaveBeenCalledTimes(1)
  expect(maintainedDisk).toBeDefined()
  expect(await disk(ws.fs)).toEqual(maintainedDisk)
  expect(state.openFloors.get('s1')).toBe(open)
  expect(state.currentTurns.get('s1')).toBe(1)
  expect(state.turnPlans.get('s1')).toBe(plan)
  expect((await ws.wal.validateFloor('s1#t1')).committed).toBe(false)
})

/** 仅提交点注入一次故障；pending 来自真实组装及真实 publish 闭包，重试不得重跑第三方模板。 */
async function pendingFixture() {
  const value=await liveFixture()
  let computed:TemplateMetadata|undefined
  const save=vi.spyOn(templateStateModule,'saveTemplateMetadata').mockImplementationOnce(async(_fs,metadata)=>{
    computed=structuredClone(metadata)
    throw new Error('工厂：首次元数据保存失败')
  })
  await expect(value.run()).rejects.toThrow(/首次元数据保存失败/)
  save.mockRestore()
  const pending=value.state.pendingTurnPlans.get('s1')
  expect(pending).toBeDefined()
  expect(value.state.turnPlans.has('s1')).toBe(false)
  expect(computed?.variables.global.runs).toBe(1)
  return {...value,pending:pending!,computed:{...computed!,outputs:{}} as TemplateState}
}

it.each(['prepared','continuation'] as const)('首次提交失败留下 pending 后维护恢复未知 %s，管线重试与直接 publish 均拒绝',async kind=>{
  const {state,ws,run,pending,computed}=await pendingFixture()
  await ws.fs.withFloor(null).writeText(TEMPLATE_STATE_PATH,JSON.stringify(incompatibleStored(computed,kind)))
  const before=await disk(ws.fs),open=state.openFloors.get('s1')
  await expect(run()).rejects.toThrow(/检查点运行时不兼容/)
  expect(await disk(ws.fs)).toEqual(before)
  await expect(pending.publish()).rejects.toThrow(/检查点运行时不兼容/)
  expect(await disk(ws.fs)).toEqual(before)
  expect(state.pendingTurnPlans.get('s1')).toBe(pending)
  expect(state.turnPlans.has('s1')).toBe(false)
  expect(state.openFloors.get('s1')).toBe(open)
  expect(state.currentTurns.get('s1')).toBe(1)
  expect((await ws.wal.validateFloor('s1#t1')).committed).toBe(false)
})

it.each(['pipeline','publish'] as const)('pending 经 %s 成功重试保留维护新增的回复与其它会话定时器，冻结模板只执行一次',async retry=>{
  const {state,ws,run,pending}=await pendingFixture(),external=await loadTemplateState(ws.fs)
  external.outputs['29']={hash:templateTextHash('维护恢复的历史回复'),text:'维护恢复的历史回复'}
  external.wiTimers={...external.wiTimers,s2:{stickyLeft:{external:3},cooldownLeft:{waiting:7}}}
  await ws.fs.withFloor(null).writeText(TEMPLATE_STATE_PATH,JSON.stringify(external))
  const result=await (retry==='pipeline' ? run() : pending.publish()),stored=await loadTemplateState(ws.fs)
  expect(result?.turnContext).toContain('运行=1')
  expect(stored.variables.global.runs).toBe(1)
  expect(stored.outputs).toEqual(external.outputs)
  expect(stored.wiTimers?.s2).toEqual(external.wiTimers.s2)
  expect(state.pendingTurnPlans.has('s1')).toBe(false)
  expect(state.turnPlans.get('s1')?.result).toBe(result)
  expect(await run()).toBe(result)
  expect((await loadTemplateState(ws.fs)).variables.global.runs).toBe(1)
})

it('warm 兼容性预检只读取元数据，不展开或校验无关历史回复正文块',async()=>{
  const {ws,run}=await liveFixture(),warm=await run(),stored=await loadTemplateState(ws.fs)
  stored.outputs=Object.fromEntries(Array.from({length:80},(_,index)=>{
    const text=`旧回复-${index}:`+'工厂正文'.repeat(1000)
    return [String(index),{hash:templateTextHash(text),text}]
  }))
  await saveTemplateState(ws.fs.withFloor('s1#t1'),stored)
  const document=prepareTemplateDocument(stored),bad=[...document.blocks].find(([,text])=>text.includes('旧回复-40:'))?.[0]
  expect(bad).toBeDefined()
  await ws.fs.withFloor(null).writeText(`${TEMPLATE_DATA_PATH}/${bad!.slice(0,2)}/${bad}.json`,'["json","损坏的无关历史回复"]')
  openLedger(ws.fs.root).epoch++
  const before=await disk(ws.fs)
  expect(await run()).toBe(warm)
  expect(await disk(ws.fs)).toEqual(before)
  await expect(loadTemplateState(ws.fs)).rejects.toThrow(/校验失败/)
})
