/** MVU 注入脚本与真实事件路由集成：同步快照、跨卡面可变钩子、保存回执、失败原子性和关闭清理。 */
import {createContext,runInContext} from 'node:vm'
import {webcrypto} from 'node:crypto'
import {mkdtemp,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import type {Context} from '@deepseek-ai/cordis'
import type {SessionEvent} from '@deepseek-ai/dsh-session'
import {createAssistantMessage} from '@deepseek-ai/dsh-llm'
import {afterEach,expect,it,vi} from 'vitest'
import {tavernCardBridgeScript} from '../src/core/cardFrame.js'
import {attachHelperEvents} from '../src/client/helperEventRouter.js'
import type {HelperSnapshot} from '../src/core/helperRuntime.js'
import {TavernState} from '../src/node/state.js'
import {resolveConfig} from '../src/node/config.js'
import {getHelperSnapshot,commitHelperVariables} from '../src/node/helperRuntime.js'
import {HELPER_STATE_PATH} from '../src/state/helper.js'

const snapshot:HelperSnapshot={storyId:'mvu-story',historyRevision:'mvu-history',currentMessageId:0,writable:true,scopes:{},
  messages:[{message_id:0,role:'assistant',name:'工厂角色',message:'出发',data:{},extra:{},is_hidden:false}]}
const cleanups:(()=>void)[]=[]
afterEach(()=>{for(const stop of cleanups.splice(0))stop()})
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve))
function frame(input=snapshot){
  const listeners=new Set<(event:unknown)=>void>(),requests:Record<string,unknown>[]=[],posts:Record<string,unknown>[]=[]
  const send=(data:Record<string,unknown>)=>{for(const listener of listeners)listener({source:parent,data:structuredClone(data)})}
  const endpoint=attachHelperEvents('mvu-session',input.storyId,message=>queueMicrotask(()=>send(message)))
  const parent={postMessage:(message:Record<string,unknown>)=>{
    const cloned=structuredClone(message);posts.push(cloned)
    if(message.action==='helperVariablesCommit')requests.push(cloned)
    else queueMicrotask(()=>endpoint.receive(cloned))
  }}
  const scope:Record<string,unknown>={parent,TextEncoder,crypto:webcrypto,queueMicrotask,setTimeout,clearTimeout,
    document:{readyState:'loading',body:null,addEventListener:vi.fn(),removeEventListener:vi.fn(),
      open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null},
    addEventListener:(name:string,listener:(event:unknown)=>void)=>{if(name==='message')listeners.add(listener)},
    removeEventListener:(_name:string,listener:(event:unknown)=>void)=>listeners.delete(listener),
  }
  scope.window=scope
  const context=createContext(scope),run=(text:string)=>runInContext(text,context)
  run(tavernCardBridgeScript({greetings:[],greetingIndex:0,helperSnapshot:input}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''))
  let closed=false
  const close=()=>{if(closed)return;closed=true;run('__dshTavernBridgeCleanup()');endpoint.dispose()}
  cleanups.push(close)
  const reply=(index:number,extra:Record<string,unknown>)=>send({source:'dsh-tavern-card',action:'helperVariablesResult',requestId:requests[index]!.requestId,...extra})
  return{run,requests,posts,reply,close,send}
}

it('每个沙箱内置同步 Mvu 读取，无命令解析返回独立副本且不发保存请求',async()=>{
  const f=frame({...snapshot,scopes:{'["chat",""]':{initialized_lorebooks:{},stat_data:{hp:10}}}})
  expect(await f.run('waitGlobalInitialized("Mvu").then(value=>value===Mvu)')).toBe(true)
  expect(f.run('Mvu.getMvuData().stat_data.hp')).toBe(10)
  expect(f.run('Mvu.getMvuData() instanceof Promise')).toBe(false)
  expect(f.run('Mvu.isDuringExtraAnalysis()')).toBe(false)
  f.run('window.before=Mvu.getMvuData()')
  const result=await f.run('Mvu.parseMessage("普通正文",before)')
  expect(result).toMatchObject({stat_data:{hp:10},display_data:{hp:10},delta_data:{}})
  expect(f.run('before')).toEqual({initialized_lorebooks:{},stat_data:{hp:10}})
  expect(f.requests).toEqual([])
  await expect(f.run('waitGlobalInitialized("UnknownFramework")')).rejects.toThrow(/尚未适配/)
})

it('跨卡面等待命令修订与结束钳制，保留原值并只在显式保存得到回执后结束',async()=>{
  const a=frame(),b=frame()
  a.run('window.before={initialized_lorebooks:{},stat_data:{hp:10,flag:false}}')
  b.run('window.seen=[];eventOn(Mvu.events.VARIABLE_UPDATE_STARTED,d=>{seen.push("start");d.stat_data.hp=20;d.stat_data.flag=true});eventOn(Mvu.events.COMMAND_PARSED,async(d,c,text)=>{await Promise.resolve();seen.push(text);c[0].args[1]="5"});eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,(d,old)=>{seen.push(old.stat_data.hp);d.stat_data.hp=Math.min(23,d.stat_data.hp)})')
  const result=await a.run('Mvu.parseMessage("_.add(\'hp\',1);",before).then(d=>window.result=d)')
  expect(result).toMatchObject({stat_data:{hp:23,flag:true},display_data:{flag:false}})
  expect(b.run('seen')).toEqual(['start',"_.add('hp',1);",10])
  expect(a.run('before.stat_data.hp')).toBe(10);expect(a.requests).toEqual([])
  let acknowledged=false
  const saved=a.run('Mvu.replaceMvuData(result,{type:"message",message_id:0})').then(()=>{acknowledged=true})
  await settle()
  expect(a.run('Mvu.getMvuData({type:"message",message_id:0}).stat_data.hp')).toBe(23)
  expect(acknowledged).toBe(false)
  expect(a.requests[0]).toMatchObject({changes:[{key:'["message",0]',before:{},value:result}]})
  a.reply(0,{ok:true,scopes:{'["message",0]':result}});await saved
  expect(acknowledged).toBe(true)
  expect(a.posts.some(post=>post.action==='helperMessageEdit')).toBe(false)
})

it('Zod 阶段可消费命令并清理旧显示字段，schema 回调始终留在提供方',async()=>{
  const a=frame(),b=frame()
  b.run('window.trace=[];eventOn("mag_command_parsed_for_zod",(d,c)=>{trace.push("parse");d.stat_data.hp=42;c.splice(0,c.length)});eventOn("mag_command_parsed_ended_for_zod",()=>trace.push("parsed"));eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,d=>{trace.push("end");d.stat_data.hp--});eventOn("mag_variable_update_ended_for_zod",d=>{trace.push("schema");d.schema="没有用别管这个";delete d.display_data;delete d.delta_data})')
  const result=await a.run('Mvu.parseMessage("_.add(\'hp\',1);",{initialized_lorebooks:{},stat_data:{hp:1},schema:{type:"object"}})')
  expect(result).toEqual({initialized_lorebooks:{},stat_data:{hp:41},schema:'没有用别管这个'})
  expect(b.run('trace')).toEqual(['parse','parsed','end','schema'])
  expect(a.requests).toEqual([])
})

it('经典 schema 未经扩展消费则明确失败，监听错误与非法参数都不改变旧表或落盘',async()=>{
  const a=frame(),b=frame()
  a.run('window.before={stat_data:{hp:10},schema:{type:"object",properties:{hp:{type:"number"}}}}')
  await expect(a.run('Mvu.parseMessage("_.add(\'hp\',1);",before)')).rejects.toThrow(/classic schema/)
  b.run('eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,d=>{d.stat_data.hp=999;throw Error("schema refused")})')
  await expect(a.run('Mvu.parseMessage("_.add(\'hp\',1);",{stat_data:{hp:10}})')).rejects.toThrow('schema refused')
  await expect(a.run('Mvu.parseMessage('+JSON.stringify("_.set('hp',(()=>{throw Error('executed')})());")+',{stat_data:{hp:10}})')).rejects.toThrow()
  expect(a.run('before.stat_data.hp')).toBe(10);expect(a.requests).toEqual([])
})

it('无命令也校验结束钩子的 schema 和元数据，临时内部数据在持久提交前拒绝',async()=>{
  const a=frame(),b=frame()
  b.run('eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,d=>d.stat_data.$meta={extensible:true})')
  await expect(a.run('Mvu.parseMessage("",{stat_data:{hp:1}})')).rejects.toThrow(/元数据/)
  b.run('eventClearEvent(Mvu.events.VARIABLE_UPDATE_ENDED);eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,d=>d.schema="unknown")')
  await expect(a.run('Mvu.parseMessage("",{stat_data:{hp:1}})')).rejects.toThrow(/schema/)
  await expect(a.run('Mvu.replaceMvuData({stat_data:{$internal:{},hp:1}})')).rejects.toThrow(/internal/)
  expect(a.run('Mvu.getMvuData()')).toEqual({});expect(a.requests).toEqual([])
})

it('持久提交失败不会虚报完成，保留本地数据供备份，关闭后旧接口和挂起解析失效',async()=>{
  const a=frame(),b=frame()
  const saved=a.run('Mvu.replaceMvuData({stat_data:{hp:5}})')
  const failed=expect(saved).rejects.toThrow('工厂 WAL 故障')
  await settle();a.reply(0,{ok:false,error:'工厂 WAL 故障'});await failed
  expect(a.run('Mvu.getMvuData().stat_data.hp')).toBe(5)
  expect(a.run('getHelperPersistenceStatus()')).toBe('error')
  b.run('eventOn(Mvu.events.VARIABLE_UPDATE_STARTED,()=>new Promise(resolve=>window.resume=resolve))')
  const parsed=a.run('window.oldMvu=Mvu;Mvu.parseMessage("",{stat_data:{hp:1}})')
  const rejected=expect(parsed).rejects.toThrow(/关闭|重写|重建/)
  await settle();a.close();await rejected
  b.run('resume()');await settle()
  expect(()=>a.run('oldMvu.getMvuData()')).toThrow(/关闭/)
})

it('变量编辑草稿阻止主动和被动显示重绘，清理后才接受显示锁',async()=>{
  const f=frame();f.run('__dshTavernVariableEditorDirty=()=>true')
  await expect(f.run('refreshOneMessage(0)')).rejects.toThrow(/变量编辑器/)
  f.send({source:'dsh-tavern-card',action:'helperDisplayGuard',requestId:'dirty',storyId:snapshot.storyId,historyRevision:snapshot.historyRevision})
  expect(f.posts.at(-1)).toMatchObject({action:'helperDisplayGuardResult',requestId:'dirty',ok:false})
  expect(f.run('Boolean(window.__dshTavernDisplayLocked)')).toBe(false)
  f.run('__dshTavernVariableEditorDirty=()=>false')
  f.send({source:'dsh-tavern-card',action:'helperDisplayGuard',requestId:'clean',storyId:snapshot.storyId,historyRevision:snapshot.historyRevision})
  await settle()
  expect(f.posts.at(-1)).toMatchObject({action:'helperDisplayGuardResult',requestId:'clean',ok:true})
})

it('实际剧情事务保存 MVU 消息变量，重建宿主仍可读且同卡另一剧情保持独立',async()=>{
  const root=await mkdtemp(join(tmpdir(),'tavern-mvu-factory-'))
  try{
    const paths={root,characters:join(root,'characters'),lorebooks:join(root,'lorebooks'),presets:join(root,'presets'),personas:join(root,'personas'),regexDir:join(root,'regex'),sessions:join(root,'sessions')}
    const state=new TavernState(paths,()=>resolveConfig({}));await state.init()
    const {cardId}=await state.createCharacter('MVU 工厂角色')
    for(const sessionId of ['mvu-session','other'])await state.saveBinding({sessionId,cardId,presetId:null,personaId:null,lorebookIds:[],characterLorebookId:null,interactiveCards:null,greetingIndex:0,createdAt:new Date(0).toISOString()})
    const events=[{type:'turn/start',seq:0,time:0,data:{turn:1}},
      {type:'assistant/message',seq:1,time:0,surfaceOp:'append',data:{turn:1,step:1,message:createAssistantMessage({content:[{type:'text',text:'出发'}]})}},
      {type:'turn/end',seq:2,time:0,data:{turn:1,reason:{kind:'completed'}}}] as unknown as SessionEvent[]
    const ctx={sessions:{get:()=>({snapshotEvents:()=>events})},get:()=>undefined} as unknown as Context
    const before=await getHelperSnapshot(ctx,state,'mvu-session',1),f=frame(before)
    await f.run('Mvu.parseMessage("_.add(\'hp\',-2);",{initialized_lorebooks:{},stat_data:{hp:10}}).then(d=>window.result=d)')
    const done=f.run('Mvu.replaceMvuData(result,{type:"message",message_id:0})')
    await settle()
    const request=f.requests[0]!
    const saved=await commitHelperVariables(ctx,state,{sessionId:'mvu-session',messageId:1,storyId:before.storyId,historyRevision:before.historyRevision,changes:request.changes})
    f.reply(0,{ok:true,scopes:saved.scopes});await done
    expect(saved.messages[0]?.data).toMatchObject({stat_data:{hp:8}})
    const restarted=new TavernState(paths,()=>resolveConfig({}));await restarted.init()
    expect((await getHelperSnapshot(ctx,restarted,'mvu-session',1)).messages[0]?.data).toEqual(saved.messages[0]?.data)
    expect((await getHelperSnapshot(ctx,restarted,'other',1)).scopes).toEqual({})
    expect((await restarted.loadBinding('mvu-session'))?.storyId).toBe(before.storyId)
    expect(await (await restarted.workspace(cardId)).fs.readText(HELPER_STATE_PATH)).toBeNull()
    const ws=await restarted.storyWorkspace(cardId,before.storyId)
    const wal=JSON.parse((await ws.fs.readText('state/wal/mvu-session_t1/meta.json'))!)
    expect(wal.committed).toBe(true)
    f.close()
  }finally{await rm(root,{recursive:true,force:true})}
})
