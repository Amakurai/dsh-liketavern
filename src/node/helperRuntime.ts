/** 将酒馆助手状态绑定真实宿主会话；只公开本剧情可见文本，提交不接受任意宿主方法或路径。 */
import {assertHelperMvuWritable,ensureHelperMvuScriptAnchor} from './helperMvu.js'
import {effectiveHelperSwipes,type HelperSwipeSet} from '../core/helperSwipes.js'
import {expandIdentityMacros} from '../core/macros.js'
import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { helperJson, helperChanges, helperScopeKey, type HelperDisplayContext, type HelperScopes, type HelperSnapshot } from '../core/helperRuntime.js'
import { isSyntheticUserText } from '../core/dshPrompt.js'
import { DEFAULT_USER_NAME } from '../core/persona.js'
import { applyHelperChanges, commitHelperChanges, loadHelperScopes, loadHelperState, type HelperState } from '../state/helper.js'
import type { WorkspaceFs } from '../state/workspaceFs.js'
import { withWorkspaceLock } from '../state/workspaceLock.js'
import { readDisplaySessionEvents } from './sessionEvents.js'
import type { TavernState } from './state.js'
import { enabledHelperLibraries,type HelperScriptBundle } from '../core/helperScripts.js'
import { characterPromptName } from '../core/characterData.js'

/**
 * Helper 历史只由不可变宿主事件快照与显示名称派生；一个长会话打开时，前端会并发为
 * 每个历史气泡请求 renderOutputText。若每个请求都重扫完整日志并重算 sha256，会退化成
 * O(消息数²)。这里只缓存最近若干会话的一份派生视图：
 *
 * - live Session 的 snapshotEvents() 通常在 append 后更换引用；兼容桩若原地增长，长度与尾事件也会失效；
 * - 换卡/换剧情/换人设纳入 bindingKey，角色或人设改名再由显示名称失效；
 * - 绑定、工作区、open floor 与 writable 绝不进入缓存，仍在每次读取及剧情锁内复核；
 * - 最多保留 8 个会话，单条历史本身还有 helperHistoryOf 的 4 MiB / 4096 条上限。
 */
const HELPER_HISTORY_CACHE_SESSIONS = 8
type HelperHistory = ReturnType<typeof helperHistoryOf>
interface HelperHistoryCacheEntry {
  events: readonly SessionEvent[]
  eventCount: number
  lastEvent: SessionEvent|undefined
  lastEventSeq: number|undefined
  bindingKey: string
  charName: string
  userName: string
  history: HelperHistory
  historyRevision: string
  assistantIndexBySeq: ReadonlyMap<number,number>
  indexByIdentity: ReadonlyMap<string,number>
  lastBoundary: {type:'turn/start'|'turn/end';turn:number}|undefined
}
const helperHistoryCaches = new WeakMap<TavernState,Map<string,HelperHistoryCacheEntry>>()

function cachedHelperHistory(state:TavernState,sessionId:string,events:readonly SessionEvent[],bindingKey:string,names:{char:string;user:string}):HelperHistoryCacheEntry {
  let cache=helperHistoryCaches.get(state)
  if(!cache){cache=new Map();helperHistoryCaches.set(state,cache)}
  const previous=cache.get(sessionId)
  const lastEvent=events.at(-1)
  if(previous?.events===events&&previous.eventCount===events.length&&previous.lastEvent===lastEvent&&previous.lastEventSeq===lastEvent?.seq
    &&previous.bindingKey===bindingKey&&previous.charName===names.char&&previous.userName===names.user){
    // Map 的插入顺序兼作 LRU；命中移到末尾，避免活跃长会话被后台查询挤出。
    cache.delete(sessionId);cache.set(sessionId,previous)
    return previous
  }
  const history=helperHistoryOf(events,names),assistantIndexBySeq=new Map<number,number>(),indexByIdentity=new Map<string,number>()
  history.forEach((message,index)=>{if(!indexByIdentity.has(message.identity))indexByIdentity.set(message.identity,index);if(message.role==='assistant')assistantIndexBySeq.set(message.seq,index)})
  let lastBoundary:HelperHistoryCacheEntry['lastBoundary']
  for(let index=events.length-1;index>=0;index--){
    const event=events[index]!
    if(event.type==='turn/start'||event.type==='turn/end'){lastBoundary={type:event.type,turn:event.data.turn};break}
  }
  const entry={events,eventCount:events.length,lastEvent,lastEventSeq:lastEvent?.seq,bindingKey,charName:names.char,userName:names.user,history,
    historyRevision:helperHistoryRevision(history),assistantIndexBySeq,indexByIdentity,lastBoundary} satisfies HelperHistoryCacheEntry
  cache.delete(sessionId);cache.set(sessionId,entry)
  while(cache.size>HELPER_HISTORY_CACHE_SESSIONS)cache.delete(cache.keys().next().value!)
  return entry
}

export function helperHistoryOf(events: readonly SessionEvent[], names: {char:string;user:string}) {
  const messages: {seq:number;identity:string;name:string;role:'user'|'assistant';message:string}[] = []
  let bytes = 0
  for (const event of events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    // 摘要替换是模型视图，用户实际见过的 append 原文仍属于聊天历史。
    if ('surfaceOp' in event && event.surfaceOp !== undefined && event.surfaceOp !== 'append') continue
    const message = event.type === 'user/message' ? event.data : event.data.message
    const text = message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
    if (!text.trim() || event.type==='user/message' && isSyntheticUserText(text)) continue
    bytes += Buffer.byteLength(text)
    if (messages.length >= 4096 || bytes > 4 * 1024 * 1024) throw new Error('酒馆助手历史超出快照预算，需要分页加载')
    messages.push({seq:event.seq,identity:String(message.id),name:event.type==='user/message'?names.user:names.char,
      role:event.type==='user/message'?'user':'assistant',message:text})
  }
  return messages
}
export function helperHistoryRevision(history:ReturnType<typeof helperHistoryOf>):string{
  return createHash('sha256').update(JSON.stringify(history.map(({seq,identity,message})=>[seq,identity,message]))).digest('hex')
}
async function helperContext(ctx:Context,state:TavernState,sessionId:string,messageId:number) {
  const binding=await state.loadBinding(sessionId)
  if (!binding?.storyId) throw new Error('会话未绑定可用剧情')
  const events=await readDisplaySessionEvents(ctx,sessionId)
  const card=await state.loadCharacter(binding.cardId),persona=await state.resolvePersona(binding.personaId)
  const charName=card?characterPromptName(card.card):'Assistant'
  const names={char:card?.card.name??'Assistant',user:persona?.name??DEFAULT_USER_NAME}
  const bindingKey=`${binding.cardId}\0${binding.storyId}\0${binding.personaId??''}`
  const cached=cachedHelperHistory(state,sessionId,events,bindingKey,names)
  const history=cached.history,currentMessageId=cached.assistantIndexBySeq.get(messageId)??-1
  if (currentMessageId<0) throw new Error('卡面消息不在当前剧情中')
  const turn=cached.lastBoundary?.type==='turn/end'?cached.lastBoundary.turn:0
  const writable=!state.openFloors.has(sessionId) && cached.lastBoundary?.type!=='turn/start'
  const historyRevision=cached.historyRevision
  const ws=await state.storyWorkspace(binding.cardId,binding.storyId)
  const greetings=card?[card.card.firstMes,...card.card.alternateGreetings].map(text=>expandIdentityMacros(text,{char:charName,user:persona?.name??DEFAULT_USER_NAME})):[]
  return {binding,history,currentMessageId,historyRevision,indexByIdentity:cached.indexByIdentity,ws,writable,turn,greetings}
}
function publicScopes(scopes:HelperScopes,indexByIdentity:ReadonlyMap<string,number>):HelperScopes {
  const result:HelperScopes={}
  for(const [key,value] of Object.entries(scopes)) {
    const [type,id]=helperScopeKey(key)
    if(type!=='message') result[key]=value
    else {
      const index=typeof id==='string'?indexByIdentity.get(id):undefined
      if(index!==undefined) result[JSON.stringify(['message',index])]=value
    }
  }
  return result
}
function snapshot(context:Awaited<ReturnType<typeof helperContext>>,scopes:HelperScopes,extras:HelperState['extras']={},swipes:Record<string,HelperSwipeSet>={}):HelperSnapshot {
  const exposed=publicScopes(scopes,context.indexByIdentity)
  return {storyId:context.binding.storyId!,historyRevision:context.historyRevision,currentMessageId:context.currentMessageId,
    writable:context.writable,scopes:exposed,messages:context.history.map((message,index)=>{
      const data=exposed[JSON.stringify(['message',index])]??{},extra=extras[message.identity]??{}
      const initial=index===0&&message.role==='assistant'&&context.greetings.length?{active:Math.min(context.binding.greetingIndex,context.greetings.length-1),pages:context.greetings.map(text=>({message:text,data:{},extra:{}}))}:undefined
      return {message_id:index,name:message.name,role:message.role,is_hidden:false,message:message.message,data,extra,
        swipe:effectiveHelperSwipes({message:message.message,data,extra},swipes[message.identity]??initial)}
    })}
}
/**
 * 纯文本展示只返回剧情/历史身份与当前消息角色；仍在剧情锁内二次读取，
 * 与完整 HelperSnapshot 保持同一套绑定和历史修订校验，但不读取、复制变量表。
 */
export async function getHelperDisplayContext(ctx:Context,state:TavernState,sessionId:string,messageId:number):Promise<HelperDisplayContext> {
  const context=await helperContext(ctx,state,sessionId,messageId)
  return withWorkspaceLock(context.ws.fs.root,async()=>{
    const current=await helperContext(ctx,state,sessionId,messageId)
    if(current.ws.fs.root!==context.ws.fs.root)throw new Error('卡面剧情绑定已经改变')
    const message=current.history[current.currentMessageId]
    if(!message)throw new Error('卡面消息不在当前剧情中')
    return {storyId:current.binding.storyId!,historyRevision:current.historyRevision,currentMessageId:current.currentMessageId,currentMessageRole:message.role}
  })
}
export async function getHelperSnapshot(ctx:Context,state:TavernState,sessionId:string,messageId:number):Promise<HelperSnapshot> {
  const context=await helperContext(ctx,state,sessionId,messageId)
  return withWorkspaceLock(context.ws.fs.root,async()=>{
    const current=await helperContext(ctx,state,sessionId,messageId)
    if(current.ws.fs.root!==context.ws.fs.root) throw new Error('卡面剧情绑定已经改变')
    const saved=await loadHelperState(current.ws.fs)
    return snapshot(current,saved.scopes,saved.extras,saved.swipes)
  })
}
export async function getHelperScriptBundle(ctx:Context,state:TavernState,sessionId:string):Promise<HelperScriptBundle> {
  const binding=await state.loadBinding(sessionId)
  if(!binding?.storyId)throw new Error('会话未绑定可用剧情')
  const ensureBinding=async()=>{
    const current=await state.loadBinding(sessionId)
    if(!current||current.storyId!==binding.storyId||current.cardId!==binding.cardId||current.presetId!==binding.presetId||current.personaId!==binding.personaId||current.interactiveCards!==binding.interactiveCards||current.helperMvu!==binding.helperMvu)throw new Error('脚本会话绑定已改变，请重新加载')
  }

  // 预设被删除或损坏时与 getSessionHelperScripts 同口径：按没有预设脚本加载，不让整个脚本包失败。
  const hasPreset=binding.presetId!==null&&await state.loadPreset(binding.presetId)!==null
  const libraries=await Promise.all([
    state.getHelperScriptLibrary({type:'global'}),
    ...(hasPreset?[state.getHelperScriptLibrary({type:'preset',presetId:binding.presetId!})]:[]),
    state.getHelperScriptLibrary({type:'character',cardId:binding.cardId}),
  ])
  await ensureBinding()
  const enabled=state.config.interactiveCards&&binding.interactiveCards!==false
  const character=libraries.find(library=>library.target.type==='character')!
  const card=await state.loadCharacter(binding.cardId),persona=await state.resolvePersona(binding.personaId)
  // 角色/人设元数据读取同样跨越异步边界；若此时会话换绑，不能把旧名称连同新一轮
  // 脚本运行时一起返回。尤其 disabled / 无脚本分支会在下面提前返回，必须先复核。
  await ensureBinding()
  const name=card?.card.name??binding.cardName
  const base={helperMvu:binding.helperMvu===true,cardId:binding.cardId,trees:character.trees,revision:character.revision,libraries,storyId:binding.storyId,enabled,whitelist:[...state.config.cardNetworkWhitelist],
    name,characterName:card?characterPromptName(card.card):name,userName:persona?.name??DEFAULT_USER_NAME}
  if(!enabled)return {...base,messageId:null}
  try{helperJson(libraries,4*1024*1024);if(!enabledHelperLibraries(libraries).length&&!base.helperMvu)return {...base,messageId:null}}
  catch(error){return {...base,messageId:null,runtimeError:error instanceof Error?error.message:String(error)}}
  let messageId:number|null
  if(base.helperMvu)messageId=await ensureHelperMvuScriptAnchor(ctx,state,sessionId,binding.storyId)
  else{
    const events=await readDisplaySessionEvents(ctx,sessionId)
    messageId=[...events].reverse().find(event=>event.type==='assistant/message'&&(!('surfaceOp' in event)||event.surfaceOp===undefined||event.surfaceOp==='append'))?.seq??null
  }
  if(messageId===null)return {...base,messageId:null}
  const snapshot=await getHelperSnapshot(ctx,state,sessionId,messageId)
  await ensureBinding()
  if(snapshot.storyId!==binding.storyId)throw new Error('脚本剧情绑定已改变')
  const scriptContext=await state.getSessionHelperScripts(sessionId,binding.storyId)
  await ensureBinding()
  if(scriptContext.libraries.some(library=>libraries.find(item=>item.target.type===library.type)?.revision!==library.revision))throw new Error('加载期间脚本库已改变，请重新加载')
  return {...base,messageId,snapshot,scriptContext}
}
export async function commitHelperVariables(ctx:Context,state:TavernState,request:{sessionId:string;messageId:number;storyId:string;historyRevision:string;changes:unknown}):Promise<HelperSnapshot> {
  const changes=helperChanges(request.changes)
  const context=await helperContext(ctx,state,request.sessionId,request.messageId)
  return withWorkspaceLock(context.ws.fs.root,async()=>{
    const current=await helperContext(ctx,state,request.sessionId,request.messageId)
    if(current.binding.storyId!==request.storyId || current.ws.fs.root!==context.ws.fs.root) throw new Error('卡面剧情绑定已经改变')
    if(current.historyRevision!==request.historyRevision) throw new Error('聊天历史已改变，请刷新卡面后重试')
    if(!state.config.interactiveCards||current.binding.interactiveCards===false)throw new Error('交互卡已关闭')
    await assertHelperMvuWritable(state,request.sessionId)
    if(!current.writable) throw new Error('生成期间不能修改酒馆助手剧情变量')
    const mapped=changes.map(change=>{
      const [type,id]=helperScopeKey(change.key)
      if(type!=='message') return change
      if(typeof id!=='number'||!current.history[id]) throw new Error('目标消息不在当前剧情中')
      return {...change,key:JSON.stringify(['message',current.history[id]!.identity])}
    })
    const floor=`${request.sessionId}#t${current.turn}`
    applyHelperChanges(await loadHelperScopes(current.ws.fs),mapped)
    const floors=await current.ws.wal.listFloors()
    if(floors.some(item=>item.floor===floor && item.rolledBack)) throw new Error('酒馆助手目标楼层已回滚')
    if(floors.some(item=>item.floor===floor)) await current.ws.wal.validateFloor(floor)
    else await current.ws.wal.beginFloor(floor)
    const scopes=await commitHelperChanges(current.ws.fs.withFloor(floor),mapped)
    await current.ws.wal.commitFloor(floor)
    const saved=await loadHelperState(current.ws.fs)
    return snapshot(current,scopes,saved.extras,saved.swipes)
  })
}

/** 聊天世界书等沙箱剧情写入复用楼层纪律；先验证业务内容，再调用 begin，最后 WAL 提交。 */
export async function withHelperStoryWrite<T>(ctx:Context,state:TavernState,sessionId:string,messageId:number,storyId:string,write:(fs:WorkspaceFs,begin:()=>Promise<void>)=>Promise<T>):Promise<T> {
  const first=await helperContext(ctx,state,sessionId,messageId)
  return withWorkspaceLock(first.ws.fs.root,async()=>{
    const current=await helperContext(ctx,state,sessionId,messageId)
    if(current.binding.storyId!==storyId||current.ws.fs.root!==first.ws.fs.root)throw new Error('世界书剧情绑定已改变')
    if(!state.config.interactiveCards||current.binding.interactiveCards===false)throw new Error('交互卡已关闭')
    await assertHelperMvuWritable(state,sessionId)
    if(!current.writable)throw new Error('生成期间不能修改聊天世界书')
    const floor=sessionId+'#t'+current.turn
    let started=false
    const begin=async()=>{
      if(started)return
      const floors=await current.ws.wal.listFloors()
      if(floors.some(item=>item.floor===floor&&item.rolledBack))throw new Error('世界书目标楼层已回滚')
      if(floors.some(item=>item.floor===floor))await current.ws.wal.validateFloor(floor)
      else await current.ws.wal.beginFloor(floor)
      started=true
    }
    const result=await write(current.ws.fs.withFloor(floor),begin)
    if(started)await current.ws.wal.commitFloor(floor)
    return result
  })
}
