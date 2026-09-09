/** 酒馆助手真实文件系统与模拟宿主集成：剧情隔离、历史投影、修订冲突、WAL 失败及分支恢复。 */
import { mkdtemp, rm, writeFile, readFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { TavernState } from '../src/node/state.js'
import { resolveConfig } from '../src/node/config.js'
import { getHelperSnapshot, commitHelperVariables,getHelperScriptBundle } from '../src/node/helperRuntime.js'
import { helperChanges, helperTable, type HelperSnapshot } from '../src/core/helperRuntime.js'
import { HELPER_STATE_PATH } from '../src/state/helper.js'
import { newStoryId, snapshotStory } from '../src/state/story.js'
import { resolveReadableAssetPath } from '../src/core/assetRead.js'
import { WorkspaceFs } from '../src/state/workspaceFs.js'

let root:string,state:TavernState,ctx:Context,cardId:string
const sessions=new Map<string,SessionEvent[]>()
function events():SessionEvent[] {
  return [
    {type:'turn/start',seq:0,time:0,data:{turn:1}},
    {type:'user/message',seq:1,time:0,surfaceOp:'append',data:createUserMessage({content:[{type:'text',text:'打开门'}],source:{kind:'user'}})},
    {type:'user/message',seq:2,time:0,surfaceOp:'append',data:createUserMessage({content:[{type:'text',text:'Current runtime context. hidden'}],source:{kind:'user'}})},
    {type:'assistant/message',seq:3,time:0,surfaceOp:'append',data:{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'门开了'}]})}},
    {type:'turn/end',seq:4,time:0,data:{turn:1,reason:{kind:'completed'}}},
  ] as unknown as SessionEvent[]
}
beforeEach(async()=>{
  root=await mkdtemp(join(tmpdir(),'tavern-helper-'))
  state=new TavernState({root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')},()=>resolveConfig({}))
  await state.init();cardId=(await state.createCharacter('工厂角色')).cardId
  sessions.clear();sessions.set('a',events());sessions.set('b',events())
  ctx={sessions:{get:(id:string)=>sessions.has(id)?{snapshotEvents:()=>sessions.get(id)!}:undefined},get:()=>undefined} as unknown as Context
  for(const sessionId of ['a','b']) await state.saveBinding({sessionId,cardId,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
})
afterEach(async()=>{vi.restoreAllMocks();await rm(root,{recursive:true,force:true})})
const read=(id='a')=>getHelperSnapshot(ctx,state,id,3)
const save=(snapshot:HelperSnapshot,key:string,value:Record<string,unknown>,sessionId='a')=>commitHelperVariables(ctx,state,{sessionId,messageId:3,storyId:snapshot.storyId,historyRevision:snapshot.historyRevision,changes:[{key,before:snapshot.scopes[key]??{},value}]})
const ws=async(id='a')=>{const binding=(await state.loadBinding(id))!;return state.storyWorkspace(cardId,binding.storyId)}

describe('剧情变量与真实历史',()=>{
  it('脚本资产按修订保存并随角色导出，保留同期修改的角色资料和旧设置',async()=>{
    const cardRoot=(await state.workspace(cardId)).fs.root,json=JSON.parse(await readFile(join(cardRoot,'card.json'),'utf8'))
    json.extensions={unrelated:{keep:true},tavern_helper:[['scripts',[]],['variables',{seed:5}],['otherSetting',true]]}
    await writeFile(join(cardRoot,'card.json'),JSON.stringify(json));state=new TavernState(state.paths,()=>resolveConfig({}));await state.init()
    const initial=await state.getCharacterHelperScripts(cardId)
    await state.saveCharacter(cardId,{description:'新的角色描述'})
    const saved=await state.saveCharacterHelperScripts(cardId,initial.revision,[{id:'script',enabled:true,content:'await Promise.resolve()',data:{n:1}}])
    expect(saved.revision).not.toBe(initial.revision)
    expect((await state.loadCharacter(cardId))?.card).toMatchObject({description:'新的角色描述',extensions:{unrelated:{keep:true},tavern_helper:{variables:{seed:5},otherSetting:true}}})
    const exported=(await state.exportCharacter(cardId)).json as {data:{extensions:{tavern_helper:{scripts:unknown}}}}
    expect(exported.data.extensions.tavern_helper.scripts).toEqual(saved.trees)
    state=new TavernState(state.paths,()=>resolveConfig({}));await state.init()
    expect(await state.getCharacterHelperScripts(cardId)).toEqual(saved)
    expect(await (await ws()).fs.readText(HELPER_STATE_PATH)).toBeNull()
  })
  it('同一旧修订的并发脚本编辑只有一份生效，非法输入不改资产',async()=>{
    const initial=await state.getCharacterHelperScripts(cardId)
    const results=await Promise.allSettled(['first','second'].map(content=>state.saveCharacterHelperScripts(cardId,initial.revision,[{id:'script',content}])))
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1)
    expect(results.filter(result=>result.status==='rejected')).toHaveLength(1)
    const saved=await state.getCharacterHelperScripts(cardId)
    await expect(state.saveCharacterHelperScripts(cardId,saved.revision,[{id:'duplicate'},{id:'duplicate'}])).rejects.toThrow(/重复/)
    expect(await state.getCharacterHelperScripts(cardId)).toEqual(saved)
  })
  it('写入回执不确定时使缓存失效，重试相同脚本不会再次覆盖角色资产',async()=>{
    const initial=await state.getCharacterHelperScripts(cardId),original=WorkspaceFs.prototype.writeText
    const spy=vi.spyOn(WorkspaceFs.prototype,'writeText').mockImplementation(async function(path,text){await original.call(this,path,text);if(path==='card.json')throw new Error('工厂回执故障')})
    const trees=[{id:'script',content:'const saved = true'}]
    await expect(state.saveCharacterHelperScripts(cardId,initial.revision,trees)).rejects.toThrow('工厂回执故障')
    spy.mockRestore()
    const current=await state.getCharacterHelperScripts(cardId)
    expect(current.trees[0]).toMatchObject({content:'const saved = true'})
    const writes=vi.spyOn(WorkspaceFs.prototype,'writeText')
    expect(await state.saveCharacterHelperScripts(cardId,initial.revision,trees)).toEqual(current)
    expect(writes).not.toHaveBeenCalled()
  })
  it('后台脚本从角色资产读取，启动快照绑定本剧情；交互卡关闭时不运行',async()=>{
    const cardRoot=(await state.workspace(cardId)).fs.root
    const json=JSON.parse(await readFile(join(cardRoot,'card.json'),'utf8'))
    json.extensions={tavern_helper:{scripts:[{id:'factory-script',enabled:true,content:'window.factory=true',data:{n:3}}]}}
    await writeFile(join(cardRoot,'card.json'),JSON.stringify(json))
    state=new TavernState(state.paths,()=>resolveConfig({}));await state.init()
    const bundle=await getHelperScriptBundle(ctx,state,'a')
    expect(bundle.trees[0]).toMatchObject({id:'factory-script',content:'window.factory=true',data:{n:3}})
    expect(bundle.messageId).toBe(3)
    expect(bundle.snapshot?.storyId).toBe((await read()).storyId)
    expect((await getHelperScriptBundle(ctx,state,'b')).storyId).not.toBe(bundle.storyId)
    expect(await (await ws()).fs.readText(HELPER_STATE_PATH)).toBeNull()
    await state.saveBinding({... (await state.loadBinding('a'))!,interactiveCards:false})
    const disabled=await getHelperScriptBundle(ctx,state,'a')
    expect(disabled.enabled).toBe(false);expect(disabled.snapshot).toBeUndefined()
  })
  it('投影真实原文和连续下标，过滤合成消息；读快照不写状态',async()=>{
    const snapshot=await read()
    expect(snapshot.messages.map(m=>[m.message_id,m.role,m.message])).toEqual([[0,'user','打开门'],[1,'assistant','门开了']])
    expect(snapshot.currentMessageId).toBe(1)
    expect(await (await ws()).fs.readText(HELPER_STATE_PATH)).toBeNull()
    expect(resolveReadableAssetPath(HELPER_STATE_PATH).ok).toBe(false)
    await expect(getHelperSnapshot(ctx,state,'a',2)).rejects.toThrow(/不在当前剧情/)
  })
  it('同步作用域落盘后可由新运行时读取，同卡的独立剧情不串数据',async()=>{
    const snapshot=await read(), saved=await save(snapshot,'["message",1]',{affinity:5})
    expect(saved.messages[1]?.data).toEqual({affinity:5})
    expect((await read('b')).scopes).toEqual({})
    const replacement=new TavernState(state.paths,()=>resolveConfig({}));await replacement.init()
    expect((await getHelperSnapshot(ctx,replacement,'a',3)).scopes).toEqual(saved.scopes)
    expect(await (await state.workspace(cardId)).fs.readText(HELPER_STATE_PATH)).toBeNull()
  })
  it('不同表并发可合并；同表旧修订冲突不覆盖，重复提交绝对值幂等',async()=>{
    const initial=await read()
    await save(initial,'["chat",""]',{n:1})
    await save(initial,'["global",""]',{g:2})
    await save(initial,'["chat",""]',{n:1})
    await expect(save(initial,'["chat",""]',{n:2})).rejects.toThrow(/另一卡面/)
    expect((await read()).scopes).toEqual({'["chat",""]':{n:1},'["global",""]':{g:2}})
  })
  it('错误剧情、旧历史、生成中和非法消息作用域全部在写入前拒绝',async()=>{
    const snapshot=await read()
    await expect(save({...snapshot,storyId:(await read('b')).storyId},'["chat",""]',{bad:true})).rejects.toThrow(/绑定/)
    await expect(save(snapshot,'["message",9]',{bad:true})).rejects.toThrow(/不在当前剧情/)
    state.openFloors.set('a',{cardId,storyId:snapshot.storyId,floor:'a#t2'})
    await expect(save(snapshot,'["chat",""]',{bad:true})).rejects.toThrow(/生成期间/)
    state.openFloors.delete('a')
    sessions.set('a',events()) // 新 UUID，即使正文和 seq 相同也不能写旧消息。
    await expect(save(snapshot,'["chat",""]',{bad:true})).rejects.toThrow(/历史已改变/)
    expect(await (await ws()).fs.readText(HELPER_STATE_PATH)).toBeNull()
  })
  it('分支复制后独立推进，撤销子楼层恢复继承值，来源不变',async()=>{
    const saved=await save(await read(),'["message",1]',{n:1})
    const source=await ws(),cardRoot=(await state.workspace(cardId)).fs.root,storyId=newStoryId()
    await snapshotStory({cardRoot,sourceRoot:source.fs.root,id:storyId,sessionId:'child',includeWal:true})
    const binding=(await state.loadBinding('a'))!
    await state.saveBinding({...binding,sessionId:'child',storyId})
    sessions.set('child',sessions.get('a')!)
    await save(await read('child'),'["message",1]',{n:2},'child')
    expect((await read()).scopes).toEqual(saved.scopes)
    const child=await ws('child')
    await child.wal.rollbackFloor('child#t1',child.fs.root)
    expect((await read('child')).messages[1]?.data).toEqual({n:1})
    expect((await read()).messages[1]?.data).toEqual({n:1})
  })
  it('WAL 写入失败与日志损坏都阻止正文修改，修复日志后仍能回滚',async()=>{
    const initial=await read(),saved=await save(initial,'["chat",""]',{n:1}),workspace=await ws()
    const before=await workspace.fs.readText(HELPER_STATE_PATH)
    const spy=vi.spyOn(workspace.wal,'recordChange').mockRejectedValueOnce(new Error('工厂 WAL 故障'))
    await expect(save(saved,'["chat",""]',{n:2})).rejects.toThrow('工厂 WAL 故障')
    spy.mockRestore()
    expect(await workspace.fs.readText(HELPER_STATE_PATH)).toBe(before)
    const records=join(workspace.fs.root,'state/wal/a_t1/records.jsonl'),valid=await readFile(records,'utf8')
    await appendFile(records,'{broken}\n')
    await expect(save(saved,'["chat",""]',{n:2})).rejects.toThrow(/WAL/)
    expect(await workspace.fs.readText(HELPER_STATE_PATH)).toBe(before)
    await writeFile(records,valid)
    await workspace.wal.rollbackFloor('a#t1',workspace.fs.root)
    expect(await workspace.fs.readText(HELPER_STATE_PATH)).toBeNull()
  })
  it('损坏状态、超量与 getter 污染数据拒绝，不静默清空旧值',async()=>{
    const snapshot=await read(),workspace=await ws()
    await writeFile(join(workspace.fs.root,HELPER_STATE_PATH),'{}').catch(async()=>{await workspace.fs.ensureDir('state');await writeFile(join(workspace.fs.root,HELPER_STATE_PATH),'{}')})
    await expect(read()).rejects.toThrow(/损坏/)
    await expect(save(snapshot,'["chat",""]',{n:1})).rejects.toThrow(/损坏/)
    const getter=vi.fn(()=>1)
    expect(()=>helperTable(Object.defineProperty({},'bad',{enumerable:true,get:getter}))).toThrow()
    expect(getter).not.toHaveBeenCalled()
    expect(()=>helperTable(JSON.parse('{"__proto__":{}}'))).toThrow()
    expect(()=>helperTable({value:'界'.repeat(400000)})).toThrow(/预算/)
    expect(()=>helperChanges([{key:'["chat",""]',before:{},value:{}},{key:'["chat",""]',before:{},value:{}}])).toThrow(/重复/)
  })
})
