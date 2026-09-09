/** 世界书接口真实注入源码测试：异步回执、并发版本、RegExp 键转码与本地 updater 生命周期。 */
import {createContext,runInContext} from 'node:vm'
import {webcrypto} from 'node:crypto'
import {afterEach,expect,it,vi} from 'vitest'
import {tavernCardBridgeScript} from '../src/core/cardFrame.js'
import {helperWorldbookSettingsCodec} from '../src/core/helperWorldbookSettings.js'
import {DEFAULT_WI_SETTINGS} from '../src/core/types.js'
import {parseHelperWorldbook} from '../src/core/helperWorldbook.js'
const cleanups:(()=>void)[]=[]
afterEach(()=>{for(const fn of cleanups.splice(0))fn()})
const entries=parseHelperWorldbook([{uid:3,name:'条目',content:'原文'}])
function frame(worldbooks:Record<string,unknown>={}){
  const requests:Record<string,unknown>[]=[],listeners=new Set<(event:unknown)=>void>(),parent={postMessage:(value:Record<string,unknown>)=>{if(String(value.action).startsWith('helperWorldbook'))requests.push(JSON.parse(JSON.stringify(value)))}}
  const scope:Record<string,unknown>={parent,TextEncoder,crypto:webcrypto,queueMicrotask,setTimeout,clearTimeout,document:{readyState:'loading',body:null,addEventListener:vi.fn(),removeEventListener:vi.fn(),open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null},addEventListener:(name:string,fn:(event:unknown)=>void)=>{if(name==='message')listeners.add(fn)},removeEventListener:(name:string,fn:(event:unknown)=>void)=>{if(name==='message')listeners.delete(fn)}}
  scope.window=scope;const context=createContext(scope),run=(code:string)=>runInContext(code,context)
  const source=tavernCardBridgeScript({greetings:[],greetingIndex:0,worldbooks:{settings:helperWorldbookSettingsCodec.fromNative(DEFAULT_WI_SETTINGS,['book']),storyId:'story',bindingRevision:'binding',names:['book'],global:['book'],characterName:'角色',character:{primary:null,additional:[]},chat:null,...worldbooks}}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'')
  run(source)
  const reply=(index:number,result:unknown,from:unknown=parent)=>{for(const fn of listeners)fn({source:from,data:{source:'dsh-tavern-card',action:'helperWorldbookResult',requestId:requests[index]!.requestId,ok:true,result}})}
  const cleanup=()=>run('window.__dshTavernBridgeCleanup()');cleanups.push(cleanup)
  const replyBinding=(index:number,context:unknown)=>{for(const fn of listeners)fn({source:parent,data:{source:'dsh-tavern-card',action:'helperWorldbookBindResult',requestId:requests[index]!.requestId,ok:true,context}})}
  const failBinding=(index:number,error:string)=>{for(const fn of listeners)fn({source:parent,data:{source:'dsh-tavern-card',action:'helperWorldbookBindResult',requestId:requests[index]!.requestId,ok:false,error}})}
  const replyContext=(index:number,context:unknown)=>{for(const fn of listeners)fn({source:parent,data:{source:'dsh-tavern-card',action:'helperWorldbookContextResult',requestId:requests[index]!.requestId,ok:true,context}})}
  return {run,requests,reply,replyBinding,failBinding,replyContext,cleanup}
}
it('目录同步可读，条目读取为 Promise，更新等待持久回执且 RegExp 键以字符串传输',async()=>{
  const f=frame();expect(f.run('getWorldbookNames()')).toEqual(['book'])
  const update=f.run('updateWorldbookWith("book",entries=>{entries[0].content="new";entries[0].strategy.keys=[/door/i];return entries})')
  expect(f.requests[0]).toMatchObject({name:'book',operation:'get'})
  f.reply(0,{snapshot:{name:'book',revision:'r0',entries}})
  await vi.waitFor(()=>expect(f.requests).toHaveLength(2))
  expect(f.requests[1]).toMatchObject({operation:'replace',revision:'r0',entries:[{content:'new',strategy:{keys:['/door/i']}}]})
  f.reply(1,{snapshot:{name:'book',revision:'r1',entries:f.requests[1]!.entries}})
  expect((await update)[0].content).toBe('new')
})
it('并发读取不会给旧 updater 换上新修订，绑定刷新与关闭后不发送过期更新',async()=>{
  const f=frame();const update=f.run('var finish; updateWorldbookWith("book",async entries=>{await new Promise(r=>finish=r);entries[0].content="draft";return entries})')
  f.reply(0,{snapshot:{name:'book',revision:'old',entries}})
  const read=f.run('getWorldbook("book")');f.reply(1,{snapshot:{name:'book',revision:'new',entries:parseHelperWorldbook([{uid:3,content:'newer'}])}})
  await read;await vi.waitFor(()=>expect(f.run('typeof finish')).toBe('function'))
  f.run('finish()');await vi.waitFor(()=>expect(f.requests).toHaveLength(3))
  expect(f.requests[2]).toMatchObject({revision:'old',entries:[{content:'draft'}]})
  f.reply(2,{snapshot:{name:'book',revision:'done',entries:f.requests[2]!.entries}});await update
  const pending=f.run('var later;updateWorldbookWith("book",async entries=>{await new Promise(r=>later=r);return entries})')
  f.reply(3,{snapshot:{name:'book',revision:'done',entries}});await vi.waitFor(()=>expect(f.run('typeof later')).toBe('function'))
  f.cleanup();f.run('later()');await expect(pending).rejects.toThrow(/已改变/)
  expect(f.requests).toHaveLength(4)
})
it('批量创建分配不冲突 UID，删除 predicate 仅在沙箱执行，返回新增/删除条目',async()=>{
  const f=frame(),created=f.run('createWorldbookEntries("book",[{name:"new"}])')
  f.reply(0,{snapshot:{name:'book',revision:'r0',entries}});await vi.waitFor(()=>expect(f.requests).toHaveLength(2))
  const saved=parseHelperWorldbook(f.requests[1]!.entries);expect(new Set(saved.map(entry=>entry.uid)).size).toBe(2)
  f.reply(1,{snapshot:{name:'book',revision:'r1',entries:saved}});expect((await created).new_entries[0].name).toBe('new')
  const deleted=f.run('deleteWorldbookEntries("book",entry=>entry.name==="new")')
  f.reply(2,{snapshot:{name:'book',revision:'r1',entries:saved}});await vi.waitFor(()=>expect(f.requests).toHaveLength(4))
  f.reply(3,{snapshot:{name:'book',revision:'r2',entries}});expect((await deleted).deleted_entries[0].name).toBe('new')
})
it('没有条目时明确报错，非 JSON 与访问器不会被静默写成空数据，外来窗口回执无效',async()=>{
  const f=frame(),missing=f.run('getWorldbook("missing")');f.reply(0,{missing:true});await expect(missing).rejects.toThrow(/不存在/)
  const read=f.run('getWorldbook("book")');f.reply(1,{snapshot:{name:'book',revision:'forged',entries:[]}},{});f.reply(1,{snapshot:{name:'book',revision:'r0',entries}});await read
  await expect(f.run('replaceWorldbook("book",[{get content(){throw Error("不可求值")}}])')).rejects.toThrow(/访问器/)
  await expect(f.run('replaceWorldbook("book",[{extra:{bad:()=>{}}}])')).rejects.toThrow(/JSON/)
  await expect(f.run('replaceWorldbook("book",Object.assign(new Array(1),{extra:1}))')).rejects.toThrow(/数组/)
  expect(f.requests).toHaveLength(2)
})

it('删除公共世界书后同步清理角色附加绑定，后续部分绑定不再带已删除名称',async()=>{
  const f=frame({names:['book','extra'],global:['book','extra'],character:{primary:'book',additional:['extra']}})
  const deleted=f.run('deleteWorldbook("extra")');f.reply(0,{snapshot:{name:'extra',revision:'r0',entries:[]}})
  await vi.waitFor(()=>expect(f.requests).toHaveLength(2));f.reply(1,{deleted:true});expect(await deleted).toBe(true)
  expect(f.run('getWorldbookNames()')).toEqual(['book']);expect(f.run('getGlobalWorldbookNames()')).toEqual(['book'])
  expect(f.run('getCharWorldbookNames("current")')).toEqual({primary:'book',additional:[]})
  const binding=f.run('setCurrentCharLorebooks({primary:null})');await vi.waitFor(()=>expect(f.requests).toHaveLength(3))
  expect(f.requests[2]).toMatchObject({kind:'character',selection:{primary:null,additional:[]}})
  f.replyBinding(2,bindingContext({character:{primary:null,additional:[]}}));await binding
})

it('旧 lorebook 查询和按 UID 局部更新走同一版本桥，保留现代额外字段并等待保存',async()=>{
  const f=frame();expect(f.run('getLorebooks()')).toEqual(['book']);expect(f.run('getCharLorebooks({type:"primary"})')).toEqual({primary:null,additional:[]})
  const before=parseHelperWorldbook([{uid:3,name:'原名',content:'原文',extra:{ignoreBudget:true,custom:'保留'}},{uid:7,content:'另一条'}])
  const update=f.run('setLorebookEntries("book",[{uid:3,content:"旧接口已改",use_group_scoring:true}])')
  f.reply(0,{snapshot:{name:'book',revision:'old',entries:before}});await vi.waitFor(()=>expect(f.requests).toHaveLength(2))
  expect(f.requests[1]).toMatchObject({revision:'old',entries:[{uid:3,name:'原名',content:'旧接口已改',extra:{ignoreBudget:true,custom:'保留',useGroupScoring:true}},{uid:7,content:'另一条'}]})
  const saved=parseHelperWorldbook(f.requests[1]!.entries);f.reply(1,{snapshot:{name:'book',revision:'new',entries:saved}})
  expect((await update)[0]).toMatchObject({uid:3,comment:'原名',content:'旧接口已改',use_group_scoring:true})
})
it('旧接口批量创建和删除返回旧版结果形状，UID 由真实保存结果决定',async()=>{
  const f=frame(),create=f.run('createLorebookEntries("book",[{comment:"新增",content:"新文"}])')
  f.reply(0,{snapshot:{name:'book',revision:'r0',entries}});await vi.waitFor(()=>expect(f.requests).toHaveLength(2))
  const saved=parseHelperWorldbook(f.requests[1]!.entries),id=saved.find(entry=>entry.name==='新增')!.uid
  f.reply(1,{snapshot:{name:'book',revision:'r1',entries:saved}});expect(await create).toMatchObject({new_uids:[id],entries:[{uid:3},{uid:id,comment:'新增'}]})
  const remove=f.run('deleteLorebookEntries("book",['+id+'])');f.reply(2,{snapshot:{name:'book',revision:'r1',entries:saved}});await vi.waitFor(()=>expect(f.requests).toHaveLength(4))
  f.reply(3,{snapshot:{name:'book',revision:'r2',entries}});expect(await remove).toMatchObject({delete_occurred:true,entries:[{uid:3}]})
})
it('旧异步 updater 关闭后不能写回，整批局部更新的坏 UID 不能造成部分保存',async()=>{
  const f=frame(),bad=f.run('setLorebookEntries("book",[{uid:3,content:"不能写"},{uid:99,content:"不存在"}])')
  f.reply(0,{snapshot:{name:'book',revision:'r0',entries}});await expect(bad).rejects.toThrow(/不存在/);expect(f.requests).toHaveLength(1)
  const update=f.run('var done;updateLorebookEntriesWith("book",async rows=>{await new Promise(r=>done=r);rows[0].content="late";return rows})')
  f.reply(1,{snapshot:{name:'book',revision:'r0',entries}});await vi.waitFor(()=>expect(f.run('typeof done')).toBe('function'))
  f.cleanup();f.run('done()');await expect(update).rejects.toThrow(/已改变/);expect(f.requests).toHaveLength(2)
})

const bindingContext=(patch:Record<string,unknown>)=>({settings:helperWorldbookSettingsCodec.fromNative(DEFAULT_WI_SETTINGS,['book']),storyId:'story',bindingRevision:'next',names:['book'],global:['book'],characterName:'角色',character:{primary:null,additional:[]},chat:null,...patch})
it('绑定请求串行使用最新令牌，旧部分角色绑定在执行时合并，不覆盖前一次已保存字段',async()=>{
  const f=frame(),all=f.run('Promise.all([rebindGlobalWorldbooks(["global"]),setCurrentCharLorebooks({primary:"primary"}),setCurrentCharLorebooks({additional:["extra"]})])')
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1));expect(f.requests[0]).toMatchObject({action:'helperWorldbookBind',kind:'global',bindingRevision:'binding',selection:['global']})
  f.replyBinding(0,bindingContext({bindingRevision:'r1',global:['global']}))
  await vi.waitFor(()=>expect(f.requests).toHaveLength(2));expect(f.requests[1]).toMatchObject({bindingRevision:'r1',kind:'character',selection:{primary:'primary',additional:[]}})
  f.replyBinding(1,bindingContext({bindingRevision:'r2',global:['global'],character:{primary:'primary',additional:[]}}))
  await vi.waitFor(()=>expect(f.requests).toHaveLength(3));expect(f.requests[2]).toMatchObject({bindingRevision:'r2',selection:{primary:'primary',additional:['extra']}})
  f.replyBinding(2,bindingContext({bindingRevision:'r3',global:['global'],character:{primary:'primary',additional:['extra']}}));await all
  expect(f.run('getCharWorldbookNames("current")')).toEqual({primary:'primary',additional:['extra']})
})
it('世界书绑定改变后拒绝仍在等待的旧 updater，查询使用保存回执的剧情书标识',async()=>{
  const f=frame(),update=f.run('var continueUpdate;updateWorldbookWith("book",async entries=>{await new Promise(r=>continueUpdate=r);return entries})')
  f.reply(0,{snapshot:{name:'book',revision:'r0',entries}});await vi.waitFor(()=>expect(f.run('typeof continueUpdate')).toBe('function'))
  const binding=f.run('rebindChatWorldbook("current","other")');await vi.waitFor(()=>expect(f.requests).toHaveLength(2))
  f.replyBinding(1,bindingContext({chat:'@dsh/chat/source-other'}));await binding
  f.run('continueUpdate()');await expect(update).rejects.toThrow(/已改变/)
  expect(f.run('getChatLorebook()')).toBe('@dsh/chat/source-other');expect(f.requests).toHaveLength(2)
})
it('新旧获取或创建聊天书都走绑定回执，返回真实私有标识而不是固定主书',async()=>{
  const f=frame(),create=f.run('getOrCreateChatLorebook("我的书")');await vi.waitFor(()=>expect(f.requests).toHaveLength(1))
  expect(f.requests[0]).toMatchObject({action:'helperWorldbookBind',kind:'ensure-chat',selection:'我的书'})
  f.replyBinding(0,bindingContext({chat:'@dsh/chat/book-new',names:['book','@dsh/chat/book-new']}))
  expect(await create).toBe('@dsh/chat/book-new');expect(f.run('getWorldbookNames()')).toContain('@dsh/chat/book-new')
})

it('旧设置同步更新快照并串行保存，等待回执后才清空未保存标记',async()=>{
  const f=frame();expect(f.run('getLorebookSettings().scan_depth')).toBe(2)
  expect(f.run('setLorebookSettings({scan_depth:4});setLorebookSettings({min_activations:2})')).toBeUndefined()
  expect(f.run('getLorebookSettings()')).toMatchObject({scan_depth:4,min_activations:2})
  const flush=f.run('flushHelperWorldbookSettings()');await vi.waitFor(()=>expect(f.requests).toHaveLength(1))
  expect(f.requests[0]).toMatchObject({kind:'settings',selection:{scan_depth:4},bindingRevision:'binding'})
  f.replyBinding(0,bindingContext({bindingRevision:'r1',settings:helperWorldbookSettingsCodec.fromNative({...DEFAULT_WI_SETTINGS,scanDepth:4},['book'])}))
  await vi.waitFor(()=>expect(f.requests).toHaveLength(2));expect(f.requests[1]).toMatchObject({kind:'settings',selection:{min_activations:2},bindingRevision:'r1'})
  expect(f.run('getLorebookSettings().min_activations')).toBe(2)
  f.replyBinding(1,bindingContext({bindingRevision:'r2',settings:helperWorldbookSettingsCodec.fromNative({...DEFAULT_WI_SETTINGS,scanDepth:4,minActivations:2},['book'])}));await flush
  expect(f.run('getHelperWorldbookSettingsStatus()')).toEqual({pending:0,unsaved:0,error:null})
  f.run('getLorebookSettings().scan_depth=99');expect(f.run('getLorebookSettings().scan_depth')).toBe(4)
})
it('设置失败保留草稿、阻止后续排队覆盖；刷新必须明确放弃，关闭后不能继续保存',async()=>{
  const f=frame();f.run('setLorebookSettings({scan_depth:4});setLorebookSettings({min_activations:3})')
  const flush=f.run('flushHelperWorldbookSettings()');const failed=expect(flush).rejects.toThrow(/conflict/)
  await vi.waitFor(()=>expect(f.requests).toHaveLength(1));f.failBinding(0,'conflict');await failed
  expect(f.requests).toHaveLength(1);expect(f.run('getLorebookSettings()')).toMatchObject({scan_depth:4,min_activations:3})
  expect(f.run('getHelperWorldbookSettingsStatus()')).toEqual({pending:0,unsaved:2,error:'conflict'})
  await expect(f.run('refreshHelperWorldbooks()')).rejects.toThrow(/未保存/)
  const refresh=f.run('refreshHelperWorldbooks({discardUnsaved:true})');expect(()=>f.run('setLorebookSettings({scan_depth:7})')).toThrow(/刷新/);f.replyContext(1,bindingContext({bindingRevision:'r1'}));await refresh
  expect(f.run('getLorebookSettings().scan_depth')).toBe(2)
  expect(()=>f.run('setLorebookSettings({scan_depth:-1})')).toThrow(/越界/)
  f.cleanup();expect(()=>f.run('setLorebookSettings({scan_depth:3})')).toThrow(/关闭/)
})
