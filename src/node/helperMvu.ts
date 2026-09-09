/** 自动 MVU 的宿主事务：正常 stop 登记任务，短期沙箱租约冻结读取，数据和幂等回执同文件经楼层 WAL 提交。 */
import {createHash,randomUUID} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import type {Session,SessionEvent} from '@deepseek-ai/dsh-session'
import {helperMvuData,parseHelperMvuState,type HelperMvuJob,type HelperMvuWork,type HelperMvuInitialSource} from '../core/helperMvu.js'
import {helperJson,helperRecord} from '../core/helperRuntime.js'
import {enabledHelperLibraries} from '../core/helperScripts.js'
import {isTavernGreetingEvent} from '../core/greetingLog.js'
import {isContinueInstruction} from '../core/dshPrompt.js'
import type {SessionBinding} from '../core/binding.js'
import {parseLorebook} from '../state/lorebook.js'
import {loadHelperState,saveHelperState,type HelperState} from '../state/helper.js'
import {withWorkspaceLock} from '../state/workspaceLock.js'
import {getHelperSnapshot,helperHistoryOf,helperHistoryRevision} from './helperRuntime.js'
import {readDisplaySessionEvents} from './sessionEvents.js'
import type {TavernState} from './state.js'

type Snapshot=Pick<Session,'id'|'snapshotEvents'>
type Request={sessionId:string;storyId:string;runtimeId:string}
type Lease={runtimeId:string;token:string;expires:number;job:HelperMvuJob;binding:string;scripts:string;history:string;before:string;work:HelperMvuWork;committed?:string}
const leases=new WeakMap<TavernState,Map<string,Lease>>()
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
const stateHash=(value:HelperState)=>hash(helperJson({scopes:value.scopes,extras:value.extras,swipes:value.swipes??{},mvu:parseHelperMvuState(value.mvu)},4*1024*1024))
const scope=(identity:string)=>JSON.stringify(['message',identity])
const enabled=(state:TavernState,binding:SessionBinding|null)=>!!binding?.storyId&&binding.helperMvu===true&&state.config.interactiveCards&&binding.interactiveCards!==false
const leaseKey=(request:Pick<Request,'sessionId'|'storyId'>)=>JSON.stringify([request.sessionId,request.storyId])
function leaseMap(state:TavernState):Map<string,Lease>{let map=leases.get(state);if(!map){map=new Map();leases.set(state,map)}for(const [key,value]of map)if(value.expires<Date.now())map.delete(key);return map}
export function revokeHelperMvuLease(state:TavernState,sessionId:string,storyId:string):void{leases.get(state)?.delete(leaseKey({sessionId,storyId}))}
function requestIdentity(request:Request):void{
  if(!request.sessionId||!request.storyId||!request.runtimeId||request.runtimeId.length>96)throw new Error('自动 MVU 运行时身份无效')
}
function candidates(events:readonly SessionEvent[],turn:number,through=Infinity){
  const steps=new Map<number,{finishes:number;last:number;stop:boolean}>()
  for(const event of events){
    if(event.type!=='assistant/chunk'||event.data.turn!==turn)continue
    const status=steps.get(event.data.step)??{finishes:0,last:-1,stop:false}
    if(event.data.chunk.type==='finish')status.finishes++
    status.last=event.seq;status.stop=event.data.chunk.type==='finish'&&event.data.chunk.reason.kind==='stop';steps.set(event.data.step,status)
  }
  return events.filter((event):event is SessionEvent<'assistant/message'>=>{
    if(event.type!=='assistant/message'||event.data.turn!==turn||event.data.interrupted||event.seq>=through||event.surfaceOp!==undefined&&event.surfaceOp!=='append')return false
    if(!event.data.message.content.some(block=>block.type==='text'&&block.text.trim()))return false
    if(isTavernGreetingEvent(event))return true
    const status=steps.get(event.data.step)
    return !!status&&status.finishes===1&&status.stop&&status.last<event.seq
  })
}
function makeJob(event:SessionEvent<'assistant/message'>,kind:HelperMvuJob['kind'],floor:string):HelperMvuJob{
  const identity=String(event.data.message.id)
  return {id:hash([kind,identity]),kind,seq:event.seq,identity,text:event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n'),turn:event.data.turn,floor}
}
/** 宿主续写是独立消息；未处理的截断片段可能含半条命令，不能仅解析尾段后宣告成功。 */
function verifyContinuation(events:readonly SessionEvent[],job:Pick<HelperMvuJob,'seq'|'turn'>,mvu:ReturnType<typeof parseHelperMvuState>):void{
  let target=job
  for(let depth=0;depth<64;depth++){
    const start=events.find(event=>event.type==='turn/start'&&event.data.turn===target.turn&&event.seq<target.seq)
    if(!start)return
    const continued=events.some(event=>event.type==='user/message'&&event.seq>start.seq&&event.seq<target.seq
      &&(event.surfaceOp===undefined||event.surfaceOp==='append')&&event.data.source.kind==='plugin'&&event.data.source.plugin==='dsh-tavern'&&event.data.source.form==='notice'
      &&isContinueInstruction(event.data.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')))
    if(!continued)return
    const previous=[...events].reverse().find((event):event is SessionEvent<'assistant/message'>=>event.type==='assistant/message'&&event.seq<start.seq
      &&(event.surfaceOp===undefined||event.surfaceOp==='append')&&event.data.message.content.some(block=>block.type==='text'&&block.text.trim()))
    if(!previous)throw new Error('自动 MVU 无法核对续写来源，请重新生成完整回复')
    if(mvu.completed.some(receipt=>receipt.identity===String(previous.data.message.id)))return
    const end=events.find(event=>event.type==='turn/end'&&event.data.turn===previous.data.turn&&event.seq>previous.seq&&event.seq<start.seq)
    if(previous.data.interrupted||!isTavernGreetingEvent(previous)&&(!candidates(events,previous.data.turn).some(event=>event.seq===previous.seq)||end?.type!=='turn/end'||end.data.reason.kind!=='completed'))
      throw new Error('截断回复的续写暂不支持自动 MVU，请从被截断的回复重新生成完整回复')
    target={seq:previous.seq,turn:previous.data.turn}
  }
  throw new Error('自动 MVU 续写来源超过 64 层核对预算，请重新生成完整回复')
}
/** 新卡面只读取默认值；首次脚本作用域与任务同一原子 WAL 写入，避免 active turn 的 bootstrap flush 穿过写入禁令。 */
async function seedScripts(state:TavernState,sessionId:string,storyId:string,saved:HelperState):Promise<void>{
  const context=await state.getSessionHelperScripts(sessionId,storyId)
  for(const script of enabledHelperLibraries(context.libraries)){
    const key=JSON.stringify(['script',script.id])
    if(!Object.hasOwn(saved.scopes,key))saved.scopes[key]=helperJson(script.data) as Record<string,unknown>
  }
}
function floorOwner(binding:SessionBinding,sessionId:string,job:Pick<HelperMvuJob,'floor'|'turn'>):void{
  const suffix='#t'+job.turn
  if(!job.floor.endsWith(suffix))throw new Error('自动 MVU 楼层与消息轮次不一致')
  const owner=job.floor.slice(0,-suffix.length)
  if(owner!==sessionId&&!(binding.walLineage??[]).some(entry=>entry.sessionId===owner&&entry.throughTurn>=job.turn))throw new Error('自动 MVU 楼层不属于当前剧情或继承世系')
}
async function floorReady(state:TavernState,binding:SessionBinding,sessionId:string,job:Pick<HelperMvuJob,'floor'|'turn'>,allowBegin=false){
  floorOwner(binding,sessionId,job)
  const ws=await state.storyWorkspace(binding.cardId,binding.storyId)
  const floors=await ws.wal.listFloors(),active=floors.filter(item=>!item.rolledBack)
  const known=floors.find(item=>item.floor===job.floor)
  if(known?.rolledBack)throw new Error('自动 MVU 目标楼层已回滚')
  const open=state.openFloors.get(sessionId)
  if(open&&(open.floor!==job.floor||open.cardId!==binding.cardId||open.storyId!==binding.storyId))throw new Error('自动 MVU 不能写入已经开启的新楼层')
  if(active.some(item=>{
    const match=/^(.*)#t([0-9]+)$/.exec(item.floor)
    return match&&Number(match[2])>job.turn&&(match[1]===sessionId||(binding.walLineage??[]).some(entry=>entry.sessionId===match[1]&&entry.throughTurn>=Number(match[2])))
  }))throw new Error('自动 MVU 目标之后已有新的 WAL 楼层')
  if(known)await ws.wal.validateFloor(job.floor)
  else if(allowBegin&&job.floor===sessionId+'#t'+job.turn)await ws.wal.beginFloor(job.floor)
  else throw new Error('自动 MVU 目标 WAL 楼层缺失')
  return {ws,open:!!open}
}
function receiptFloor(floor:string){return {floor,turn:Number(floor.slice(floor.lastIndexOf('#t')+2))}}
/** 数据回执必须有可验证 WAL；活动楼层交回 turn/end，已关闭但未提交的楼层继续阻止新轮次。 */
async function unfinalizedReceipt(state:TavernState,binding:SessionBinding,sessionId:string,mvu:ReturnType<typeof parseHelperMvuState>):Promise<boolean>{
  const receipt=mvu.completed.at(-1)
  if(!receipt)return false
  const job=receiptFloor(receipt.floor);floorOwner(binding,sessionId,job)
  const ws=await state.storyWorkspace(binding.cardId,binding.storyId),floor=await ws.wal.validateFloor(job.floor)
  if(floor.rolledBack)throw new Error('自动 MVU 完成回执楼层已回滚')
  if(floor.committed)return false
  const open=state.openFloors.get(sessionId)
  return !(open?.floor===job.floor&&open.cardId===binding.cardId&&open.storyId===binding.storyId)
}
/** turn/end 登记失败会留下未提交楼层；只有没有任务/回执认领的关闭楼层才属于待恢复登记。 */
async function unregisteredFloor(state:TavernState,binding:SessionBinding,sessionId:string,mvu:ReturnType<typeof parseHelperMvuState>):Promise<boolean>{
  const ws=await state.storyWorkspace(binding.cardId,binding.storyId),open=state.openFloors.get(sessionId)
  const linked=new Set([...mvu.pending.map(job=>job.floor),...mvu.completed.map(receipt=>receipt.floor)])
  for(const floor of await ws.wal.listFloors()){
    if(floor.rolledBack||floor.committed||linked.has(floor.floor)||open?.floor===floor.floor&&open.cardId===binding.cardId&&open.storyId===binding.storyId)continue
    const match=/^(.*)#t([0-9]+)$/.exec(floor.floor)
    if(!match)continue
    const turn=Number(match[2]),owner=match[1]
    if(owner!==sessionId&&!(binding.walLineage??[]).some(entry=>entry.sessionId===owner&&entry.throughTurn>=turn))continue
    await ws.wal.validateFloor(floor.floor)
    return true
  }
  return false
}
async function queue(state:TavernState,sessionId:string,session:Snapshot,live:boolean):Promise<void>{
  if(session.id!==sessionId)throw new Error('自动 MVU 结束来源与会话不一致')
  const binding=await state.loadBinding(sessionId)
  if(!enabled(state,binding))return
  const events=session.snapshotEvents(),boundary=[...events].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end')
  if(!boundary||!live&&(boundary.type!=='turn/end'||boundary.data.reason.kind!=='completed'))return
  if(live&&boundary.type==='turn/end')return queue(state,sessionId,session,false)
  const turn=boundary.data.turn,open=state.openFloors.get(sessionId)
  if(live&&(!open||open.cardId!==binding!.cardId||open.storyId!==binding!.storyId))throw new Error('自动 MVU stop 缺少当前楼层')
  const items=candidates(events,turn,boundary.type==='turn/end'?boundary.seq:Infinity)
  if(!items.length)return
  const ws=await state.storyWorkspace(binding!.cardId,binding!.storyId)
  await withWorkspaceLock(ws.fs.root,()=>withWorkspaceLock(state.paths.sessions,async()=>{
    const current=await state.loadBinding(sessionId)
    if(!enabled(state,current)||hash(current)!==hash(binding))throw new Error('自动 MVU 登记期间剧情绑定已改变')
    const saved=await loadHelperState(ws.fs),mvu=parseHelperMvuState(saved.mvu),floor=open?.floor??sessionId+'#t'+turn
    const selected=mvu.initialized?items:items.slice(-1);let added=false
    for(const item of selected){
      const job=makeJob(item,mvu.initialized?'update':'initialize',floor)
      if(mvu.pending.some(row=>row.identity===job.identity)||mvu.completed.some(row=>row.identity===job.identity))continue
      if(!mvu.initialized&&mvu.pending.length)continue
      if(mvu.pending.length>=64)throw new Error('自动 MVU 待处理任务超过 64 项')
      verifyContinuation(events,job,mvu)
      await floorReady(state,current!,sessionId,job)
      if(!added){await seedScripts(state,sessionId,current!.storyId!,saved);added=true}
      mvu.pending.push(job)
    }
    if(!added)return
    await ws.wal.reopenFloor(floor)
    await saveHelperState(ws.fs.withFloor(floor),{...saved,mvu:parseHelperMvuState(mvu)})
  }))
}
export const queueHelperMvuTurn=(state:TavernState,sessionId:string,session:Snapshot):Promise<void>=>queue(state,sessionId,session,false)
export const queueHelperMvuStop=(state:TavernState,sessionId:string,session:Snapshot):Promise<void>=>queue(state,sessionId,session,true)
export async function helperMvuPending(state:TavernState,sessionId:string,includeInitialization=true):Promise<boolean>{
  const binding=await state.loadBinding(sessionId)
  if(!enabled(state,binding))return false
  const ws=await state.storyWorkspace(binding!.cardId,binding!.storyId)
  return withWorkspaceLock(ws.fs.root,async()=>{const mvu=parseHelperMvuState((await loadHelperState(ws.fs)).mvu);return includeInitialization&&!mvu.initialized||mvu.pending.length>0||await unfinalizedReceipt(state,binding!,sessionId,mvu)||await unregisteredFloor(state,binding!,sessionId,mvu)})
}
/** 脚本加载阶段允许先播种数据；任务一经登记，普通变量/消息/世界书写必须等待本批事务完成。 */
export async function assertHelperMvuWritable(state:TavernState,sessionId:string):Promise<void>{
  const binding=await state.loadBinding(sessionId)
  if(!enabled(state,binding))return
  const ws=await state.storyWorkspace(binding!.cardId,binding!.storyId)
  await withWorkspaceLock(ws.fs.root,async()=>{const mvu=parseHelperMvuState((await loadHelperState(ws.fs)).mvu);if(mvu.pending.length||await unfinalizedReceipt(state,binding!,sessionId,mvu)||await unregisteredFloor(state,binding!,sessionId,mvu))throw new Error('自动 MVU 正在更新当前剧情，请等待事务完成')})
}
async function sources(state:TavernState,binding:SessionBinding):Promise<HelperMvuInitialSource[]>{
  const result:HelperMvuInitialSource[]=[],known=new Set(await state.listLorebooks()),seen=new Set<string>()
  const add=async(id:string,role:'global'|'character')=>{
    if(seen.has(id))return
    if(!known.has(id))throw new Error('自动 MVU 初始化世界书不存在：'+id)
    seen.add(id)
    const entries=await state.loadLorebookEntries(id,role)
    result.push({name:id,role,entries:entries.map(({uid,comment,content})=>({uid,comment,content}))})
  }
  for(const id of binding.lorebookIds)await add(id,'global')
  if(binding.characterLorebookId)await add(binding.characterLorebookId,'character')
  else if(binding.useEmbeddedLorebook!==false){
    const embedded=await state.loadCharacterLorebookRaw(binding.cardId)
    if(embedded)result.push({name:embedded.name,role:'character',entries:parseLorebook(embedded.json,{source:'character',sourceRef:binding.cardId}).map(({uid,comment,content})=>({uid,comment,content}))})
  }
  for(const id of binding.characterLorebookIds??[])await add(id,'character')
  helperJson(result,2*1024*1024);return result
}
function latestCompleted(events:readonly SessionEvent[]){
  const completed=new Set(events.filter(event=>event.type==='turn/end'&&event.data.reason.kind==='completed').map(event=>event.type==='turn/end'?event.data.turn:-1))
  return [...events].reverse().find((event):event is SessionEvent<'assistant/message'>=>event.type==='assistant/message'&&!event.data.interrupted&&(event.surfaceOp===undefined||event.surfaceOp==='append')
    &&event.data.message.content.some(block=>block.type==='text'&&block.text.trim())&&(isTavernGreetingEvent(event)||completed.has(event.data.turn)&&candidates(events,event.data.turn).some(item=>item.seq===event.seq)))
}
async function locked<T>(state:TavernState,request:Request,run:(binding:SessionBinding)=>Promise<T>):Promise<T>{
  requestIdentity(request)
  const first=await state.loadBinding(request.sessionId)
  if(!first?.storyId||first.storyId!==request.storyId)throw new Error('自动 MVU 剧情绑定已改变')
  const ws=await state.storyWorkspace(first.cardId,first.storyId)
  return withWorkspaceLock(ws.fs.root,()=>withWorkspaceLock(state.paths.sessions,async()=>{
    const binding=await state.loadBinding(request.sessionId)
    if(!binding||binding.storyId!==request.storyId||binding.cardId!==first.cardId)throw new Error('自动 MVU 剧情绑定已改变')
    return run(binding)
  }))
}
async function scriptRevision(state:TavernState,request:Request){const scripts=await state.getSessionHelperScripts(request.sessionId,request.storyId);return hash([scripts.bindingRevision,scripts.libraries.map(({type,revision})=>[type,revision])])}
function verifyTarget(events:readonly SessionEvent[],job:HelperMvuJob):void{
  const target=events.find(event=>event.seq===job.seq)
  if(target?.type!=='assistant/message'||String(target.data.message.id)!==job.identity||target.data.turn!==job.turn||target.data.interrupted||target.surfaceOp!==undefined&&target.surfaceOp!=='append'
    ||target.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')!==job.text)throw new Error('自动 MVU 目标消息身份或原文已改变')
  if(!isTavernGreetingEvent(target)&&!candidates(events,job.turn).some(item=>item.seq===job.seq))throw new Error('自动 MVU 目标没有真实正常 stop')
}
/** 后台脚本在任何沙箱挂载前取得安全锚点并播种静态 data；不会领取执行租约或执行第三方代码。 */
export async function ensureHelperMvuScriptAnchor(ctx:Context,state:TavernState,sessionId:string,storyId:string):Promise<number|null>{
  return locked(state,{sessionId,storyId,runtimeId:'script-bootstrap'},async binding=>{
    if(!enabled(state,binding))return null
    const ws=await state.storyWorkspace(binding.cardId,storyId),saved=await loadHelperState(ws.fs),mvu=parseHelperMvuState(saved.mvu)
    const events=await readDisplaySessionEvents(ctx,sessionId)
    let job=mvu.pending[0],register=false
    if(!job){
      let latest=latestCompleted(events)
      if(!mvu.initialized){
        const boundary=[...events].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end'),open=state.openFloors.get(sessionId)
        if(boundary?.type==='turn/start'&&open?.floor===sessionId+'#t'+boundary.data.turn&&open.cardId===binding.cardId&&open.storyId===storyId){
          const stop=candidates(events,boundary.data.turn).at(-1)
          if(stop&&(!latest||stop.seq>latest.seq))latest=stop
        }
      }
      if(!latest)return null
      const open=state.openFloors.get(sessionId)
      if(!mvu.initialized&&open&&open.floor!==sessionId+'#t'+latest.data.turn)return null
      job=makeJob(latest,mvu.initialized?'update':'initialize',sessionId+'#t'+latest.data.turn)
      register=!mvu.initialized
    }
    verifyTarget(events,job)
    verifyContinuation(events,job,mvu)
    const before=stateHash(saved)
    await seedScripts(state,sessionId,storyId,saved)
    if(register){mvu.pending.push(job);saved.mvu=mvu}
    if(stateHash(saved)!==before){
      const ready=await floorReady(state,binding,sessionId,job,register)
      await ws.wal.reopenFloor(job.floor)
      await saveHelperState(ws.fs.withFloor(job.floor),saved)
      if(!ready.open)await ws.wal.commitFloor(job.floor)
    }else if(mvu.pending.length)await floorReady(state,binding,sessionId,job)
    return job.seq
  })
}
export async function prepareHelperMvuJob(ctx:Context,state:TavernState,request:Request):Promise<HelperMvuWork>{
  return locked(state,request,async binding=>{
    const baseWork:HelperMvuWork={storyId:request.storyId,enabled:enabled(state,binding),status:'idle'}
    if(!baseWork.enabled){leaseMap(state).delete(leaseKey(request));return baseWork}
    const ws=await state.storyWorkspace(binding.cardId,binding.storyId)
    let saved=await loadHelperState(ws.fs),mvu=parseHelperMvuState(saved.mvu)
    if(await unfinalizedReceipt(state,binding,request.sessionId,mvu)){
      const job=receiptFloor(mvu.completed.at(-1)!.floor),ready=await floorReady(state,binding,request.sessionId,job)
      if(!ready.open)await ready.ws.wal.commitFloor(job.floor)
    }
    if(!mvu.pending.length&&await unregisteredFloor(state,binding,request.sessionId,mvu)){
      const session=ctx.sessions.get(request.sessionId as Session['id'])
      if(!session)throw new Error('自动 MVU 登记恢复缺少当前宿主会话')
      await queue(state,request.sessionId,session,false)
      saved=await loadHelperState(ws.fs);mvu=parseHelperMvuState(saved.mvu)
      if(!mvu.pending.length)throw new Error('自动 MVU 登记恢复未找到正常完成回复')
    }
    baseWork.completed=mvu.completed.map(({id,digest})=>({id,digest}))
    const events=await readDisplaySessionEvents(ctx,request.sessionId),history=helperHistoryOf(events,{char:'',user:''})
    if(!mvu.pending.length&&!mvu.initialized){
      const latest=latestCompleted(events)
      if(!latest)return {...baseWork,status:'waiting'}
      const open=state.openFloors.get(request.sessionId)
      if(open&&open.floor!==request.sessionId+'#t'+latest.data.turn)return {...baseWork,status:'waiting'}
      const job=makeJob(latest,'initialize',request.sessionId+'#t'+latest.data.turn)
      verifyContinuation(events,job,mvu)
      const ready=await floorReady(state,binding,request.sessionId,job,true)
      await seedScripts(state,request.sessionId,request.storyId,saved)
      mvu.pending.push(job);saved.mvu=mvu
      await ws.wal.reopenFloor(job.floor)
      await saveHelperState(ws.fs.withFloor(job.floor),saved)
      if(!ready.open)await ws.wal.commitFloor(job.floor)
    }
    const job=mvu.pending[0]
    if(!job)return {...baseWork,awaitingTurnEnd:state.openFloors.has(request.sessionId)}
    verifyTarget(events,job);verifyContinuation(events,job,mvu);await floorReady(state,binding,request.sessionId,job)
    const key=leaseKey(request),map=leaseMap(state),old=map.get(key)
    if(old&&old.job.id===job.id&&!old.committed){
      if(old.runtimeId!==request.runtimeId)return {...baseWork,status:'waiting'}
      old.expires=Date.now()+90000
      return helperJson(old.work,4*1024*1024) as HelperMvuWork
    }
    const index=history.findIndex(item=>item.identity===job.identity),target=saved.scopes[scope(job.identity)]??{}
    let base:Record<string,unknown>=target
    if(job.kind==='update'){
      base={}
      for(let at=index-1;at>=0;at--){const item=saved.scopes[scope(history[at]!.identity)];if(item&&helperRecord(item.stat_data)){base=helperMvuData(item);break}}
      if(!helperRecord(base.stat_data))throw new Error('自动 MVU 更新缺少前一条有效消息状态')
    }
    const initialSources=job.kind==='initialize'?await sources(state,binding):undefined
    const greeting=events.find((event):event is SessionEvent<'assistant/message'>=>event.type==='assistant/message'&&isTavernGreetingEvent(event)&&(event.surfaceOp===undefined||event.surfaceOp==='append'))
    const isGreeting=isTavernGreetingEvent(events.find(event=>event.seq===job.seq)!)
    const token=randomUUID(),work:HelperMvuWork={...baseWork,status:'pending',job,token,base:helperJson(base) as Record<string,unknown>,snapshot:{...await getHelperSnapshot(ctx,state,request.sessionId,job.seq),writable:false},applyText:job.kind==='update'||!isGreeting&&!helperRecord(target.stat_data),
      ...(initialSources?{initialSources,greeting:greeting?.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')??'',swipeId:isGreeting?binding.greetingIndex:saved.swipes?.[job.identity]?.active??0}:{})}
    if(map.size>=128)throw new Error('自动 MVU 活动运行时超过预算')
    map.set(key,{runtimeId:request.runtimeId,token,expires:Date.now()+90000,job,binding:hash(binding),scripts:await scriptRevision(state,request),history:helperHistoryRevision(history),before:stateHash(saved),work})
    return helperJson(work,4*1024*1024) as HelperMvuWork
  })
}
export async function commitHelperMvuJob(ctx:Context,state:TavernState,request:Request&{jobId:string;token:string;data:unknown}):Promise<HelperMvuWork>{
  const data=helperMvuData(request.data),digest=hash(data)
  return locked(state,request,async binding=>{
    if(!enabled(state,binding))throw new Error('自动 MVU 已关闭')
    const key=leaseKey(request),lease=leaseMap(state).get(key)
    if(!lease||lease.runtimeId!==request.runtimeId||lease.token!==request.token||lease.job.id!==request.jobId)throw new Error('自动 MVU 执行租约已失效，请重新准备')
    if(hash(binding)!==lease.binding||await scriptRevision(state,request)!==lease.scripts)throw new Error('自动 MVU 绑定或脚本库已改变')
    const events=await readDisplaySessionEvents(ctx,request.sessionId)
    verifyTarget(events,lease.job)
    if(helperHistoryRevision(helperHistoryOf(events,{char:'',user:''}))!==lease.history)throw new Error('自动 MVU 执行期间聊天历史已改变')
    const {ws,open}=await floorReady(state,binding,request.sessionId,lease.job)
    const saved=await loadHelperState(ws.fs),mvu=parseHelperMvuState(saved.mvu),receipt=mvu.completed.find(item=>item.id===request.jobId)
    verifyContinuation(events,lease.job,mvu)
    if(receipt){
      if(receipt.digest!==digest||receipt.identity!==lease.job.identity)throw new Error('自动 MVU 重试结果与完成回执不一致')
      if(hash(saved.scopes[scope(lease.job.identity)])!==receipt.valueDigest)throw new Error('自动 MVU 完成后的消息状态已被修改')
      if(!open)await ws.wal.commitFloor(lease.job.floor)
      lease.committed=digest
      return {storyId:request.storyId,enabled:true,status:mvu.pending.length?'waiting':'idle',awaitingTurnEnd:open,completed:mvu.completed.map(({id,digest})=>({id,digest}))}
    }
    if(stateHash(saved)!==lease.before||mvu.pending[0]?.id!==request.jobId)throw new Error('自动 MVU 变量或待处理队列已被另一运行时修改')
    saved.scopes[scope(lease.job.identity)]=helperMvuData({...(saved.scopes[scope(lease.job.identity)]??{}),...data})
    mvu.pending.shift();mvu.completed.push({id:lease.job.id,identity:lease.job.identity,kind:lease.job.kind,digest,valueDigest:hash(saved.scopes[scope(lease.job.identity)]),floor:lease.job.floor})
    mvu.completed=mvu.completed.slice(-256);mvu.initialized=true;mvu.lastIdentity=lease.job.identity;saved.mvu=mvu
    await ws.wal.reopenFloor(lease.job.floor)
    await saveHelperState(ws.fs.withFloor(lease.job.floor),saved)
    if(!open)await ws.wal.commitFloor(lease.job.floor)
    lease.committed=digest
    return {storyId:request.storyId,enabled:true,status:mvu.pending.length?'waiting':'idle',awaitingTurnEnd:open,completed:mvu.completed.map(({id,digest})=>({id,digest}))}
  })
}
