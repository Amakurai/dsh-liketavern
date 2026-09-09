/** 自动 MVU 的真实文件事务：模拟宿主 stop 日志、短期租约、失败恢复、分支继承及同层 WAL 原子回执。 */
import {mkdtemp,rm,appendFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {beforeEach,afterEach,it,expect,vi} from 'vitest'
import type {Context} from '@deepseek-ai/cordis'
import type {Session,SessionEvent} from '@deepseek-ai/dsh-session'
import {createAssistantMessage,createUserMessage} from '@deepseek-ai/dsh-llm'
import {TavernState} from '../src/node/state.js'
import {resolveConfig} from '../src/node/config.js'
import {prepareHelperMvuJob,commitHelperMvuJob,queueHelperMvuStop,queueHelperMvuTurn,helperMvuPending,assertHelperMvuWritable} from '../src/node/helperMvu.js'
import {loadHelperState,saveHelperState,HELPER_STATE_PATH} from '../src/state/helper.js'
import {parseHelperMvuState,type HelperMvuWork} from '../src/core/helperMvu.js'
import {commitHelperVariables,getHelperSnapshot,getHelperScriptBundle,withHelperStoryWrite} from '../src/node/helperRuntime.js'
import {TAVERN_GREETING_SOURCE} from '../src/core/greetingLog.js'
import {greetingTurnEvents} from '../src/node/greetingSeed.js'
import {createHash} from 'node:crypto'
import {helperJson} from '../src/core/helperRuntime.js'
import {CONTINUE_INSTRUCTION_PREFIX} from '../src/core/dshPrompt.js'
import {onTurnEnd} from '../src/node/sessionLifecycle.js'

let root:string,state:TavernState,ctx:Context,cardId:string,storyId:string,events:SessionEvent[]
const sources=new Map<string,SessionEvent[]>()
const snapshot=(id='session')=>({id:id as Session['id'],snapshotEvents:()=>sources.get(id)??events})
const request=(runtimeId='runtime')=>({sessionId:'session',storyId,runtimeId})
const ws=()=>state.storyWorkspace(cardId,storyId)
const read=async()=>loadHelperState((await ws()).fs)
function append(type:string,data:unknown){events.push({type,data,seq:events.length,time:0,...(type==='assistant/message'?{surfaceOp:'append'}:{})} as SessionEvent)}
function assistant(turn:number,text='角色回复',step=1,interrupted=false){
  append('assistant/message',{turn,step,message:createAssistantMessage({content:[{type:'text',text}],source:turn===0?TAVERN_GREETING_SOURCE:{provider:'fixture',model:'fixture'}}),...(interrupted?{interrupted:true}:{})})
}
function createState(){return new TavernState({root,characters:join(root,'characters'),lorebooks:join(root,'library/lorebooks'),presets:join(root,'library/presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')},()=>resolveConfig({}))}
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'helper-mvu-'));state=createState();await state.init();cardId=(await state.createCharacter('MVU工厂')).cardId
  await state.saveBinding({sessionId:'session',cardId,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:true,helperMvu:true,greetingIndex:0,createdAt:'factory'})
  storyId=(await state.loadBinding('session'))!.storyId!;events=[];sources.clear();sources.set('session',events)
  ctx={sessions:{get:(id:string)=>sources.has(id)?snapshot(id):undefined},get:()=>undefined} as unknown as Context
})
afterEach(async()=>{vi.restoreAllMocks();vi.useRealTimers();await rm(root,{recursive:true,force:true})})
async function prepare(runtimeId='runtime'){return prepareHelperMvuJob(ctx,state,request(runtimeId))}
async function commit(work:HelperMvuWork,data:unknown,runtimeId='runtime'){
  return commitHelperMvuJob(ctx,state,{...request(runtimeId),jobId:work.job!.id,token:work.token!,data})
}
async function initialize(){assistant(0,'<initvar>hp: 10</initvar>');const work=await prepare();await commit(work,{stat_data:{hp:10},other:'greeting'});return work}
async function start(turn=1,text="_.add('hp',1);",reason='stop'){
  append('turn/start',{turn});append('assistant/chunk',{turn,step:1,chunk:{type:'finish',reason:{kind:reason}}});assistant(turn,text)
  const floor='session#t'+turn,workspace=await ws();await workspace.wal.beginFloor(floor);state.openFloors.set('session',{cardId,storyId,floor})
}
async function end(turn=1,kind='completed'){
  append('turn/end',{turn,reason:{kind}});state.openFloors.delete('session');await (await ws()).wal.commitFloor('session#t'+turn)
}
async function continuation(turn:number,text:string,owned=true){
  append('turn/start',{turn})
  append('user/message',createUserMessage({content:[{type:'text',text:CONTINUE_INSTRUCTION_PREFIX+'紧接断点继续'}],source:owned?{kind:'plugin',plugin:'dsh-tavern',form:'notice',summary:'续写指令'}:{kind:'user'}}))
  append('assistant/chunk',{turn,step:1,chunk:{type:'finish',reason:{kind:'stop'}}});assistant(turn,text)
  const floor='session#t'+turn;await (await ws()).wal.beginFloor(floor);state.openFloors.set('session',{cardId,storyId,floor})
}

it('空历史等待初始化，未登记任务时允许脚本播种，关闭开关后不再门控',async()=>{
  expect(await prepare()).toMatchObject({enabled:true,status:'waiting'})
  expect(await helperMvuPending(state,'session')).toBe(true);expect(await helperMvuPending(state,'session',false)).toBe(false);await assertHelperMvuWritable(state,'session')
  expect(await (await ws()).fs.readText(HELPER_STATE_PATH)).toBeNull()
  await state.saveBinding({... (await state.loadBinding('session'))!,helperMvu:false})
  expect(await prepare()).toMatchObject({enabled:false,status:'idle'});expect(await helperMvuPending(state,'session')).toBe(false)
})

it('已有多层历史首次启用仅初始化最新正常完成回复，不回写更早消息',async()=>{
  assistant(0,'<initvar>hp: 20</initvar>');await start(1,'第一层');await end(1);await start(2,'第二层');await end(2)
  const work=await prepare();expect(work.job).toMatchObject({kind:'initialize',turn:2,floor:'session#t2'});expect(work.greeting).toBe('<initvar>hp: 20</initvar>');expect(work.applyText).toBe(true)
  await commit(work,{stat_data:{hp:20}})
  const saved=await read();expect(Object.keys(saved.scopes)).toEqual([JSON.stringify(['message',work.job!.identity])])
  expect(saved.mvu?.completed).toHaveLength(1)
})

it('首次启用已有手动 MVU 当前锚点保留现有 stat_data，明确不重放该条正文',async()=>{
  assistant(0,'开场');await start(1,"_.add('hp',5);");await end(1)
  const target=events.findLast(event=>event.type==='assistant/message')! as SessionEvent<'assistant/message'>,workspace=await ws(),key=JSON.stringify(['message',String(target.data.message.id)])
  await saveHelperState(workspace.fs.withFloor('session#t1'),{scopes:{[key]:{stat_data:{hp:15},zCustom:'kept'}},extras:{}})
  const work=await prepare();expect(work.applyText).toBe(false);expect(work.base?.stat_data).toEqual({hp:15})
  await commit(work,{stat_data:{hp:15}});await commit(work,{stat_data:{hp:15}})
  expect((await read()).scopes[key]).toEqual({stat_data:{hp:15},zCustom:'kept'})
})

it('初始化只写当前锚点，快照/开场白和绑定来源完整，保留锚点已有数据',async()=>{
  const global=await state.saveLorebook('global',{entries:[{uid:1,comment:'[initvar]',content:'hp: 10',disable:true}]}),additional=await state.saveLorebook('additional',{entries:[{uid:2,comment:'[initvar]',content:'mp: 2'}]})
  await state.saveCharacterLorebook(cardId,{name:'embedded',entries:[{uid:3,comment:'[initvar]',content:'stamina: 3'}]})
  await state.saveBinding({... (await state.loadBinding('session'))!,lorebookIds:[global],characterLorebookIds:[additional]})
  assistant(0,'<initvar>hp: 20</initvar>');const identity=String((events[0] as SessionEvent<'assistant/message'>).data.message.id),workspace=await ws()
  await workspace.wal.beginFloor('session#t0');await saveHelperState(workspace.fs.withFloor('session#t0'),{scopes:{[JSON.stringify(['message',identity])]:{custom:'keep'}},extras:{}});await workspace.wal.commitFloor('session#t0')
  const work=await prepare();expect(work).toMatchObject({status:'pending',base:{custom:'keep'},greeting:'<initvar>hp: 20</initvar>',snapshot:{currentMessageId:0,writable:false}})
  expect(work.initialSources?.map(source=>source.role)).toEqual(['global','character','character'])
  expect(work.initialSources?.[0]?.entries).toHaveLength(1)
  await assertHelperMvuWritable(state,'session').then(()=>{throw new Error('must refuse')},error=>expect(error.message).toMatch(/正在更新/))
  await commit(work,{stat_data:{hp:20}})
  const saved=await read();expect(saved.scopes[JSON.stringify(['message',identity])]).toEqual({custom:'keep',stat_data:{hp:20}})
  expect(saved.mvu).toMatchObject({initialized:true,pending:[],lastIdentity:identity});expect(await helperMvuPending(state,'session')).toBe(false)
  await commit(work,{stat_data:{hp:20}});expect((await read()).mvu?.completed).toHaveLength(1)
})

it('active stop 在同层 WAL 登记并提交数据，turn/end 才提交楼层且不重复处理初始化身份',async()=>{
  await start();await queueHelperMvuStop(state,'session',snapshot())
  const work=await prepare();expect(work.job?.kind).toBe('initialize')
  expect(await commit(work,{stat_data:{hp:11}})).toMatchObject({status:'idle',awaitingTurnEnd:true})
  expect((await (await ws()).wal.validateFloor('session#t1')).committed).toBe(false)
  expect(await helperMvuPending(state,'session')).toBe(false)
  append('turn/end',{turn:1,reason:{kind:'completed'}});await queueHelperMvuTurn(state,'session',snapshot())
  expect((await read()).mvu?.pending).toEqual([])
  state.openFloors.delete('session');await (await ws()).wal.commitFloor('session#t1')
  expect((await (await ws()).wal.validateFloor('session#t1')).committed).toBe(true)
})

it('真实普通变量与剧情写事务在 pending 时拒绝，MVU 保存且正常收口后恢复可写',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());const work=await prepare()
  await end();const current=await getHelperSnapshot(ctx,state,'session',work.job!.seq)
  const request={sessionId:'session',messageId:work.job!.seq,storyId,historyRevision:current.historyRevision,changes:[{key:'["chat",""]',before:{},value:{manual:true}}]}
  await expect(commitHelperVariables(ctx,state,request)).rejects.toThrow(/正在更新/)
  const write=vi.fn(async()=>true)
  await expect(withHelperStoryWrite(ctx,state,'session',work.job!.seq,storyId,write)).rejects.toThrow(/正在更新/);expect(write).not.toHaveBeenCalled()
  await commit(work,{stat_data:{hp:11}})
  expect((await commitHelperVariables(ctx,state,request)).scopes['["chat",""]']).toEqual({manual:true})
  expect(await withHelperStoryWrite(ctx,state,'session',work.job!.seq,storyId,write)).toBe(true);expect(write).toHaveBeenCalledTimes(1)
})

it('active stop 登记任务时同层播种启用脚本的静态 data，已存在作用域不覆盖且禁用脚本不播种',async()=>{
  const library=await state.getHelperScriptLibrary({type:'global'})
  await state.saveHelperScriptLibrary(library.target,library.revision,[
    {type:'script',id:'enabled',enabled:true,name:'enabled',content:'throw new Error("must never execute on host")',data:{default:true}},
    {type:'script',id:'disabled',enabled:false,name:'disabled',content:'',data:{hidden:true}},
    {type:'folder',id:'off-folder',enabled:false,scripts:[{type:'script',id:'inside',enabled:true,name:'inside',content:'',data:{hidden:true}}]},
  ])
  await start();await queueHelperMvuStop(state,'session',snapshot())
  const saved=await read();expect(saved.scopes['["script","enabled"]']).toEqual({default:true})
  expect(saved.scopes).not.toHaveProperty('["script","disabled"]');expect(saved.scopes).not.toHaveProperty('["script","inside"]')
  saved.scopes['["script","enabled"]']={edited:true};await saveHelperState((await ws()).fs.withFloor('session#t1'),saved)
  await queueHelperMvuStop(state,'session',snapshot());expect((await read()).scopes['["script","enabled"]']).toEqual({edited:true})
  const work=await prepare();expect(work.snapshot?.scopes['["script","enabled"]']).toEqual({edited:true})
  expect((await (await ws()).wal.validateFloor('session#t1')).committed).toBe(false)
})

it('无开场白的工具中间回复不挂载首次脚本；真实 stop 的 bundle 与登记并发仍先原子播种',async()=>{
  const library=await state.getHelperScriptLibrary({type:'global'})
  await state.saveHelperScriptLibrary(library.target,library.revision,[{type:'script',id:'seeded',enabled:true,name:'seeded',content:'',data:{factory:7}}])
  await start(1,'工具中间消息','tool-calls')
  expect((await getHelperScriptBundle(ctx,state,'session')).messageId).toBeNull();expect((await read()).mvu).toBeUndefined()
  append('assistant/chunk',{turn:1,step:2,chunk:{type:'finish',reason:{kind:'stop'}}});assistant(1,'正常回复',2)
  const [bundle]=await Promise.all([getHelperScriptBundle(ctx,state,'session'),queueHelperMvuStop(state,'session',snapshot())])
  expect(bundle.messageId).toBe(events.at(-1)!.seq);expect(bundle.snapshot?.scopes['["script","seeded"]']).toEqual({factory:7})
  expect((await read()).mvu?.pending).toHaveLength(1);expect((await (await ws()).wal.validateFloor('session#t1')).committed).toBe(false)
  const runner=await prepare('actual-runner');expect(runner.status).toBe('pending');expect(runner.job?.seq).toBe(bundle.messageId)
})

it('已有完成锚点的首次 bundle 在返回前播种并登记初始化，不领取运行时租约',async()=>{
  const library=await state.getHelperScriptLibrary({type:'global'})
  await state.saveHelperScriptLibrary(library.target,library.revision,[{type:'script',id:'seeded',enabled:true,name:'seeded',content:'',data:{factory:8}}])
  assistant(0,'开场');const bundle=await getHelperScriptBundle(ctx,state,'session')
  expect(bundle.snapshot?.scopes['["script","seeded"]']).toEqual({factory:8});expect((await read()).mvu?.pending).toHaveLength(1)
  expect((await prepare('real-runtime')).status).toBe('pending');expect((await (await ws()).wal.validateFloor('session#t0')).committed).toBe(true)
})

it('全局开关在新楼层期间恢复时延期旧锚点初始化，当前真实 stop 后再挂载',async()=>{
  assistant(0,'旧开场');await start(1,'中间工具消息','tool-calls')
  expect((await getHelperScriptBundle(ctx,state,'session')).messageId).toBeNull();expect((await prepare()).status).toBe('waiting')
  append('assistant/chunk',{turn:1,step:2,chunk:{type:'finish',reason:{kind:'stop'}}});assistant(1,'本轮完成',2)
  expect((await getHelperScriptBundle(ctx,state,'session')).messageId).toBe(events.at(-1)!.seq)
  expect((await read()).mvu?.pending[0]).toMatchObject({turn:1,kind:'initialize',floor:'session#t1'})
})

it('真实 turn 1 greeting seed 没有 finish 也能初始化，识别开场文本与 swipe 且不执行正文命令',async()=>{
  events.push(...greetingTurnEvents("<initvar>hp: 7</initvar> _.add('hp',9);"))
  await state.saveBinding({... (await state.loadBinding('session'))!,greetingIndex:2})
  const bundle=await getHelperScriptBundle(ctx,state,'session'),work=await prepare()
  expect(work).toMatchObject({job:{turn:1,kind:'initialize'},applyText:false,swipeId:2,greeting:"<initvar>hp: 7</initvar> _.add('hp',9);"})
  expect(work.job?.seq).toBe(bundle.messageId);await commit(work,{stat_data:{hp:7}})
  await queueHelperMvuTurn(state,'session',snapshot());expect((await read()).mvu?.pending).toEqual([])
})

it('完成回执在宿主重启后仍以有界 id/digest 暴露，可确认丢失的成功响应',async()=>{
  assistant(0,'开场');const work=await prepare(),data={z:'preserved',stat_data:{hp:10}},digest=createHash('sha256').update(JSON.stringify(helperJson(data))).digest('hex')
  expect((await commit(work,data)).completed).toEqual([{id:work.job!.id,digest}])
  state=createState();await state.init();expect(await prepare('reconnected')).toMatchObject({status:'idle',completed:[{id:work.job!.id,digest}]})
  await start();await queueHelperMvuStop(state,'session',snapshot())
  expect((await prepare('next')).completed).toEqual([{id:work.job!.id,digest}]);expect((await prepare('another')).completed).toEqual([{id:work.job!.id,digest}])
})

it('初始化后正常 stop 更新继承前一有效消息数据，登记及同令牌重试不会翻倍',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());await queueHelperMvuStop(state,'session',snapshot())
  const work=await prepare();expect(work.job?.kind).toBe('update');expect(work.base).toEqual({stat_data:{hp:10},other:'greeting'})
  await commit(work,{...work.base,stat_data:{hp:11}});await commit(work,{...work.base,stat_data:{hp:11}})
  await end();await queueHelperMvuTurn(state,'session',snapshot())
  const saved=await read();expect(saved.mvu?.completed).toHaveLength(2);expect(saved.mvu?.pending).toHaveLength(0)
  await expect(commit(work,{stat_data:{hp:12}})).rejects.toThrow(/回执不一致/)
})

it.each(["_.add('hp',2);","_.add('hp',"] )('真实续写不把未提交截断片段 %s 静默漏算为成功',async(text)=>{
  await initialize();await start(1,text,'max-tokens');await end(1,'max-tokens');const before=await read()
  await continuation(2,'2); 剩余正文')
  await expect(queueHelperMvuStop(state,'session',snapshot())).rejects.toThrow(/截断回复.*重新生成/)
  expect(await read()).toEqual(before)
  await end(2);await expect(queueHelperMvuTurn(state,'session',snapshot())).rejects.toThrow(/截断回复.*重新生成/)
  await expect(getHelperScriptBundle(ctx,state,'session')).rejects.toThrow(/截断回复.*重新生成/)
})

it('正常已计算回复后的续写只提交新文本，不重复应用前一回复的命令',async()=>{
  await initialize();await start(1,"_.add('hp',5);");await queueHelperMvuStop(state,'session',snapshot());await commit(await prepare(),{stat_data:{hp:15}});await end(1)
  await continuation(2,"_.add('hp',2);");await queueHelperMvuStop(state,'session',snapshot())
  const work=await prepare();expect(work.base?.stat_data).toEqual({hp:15});expect(work.job?.text).toBe("_.add('hp',2);")
  await commit(work,{stat_data:{hp:17}});expect((await read()).mvu?.completed).toHaveLength(3)
})

it('仅同文用户台词不冒充宿主续写，真实连续续写链不能隐藏更早未处理的截断',async()=>{
  await initialize();await start(1,"_.add('hp',",'max-tokens');await end(1,'max-tokens')
  await continuation(2,'2);');await end(2)
  await continuation(3,'后续正文');await expect(queueHelperMvuStop(state,'session',snapshot())).rejects.toThrow(/截断回复.*重新生成/)
  const instruction=events.findLast(event=>event.type==='user/message')! as SessionEvent<'user/message'>
  instruction.data=createUserMessage({content:instruction.data.content,source:{kind:'user'}})
  await queueHelperMvuStop(state,'session',snapshot());expect((await prepare()).job?.turn).toBe(3)
})

it('首次启用必须复核续写来源，不把最新尾段当作完整初始化锚点',async()=>{
  await start(1,'未处理截断','max-tokens');await end(1,'max-tokens');await continuation(2,'继续片段');await end(2)
  await expect(prepare()).rejects.toThrow(/截断回复.*重新生成/)
  await expect(getHelperScriptBundle(ctx,state,'session')).rejects.toThrow(/截断回复.*重新生成/)
  expect((await read()).mvu).toBeUndefined()
})

it('已有 pending 与旧执行租约在 prepare 和 commit 再核续写来源，来源变化不能绕过检查',async()=>{
  await initialize();await start(1,'未处理截断','max-tokens');await end(1,'max-tokens');await continuation(2,'继续片段',false)
  await queueHelperMvuStop(state,'session',snapshot());const work=await prepare()
  const instruction=events.findLast(event=>event.type==='user/message')! as SessionEvent<'user/message'>
  instruction.data=createUserMessage({content:instruction.data.content,source:{kind:'plugin',plugin:'dsh-tavern',form:'notice',summary:'续写指令'}})
  await expect(prepare()).rejects.toThrow(/截断回复.*重新生成/);await expect(commit(work,{stat_data:{hp:20}})).rejects.toThrow(/截断回复.*重新生成/)
  expect((await read()).mvu?.pending).toHaveLength(1);expect((await read()).mvu?.completed).toHaveLength(1)
})

it('多步骤正常 stop 顺序排队，每个任务从前一个已完成消息状态接续',async()=>{
  await initialize();await start()
  append('assistant/chunk',{turn:1,step:2,chunk:{type:'finish',reason:{kind:'stop'}}});assistant(1,'第二步',2)
  await queueHelperMvuStop(state,'session',snapshot());expect((await read()).mvu?.pending).toHaveLength(2)
  const first=await prepare();await commit(first,{stat_data:{hp:11}})
  const second=await prepare();expect(second.base?.stat_data).toEqual({hp:11});await commit(second,{stat_data:{hp:12}})
  expect((await read()).mvu?.completed).toHaveLength(3)
})

it('截断、缺 finish、重复 finish、interrupted 或失败终止帧不能登记成功更新',async()=>{
  await initialize();await start(1,'截断','max-tokens');await queueHelperMvuStop(state,'session',snapshot());expect((await read()).mvu?.pending).toEqual([])
  events.splice(1);append('turn/start',{turn:1});assistant(1,'无finish');await queueHelperMvuStop(state,'session',snapshot());expect((await read()).mvu?.pending).toEqual([])
  events.splice(1);append('turn/start',{turn:1});append('assistant/chunk',{turn:1,step:1,chunk:{type:'finish',reason:{kind:'stop'}}});append('assistant/chunk',{turn:1,step:1,chunk:{type:'finish',reason:{kind:'stop'}}});assistant(1,'重复finish');await queueHelperMvuStop(state,'session',snapshot());expect((await read()).mvu?.pending).toEqual([])
  events.splice(1);append('turn/start',{turn:1});append('assistant/chunk',{turn:1,step:1,chunk:{type:'finish',reason:{kind:'stop'}}});assistant(1,'中断',1,true);await queueHelperMvuStop(state,'session',snapshot());expect((await read()).mvu?.pending).toEqual([])
  events.splice(1);append('turn/start',{turn:1});append('assistant/chunk',{turn:1,step:1,chunk:{type:'finish',reason:{kind:'stop'}}});assistant(1);append('turn/end',{turn:1,reason:{kind:'error',error:{code:'UNKNOWN',message:'failure'}}});await queueHelperMvuTurn(state,'session',snapshot());expect((await read()).mvu?.pending).toEqual([])
})

it('已登记真实 stop 在取消结束后保留，重启不继承租约但可重新准备同一个持久任务',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());const old=await prepare()
  await end(1,'aborted');state=createState();await state.init()
  expect(await helperMvuPending(state,'session')).toBe(true);expect(await helperMvuPending(state,'session',false)).toBe(true)
  await expect(commit(old,{stat_data:{hp:11}})).rejects.toThrow(/租约已失效/)
  const next=await prepare();expect(next.job?.id).toBe(old.job?.id);expect(next.token).not.toBe(old.token)
  await commit(next,{stat_data:{hp:11}});expect(await helperMvuPending(state,'session')).toBe(false)
})

it('消息原文或切换绑定使旧执行者失效，不能把结果写到新剧情',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());const work=await prepare()
  const target=events.find(event=>event.seq===work.job!.seq)! as SessionEvent<'assistant/message'>
  const text=target.data.message.content;target.data.message={...target.data.message,content:[{type:'text',text:'已被改写'}]}
  await expect(commit(work,{stat_data:{hp:11}})).rejects.toThrow(/原文已改变/)
  target.data.message={...target.data.message,content:text}
  await state.saveBinding({... (await state.loadBinding('session'))!,helperMvu:false})
  await expect(commit(work,{stat_data:{hp:11}})).rejects.toThrow(/已关闭/)
  const other=(await state.createCharacter('另外一张卡')).cardId
  await state.saveBinding({... (await state.loadBinding('session'))!,cardId:other,storyId:undefined,helperMvu:true})
  await expect(commit(work,{stat_data:{hp:11}})).rejects.toThrow(/剧情绑定已改变/)
  expect((await read()).mvu?.pending).toHaveLength(1)
})

it('同运行时心跳复用基线与令牌，其他运行时只能等待；过期后旧窗口被拒绝',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());const first=await prepare()
  expect((await prepare()).token).toBe(first.token);expect(await prepare('other')).toMatchObject({status:'waiting'})
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(Date.now()+91000)
  const next=await prepare('other');expect(next.token).not.toBe(first.token)
  await expect(commit(first,{stat_data:{hp:11}})).rejects.toThrow(/租约已失效/)
  await commit(next,{stat_data:{hp:11}},'other')
})

it('变量、脚本修订、原文或绑定改变使冻结提交失败，不清空待处理任务',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());const work=await prepare(),workspace=await ws()
  const saved=await read();saved.scopes['["chat",""]']={changed:true};await saveHelperState(workspace.fs.withFloor('session#t1'),saved)
  await expect(commit(work,{stat_data:{hp:11}})).rejects.toThrow(/变量或待处理队列/)
  expect((await read()).mvu?.pending).toHaveLength(1)
  expect((await prepare()).base).toEqual(work.base)
  const library=await state.getHelperScriptLibrary({type:'global'});await state.saveHelperScriptLibrary(library.target,library.revision,[{type:'script',value:{id:'factory',name:'factory',enabled:true,content:'',info:'',button:{enabled:false,buttons:[]},data:{}}}])
  await expect(commit(work,{stat_data:{hp:11}})).rejects.toThrow(/脚本库已改变/)
})

it('门控只追加无 WAL 的 turn/start 时旧 job仍可完成，真正新楼层已建立则拒绝',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());const work=await prepare();await end()
  append('turn/start',{turn:2});await commit(work,{stat_data:{hp:11}})
  await (await ws()).wal.beginFloor('session#t2')
  await expect(commit(work,{stat_data:{hp:11}})).rejects.toThrow(/新的 WAL 楼层/)
})

it('正文已保存但 commitFloor 失败可以凭同 token 回执修复，坏 WAL 永远拒绝',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());const work=await prepare();await end()
  const workspace=await ws();vi.spyOn(workspace.wal,'commitFloor').mockRejectedValueOnce(new Error('factory commit failed'))
  await expect(commit(work,{stat_data:{hp:11}})).rejects.toThrow('factory commit failed')
  expect((await read()).mvu?.pending).toEqual([]);await commit(work,{stat_data:{hp:11}})
  await appendFile(join(workspace.fs.root,'state/wal/session_t1/records.jsonl'),'{broken}\n')
  await expect(commit(work,{stat_data:{hp:11}})).rejects.toThrow(/WAL/)
})

it('丢失提交回执后 prepare 必须补齐 WAL 收口才返回 idle，收口前门控与普通写仍阻止',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());const work=await prepare();await end()
  const workspace=await ws();vi.spyOn(workspace.wal,'commitFloor').mockRejectedValueOnce(new Error('factory finalization failed'))
  await expect(commit(work,{stat_data:{hp:11}})).rejects.toThrow('factory finalization failed')
  expect(await helperMvuPending(state,'session',false)).toBe(true);await expect(assertHelperMvuWritable(state,'session')).rejects.toThrow(/正在更新/)
  const recovered=await prepare('reconnected');expect(recovered.status).toBe('idle');expect(recovered.completed?.at(-1)?.id).toBe(work.job!.id)
  expect((await workspace.wal.validateFloor('session#t1')).committed).toBe(true);expect(await helperMvuPending(state,'session')).toBe(false)
})

it('持续收口失败或损坏 WAL 不能通过 completed 摘要释放门控',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());const work=await prepare();await end()
  const workspace=await ws(),failed=vi.spyOn(workspace.wal,'commitFloor').mockRejectedValue(new Error('factory persistent failure'))
  await expect(commit(work,{stat_data:{hp:11}})).rejects.toThrow('factory persistent failure')
  await expect(prepare('reconnected')).rejects.toThrow('factory persistent failure');expect(await helperMvuPending(state,'session',false)).toBe(true)
  failed.mockRestore();await appendFile(join(workspace.fs.root,'state/wal/session_t1/records.jsonl'),'{broken}\n')
  await expect(prepare('reconnected')).rejects.toThrow(/WAL/);await expect(helperMvuPending(state,'session',false)).rejects.toThrow(/WAL/)
})

it('复制剧情只继承持久任务，祖先楼层经 walLineage 验证且子提交不改变来源',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());const sourceWork=await prepare();await end()
  const sourceStory=storyId,binding=(await state.loadBinding('session'))!,childStory=await state.forkStory(binding,'child',async()=>{})
  sources.set('child',[...events]);await state.saveBinding({...binding,sessionId:'child',storyId:childStory,walLineage:[{sessionId:'session',throughTurn:1}]})
  const req={sessionId:'child',storyId:childStory,runtimeId:'child-runtime'}
  await expect(commitHelperMvuJob(ctx,state,{...req,jobId:sourceWork.job!.id,token:sourceWork.token!,data:{stat_data:{hp:11}}})).rejects.toThrow(/租约已失效/)
  const child=await prepareHelperMvuJob(ctx,state,req);expect(child.job?.id).toBe(sourceWork.job?.id)
  await commitHelperMvuJob(ctx,state,{...req,jobId:child.job!.id,token:child.token!,data:{stat_data:{hp:11}}})
  expect((await loadHelperState((await state.storyWorkspace(cardId,childStory)).fs)).mvu?.pending).toEqual([])
  expect((await loadHelperState((await state.storyWorkspace(cardId,sourceStory)).fs)).mvu?.pending).toHaveLength(1)
})

it('复制任务没有祖先授权或目标回执原文已失效时不凭已有 WAL 文件写入',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());await end()
  const binding=(await state.loadBinding('session'))!,childStory=await state.forkStory(binding,'child',async()=>{})
  sources.set('child',[...events]);await state.saveBinding({...binding,sessionId:'child',storyId:childStory,walLineage:[]})
  await expect(prepareHelperMvuJob(ctx,state,{sessionId:'child',storyId:childStory,runtimeId:'child'})).rejects.toThrow(/继承世系/)
  expect((await loadHelperState((await state.storyWorkspace(cardId,childStory)).fs)).mvu?.pending).toHaveLength(1)
})

it('同层 helper 正文写失败保留任务，重试只在成功后添加完成回执',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());const work=await prepare(),workspace=await ws()
  const original=workspace.wal.recordChange.bind(workspace.wal)
  vi.spyOn(workspace.wal,'recordChange').mockImplementationOnce(async()=>{throw new Error('factory WAL write failed')})
  await expect(commit(work,{stat_data:{hp:11}})).rejects.toThrow('factory WAL write failed')
  expect((await read()).mvu?.pending).toHaveLength(1);expect((await read()).mvu?.completed).toHaveLength(1)
  vi.mocked(workspace.wal.recordChange).mockImplementation(original);await commit(work,{stat_data:{hp:11}})
  expect((await read()).mvu?.completed).toHaveLength(2)
})

it('turn/end 登记写入失败不提交楼层，后台准备会从正常 stop 恢复同一更新',async()=>{
  await initialize();await start();append('turn/end',{turn:1,reason:{kind:'completed'}})
  const workspace=await ws(),original=workspace.wal.recordChange.bind(workspace.wal)
  vi.spyOn(workspace.wal,'recordChange').mockImplementationOnce(async()=>{throw new Error('factory queue write failed')})
  await expect(onTurnEnd(state,'session',snapshot())).rejects.toThrow('factory queue write failed')
  expect((await workspace.wal.validateFloor('session#t1')).committed).toBe(false)
  expect((await read()).mvu?.pending).toEqual([]);expect(await helperMvuPending(state,'session',false)).toBe(true)
  vi.mocked(workspace.wal.recordChange).mockImplementation(original)
  const recovered=await prepare('recovered-runtime');expect(recovered.job).toMatchObject({kind:'update',turn:1,floor:'session#t1'})
  await commit(recovered,{stat_data:{hp:11}},'recovered-runtime')
  expect((await workspace.wal.validateFloor('session#t1')).committed).toBe(true);expect(await helperMvuPending(state,'session')).toBe(false)
})

it('状态损坏和临时数据拒绝，楼层回滚同时撤销数据及完成回执',async()=>{
  await initialize();await start();await queueHelperMvuStop(state,'session',snapshot());const work=await prepare()
  await expect(commit(work,{stat_data:{hp:11,$internal:{}}})).rejects.toThrow(/临时/)
  await commit(work,{stat_data:{hp:11}});await end();const workspace=await ws()
  await workspace.wal.rollbackFloor('session#t1',workspace.fs.root)
  expect((await read()).mvu?.completed).toHaveLength(1)
  await expect(commit(work,{stat_data:{hp:11}})).rejects.toThrow(/已回滚/)
  const saved=await read();await workspace.fs.writeText(HELPER_STATE_PATH,JSON.stringify({...saved,version:1,mvu:{version:1,initialized:true,pending:'broken',completed:[]}}))
  await expect(helperMvuPending(state,'session')).rejects.toThrow(/损坏/)
  expect(()=>parseHelperMvuState({version:1,initialized:false,pending:[],completed:Array(257).fill({})})).toThrow(/损坏/)
})
