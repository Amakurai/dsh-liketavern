/** 世界书 SDK 的真实文件系统集成：格式往返、原始 UID、共享资产 CAS、聊天 WAL 与剧情隔离。 */
import {mkdtemp,readFile,rm,writeFile,appendFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {beforeEach,afterEach,expect,it,vi} from 'vitest'
import type {Context} from '@deepseek-ai/cordis'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {createAssistantMessage} from '@deepseek-ai/dsh-llm'
import {TavernState} from '../src/node/state.js'
import {resolveConfig} from '../src/node/config.js'
import {onTurnStart,onTurnEnd} from '../src/node/sessionLifecycle.js'
import {getHelperWorldbookContext,helperWorldbookOperation,rebindHelperWorldbooks} from '../src/node/helperWorldbook.js'
import {readHelperWorldbook,writeHelperWorldbook} from '../src/state/helperWorldbook.js'
import {parseHelperWorldbook,type HelperWorldbookOperation} from '../src/core/helperWorldbook.js'
import {parseLorebook} from '../src/state/lorebook.js'
import {WorkspaceFs} from '../src/state/workspaceFs.js'
import {loadBoundLoreEntries,runTavernPipeline} from '../src/node/pipeline.js'
import {decodeChatWorldbooks,CHAT_WORLDBOOK_PATH} from '../src/state/chatWorldbooks.js'
import type {HelperWorldbookRebindRequest} from '../src/core/helperWorldbook.js'
let root:string,state:TavernState,ctx:Context,cardId:string
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'helper-worldbook-'))
  state=new TavernState({root,characters:join(root,'characters'),lorebooks:join(root,'library/lorebooks'),presets:join(root,'library/presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')},()=>resolveConfig({}));await state.init();cardId=(await state.createCharacter('工厂角色')).cardId
  for(const sessionId of ['a','b'])await state.saveBinding({sessionId,cardId,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
  const events=[{type:'turn/start',seq:0,time:0,data:{turn:1}},{type:'assistant/message',seq:1,time:0,data:{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'工厂消息'}]})}},{type:'turn/end',seq:2,time:0,data:{turn:1,reason:{kind:'completed'}}}] as unknown as SessionEvent[]
  ctx={sessions:{get:()=>({snapshotEvents:()=>events})},get:()=>undefined} as unknown as Context
})
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true})})
async function op(name:string,operation:HelperWorldbookOperation,entries?:unknown,revision?:string,sessionId='a'){
  const storyId=(await state.loadBinding(sessionId))!.storyId!,context=await getHelperWorldbookContext(state,sessionId,storyId)
  return helperWorldbookOperation(ctx,state,sessionId,1,{storyId,bindingRevision:context.bindingRevision,name,operation,...(entries===undefined?{}:{entries}),...(revision===undefined?{}:{revision})})
}
it('原生/角色书字段转换保留原始字符串 UID、额外字段、位置和定时效果，写回可由实际引擎读取',()=>{
  const raw={name:'factory',entries:{'named-id':{keys:['door'],secondary_keys:['key'],content:'原文',enabled:true,insertion_order:42,extensions:{position:4,depth:2,role:1,selectiveLogic:3,sticky:2,cooldown:3,group:'team'},custom:{retained:1}}}}
  const view=readHelperWorldbook(raw),entry=view.entries[0]!
  expect(entry).toMatchObject({uid:0,content:'原文',position:{type:'at_depth',role:'user',depth:2,order:42},effect:{sticky:2,cooldown:3}})
  entry.content='修改后的正文'
  const changed=writeHelperWorldbook(view.entries,raw),native=parseLorebook(changed,{source:'global',sourceRef:'factory'})[0]!
  expect(native).toMatchObject({uid:'named-id',content:'修改后的正文',position:4,role:1,sticky:2,cooldown:3,group:'team'})
  expect(readHelperWorldbook(changed).entries[0]).toMatchObject({uid:0,extra:{custom:{retained:1}}})
})
it('现代字段缺省有界归一化，重复 UID、无效键和非 JSON 额外字段明确拒绝',()=>{
  expect(parseHelperWorldbook([{},{}]).map(entry=>entry.uid)).toEqual([0,1])
  expect(()=>parseHelperWorldbook([{uid:1},{uid:1}])).toThrow(/重复/)
  expect(()=>parseHelperWorldbook([{strategy:{keys:[3]}}])).toThrow(/文本/)
  expect(()=>parseHelperWorldbook([{extra:{bad:()=>{}}}])).toThrow(/JSON/)
  expect(()=>parseHelperWorldbook([{content:'x'.repeat(100001)}])).toThrow(/预算/)
})
it('共享书的创建、读取、CAS 替换和删除更新运行时缓存；原始含空格书名可以精确解析',async()=>{
  const created=await op('工厂 书','create',[{uid:7,name:'条目',content:'初始',strategy:{type:'constant'}}])
  expect(created.created).toBe(true);expect(created.snapshot!.name).not.toBe('工厂 书')
  const first=(await op('工厂 书','get')).snapshot!
  expect((await state.loadLorebookEntries(first.name,'global'))[0]?.content).toBe('初始')
  const saved=await op('工厂 书','replace',[{...first.entries[0],content:'已更新'}],first.revision)
  expect(saved.snapshot!.entries[0]).toMatchObject({uid:7,content:'已更新'})
  expect((await state.loadLorebookEntries(first.name,'global'))[0]?.content).toBe('已更新')
  await expect(op('工厂 书','replace',[],first.revision)).rejects.toThrow(/修改/)
  expect((await op('工厂 书','create',[])).created).toBe(false)
  expect((await op('工厂 书','delete',undefined,saved.snapshot!.revision)).deleted).toBe(true)
  expect((await op('工厂 书','delete')).deleted).toBe(false)
})
it('聊天书修改仅落当前剧情并记 WAL，回滚撤销本层创建，其它剧情保持不变',async()=>{
  const created=await op('@dsh/chat','create',[{content:'剧情书'}])
  expect(created.snapshot!.entries[0]?.content).toBe('剧情书')
  expect((await op('@dsh/chat','get',undefined,undefined,'b')).missing).toBe(true)
  const binding=(await state.loadBinding('a'))!,workspace=await state.storyWorkspace(cardId,binding.storyId)
  expect(await (await state.workspace(cardId)).fs.readText('assets/chat-lorebook.json')).toBeNull()
  const logs=await workspace.wal.listFloors();expect(logs.map(log=>log.floor)).toContain('a#t1')
  await workspace.wal.rollbackFloor('a#t1',workspace.fs.root)
  expect((await op('@dsh/chat','get')).missing).toBe(true)
})
it('生成中和损坏 WAL 拒绝聊天书写入，旧正文保持可恢复',async()=>{
  const first=(await op('@dsh/chat','create',[{content:'原文'}])).snapshot!,binding=(await state.loadBinding('a'))!,workspace=await state.storyWorkspace(cardId,binding.storyId)
  state.openFloors.set('a',{cardId,storyId:binding.storyId!,floor:'a#t2'})
  await expect(op('@dsh/chat','replace',[],first.revision)).rejects.toThrow(/生成/);state.openFloors.delete('a')
  const files=await workspace.fs.list('state/wal'),log=files.find(file=>file.endsWith('.jsonl'))!
  await appendFile(join(workspace.fs.root,'state/wal',log),'bad line\n')
  await expect(op('@dsh/chat','replace',[],first.revision)).rejects.toThrow()
  expect((await op('@dsh/chat','get')).snapshot!.entries[0]?.content).toBe('原文')
})
it('角色内嵌书可以清空但保留合法书壳，坏 JSON 不会被空内容覆盖',async()=>{
  await op('@dsh/character','create',[{content:'内嵌'}])
  const before=(await op('@dsh/character','get')).snapshot!
  await op('@dsh/character','replace',[],before.revision)
  expect((await op('@dsh/character','get')).snapshot!.entries).toEqual([])
  await state.saveLorebook('broken',{entries:{}})
  const path=join(root,'library/lorebooks/broken.json');await writeFile(path,'{broken')
  await expect(op('broken','upsert',[])).rejects.toThrow();expect(await readFile(path,'utf8')).toBe('{broken')
})

it('保留名称或重复原始 UID 拒绝转换，新增数字 UID 不覆盖带自定义映射的旧条目',()=>{
  expect(()=>readHelperWorldbook({entries:[{uid:'__proto__',content:'x'}]})).toThrow(/保留名称/)
  expect(()=>readHelperWorldbook({entries:[{uid:'same',content:'a'},{uid:'same',content:'b'}]})).toThrow(/重复/)
  const raw={entries:{'0':{uid:'0',dsh_helper_uid:3,content:'旧条目'}}}
  const result=writeHelperWorldbook([...readHelperWorldbook(raw).entries,{uid:0,content:'新条目'}],raw)
  expect(readHelperWorldbook(result).entries.map(entry=>[entry.uid,entry.content])).toEqual([[3,'旧条目'],[0,'新条目']])
})
it('世界书绑定改变后旧令牌拒绝修改共享资产',async()=>{
  const first=(await op('bound','create',[{content:'保留'}])).snapshot!,binding=(await state.loadBinding('a'))!
  const context=await getHelperWorldbookContext(state,'a',binding.storyId!)
  await state.saveBinding({...binding,lorebookIds:['bound']})
  await expect(helperWorldbookOperation(ctx,state,'a',1,{storyId:binding.storyId!,bindingRevision:context.bindingRevision,name:'bound',operation:'replace',revision:first.revision,entries:[]})).rejects.toThrow(/绑定/)
  expect((await op('bound','get')).snapshot!.entries[0]?.content).toBe('保留')
})

it('角色书镜像写入失败后不能假确认，相同目标重试补齐运行时卡片镜像',async()=>{
  const before=(await op('@dsh/character','create',[{content:'原文'}])).snapshot!,entries=before.entries.map(entry=>({...entry,content:'新文'}))
  await state.loadCharacterLorebookRaw(cardId)
  const original=WorkspaceFs.prototype.writeText,spy=vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(async function(path,text){
    if(path==='card.json')throw new Error('工厂镜像故障')
    return original.call(this,path,text)
  })
  await expect(op('@dsh/character','replace',entries,before.revision)).rejects.toThrow(/镜像故障/)
  spy.mockRestore()
  const result=await op('@dsh/character','replace',entries,before.revision)
  expect(result.snapshot!.entries[0]?.content).toBe('新文')
  expect(readHelperWorldbook((await state.loadCharacterLorebookRaw(cardId))!.json).entries[0]?.content).toBe('新文')
})
it('共享书写入成功但回执失败仍使缓存失效，相同目标可幂等重试',async()=>{
  const first=(await op('uncertain','create',[{content:'旧'}])).snapshot!,entries=first.entries.map(entry=>({...entry,content:'已落盘'}))
  await state.loadLorebookEntries('uncertain','global')
  const original=WorkspaceFs.prototype.writeText,spy=vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(async function(path,text){
    await original.call(this,path,text)
    if(path==='library/lorebooks/uncertain.json')throw new Error('工厂回执故障')
  })
  await expect(op('uncertain','replace',entries,first.revision)).rejects.toThrow(/回执故障/)
  spy.mockRestore()
  expect((await state.loadLorebookEntries('uncertain','global'))[0]?.content).toBe('已落盘')
  expect((await op('uncertain','replace',entries,first.revision)).snapshot!.entries[0]?.content).toBe('已落盘')
})

it('语法合法但结构损坏的世界书拒绝读取或覆盖，原文件保持原样',async()=>{
  for(const value of [null,{name:'missing'},{entries:[null]},{entries:{a:'bad'}}])expect(()=>readHelperWorldbook(value)).toThrow(/结构|损坏/)
  await state.saveLorebook('shape-broken',{entries:{}})
  const path=join(root,'library/lorebooks/shape-broken.json');await writeFile(path,'{"entries":[null]}')
  await expect(op('shape-broken','upsert',[])).rejects.toThrow(/损坏/)
  expect(await readFile(path,'utf8')).toBe('{"entries":[null]}')
})

async function bindBooks(kind:HelperWorldbookRebindRequest['kind'],selection:unknown,sessionId='a'){
  const binding=(await state.loadBinding(sessionId))!,context=await getHelperWorldbookContext(state,sessionId,binding.storyId!)
  return rebindHelperWorldbooks(ctx,state,sessionId,1,{storyId:binding.storyId!,bindingRevision:context.bindingRevision,kind,selection})
}
it('全局和角色绑定影响真实装配来源，空主书可禁用内嵌书，附加书不重复加载',async()=>{
  await op('@dsh/character','create',[{content:'embedded'}]);await op('global book','create',[{content:'global'}]);await op('additional','create',[{content:'additional'}])
  const original=(await state.loadBinding('a'))!,before=state.standingRevTags(original)
  const global=await bindBooks('global',['global book']);expect(global.global).toHaveLength(1)
  await bindBooks('character',{primary:null,additional:['additional','additional']})
  const bound=(await state.loadBinding('a'))!,entries=(await loadBoundLoreEntries(state,bound)).entries
  expect(entries.map(entry=>[entry.source,entry.content])).toEqual([['global','global'],['character','additional']])
  expect(state.standingRevTags(bound)).not.toEqual(before)
  await bindBooks('character',{primary:'@dsh/character',additional:[]})
  expect((await loadBoundLoreEntries(state,(await state.loadBinding('a'))!)).entries.some(entry=>entry.content==='embedded')).toBe(true)
  expect((await state.loadBinding('b'))?.lorebookIds).toEqual([])
})
it('缺书、非法列表和旧绑定令牌整批拒绝，不改变会话选择',async()=>{
  await op('known','create',[])
  const before=await state.loadBinding('a'),context=await getHelperWorldbookContext(state,'a',before!.storyId!)
  await expect(bindBooks('global',['known','missing'])).rejects.toThrow(/不存在/)
  await expect(bindBooks('character',{primary:null,additional:['../private']})).rejects.toThrow()
  expect(await state.loadBinding('a')).toEqual(before)
  await bindBooks('global',['known'])
  await expect(rebindHelperWorldbooks(ctx,state,'a',1,{storyId:context.storyId,bindingRevision:context.bindingRevision,kind:'global',selection:[]})).rejects.toThrow(/绑定/)
  expect((await state.loadBinding('a'))?.lorebookIds).toEqual(['known'])
})
it('聊天绑定采用私有副本，切换回来保留修改，解绑保留书且实际装配不再注入',async()=>{
  await op('source-a','create',[{content:'A'}]);await op('source-b','create',[{content:'B'}])
  const first=await bindBooks('chat','source-a'),a=first.chat!,snapshot=(await op(a,'get')).snapshot!
  await op(a,'replace',[{...snapshot.entries[0],content:'A private'}],snapshot.revision)
  const second=await bindBooks('chat','source-b');expect(second.chat).not.toBe(a)
  expect((await loadBoundLoreEntries(state,(await state.loadBinding('a'))!)).entries.filter(entry=>entry.source==='chat').map(entry=>entry.content)).toEqual(['B'])
  expect((await bindBooks('chat','source-a')).chat).toBe(a)
  expect((await op(a,'get')).snapshot!.entries[0]?.content).toBe('A private')
  expect((await op('source-a','get')).snapshot!.entries[0]?.content).toBe('A')
  const detached=await bindBooks('chat',null);expect(detached.chat).toBeNull();expect(detached.names).toContain(a)
  expect((await loadBoundLoreEntries(state,(await state.loadBinding('a'))!)).entries.filter(entry=>entry.source==='chat')).toEqual([])
  expect((await op(a,'get')).snapshot!.entries[0]?.content).toBe('A private')
  expect((await getHelperWorldbookContext(state,'b',(await state.loadBinding('b'))!.storyId!)).names).not.toContain(a)
})
it('聊天集合随分支复制且各自修改，回滚一次恢复切换前的完整集合与活动书',async()=>{
  const binding=(await state.loadBinding('a'))!
  await state.saveChatLorebook(cardId,{name:'initial',entries:{0:{content:'initial'}}},binding.storyId)
  await op('shared','create',[{content:'shared'}]);const selected=await bindBooks('chat','shared')
  const childStory=await state.forkStory(binding,'child',async()=>{});await state.saveBinding({...binding,sessionId:'child',storyId:childStory})
  await bindBooks('chat',null,'child')
  expect((await getHelperWorldbookContext(state,'a',binding.storyId!)).chat).toBe(selected.chat)
  const ws=await state.storyWorkspace(cardId,binding.storyId);await ws.wal.rollbackFloor('a#t1',ws.fs.root)
  const restored=await getHelperWorldbookContext(state,'a',binding.storyId!)
  expect(restored.chat).toBe('@dsh/chat');expect(restored.names).not.toContain(selected.chat)
  expect((await op('@dsh/chat','get')).snapshot!.entries[0]?.content).toBe('initial')
  expect((await getHelperWorldbookContext(state,'child',childStory)).names).toContain(selected.chat)
})
it('面板保存活动书不删除闲置书，获取已有聊天绑定在生成中允许而切换拒绝',async()=>{
  await op('a-book','create',[{content:'A'}]);await op('b-book','create',[{content:'B'}]);const a=(await bindBooks('chat','a-book')).chat!
  const current=await bindBooks('chat','b-book'),binding=(await state.loadBinding('a'))!
  await state.saveChatLorebook(cardId,{entries:{0:{content:'panel edit'}}},binding.storyId)
  expect((await op(a,'get')).snapshot!.entries[0]?.content).toBe('A')
  expect((await op(current.chat!,'get')).snapshot!.entries[0]?.content).toBe('panel edit')
  state.openFloors.set('a',{cardId,storyId:binding.storyId!,floor:'a#t2'})
  expect((await bindBooks('ensure-chat',null)).chat).toBe(current.chat)
  await expect(bindBooks('chat',a)).rejects.toThrow(/生成/)
})
it('聊天切换写入后回执故障仍可重新读取确认；损坏 WAL 阻止下一次切换',async()=>{
  await op('a-book','create',[{content:'A'}]);await op('b-book','create',[{content:'B'}]);await bindBooks('chat','a-book')
  const original=WorkspaceFs.prototype.writeText,spy=vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(async function(path,text){await original.call(this,path,text);if(path===CHAT_WORLDBOOK_PATH)throw Error('回执故障')})
  await expect(bindBooks('chat','b-book')).rejects.toThrow(/回执故障/);spy.mockRestore()
  const binding=(await state.loadBinding('a'))!,ws=await state.storyWorkspace(cardId,binding.storyId)
  const current=decodeChatWorldbooks(JSON.parse((await ws.fs.readText(CHAT_WORLDBOOK_PATH))!))
  expect((await op('@dsh/chat/'+current.active,'get')).snapshot!.entries[0]?.content).toBe('B')
  const log=(await ws.fs.list('state/wal')).find(file=>file.endsWith('.jsonl'))!
  await appendFile(join(ws.fs.root,'state/wal',log),'broken\n')
  await expect(bindBooks('chat','a-book')).rejects.toThrow()
  expect(decodeChatWorldbooks(JSON.parse((await ws.fs.readText(CHAT_WORLDBOOK_PATH))!)).active).toBe(current.active)
})

it('绑定修改下一轮生效，同轮完整提示词计划仍重放首次冻结的世界书',async()=>{
  await op('first','create',[{content:'FIRST-BOUND-BOOK',strategy:{type:'constant'}}]);await op('second','create',[{content:'SECOND-BOUND-BOOK',strategy:{type:'constant'}}]);await bindBooks('global',['first'])
  await onTurnStart(state,'a',2)
  const run=()=>runTavernPipeline({state,sessionId:'a',agent:null,mode:'live',generationType:'normal',historyOverride:[{role:'user',content:'hello'}]})
  const first=await run();expect(first!.standing).toContain('FIRST-BOUND-BOOK')
  await bindBooks('global',['second'])
  const sameTurn=await run();expect(sameTurn!.standing).toBe(first!.standing);expect(sameTurn!.turnContext).toBe(first!.turnContext)
  await onTurnEnd(state,'a');await onTurnStart(state,'a',3)
  expect((await run())!.standing).toContain('SECOND-BOUND-BOOK')
})
it('解绑后的面板编辑新建活动书，不覆盖保留的主书；角色来源变化必须改变资产指纹',async()=>{
  const binding=(await state.loadBinding('a'))!
  await state.saveChatLorebook(cardId,{name:'preserved',entries:{0:{content:'preserved'}}},binding.storyId)
  await bindBooks('chat',null)
  await state.saveChatLorebook(cardId,{entries:{0:{content:'new panel'}}},binding.storyId)
  const context=await getHelperWorldbookContext(state,'a',binding.storyId!)
  expect(context.chat).not.toBe('@dsh/chat');expect((await op('@dsh/chat','get')).snapshot!.entries[0]?.content).toBe('preserved')
  expect(state.standingRevTags({...binding,lorebookIds:['book'],characterLorebookIds:[]})).not.toEqual(state.standingRevTags({...binding,lorebookIds:[],characterLorebookIds:['book']}))
})

it('旧设置与全局选择一次保存，部分覆盖跨重载保留且其它会话跟随默认',async()=>{
  await op('settings-book','create',[{content:'SETTINGS-FOUND',strategy:{keys:['old']}}])
  const context=await bindBooks('settings',{selected_global_lorebooks:['settings-book'],scan_depth:1,min_activations:1,max_depth:3,recursive:false,overflow_alert:false})
  expect(context.settings).toMatchObject({selected_global_lorebooks:['settings-book'],scan_depth:1,min_activations:1,max_depth:3,recursive:false,overflow_alert:false})
  const binding=(await state.loadBinding('a'))!
  expect(binding.worldInfo).toEqual({scanDepth:1,minActivations:1,maxScanDepth:3,recursiveScan:false,overflowWarning:false})
  expect((await state.loadBinding('b'))!.worldInfo).toBeUndefined()
  const result=await runTavernPipeline({state,sessionId:'a',agent:null,mode:'preview',historyOverride:[{role:'user',content:'old'},{role:'assistant',content:'new'}]})
  expect(result!.turnContext).toContain('SETTINGS-FOUND')
  await expect(bindBooks('settings',{scan_depth:2,selected_global_lorebooks:['missing']})).rejects.toThrow(/不存在/)
  expect((await state.loadBinding('a'))!.worldInfo).toEqual(binding.worldInfo)
  await expect(bindBooks('settings',{scan_depth:2,invalid:true})).rejects.toThrow(/未知/)
  await expect((await state.storyWorkspace(cardId,binding.storyId)).wal.listFloors()).resolves.toEqual([])
})
it('设置修改失效旧令牌，冻结当前轮，下一轮使用新扫描设置',async()=>{
  await op('settings-live','create',[{content:'OLD-KEY-FOUND',strategy:{keys:['old']}}]);await bindBooks('settings',{selected_global_lorebooks:['settings-live'],scan_depth:2,recursive:false})
  await onTurnStart(state,'a',2)
  const run=()=>runTavernPipeline({state,sessionId:'a',agent:null,mode:'live',historyOverride:[{role:'user',content:'old'},{role:'assistant',content:'new'}]})
  const first=await run();expect(first!.turnContext).toContain('OLD-KEY-FOUND')
  const binding=(await state.loadBinding('a'))!,before=await getHelperWorldbookContext(state,'a',binding.storyId!)
  await bindBooks('settings',{scan_depth:1})
  await expect(rebindHelperWorldbooks(ctx,state,'a',1,{storyId:binding.storyId!,bindingRevision:before.bindingRevision,kind:'settings',selection:{scan_depth:3}})).rejects.toThrow(/改变/)
  expect((await run())!.turnContext).toBe(first!.turnContext)
  await onTurnEnd(state,'a');await onTurnStart(state,'a',3)
  expect((await run())!.turnContext).not.toContain('OLD-KEY-FOUND')
})
it('设置写后报错可重新读取确认，策略覆盖进入 standing 指纹，普通扫描覆盖不破坏稳定前缀',async()=>{
  const binding=(await state.loadBinding('a'))!,old=state.standingRevTags(binding)
  expect(state.standingRevTags({...binding,worldInfo:{characterStrategy:2}})).not.toEqual(old)
  expect(state.standingRevTags({...binding,worldInfo:{scanDepth:4}})).toEqual(old)
  const original=state.saveBinding.bind(state),spy=vi.spyOn(state,'saveBinding').mockImplementation(async binding=>{await original(binding);throw Error('written then failed')})
  await expect(bindBooks('settings',{scan_depth:4})).rejects.toThrow(/written/);spy.mockRestore()
  expect((await getHelperWorldbookContext(state,'a',binding.storyId!)).settings!.scan_depth).toBe(4)
})
