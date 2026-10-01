/** 卡面世界书租约集成：真实宿主会话及文件系统验证资产/剧情锁排队撤销、末级写许可、只读与聊天 WAL 回滚。 */
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {Session,SessionId,SessionStore} from '@deepseek-ai/dsh-session'
import {createAssistantMessage,createUserMessage} from '@deepseek-ai/dsh-llm'
import {TavernState} from '../src/node/state.js'
import {resolveConfig} from '../src/node/config.js'
import {TavernService} from '../src/node/service.js'
import type {HelperFrameLease,HelperFrameOpen} from '../src/core/helperFrame.js'
import type {HelperWorldbookRebindRequest} from '../src/core/helperWorldbook.js'
import {CHAT_WORLDBOOK_PATH} from '../src/state/chatWorldbooks.js'
import {WorkspaceFs} from '../src/state/workspaceFs.js'
import {withWorkspaceLock} from '../src/state/workspaceLock.js'

const lockProbe=vi.hoisted(()=>({root:'',queued:null as (()=>void)|null}))
vi.mock('../src/state/workspaceLock.js',async importOriginal=>{
  const actual=await importOriginal<typeof import('../src/state/workspaceLock.js')>()
  return {...actual,withWorkspaceLock:<T>(root:string,task:()=>Promise<T>)=>{
    if(root===lockProbe.root)lockProbe.queued?.()
    return actual.withWorkspaceLock(root,task)
  }}
})

let root:string,state:TavernState,ctx:Context,cardId:string,source:Session,messageId:number,service:TavernService
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'helper-frame-worldbook-'))
  state=new TavernState({root,characters:join(root,'characters'),lorebooks:join(root,'library/lorebooks'),presets:join(root,'library/presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')},()=>resolveConfig({}))
  await state.init();cardId=(await state.createCharacter('世界书租约工厂角色')).cardId
  ctx=new Context();new SessionStore(ctx);new AgentRegistry(ctx);source=ctx.sessions.create(SessionId('frame-worldbook-story'))
  source.append('agent-preset/selected',{agentPreset:'tavern'})
  source.append('turn/start',{turn:1})
  source.append('user/message',createUserMessage({content:[{type:'text',text:'用户台词'}],source:{kind:'user'}}),{surfaceOp:'append'})
  source.append('assistant/message',{stream:[],turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'角色回复'}],source:{provider:'factory',model:'factory'}})},{surfaceOp:'append'})
  source.append('turn/end',{turn:1,reason:{kind:'completed'}})
  messageId=source.snapshotEvents().find(event=>event.type==='assistant/message')!.seq
  await state.saveBinding({sessionId:source.id,cardId,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:'factory'})
  service=new TavernService(ctx,state,{get:()=>resolveConfig({}),update:async()=>undefined})
})
afterEach(async()=>{
  lockProbe.root='';lockProbe.queued=null;vi.restoreAllMocks()
  await ctx?.fiber.dispose();await rm(root,{recursive:true,force:true})
})
async function frameRequest(epoch=1,readOnly=false):Promise<HelperFrameOpen>{
  return {sessionId:source.id,messageId,storyId:(await state.loadBinding(source.id))!.storyId!,frameId:'private-worldbook-frame',runtimeId:'worldbook-runtime-'+epoch,epoch,readOnly}
}
async function lease(input:HelperFrameOpen):Promise<HelperFrameLease>{return {...input,token:(await service.openHelperFrame(input)).token}}
async function files(){
  const fs=new WorkspaceFs(root,null)
  return Promise.all((await fs.list()).map(async path=>[path,Buffer.from((await fs.readBytes(path))!).toString('base64')]))
}
async function bookContext(storyId:string){return service.getHelperWorldbookContext({sessionId:source.id,storyId})}
async function seedBook(name:string,storyId:string){
  const raw={name,entries:{'factory-entry':{content:'原设定'}}}
  if(name==='@dsh/character')await state.saveCharacterLorebook(cardId,raw)
  else if(name==='@dsh/chat')await state.saveChatLorebook(cardId,raw,storyId)
  else await state.saveLorebook(name,raw)
}
async function book(name:string,storyId:string,frameLease?:HelperFrameLease){
  const context=await bookContext(storyId)
  return service.helperWorldbookOperation({sessionId:source.id,messageId,storyId,bindingRevision:context.bindingRevision,name,operation:'get',...(frameLease?{frameLease}:{})})
}
async function rotateWhileQueued(lock:string,input:HelperFrameOpen,write:()=>Promise<unknown>){
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),queued=Promise.withResolvers<void>()
  const held=withWorkspaceLock(lock,async()=>{entered.resolve();await release.promise})
  await entered.promise;lockProbe.root=lock;lockProbe.queued=queued.resolve
  const pending=write().then(()=>({saved:true}),error=>({saved:false,error:String(error)}))
  let opening:Promise<{token:string}>|undefined
  try{
    await Promise.race([queued.promise,pending.then(result=>{throw new Error('未到真实锁队列：'+JSON.stringify(result))})])
    // open 在第一个 await 前撤销旧 token，即使旧写入已持有 sessions 锁仍须即时失效。
    opening=service.openHelperFrame({...input,epoch:2,runtimeId:'worldbook-runtime-2'})
  }finally{
    lockProbe.root='';lockProbe.queued=null;release.resolve();await held
  }
  expect(await pending).toMatchObject({saved:false,error:expect.stringContaining('租约已失效')})
  return {...input,epoch:2,runtimeId:'worldbook-runtime-2',token:(await opening!).token}
}

it.each(['public-book','@dsh/character','@dsh/chat'])('%s 的旧 CRUD 请求在真实资产/剧情锁队列中被新 epoch 撤销，资产和 WAL 全部不变',async name=>{
  const input=await frameRequest();await seedBook(name,input.storyId)
  const frameLease=await lease(input),context=await bookContext(input.storyId),snapshot=(await book(name,input.storyId)).snapshot!
  const before=await files(),ws=await state.storyWorkspace(cardId,input.storyId)
  const lock=name==='@dsh/chat'?ws.fs.root:name==='@dsh/character'?join(state.paths.characters,cardId):state.paths.root
  const fresh=await rotateWhileQueued(lock,input,()=>service.helperWorldbookOperation({sessionId:source.id,messageId,storyId:input.storyId,bindingRevision:context.bindingRevision,frameLease,name,operation:'replace',revision:snapshot.revision,entries:[{...snapshot.entries[0]!,content:'旧运行时不得保存'}]}))
  expect(await files()).toEqual(before)
  expect((await book(name,input.storyId,fresh)).snapshot!.entries[0]?.content).toBe('原设定')
})

it.each(['global','character','chat'] as const)('%s 世界书绑定排队时撤销旧许可，不改会话选择、剧情副本或 WAL',async kind=>{
  const input=await frameRequest();await seedBook('source-book',input.storyId)
  const frameLease=await lease(input),context=await bookContext(input.storyId),before=await files(),ws=await state.storyWorkspace(cardId,input.storyId)
  const selection:HelperWorldbookRebindRequest['selection']=kind==='global'?['source-book']:kind==='character'?{primary:'source-book',additional:[]}:'source-book'
  await rotateWhileQueued(kind==='chat'?ws.fs.root:state.paths.root,input,()=>service.rebindHelperWorldbooks({sessionId:source.id,messageId,storyId:input.storyId,bindingRevision:context.bindingRevision,frameLease,kind,selection}))
  expect(await files()).toEqual(before)
  expect(await bookContext(input.storyId)).toEqual(context)
})

it.each(['public-book','@dsh/character'])('%s 已通过业务校验后在异步存储准备期间轮换，末级许可仍拒绝落盘',async name=>{
  const input=await frameRequest();await seedBook(name,input.storyId)
  const frameLease=await lease(input),context=await bookContext(input.storyId),snapshot=(await book(name,input.storyId)).snapshot!,before=await files()
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  if(name==='@dsh/character'){
    const original=state.saveCharacterLorebook.bind(state)
    vi.spyOn(state,'saveCharacterLorebook').mockImplementation(async(...args)=>{entered.resolve();await release.promise;return original(...args)})
  }else{
    const original=state.saveLorebook.bind(state)
    vi.spyOn(state,'saveLorebook').mockImplementation(async(...args)=>{entered.resolve();await release.promise;return original(...args)})
  }
  const pending=service.helperWorldbookOperation({sessionId:source.id,messageId,storyId:input.storyId,bindingRevision:context.bindingRevision,frameLease,name,operation:'replace',revision:snapshot.revision,entries:[{...snapshot.entries[0]!,content:'异步准备后不得保存'}]}).then(()=>({saved:true}),error=>({saved:false,error:String(error)}))
  try{
    await Promise.race([entered.promise,pending.then(result=>{throw new Error('未到存储准备屏障：'+JSON.stringify(result))})])
    const opened=service.openHelperFrame({...input,epoch:2,runtimeId:'worldbook-runtime-2'})
    release.resolve()
    expect(await pending).toMatchObject({saved:false,error:expect.stringContaining('租约已失效')});await opened
  }finally{release.resolve()}
  expect(await files()).toEqual(before)
})

it('新的可写许可可以创建并切换聊天书，真实完成楼层 WAL 一次回滚撤销副本和绑定，公共来源保持原样',async()=>{
  const old=await frameRequest();await seedBook('source-book',old.storyId);await lease(old)
  const input={...old,epoch:2,runtimeId:'worldbook-runtime-2'},frameLease=await lease(input),context=await bookContext(input.storyId)
  const selected=await service.rebindHelperWorldbooks({sessionId:source.id,messageId,storyId:input.storyId,bindingRevision:context.bindingRevision,frameLease,kind:'chat',selection:'source-book'})
  const current=(await book(selected.chat!,input.storyId)).snapshot!
  await service.helperWorldbookOperation({sessionId:source.id,messageId,storyId:input.storyId,bindingRevision:selected.bindingRevision,frameLease,name:selected.chat!,operation:'replace',revision:current.revision,entries:[{...current.entries[0]!,content:'当前剧情的新设定'}]})
  expect((await book(selected.chat!,input.storyId)).snapshot!.entries[0]?.content).toBe('当前剧情的新设定')
  expect((await book('source-book',input.storyId)).snapshot!.entries[0]?.content).toBe('原设定')
  const ws=await state.storyWorkspace(cardId,input.storyId)
  expect(await ws.wal.listFloors()).toContainEqual(expect.objectContaining({floor:source.id+'#t1',committed:true}))
  expect(await ws.fs.readText(CHAT_WORLDBOOK_PATH)).not.toBeNull()
  await ws.wal.rollbackFloor(source.id+'#t1',ws.fs.root)
  expect((await bookContext(input.storyId)).chat).toBeNull()
  expect((await book(selected.chat!,input.storyId)).missing).toBe(true)
  expect((await book('source-book',input.storyId)).snapshot!.entries[0]?.content).toBe('原设定')
})

it('只读候选许可可以读取现代世界书，CRUD 和绑定写入明确拒绝且不产生 WAL 或资产变更',async()=>{
  const input=await frameRequest(1,true);await seedBook('source-book',input.storyId)
  const frameLease=await lease(input),context=await bookContext(input.storyId),snapshot=(await book('source-book',input.storyId,frameLease)).snapshot!,before=await files()
  expect(snapshot.entries[0]?.content).toBe('原设定')
  await expect(service.helperWorldbookOperation({sessionId:source.id,messageId,storyId:input.storyId,bindingRevision:context.bindingRevision,frameLease,name:'source-book',operation:'replace',revision:snapshot.revision,entries:[]})).rejects.toThrow(/租约已失效/)
  await expect(service.rebindHelperWorldbooks({sessionId:source.id,messageId,storyId:input.storyId,bindingRevision:context.bindingRevision,frameLease,kind:'chat',selection:'source-book'})).rejects.toThrow(/租约已失效/)
  expect(await files()).toEqual(before)
})
