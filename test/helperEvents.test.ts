/** 真实序列化 iframe 运行层与主页面路由的集成：跨窗口顺序、参数修改、重入、取消及剧情隔离。 */
import { createContext,runInContext } from 'node:vm'
import { webcrypto } from 'node:crypto'
import { afterEach,expect,it,vi } from 'vitest'
import { installCardEvents } from '../src/core/cardEvents.js'
import { attachHelperEvents,emitHelperHostEvent } from '../src/client/helperEventRouter.js'
import type {HelperSnapshot} from '../src/core/helperRuntime.js'
const cleanups:(()=>void)[]=[]
afterEach(()=>{for(const stop of cleanups.splice(0))stop();vi.useRealTimers()})
const settle=()=>new Promise<void>(resolve=>setImmediate(resolve))
const mvuSnapshot:HelperSnapshot={storyId:'story',historyRevision:'native',currentMessageId:0,writable:false,scopes:{},messages:[{message_id:0,role:'assistant',name:'角色',message:'回复',data:{},extra:{},is_hidden:false}]}
function frame(sessionId='session',storyId='story',nativeMvu?:Parameters<typeof attachHelperEvents>[3]) {
  const listeners=new Set<(event:unknown)=>void>(),errors:unknown[]=[],deliveries:unknown[]=[]
  const endpoint=attachHelperEvents(sessionId,storyId,message=>queueMicrotask(()=>{if(message.action==='helperEventDeliver')deliveries.push(message);for(const listener of listeners)listener({source:parent,data:structuredClone(message)})}),nativeMvu)
  const parent={postMessage:(message:Record<string,unknown>)=>{const cloned=structuredClone(message);queueMicrotask(()=>endpoint.receive(cloned))}}
  const scope:Record<string,unknown>={parent,crypto:webcrypto,TextEncoder,setTimeout,clearTimeout,
    addEventListener:(name:string,listener:(event:unknown)=>void)=>{if(name==='message')listeners.add(listener)},
    removeEventListener:(_name:string,listener:(event:unknown)=>void)=>listeners.delete(listener),
    __dshTavernReportError:(error:unknown)=>errors.push(error),
  }
  scope.window=scope
  const context=createContext(scope),run=(text:string)=>runInContext(text,context)
  const install=()=>run(`window.cleanup=(${installCardEvents.toString()})(true)`)
  install()
  let closed=false
  const close=()=>{if(closed)return;closed=true;run('cleanup()');endpoint.dispose()}
  cleanups.push(close)
  return {run,close,errors,deliveries,reinstall:()=>{run('cleanup()');install()}}
}

it('first/last 在整个剧情排序，监听修改按顺序传播，发送方原对象身份保留',async()=>{
  const a=frame(),b=frame(),c=frame()
  a.run('window.data={n:1,steps:[]}; eventOn("change",d=>{if(d!==data)throw Error("identity lost");d.n*=2;d.steps.push("a")})')
  b.run('eventMakeFirst("change",d=>{d.n+=3;d.steps.push("b")})')
  c.run('eventMakeLast("change",async d=>{await Promise.resolve();d.n+=5;d.steps.push("c")})')
  await a.run('eventEmit("change",data)')
  expect(a.run('data')).toEqual({n:13,steps:['b','a','c']})
})

it('内置 MVU 事件在每个监听前准备同一冻结快照，修改仍按剧情顺序回传',async()=>{
  const a=frame('session','story',{current:()=>true,snapshot:()=>mvuSnapshot}),b=frame()
  b.run('window.seen=[];__dshTavernPrepareHostEvent=async()=>{throw Error("wrong preparation")};__dshTavernPrepareMvuEvent=async snapshot=>seen.push(snapshot.historyRevision);eventOn("native",d=>{seen.push(d.n);d.n++})')
  await a.run('window.data={n:2};eventEmit("native",data)')
  expect(a.run('data.n')).toBe(3);expect(b.run('seen')).toEqual(['native',2])
  expect(b.deliveries[0]).toMatchObject({host:true,mvuSnapshot})
})

it('MVU 快照准备失败不会消耗 once，后续有效任务可以执行它',async()=>{
  const a=frame('session','story',{current:()=>true,snapshot:()=>mvuSnapshot}),b=frame()
  b.run('window.n=0;__dshTavernPrepareMvuEvent=async()=>{throw Error("dirty snapshot")};eventOnce("native",()=>n++)')
  await expect(a.run('eventEmit("native")')).rejects.toThrow('dirty snapshot');expect(b.run('n')).toBe(0)
  b.run('__dshTavernPrepareMvuEvent=async()=>{}');await a.run('eventEmit("native")');await a.run('eventEmit("native")')
  expect(b.run('n')).toBe(1)
})

it('MVU 租约在异步准备后失效就取消执行并保留 once',async()=>{
  let current=true
  const a=frame('session','story',{current:()=>current,snapshot:()=>mvuSnapshot}),b=frame()
  b.run('window.n=0;__dshTavernPrepareMvuEvent=()=>new Promise(resolve=>window.release=resolve);eventOnce("native",()=>n++)')
  const emitted=a.run('eventEmit("native")'),rejected=expect(emitted).rejects.toThrow(/来源已改变/)
  await settle();current=false;b.run('release()');await rejected;expect(b.run('n')).toBe(0)
  current=true;b.run('__dshTavernPrepareMvuEvent=async()=>{}');await a.run('eventEmit("native")');expect(b.run('n')).toBe(1)
})

it('MVU 发送运行时在准备期间重建不能授权旧监听，重新发送仍使用 once',async()=>{
  const a=frame('session','story',{current:()=>true,snapshot:()=>mvuSnapshot}),b=frame()
  b.run('window.n=0;__dshTavernPrepareMvuEvent=()=>new Promise(resolve=>window.release=resolve);eventOnce("native",()=>n++)')
  const emitted=a.run('eventEmit("native")'),rejected=expect(emitted).rejects.toThrow(/关闭|重建/)
  await settle();a.reinstall();await rejected;b.run('release()');await settle();expect(b.run('n')).toBe(0)
  b.run('__dshTavernPrepareMvuEvent=async()=>{}');await a.run('eventEmit("native")');expect(b.run('n')).toBe(1)
})

it('缺少 MVU 冻结快照明确失败，普通脚本参数不能伪造宿主准备权限',async()=>{
  const a=frame('session','story',{current:()=>true,snapshot:()=>undefined}),b=frame(),ordinary=frame()
  b.run('window.n=0;__dshTavernPrepareMvuEvent=async()=>{throw Error("must not prepare")};eventOn("native",()=>n++)')
  await expect(a.run('eventEmit("native")')).rejects.toThrow(/缺少固定剧情快照/);expect(b.run('n')).toBe(0)
  await ordinary.run('eventEmit("native",{host:true,mvuSnapshot:{storyId:"spoof"}})');expect(b.run('n')).toBe(1)
  expect(b.deliveries[0]).not.toHaveProperty('host');expect(b.deliveries[0]).not.toHaveProperty('mvuSnapshot')
})
it('once 和 stop 跨卡面只调用预期次数，其他会话或剧情不参与',async()=>{
  const a=frame(),b=frame(),otherSession=frame('other'),otherStory=frame('session','other')
  b.run('window.n=0;eventOnce("one",()=>n++);window.listener=eventOn("two",()=>n++)')
  otherSession.run('eventOn("one",()=>{throw Error("wrong session")})')
  otherStory.run('eventOn("one",()=>{throw Error("wrong story")})')
  await a.run('eventEmit("one")');await a.run('eventEmit("one")')
  expect(b.run('n')).toBe(1)
  b.run('listener.stop()');await a.run('eventEmit("two")')
  expect(b.run('n')).toBe(1)
})
it('监听抛错传播给发送方，先前与失败监听的 JSON 修改仍可见',async()=>{
  const a=frame(),b=frame(),c=frame()
  a.run('window.data={n:0}')
  b.run('eventOn("fail",d=>{d.n=7;throw Error("factory listener failed")})')
  c.run('window.called=false;eventOn("fail",()=>called=true)')
  await expect(a.run('eventEmit("fail",data)')).rejects.toThrow('factory listener failed')
  expect(a.run('data.n')).toBe(7);expect(c.run('called')).toBe(false)
})
it('异步监听可以重入发出另一事件，不因全局队列锁死',async()=>{
  const a=frame(),b=frame()
  a.run('window.data={n:0};eventOn("inner",d=>d.n++)')
  b.run('eventOn("outer",async d=>{await eventEmit("inner",d);d.n+=2})')
  await a.run('eventEmit("outer",data)')
  expect(a.run('data.n')).toBe(3)
})
it('监听卡面卸载或重写会拒绝待处理事件，旧监听不会复活',async()=>{
  const a=frame(),b=frame()
  b.run('eventOn("wait",()=>new Promise(()=>{}))')
  const done=a.run('eventEmit("wait")'),rejected=expect(done).rejects.toThrow(/卸载/)
  await settle();b.close();await rejected
  const c=frame();c.run('eventOn("old",()=>{throw Error("old listener")})');await settle()
  c.reinstall();await a.run('eventEmit("old")')
})
it('函数与过大参数不跨窗口传递，监听返回非法数据立即明确失败',async()=>{
  const a=frame(),b=frame()
  await expect(a.run('eventEmit("bad",()=>{})')).rejects.toThrow(/JSON/)
  await expect(a.run('eventEmit("bad","x".repeat(256*1024))')).rejects.toThrow(/256 KiB/)
  b.run('eventOn("bad",d=>d.callback=()=>{})')
  await expect(a.run('eventEmit("bad",{})')).rejects.toThrow(/JSON/)
})
it('同步入口立即执行本地监听，再异步通知其他卡面且不重复自身',async()=>{
  const a=frame(),b=frame()
  a.run('window.n=0;eventOn("sync",()=>n++)')
  b.run('window.n=0;eventOn("sync",()=>n++)')
  expect(a.run('eventEmitAndWait("sync");n')).toBe(1)
  await settle();expect(a.run('n')).toBe(1);expect(b.run('n')).toBe(1)
})
it('内部快照刷新通知只触发本卡面，不随卡面数量反复广播',async()=>{
  const a=frame(),b=frame()
  a.run('window.n=0;eventOn("dsh_helper_snapshot_refreshed",()=>n++)')
  b.run('window.n=0;eventOn("dsh_helper_snapshot_refreshed",()=>n++)')
  await a.run('__dshTavernEmitLocal("dsh_helper_snapshot_refreshed")')
  await settle();expect(a.run('n')).toBe(1);expect(b.run('n')).toBe(0)
})
it('卡住的监听在预算内失败，之后新的事件仍能正常路由',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']})
  const a=frame(),b=frame()
  b.run('eventOn("timeout",()=>new Promise(()=>{}));eventOn("next",d=>d.ok=true)')
  const done=a.run('eventEmit("timeout")'),rejected=expect(done).rejects.toThrow(/超时/)
  await settle();await vi.advanceTimersByTimeAsync(15001);await rejected
  await a.run('window.data={ok:false};eventEmit("next",data)')
  expect(a.run('data.ok')).toBe(true)
})

/** 宿主发布沿用 JSON 顺序路由，但监听开始前先刷新各沙箱的实际剧情快照。 */
it('宿主显示事件在同剧情按 first/last 顺序分发，预备完成前不调用监听',async()=>{
  const {emitHelperHostEvent}=await import('../src/client/helperEventRouter.js')
  const a=frame(),b=frame(),other=frame('session','other')
  a.run('window.seen=[];window.__dshTavernPrepareHostEvent=async()=>{seen.push("fresh")};eventMakeFirst(tavern_events.CHARACTER_MESSAGE_RENDERED,(id,type)=>seen.push([id,type]))')
  b.run('window.seen=[];window.__dshTavernPrepareHostEvent=()=>new Promise(resolve=>window.release=resolve);eventMakeLast(tavern_events.CHARACTER_MESSAGE_RENDERED,(id,type)=>seen.push([id,type]))')
  other.run('eventOn(tavern_events.CHARACTER_MESSAGE_RENDERED,()=>{throw Error("wrong story")})');await settle()
  const result=emitHelperHostEvent('session','story','character_message_rendered',[2,'normal']);await settle()
  expect(a.run('seen')).toEqual(['fresh',[2,'normal']]);expect(b.run('seen')).toEqual([])
  b.run('release()');await result;expect(b.run('seen')).toEqual([[2,'normal']])
})
it('准备失败保留 once 监听，显式修复草稿后可重试；普通脚本事件不伪装宿主准备',async()=>{
  const {emitHelperHostEvent}=await import('../src/client/helperEventRouter.js')
  const a=frame();a.run('window.n=0;window.__dshTavernPrepareHostEvent=async()=>{throw Error("unsaved draft")};eventOnce(tavern_events.CHARACTER_MESSAGE_RENDERED,()=>n++)');await settle()
  await expect(emitHelperHostEvent('session','story','character_message_rendered',[0,'normal'])).rejects.toThrow('unsaved draft');expect(a.run('n')).toBe(0)
  a.run('__dshTavernPrepareHostEvent=async()=>{}');await emitHelperHostEvent('session','story','character_message_rendered',[0,'normal']);expect(a.run('n')).toBe(1)
  await emitHelperHostEvent('session','story','character_message_rendered',[0,'normal']);expect(a.run('n')).toBe(1)
  a.run('__dshTavernPrepareHostEvent=async()=>{throw Error("should not prepare")};eventOn("manual",()=>n++)');await a.run('eventEmit("manual")');expect(a.run('n')).toBe(2)
})
it('宿主显示来源失效时停止后续监听，卸载与失败不冒充显示完成',async()=>{
  const {emitHelperHostEvent}=await import('../src/client/helperEventRouter.js')
  const a=frame(),b=frame();let current=true
  a.run('eventOn(tavern_events.CHAT_CHANGED,()=>new Promise(resolve=>window.release=resolve))');b.run('window.n=0;eventOn(tavern_events.CHAT_CHANGED,()=>n++)');await settle()
  const result=emitHelperHostEvent('session','story','chat_id_changed',['story'],()=>current),assertion=expect(result).rejects.toThrow(/来源已改变/)
  await settle();current=false;a.run('release()');await assertion;expect(b.run('n')).toBe(0)
})

it('准备期间主动取消的 once 不会因读取失败而复活或继续占用宿主路由',async()=>{
  const {emitHelperHostEvent}=await import('../src/client/helperEventRouter.js')
  const a=frame();a.run('window.n=0;window.__dshTavernPrepareHostEvent=()=>new Promise((resolve,reject)=>window.fail=()=>reject(Error("read failed")));window.stop=eventOnce(tavern_events.CHARACTER_MESSAGE_RENDERED,()=>n++)');await settle()
  const result=emitHelperHostEvent('session','story','character_message_rendered',[0,'normal']),assertion=expect(result).rejects.toThrow('read failed');await settle()
  a.run('stop.stop();fail()');await assertion;expect(a.deliveries).toHaveLength(1)
  await emitHelperHostEvent('session','story','character_message_rendered',[0,'normal']);expect(a.deliveries).toHaveLength(1);expect(a.run('n')).toBe(0)
})

/** 准备与执行之间复核宿主租约，超时只取消本次交付，不能消耗尚未执行的 once。 */
it('快照准备期间宿主来源失效不会执行旧监听，once 可由有效的新事件使用',async()=>{
  const a=frame();let current=true
  a.run('window.n=0;window.__dshTavernPrepareHostEvent=()=>new Promise(resolve=>window.release=resolve);eventOnce(tavern_events.CHARACTER_MESSAGE_RENDERED,()=>n++)');await settle()
  const result=emitHelperHostEvent('session','story','character_message_rendered',[0,'normal'],()=>current),assertion=expect(result).rejects.toThrow('来源已改变')
  await settle();current=false;a.run('release()');await assertion;await settle();expect(a.run('n')).toBe(0)
  a.run('__dshTavernPrepareHostEvent=async()=>{}');await emitHelperHostEvent('session','story','character_message_rendered',[0,'normal']);expect(a.run('n')).toBe(1)
  await emitHelperHostEvent('session','story','character_message_rendered',[0,'normal']);expect(a.run('n')).toBe(1)
})
it.each(['resolve','reject'])('准备超时后迟到的 %s 不执行旧监听也不丢失 once',async(outcome)=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']})
  const a=frame()
  a.run('window.n=0;window.__dshTavernPrepareHostEvent=()=>new Promise((resolve,reject)=>{window.release=resolve;window.fail=()=>reject(Error("late read failure"))});eventOnce(tavern_events.CHARACTER_MESSAGE_RENDERED,()=>n++)');await settle()
  const result=emitHelperHostEvent('session','story','character_message_rendered',[0,'normal']),assertion=expect(result).rejects.toThrow('超时')
  await settle();await vi.advanceTimersByTimeAsync(15001);await assertion
  a.run(outcome==='resolve'?'release()':'fail()');await settle();expect(a.run('n')).toBe(0)
  a.run('__dshTavernPrepareHostEvent=async()=>{}');await emitHelperHostEvent('session','story','character_message_rendered',[0,'normal']);expect(a.run('n')).toBe(1)
  expect(a.deliveries).toHaveLength(2)
})
it('超时后主动取消的 once 不因迟到准备回执重新订阅',async()=>{
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout','Date']})
  const a=frame()
  a.run('window.n=0;window.__dshTavernPrepareHostEvent=()=>new Promise(resolve=>window.release=resolve);window.stop=eventOnce(tavern_events.CHARACTER_MESSAGE_RENDERED,()=>n++)');await settle()
  const result=emitHelperHostEvent('session','story','character_message_rendered',[0,'normal']),assertion=expect(result).rejects.toThrow('超时')
  await settle();await vi.advanceTimersByTimeAsync(15001);await assertion
  a.run('stop.stop();release();__dshTavernPrepareHostEvent=async()=>{}');await settle()
  await emitHelperHostEvent('session','story','character_message_rendered',[0,'normal']);expect(a.run('n')).toBe(0);expect(a.deliveries).toHaveLength(1)
})
it('两个并发宿主事件准备同一 once 时只给一个执行许可',async()=>{
  const a=frame()
  a.run('window.n=0;window.releases=[];window.__dshTavernPrepareHostEvent=()=>new Promise(resolve=>releases.push(resolve));eventOnce(tavern_events.CHARACTER_MESSAGE_RENDERED,()=>n++)');await settle()
  const first=emitHelperHostEvent('session','story','character_message_rendered',[0,'normal']),second=emitHelperHostEvent('session','story','character_message_rendered',[0,'normal'])
  await settle();expect(a.run('releases.length')).toBe(2)
  a.run('releases.forEach(resolve=>resolve())');await Promise.all([first,second]);expect(a.run('n')).toBe(1)
  await emitHelperHostEvent('session','story','character_message_rendered',[0,'normal']);expect(a.run('n')).toBe(1)
})
it('准备期间重建运行时会拒绝旧事件且不会执行旧函数，新运行时可正常接收宿主事件',async()=>{
  const a=frame()
  a.run('window.n=0;window.__dshTavernPrepareHostEvent=()=>new Promise(resolve=>window.release=resolve);eventOnce(tavern_events.MESSAGE_RECEIVED,()=>n++)');await settle()
  const result=emitHelperHostEvent('session','story','message_received',[0]),assertion=expect(result).rejects.toThrow(/关闭|重建/)
  await settle();a.reinstall();await assertion;a.run('release();__dshTavernPrepareHostEvent=async()=>{};eventOnce(tavern_events.MESSAGE_RECEIVED,()=>n+=10)');await settle()
  expect(a.run('n')).toBe(0);await emitHelperHostEvent('session','story','message_received',[1]);expect(a.run('n')).toBe(10)
})
