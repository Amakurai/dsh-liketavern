/** 批量消息编辑集成：真实 Session 验证 seed/模型视图、真实剧情 WAL 与模拟宿主分支创建。 */
import {mkdtemp,rm,appendFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import type {Context} from '@deepseek-ai/cordis'
import {Session,SessionSeq,type SessionEvent} from '@deepseek-ai/dsh-session'
import {apply as applySessionInvariant} from '@deepseek-ai/dsh-session/invariant'
import {createAssistantMessage,createUserMessage,createToolResultMessage,ToolCallId} from '@deepseek-ai/dsh-llm'
import {TavernState} from '../src/node/state.js'
import {resolveConfig} from '../src/node/config.js'
import {commitHelperVariables,getHelperSnapshot,helperHistoryOf} from '../src/node/helperRuntime.js'
import {editHelperMessages} from '../src/node/helperChatEdits.js'
import {parseHelperMessageEdits} from '../src/core/helperChatEdits.js'
import {editedHistorySeed} from '../src/node/helperChatSeed.js'
import {WorkspaceFs} from '../src/state/workspaceFs.js'
import {loadHelperState,saveHelperState,type HelperState} from '../src/state/helper.js'
import {MemoryStore} from '../src/state/memory.js'
import {newStoryId,snapshotStory} from '../src/state/story.js'
let root:string,state:TavernState,ctx:Context,cardId:string,source:Session
const sessions=new Map<string,Session>(),created=vi.fn(),followup=vi.fn()
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'helper-chat-edit-'));state=new TavernState({root,characters:join(root,'characters'),lorebooks:join(root,'library/lorebooks'),presets:join(root,'library/presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')},()=>resolveConfig({}));await state.init();cardId=(await state.createCharacter('编辑角色')).cardId
  source=Session.create('session-parent' as Session['id']);source.append('agent-preset/selected',{agentPreset:'tavern'})
  for(let turn=1;turn<=3;turn++){
    source.append('turn/start',{turn});source.append('user/message',createUserMessage({content:[{type:'text',text:'user-'+turn}],source:{kind:'user'}}),{surfaceOp:'append'})
    source.append('step/start',{turn,step:1})
    const callId=ToolCallId('call-'+turn)
    source.append('assistant/message',{turn,step:1,message:createAssistantMessage({content:[{type:'text',text:'assistant-'+turn},...(turn===2?[{type:'tool-call' as const,id:callId,name:'fixture_tool',arguments:'{}'}]:[])],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
    if(turn===2){source.append('tool/call',{turn,step:1,callId,name:'fixture_tool',arguments:'{}'});source.append('tool/result',{turn,step:1,message:createToolResultMessage({callId,content:[{type:'text',text:'fixture tool result'}],isError:false})},{surfaceOp:'append'})}
    source.append('step/end',{turn,step:1})
    source.append('turn/end',{turn,reason:{kind:'completed'}})
  }
  sessions.clear();sessions.set(source.id,source);created.mockReset();followup.mockReset()
  const presets={composedPreset:()=> 'tavern',resolve:async()=>({id:'tavern'}),mount:vi.fn()}
  ctx={sessions:{get:(id:string)=>sessions.get(id)},get:(key:string)=>key==='agentPresets'?presets:undefined,logger:{warn:vi.fn()},agents:{get:(id:string)=>sessions.has(id)?{options:{provider:'test',model:'test'},ctx:{},followup}:undefined,withoutInitiator:(fn:()=>unknown)=>fn(),create:async(options:{sessionId:Session['id'];seed:SessionEvent[]})=>{created(options);sessions.set(options.sessionId,Session.create(options.sessionId,options.seed));return {dispose:vi.fn()}}}} as unknown as Context
  await state.saveBinding({sessionId:source.id,cardId,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:'now'})
  const binding=(await state.loadBinding(source.id))!,ws=await state.storyWorkspace(cardId,binding.storyId)
  for(let turn=1;turn<=3;turn++){const floor=source.id+'#t'+turn;await ws.wal.beginFloor(floor);await new MemoryStore(ws.fs.withFloor(floor)).write({body:'fact-'+turn});await ws.wal.commitFloor(floor)}
})
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true})})
async function request(){const messageId=source.snapshotEvents().findLast(event=>event.type==='assistant/message'&&event.surfaceOp==='append')!.seq;const snapshot=await getHelperSnapshot(ctx,state,source.id,messageId);return {messageId,...snapshot}}
async function edit(edits:unknown){const input=await request();return editHelperMessages(ctx,state,source.id,input.messageId,{storyId:input.storyId,historyRevision:input.historyRevision,edits,before:parseHelperMessageEdits(edits).filter(row=>row.data!==undefined||row.extra!==undefined||row.pages!==undefined).map(row=>{
  const target=input.messages.at(row.message_id)!
  return {message_id:row.message_id,...(row.data!==undefined?{data:target?.data??{}}:{}),...(row.extra!==undefined?{extra:target?.extra??{}}:{}),...(row.pages!==undefined?{pages:target?.swipe??{active:0,pages:[{message:target.message,data:target.data,extra:target.extra}]}}:{})}
})})}
const texts=(session:Session)=>session.deriveMessages().flatMap(message=>message.content.filter(block=>block.type==='text').map(block=>block.text))
/** 重建工厂的三个已完成楼层，把真实 MVU 状态和回执按原始顺序写入各自 WAL。 */
async function completedMvu(){
  const binding={...(await state.loadBinding(source.id))!,storyId:newStoryId(),helperMvu:true}
  await snapshotStory({cardRoot:join(state.paths.characters,cardId),sourceRoot:(await state.workspace(cardId)).fs.root,id:binding.storyId,sessionId:source.id})
  await state.saveBinding(binding)
  const ws=await state.storyWorkspace(cardId,binding.storyId)
  const saved:HelperState={scopes:{},extras:{},mvu:{version:1,initialized:true,pending:[],completed:[]}}
  const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
  for(let turn=1;turn<=3;turn++){
    const message=source.snapshotEvents().find(event=>event.type==='assistant/message'&&event.data.turn===turn)!
    if(message.type!=='assistant/message')throw Error('fixture missing assistant')
    const identity=message.data.message.id,floor=source.id+'#t'+turn,kind=turn===1?'initialize' as const:'update' as const
    const data={schema:'没有用别管这个',stat_data:{hp:turn*10}}
    saved.scopes[JSON.stringify(['message',identity])]=data
    saved.mvu!.completed.push({id:hash([kind,identity]),identity,kind,digest:hash(data),valueDigest:hash(data),floor})
    saved.mvu!.lastIdentity=identity
    await ws.wal.beginFloor(floor)
    await new MemoryStore(ws.fs.withFloor(floor)).write({body:'fact-'+turn})
    await saveHelperState(ws.fs.withFloor(floor),saved)
    await ws.wal.commitFloor(floor)
  }
  return {ws,before:await loadHelperState(ws.fs)}
}

it('完成 MVU 后编辑 extra 或未选中页保留初始化状态和全部完成回执',async()=>{
  const {ws,before}=await completedMvu(),receiptBytes=JSON.stringify(before.mvu)
  expect((await edit([{message_id:3,extra:{tag:'label'}}])).branch).toBeNull()
  expect(JSON.stringify((await loadHelperState(ws.fs)).mvu)).toBe(receiptBytes)
  const current=await request(),message=current.messages[5]!
  const pages={active:0,pages:[{message:message.message,data:message.data,extra:message.extra},{message:'alternate',data:{stat_data:{hp:99}},extra:{}}]}
  expect((await edit([{message_id:5,pages}])).branch).toBeNull()
  expect((await edit([{message_id:5,pages:{...pages,pages:pages.pages.map((page,index)=>index===1?{...page,extra:{tag:'updated'}}:page)}}])).branch).toBeNull()
  const saved=await loadHelperState(ws.fs)
  expect(JSON.stringify(saved.mvu)).toBe(receiptBytes)
  expect(saved.scopes).toEqual(before.scopes)
  expect((await request()).messages[5]?.swipe?.pages[1]?.extra).toEqual({tag:'updated'})
  expect(created).not.toHaveBeenCalled()
})

it.each(['edit','delete'] as const)('MVU 分支 %s 只保留未受影响楼层回执，原剧情和原身份状态保持不变',async kind=>{
  const {ws,before}=await completedMvu()
  const result=await edit(kind==='edit'?[{message_id:3,message:'changed',extra:{tag:'child'}}]:[{message_id:2,delete:true},{message_id:3,delete:true}])
  const child=sessions.get(result.branch!.childSessionId)!,binding=(await state.loadBinding(child.id))!,childWs=await state.storyWorkspace(cardId,binding.storyId)
  const saved=await loadHelperState(childWs.fs),kept=before.mvu!.completed[0]!
  expect(saved.mvu).toEqual({...before.mvu,completed:[kept],lastIdentity:kept.identity})
  expect(saved.scopes[JSON.stringify(['message',kept.identity])]).toEqual({schema:'没有用别管这个',stat_data:{hp:10}})
  for(const row of before.mvu!.completed.slice(1))expect(saved.scopes[JSON.stringify(['message',row.identity])]).toBeUndefined()
  expect(await loadHelperState(ws.fs)).toEqual(before)
  expect((await childWs.wal.validateFloor(source.id+'#t1')).rolledBack).toBe(false)
  expect((await childWs.wal.listFloors()).filter(row=>row.floor.startsWith(source.id+'#t')&&row.rolledBack).map(row=>row.floor).sort()).toEqual([source.id+'#t2',source.id+'#t3'])
})

it('批量改用户和 assistant 正文，保留后续消息，只撤销子剧情最早修改楼层及之后事实',async()=>{
  const before=source.snapshotEvents(),result=await edit([{message_id:2,message:'edited user'},{message_id:3,message:'edited assistant'}]),child=sessions.get(result.branch!.childSessionId)!
  expect(texts(child)).toEqual(['user-1','assistant-1','edited user','edited assistant','user-3','assistant-3'])
  expect(source.snapshotEvents()).toEqual(before);expect(texts(source)).toContain('assistant-2');expect(created).toHaveBeenCalledOnce();expect(followup).not.toHaveBeenCalled()
  const binding=(await state.loadBinding(child.id))!,parent=(await state.loadBinding(source.id))!
  expect((await (await state.storyWorkspace(cardId,binding.storyId)).memory.list()).map(item=>item.body)).toEqual(['fact-1'])
  expect((await (await state.storyWorkspace(cardId,parent.storyId)).memory.list()).map(item=>item.body)).toEqual(['fact-1','fact-2','fact-3'])
  expect(binding.walLineage).toContainEqual({sessionId:source.id,throughTurn:3})
})
it('移除修改后已过时的压缩替换，模型和可见消息都读到新正文',async()=>{
  const nodes=source.snapshotEvents().filter(event=>'surfaceOp' in event&&event.surfaceOp==='append'),start=nodes[0]!.seq,end=nodes.at(-1)!.seq
  source.append('user/message',createUserMessage({content:[{type:'text',text:'STALE SUMMARY'}],source:{kind:'user'}}),{surfaceOp:{op:'replace',start,end},sourceEventSeqs:nodes.map(event=>event.seq)})
  expect(texts(source)).toEqual(['STALE SUMMARY'])
  const result=await edit([{message_id:1,message:'NEW FIRST REPLY'}]),child=sessions.get(result.branch!.childSessionId)!
  expect(texts(child)).not.toContain('STALE SUMMARY');expect(texts(child)).toContain('NEW FIRST REPLY');expect(texts(child)).toContain('assistant-3')
  expect(child.snapshotEvents().some(event=>event.type==='tavern/message-edit-marker'&&event.ignorable)).toBe(true)
})
it('无变化不生成分支，负数下标按快照定位，重复/越界/额外字段整批拒绝',async()=>{
  expect(await edit([{message_id:-1,message:'assistant-3'}])).toEqual({branch:null});expect(created).not.toHaveBeenCalled()
  for(const edits of [[{message_id:0,message:'new'},{message_id:-6,message:'other'}],[{message_id:10,message:'bad'}],[{message_id:1,message:'x',is_hidden:true}]])await expect(edit(edits)).rejects.toThrow()
  expect(created).not.toHaveBeenCalled()
  expect(()=>parseHelperMessageEdits([{message_id:0,get message(){throw Error('getter executed')}}])).toThrow(/非法字段/)
})
it('旧历史令牌、换剧情和生成中拒绝；损坏 WAL 在发布宿主子会话前失败',async()=>{
  const input=await request(),base={storyId:input.storyId,historyRevision:input.historyRevision,edits:[{message_id:1,message:'changed'}]}
  await expect(editHelperMessages(ctx,state,source.id,input.messageId,{...base,historyRevision:'old'})).rejects.toThrow(/历史/)
  await expect(editHelperMessages(ctx,state,source.id,input.messageId,{...base,storyId:'other'})).rejects.toThrow(/绑定/)
  state.openFloors.set(source.id,{cardId,storyId:input.storyId,floor:source.id+'#t4'});await expect(edit(base.edits)).rejects.toThrow(/生成/);state.openFloors.delete(source.id)
  const ws=await state.storyWorkspace(cardId,input.storyId),file=(await ws.fs.list('state/wal')).find(path=>path.endsWith('.jsonl'))!
  await appendFile(join(ws.fs.root,'state/wal',file),'broken\n');await expect(edit(base.edits)).rejects.toThrow(/WAL/)
  expect(created).not.toHaveBeenCalled();expect(await state.listStories(cardId)).toHaveLength(1)
})
it('宿主创建失败清理未绑定草稿，不影响原会话或原事实',async()=>{
  vi.spyOn(ctx.agents,'create').mockRejectedValueOnce(Error('host creation failed'))
  await expect(edit([{message_id:3,message:'changed'}])).rejects.toThrow(/host creation failed/)
  expect(await state.listStories(cardId)).toHaveLength(1);expect(texts(source)).toContain('assistant-2')
})
it('编辑正文获得新消息身份，坏 seed 在创建分支前拒绝',()=>{
  const message=source.snapshotEvents().find(event=>event.type==='assistant/message')!
  const seed=editedHistorySeed(source.snapshotEvents(),new Map([[message.seq,'new body']]))
  const changed=seed.find(event=>event.seq===message.seq)!
  expect(changed.type==='assistant/message'&&changed.data.message.id).not.toEqual(message.type==='assistant/message'&&message.data.message.id)
  expect(()=>editedHistorySeed([{...message,seq:SessionSeq(999)}],new Map([[999,'bad']]))).toThrow()
})

it('流式旧正文不残留，非正文推理块保持位置，编辑消息不引用旧片段',()=>{
  const raw=Session.create('session-stream-edit' as Session['id']);raw.append('turn/start',{turn:1})
  const chunk=raw.append('assistant/chunk',{turn:1,step:1,chunk:{type:'text-delta',index:0,text:'old text'}})
  const message=raw.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({content:[{type:'reasoning',text:'reason preserved'},{type:'text',text:'old text'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append',sourceEventSeqs:[chunk.seq]})
  raw.append('turn/end',{turn:1,reason:{kind:'completed'}})
  const changed=editedHistorySeed(raw.snapshotEvents(),new Map([[message.seq,'new text']])),edited=changed.find(event=>event.seq===message.seq)!
  expect(changed.find(event=>event.seq===chunk.seq)).toMatchObject({type:'tavern/message-edit-marker',ignorable:true})
  expect(edited).not.toHaveProperty('sourceEventSeqs')
  expect(edited.type==='assistant/message'&&edited.data.message.content).toEqual([{type:'reasoning',text:'reason preserved'},{type:'text',text:'new text'}])
})
it('复制剧情期间有新的宿主事件时拒绝发布分支，保留新事件与来源状态',async()=>{
  const original=state.forkStory.bind(state)
  vi.spyOn(state,'forkStory').mockImplementation((binding,id,prepare)=>original(binding,id,async fs=>{
    source.append('user/message',createUserMessage({content:[{type:'text',text:'new live event'}],source:{kind:'user'}}),{surfaceOp:'append'})
    await prepare(fs)
  }))
  await expect(edit([{message_id:1,message:'changed'}])).rejects.toThrow(/期间/)
  expect(created).not.toHaveBeenCalled();expect(await state.listStories(cardId)).toHaveLength(1);expect(texts(source)).toContain('new live event')
})

it('批量 data/extra 原子保存，变量 API 和重载读取一致，既有变量写入保留 extra；楼层回滚撤销全部',async()=>{
  const result=await edit([{message_id:1,data:{hp:10},extra:{display:{color:'red'}}},{message_id:-1,data:{hp:20},extra:{tags:['done']}}])
  expect(result.branch).toBeNull();expect(created).not.toHaveBeenCalled();expect(texts(source)).toContain('assistant-3')
  expect(result.snapshot?.messages[1]).toMatchObject({data:{hp:10},extra:{display:{color:'red'}}})
  const input=await request()
  await commitHelperVariables(ctx,state,{sessionId:source.id,messageId:input.messageId,storyId:input.storyId,historyRevision:input.historyRevision,changes:[{key:'["message",1]',before:{hp:10},value:{hp:11}}]})
  const fresh=await request();expect(fresh.messages[1]).toMatchObject({data:{hp:11},extra:{display:{color:'red'}}});expect(fresh.messages[5]?.data).toEqual({hp:20})
  const ws=await state.storyWorkspace(cardId,input.storyId)
  expect((await loadHelperState(new WorkspaceFs(ws.fs.root,null))).extras).not.toEqual({})
  await ws.wal.rollbackFloor(source.id+'#t3',ws.fs.root)
  const reverted=await request();expect(reverted.messages.every(row=>!Object.keys(row.extra).length&&!Object.keys(row.data).length)).toBe(true)
})
it('一个目标原值过时导致整批失败，正文分支也不发布；同值重试允许但缺少原值拒绝',async()=>{
  const input=await request(),before=[{message_id:1,data:{},extra:{}}]
  await edit([{message_id:1,data:{hp:2},extra:{color:'blue'}}])
  const requestBase={storyId:input.storyId,historyRevision:input.historyRevision,before}
  await expect(editHelperMessages(ctx,state,source.id,input.messageId,{...requestBase,edits:[{message_id:1,data:{hp:3},extra:{color:'red'}},{message_id:3,message:'new'}]})).rejects.toThrow(/另一卡面/)
  expect(created).not.toHaveBeenCalled();expect((await request()).messages[1]?.data).toEqual({hp:2})
  await expect(editHelperMessages(ctx,state,source.id,input.messageId,{...requestBase,edits:[{message_id:1,data:{hp:2},extra:{color:'blue'}}]})).resolves.toMatchObject({branch:null})
  await expect(editHelperMessages(ctx,state,source.id,input.messageId,{...requestBase,before:[],edits:[{message_id:1,data:{}}]})).rejects.toThrow(/原值/)
})
it('正文和数据混编只在草稿回滚后绑定新身份；显式数据有子会话 WAL 可再次撤销',async()=>{
  await edit([{message_id:1,data:{old:1},extra:{old:1}}])
  const result=await edit([{message_id:3,message:'changed',data:{hp:9},extra:{tag:'child'}},{message_id:5,data:{hp:8}}]),child=sessions.get(result.branch!.childSessionId)!
  const messageId=child.snapshotEvents().findLast(event=>event.type==='assistant/message')!.seq
  const snapshot=await getHelperSnapshot(ctx,state,child.id,messageId)
  expect(snapshot.messages[3]).toMatchObject({message:'changed',data:{hp:9},extra:{tag:'child'}})
  expect(snapshot.messages[1]?.data).toEqual({});expect(snapshot.messages[5]?.data).toEqual({hp:8})
  const original=await request();expect(original.messages[1]?.data).toEqual({old:1});expect(original.messages[3]?.extra).toEqual({})
  const ws=await state.storyWorkspace(cardId,snapshot.storyId)
  await ws.wal.validateFloor(child.id+'#t3');await ws.wal.rollbackFloor(child.id+'#t3',ws.fs.root)
  expect((await getHelperSnapshot(ctx,state,child.id,messageId)).messages[3]?.data).toEqual({})
  expect((await request()).messages[1]?.data).toEqual({old:1})
})
it('正文写入失败不产生半份消息数据；失败草稿不发布，来源始终不变',async()=>{
  const write=WorkspaceFs.prototype.writeText
  const spy=vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(function(path,value){if(path==='state/helper.json')throw Error('write failed');return write.call(this,path,value)})
  await expect(edit([{message_id:1,data:{hp:1},extra:{x:1}}])).rejects.toThrow(/write failed/)
  expect((await request()).messages[1]).toMatchObject({data:{},extra:{}})
  await expect(edit([{message_id:1,message:'new',data:{hp:1}}])).rejects.toThrow(/write failed/)
  expect(created).not.toHaveBeenCalled();expect(await state.listStories(cardId)).toHaveLength(1)
  spy.mockRestore();await edit([{message_id:1,data:{hp:1},extra:{x:1}}]);expect((await request()).messages[1]?.extra).toEqual({x:1})
})
it('旧版状态兼容读取；损坏 extra 和非法/超量数据在创建分支或写正文前拒绝',async()=>{
  for(const row of [{message_id:1,data:[]},{message_id:1,extra:null},{message_id:1},{message_id:1,extra:{large:'x'.repeat(1024*1024)}}])await expect(edit([row])).rejects.toThrow()
  const input=await request(),ws=await state.storyWorkspace(cardId,input.storyId)
  await ws.fs.writeText('state/helper.json',JSON.stringify({version:1,scopes:{},extras:{bad:[]}}))
  await expect(request()).rejects.toThrow(/普通对象/);expect(created).not.toHaveBeenCalled()
})

it('读取状态期间历史变化不能把旧下标数据写到新历史，也不留下消息数据',async()=>{
  const input=await request(),stat=WorkspaceFs.prototype.stat;let injected=false
  vi.spyOn(WorkspaceFs.prototype,'stat').mockImplementation(async function(path){
    if(path==='state/helper.json'&&!injected){injected=true;source.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'new event'}]}),{surfaceOp:'append'})}
    return stat.call(this,path)
  })
  await expect(editHelperMessages(ctx,state,source.id,input.messageId,{storyId:input.storyId,historyRevision:input.historyRevision,edits:[{message_id:-1,data:{bad:1}}],before:[{message_id:-1,data:{}}]})).rejects.toThrow(/历史/)
  expect((await request()).messages.every(row=>!Object.keys(row.data).length)).toBe(true)
})

it('完整多页保存和普通变量更新在重启后仍一致；切页创建分支并保留离开页的变量',async()=>{
  const first=await request(),base=first.messages[5]!,book={active:0,pages:[{message:base.message,data:base.data,extra:base.extra},{message:'alternate third',data:{hp:2},extra:{tag:'second'}}]}
  const saved=await edit([{message_id:5,pages:book}]);expect(saved.branch).toBeNull();expect(created).not.toHaveBeenCalled()
  expect(texts(source).at(-1)).toBe('assistant-3');expect(saved.snapshot?.messages[5]?.swipe?.pages).toHaveLength(2)
  await commitHelperVariables(ctx,state,{sessionId:source.id,messageId:first.messageId,storyId:first.storyId,historyRevision:first.historyRevision,changes:[{key:'["message",5]',before:{},value:{hp:7}}]})
  const restarted=new TavernState(state.paths,()=>state.config);await restarted.init()
  const fresh=await getHelperSnapshot(ctx,restarted,source.id,first.messageId)
  expect(fresh.messages[5]?.swipe?.pages[0]?.data).toEqual({hp:7})
  const pages={...fresh.messages[5]!.swipe!,active:1},switched=await edit([{message_id:5,pages}]),child=sessions.get(switched.branch!.childSessionId)!
  const childSnapshot=await getHelperSnapshot(ctx,state,child.id,first.messageId)
  expect(texts(child).at(-1)).toBe('alternate third');expect(childSnapshot.messages[5]).toMatchObject({data:{hp:2},extra:{tag:'second'},swipe:{active:1}})
  expect(childSnapshot.messages[5]?.swipe?.pages[0]?.data).toEqual({hp:7})
  const childWs=await state.storyWorkspace(cardId,childSnapshot.storyId)
  expect((await childWs.memory.list()).map(item=>item.body)).toEqual(['fact-1','fact-2'])
  const back=await editHelperMessages(ctx,state,child.id,first.messageId,{storyId:childSnapshot.storyId,historyRevision:childSnapshot.historyRevision,edits:[{message_id:5,pages:{...childSnapshot.messages[5]!.swipe!,active:0}}],before:[{message_id:5,pages:childSnapshot.messages[5]!.swipe!}]})
  const grandchild=sessions.get(back.branch!.childSessionId)!,restored=await getHelperSnapshot(ctx,state,grandchild.id,first.messageId)
  expect(texts(grandchild).at(-1)).toBe('assistant-3');expect(restored.messages[5]?.data).toEqual({hp:7})
  expect((await request()).messages[5]).toMatchObject({message:'assistant-3',data:{hp:7},swipe:{active:0}})
  expect(followup).not.toHaveBeenCalled()
})
it('未选中页修改不分叉，旧页集合冲突整批失败；相同正文的切页也撤销派生事实',async()=>{
  const first=await request(),base=first.messages[5]!,book={active:0,pages:[{message:base.message,data:{},extra:{}},{message:base.message,data:{hp:9},extra:{}}]}
  await edit([{message_id:5,pages:book}]);const before=await request()
  const changed={...book,pages:book.pages.map((page,index)=>index===1?{...page,extra:{tag:'updated'}}:page)}
  expect((await edit([{message_id:5,pages:changed}])).branch).toBeNull();expect(created).not.toHaveBeenCalled()
  await expect(editHelperMessages(ctx,state,source.id,before.messageId,{storyId:before.storyId,historyRevision:before.historyRevision,edits:[{message_id:5,pages:{...book,active:1}}],before:[{message_id:5,pages:book}]})).rejects.toThrow(/消息页已被/)
  const result=await edit([{message_id:5,pages:{...changed,active:1}}]),child=sessions.get(result.branch!.childSessionId)!
  expect(texts(child)).toEqual(texts(source));expect((await getHelperSnapshot(ctx,state,child.id,first.messageId)).messages[5]?.data).toEqual({hp:9})
  const binding=(await state.loadBinding(child.id))!,ws=await state.storyWorkspace(cardId,binding.storyId)
  await ws.wal.validateFloor(child.id+'#t3');await ws.wal.rollbackFloor(child.id+'#t3',ws.fs.root)
  expect(Object.keys((await loadHelperState(ws.fs)).swipes??{})).toHaveLength(0)
  expect((await request()).messages[5]?.swipe?.pages[1]?.extra).toEqual({tag:'updated'})
})
it('坏页集合、页字段矛盾与写失败不落部分数据，也不会提前创建宿主分支',async()=>{
  const first=await request(),base=first.messages[5]!,book={active:0,pages:[{message:base.message,data:{},extra:{}},{message:'alternate',data:{},extra:{}}]}
  for(const pages of [{active:1,pages:[]},{active:3,pages:book.pages},{active:0,pages:[{message:'',data:{},extra:{}}]}])await expect(edit([{message_id:5,pages}])).rejects.toThrow()
  await expect(edit([{message_id:5,message:'contradiction',pages:book}])).rejects.toThrow(/不一致/)
  const original=WorkspaceFs.prototype.writeText,spy=vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(function(path,value){if(path==='state/helper.json')throw Error('page write failed');return original.call(this,path,value)})
  await expect(edit([{message_id:5,pages:book}])).rejects.toThrow(/page write failed/)
  await expect(edit([{message_id:5,pages:{...book,active:1}}])).rejects.toThrow(/page write failed/)
  expect(created).not.toHaveBeenCalled();expect(await state.listStories(cardId)).toHaveLength(1);spy.mockRestore()
  expect((await request()).messages[5]?.swipe?.pages).toHaveLength(1)
})

/** 调用宿主实际关系不变量伴随插件，检查删改 seed 的 turn/step 和工具结果配对，而非自写镜像校验器。 */
async function assertHostTrace(session:Session){
  const adapter={sessions:{list:()=>[session]},on:vi.fn(),invariants:{register:(_name:string,install:(ctx:Context,fail:(message:string)=>never)=>void)=>{install(adapter as unknown as Context,message=>{throw Error(message)});return ()=>{}}}}
  await applySessionInvariant(adapter as unknown as Context)
}
it('删除用户和 assistant 消息同时移除工具配对及过时摘要，保留后续历史与原会话',async()=>{
  await assertHostTrace(source)
  const nodes=source.snapshotEvents().filter(event=>'surfaceOp' in event&&event.surfaceOp==='append')
  source.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'stale deleted summary'}]}),{surfaceOp:{op:'replace',start:nodes[0]!.seq,end:nodes.at(-1)!.seq},sourceEventSeqs:nodes.map(event=>event.seq)})
  const original=source.snapshotEvents(),result=await edit([{message_id:2,delete:true},{message_id:3,delete:true}]),child=sessions.get(result.branch!.childSessionId)!
  expect(result.branch?.title).toContain('删除聊天消息');expect(texts(child)).toEqual(['user-1','assistant-1','user-3','assistant-3'])
  expect(child.snapshotEvents().filter(event=>event.type==='tool/call'||event.type==='tool/result')).toHaveLength(0)
  expect(helperHistoryOf(child.snapshotEvents(),{char:'c',user:'u'}).map(row=>row.message)).toEqual(texts(child))
  expect(source.snapshotEvents()).toEqual(original);expect(texts(source)).toEqual(['stale deleted summary'])
  await assertHostTrace(child)
  const binding=(await state.loadBinding(child.id))!,ws=await state.storyWorkspace(cardId,binding.storyId)
  expect((await ws.memory.list()).map(row=>row.body)).toEqual(['fact-1']);expect(followup).not.toHaveBeenCalled()
})
it('删除后按稳定 seq 映射其它修改；旧导入消息数据和完整页在子剧情清除，来源保留',async()=>{
  const input=await request(),history=helperHistoryOf(source.snapshotEvents(),{char:'c',user:'u'}),removed=history[3]!.identity,ws=await state.storyWorkspace(cardId,input.storyId)
  // 模拟无楼层日志的旧导入数据，删除不能仅依赖回滚碰巧清除它。
  await ws.fs.writeText('state/helper.json',JSON.stringify({version:1,scopes:{[JSON.stringify(['message',removed])]:{old:1}},extras:{[removed]:{old:2}},swipes:{[removed]:{active:0,pages:[{message:'assistant-2',data:{old:1},extra:{old:2}}]}}}))
  const result=await edit([{message_id:2,delete:true},{message_id:3,delete:true},{message_id:5,message:'kept edit',data:{hp:9}}]),child=sessions.get(result.branch!.childSessionId)!
  const next=await getHelperSnapshot(ctx,state,child.id,input.messageId),childWs=await state.storyWorkspace(cardId,next.storyId),stored=await loadHelperState(childWs.fs)
  expect(next.messages[3]).toMatchObject({message:'kept edit',data:{hp:9}});expect(next.messages).toHaveLength(4)
  expect(stored.scopes[JSON.stringify(['message',removed])]).toBeUndefined();expect(stored.extras[removed]).toBeUndefined();expect(stored.swipes?.[removed]).toBeUndefined()
  expect((await loadHelperState(ws.fs)).extras[removed]).toEqual({old:2})
  await childWs.wal.validateFloor(child.id+'#t3')
})
it('可以删除包括当前卡面在内的全部可见消息，子会话仍能继续新回合',async()=>{
  for(let turn=4;turn<=33;turn++){
    source.append('turn/start',{turn});source.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'bulk user '+turn}]}),{surfaceOp:'append'})
    source.append('step/start',{turn,step:1});source.append('assistant/message',{turn,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'bulk reply '+turn}]})},{surfaceOp:'append'});source.append('step/end',{turn,step:1});source.append('turn/end',{turn,reason:{kind:'completed'}})
  }
  const result=await edit(Array.from({length:66},(_,message_id)=>({message_id,delete:true}))),child=sessions.get(result.branch!.childSessionId)!
  expect(child.deriveMessages()).toEqual([]);await assertHostTrace(child)
  child.append('turn/start',{turn:34});child.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'new start'}]}),{surfaceOp:'append'})
  child.append('step/start',{turn:34,step:1});const reply=child.append('assistant/message',{turn:34,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'new reply'}]})},{surfaceOp:'append'});child.append('step/end',{turn:34,step:1});child.append('turn/end',{turn:34,reason:{kind:'completed'}})
  await assertHostTrace(child);expect((await getHelperSnapshot(ctx,state,child.id,reply.seq)).messages.map(row=>row.message)).toEqual(['new start','new reply'])
})
it('删除非法批次、生成中、坏 WAL 和宿主创建失败均不影响来源',async()=>{
  for(const edits of [[{message_id:1,delete:false}],[{message_id:1,delete:true,message:'new'}],[{message_id:1,delete:true},{message_id:-5,delete:true}],[{message_id:99,delete:true}]])await expect(edit(edits)).rejects.toThrow()
  const input=await request();state.openFloors.set(source.id,{cardId,storyId:input.storyId,floor:source.id+'#t4'});await expect(edit([{message_id:1,delete:true}])).rejects.toThrow(/生成/);state.openFloors.delete(source.id)
  vi.spyOn(ctx.agents,'create').mockRejectedValueOnce(Error('delete host failed'));await expect(edit([{message_id:1,delete:true}])).rejects.toThrow(/delete host failed/)
  expect(await state.listStories(cardId)).toHaveLength(1);expect(texts(source)).toContain('assistant-1')
  const ws=await state.storyWorkspace(cardId,input.storyId),file=(await ws.fs.list('state/wal')).find(path=>path.endsWith('.jsonl'))!;await appendFile(join(ws.fs.root,'state/wal',file),'broken\n')
  await expect(edit([{message_id:1,delete:true}])).rejects.toThrow(/WAL/);expect(await state.listStories(cardId)).toHaveLength(1)
})
it('删除有流式片段的消息不残留旧文本；不存在的 seq 和共享步骤的歧义目标拒绝',()=>{
  const raw=Session.create('session-delete-stream' as Session['id']);raw.append('turn/start',{turn:1});raw.append('step/start',{turn:1,step:1})
  raw.append('assistant/chunk',{turn:1,step:1,chunk:{type:'text-delta',index:0,text:'deleted streamed text'}})
  const message=raw.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'deleted streamed text'}]})},{surfaceOp:'append'})
  raw.append('step/end',{turn:1,step:1});raw.append('turn/end',{turn:1,reason:{kind:'completed'}})
  const seed=editedHistorySeed(raw.snapshotEvents(),new Map(),new Set([message.seq]));expect(JSON.stringify(seed)).not.toContain('deleted streamed text');expect(seed.some(event=>event.type==='assistant/chunk')).toBe(false)
  expect(()=>editedHistorySeed(raw.snapshotEvents(),new Map(),new Set([999]))).toThrow(/不在日志/)
  const shared=Session.create('session-delete-shared' as Session['id']);shared.append('turn/start',{turn:1});shared.append('step/start',{turn:1,step:1})
  const one=shared.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'one'}]})},{surfaceOp:'append'})
  shared.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'two'}]})},{surfaceOp:'append'});shared.append('step/end',{turn:1,step:1});shared.append('turn/end',{turn:1,reason:{kind:'completed'}})
  expect(()=>editedHistorySeed(shared.snapshotEvents(),new Map(),new Set([one.seq]))).toThrow(/共用步骤/)
})
