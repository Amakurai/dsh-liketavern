/** 在模拟浏览器中执行真实注入源码，验证脚本库同步 API、保存回执、重写恢复和异步失败边界。 */
import {createContext,runInContext} from 'node:vm'
import {webcrypto} from 'node:crypto'
import {afterEach,expect,it,vi} from 'vitest'
import {tavernCardBridgeScript} from '../src/core/cardFrame.js'
import {parseHelperScriptTrees,type HelperScriptContext,type HelperScript} from '../src/core/helperScripts.js'
const context:HelperScriptContext={storyId:'story',bindingRevision:'binding',libraries:[{type:'global',revision:'r0',trees:parseHelperScriptTrees([{id:'global-script',enabled:true,name:'Global',content:'initial'}])},{type:'character',revision:'c0',trees:[]}]}
const cleanups:(()=>void)[]=[]
afterEach(()=>{for(const cleanup of cleanups.splice(0))cleanup()})
function frame(script=false){
  const messages:Record<string,unknown>[]=[],listeners=new Set<(event:unknown)=>void>()
  const parent={postMessage:vi.fn((message:Record<string,unknown>)=>messages.push(message))}
  const scope:Record<string,unknown>={parent,TextEncoder,crypto:webcrypto,queueMicrotask,setTimeout,clearTimeout,
    document:{readyState:'loading',body:null,addEventListener:vi.fn(),removeEventListener:vi.fn(),open:vi.fn(),write:vi.fn(),close:vi.fn(),currentScript:null,querySelector:()=>null},
    addEventListener:(name:string,callback:(event:unknown)=>void)=>{if(name==='message')listeners.add(callback)},removeEventListener:(name:string,callback:(event:unknown)=>void)=>{if(name==='message')listeners.delete(callback)}}
  scope.window=scope;const vm=createContext(scope),run=(code:string)=>runInContext(code,vm)
  const source=tavernCardBridgeScript({greetings:[],greetingIndex:0,scriptLibraries:context,scriptContext:script?{script:context.libraries[0]!.trees[0] as HelperScript,trees:[],libraryType:'global'}:undefined}).replace(/^<script[^>]*>/,'').replace(/<\/script>$/,'')
  const install=()=>run(source);install()
  const requests=()=>messages.filter(message=>['helperScriptLibraryCommit','helperScriptLibrariesGet'].includes(String(message.action)))
  const reply=(index:number,value:Record<string,unknown>,from:unknown=parent)=>{const request=requests()[index]!;for(const listener of listeners)listener({source:from,data:{source:'dsh-tavern-card',action:request.action==='helperScriptLibraryCommit'?'helperScriptLibraryResult':'helperScriptLibrariesResult',requestId:request.requestId,...value}})}
  const cleanup=()=>run('window.__dshTavernBridgeCleanup()');cleanups.push(cleanup)
  return {run,requests,reply,messages,install,cleanup}
}
it('同步修改可立即读取，先串行保存再确认重载，第二批使用第一批返回的新修订',async()=>{
  const f=frame()
  f.run('updateScriptTreesWith(t=>{t[0].content="first";return t},{type:"global"})')
  expect(f.run('getScriptTrees({type:"global"})[0].content')).toBe('first')
  const done=f.run('flushHelperScripts()')
  expect(f.requests()[0]).toMatchObject({type:'global',revision:'r0'})
  f.run('updateScriptTreesWith(t=>{t[0].content="second";return t},{type:"global"})')
  f.reply(0,{ok:true,library:{type:'global',revision:'r1',trees:f.requests()[0]!.trees}})
  await vi.waitFor(()=>expect(f.requests()).toHaveLength(2))
  expect(f.requests()[1]).toMatchObject({revision:'r1',trees:[{content:'second'}]})
  expect(f.messages.some(message=>message.action==='helperScriptLibraryApplied')).toBe(false)
  f.reply(1,{ok:true,library:{type:'global',revision:'r2',trees:f.requests()[1]!.trees}});await done
  expect(f.run('getHelperScriptStatus()')).toBe('saved')
  expect(f.messages.at(-1)).toMatchObject({action:'helperScriptLibraryApplied',requestId:f.requests()[1]!.requestId})
})
it('坏值、访问器和更新中的竞争都在本地拒绝，不污染旧树或调用宿主',async()=>{
  const f=frame()
  expect(()=>f.run('replaceScriptTrees([{id:"dup"},{id:"dup"}],{type:"global"})')).toThrow(/重复/)
  expect(()=>f.run('replaceScriptTrees([{get content(){throw Error("不应求值")}}],{type:"global"})')).toThrow(/非法字段/)
  expect(f.requests()).toHaveLength(0)
  const old=f.run('var finish;updateScriptTreesWith(async t=>{await new Promise(r=>finish=r);t[0].name="stale";return t},{type:"global"})')
  f.run('updateScriptTreesWith(t=>{t[0].name="current";return t},{type:"global"})')
  f.run('finish()');await expect(old).rejects.toThrow(/已改变/)
  expect(f.run('getScriptTrees({type:"global"})[0].name')).toBe('current')
})
it('保存冲突保持草稿，刷新默认不丢弃；刷新期间新修改同样保留',async()=>{
  const f=frame();f.run('updateScriptTreesWith(t=>{t[0].name="draft";return t},{type:"global"})')
  const saved=f.run('flushHelperScripts()');f.reply(0,{ok:false,error:'revision conflict'});await expect(saved).rejects.toThrow('revision conflict')
  expect(f.run('getScriptTrees({type:"global"})[0].name')).toBe('draft')
  await expect(f.run('refreshHelperScripts()')).rejects.toThrow(/未保存/)
  const refresh=f.run('refreshHelperScripts({discardUnsaved:true})')
  f.run('updateScriptTreesWith(t=>{t[0].name="new draft";return t},{type:"global"})')
  f.reply(1,{ok:true,context});await expect(refresh).rejects.toThrow(/刷新期间/)
  expect(f.run('getScriptTrees({type:"global"})[0].name')).toBe('new draft')
})
it('不接受其它窗口回执；重写中断旧 Promise，但保留待确认草稿供幂等重试',async()=>{
  const f=frame();f.run('updateScriptTreesWith(t=>{t[0].name="retained";return t},{type:"global"})')
  const saved=f.run('flushHelperScripts()'),rejected=expect(saved).rejects.toThrow(/关闭/)
  f.reply(0,{ok:true,library:{type:'global',revision:'forged',trees:[]}},{});
  expect(f.run('getHelperScriptStatus()')).toBe('pending')
  f.install();await rejected
  expect(f.run('getScriptTrees({type:"global"})[0].name')).toBe('retained')
  const retried=f.run('flushHelperScripts()')
  expect(f.requests()[1]).toMatchObject({revision:'r0',trees:[{name:'retained'}]})
  f.reply(1,{ok:true,library:{type:'global',revision:'r1',trees:f.requests()[1]!.trees}});await retried
})
it('后台按钮和说明进入本脚本所属资产库，按钮查询使用稳定事件身份',async()=>{
  const f=frame(true)
  f.run('replaceScriptButtons([{name:"go",visible:true}]);replaceScriptInfo("new info")')
  expect(f.run('getScriptTrees({type:"global"})[0].info')).toBe('new info')
  expect(f.run('getAllEnabledScriptButtons()[getScriptId()][0]')).toMatchObject({button_name:'go',button_id:f.run('getButtonEvent("go")')})
  const done=f.run('flushHelperScripts()')
  expect(f.requests()[0]).toMatchObject({type:'global',trees:[{info:'new info',button:{buttons:[{name:'go',visible:true}]}}]})
  f.reply(0,{ok:true,library:{type:'global',revision:'r1',trees:f.requests()[0]!.trees}});await done
})

it('特殊脚本 ID 作为按钮字典键保留，不改变结果对象原型',()=>{
  const f=frame()
  f.run('replaceScriptTrees([{id:"__proto__",enabled:true,button:{buttons:[{name:"x",visible:true}]}}],{type:"global"})')
  expect(f.run('Object.keys(getAllEnabledScriptButtons())')).toEqual(['__proto__'])
  expect(f.run('Object.getPrototypeOf(getAllEnabledScriptButtons())')).toBeNull()
  expect(f.run('getAllEnabledScriptButtons()["__proto__"][0].button_name')).toBe('x')
})
