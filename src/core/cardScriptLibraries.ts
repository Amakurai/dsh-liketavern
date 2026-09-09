/** 沙箱脚本库 API：同步草稿、串行 CAS 保存、显式回执及重载确认；第三方 updater 只在 iframe 执行。 */
import type {HelperScriptContext,HelperScriptType,HelperScriptTree,HelperScriptView} from './helperScripts.js'
import type {CardPersistenceLabels} from './cardPersistence.js'
export function installCardScriptLibraries(initial:HelperScriptContext,normalize:(input:unknown)=>HelperScriptTree[],json:(input:unknown,maxBytes:number)=>unknown,_labels:CardPersistenceLabels):()=>void {
  type Entry=HelperScriptView&{confirmed:HelperScriptTree[];version:number}
  type Store={bindingRevision:string;libraries:Entry[]}
  const root=window as unknown as Record<string,unknown>,source='dsh-tavern-card'
  const clone=<T>(value:T):T=>JSON.parse(JSON.stringify(value)) as T
  const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b)
  let store=root.__dshTavernScriptLibraries as Store|undefined
  if(!store||store.bindingRevision!==initial.bindingRevision){store={bindingRevision:initial.bindingRevision,libraries:initial.libraries.map(library=>({...clone(library),confirmed:clone(library.trees),version:0}))};root.__dshTavernScriptLibraries=store}
  const state=store,epoch=crypto.randomUUID()
  let active=true,serial=0,failure:Error|null=null,running:Promise<void>|null=null,refreshing:Promise<HelperScriptContext>|null=null
  let pending:{id:string;action:string;resolve:(result:Record<string,unknown>)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}|null=null
  let status='saved',lastReceipt:string|null=null
  function report(error:unknown){const callback=root.__dshTavernReportError;if(typeof callback==='function')callback(error)}
  // 脚本保存反馈由设置编辑器展示；不把状态段落插进角色卡自己的布局。
  function setStatus(value:string){status=value}
  function entry(type:HelperScriptType):Entry {
    if(!active)throw new Error('脚本库运行时已关闭')
    if(!['global','preset','character'].includes(type))throw new Error('脚本库类型无效')
    const value=state.libraries.find(library=>library.type===type)
    if(!value)throw new Error('未绑定目标脚本库')
    return value
  }
  const dirty=()=>state.libraries.some(library=>!equal(library.trees,library.confirmed))
  function request(action:string,resultAction:string,payload:Record<string,unknown>):Promise<Record<string,unknown>> {
    if(!active)return Promise.reject(new Error('脚本库运行时已关闭'))
    if(pending)return Promise.reject(new Error('脚本库已有请求正在处理'))
    const id=epoch+':'+(++serial)
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending=null;reject(new Error('脚本库通信超时；本地修改已保留，请读取或重试确认'))},15000)
      pending={id,action:resultAction,resolve,reject,timer}
      parent.postMessage({source,action,requestId:id,storyId:initial.storyId,bindingRevision:state.bindingRevision,...payload},'*')
    })
  }
  function receive(event:MessageEvent){
    if(event.source!==parent)return
    const result=event.data
    if(!pending||!result||result.source!==source||result.action!==pending.action||result.requestId!==pending.id)return
    const current=pending;pending=null;clearTimeout(current.timer)
    if(result.ok===true)current.resolve(result)
    else current.reject(new Error(typeof result.error==='string'?result.error:'脚本库保存失败'))
  }
  async function drain(){
    try{
      for(let library=state.libraries.find(item=>!equal(item.trees,item.confirmed));library;library=state.libraries.find(item=>!equal(item.trees,item.confirmed))){
        const sent=clone(library.trees)
        setStatus('pending')
        const response=await request('helperScriptLibraryCommit','helperScriptLibraryResult',{type:library.type,revision:library.revision,trees:sent})
        if(!active)throw new Error('脚本运行时已关闭，保存结果需重新读取')
        const saved=response.library as HelperScriptView|undefined
        if(!saved||saved.type!==library.type||typeof saved.revision!=='string')throw new Error('脚本库保存回执无效')
        const trees=normalize(saved.trees)
        if(equal(library.trees,sent))library.trees=clone(trees)
        library.confirmed=trees;library.revision=saved.revision
        lastReceipt=String(response.requestId)
      }
      setStatus('saved')
      // 宿主收到这条确认后才可重载；本轮 Promise 的微任务仍能先确认保存结果。
      if(lastReceipt){parent.postMessage({source,action:'helperScriptLibraryApplied',requestId:lastReceipt},'*');lastReceipt=null}
    }catch(error){failure=error instanceof Error?error:new Error(String(error));if(active){setStatus('error');report(failure)}throw failure}
  }
  function flushHelperScripts(option:{retry?:boolean}={}):Promise<void>{
    if(!active)return Promise.reject(new Error('脚本库运行时已关闭'))
    if(refreshing)return refreshing.then(()=>flushHelperScripts(option))
    if(option.retry)failure=null
    if(failure)return Promise.reject(failure)
    if(!running)running=drain().finally(()=>{running=null})
    return running
  }
  function getScriptTrees(option:{type:HelperScriptType}):HelperScriptTree[]{
    if(option?.type==='preset'&&!state.libraries.some(library=>library.type==='preset'))return []
    return clone(entry(option?.type).trees)
  }
  function replaceScriptTrees(input:unknown,option:{type:HelperScriptType}):void{
    if(root.__dshTavernDisplayLocked)throw new Error('卡面正在重绘，请等待完成')
    const library=entry(option?.type),trees=normalize(normalize(input))
    json(state.libraries.map(item=>({type:item.type,trees:item===library?trees:item.trees})),4*1024*1024)
    if(equal(trees,library.trees))return
    library.trees=trees;library.version++;setStatus('pending')
    queueMicrotask(()=>{if(active)void flushHelperScripts().catch(()=>{})})
  }
  function updateScriptTreesWith(updater:(trees:HelperScriptTree[])=>unknown,option:{type:HelperScriptType}):unknown {
    if(typeof updater!=='function')throw new Error('脚本库更新器必须是函数')
    const library=entry(option?.type),before=library.version
    const commit=(value:unknown)=>{if(!active||before!==library.version)throw new Error('等待期间脚本库已改变');replaceScriptTrees(value,option);return getScriptTrees(option)}
    const result=updater(getScriptTrees(option))
    return result&&typeof (result as Promise<unknown>).then==='function'?Promise.resolve(result).then(commit):commit(result)
  }
  function refreshHelperScripts(option:{discardUnsaved?:boolean}={}):Promise<HelperScriptContext>{
    if(refreshing)return refreshing
    if(running)return Promise.reject(new Error('请等待当前脚本库保存结束'))
    if(dirty()&&!option.discardUnsaved)return Promise.reject(new Error('脚本库有未保存修改，请先导出或保存'))
    const versions=state.libraries.map(library=>library.version)
    refreshing=(async()=>{
      const response=await request('helperScriptLibrariesGet','helperScriptLibrariesResult',{})
      const next=response.context as HelperScriptContext|undefined
      if(!active||!next||next.storyId!==initial.storyId||next.bindingRevision!==state.bindingRevision||!Array.isArray(next.libraries))throw new Error('脚本会话绑定已改变，请重新加载')
      if(state.libraries.some((library,index)=>library.version!==versions[index]))throw new Error('刷新期间脚本库已改变，保留本地修改')
      for(const library of state.libraries){
        const saved=next.libraries.find(item=>item.type===library.type)
        if(!saved||typeof saved.revision!=='string')throw new Error('脚本库刷新回执无效')
        normalize(saved.trees)
      }
      for(const library of state.libraries){const saved=next.libraries.find(item=>item.type===library.type)!;library.trees=normalize(saved.trees);library.confirmed=clone(library.trees);library.revision=saved.revision;library.version++}
      failure=null;setStatus('saved');return clone(next)
    })().finally(()=>{refreshing=null})
    return refreshing
  }
  function getAllEnabledScriptButtons(){
    if(!active)throw new Error('脚本库运行时已关闭')
    const result:Record<string,{button_id:string;button_name:string}[]>=Object.create(null)
    for(const library of state.libraries)for(const tree of library.trees){
      const scripts=tree.type==='script'?[tree]:tree.enabled?tree.scripts:[]
      for(const script of scripts.filter(script=>script.enabled)){
        if(Object.hasOwn(result,script.id))throw new Error('启用的脚本 ID 重复')
        result[script.id]=script.button.enabled?script.button.buttons.filter(button=>button.visible).map(button=>({button_id:'dsh_script_button:'+JSON.stringify([script.id,button.name]),button_name:button.name})):[]
      }
    }
    return result
  }
  const api={getAllEnabledScriptButtons,getScriptTrees,replaceScriptTrees,updateScriptTreesWith,flushHelperScripts,refreshHelperScripts,getHelperScriptStatus:()=>status}
  Object.assign(root,api);root.TavernHelper=Object.assign(root.TavernHelper??{},api)
  root.__dshTavernScriptLibrariesInstalled=true
  window.addEventListener('message',receive)
  if(dirty())queueMicrotask(()=>{if(active)void flushHelperScripts().catch(()=>{})})
  return ()=>{active=false;window.removeEventListener('message',receive);root.__dshTavernScriptLibrariesInstalled=false;if(pending){clearTimeout(pending.timer);pending.reject(new Error('脚本库运行时已关闭，保存结果需重新读取'));pending=null}}
}
