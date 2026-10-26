/** 批量消息编辑集成：真实 Session 验证 seed/模型视图、真实剧情 WAL 与模拟宿主分支创建。 */
import {mkdtemp,rm,appendFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {afterEach,beforeEach,expect,it,vi} from 'vitest'
import type {Context} from '@deepseek-ai/cordis'
import {interruptedTurnClosers,KNOWN_SESSION_EVENT_TYPES,Session,SessionSeq,ToolCallRecovery,type SessionEvent} from '@deepseek-ai/dsh-session'
import {CompactionId,compactCheckpointSource} from '@deepseek-ai/dsh-compaction'
import {assertReleasedV4Relationships} from '@deepseek-ai/dsh-session-format-v3-to-v4'
import {validateStoredEvents} from '@deepseek-ai/dsh-session-persistence'
import {createAssistantMessage,createSystemMessage,createUserMessage,createToolResultMessage,ToolCallId} from '@deepseek-ai/dsh-llm'
import {TavernState} from '../src/node/state.js'
import {resolveConfig} from '../src/node/config.js'
import {commitHelperVariables,getHelperScriptBundle,getHelperSnapshot,helperHistoryOf} from '../src/node/helperRuntime.js'
import {editHelperMessages} from '../src/node/helperChatEdits.js'
import {parseHelperMessageEdits} from '../src/core/helperChatEdits.js'
import {editedHistorySeed} from '../src/node/helperChatSeed.js'
import {editAssistantMessage,editUserMessage,getFloorUserMessage,regenerate} from '../src/node/floors.js'
import {sessionHasUserMessage,TAVERN_GREETING_SOURCE} from '../src/core/greetingLog.js'
import {attachPresetPlanMessage} from '../src/node/presetRequestProjection.js'
import {buildTemplateMessageHistory} from '../src/node/templateMessageHistory.js'
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
    source.append('assistant/message',{stream: [], turn,step:1,message:createAssistantMessage({content:[{type:'text',text:'assistant-'+turn},...(turn===2?[{type:'tool-call' as const,id:callId,name:'fixture_tool',arguments:'{}'}]:[])],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
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
const texts=(session:Session)=>session.deriveMessages().filter(message=>message.role!=='tool'&&message.role!=='developer').flatMap(message=>message.content.filter(block=>block.type==='text').map(block=>block.text))

it('楼层正文编辑保留工具调用与结果配对，子剧情撤销派生事实但原会话不变',async()=>{
  const event=source.snapshotEvents().find(event=>event.type==='assistant/message'&&event.data.turn===2)!
  if(event.type!=='assistant/message')throw Error('fixture missing assistant')
  const before=source.snapshotEvents(),call=event.data.message.content.find(block=>block.type==='tool-call')!
  const result=await editAssistantMessage({ctx,state},source.id,event.data.message.id,'edited floor reply')
  const child=sessions.get(result.childSessionId)!
  const reply=child.deriveMessages().find(message=>message.role==='assistant'&&message.content.some(block=>block.type==='text'&&block.text==='edited floor reply'))!
  expect(reply.content).toContainEqual(call)
  expect(child.deriveMessages().some(message=>message.role==='tool'&&call.type==='tool-call'&&message.toolCallId===call.id)).toBe(true)
  expect(source.snapshotEvents()).toEqual(before)
  const binding=(await state.loadBinding(child.id))!
  expect((await (await state.storyWorkspace(cardId,binding.storyId)).memory.list()).map(entry=>entry.body)).toEqual(['fact-1'])
})

it('楼层正文编辑清除同轮旧压缩和失败流，模型实际视图使用修订正文',async()=>{
  const raw=Session.create(source.id)
  raw.append('agent-preset/selected',{agentPreset:'tavern'})
  raw.append('turn/start',{turn:1});raw.append('step/start',{turn:1,step:1})
  raw.append('assistant/attempt',{turn:1,step:1,stream:[{type:'text-chunks',time0:0,index:0,dt:[0],texts:['old failed text']}]})
  const event=raw.append('assistant/message',{turn:1,step:1,stream:[],message:createAssistantMessage({content:[{type:'text',text:'original reply'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  raw.append('user/message',createUserMessage({content:[{type:'text',text:'stale compressed reply'}],source:{kind:'user'}}),{surfaceOp:{op:'replace',startSeq:event.seq,endSeq:event.seq},sourceEventSeqs:[event.seq]})
  raw.append('step/end',{turn:1,step:1});raw.append('turn/end',{turn:1,reason:{kind:'completed'}})
  source=raw;sessions.set(source.id,source)
  const before=source.snapshotEvents()
  const result=await editAssistantMessage({ctx,state},source.id,event.data.message.id,'revised floor reply')
  const child=sessions.get(result.childSessionId)!
  expect(texts(child)).toEqual(['revised floor reply'])
  expect(JSON.stringify(child.snapshotEvents())).not.toContain('old failed text')
  expect(source.snapshotEvents()).toEqual(before)
})
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
  source.append('user/message',createUserMessage({content:[{type:'text',text:'STALE SUMMARY'}],source:{kind:'user'}}),{surfaceOp:{op:'replace',startSeq:start,endSeq:end},sourceEventSeqs:nodes.map(event=>event.seq)})
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
  const chunk=raw.append('assistant/attempt',{turn:1,step:1,stream:[{type:'text-chunks',time0:0,index:0,dt:[0],texts:['old text']}]})
  const message=raw.append('assistant/message',{stream: [{type:'text-chunks',time0:0,index:0,dt:[0],texts:['old text']}], turn:1,step:1,message:createAssistantMessage({content:[{type:'reasoning',text:'reason preserved'},{type:'text',text:'old text'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  raw.append('turn/end',{turn:1,reason:{kind:'completed'}})
  const changed=editedHistorySeed(raw.snapshotEvents(),new Map([[message.seq,'new text']])),edited=changed.find(event=>event.seq===message.seq)!
  expect(changed.find(event=>event.seq===chunk.seq)).toMatchObject({type:'tavern/message-edit-marker',ignorable:true})
  expect(edited).not.toHaveProperty('sourceEventSeqs')
  expect(edited).toHaveProperty('data.stream',[])
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

/** 调用宿主公开持久化校验、V4 关系校验、Session 恢复与 ToolCallRecovery/interruptedTurnClosers，检查删改 seed 的 turn/step、压缩与工具结果配对。 */
async function assertHostTrace(session:Session){
  const events=session.snapshotEvents()
  validateStoredEvents(session.header,events.map(event=>structuredClone(event)))
  assertReleasedV4Relationships({header:{delegationDepth:0,...session.header},inheritedEventCount:session.inheritedEventCount,events:events.map(event=>structuredClone(event))},KNOWN_SESSION_EVENT_TYPES)
  const restored=Session.create(session.id,events,session.header,session.inheritedEventCount)
  expect(restored.deriveMessages()).toEqual(session.deriveMessages())
  const recovery=new ToolCallRecovery()
  for(const event of events){
    if(event.type==='step/end'||event.type==='turn/end'||event.type==='turn/start')expect(recovery.results()).toEqual([])
    recovery.observe(event)
  }
  expect(recovery.results()).toEqual([])
  expect(interruptedTurnClosers(events)).toEqual([])
}
it('修改或删除压缩点之后的消息保留前置压缩事务与工具裁剪，持久化重载不丢 compaction/start',async()=>{
  const raw=Session.create('session-compact-before-edit' as Session['id']);raw.append('agent-preset/selected',{agentPreset:'tavern'})
  raw.append('turn/start',{turn:1})
  const firstUser=raw.append('user/message',createUserMessage({content:[{type:'text',text:'user-1'}],source:{kind:'user'}}),{surfaceOp:'append'})
  raw.append('step/start',{turn:1,step:1})
  const callId=ToolCallId('call-1')
  const firstAssistant=raw.append('assistant/message',{stream:[],turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'assistant-1'},{type:'tool-call',id:callId,name:'fixture_tool',arguments:'{}'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  raw.append('tool/call',{turn:1,step:1,callId,name:'fixture_tool',arguments:'{}'})
  const toolResult=raw.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId,content:[{type:'text',text:'long tool result'}],isError:false})},{surfaceOp:'append'})
  raw.append('step/end',{turn:1,step:1});raw.append('turn/end',{turn:1,reason:{kind:'completed'}})
  raw.append('session/title-llm-request',{messageSeqs:[firstUser.seq],messages:[createUserMessage({content:[{type:'text',text:'user-1'}],source:{kind:'dsh-session-title-llm'}})]})
  raw.append('session/title',{title:'首轮标题',source:{kind:'auto'},messageSeqs:[firstUser.seq]})
  const compactionId=CompactionId('compact-1'),shadowedSeqs=[firstUser.seq,firstAssistant.seq,toolResult.seq]
  const start=raw.append('compaction/start',{compactionId,turn:null})
  const summary=raw.append('compaction/summary',{compactionId,shadowedRange:{start:firstUser.seq,end:toolResult.seq},shadowedSeqs,shadowedTokenCount:30,summary:[{type:'text',text:'summary-1'}],rawInput:{messages:[]},rawOutput:[{type:'text',text:'summary-1'}]})
  const checkpoint=raw.append('user/message',createUserMessage({content:[{type:'text',text:'<compacted-summary>summary-1</compacted-summary>'}],source:compactCheckpointSource(compactionId)}),{surfaceOp:{op:'replace',startSeq:firstUser.seq,endSeq:toolResult.seq},sourceEventSeqs:[start.seq,summary.seq,...shadowedSeqs]})
  raw.append('compaction/end',{compactionId,turn:null})
  raw.append('turn/start',{turn:2})
  raw.append('user/message',createUserMessage({content:[{type:'text',text:'user-2'}],source:{kind:'user'}}),{surfaceOp:'append'})
  raw.append('step/start',{turn:2,step:1})
  const call2=ToolCallId('call-2')
  raw.append('assistant/message',{stream:[],turn:2,step:1,message:createAssistantMessage({content:[{type:'text',text:'assistant-2'},{type:'tool-call',id:call2,name:'fixture_tool',arguments:'{}'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  raw.append('tool/call',{turn:2,step:1,callId:call2,name:'fixture_tool',arguments:'{}'})
  const tool2=raw.append('tool/result',{turn:2,step:1,message:createToolResultMessage({callId:call2,content:[{type:'text',text:'verbose output 2'}],isError:false})},{surfaceOp:'append'})
  raw.append('step/end',{turn:2,step:1})
  raw.append('compaction/prune',{shadowedRange:{start:tool2.seq,end:tool2.seq},shadowedSeqs:[tool2.seq],shadowedTokenCount:12})
  raw.append('tool/result',{...tool2.data,message:{...tool2.data.message,content:[{type:'text',text:'pruned output 2'}]}},{surfaceOp:{op:'replace',startSeq:tool2.seq,endSeq:tool2.seq},sourceEventSeqs:[tool2.seq]})
  raw.append('turn/end',{turn:2,reason:{kind:'completed'}})
  raw.append('turn/start',{turn:3})
  const user3=raw.append('user/message',createUserMessage({content:[{type:'text',text:'user-3'}],source:{kind:'user'}}),{surfaceOp:'append'})
  raw.append('step/start',{turn:3,step:1})
  const assistant3=raw.append('assistant/message',{stream:[],turn:3,step:1,message:createAssistantMessage({content:[{type:'text',text:'assistant-3'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  raw.append('step/end',{turn:3,step:1})
  const staleId=CompactionId('compact-stale')
  const staleStart=raw.append('compaction/start',{compactionId:staleId,turn:3})
  raw.append('turn/end',{turn:3,reason:{kind:'completed'}})
  const seed=editedHistorySeed(raw.snapshotEvents(),new Map([[assistant3.seq,'assistant-3-edited']]),new Set([user3.seq]))
  expect(seed[start.seq]?.type).toBe('compaction/start')
  expect(seed[summary.seq]?.type).toBe('compaction/summary')
  expect(seed[checkpoint.seq]?.type).toBe('user/message')
  expect(seed[staleStart.seq]).toMatchObject({type:'tavern/message-edit-marker',ignorable:true,data:{originalType:'compaction/start',reason:'stale-compaction'}})
  const child=Session.create('session-compact-child' as Session['id'],seed)
  await assertHostTrace(child)
  expect(texts(child)).toEqual(['<compacted-summary>summary-1</compacted-summary>','user-2','assistant-2','assistant-3-edited'])
  const deletedFirstSeed=editedHistorySeed(raw.snapshotEvents(),new Map(),new Set([firstUser.seq]))
  const deletedFirstChild=Session.create('session-compact-deleted-first' as Session['id'],deletedFirstSeed)
  await assertHostTrace(deletedFirstChild)
  expect(texts(deletedFirstChild)).toEqual(['assistant-1','user-2','assistant-2','user-3','assistant-3'])
})
it('删除用户和 assistant 消息同时移除工具配对及过时摘要，保留后续历史与原会话',async()=>{
  await assertHostTrace(source)
  const nodes=source.snapshotEvents().filter(event=>'surfaceOp' in event&&event.surfaceOp==='append')
  source.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'stale deleted summary'}]}),{surfaceOp:{op:'replace',startSeq:nodes[0]!.seq,endSeq:nodes.at(-1)!.seq},sourceEventSeqs:nodes.map(event=>event.seq)})
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
  const input=await request(),history=helperHistoryOf(source.snapshotEvents(),{char:'c',user:'u'}),removed=history[3]!.identity,edited=history[5]!.identity,ws=await state.storyWorkspace(cardId,input.storyId)
  // 模拟无楼层日志的旧导入数据，删除和正文改写都不能仅依赖回滚碰巧清除旧 identity。
  await ws.fs.writeText('state/helper.json',JSON.stringify({version:1,scopes:{[JSON.stringify(['message',removed])]:{old:1},[JSON.stringify(['message',edited])]:{stale:1}},extras:{[removed]:{old:2},[edited]:{stale:2}},swipes:{[removed]:{active:0,pages:[{message:'assistant-2',data:{old:1},extra:{old:2}}]},[edited]:{active:0,pages:[{message:'assistant-3',data:{stale:1},extra:{stale:2}}]}}}))
  const result=await edit([{message_id:2,delete:true},{message_id:3,delete:true},{message_id:5,message:'kept edit',data:{hp:9}}]),child=sessions.get(result.branch!.childSessionId)!
  const next=await getHelperSnapshot(ctx,state,child.id,input.messageId),childWs=await state.storyWorkspace(cardId,next.storyId),stored=await loadHelperState(childWs.fs)
  expect(next.messages[3]).toMatchObject({message:'kept edit',data:{hp:9}});expect(next.messages).toHaveLength(4)
  expect(stored.scopes[JSON.stringify(['message',removed])]).toBeUndefined();expect(stored.extras[removed]).toBeUndefined();expect(stored.swipes?.[removed]).toBeUndefined()
  expect(stored.scopes[JSON.stringify(['message',edited])]).toBeUndefined();expect(stored.extras[edited]).toBeUndefined();expect(stored.swipes?.[edited]).toBeUndefined()
  expect((await loadHelperState(ws.fs)).extras[removed]).toEqual({old:2});expect((await loadHelperState(ws.fs)).extras[edited]).toEqual({stale:2})
  await childWs.wal.validateFloor(child.id+'#t3')
})
it('可以删除包括当前卡面在内的全部可见消息，子会话仍能继续新回合',async()=>{
  for(let turn=4;turn<=33;turn++){
    source.append('turn/start',{turn});source.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'bulk user '+turn}]}),{surfaceOp:'append'})
    source.append('step/start',{turn,step:1});source.append('assistant/message',{stream: [], turn,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'bulk reply '+turn}]})},{surfaceOp:'append'});source.append('step/end',{turn,step:1});source.append('turn/end',{turn,reason:{kind:'completed'}})
  }
  const result=await edit(Array.from({length:66},(_,message_id)=>({message_id,delete:true}))),child=sessions.get(result.branch!.childSessionId)!
  expect(child.deriveMessages()).toEqual([]);await assertHostTrace(child)
  child.append('turn/start',{turn:34});child.append('user/message',createUserMessage({source:{kind:'user'},content:[{type:'text',text:'new start'}]}),{surfaceOp:'append'})
  child.append('step/start',{turn:34,step:1});const reply=child.append('assistant/message',{stream: [], turn:34,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'new reply'}]})},{surfaceOp:'append'});child.append('step/end',{turn:34,step:1});child.append('turn/end',{turn:34,reason:{kind:'completed'}})
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
  raw.append('assistant/attempt',{turn:1,step:1,stream:[{type:'text-chunks',time0:0,index:0,dt:[0],texts:['deleted streamed text']}]})
  const message=raw.append('assistant/message',{stream: [], turn:1,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'deleted streamed text'}]})},{surfaceOp:'append'})
  raw.append('step/end',{turn:1,step:1});raw.append('turn/end',{turn:1,reason:{kind:'completed'}})
  const seed=editedHistorySeed(raw.snapshotEvents(),new Map(),new Set([message.seq]));expect(JSON.stringify(seed)).not.toContain('deleted streamed text');expect(seed.some(event=>event.type==='assistant/attempt')).toBe(false)
  expect(()=>editedHistorySeed(raw.snapshotEvents(),new Map(),new Set([999]))).toThrow(/不在日志/)
  const shared=Session.create('session-delete-shared' as Session['id']);shared.append('turn/start',{turn:1});shared.append('step/start',{turn:1,step:1})
  const one=shared.append('assistant/message',{stream: [], turn:1,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'one'}]})},{surfaceOp:'append'})
  shared.append('assistant/message',{stream: [], turn:1,step:1,message:createAssistantMessage({source:{provider:'test',model:'test'},content:[{type:'text',text:'two'}]})},{surfaceOp:'append'});shared.append('step/end',{turn:1,step:1});shared.append('turn/end',{turn:1,reason:{kind:'completed'}})
  expect(()=>editedHistorySeed(shared.snapshotEvents(),new Map(),new Set([one.seq]))).toThrow(/共用步骤/)
})
it('非 MVU 脚本包跳过纯工具或空白 assistant/message，不因无文本节点抛错',async()=>{
  const library=await state.getHelperScriptLibrary({type:'character',cardId})
  await state.saveHelperScriptLibrary({type:'character',cardId},library.revision,[{type:'script',id:'s1',name:'测试脚本',enabled:true,content:'console.log(1)',info:'',button:{enabled:false,buttons:[]},data:{}}])
  const lastVisibleSeq=(await request()).messageId
  source.append('turn/start',{turn:4});source.append('step/start',{turn:4,step:1})
  const callId=ToolCallId('call-4')
  source.append('assistant/message',{stream:[],turn:4,step:1,message:createAssistantMessage({content:[{type:'tool-call',id:callId,name:'fixture_tool',arguments:'{}'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  const bundle=await getHelperScriptBundle(ctx,state,source.id)
  expect(bundle.messageId).toBe(lastVisibleSeq);expect(bundle.snapshot?.currentMessageId).toBe(5)
  const toolOnly=Session.create('session-tool-only' as Session['id']);toolOnly.append('turn/start',{turn:1});toolOnly.append('step/start',{turn:1,step:1})
  toolOnly.append('assistant/message',{stream:[],turn:1,step:1,message:createAssistantMessage({content:[{type:'tool-call',id:ToolCallId('call-only'),name:'fixture_tool',arguments:'{}'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  sessions.set(toolOnly.id,toolOnly)
  await state.saveBinding({sessionId:toolOnly.id,cardId,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:true,helperMvu:false,greetingIndex:0,createdAt:'now'})
  const emptyBundle=await getHelperScriptBundle(ctx,state,toolOnly.id)
  expect(emptyBundle.messageId).toBeNull();expect(emptyBundle.snapshot).toBeUndefined()
})

it('保留系统提示词单节点替换与完整种子压缩，清理前置图片卸载、手动 /compact、残缺压缩及删除步骤的 PTC 子调用',async()=>{
  const raw=Session.create('session-system-ptc-compact' as Session['id']);raw.append('agent-preset/selected',{agentPreset:'tavern'})
  raw.append('turn/start',{turn:1});raw.append('step/start',{turn:1,step:1})
  const sys0=raw.append('system/message',{turn:1,step:1,message:createSystemMessage('')},{surfaceOp:'append'})
  const greeting=raw.append('assistant/message',{stream:[],turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'greeting-1'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  raw.append('step/end',{turn:1,step:1});raw.append('turn/end',{turn:1,reason:{kind:'completed'}})
  raw.append('turn/start',{turn:2})
  const user2=raw.append('user/message',createUserMessage({content:[{type:'text',text:'user-2'}],source:{kind:'user'}}),{surfaceOp:'append'})
  raw.append('step/start',{turn:2,step:1})
  const sys1=raw.append('system/message',{turn:2,step:1,message:createSystemMessage('standing system prompt')},{surfaceOp:{op:'replace',startSeq:sys0.seq,endSeq:sys0.seq},sourceEventSeqs:[sys0.seq]})
  const ptcCall=ToolCallId('call-ptc-2'),subCall=ToolCallId('sub-ptc-2')
  const assistant2=raw.append('assistant/message',{stream:[],turn:2,step:1,message:createAssistantMessage({content:[{type:'text',text:'assistant-2'},{type:'tool-call',id:ptcCall,name:'run_code',arguments:'{"code":"1"}'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  raw.append('tool/call',{turn:2,step:1,callId:ptcCall,name:'run_code',arguments:'{"code":"1"}'})
  const ptcStart={type:'tool/ptc-dispatch-start',seq:SessionSeq(raw.seq),time:1,data:{rootCallId:ptcCall,parentCallId:ptcCall,subCallId:subCall,name:'tavern_memory_search',arguments:'{"query":"q"}'}} as unknown as SessionEvent
  raw.append(ptcStart.type,ptcStart.data as never)
  const ptcDone={type:'tool/ptc-dispatch',seq:SessionSeq(raw.seq),time:1,data:{rootCallId:ptcCall,parentCallId:ptcCall,subCallId:subCall,name:'tavern_memory_search',arguments:'{"query":"q"}',content:[{type:'text',text:'[]'}],isError:false,durationMs:1}} as unknown as SessionEvent
  raw.append(ptcDone.type,ptcDone.data as never)
  const ptcResult=raw.append('tool/result',{turn:2,step:1,message:createToolResultMessage({callId:ptcCall,content:[{type:'text',text:'ptc done'}],isError:false})},{surfaceOp:'append'})
  raw.append('step/end',{turn:2,step:1});raw.append('turn/end',{turn:2,reason:{kind:'completed'}})
  raw.append('turn/start',{turn:3})
  const user3=raw.append('user/message',createUserMessage({content:[{type:'text',text:'user-3'}],source:{kind:'user'}}),{surfaceOp:'append'})
  raw.append('step/start',{turn:3,step:1})
  const sysInHistory=raw.append('system/message',{turn:3,step:1,message:createSystemMessage('in-history sys 3')},{surfaceOp:'append'})
  const assistant3=raw.append('assistant/message',{stream:[],turn:3,step:1,message:createAssistantMessage({content:[{type:'text',text:'assistant-3'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  raw.append('step/end',{turn:3,step:1});raw.append('turn/end',{turn:3,reason:{kind:'completed'}})

  // 1. 编辑首轮开场白（first < sys1.seq）：保留第 2 轮的 system/message 单节点替换，不把系统提示词打回空串。
  const editedGreetingSeed=editedHistorySeed(raw.snapshotEvents(),new Map([[greeting.seq,'greeting-1-edited']]))
  expect(editedGreetingSeed[sys1.seq]?.type).toBe('system/message')
  const editedGreetingChild=Session.create('session-sys-preserved' as Session['id'],editedGreetingSeed)
  await assertHostTrace(editedGreetingChild)
  expect(editedGreetingChild.deriveMessages()[0]).toMatchObject({role:'system',content:[{type:'text',text:'standing system prompt'}]})

  // 2. 删除含 run_code 的 assistant 步骤：同步移除 tool/ptc-dispatch-start 与 tool/ptc-dispatch，通过 V4 关系校验。
  const deletedPtcSeed=editedHistorySeed(raw.snapshotEvents(),new Map(),new Set([user2.seq,assistant2.seq]))
  expect(deletedPtcSeed[ptcStart.seq]).toMatchObject({type:'tavern/message-edit-marker',ignorable:true,data:{originalType:'tool/ptc-dispatch-start',reason:'deleted-message'}})
  expect(deletedPtcSeed[ptcDone.seq]).toMatchObject({type:'tavern/message-edit-marker',ignorable:true,data:{originalType:'tool/ptc-dispatch',reason:'deleted-message'}})
  const deletedPtcChild=Session.create('session-ptc-deleted' as Session['id'],deletedPtcSeed)
  await assertHostTrace(deletedPtcChild)

  // 3. 前置 image/offload、不完整压缩（缺 checkpoint）与修改点之后的手动 /compact（command/run + command/done）均转为可忽略标记。
  const baseEvents=raw.snapshotEvents()
  const offloadSeq=baseEvents.length
  const brokenStartSeq=offloadSeq+1,brokenSummarySeq=offloadSeq+2,brokenEndSeq=offloadSeq+3
  const cmdRunSeq=offloadSeq+4,cmdStartSeq=offloadSeq+5,cmdSummarySeq=offloadSeq+6,cmdCheckpointSeq=offloadSeq+7,cmdEndSeq=offloadSeq+8,cmdDoneSeq=offloadSeq+9
  const turn4StartSeq=offloadSeq+10,user4Seq=offloadSeq+11,step4StartSeq=offloadSeq+12,sys4Seq=offloadSeq+13,step4EndSeq=offloadSeq+14,turn4EndSeq=offloadSeq+15
  const brokenId=CompactionId('compact-broken'),cmdCompactId=CompactionId('compact-cmd'),commandId='cmd-compact-1'
  const cmdShadowed=[greeting.seq,user2.seq,assistant2.seq,ptcResult.seq,user3.seq,sysInHistory.seq,assistant3.seq]
  const extendedEvents:SessionEvent[]=[
    ...baseEvents,
    {type:'image/offload',seq:SessionSeq(offloadSeq),time:1,data:{targets:[{seq:user2.seq,imageIndexes:[0]}]}} as unknown as SessionEvent,
    {type:'compaction/start',seq:SessionSeq(brokenStartSeq),time:1,data:{compactionId:brokenId,turn:null}},
    {type:'compaction/summary',seq:SessionSeq(brokenSummarySeq),time:1,data:{compactionId:brokenId,shadowedRange:{start:greeting.seq,end:ptcResult.seq},shadowedSeqs:[greeting.seq,user2.seq,assistant2.seq,ptcResult.seq],shadowedTokenCount:20,summary:[{type:'text',text:'broken'}],rawInput:{messages:[]},rawOutput:[{type:'text',text:'broken'}]}},
    {type:'compaction/end',seq:SessionSeq(brokenEndSeq),time:1,data:{compactionId:brokenId,turn:null}},
    {type:'command/run',seq:SessionSeq(cmdRunSeq),time:1,data:{name:'compact',args:'',commandId}} as unknown as SessionEvent,
    {type:'compaction/start',seq:SessionSeq(cmdStartSeq),time:1,data:{compactionId:cmdCompactId,turn:null,sourceCommandId:commandId}},
    {type:'compaction/summary',seq:SessionSeq(cmdSummarySeq),time:1,data:{compactionId:cmdCompactId,sourceCommandId:commandId,shadowedRange:{start:greeting.seq,end:assistant3.seq},shadowedSeqs:cmdShadowed,shadowedTokenCount:40,summary:[{type:'text',text:'cmd-summary'}],rawInput:{messages:[]},rawOutput:[{type:'text',text:'cmd-summary'}]}},
    {type:'user/message',seq:SessionSeq(cmdCheckpointSeq),time:1,surfaceOp:{op:'replace',startSeq:SessionSeq(greeting.seq),endSeq:SessionSeq(assistant3.seq)},sourceEventSeqs:[SessionSeq(cmdStartSeq),SessionSeq(cmdSummarySeq),...cmdShadowed],data:createUserMessage({content:[{type:'text',text:'<compacted-summary>cmd-summary</compacted-summary>'}],source:compactCheckpointSource(cmdCompactId,commandId as never)})},
    {type:'compaction/end',seq:SessionSeq(cmdEndSeq),time:1,data:{compactionId:cmdCompactId,turn:null,sourceCommandId:commandId}},
    {type:'command/done',seq:SessionSeq(cmdDoneSeq),time:1,data:{name:'compact',commandId,kind:'success',result:'ok',sourceEventSeq:SessionSeq(cmdSummarySeq)}} as unknown as SessionEvent,
    {type:'turn/start',seq:SessionSeq(turn4StartSeq),time:1,data:{turn:4}},
    {type:'user/message',seq:SessionSeq(user4Seq),time:1,surfaceOp:'append',data:createUserMessage({content:[{type:'text',text:'user-4'}],source:{kind:'user'}})},
    {type:'step/start',seq:SessionSeq(step4StartSeq),time:1,data:{turn:4,step:1}},
    {type:'system/message',seq:SessionSeq(sys4Seq),time:1,surfaceOp:{op:'replace',startSeq:sys1.seq,endSeq:sys1.seq},sourceEventSeqs:[sys1.seq],data:{turn:4,step:1,message:createSystemMessage('normalized sys 4')}},
    {type:'step/end',seq:SessionSeq(step4EndSeq),time:1,data:{turn:4,step:1}},
    {type:'turn/end',seq:SessionSeq(turn4EndSeq),time:1,data:{turn:4,reason:{kind:'completed'}}}
  ]
  // 编辑第 4 轮用户消息（first = user4Seq）：保留完整手动 /compact，清理前置 image/offload 与残缺 broken 压缩。
  const keepCmdSeed=editedHistorySeed(extendedEvents,new Map([[user4Seq,'user-4-edited']]))
  expect(keepCmdSeed[offloadSeq]).toMatchObject({type:'tavern/message-edit-marker',ignorable:true,data:{originalType:'image/offload',reason:'stale-compaction'}})
  expect(keepCmdSeed[brokenStartSeq]).toMatchObject({type:'tavern/message-edit-marker',ignorable:true,data:{originalType:'compaction/start',reason:'stale-compaction'}})
  expect(keepCmdSeed[brokenSummarySeq]).toMatchObject({type:'tavern/message-edit-marker',ignorable:true,data:{originalType:'compaction/summary',reason:'stale-compaction'}})
  expect(keepCmdSeed[brokenEndSeq]).toMatchObject({type:'tavern/message-edit-marker',ignorable:true,data:{originalType:'compaction/end',reason:'stale-compaction'}})
  expect(keepCmdSeed[cmdRunSeq]?.type).toBe('command/run')
  expect(keepCmdSeed[cmdDoneSeq]?.type).toBe('command/done')
  await assertHostTrace(Session.create('session-keep-cmd-compact' as Session['id'],keepCmdSeed))

  // 编辑第 3 轮回复（first = assistant3.seq < cmdRunSeq）：过时手动 /compact 连同被其折叠且已被第 4 轮 head 归一替代的 in-history system 一起转为可忽略标记。
  const staleCmdSeed=editedHistorySeed(extendedEvents,new Map([[assistant3.seq,'assistant-3-edited']]))
  for(const seq of [sysInHistory.seq,cmdRunSeq,cmdStartSeq,cmdSummarySeq,cmdCheckpointSeq,cmdEndSeq,cmdDoneSeq]){
    expect(staleCmdSeed[seq]).toMatchObject({type:'tavern/message-edit-marker',ignorable:true,data:{reason:'stale-compaction'}})
  }
  const staleCmdChild=Session.create('session-stale-cmd-compact' as Session['id'],staleCmdSeed)
  await assertHostTrace(staleCmdChild)
  expect(texts(staleCmdChild)).toEqual(['normalized sys 4','greeting-1','user-2','assistant-2','user-3','assistant-3-edited','user-4'])
})

it('残缺压缩不污染后续合法压缩的 in-history system，同文本 head 轮次、孤立工具裁剪与多步删除均满足 V4 校验',async()=>{
  const raw=Session.create('session-edge-compactions' as Session['id']);raw.append('agent-preset/selected',{agentPreset:'tavern'})
  raw.append('turn/start',{turn:1});raw.append('step/start',{turn:1,step:1})
  const sys0=raw.append('system/message',{turn:1,step:1,message:createSystemMessage('initial head')},{surfaceOp:'append'})
  const user1=raw.append('user/message',createUserMessage({content:[{type:'text',text:'u1'}],source:{kind:'user'}}),{surfaceOp:'append'})
  const call1=ToolCallId('call-edge-1')
  const assistant1=raw.append('assistant/message',{stream:[],turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'a1'},{type:'tool-call',id:call1,name:'fixture_tool',arguments:'{}'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  raw.append('tool/call',{turn:1,step:1,callId:call1,name:'fixture_tool',arguments:'{}'})
  const tool1=raw.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId:call1,content:[{type:'text',text:'tool-out-1'}],isError:false})},{surfaceOp:'append'})
  raw.append('step/end',{turn:1,step:1});raw.append('turn/end',{turn:1,reason:{kind:'completed'}})
  raw.append('turn/start',{turn:2});raw.append('step/start',{turn:2,step:1})
  const sys2=raw.append('system/message',{turn:2,step:1,message:createSystemMessage('in-history prompt 2')},{surfaceOp:'append'})
  const user2=raw.append('user/message',createUserMessage({content:[{type:'text',text:'u2'}],source:{kind:'user'}}),{surfaceOp:'append'})
  const assistant2=raw.append('assistant/message',{stream:[],turn:2,step:1,message:createAssistantMessage({content:[{type:'text',text:'a2'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  raw.append('step/end',{turn:2,step:1});raw.append('turn/end',{turn:2,reason:{kind:'completed'}})
  const base=raw.snapshotEvents()

  // 1. 失败压缩（无 checkpoint）曾把 sys2 列入 shadowedSeqs；随后合法压缩折叠了 sys2 且第 3 轮替换了 head：编辑第 3 轮时不能把 sys2 标为 stale。
  const failId=CompactionId('compact-fail-sys2'),validId=CompactionId('compact-valid-sys2')
  const validShadowed=[user1.seq,assistant1.seq,tool1.seq,sys2.seq,user2.seq,assistant2.seq]
  const s=base.length
  const eventsWithFailedThenValid:SessionEvent[]=[
    ...base,
    {type:'compaction/start',seq:SessionSeq(s),time:1,data:{compactionId:failId,turn:null}},
    {type:'compaction/summary',seq:SessionSeq(s+1),time:1,data:{compactionId:failId,shadowedRange:{start:user1.seq,end:assistant2.seq},shadowedSeqs:validShadowed,shadowedTokenCount:30,summary:[{type:'text',text:'fail'}],rawInput:{messages:[]},rawOutput:[{type:'text',text:'fail'}]}},
    {type:'compaction/end',seq:SessionSeq(s+2),time:1,data:{compactionId:failId,turn:null,error:{message:'aborted'}}},
    {type:'compaction/start',seq:SessionSeq(s+3),time:1,data:{compactionId:validId,turn:null}},
    {type:'compaction/summary',seq:SessionSeq(s+4),time:1,data:{compactionId:validId,shadowedRange:{start:user1.seq,end:assistant2.seq},shadowedSeqs:validShadowed,shadowedTokenCount:30,summary:[{type:'text',text:'valid'}],rawInput:{messages:[]},rawOutput:[{type:'text',text:'valid'}]}},
    {type:'user/message',seq:SessionSeq(s+5),time:1,surfaceOp:{op:'replace',startSeq:user1.seq,endSeq:assistant2.seq},sourceEventSeqs:[SessionSeq(s+3),SessionSeq(s+4),...validShadowed],data:createUserMessage({content:[{type:'text',text:'<compacted-summary>valid</compacted-summary>'}],source:compactCheckpointSource(validId)})},
    {type:'compaction/end',seq:SessionSeq(s+6),time:1,data:{compactionId:validId,turn:null}},
    {type:'turn/start',seq:SessionSeq(s+7),time:1,data:{turn:3}},
    {type:'user/message',seq:SessionSeq(s+8),time:1,surfaceOp:'append',data:createUserMessage({content:[{type:'text',text:'u3'}],source:{kind:'user'}})},
    {type:'step/start',seq:SessionSeq(s+9),time:1,data:{turn:3,step:1}},
    {type:'system/message',seq:SessionSeq(s+10),time:1,surfaceOp:{op:'replace',startSeq:sys0.seq,endSeq:sys0.seq},sourceEventSeqs:[sys0.seq],data:{turn:3,step:1,message:createSystemMessage('head 3')}},
    {type:'assistant/message',seq:SessionSeq(s+11),time:1,surfaceOp:'append',data:{turn:3,step:1,stream:[],message:createAssistantMessage({content:[{type:'text',text:'a3'}],source:{provider:'test',model:'test'}})}},
    {type:'step/end',seq:SessionSeq(s+12),time:1,data:{turn:3,step:1}},
    {type:'turn/end',seq:SessionSeq(s+13),time:1,data:{turn:3,reason:{kind:'completed'}}},
  ]
  const seed1=editedHistorySeed(eventsWithFailedThenValid,new Map([[s+11,'a3-edited']]))
  expect(seed1[sys2.seq]?.type).toBe('system/message')
  expect(seed1[s+5]?.type).toBe('user/message')
  await assertHostTrace(Session.create('session-failed-then-valid' as Session['id'],seed1))

  // 2. 过时压缩之后的轮次若系统提示词与 head 相同（未发射 system/message 替换），被该压缩遮蔽的 sys2 仍须清除，避免旧 in-history 复活。
  const eventsSameHead:SessionEvent[]=[
    ...base,
    {type:'compaction/start',seq:SessionSeq(s),time:1,data:{compactionId:validId,turn:null}},
    {type:'compaction/summary',seq:SessionSeq(s+1),time:1,data:{compactionId:validId,shadowedRange:{start:user1.seq,end:assistant2.seq},shadowedSeqs:validShadowed,shadowedTokenCount:30,summary:[{type:'text',text:'valid'}],rawInput:{messages:[]},rawOutput:[{type:'text',text:'valid'}]}},
    {type:'user/message',seq:SessionSeq(s+2),time:1,surfaceOp:{op:'replace',startSeq:user1.seq,endSeq:assistant2.seq},sourceEventSeqs:[SessionSeq(s),SessionSeq(s+1),...validShadowed],data:createUserMessage({content:[{type:'text',text:'<compacted-summary>valid</compacted-summary>'}],source:compactCheckpointSource(validId)})},
    {type:'compaction/end',seq:SessionSeq(s+3),time:1,data:{compactionId:validId,turn:null}},
    {type:'turn/start',seq:SessionSeq(s+4),time:1,data:{turn:3}},
    {type:'user/message',seq:SessionSeq(s+5),time:1,surfaceOp:'append',data:createUserMessage({content:[{type:'text',text:'u3'}],source:{kind:'user'}})},
    {type:'step/start',seq:SessionSeq(s+6),time:1,data:{turn:3,step:1}},
    {type:'assistant/message',seq:SessionSeq(s+7),time:1,surfaceOp:'append',data:{turn:3,step:1,stream:[],message:createAssistantMessage({content:[{type:'text',text:'a3'}],source:{provider:'test',model:'test'}})}},
    {type:'step/end',seq:SessionSeq(s+8),time:1,data:{turn:3,step:1}},
    {type:'turn/end',seq:SessionSeq(s+9),time:1,data:{turn:3,reason:{kind:'completed'}}},
  ]
  const seed2=editedHistorySeed(eventsSameHead,new Map([[assistant2.seq,'a2-edited']]))
  expect(seed2[sys2.seq]).toMatchObject({type:'tavern/message-edit-marker',ignorable:true,data:{originalType:'system/message',reason:'stale-compaction'}})
  const child2=Session.create('session-same-head' as Session['id'],seed2)
  await assertHostTrace(child2)
  expect(texts(child2)).not.toContain('in-history prompt 2')

  // 3. 修改点之前的孤立 tool/result replace 被标为 stale 时，引用该替换节点的后续压缩事务也级联转为 stale。
  const orphanToolSeq=s
  const cascadeShadowed=[user1.seq,assistant1.seq,orphanToolSeq,sys2.seq,user2.seq,assistant2.seq]
  const eventsOrphanPrune:SessionEvent[]=[
    ...base,
    {type:'tool/result',seq:SessionSeq(orphanToolSeq),time:1,surfaceOp:{op:'replace',startSeq:tool1.seq,endSeq:tool1.seq},sourceEventSeqs:[tool1.seq],data:{...tool1.data,message:{...tool1.data.message,content:[{type:'text',text:'orphan pruned'}]}}},
    {type:'compaction/start',seq:SessionSeq(s+1),time:1,data:{compactionId:validId,turn:null}},
    {type:'compaction/summary',seq:SessionSeq(s+2),time:1,data:{compactionId:validId,shadowedRange:{start:user1.seq,end:assistant2.seq},shadowedSeqs:cascadeShadowed,shadowedTokenCount:30,summary:[{type:'text',text:'cascade'}],rawInput:{messages:[]},rawOutput:[{type:'text',text:'cascade'}]}},
    {type:'user/message',seq:SessionSeq(s+3),time:1,surfaceOp:{op:'replace',startSeq:user1.seq,endSeq:assistant2.seq},sourceEventSeqs:[SessionSeq(s+1),SessionSeq(s+2),...cascadeShadowed],data:createUserMessage({content:[{type:'text',text:'<compacted-summary>cascade</compacted-summary>'}],source:compactCheckpointSource(validId)})},
    {type:'compaction/end',seq:SessionSeq(s+4),time:1,data:{compactionId:validId,turn:null}},
    {type:'turn/start',seq:SessionSeq(s+5),time:1,data:{turn:3}},
    {type:'user/message',seq:SessionSeq(s+6),time:1,surfaceOp:'append',data:createUserMessage({content:[{type:'text',text:'u3'}],source:{kind:'user'}})},
    {type:'step/start',seq:SessionSeq(s+7),time:1,data:{turn:3,step:1}},
    {type:'assistant/message',seq:SessionSeq(s+8),time:1,surfaceOp:'append',data:{turn:3,step:1,stream:[],message:createAssistantMessage({content:[{type:'text',text:'a3'}],source:{provider:'test',model:'test'}})}},
    {type:'step/end',seq:SessionSeq(s+9),time:1,data:{turn:3,step:1}},
    {type:'turn/end',seq:SessionSeq(s+10),time:1,data:{turn:3,reason:{kind:'completed'}}},
  ]
  const seed3=editedHistorySeed(eventsOrphanPrune,new Map([[s+8,'a3-edited']]))
  expect(seed3[orphanToolSeq]).toMatchObject({type:'tavern/message-edit-marker',ignorable:true})
  expect(seed3[s+3]).toMatchObject({type:'tavern/message-edit-marker',ignorable:true})
  await assertHostTrace(Session.create('session-orphan-cascade' as Session['id'],seed3))

  // 4. 删除多步 turn 的唯一可见回复时，同轮前置纯工具步骤一并清除；非法编辑目标（压缩检查点、工作区指令）直接拒绝。
  const multi=Session.create('session-multistep-delete' as Session['id']);multi.append('agent-preset/selected',{agentPreset:'tavern'})
  multi.append('turn/start',{turn:1})
  const mUser=multi.append('user/message',createUserMessage({content:[{type:'text',text:'m-u1'}],source:{kind:'user'}}),{surfaceOp:'append'})
  const wsNotice=multi.append('user/message',{...createUserMessage({content:[{type:'text',text:'AGENTS.md'}],source:{kind:'user'}}),source:{kind:'agent-instructions'}} as never,{surfaceOp:'append'})
  multi.append('step/start',{turn:1,step:1})
  const mCall=ToolCallId('m-call-1')
  const step1ToolOnly=multi.append('assistant/message',{stream:[],turn:1,step:1,message:createAssistantMessage({content:[{type:'tool-call',id:mCall,name:'fixture_tool',arguments:'{}'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  multi.append('tool/call',{turn:1,step:1,callId:mCall,name:'fixture_tool',arguments:'{}'})
  const step1Result=multi.append('tool/result',{turn:1,step:1,message:createToolResultMessage({callId:mCall,content:[{type:'text',text:'m-tool-res'}],isError:false})},{surfaceOp:'append'})
  multi.append('step/end',{turn:1,step:1})
  multi.append('step/start',{turn:1,step:2})
  const step2Reply=multi.append('assistant/message',{stream:[],turn:1,step:2,message:createAssistantMessage({content:[{type:'text',text:'m-final-reply'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  multi.append('step/end',{turn:1,step:2});multi.append('turn/end',{turn:1,reason:{kind:'completed'}})
  expect(()=>editedHistorySeed(multi.snapshotEvents(),new Map([[999,'bad']]))).toThrow(/不在日志/)
  expect(()=>editedHistorySeed(multi.snapshotEvents(),new Map([[wsNotice.seq,'bad']]))).toThrow(/不是可见消息/)
  expect(()=>editedHistorySeed(eventsSameHead,new Map([[s+2,'bad']]))).toThrow(/不是可见消息/)
  const multiDeletedSeed=editedHistorySeed(multi.snapshotEvents(),new Map(),new Set([mUser.seq,step2Reply.seq]))
  expect(multiDeletedSeed[step1ToolOnly.seq]).toMatchObject({type:'tavern/message-edit-marker',ignorable:true,data:{reason:'deleted-message'}})
  expect(multiDeletedSeed[step1Result.seq]).toMatchObject({type:'tavern/message-edit-marker',ignorable:true,data:{reason:'deleted-message'}})
  const multiChild=Session.create('session-multistep-child' as Session['id'],multiDeletedSeed)
  await assertHostTrace(multiChild)
  expect(multiChild.deriveMessages().filter(m=>m.role==='assistant'||m.role==='tool')).toEqual([])
})

it('楼层重生成、编辑用户消息、开场白判定与历史投影忽略宿主注入消息并剥离旧布局载体',async()=>{
  const raw=Session.create(source.id);raw.append('agent-preset/selected',{agentPreset:'tavern'})
  const greeting=raw.append('assistant/message',{stream:[],turn:0,step:0,message:createAssistantMessage({content:[{type:'text',text:'greeting'}],source:TAVERN_GREETING_SOURCE})},{surfaceOp:'append'})
  const wsMsg={...createUserMessage({content:[{type:'text',text:'<system-reminder>AGENTS.md</system-reminder>'}],source:{kind:'user'}}),source:{kind:'agent-instructions'}} as never
  const modelMsg={...createUserMessage({content:[{type:'text',text:'<system-reminder>switched model</system-reminder>'}],source:{kind:'user'}}),source:{kind:'model-selection'}} as never
  raw.append('user/message',wsMsg,{surfaceOp:'append'})
  raw.append('user/message',modelMsg,{surfaceOp:'append'})
  expect(sessionHasUserMessage(raw.snapshotEvents())).toBe(false)

  raw.append('turn/start',{turn:1})
  const realUser=attachPresetPlanMessage(createUserMessage({content:[{type:'text',text:'real player input'}],source:{kind:'user'}}),{
    version:1,sessionId:source.id,turn:1,standingText:'standing',contextText:'context',layout:{version:1,history:[],entries:[]},
  })
  const userEv=raw.append('user/message',realUser,{surfaceOp:'append'})
  raw.append('user/message',wsMsg,{surfaceOp:'append'})
  raw.append('user/message',modelMsg,{surfaceOp:'append'})
  raw.append('step/start',{turn:1,step:1})
  const replyEv=raw.append('assistant/message',{stream:[],turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'reply-1'}],source:{provider:'test',model:'test'}})},{surfaceOp:'append'})
  raw.append('step/end',{turn:1,step:1})
  const cid=CompactionId('compact-in-turn'),inTurnShadowed=[...raw.surface.nodes]
  const cStart=raw.append('compaction/start',{compactionId:cid,turn:1})
  const cSum=raw.append('compaction/summary',{compactionId:cid,shadowedRange:{start:greeting.seq,end:replyEv.seq},shadowedSeqs:inTurnShadowed,shadowedTokenCount:10,summary:[{type:'text',text:'sum'}],rawInput:{messages:[]},rawOutput:[{type:'text',text:'sum'}]})
  raw.append('user/message',createUserMessage({content:[{type:'text',text:'<compacted-summary>sum</compacted-summary>'}],source:compactCheckpointSource(cid)}),{surfaceOp:{op:'replace',startSeq:greeting.seq,endSeq:replyEv.seq},sourceEventSeqs:[cStart.seq,cSum.seq,...inTurnShadowed]})
  raw.append('compaction/end',{compactionId:cid,turn:1})
  raw.append('turn/end',{turn:1,reason:{kind:'completed'}})
  source=raw;sessions.set(source.id,source)

  expect(helperHistoryOf(source.snapshotEvents(),{char:'c',user:'u'}).map(row=>row.message)).toEqual(['greeting','real player input','reply-1'])
  expect(buildTemplateMessageHistory(source.deriveMessages(),[],'c','u',source.snapshotEvents()).history.map(row=>row.content)).toEqual(['<compacted-summary>sum</compacted-summary>'])
  expect(await getFloorUserMessage({ctx,state},source.id,replyEv.data.message.id)).toEqual({turn:1,text:'real player input'})

  await regenerate({ctx,state},source.id,replyEv.data.message.id)
  expect(followup).toHaveBeenCalledOnce()
  const replayed=followup.mock.calls[0]![0]
  expect(replayed.content).toEqual([{type:'text',text:'real player input'}])
  expect(replayed.source).not.toHaveProperty('tavernPromptPlan')

  followup.mockReset()
  await editUserMessage({ctx,state},source.id,replyEv.data.message.id,'updated player input')
  expect(followup).toHaveBeenCalledOnce()
  expect(followup.mock.calls[0]![0].content).toEqual([{type:'text',text:'updated player input'}])

})
