/** 世界书业务桥：固定会话和剧情，资产 CAS，聊天书集合与绑定切换通过同一文件及楼层 WAL 保存。 */
import {createHash,randomUUID} from 'node:crypto'
import {join} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {SessionBinding} from '../core/binding.js'
import {helperWorldbookSettingsCodec} from '../core/helperWorldbookSettings.js'
import {helperJson,helperRecord} from '../core/helperRuntime.js'
import {HELPER_CHARACTER_WORLDBOOK as CHARACTER,HELPER_WORLDBOOK_MAX_BYTES,type HelperWorldbookContext,type HelperWorldbookRequest,type HelperWorldbookResult,type HelperWorldbookRebindRequest} from '../core/helperWorldbook.js'
import {readHelperWorldbook,writeHelperWorldbook} from '../state/helperWorldbook.js'
import {CHAT_WORLDBOOK_PATH,chatWorldbookId,chatWorldbookRef,parseChatWorldbookFile,encodeChatWorldbooks,type ChatWorldbooks} from '../state/chatWorldbooks.js'
import {WorkspaceFs} from '../state/workspaceFs.js'
import {withWorkspaceLock} from '../state/workspaceLock.js'
import {withHelperStoryWrite} from './helperRuntime.js'
import type {TavernState} from './state.js'
function revision(value:unknown):string{return createHash('sha256').update(JSON.stringify(helperJson(value,HELPER_WORLDBOOK_MAX_BYTES))).digest('hex')}
function bindingRevision(state:TavernState,binding:SessionBinding,chat:ChatWorldbooks):string{return revision([binding.storyId,binding.cardId,binding.lorebookIds,binding.characterLorebookId,binding.useEmbeddedLorebook!==false,binding.characterLorebookIds??[],chat.active,state.worldInfoFor(binding)])}
async function chatBooks(state:TavernState,binding:SessionBinding):Promise<ChatWorldbooks>{const fs=(await state.storyWorkspace(binding.cardId,binding.storyId)).fs,text=await fs.readText(CHAT_WORLDBOOK_PATH);return parseChatWorldbookFile(text)}
async function selected(state:TavernState,sessionId:string,storyId:string,expected?:string){
  const binding=await state.loadBinding(sessionId)
  if(!binding?.storyId||binding.storyId!==storyId)throw new Error('世界书会话绑定已改变，请刷新')
  if(!state.config.interactiveCards||binding.interactiveCards===false)throw new Error('交互卡已关闭')
  const chat=await chatBooks(state,binding)
  if(expected!==undefined&&bindingRevision(state,binding,chat)!==expected)throw new Error('世界书会话绑定已改变，请刷新')
  return {binding,chat}
}
function name(value:unknown):string{if(typeof value!=='string'||!value.trim()||value.length>256)throw new Error('世界书名称无效');return value}
async function names(state:TavernState){const result=await state.listLorebooks();if(result.length>512)throw new Error('世界书目录超过 512 本的接口预算');return result}
/** 公共书只通过目录 ID 或唯一原名解析，剧情书标识只索引当前文件中的 Map，不拼成路径。 */
async function resolveBook(state:TavernState,value:string):Promise<string|null>{
  name(value);const ids=await names(state)
  if(ids.includes(value))return value
  let found:string|null=null
  for(const id of ids){const raw=await state.loadLorebookJson(id);if(helperRecord(raw)&&raw.name===value){if(found!==null)throw new Error('世界书名称不唯一，请使用目录中的文件标识');found=id}}
  return found
}
async function rawBook(state:TavernState,binding:SessionBinding,value:string,chat:ChatWorldbooks):Promise<{id:string;raw:unknown|null}> {
  const privateId=chatWorldbookId(value)
  if(privateId!==null)return {id:chatWorldbookRef(privateId),raw:chat.books.get(privateId)??null}
  if(value===CHARACTER){const fs=(await state.workspace(binding.cardId)).fs,raw=await fs.readText('assets/character-book.json');if(raw!==null)return {id:CHARACTER,raw:JSON.parse(raw)};const card=await state.loadCharacter(binding.cardId),book=card?.card.characterBook;return {id:CHARACTER,raw:book?(book.raw??{entries:book.entries}):null}}
  const id=await resolveBook(state,value)
  if(id===null)return {id:value,raw:null}
  const raw=await new WorkspaceFs(state.paths.root,null).readText('library/lorebooks/'+id+'.json')
  return {id,raw:raw===null?null:JSON.parse(raw)}
}
async function contextFrom(state:TavernState,binding:SessionBinding,chat:ChatWorldbooks):Promise<HelperWorldbookContext>{
  const items=await names(state),card=await state.loadCharacter(binding.cardId),embedded=await rawBook(state,binding,CHARACTER,chat)
  return {storyId:binding.storyId!,bindingRevision:bindingRevision(state,binding,chat),names:[...items,...(embedded.raw!==null?[CHARACTER]:[]),...Array.from(chat.books.keys(),chatWorldbookRef)],global:binding.lorebookIds.filter(id=>items.includes(id)),characterName:card?.card.name??'',settings:helperWorldbookSettingsCodec.fromNative(state.worldInfoFor(binding),binding.lorebookIds),
    character:{primary:binding.characterLorebookId?(items.includes(binding.characterLorebookId)?binding.characterLorebookId:null):(binding.useEmbeddedLorebook!==false&&embedded.raw!==null?CHARACTER:null),additional:(binding.characterLorebookIds??[]).filter(id=>items.includes(id)&&id!==binding.characterLorebookId)},chat:chat.active===null?null:chatWorldbookRef(chat.active)}
}
export async function getHelperWorldbookContext(state:TavernState,sessionId:string,storyId:string):Promise<HelperWorldbookContext>{
  return withWorkspaceLock(state.paths.sessions,async()=>{const {binding,chat}=await selected(state,sessionId,storyId);return contextFrom(state,binding,chat)})
}
export async function helperWorldbookOperation(ctx:Context,state:TavernState,sessionId:string,messageId:number,request:HelperWorldbookRequest):Promise<HelperWorldbookResult>{
  name(request.name);if(request.label!==undefined)name(request.label)
  if(!['get','replace','create','upsert','delete'].includes(request.operation))throw new Error('世界书操作无效')
  const privateId=chatWorldbookId(request.name)
  const run=async(writeChat?:(raw:unknown|null)=>Promise<void>):Promise<HelperWorldbookResult>=>withWorkspaceLock(state.paths.sessions,async()=>{
    const {binding,chat}=await selected(state,sessionId,request.storyId,request.bindingRevision)
    const lock=request.name===CHARACTER?join(state.paths.characters,binding.cardId):state.paths.root
    return withWorkspaceLock(lock,async()=>{
      const current=await rawBook(state,binding,request.name,chat)
      const snapshot=(raw:unknown,id=current.id)=>({name:id,revision:revision(raw),entries:readHelperWorldbook(raw).entries})
      if(request.operation==='get')return current.raw===null?{missing:true}:{snapshot:snapshot(current.raw)}
      if(request.operation==='create'&&current.raw!==null)return {created:false,snapshot:snapshot(current.raw)}
      if(request.operation==='delete'&&current.raw===null)return {deleted:false}
      if(request.operation==='replace'&&current.raw===null)throw new Error('世界书不存在')
      const next=request.operation==='delete'?null:writeHelperWorldbook(request.entries??[],current.raw??{name:request.label??request.name,entries:{}})
      if(current.raw!==null&&request.revision!==revision(current.raw)){
        if(next!==null&&revision(next)===revision(current.raw)){
          // 角色书的镜像可能仅写完一个文件，相同目标重试仍需补齐 card.json。
          if(request.name!==CHARACTER)return {created:false,snapshot:snapshot(current.raw)}
        }else throw new Error('世界书已被修改，请重新读取后合并')
      }
      if(current.raw===null&&request.revision!==undefined)throw new Error('世界书已被删除，请重新读取')
      if(privateId!==null){
        if(!writeChat)throw new Error('聊天世界书缺少楼层写入上下文')
        if(next===null){chat.books.delete(privateId);if(chat.active===privateId)chat.active=null}
        else{if(chat.books.size===0&&privateId==='main')chat.active='main';chat.books.set(privateId,next)}
        await writeChat(encodeChatWorldbooks(chat))
        const context=await contextFrom(state,binding,chat)
        return next===null?{deleted:true,context}:{created:current.raw===null,snapshot:snapshot(next),context}
      }
      if(request.name===CHARACTER){
        if(next===null)await state.deleteCharacterLorebook(binding.cardId)
        else await state.saveCharacterLorebook(binding.cardId,{...(next as Record<string,unknown>),name:CHARACTER})
        const saved=await rawBook(state,binding,CHARACTER,chat)
        return saved.raw===null?{deleted:true}:{created:current.raw===null,snapshot:snapshot(saved.raw)}
      }
      if(next===null){await state.deleteLorebook(current.id);return {deleted:true}}
      const id=await state.saveLorebook(current.raw===null?request.name:current.id,next),saved=await rawBook(state,binding,id,chat)
      if(saved.raw===null)throw new Error('世界书保存回执无法确认')
      return {created:current.raw===null,snapshot:snapshot(saved.raw,id)}
    })
  })
  if(privateId!==null&&request.operation!=='get')return withHelperStoryWrite(ctx,state,sessionId,messageId,request.storyId,async(fs,begin)=>run(async raw=>{
    await begin();try{if(raw===null)await fs.delete(CHAT_WORLDBOOK_PATH);else await fs.writeText(CHAT_WORLDBOOK_PATH,JSON.stringify(raw,null,2)+'\n')}finally{state.invalidateChatLorebook((await state.loadBinding(sessionId))!.cardId,request.storyId)}
  }))
  return run()
}
/** 全局/角色选择属于会话配置；聊天选择及私有副本属于剧情，存成单次 WAL 写入。 */
export async function rebindHelperWorldbooks(ctx:Context,state:TavernState,sessionId:string,messageId:number,request:HelperWorldbookRebindRequest):Promise<HelperWorldbookContext>{
  const value=helperJson(request.selection,16384)
  if(!['global','character','chat','ensure-chat','settings'].includes(request.kind))throw new Error('世界书绑定类型无效')
  if(request.kind==='ensure-chat'){
    if(value!==null)name(value)
    const existing=await withWorkspaceLock(state.paths.sessions,async()=>{const {binding,chat}=await selected(state,sessionId,request.storyId,request.bindingRevision);return chat.active===null?null:contextFrom(state,binding,chat)})
    if(existing)return existing
  }
  const run=async(writeChat?:(raw:unknown|null)=>Promise<void>)=>withWorkspaceLock(state.paths.sessions,async()=>{
    const {binding,chat}=await selected(state,sessionId,request.storyId,request.bindingRevision)
    return withWorkspaceLock(state.paths.root,async()=>{
      const shared=async(input:unknown)=>{const ref=name(input);if(chatWorldbookId(ref)!==null)throw new Error('剧情书不能作为共享角色或全局绑定');const id=await resolveBook(state,ref);if(id===null)throw new Error('绑定的世界书不存在');const book=await rawBook(state,binding,id,chat);if(book.raw===null)throw new Error('绑定的世界书不存在');readHelperWorldbook(book.raw);return id}
      const sharedList=async(input:unknown)=>{if(!Array.isArray(input)||input.length>64)throw new Error('世界书绑定列表必须至多 64 项');const result:string[]=[];for(const item of input){const id=await shared(item);if(!result.includes(id))result.push(id)}return result}
      if(request.kind==='settings'){
        const patch=helperWorldbookSettingsCodec.patch(value),worldInfo={...binding.worldInfo,...helperWorldbookSettingsCodec.toNative(patch)}
        const lorebookIds=patch.selected_global_lorebooks===undefined?binding.lorebookIds:await sharedList(patch.selected_global_lorebooks)
        const next={...binding,worldInfo,lorebookIds};await state.saveBinding(next);return contextFrom(state,next,chat)
      }
      if(request.kind==='global'){const lorebookIds=await sharedList(value),next={...binding,lorebookIds};await state.saveBinding(next);return contextFrom(state,next,chat)}
      if(request.kind==='character'){
        if(!helperRecord(value)||!Array.isArray(value.additional)||value.primary!==null&&typeof value.primary!=='string'||Object.keys(value).some(key=>!['primary','additional'].includes(key)))throw new Error('角色世界书绑定无效')
        let primary:string|null=null,embedded=false
        if(value.primary===CHARACTER){const book=await rawBook(state,binding,CHARACTER,chat);if(book.raw===null)throw new Error('角色内嵌书不存在');readHelperWorldbook(book.raw);embedded=true}
        else if(value.primary!==null)primary=await shared(value.primary)
        const additional=(await sharedList(value.additional)).filter(id=>id!==primary),next={...binding,characterLorebookId:primary,useEmbeddedLorebook:embedded,characterLorebookIds:additional}
        await state.saveBinding(next);return contextFrom(state,next,chat)
      }
      if(!writeChat)throw new Error('聊天绑定缺少楼层写入上下文')
      if(request.kind==='ensure-chat'){
        if(chat.active!==null)return contextFrom(state,binding,chat)
        const matches=value===null?[]:[...chat.books].filter(([,raw])=>helperRecord(raw)&&raw.name===value)
        if(matches.length>1)throw new Error('剧情内世界书名称不唯一，请显式绑定目录标识')
        const target=matches[0]?.[0]??(!chat.books.has('main')?'main':'book-'+randomUUID())
        if(!chat.books.has(target))chat.books.set(target,{name:value??'聊天世界书',entries:{}})
        chat.active=target
      }else if(value===null)chat.active=null
      else{
        const ref=name(value),privateId=chatWorldbookId(ref)
        if(privateId!==null){if(!chat.books.has(privateId))throw new Error('剧情世界书不存在');chat.active=privateId}
        else{
          const source=await rawBook(state,binding,ref,chat);if(source.raw===null)throw new Error('绑定的世界书不存在');readHelperWorldbook(source.raw)
          const target='source-'+createHash('sha256').update(source.id).digest('hex').slice(0,24)
          if(!chat.books.has(target))chat.books.set(target,source.raw)
          chat.active=target
        }
      }
      await writeChat(encodeChatWorldbooks(chat));return contextFrom(state,binding,chat)
    })
  })
  if(request.kind==='global'||request.kind==='character'||request.kind==='settings')return run()
  return withHelperStoryWrite(ctx,state,sessionId,messageId,request.storyId,async(fs,begin)=>run(async raw=>{
    await begin();try{if(raw===null)await fs.delete(CHAT_WORLDBOOK_PATH);else await fs.writeText(CHAT_WORLDBOOK_PATH,JSON.stringify(raw,null,2)+'\n')}finally{state.invalidateChatLorebook((await state.loadBinding(sessionId))!.cardId,request.storyId)}
  }))
}
