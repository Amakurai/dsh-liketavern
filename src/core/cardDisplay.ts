/** 消息显示 SDK：固定剧情和可见下标，变量保存后请求重绘；准备阶段禁止新写入，失败或超时解除。 */
import type {HelperSnapshot} from './helperRuntime.js'
export function installCardDisplay():()=>void{
  const root=window as unknown as Record<string,unknown>,source='dsh-tavern-card',epoch=crypto.randomUUID()
  let active=true,busy=false,serial=0,lock:string|null=null,lockTimer:ReturnType<typeof setTimeout>|undefined
  let preparing:{id:string}|null=null
  let pending:{id:string;resolve:()=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}|null=null
  const snapshot=()=>root.__dshTavernSnapshot as HelperSnapshot
  const unlock=()=>{lock=null;preparing=null;clearTimeout(lockTimer);delete root.__dshTavernDisplayLocked}
  function check(){
    for(const key of ['getHelperPersistenceStatus','getHelperScriptStatus']){const fn=root[key];if(typeof fn==='function'&&fn()!=='saved')throw new Error('卡面有未保存数据，请先保存或备份后再刷新')}
    const settings=root.getHelperWorldbookSettingsStatus as (()=>{pending:number;unsaved:number;error:unknown})|undefined
    const value=settings?.();if(value&&(value.pending||value.unsaved||value.error))throw new Error('世界书设置尚未保存')
    const legacy=root.__dshTavernLegacyChatDirty as (()=>boolean)|undefined
    if(legacy?.())throw new Error('上下文聊天有未保存草稿')
    const variables=root.__dshTavernVariableEditorDirty as (()=>boolean)|undefined
    if(variables?.())throw new Error('变量编辑器有未保存草稿')
  }
  function receive(event:MessageEvent){
    const value=event.data
    if(event.source!==parent||value?.source!==source)return
    if(value.action==='helperDisplayUnlock'&&(value.requestId===lock||value.requestId===preparing?.id)){unlock();return}
    if(value.action==='helperDisplayGuard'&&typeof value.requestId==='string'&&value.requestId.length<=96){
      try{
        if(!active||lock||preparing||value.storyId!==snapshot()?.storyId||typeof value.historyRevision!=='string'||value.historyRevision.length>96)throw new Error('卡面历史已改变或正在刷新')
        check()
        const preparation={id:value.requestId};preparing=preparation
        // 无草稿的旧卡先同步权威历史；刷新期间新增草稿、超时撤销或换绑都不能取得重绘锁。
        void(async()=>{
          try{
            if(value.historyRevision!==snapshot()?.historyRevision){
              const refresh=root.refreshHelperSnapshot
              if(typeof refresh!=='function')throw new Error('当前卡面不能刷新剧情快照')
              await refresh()
            }
            if(!active||preparing!==preparation)return
            if(value.storyId!==snapshot()?.storyId||value.historyRevision!==snapshot()?.historyRevision)throw new Error('卡面历史已改变或正在刷新')
            check();lock=preparation.id;root.__dshTavernDisplayLocked=true
            lockTimer=setTimeout(unlock,45000)
            parent.postMessage({source,action:'helperDisplayGuardResult',requestId:lock,ok:true},'*')
          }catch(error){if(active&&preparing===preparation)parent.postMessage({source,action:'helperDisplayGuardResult',requestId:preparation.id,ok:false,error:String(error)},'*')}
          finally{if(preparing===preparation)preparing=null}
        })()
      }catch(error){parent.postMessage({source,action:'helperDisplayGuardResult',requestId:value.requestId,ok:false,error:String(error)},'*')}
      return
    }
    if(!pending||value.action!=='helperDisplayResult'||value.requestId!==pending.id)return
    const current=pending;pending=null;clearTimeout(current.timer)
    if(value.ok===true){current.resolve();parent.postMessage({source,action:'helperDisplayApplied',requestId:current.id},'*')}
    else current.reject(new Error(typeof value.error==='string'?value.error:'消息显示刷新失败'))
  }
  async function refresh(ids:number[]|null):Promise<void>{
    if(!active||root.__dshTavernMessageBranch)throw new Error('卡面已关闭或已切换分支')
    if(busy||lock||preparing)throw new Error('消息显示刷新仍在进行')
    const before=snapshot();if(!before)throw new Error('当前卡面没有真实聊天快照')
    const storyId=before.storyId,historyRevision=before.historyRevision
    if(ids!==null&&(!Array.isArray(ids)||ids.length>4096||ids.some(id=>!Number.isSafeInteger(id)||id<0||id>=before.messages.length)))throw new Error('消息刷新序号无效')
    if(ids?.length===0)return
    busy=true
    try{
      await (root.flushHelperVariables as ()=>Promise<void>)()
      if(!active||snapshot().storyId!==storyId||snapshot().historyRevision!==historyRevision)throw new Error('等待期间聊天历史已改变')
      check()
      const id=epoch+':'+(++serial)
      await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{pending=null;reject(new Error('消息显示刷新超时，原显示保留'))},35000);pending={id,resolve,reject,timer};parent.postMessage({source,action:'helperDisplayRefresh',requestId:id,storyId,historyRevision,ids},'*')})
    }finally{busy=false}
  }
  async function refreshOneMessage(id:number,element?:unknown):Promise<void>{
    if(element!==undefined)throw new Error('沙箱不支持指定宿主 DOM 作为刷新目标')
    if(!Number.isSafeInteger(id)||id<0)throw new Error('消息刷新序号无效')
    await refresh([id])
  }
  root.__dshTavernRefreshDisplay=refresh
  Object.assign(root,{refreshOneMessage});root.TavernHelper=Object.assign(root.TavernHelper??{},{refreshOneMessage})
  window.addEventListener('message',receive)
  return()=>{active=false;unlock();window.removeEventListener('message',receive);if(pending){clearTimeout(pending.timer);pending.reject(new Error('卡面已关闭'));pending=null}}
}
