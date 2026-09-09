/** 完整序列化桥脚本的内置 MVU 执行测试：真实快照准备与钩子、初始化锚点、失败和窗口身份边界。 */
import {createContext,runInContext} from 'node:vm'
import {webcrypto} from 'node:crypto'
import {parse as parseYaml} from 'yaml'
import {afterEach,expect,it,vi} from 'vitest'
import {tavernCardBridgeScript} from '../src/core/cardFrame.js'
import {attachHelperEvents} from '../src/client/helperEventRouter.js'
import type {HelperSnapshot} from '../src/core/helperRuntime.js'
import type {HelperMvuWork} from '../src/core/helperMvu.js'

const cleanups:(()=>void)[]=[]
afterEach(()=>{for(const stop of cleanups.splice(0))stop()})
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve))
function work(kind:'initialize'|'update'='update',turn=1,text="_.add('hp',5);"):HelperMvuWork{
  const snapshot:HelperSnapshot={storyId:'runner-story',historyRevision:'runner-history',currentMessageId:0,writable:false,scopes:{},messages:[{message_id:0,role:'assistant',name:'角色',message:text,data:{},extra:{},is_hidden:false}]}
  return {storyId:snapshot.storyId,enabled:true,status:'pending',job:{id:'job',kind,seq:3,identity:'message',text,turn,floor:'session#t'+turn},token:'token',base:{stat_data:{hp:10}},snapshot,applyText:kind==='update'||turn>0,greeting:'<initvar>hp: 7</initvar>',swipeId:2}
}
function frame(initial=work()){
  const listeners=new Set<(event:unknown)=>void>(),posts:Record<string,unknown>[]=[]
  let current=initial,refreshed:HelperSnapshot|undefined,valid=true
  const send=(data:Record<string,unknown>,source:unknown=parent)=>{for(const listener of listeners)listener({source,data:run('JSON.parse('+JSON.stringify(JSON.stringify(data))+')')})}
  const endpoint=attachHelperEvents('runner-session',initial.storyId,message=>queueMicrotask(()=>send(message)),{current:()=>valid,snapshot:()=>current.snapshot})
  const parent={postMessage:(message:Record<string,unknown>)=>{
    const value=structuredClone(message);posts.push(value)
    if(value.action==='helperSnapshotGet')queueMicrotask(()=>send({source:'dsh-tavern-card',action:'helperSnapshotResult',requestId:value.requestId,ok:true,snapshot:refreshed??current.snapshot}))
    else if(String(value.action).startsWith('helperEvent'))queueMicrotask(()=>endpoint.receive(value))
  }}
  const scope:Record<string,unknown>={parent,TextEncoder,crypto:webcrypto,queueMicrotask,setTimeout,clearTimeout,
    __parseYaml:(text:string)=>JSON.stringify(parseYaml(text)),
    document:{readyState:'loading',body:null,addEventListener:vi.fn(),removeEventListener:vi.fn(),open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null},
    addEventListener:(name:string,listener:(event:unknown)=>void)=>{if(name==='message')listeners.add(listener)},
    removeEventListener:(_name:string,listener:(event:unknown)=>void)=>listeners.delete(listener)}
  scope.window=scope
  const context=createContext(scope),run=(text:string)=>runInContext(text,context)
  run('window.YAML={parse:text=>JSON.parse(__parseYaml(text))}')
  run(tavernCardBridgeScript({greetings:[],greetingIndex:0,helperSnapshot:initial.snapshot,mvuRunner:true}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,''))
  const runtimeId=posts.find(value=>value.action==='helperMvuReady')!.runtimeId
  const dispatch=(next=current,requestId='request',extra:Record<string,unknown>={},source:unknown=parent)=>{current=next;send({source:'dsh-tavern-card',action:'helperMvuRun',runtimeId,requestId,work:next,...extra},source)}
  const result=async(id='request')=>{for(let i=0;i<20;i++){const found=posts.find(value=>value.action==='helperMvuResult'&&value.requestId===id);if(found)return found;await settle()}throw Error('runner result did not arrive')}
  let closed=false
  const close=()=>{if(closed)return;closed=true;valid=false;run('__dshTavernBridgeCleanup()');endpoint.dispose()}
  cleanups.push(close)
  return {run,posts,dispatch,result,close,runtimeId,overrideSnapshot:(next:HelperSnapshot)=>{refreshed=next}}
}

it('完整 srcDoc 桥自包含，开场初始化先合并 YAML 再等待可变初始化钩子且不自动写变量',async()=>{
  const input=work('initialize',0,'开场');input.base={};const f=frame(input)
  f.run('window.seen=[];eventOn(Mvu.events.VARIABLE_INITIALIZED,async(d,swipe)=>{await Promise.resolve();seen.push([getCurrentMessageId(),swipe]);d.stat_data.hp+=3})')
  f.dispatch();expect(await f.result()).toMatchObject({ok:true,data:{stat_data:{hp:10}}})
  expect(f.run('seen')).toEqual([[0,2]]);expect(input.base).toEqual({});expect(f.posts.some(value=>value.action==='helperVariablesCommit')).toBe(false)
})

it('首次非开场锚点计算正文，已有当前消息 stat_data 的初始化显式跳过本文',async()=>{
  const input=work('initialize');input.base={};const a=frame(input);a.dispatch()
  expect(await a.result()).toMatchObject({ok:true,data:{stat_data:{hp:12}}})
  a.close();const existing=work('initialize');existing.base={stat_data:{hp:15}};existing.applyText=false
  const b=frame(existing);b.dispatch();expect(await b.result()).toMatchObject({ok:true,data:{stat_data:{hp:15}}})
})

it('更新使用刷新后的同一目标快照，事件能改命令与结束数据而不修改输入基线',async()=>{
  const input=work(),f=frame(input)
  f.run('eventOn(Mvu.events.COMMAND_PARSED,(d,c)=>{if(getCurrentMessageId()!==0)throw Error("wrong position");c[0].args[1]="7"});eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,d=>d.stat_data.hp=Math.min(16,d.stat_data.hp))')
  f.dispatch();expect(await f.result()).toMatchObject({ok:true,data:{stat_data:{hp:16}}});expect(input.base).toEqual({stat_data:{hp:10}})
})

it('命令与监听失败返回明确错误，不报告成功也不提交变量',async()=>{
  const f=frame();f.run('eventOn(Mvu.events.VARIABLE_UPDATE_ENDED,()=>{throw Error("schema failed")})');f.dispatch()
  expect(await f.result()).toMatchObject({ok:false,error:'schema failed'})
  f.run('eventClearEvent(Mvu.events.VARIABLE_UPDATE_ENDED)');f.dispatch(work('update',1,"_.set('hp',evil());"),'bad')
  expect(await f.result('bad')).toMatchObject({ok:false});expect(f.posts.some(value=>value.action==='helperVariablesCommit')).toBe(false)
})

it('任务来源窗口、运行时和请求身份不匹配时不执行也不回传',async()=>{
  const f=frame();f.dispatch(work(),'spoof',{},{});f.dispatch(work(),'runtime',{runtimeId:'other'});f.dispatch(work(),'')
  await settle();expect(f.posts.filter(value=>value.action==='helperMvuResult')).toEqual([])
  f.dispatch();expect(await f.result()).toMatchObject({ok:true})
})

it('任务正文或刷新回执与冻结快照不一致时在任何 MVU 钩子前失败',async()=>{
  const input=work(),f=frame(input);f.run('window.n=0;eventOn(Mvu.events.VARIABLE_UPDATE_STARTED,()=>n++)')
  f.overrideSnapshot({...input.snapshot!,historyRevision:'different'});f.dispatch()
  expect(await f.result()).toMatchObject({ok:false,error:'MVU 任务快照与刷新回执不一致'});expect(f.run('n')).toBe(0)
  const bad=work();bad.job!.text='wrong';f.dispatch(bad,'body');expect(await f.result('body')).toMatchObject({ok:false,error:'MVU 任务正文与消息快照不一致'})
})

it('执行期间拒绝重入任务，关闭后迟到的异步监听不会回传成功',async()=>{
  const f=frame();f.run('eventOn(Mvu.events.VARIABLE_UPDATE_STARTED,()=>new Promise(resolve=>window.release=resolve))')
  f.dispatch();await settle();f.dispatch(work(),'busy');expect(await f.result('busy')).toMatchObject({ok:false,error:'MVU 任务正在执行'})
  f.close();f.run('release()');await settle();expect(f.posts.some(value=>value.action==='helperMvuResult'&&value.requestId==='request')).toBe(false)
})
