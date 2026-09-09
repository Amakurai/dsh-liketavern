/** 实际 iframe 注入脚本的通信集成：同步读写、异步回执、来源鉴别、串行合并及关闭失败。 */
import { createContext, runInContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tavernCardBridgeScript } from '../src/core/cardFrame.js'
import type { HelperSnapshot } from '../src/core/helperRuntime.js'
import type { CardScriptContext } from '../src/core/cardScript.js'
import { parseHelperScriptTrees,type HelperScript } from '../src/core/helperScripts.js'

const snapshot:HelperSnapshot={storyId:'story-test',historyRevision:'history',currentMessageId:1,writable:true,
  scopes:{'["chat",""]':{n:0}},messages:[
    {message_id:0,role:'user',name:'旅人',message:'开门',is_hidden:false,data:{},extra:{}},
    {message_id:1,role:'assistant',name:'灯塔',message:'门开了',is_hidden:false,data:{},extra:{}},
  ]}
const cleanups:(()=>void)[]=[]
afterEach(()=>{for(const cleanup of cleanups.splice(0)) cleanup()})
function frame(input:HelperSnapshot=snapshot,scriptContext?:CardScriptContext) {
  const listeners=new Map<string,Set<(event:unknown)=>void>>()
  const requests:{source:string;action:string;requestId:string;changes:{key:string;before:unknown;value:unknown}[]}[]=[]
  const parent={postMessage:vi.fn((message)=>{if(['helperVariablesCommit','helperSnapshotGet','helperMessageEdit'].includes(message.action)) requests.push(message)})}
  const scope:Record<string,unknown>={parent,TextEncoder,crypto:webcrypto,queueMicrotask,setTimeout,clearTimeout,
    document:{readyState:'loading',body:null,addEventListener:vi.fn(),removeEventListener:vi.fn(),
      open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null},
    addEventListener:(name:string,callback:(event:unknown)=>void)=>{if(!listeners.has(name)) listeners.set(name,new Set());listeners.get(name)!.add(callback)},
    removeEventListener:(name:string,callback:(event:unknown)=>void)=>listeners.get(name)?.delete(callback),
  }
  scope.window=scope
  const context=createContext(scope)
  const run=(code:string)=>runInContext(code,context)
  const source=tavernCardBridgeScript({greetings:['开场白'],greetingIndex:0,helperSnapshot:input,scriptContext}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'')
  const install=()=>run(source)
  install()
  const reply=(index:number,extra:Record<string,unknown>,from:unknown=parent)=>{
    for(const listener of listeners.get('message')??[]) listener({source:from,data:{source:'dsh-tavern-card',action:requests[index]!.action==='helperMessageEdit'?'helperMessageEditResult':requests[index]!.action==='helperSnapshotGet'?'helperSnapshotResult':'helperVariablesResult',requestId:requests[index]!.requestId,...extra}})
  }
  const invalidate=(storyId=input.storyId,from:unknown=parent)=>{
    for(const listener of listeners.get('message')??[]) listener({source:from,data:{source:'dsh-tavern-card',action:'helperSnapshotInvalidated',storyId}})
  }
  const cleanup=()=>run('window.__dshTavernBridgeCleanup()')
  cleanups.push(cleanup)
  const send=(data:Record<string,unknown>,from:unknown=parent)=>{for(const listener of listeners.get('message')??[])listener({source:from,data:{source:'dsh-tavern-card',...data}})}
  return {run,requests,reply,parent,install,cleanup,invalidate,send}
}

describe('剧情变量卡面通信',()=>{
  it('后台脚本拥有独立身份、默认脚本变量和动态按钮，初值只填首次缺失的表',async()=>{
    const trees=parseHelperScriptTrees([{id:'script-a',name:'灯塔脚本',enabled:true,data:{n:2},button:{buttons:[{name:'出发',visible:true}]}}])
    const f=frame(snapshot,{script:trees[0] as HelperScript,trees})
    expect(f.run('getScriptId()')).toBe('script-a')
    expect(f.run('getScriptName()')).toBe('灯塔脚本')
    expect(f.run('getVariables({type:"script"})')).toEqual({n:2})
    expect(f.run('getScriptButtons()')).toEqual([{name:'出发',visible:true}])
    f.run('appendInexistentScriptButtons([{name:"出发",visible:false},{name:"休息",visible:true}])')
    expect(f.run('getScriptButtons().length')).toBe(2)
    const saved=f.run('flushHelperVariables()')
    expect(f.requests[0]?.changes[0]?.key).toBe('["script","script-a"]')
    f.reply(0,{ok:true,scopes:{...snapshot.scopes,'["script","script-a"]':{n:2}}});await saved
    f.run('replaceVariables({},{type:"script"})')
    const cleared=f.run('flushHelperVariables()');f.reply(1,{ok:true,scopes:{...snapshot.scopes,'["script","script-a"]':{}}});await cleared
    f.install()
    expect(f.run('getVariables({type:"script"})')).toEqual({})
    expect(f.requests).toHaveLength(2)
  })
  it('刷新更新历史、最新变量下标与上下文，重写后继续使用新修订',async()=>{
    const f=frame()
    const next={...snapshot,historyRevision:'new-history',scopes:{'["message",2]':{n:3}},messages:[...snapshot.messages,
      {message_id:2,role:'user' as const,name:'旅人',message:'继续',is_hidden:false,data:{},extra:{}}]}
    const refreshed=f.run('refreshHelperSnapshot()')
    expect(f.requests[0]?.action).toBe('helperSnapshotGet')
    f.reply(0,{ok:true,snapshot:next});await refreshed
    expect(f.run('getLastMessageId()')).toBe(2)
    expect(f.run('getCurrentMessageId()')).toBe(1)
    expect(f.run('getVariables({type:"message"})')).toEqual({n:3})
    expect(f.run('SillyTavern.getContext().chat.map(m=>m.message)')).toEqual(['开门','门开了','继续'])
    f.install()
    expect(f.run('getLastMessageId()')).toBe(2)
    f.run('replaceVariables({n:4},{type:"message"})')
    const saved=f.run('flushHelperVariables()')
    expect(f.requests[1]).toMatchObject({historyRevision:'new-history',changes:[{key:'["message",2]',before:{n:3},value:{n:4}}]})
    f.reply(1,{ok:true,scopes:{'["message",2]':{n:4}}});await saved
  })
  it('冲突后的刷新默认保留本地，显式丢弃才加载服务器；刷新期间新写入也不覆盖',async()=>{
    const f=frame();f.run('replaceVariables({n:1})')
    const saved=f.run('flushHelperVariables()');f.reply(0,{ok:false,error:'冲突'})
    await expect(saved).rejects.toThrow('冲突')
    await expect(f.run('refreshHelperSnapshot()')).rejects.toThrow(/未保存/)
    expect(f.requests).toHaveLength(1)
    const refresh=f.run('refreshHelperSnapshot({discardUnsaved:true})')
    f.run('replaceVariables({n:2})')
    f.reply(1,{ok:true,snapshot:{...snapshot,scopes:{'["chat",""]':{n:9}}}})
    await expect(refresh).rejects.toThrow(/刷新期间/)
    expect(f.run('getVariables()')).toEqual({n:2})
    const retry=f.run('refreshHelperSnapshot({discardUnsaved:true})')
    f.reply(2,{ok:true,snapshot:{...snapshot,scopes:{'["chat",""]':{n:9}}}});await retry
    expect(f.run('getVariables()')).toEqual({n:9})
    expect(f.run('getHelperPersistenceStatus()')).toBe('saved')
  })
  it('刷新拒绝另一剧情，且使等待旧快照的异步更新失效',async()=>{
    const f=frame()
    const invalid=f.run('refreshHelperSnapshot()')
    f.reply(0,{ok:true,snapshot:{...snapshot,storyId:'other'}})
    await expect(invalid).rejects.toThrow(/快照回执/)
    const update=f.run('updateVariablesWith(v=>new Promise(resolve=>{window.finishUpdate=()=>resolve({n:4})}))')
    const refresh=f.run('refreshHelperSnapshot()');f.reply(1,{ok:true,snapshot});await refresh
    f.run('finishUpdate()')
    await expect(update).rejects.toThrow(/snapshot changed/)
    expect(f.run('getVariables()')).toEqual({n:0})
    expect(f.requests).toHaveLength(2)
  })
  it('同剧情可信通知自动刷新未修改卡面，忽略伪造来源和其他剧情',async()=>{
    const f=frame()
    f.invalidate('other');f.invalidate(snapshot.storyId,{})
    await Promise.resolve();expect(f.requests).toHaveLength(0)
    f.invalidate();f.invalidate()
    await Promise.resolve();expect(f.requests).toHaveLength(1)
    f.reply(0,{ok:true,snapshot:{...snapshot,scopes:{'["chat",""]':{n:8}}}})
    await Promise.resolve();await Promise.resolve()
    expect(f.run('getVariables()')).toEqual({n:8})
  })
  it('修改立即可读，只有当前父窗口的匹配成功回执才能结束保存',async()=>{
    const f=frame()
    f.run('replaceVariables({n:1})')
    const done=f.run('flushHelperVariables()')
    expect(f.run('getVariables()')).toEqual({n:1})
    expect(f.run('getHelperPersistenceStatus()')).toBe('pending')
    expect(f.requests[0]?.changes).toEqual([{key:'["chat",""]',before:{n:0},value:{n:1}}])
    f.reply(0,{ok:true,scopes:{'["chat",""]':{n:999}}},{})
    expect(f.run('getHelperPersistenceStatus()')).toBe('pending')
    f.reply(0,{ok:true,requestId:'forged',scopes:{}})
    expect(f.run('getHelperPersistenceStatus()')).toBe('pending')
    f.reply(0,{ok:true,scopes:{'["chat",""]':{n:1}}})
    await done
    expect(f.run('getHelperPersistenceStatus()')).toBe('saved')
  })
  it('等待落盘期间的新写入不会被旧回执覆盖，并在下一批串行提交',async()=>{
    const f=frame()
    f.run('replaceVariables({n:1})')
    const done=f.run('flushHelperVariables()')
    f.run('replaceVariables({n:2})')
    f.reply(0,{ok:true,scopes:{'["chat",""]':{n:1},'["global",""]':{other:3}}})
    await Promise.resolve();await Promise.resolve()
    expect(f.run('getVariables()')).toEqual({n:2})
    expect(f.requests[1]?.changes).toEqual([{key:'["chat",""]',before:{n:1},value:{n:2}}])
    f.reply(1,{ok:true,scopes:{'["chat",""]':{n:2},'["global",""]':{other:3}}})
    await done
    expect(f.run('getVariables({type:"global"})')).toEqual({other:3})
  })
  it('宿主冲突保留本地数据供备份，失败之后不再伪装成保存中或成功',async()=>{
    const f=frame()
    f.run('replaceVariables({n:1})')
    const done=f.run('flushHelperVariables()')
    f.reply(0,{ok:false,error:'变量冲突'})
    await expect(done).rejects.toThrow('变量冲突')
    expect(f.run('getVariables()')).toEqual({n:1})
    expect(f.run('getHelperPersistenceStatus()')).toBe('error')
    f.run('replaceVariables({n:2})')
    await expect(f.run('flushHelperVariables()')).rejects.toThrow('变量冲突')
    expect(f.run('getHelperPersistenceStatus()')).toBe('error')
    expect(f.requests).toHaveLength(1)
  })
  it('关闭时拒绝挂起的等待，不接受晚到回执',async()=>{
    const f=frame()
    f.run('replaceVariables({n:1})')
    const done=f.run('flushHelperVariables()'),rejected=expect(done).rejects.toThrow(/重写或关闭/)
    f.cleanup()
    await rejected
    f.reply(0,{ok:true,scopes:{'["chat",""]':{n:7}}})
    expect(f.run('getVariables()')).toEqual({n:1})
  })
  it('回执已入队但继续执行前关闭时，不能覆盖新文档的变量',async()=>{
    const f=frame()
    const refreshed=f.run('refreshHelperSnapshot()')
    f.reply(0,{ok:true,snapshot:{...snapshot,scopes:{'["chat",""]':{n:9}}}})
    f.cleanup()
    await expect(refreshed).rejects.toThrow(/已关闭/)
    expect(f.run('getVariables()')).toEqual({n:0})
    await expect(f.run('flushHelperVariables()')).rejects.toThrow(/已关闭/)
  })
  it('消息接口读取完整快照，变量支持历史负下标而不把系统注入当用户台词',()=>{
    const f=frame()
    expect(f.run('getChatMessages("0-{{lastMessageId}}").map(m=>m.message)')).toEqual(['开门','门开了'])
    expect(f.run('SillyTavern.getContext().chat.map(m=>m.message)')).toEqual(['开门','门开了'])
    expect(f.run('getChatMessages(-2)[0].role')).toBe('user')
    expect(f.run('getChatMessages("0-1",{role:"assistant"})')).toHaveLength(1)
    expect(f.run('getVariables({type:"message",message_id:-2})')).toEqual({})
    expect(()=>f.run('getVariables({type:"message",message_id:-3})')).toThrow(/out of range/)
  })
})

it('后台脚本同步读取三类库的独立副本，重写后保持完整库上下文',()=>{
  const global=parseHelperScriptTrees([{id:'global-script',enabled:true,content:'global code'}])
  const preset=parseHelperScriptTrees([{id:'preset-script',enabled:true,content:'preset code'}])
  const character=parseHelperScriptTrees([{id:'character-script',enabled:true}])
  const f=frame({...snapshot,scopes:{...snapshot.scopes,'["script","global-script"]':{}}},{script:global[0] as HelperScript,trees:character,libraries:[{type:'global',trees:global},{type:'preset',trees:preset},{type:'character',trees:character}]})
  expect(f.run('getScriptId()')).toBe('global-script')
  expect(f.run('getScriptTrees({type:"preset"})[0].content')).toBe('preset code')
  f.run('getScriptTrees({type:"global"})[0].content="changed"')
  expect(f.run('TavernHelper.getScriptTrees({type:"global"})[0].content')).toBe('global code')
  expect(()=>f.run('getScriptTrees({type:"unknown"})')).toThrow(/类型/)
  f.install()
  expect(f.run('getScriptTrees({type:"character"})[0].id')).toBe('character-script')
  expect(f.requests).toHaveLength(0)
})

it('批量正文编辑先保存变量，成功回执后才确认分支，不能从同一卡面重复分叉',async()=>{
  const f=frame();f.run('replaceVariables({n:2})')
  const edit=f.run('setChatMessages([{message_id:0,message:"用户新正文"},{message_id:1,message:"角色新正文"}],{refresh:"none"})')
  expect(f.requests[0]).toMatchObject({action:'helperVariablesCommit'});expect(f.requests).toHaveLength(1)
  f.reply(0,{ok:true,scopes:{'["chat",""]':{n:2}}});await vi.waitFor(()=>expect(f.requests).toHaveLength(2))
  expect(f.requests[1]).toMatchObject({action:'helperMessageEdit',storyId:'story-test',historyRevision:'history',edits:[{message_id:0,message:'用户新正文'},{message_id:1,message:'角色新正文'}]})
  await expect(f.run('setChatMessages([{message_id:1,message:"重复"}])')).rejects.toThrow(/进行/)
  expect(f.parent.postMessage.mock.calls.some(([message])=>message.action==='helperMessageEditApplied')).toBe(false)
  f.reply(1,{ok:true,result:{branch:{childSessionId:'child',title:'编辑'}}},{});expect(f.parent.postMessage.mock.calls.some(([message])=>message.action==='helperMessageEditApplied')).toBe(false)
  f.reply(1,{ok:true,result:{branch:{childSessionId:'child',title:'编辑'}}});await edit
  expect(f.parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({action:'helperMessageEditApplied',requestId:f.requests[1]!.requestId}),'*')
  await expect(f.run('setChatMessages([{message_id:1,message:"重复"}])')).rejects.toThrow(/分支/)
})
it('正文编辑整批拒绝不支持字段；失败或关闭不会确认跳转，空批次不发请求',async()=>{
  const f=frame();await f.run('setChatMessages([])');expect(f.requests).toHaveLength(0)
  await expect(f.run('setChatMessages([{message_id:0,message:"ok"},{message_id:1,is_hidden:true}])')).rejects.toThrow(/不支持修改消息属性/)
  expect(f.requests).toHaveLength(0)
  const edit=f.run('setChatMessages([{message_id:1,message:"new"}])');const assertion=expect(edit).rejects.toThrow(/conflict/)
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1));f.reply(0,{ok:false,error:'conflict'});await assertion
  expect(f.parent.postMessage.mock.calls.some(([message])=>message.action==='helperMessageEditApplied')).toBe(false)
  const later=f.run('setChatMessages([{message_id:1,message:"new"}])');const closed=expect(later).rejects.toThrow(/关闭/);await vi.waitFor(()=>expect(f.requests).toHaveLength(2));f.cleanup();await closed
})

it('消息数据事务返回新快照；等待期间的新变量保持草稿，随后以新确认值串行保存',async()=>{
  const f=frame(),edit=f.run('setChatMessages([{message_id:1,data:{hp:1},extra:{nested:{color:"red"}}}],{refresh:"none"})')
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1))
  expect(f.requests[0]).toMatchObject({action:'helperMessageEdit',before:[{message_id:1,data:{},extra:{}}]})
  f.run('replaceVariables({hp:2},{type:"message",message_id:1})')
  await Promise.resolve();expect(f.requests).toHaveLength(1)
  const next={...snapshot,scopes:{...snapshot.scopes,'["message",1]':{hp:1}},messages:snapshot.messages.map(message=>message.message_id===1?{...message,data:{hp:1},extra:{nested:{color:'red'}}}:message)}
  f.reply(0,{ok:true,result:{branch:null,snapshot:next}});await edit
  await vi.waitFor(()=>expect(f.requests).toHaveLength(2))
  expect(f.requests[1]).toMatchObject({action:'helperVariablesCommit',changes:[{key:'["message",1]',before:{hp:1},value:{hp:2}}]})
  const flushed=f.run('flushHelperVariables()');f.reply(1,{ok:true,scopes:{...snapshot.scopes,'["message",1]':{hp:2}}});await flushed
  expect(f.run('getChatMessages(1)[0].data')).toEqual({hp:2})
  f.run('getChatMessages(1)[0].extra.nested.color="mutated"');expect(f.run('getChatMessages(1)[0].extra')).toEqual({nested:{color:'red'}})
  expect(f.parent.postMessage.mock.calls.some(([message])=>message.action==='helperMessageEditApplied')).toBe(false)
  const second=f.run('setChatMessages([{message_id:1,extra:{}}])');await vi.waitFor(()=>expect(f.requests).toHaveLength(3));expect(f.requests[2]).toMatchObject({before:[{message_id:1,extra:{nested:{color:'red'}}}]});f.reply(2,{ok:false,error:'conflict'});await expect(second).rejects.toThrow(/conflict/)
})

it('实际 SDK 接受修改后的完整消息对象，swipe 当前页返回真实 data/extra 且副本互不串改',async()=>{
  const initial={...snapshot,scopes:{...snapshot.scopes,'["message",1]':{hp:1}},messages:snapshot.messages.map(row=>row.message_id===1?{...row,data:{hp:1},extra:{panel:{tab:'old'}}}:row)}
  const f=frame(initial)
  expect(f.run('getChatMessages(1,{include_swipes:true})[0].swipes_data[0]')).toEqual({hp:1})
  expect(f.run('getChatMessages(1,{include_swipes:true})[0].swipes_info[0]')).toEqual({panel:{tab:'old'}})
  const edit=f.run('const row=getChatMessages(1); row[0].data.hp=2; row[0].extra.panel.tab="new"; setChatMessages(row,{refresh:"none"})')
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1))
  expect(f.requests[0]).toMatchObject({action:'helperMessageEdit',edits:[{message_id:1,message:'门开了',data:{hp:2},extra:{panel:{tab:'new'}}}],before:[{message_id:1,data:{hp:1},extra:{panel:{tab:'old'}}}]})
  const next={...initial,scopes:{...initial.scopes,'["message",1]':{hp:2}},messages:initial.messages.map(row=>row.message_id===1?{...row,data:{hp:2},extra:{panel:{tab:'new'}}}:row)}
  f.reply(0,{ok:true,result:{branch:null,snapshot:next}});await edit
  f.run('getChatMessages(1,{include_swipes:true})[0].swipes_data[0].hp=999')
  expect(f.run('getChatMessages(1)[0].data.hp')).toBe(2)
  const swiped=f.run('const pages=getChatMessages(1,{include_swipes:true}); pages[0].swipes[0]="swipe body"; pages[0].swipes_data[0].hp=3; setChatMessages(pages)')
  await vi.waitFor(()=>expect(f.requests).toHaveLength(2))
  expect(f.requests[1]).toMatchObject({edits:[{message_id:1,message:'swipe body',data:{hp:3},extra:{panel:{tab:'new'}}}]})
  f.reply(1,{ok:true,result:{branch:{childSessionId:'child',title:'changed'}}});await swiped
})
it('完整消息中的不支持变化、矛盾别名与旧开场白 getter 均整批失败，不发送部分修改',async()=>{
  const f=frame()
  for(const code of ['const rows=getChatMessages("0-1");rows[0].data.x=1;rows[1].role="user";setChatMessages(rows)',
    'setChatMessages([{message_id:1,message:"one",mes:"two"}])',
    'setChatMessages([{message_id:1,get swipe_id(){throw Error("getter ran")}}])'])await expect(f.run('(async()=>{'+code.replace('setChatMessages(','return setChatMessages(')+'})()')).rejects.toThrow()
  expect(f.requests).toHaveLength(0)
})

it('完整页 SDK 新增未选中页后读回，单条 swipe_id 走持久化分支而不是旧开场白桥',async()=>{
  const initial={...snapshot,messages:snapshot.messages.map(row=>row.message_id===1?{...row,swipe:{active:0,pages:[{message:row.message,data:{},extra:{}},{message:'second',data:{hp:2},extra:{tag:2}}]}}:row)}
  const f=frame(initial),saved=f.run('setChatMessages([{message_id:1,swipes:["门开了","second","third"],swipes_data:[{},{hp:2},{hp:3}],swipes_info:[{},{tag:2},{tag:3}]}],{refresh:"none"})')
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1))
  expect(f.requests[0]).toMatchObject({action:'helperMessageEdit',edits:[{message_id:1,pages:{active:0,pages:[{message:'门开了'},{message:'second',data:{hp:2}},{message:'third',data:{hp:3},extra:{tag:3}}]}}],before:[{message_id:1,pages:{active:0,pages:[{message:'门开了'},{message:'second'}]}}]})
  const book={active:0,pages:[{message:'门开了',data:{},extra:{}},{message:'second',data:{hp:2},extra:{tag:2}},{message:'third',data:{hp:3},extra:{tag:3}}]}
  const next={...initial,messages:initial.messages.map(row=>row.message_id===1?{...row,swipe:book}:row)}
  f.reply(0,{ok:true,result:{branch:null,snapshot:next}});await saved
  expect(f.run('getChatMessages(1,{include_swipes:true})[0].swipes_data')).toEqual([{}, {hp:2},{hp:3}])
  expect(f.run('Object.hasOwn(getChatMessages(1)[0],"swipe")')).toBe(false)
  const switched=f.run('setChatMessages([{message_id:1,swipe_id:2}])');await vi.waitFor(()=>expect(f.requests).toHaveLength(2))
  expect(f.requests[1]).toMatchObject({edits:[{message_id:1,message:'third',data:{hp:3},extra:{tag:3},pages:{active:2}}]})
  f.reply(1,{ok:true,result:{branch:{childSessionId:'swipe-child',title:'swipe'}}});await switched
  expect(f.parent.postMessage.mock.calls.some(([row])=>row.action==='swipeGreeting')).toBe(false)
})

it('旧 setChatMessage 和 Slash 切页等待现代事务，当前页下标按持久化集合计算',async()=>{
  const initial={...snapshot,messages:snapshot.messages.map(row=>row.message_id===1?{...row,swipe:{active:0,pages:[{message:row.message,data:{},extra:{}},{message:'second',data:{hp:2},extra:{}},{message:'third',data:{hp:3},extra:{}}]}}:row)}
  const f=frame(initial),edit=f.run('setChatMessage("legacy body",1,{swipe_id:1,refresh:"none"})')
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1));expect(f.requests[0]).toMatchObject({edits:[{message_id:1,message:'legacy body',data:{hp:2},pages:{active:1}}]})
  f.reply(0,{ok:true,result:{branch:{childSessionId:'child',title:'legacy'}}});await edit
  expect(f.parent.postMessage.mock.calls.some(([row])=>row.action==='swipeGreeting')).toBe(false)
  const g=frame(initial),slash=g.run('triggerSlash("/swipe left")');await vi.waitFor(()=>expect(g.requests).toHaveLength(1));expect(g.requests[0]).toMatchObject({edits:[{message_id:1,message:'third',pages:{active:2}}]})
  g.reply(0,{ok:true,result:{branch:{childSessionId:'child-2',title:'slash'}}});expect(await slash).toBe('')
  expect(await g.run('triggerSlash("/pass {{lastMessageId}}")')).toBe('1')
})
it('上下文只保存改动行，原生页变量别名有效；保存期间继续编辑按字段保留且可再次保存',async()=>{
  const f=frame();f.run('var ctx=SillyTavern.getContext();var held=ctx.chat[1];held.variables[0].hp=2')
  const saved=f.run('ctx.saveChat()');await vi.waitFor(()=>expect(f.requests).toHaveLength(1))
  expect(f.requests[0]).toMatchObject({edits:[{message_id:1,data:{hp:2}}]});expect((f.requests[0] as unknown as {edits:unknown[]}).edits).toHaveLength(1)
  await expect(f.run('ctx.saveChat()')).rejects.toThrow(/仍在保存/)
  f.run('held.variables[0].hp=3')
  const next={...snapshot,scopes:{...snapshot.scopes,'["message",1]':{hp:2}},messages:snapshot.messages.map(row=>row.message_id===1?{...row,data:{hp:2}}:row)}
  f.reply(0,{ok:true,result:{branch:null,snapshot:next}});await saved
  expect(f.run('ctx.chat[1]===held')).toBe(true);expect(f.run('held.variables[0].hp')).toBe(3);expect(f.run('held.swipes_data[0].hp')).toBe(2)
  expect(f.run('SillyTavern.getContext().chat===ctx.chat')).toBe(true)
  const again=f.run('ctx.saveChat()');await vi.waitFor(()=>expect(f.requests).toHaveLength(2));expect(f.requests[1]).toMatchObject({edits:[{message_id:1,data:{hp:3}}],before:[{message_id:1,data:{hp:2}}]})
  f.reply(1,{ok:true,result:{branch:null,snapshot:{...next,scopes:{...next.scopes,'["message",1]':{hp:3}},messages:next.messages.map(row=>row.message_id===1?{...row,data:{hp:3}}:row)}}});await again
  expect(f.run('held.data.hp')).toBe(3);await f.run('ctx.saveChat()');expect(f.requests).toHaveLength(2)
})
it('新历史不重定位旧上下文草稿，刷新后保留待保存修改并明确失败',async()=>{
  const f=frame();f.run('var ctx=SillyTavern.getContext();ctx.chat[1].mes="draft"')
  const refreshed=f.run('refreshHelperSnapshot()');f.reply(0,{ok:true,snapshot:{...snapshot,historyRevision:'new-history'}});await refreshed
  expect(f.run('SillyTavern.getContext().chat[1].mes')).toBe('draft')
  await expect(f.run('ctx.saveChat()')).rejects.toThrow(/历史已改变/);await expect(f.run('ctx.swipe()')).rejects.toThrow(/历史已改变/)
  expect(f.requests).toHaveLength(1)
})
it('普通变量更新后干净上下文读取新值，旧上下文不能覆盖消息变化',async()=>{
  const f=frame();f.run('var old=SillyTavern.getContext();replaceVariables({hp:2},{type:"message",message_id:1})')
  const saved=f.run('flushHelperVariables()');f.reply(0,{ok:true,scopes:{...snapshot.scopes,'["message",1]':{hp:2}}});await saved
  expect(f.run('SillyTavern.getContext().chat[1].data')).toEqual({hp:2})
  f.run('old.chat[1].extra.tag="stale"');await expect(f.run('old.saveChat()')).rejects.toThrow(/已被修改/);expect(f.requests).toHaveLength(1)
})
it('旧接口非法选项、结构修改、矛盾页别名明确失败；正文分支回执保留旧页面草稿',async()=>{
  const f=frame();await expect(f.run('setChatMessage("body",1,{unknown:true})')).rejects.toThrow(/选项/)
  f.run('var ctx=SillyTavern.getContext();ctx.chat[1].variables[0].hp=1;ctx.chat[1].swipes_data[0].hp=2')
  await expect(f.run('ctx.saveChat()')).rejects.toThrow(/别名互相冲突/);expect(f.requests).toHaveLength(0)
  f.run('ctx.chat.pop()');await expect(f.run('ctx.saveChat()')).rejects.toThrow(/插入、删除或重排/)
  const g=frame();g.run('var ctx=SillyTavern.getContext();ctx.chat[1].mes="new body"');const edit=g.run('ctx.saveChat()')
  await vi.waitFor(()=>expect(g.requests).toHaveLength(1));expect(g.requests[0]).toMatchObject({edits:[{message_id:1,message:'new body'}]});g.run('window.__dshTavernSnapshotGeneration=10');g.reply(0,{ok:true,result:{branch:{childSessionId:'child',title:'context'}}});await edit
  expect(g.run('ctx.chat[1].mes')).toBe('new body')
})

it('deleteChatMessages 整批验证后经同一固定快照和分支回执协议执行，当前卡面也可删除',async()=>{
  const f=frame();await f.run('deleteChatMessages([])')
  for(const input of ['[1,-1]','[9]','[1.5]','["1"]'])await expect(f.run('deleteChatMessages('+input+')')).rejects.toThrow()
  await expect(f.run('setChatMessages([{message_id:1,delete:true}])')).rejects.toThrow(/已知消息字段/)
  expect(f.requests).toHaveLength(0)
  const deleted=f.run('TavernHelper.deleteChatMessages([0,-1],{refresh:"none"})');await vi.waitFor(()=>expect(f.requests).toHaveLength(1))
  expect(f.requests[0]).toMatchObject({action:'helperMessageEdit',storyId:'story-test',historyRevision:'history',edits:[{message_id:0,delete:true},{message_id:-1,delete:true}]})
  f.reply(0,{ok:true,result:{branch:{childSessionId:'deleted-child',title:'deleted'}}});await deleted
  expect(f.parent.postMessage).toHaveBeenCalledWith(expect.objectContaining({action:'helperMessageEditApplied'}),'*')
  await expect(f.run('deleteChatMessages([1])')).rejects.toThrow(/分支/)
})

it('较长聊天可一次删除超过普通编辑上限的消息，超出快照预算仍拒绝',async()=>{
  const initial={...snapshot,currentMessageId:99,messages:Array.from({length:100},(_,message_id)=>({...snapshot.messages[1]!,message_id,message:'message '+message_id}))}
  const f=frame(initial);await expect(f.run('deleteChatMessages(Array.from({length:4097},(_,i)=>i))')).rejects.toThrow(/4096/)
  const done=f.run('deleteChatMessages(Array.from({length:100},(_,i)=>i))');await vi.waitFor(()=>expect(f.requests).toHaveLength(1))
  expect((f.requests[0] as unknown as {edits:unknown[]}).edits).toHaveLength(100)
  f.reply(0,{ok:true,result:{branch:{childSessionId:'bulk-delete',title:'deleted'}}});await done
})

/** 刷新以真实父窗口回执为界；失败保留草稿，锁定期间写入必须在改动之前拒绝。 */
it('仅指定消息 id 可重绘，none 不发请求，刷新先等待变量保存并校验来源',async()=>{
  const f=frame();await f.run('setChatMessages([{message_id:1}],{refresh:"none"})');expect(f.parent.postMessage.mock.calls.some(([value])=>value.action==='helperDisplayRefresh')).toBe(false)
  f.run('replaceVariables({n:8})');const refreshed=f.run('refreshOneMessage(1)')
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1))
  expect(f.parent.postMessage.mock.calls.some(([value])=>value.action==='helperDisplayRefresh')).toBe(false)
  f.reply(0,{ok:true,scopes:{'["chat",""]':{n:8}}})
  await vi.waitFor(()=>expect(f.parent.postMessage.mock.calls.some(([value])=>value.action==='helperDisplayRefresh')).toBe(true))
  const request=f.parent.postMessage.mock.calls.find(([value])=>value.action==='helperDisplayRefresh')![0]
  expect(request).toMatchObject({storyId:snapshot.storyId,historyRevision:'history',ids:[1]})
  f.send({action:'helperDisplayResult',requestId:request.requestId,ok:true},{})
  expect(f.parent.postMessage.mock.calls.some(([value])=>value.action==='helperDisplayApplied')).toBe(false)
  f.send({action:'helperDisplayResult',requestId:request.requestId,ok:true});await refreshed
  expect(f.parent.postMessage.mock.calls.some(([value])=>value.action==='helperDisplayApplied')).toBe(true)
  await expect(f.run('refreshOneMessage(-1)')).rejects.toThrow(/序号/)
  await expect(f.run('refreshOneMessage(1,{})')).rejects.toThrow(/DOM/)
})
it('元数据写回后遵守 all 重绘，失败不撤销已保存数据也不伪装刷新成功',async()=>{
  const f=frame(),done=f.run('setChatMessages([{message_id:-1,data:{hp:9}}],{refresh:"all"})')
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1));f.reply(0,{ok:true,result:{branch:null,snapshot:{...snapshot,scopes:{...snapshot.scopes,'["message",1]':{hp:9}}}}})
  await vi.waitFor(()=>expect(f.parent.postMessage.mock.calls.some(([value])=>value.action==='helperDisplayRefresh')).toBe(true))
  const request=f.parent.postMessage.mock.calls.find(([value])=>value.action==='helperDisplayRefresh')![0];expect(request.ids).toBeNull()
  f.send({action:'helperDisplayResult',requestId:request.requestId,ok:false,error:'另一卡面未保存'});await expect(done).rejects.toThrow(/未保存/)
  expect(f.run('getChatMessages(1)[0].data')).toEqual({hp:9})
})
it('重绘准备锁保护变量和上下文草稿，取消后恢复写入，伪造或陈旧请求不能加锁',async()=>{
  const f=frame(),guard={action:'helperDisplayGuard',requestId:'guard',storyId:snapshot.storyId,historyRevision:'history'}
  f.send(guard,{});expect(f.run('Boolean(window.__dshTavernDisplayLocked)')).toBe(false)
  f.send({...guard,historyRevision:'old'});expect(f.run('Boolean(window.__dshTavernDisplayLocked)')).toBe(false)
  f.reply(0,{ok:true,snapshot});await vi.waitFor(()=>expect(f.parent.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({action:'helperDisplayGuardResult',ok:false}))
  f.send(guard);expect(f.run('Boolean(window.__dshTavernDisplayLocked)')).toBe(true)
  expect(()=>f.run('replaceVariables({n:99})')).toThrow(/重绘/);expect(f.run('getVariables()')).toEqual({n:0})
  await expect(f.run('setChatMessages([{message_id:1,data:{hp:2}}])')).rejects.toThrow(/重绘/)
  f.send({action:'helperDisplayUnlock',requestId:'other'});expect(f.run('Boolean(window.__dshTavernDisplayLocked)')).toBe(true)
  f.send({action:'helperDisplayUnlock',requestId:'guard'});expect(f.run('Boolean(window.__dshTavernDisplayLocked)')).toBe(false)
  f.run('SillyTavern.getContext().chat[1].message="草稿"')
  f.send({...guard,requestId:'draft'});expect(f.run('Boolean(window.__dshTavernDisplayLocked)')).toBe(false)
  expect(f.parent.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({ok:false,error:expect.stringContaining('草稿')})
})

it('宿主事件准备等候已在保存的变量，再读取最新历史；冲突时保留草稿并拒绝监听',async()=>{
  const f=frame();f.run('replaceVariables({n:1});flushHelperVariables()');const prepared=f.run('__dshTavernPrepareHostEvent()')
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1));f.reply(0,{ok:true,scopes:{'["chat",""]':{n:1}}})
  await vi.waitFor(()=>expect(f.requests).toHaveLength(2));expect(f.requests[1]?.action).toBe('helperSnapshotGet')
  const next={...snapshot,historyRevision:'latest',scopes:{'["chat",""]':{n:1},'["message",2]':{hp:9}},messages:[...snapshot.messages,{message_id:2,name:'灯塔',role:'assistant' as const,is_hidden:false,message:'新回复',data:{hp:9},extra:{}}]}
  f.reply(1,{ok:true,snapshot:next});await prepared;expect(f.run('getLastMessageId()')).toBe(2);expect(f.run('getVariables({type:"message"})')).toEqual({hp:9})
  f.run('replaceVariables({n:3})');const saved=f.run('flushHelperVariables()'),assertion=expect(saved).rejects.toThrow('conflict');f.reply(2,{ok:false,error:'conflict'});await assertion
  await expect(f.run('__dshTavernPrepareHostEvent()')).rejects.toThrow('conflict');expect(f.run('getVariables()')).toEqual({n:3});expect(f.requests).toHaveLength(3)
})

/** 新消息不会重建旧沙箱；可信重绘准备只在无草稿时同步历史，并对迟到/冲突回执保持可撤销。 */
it('旧卡面准备重绘先读取新快照，更新变量与消息后才加锁',async()=>{
  const f=frame(),guard={action:'helperDisplayGuard',requestId:'new-history',storyId:snapshot.storyId,historyRevision:'next'}
  f.send(guard,{})
  f.send({...guard,storyId:'other'})
  expect(f.requests).toHaveLength(0)
  f.send(guard)
  expect(f.requests[0]?.action).toBe('helperSnapshotGet')
  expect(f.run('Boolean(window.__dshTavernDisplayLocked)')).toBe(false)
  await expect(f.run('refreshOneMessage(1)')).rejects.toThrow(/刷新仍在进行/)
  const next={...snapshot,historyRevision:'next',scopes:{'["chat",""]':{n:9}},messages:[...snapshot.messages,{message_id:2,name:'灯塔',role:'assistant' as const,is_hidden:false,message:'新回复',data:{},extra:{}}]}
  f.reply(0,{ok:true,snapshot:next})
  await vi.waitFor(()=>expect(f.parent.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({action:'helperDisplayGuardResult',requestId:'new-history',ok:true}))
  expect(f.run('getLastMessageId()')).toBe(2)
  expect(f.run('getVariables()')).toEqual({n:9})
  expect(f.run('Boolean(window.__dshTavernDisplayLocked)')).toBe(true)
  f.send({action:'helperDisplayUnlock',requestId:'new-history'})
  expect(f.run('Boolean(window.__dshTavernDisplayLocked)')).toBe(false)
})
it('旧卡刷新期间新增变量或上下文草稿时拒绝加锁，原草稿保留',async()=>{
  for(const kind of ['variables','chat']){
    const f=frame(),requestId='raced-'+kind
    f.send({action:'helperDisplayGuard',requestId,storyId:snapshot.storyId,historyRevision:'next'})
    expect(f.requests[0]?.action).toBe('helperSnapshotGet')
    f.run(kind==='variables'?'replaceVariables({n:7})':'SillyTavern.getContext().chat[1].message="新草稿"')
    f.reply(0,{ok:true,snapshot:{...snapshot,historyRevision:'next'}})
    await vi.waitFor(()=>expect(f.parent.postMessage.mock.calls.some(([value])=>value.action==='helperDisplayGuardResult'&&value.requestId===requestId&&value.ok===false)).toBe(true))
    expect(f.run('Boolean(window.__dshTavernDisplayLocked)')).toBe(false)
    expect(f.run(kind==='variables'?'getVariables().n':'SillyTavern.getContext().chat[1].message')).toBe(kind==='variables'?7:'新草稿')
  }
})
it('旧卡准备被宿主取消或收到另一剧情时不能迟到加锁，原有草稿不触发刷新',async()=>{
  const canceled=frame(),guard={action:'helperDisplayGuard',requestId:'late',storyId:snapshot.storyId,historyRevision:'next'}
  canceled.send(guard)
  canceled.send({action:'helperDisplayUnlock',requestId:'late'})
  canceled.reply(0,{ok:true,snapshot:{...snapshot,historyRevision:'next'}})
  await vi.waitFor(()=>expect(canceled.run('window.__dshTavernSnapshot.historyRevision')).toBe('next'))
  expect(canceled.run('Boolean(window.__dshTavernDisplayLocked)')).toBe(false)
  expect(canceled.parent.postMessage.mock.calls.some(([value])=>value.action==='helperDisplayGuardResult'&&value.ok===true)).toBe(false)
  const rebound=frame();rebound.send(guard);rebound.reply(0,{ok:true,snapshot:{...snapshot,storyId:'other',historyRevision:'next'}})
  await vi.waitFor(()=>expect(rebound.parent.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({action:'helperDisplayGuardResult',ok:false}))
  expect(rebound.run('window.__dshTavernSnapshot.storyId')).toBe(snapshot.storyId)
  const dirty=frame();dirty.run('SillyTavern.getContext().chat[1].message="已有草稿"');dirty.send(guard)
  expect(dirty.requests).toHaveLength(0)
  expect(dirty.parent.postMessage.mock.calls.at(-1)?.[0]).toMatchObject({action:'helperDisplayGuardResult',ok:false,error:expect.stringContaining('草稿')})
})

/** 卡面刷新订阅必须在真实变化时通知，不能由重复读取制造刷新循环。 */
it('相同快照不重复发送刷新事件，变量或历史变化仍通知',async()=>{
  const f=frame()
  f.run("var refreshEvents=0;eventOn('dsh_helper_snapshot_refreshed',()=>refreshEvents++)")
  const read=async(next:HelperSnapshot)=>{
    const task=f.run('refreshHelperSnapshot()')
    f.reply(f.requests.length-1,{ok:true,snapshot:next});await task
  }
  await read(snapshot)
  expect(f.run('refreshEvents')).toBe(0)
  const changed={...snapshot,scopes:{'["chat",""]':{n:1}}}
  await read(changed)
  expect(f.run('refreshEvents')).toBe(1)
  await read(changed)
  expect(f.run('refreshEvents')).toBe(1)
  await read({...changed,historyRevision:'next-history'})
  expect(f.run('refreshEvents')).toBe(2)
})
