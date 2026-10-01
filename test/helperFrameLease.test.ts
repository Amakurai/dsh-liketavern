/** 真实剧情文件与锁屏障验证：旧卡面写许可排队时被新运行时撤销，不得开始 WAL 或改写变量。 */
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import {Context} from '@deepseek-ai/cordis'
import {AgentRegistry} from '@deepseek-ai/dsh-agent'
import {Session,SessionId,SessionStore,type SessionEvent} from '@deepseek-ai/dsh-session'
import {createAssistantMessage,createUserMessage} from '@deepseek-ai/dsh-llm'
import {TavernState} from '../src/node/state.js'
import {resolveConfig} from '../src/node/config.js'
import {commitHelperVariables,getHelperSnapshot} from '../src/node/helperRuntime.js'
import {withWorkspaceLock} from '../src/state/workspaceLock.js'
import {HELPER_STATE_PATH} from '../src/state/helper.js'
import {TavernService} from '../src/node/service.js'
import type {HelperFrameLease,HelperFrameOpen} from '../src/core/helperFrame.js'
import {WorkspaceFs} from '../src/state/workspaceFs.js'
import {greetingTurnEvents} from '../src/node/greetingSeed.js'

let root:string,state:TavernState,ctx:Context,cardId:string,source:Session,messageId:number,service:TavernService
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'helper-frame-lease-'))
  state=new TavernState({root,characters:join(root,'characters'),lorebooks:join(root,'library/lorebooks'),presets:join(root,'library/presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')},()=>resolveConfig({}))
  await state.init();cardId=(await state.createCharacter('租约工厂角色')).cardId
  ctx=new Context();new SessionStore(ctx);new AgentRegistry(ctx);source=ctx.sessions.create(SessionId('frame-lease-story'))
  source.append('agent-preset/selected',{agentPreset:'tavern'})
  source.append('turn/start',{turn:1})
  source.append('user/message',createUserMessage({content:[{type:'text',text:'用户台词'}],source:{kind:'user'}}),{surfaceOp:'append'})
  source.append('assistant/message',{stream:[],turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'角色回复'}],source:{provider:'factory',model:'factory'}})},{surfaceOp:'append'})
  source.append('turn/end',{turn:1,reason:{kind:'completed'}})
  messageId=source.snapshotEvents().find(event=>event.type==='assistant/message')!.seq
  await state.saveBinding({sessionId:source.id,cardId,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:'factory'})
  service=new TavernService(ctx,state,{get:()=>resolveConfig({}),update:async()=>undefined})
})
afterEach(async()=>{vi.restoreAllMocks();await ctx?.fiber.dispose();await rm(root,{recursive:true,force:true})})
const frameRequest=async(epoch=1):Promise<HelperFrameOpen>=>({sessionId:source.id,messageId,storyId:(await state.loadBinding(source.id))!.storyId!,frameId:'private-frame-factory',runtimeId:'runtime-factory-'+epoch,epoch,readOnly:false})
const frame=async(input:HelperFrameOpen):Promise<HelperFrameLease>=>({...input,token:(await service.openHelperFrame(input)).token})

it('旧运行时已经发出、仍排剧情锁的变量写入必须拒绝，正文及真实 WAL 都不变化',async()=>{
  const snapshot=await getHelperSnapshot(ctx,state,source.id,messageId)
  const ws=await state.storyWorkspace(cardId,snapshot.storyId)
  const files=async()=>Promise.all((await ws.fs.list('state/wal')).map(async path=>[path,await ws.fs.readText('state/wal/'+path)]))
  const walBefore=await files(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  const blocked=withWorkspaceLock(ws.fs.root,async()=>{entered.resolve();await release.promise})
  await entered.promise
  let active=true
  const reached=Promise.withResolvers<void>(),original=state.storyWorkspace.bind(state)
  vi.spyOn(state,'storyWorkspace').mockImplementation(async(...args)=>{reached.resolve();return original(...args)})
  const pending=commitHelperVariables(ctx,state,{sessionId:source.id,messageId,storyId:snapshot.storyId,historyRevision:snapshot.historyRevision,
    changes:[{key:JSON.stringify(['chat','']),before:{},value:{oldRuntime:'不得保存'}}]},()=>{if(!active)throw new Error('卡面运行时租约已失效')})
  const outcome=pending.then(()=>({saved:true}),error=>({saved:false,error:String(error)}))
  await reached.promise
  active=false;release.resolve();await blocked
  expect(await outcome).toMatchObject({saved:false,error:expect.stringContaining('租约已失效')})
  expect(await ws.fs.readText(HELPER_STATE_PATH)).toBeNull()
  expect(await files()).toEqual(walBefore)
})

it('真实 Service 接受旧请求后等剧情锁，新 open 首 await 前撤销它，不能写正文或 WAL',async()=>{
  const snapshot=await getHelperSnapshot(ctx,state,source.id,messageId),input=await frameRequest(),frameLease=await frame(input)
  const ws=await state.storyWorkspace(cardId,snapshot.storyId),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>()
  const before=await ws.fs.list('state/wal'),held=withWorkspaceLock(ws.fs.root,async()=>{entered.resolve();await release.promise})
  await entered.promise
  const reached=Promise.withResolvers<void>(),original=state.storyWorkspace.bind(state)
  vi.spyOn(state,'storyWorkspace').mockImplementation(async(...args)=>{reached.resolve();return original(...args)})
  const pending=service.commitHelperVariables({sessionId:source.id,messageId,storyId:snapshot.storyId,historyRevision:snapshot.historyRevision,frameLease,
    changes:[{key:JSON.stringify(['chat','']),before:{},value:{old:'不得保存'}}]}).then(()=>({saved:true}),error=>({saved:false,error:String(error)}))
  await reached.promise
  const opened=service.openHelperFrame({...input,epoch:2,runtimeId:'runtime-factory-2'})
  release.resolve();await held
  expect(await pending).toMatchObject({saved:false,error:expect.stringContaining('租约已失效')})
  await opened
  expect(await ws.fs.readText(HELPER_STATE_PATH)).toBeNull();expect(await ws.fs.list('state/wal')).toEqual(before)
})

it.each(['global','character'] as const)('共享 %s 脚本等待真正资产锁时轮换运行时，不覆盖静态资产',async type=>{
  const input=await frameRequest(),frameLease=await frame(input),scripts=await state.getSessionHelperScripts(source.id,input.storyId)
  const library=scripts.libraries.find(item=>item.type===type)!,lock=type==='global'?state.paths.root:(await state.workspace(cardId)).fs.root
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),held=withWorkspaceLock(lock,async()=>{entered.resolve();await release.promise})
  await entered.promise
  const reached=Promise.withResolvers<void>(),original=state.saveHelperScriptLibrary.bind(state)
  vi.spyOn(state,'saveHelperScriptLibrary').mockImplementation(async(...args)=>{reached.resolve();return original(...args)})
  const pending=service.commitSessionHelperScripts({sessionId:source.id,storyId:input.storyId,frameLease,bindingRevision:scripts.bindingRevision,type,revision:library.revision,
    trees:[{id:'runtime-script',content:'不允许旧运行时保存'}]}).then(()=>({saved:true}),error=>({saved:false,error:String(error)}))
  await reached.promise
  const opened=service.openHelperFrame({...input,epoch:2,runtimeId:'runtime-factory-2'})
  release.resolve();await held
  expect(await pending).toMatchObject({saved:false,error:expect.stringContaining('租约已失效')});await opened
  expect((await state.getSessionHelperScripts(source.id,input.storyId)).libraries.find(item=>item.type===type)?.trees).toEqual([])
})

it('消息分支已完成旧 verify 后仍有异步草稿写，实际发布前发现轮换时拒绝并清理草稿',async()=>{
  const input=await frameRequest(),frameLease=await frame(input),snapshot=await getHelperSnapshot(ctx,state,source.id,messageId)
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),write=WorkspaceFs.prototype.writeText
  vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(async function(path,text){
    await write.call(this,path,text)
    if(path==='story.json'&&this.root.includes('.preparing-')){entered.resolve();await release.promise}
  })
  const before=await state.listStories(cardId)
  const pending=service.editHelperMessages({sessionId:source.id,messageId,storyId:snapshot.storyId,historyRevision:snapshot.historyRevision,frameLease,
    edits:[{message_id:snapshot.currentMessageId,message:'不得发布的新正文'}]}).then(()=>({published:true}),error=>({published:false,error:String(error)}))
  await Promise.race([entered.promise,pending.then(outcome=>{throw new Error('未到发布屏障：'+JSON.stringify(outcome))})])
  const opened=service.openHelperFrame({...input,epoch:2,runtimeId:'runtime-factory-2'})
  release.resolve()
  expect(await pending).toMatchObject({published:false,error:expect.stringContaining('租约已失效')});await opened
  expect(await state.listStories(cardId)).toEqual(before)
  expect(source.snapshotEvents().some(event=>event.type==='assistant/message'&&event.data.message.content.some(block=>block.type==='text'&&block.text==='不得发布的新正文'))).toBe(false)
})

it('变量提交已开始 WAL 后轮换运行时，完成已认领提交并保留真实成功回执及回滚能力',async()=>{
  const snapshot=await getHelperSnapshot(ctx,state,source.id,messageId),input=await frameRequest(),frameLease=await frame(input)
  const ws=await state.storyWorkspace(cardId,input.storyId),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),begin=ws.wal.beginFloor.bind(ws.wal)
  vi.spyOn(ws.wal,'beginFloor').mockImplementation(async floor=>{await begin(floor);entered.resolve();await release.promise})
  const key=JSON.stringify(['chat',''])
  const pending=service.commitHelperVariables({sessionId:source.id,messageId,storyId:snapshot.storyId,historyRevision:snapshot.historyRevision,frameLease,
    changes:[{key,before:{},value:{claimed:'已开始提交'}}]})
  await entered.promise
  const opened=service.openHelperFrame({...input,epoch:2,runtimeId:'runtime-factory-2'})
  release.resolve()
  expect((await pending).scopes[key]).toEqual({claimed:'已开始提交'});await opened
  expect((await getHelperSnapshot(ctx,state,source.id,messageId)).scopes[key]).toEqual({claimed:'已开始提交'})
  await ws.wal.rollbackFloor(source.id+'#t1',ws.fs.root)
  expect(await ws.fs.readText(HELPER_STATE_PATH)).toBeNull()
})

it.each(['persona','preset','worldbooks'] as const)('Session.seq 未变但同剧情 %s 绑定已改变时旧令牌拒绝写，可信面板仍可保存',async kind=>{
  const snapshot=await getHelperSnapshot(ctx,state,source.id,messageId),input=await frameRequest(),frameLease=await frame(input),before=(await state.loadBinding(source.id))!,seq=source.seq
  let next=before
  if(kind==='persona'){
    const id=await state.savePersona({id:'frame-persona',name:'新用户',description:'新用户',avatar:''})
    next={...before,personaId:id}
  }else if(kind==='preset')next={...before,presetId:'changed-preset'}
  else next={...before,lorebookIds:['new-worldbook']}
  await state.saveBinding(next)
  expect(source.seq).toBe(seq);expect((await state.loadBinding(source.id))!.storyId).toBe(input.storyId)
  const request={sessionId:source.id,messageId,storyId:input.storyId,historyRevision:snapshot.historyRevision,
    changes:[{key:JSON.stringify(['chat','']),before:{},value:{kept:'面板数据'}}]}
  await expect(service.commitHelperVariables({...request,frameLease})).rejects.toThrow('租约已失效')
  const ws=await state.storyWorkspace(cardId,input.storyId)
  expect(await ws.fs.readText(HELPER_STATE_PATH)).toBeNull()
  expect((await service.commitHelperVariables(request)).scopes[JSON.stringify(['chat',''])]).toEqual({kept:'面板数据'})
})

async function greetingSource():Promise<void>{
  await state.saveCharacter(cardId,{firstMes:'开场白一',alternateGreetings:['开场白二']})
  source=ctx.sessions.create(SessionId('frame-lease-greeting'),{seed:[
    {type:'agent-preset/selected',seq:0,time:0,data:{agentPreset:'tavern'}},
    ...greetingTurnEvents('开场白一').map(event=>({...event,seq:event.seq+1})),
  ] as SessionEvent[]})
  messageId=source.snapshotEvents().find(event=>event.type==='assistant/message')!.seq
  await state.saveBinding({sessionId:source.id,cardId,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:'factory'})
}

it('开场白 swipe 排队期间 Session.seq 不变但换绑，不能发布旧角色分支',async()=>{
  await greetingSource()
  const input=await frameRequest(),frameLease=await frame(input),old=(await state.loadBinding(source.id))!,ws=await state.storyWorkspace(cardId,old.storyId),seq=source.seq
  const entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),held=withWorkspaceLock(ws.fs.root,async()=>{entered.resolve();await release.promise})
  await entered.promise
  const reached=Promise.withResolvers<void>(),workspace=state.storyWorkspace.bind(state)
  vi.spyOn(state,'storyWorkspace').mockImplementation(async(...args)=>{reached.resolve();return workspace(...args)})
  const pending=service.swipeGreeting({sessionId:source.id,index:1,frameLease}).then(()=>({published:true}),error=>({published:false,error:String(error)}))
  await reached.promise
  const other=await state.createCharacter('换绑的另一角色')
  await state.saveBinding({...old,cardId:other.cardId,storyId:undefined})
  expect(source.seq).toBe(seq)
  release.resolve();await held
  expect(await pending).toMatchObject({published:false,error:expect.stringContaining('绑定已改变')})
  expect((await state.listStories(cardId)).filter(story=>story.sessionId!==source.id&&story.sessionId!=='frame-lease-story')).toEqual([])
})

it('开场白分支末级草稿写后轮换仍拒绝发布；新令牌配对同消息可正常创建子会话',async()=>{
  await greetingSource()
  const input=await frameRequest(),frameLease=await frame(input),before=await state.listStories(cardId),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),write=WorkspaceFs.prototype.writeText
  const blocked=vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(async function(path,text){
    await write.call(this,path,text)
    if(path==='story.json'&&this.root.includes('.preparing-')){entered.resolve();await release.promise}
  })
  const pending=service.swipeGreeting({sessionId:source.id,index:1,frameLease}).then(()=>({published:true}),error=>({published:false,error:String(error)}))
  await Promise.race([entered.promise,pending.then(outcome=>{throw new Error('未到开场白发布屏障：'+JSON.stringify(outcome))})])
  const opened=service.openHelperFrame({...input,epoch:2,runtimeId:'runtime-factory-2'})
  release.resolve()
  expect(await pending).toMatchObject({published:false,error:expect.stringContaining('租约已失效')})
  const token=(await opened).token;blocked.mockRestore()
  expect(await state.listStories(cardId)).toEqual(before)
  ctx.provide('agentPresets',{composedPreset:()=> 'tavern',resolve:async()=>({id:'tavern'}),mount:vi.fn()})
  const create=vi.fn(async(options:{sessionId:SessionId;seed:SessionEvent[]})=>{
    ctx.sessions.create(options.sessionId,{seed:options.seed});return {dispose:vi.fn()}
  })
  vi.spyOn(ctx.agents,'create').mockImplementation(create)
  const current={frameId:input.frameId,runtimeId:'runtime-factory-2',epoch:2,token}
  const result=await service.swipeGreeting({sessionId:source.id,index:1,frameLease:current})
  expect(create).toHaveBeenCalledTimes(1);expect(result.index).toBe(1)
  expect((await state.loadBinding(result.childSessionId))!.storyId).not.toBe(input.storyId)
  expect(ctx.sessions.get(result.childSessionId as SessionId)?.snapshotEvents().some(event=>event.type==='assistant/message'&&event.data.message.content.some(block=>block.type==='text'&&block.text==='开场白二'))).toBe(true)
})
