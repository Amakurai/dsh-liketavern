/** 同页面剧情事件路由：固定会话/剧情分组，串行调用监听并回传 JSON 修改；第三方函数始终留在各自 iframe。 */
import { helperJson,helperRecord } from '../core/helperRuntime.js'
import type {HelperSnapshot} from '../core/helperRuntime.js'
type NativeMvu={current:()=>boolean;snapshot:()=>HelperSnapshot|undefined}
type Message=Record<string,unknown>
type Entry={endpoint:Endpoint;id:string;event:string;once:boolean}
type Group={endpoints:Set<Endpoint>;listeners:Entry[];inflight:number}
type Delivery={resolve:(value:Message)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>;
  host?:{entry:Entry;current:()=>boolean;phase:'preparing'|'executing'}}
const groups=new Map<string,Group>()
function args(value:unknown):unknown[] {
  const parsed=helperJson(value,256*1024)
  if(!Array.isArray(parsed)||parsed.length>64)throw new Error('事件参数必须是至多 64 项的 JSON 数组')
  return parsed
}
class Endpoint {
  runtimeId='';active=true;serial=0;inflight=0
  pending=new Map<string,Delivery>()
  constructor(readonly group:Group,readonly send:(message:Message)=>void,readonly nativeMvu?:NativeMvu){}
  post(message:Message){if(this.active)this.send({source:'dsh-tavern-card',runtimeId:this.runtimeId,...message})}
  reset(reason:string) {
    this.group.listeners=this.group.listeners.filter(entry=>entry.endpoint!==this)
    for(const [deliveryId,delivery] of this.pending){clearTimeout(delivery.timer);if(delivery.host)this.post({action:'helperEventCancel',deliveryId});delivery.reject(new Error(reason))}
    this.pending.clear()
  }
  async invoke(entry:Entry,data:unknown[],emissionId:string,remaining:number,host?:()=>boolean,mvuSnapshot?:HelperSnapshot):Promise<Message> {
    if(!this.active)throw new Error('事件监听卡面已关闭')
    if(this.pending.size>=64)throw new Error('事件监听处理超过并发预算')
    const deliveryId=`${this.runtimeId}:${++this.serial}`
    return new Promise((resolve,reject)=>{
      const timeoutMs=Math.min(15000,remaining)
      const timer=setTimeout(()=>{this.pending.delete(deliveryId);if(host)this.post({action:'helperEventCancel',deliveryId});reject(new Error('事件监听处理超时'))},timeoutMs)
      this.pending.set(deliveryId,{resolve,reject,timer,...(host?{host:{entry,current:host,phase:'preparing' as const}}:{})})
      try{this.post({action:'helperEventDeliver',deliveryId,listenerId:entry.id,emissionId,args:data,...(host?{host:true,timeoutMs}:{}),...(mvuSnapshot?{mvuSnapshot}:{})})}
      catch(error){clearTimeout(timer);this.pending.delete(deliveryId);reject(error instanceof Error?error:new Error(String(error)))}
    })
  }
  receive(value:Message) {
    if(!this.active)return
    const action=value.action
    if(action==='helperEventConnect') {
      if(typeof value.runtimeId!=='string'||!value.runtimeId||value.runtimeId.length>96)return
      this.reset('卡面事件运行时已重建');this.runtimeId=value.runtimeId;return
    }
    if(!this.active||!this.runtimeId||value.runtimeId!==this.runtimeId)return
    if(action==='helperEventDisconnect'){this.reset('卡面事件运行时已关闭');this.runtimeId='';return}
    if(action==='helperEventPrepared') {
      if(typeof value.deliveryId!=='string')return
      const deliveryId=value.deliveryId,delivery=this.pending.get(deliveryId),host=delivery?.host
      if(!delivery||!host||host.phase!=='preparing')return
      // 准备可以等待变量保存与远端读取；执行许可必须在等待之后由宿主再次核验。
      try{
        if(!host.current())throw new Error('宿主事件来源已改变')
        const data=args(value.args)
        if(!this.group.listeners.includes(host.entry)){
          this.pending.delete(deliveryId);clearTimeout(delivery.timer);this.post({action:'helperEventCancel',deliveryId})
          delivery.resolve({ok:true,args:data,invoked:false,canceled:true});return
        }
        if(host.entry.once)this.group.listeners=this.group.listeners.filter(entry=>entry!==host.entry)
        host.phase='executing'
        this.post({action:'helperEventExecute',deliveryId})
      }catch(error){
        this.pending.delete(deliveryId);clearTimeout(delivery.timer);this.post({action:'helperEventCancel',deliveryId})
        delivery.reject(error instanceof Error?error:new Error(String(error)))
      }
      return
    }
    if(action==='helperEventReply') {
      if(typeof value.deliveryId!=='string')return
      const delivery=this.pending.get(value.deliveryId)
      if(!delivery)return
      this.pending.delete(value.deliveryId);clearTimeout(delivery.timer)
      try{
        if(delivery.host?.phase==='preparing'&&value.ok===true&&value.canceled!==true)throw new Error('宿主事件尚未确认执行')
        delivery.resolve({...value,args:args(value.args)})
      }catch(error){delivery.reject(error instanceof Error?error:new Error(String(error)))}
      return
    }
    try {
      if(action==='helperEventSubscribe') {
        if(typeof value.listenerId!=='string'||value.listenerId.length>128||typeof value.event!=='string'||!value.event||value.event.length>256)throw new Error('事件监听信息无效')
        if(typeof value.once!=='boolean'||!['normal','first','last'].includes(String(value.position)))throw new Error('事件监听选项无效')
        const existing=this.group.listeners.find(entry=>entry.endpoint===this&&entry.id===value.listenerId)
        if(existing&&existing.event!==value.event)throw new Error('事件监听身份冲突')
        if(!existing&&(this.group.listeners.length>=4096||this.group.listeners.filter(entry=>entry.endpoint===this).length>=1024))throw new Error('剧情事件监听超过预算')
        if(existing&&value.position==='normal')return
        this.group.listeners=this.group.listeners.filter(entry=>entry!==existing)
        const entry=existing??{endpoint:this,id:value.listenerId,event:value.event,once:value.once}
        if(value.position==='first')this.group.listeners.unshift(entry);else this.group.listeners.push(entry)
      } else if(action==='helperEventUnsubscribe') {
        this.group.listeners=this.group.listeners.filter(entry=>entry.endpoint!==this||entry.id!==value.listenerId)
      } else if(action==='helperEventEmit') {
        if(typeof value.requestId!=='string'||!value.requestId||value.requestId.length>128||typeof value.event!=='string'||!value.event||value.event.length>256)throw new Error('事件发送信息无效')
        if(this.inflight>=16||this.group.inflight>=64)throw new Error('事件发送超过并发预算')
        const data=args(value.args),runtimeId=this.runtimeId
        this.inflight++;this.group.inflight++
        void this.emit(value.requestId,value.event,data,value.excludeSelf===true).then(result=>{
          if(this.runtimeId===runtimeId)this.post(result)
        }).catch(()=>{}).finally(()=>{this.inflight--;this.group.inflight--})
      }
    } catch(error) {
      this.post({action:'helperEventResult',requestId:value.requestId,ok:false,error:error instanceof Error?error.message:String(error),args:[]})
    }
  }
  async emit(requestId:string,event:string,data:unknown[],excludeSelf:boolean):Promise<Message> {
    const runtimeId=this.runtimeId
    const deadline=Date.now()+45000
    try {
      const current=()=>this.active&&this.runtimeId===runtimeId&&(!this.nativeMvu||this.nativeMvu.current())
      if(!current())throw new Error('事件发送卡面或 MVU 任务已改变')
      const mvuSnapshot=this.nativeMvu?.snapshot()
      if(this.nativeMvu&&!mvuSnapshot)throw new Error('MVU 事件缺少固定剧情快照')
      for(const entry of [...this.group.listeners]) {
        if(!this.active||this.runtimeId!==runtimeId)throw new Error('事件发送卡面已关闭')
        if(Date.now()>=deadline)throw new Error('事件处理超过总时间预算')
        if(entry.event!==event||excludeSelf&&entry.endpoint===this||!this.group.listeners.includes(entry))continue
        if(this.nativeMvu&&!this.nativeMvu.current())throw new Error('MVU 任务或脚本就绪状态已改变')
        if(entry.once&&!this.nativeMvu)this.group.listeners=this.group.listeners.filter(item=>item!==entry)
        const result=await entry.endpoint.invoke(entry,data,requestId,deadline-Date.now(),this.nativeMvu?current:undefined,mvuSnapshot)
        data=args(result.args)
        if(result.ok!==true)throw new Error(typeof result.error==='string'?result.error:'事件监听失败')
      }
      if(!current())throw new Error('事件发送卡面或 MVU 任务已改变')
      return {action:'helperEventResult',requestId,ok:true,args:data}
    } catch(error) {return {action:'helperEventResult',requestId,ok:false,error:error instanceof Error?error.message:String(error),args:data}}
  }
}
export function attachHelperEvents(sessionId:string,storyId:string,send:(message:Message)=>void,nativeMvu?:NativeMvu) {
  const key=JSON.stringify([sessionId,storyId])
  let group=groups.get(key)
  if(!group){group={endpoints:new Set(),listeners:[],inflight:0};groups.set(key,group)}
  const endpoint=new Endpoint(group,send,nativeMvu);group.endpoints.add(endpoint)
  return {
    matchesRuntime:(id:unknown)=>endpoint.active&&typeof id==='string'&&id!==''&&endpoint.runtimeId===id,
    receive:(value:unknown)=>{if(helperRecord(value)&&value.source==='dsh-tavern-card')endpoint.receive(value)},
    dispose:()=>{endpoint.active=false;endpoint.reset('事件监听卡面已卸载');group!.endpoints.delete(endpoint);if(!group!.endpoints.size)groups.delete(key)},
  }
}

/** 仅宿主代码调用此入口；事件来自实际显示生命周期，不接受 iframe 指定会话或历史位置。 */
export async function emitHelperHostEvent(sessionId:string,storyId:string,event:'character_message_rendered'|'user_message_rendered'|'chat_id_changed'|'message_sent'|'message_received'|'generation_started'|'generation_ended'|'generation_stopped',data:unknown[],current:()=>boolean=()=>true):Promise<void>{
  const key=JSON.stringify([sessionId,storyId]),group=groups.get(key)
  if(!group)return
  if(group.inflight>=64)throw new Error('事件发送超过并发预算')
  let payload=args(data)
  const id='host:'+crypto.randomUUID(),deadline=Date.now()+45000
  group.inflight++
  try{
    for(const entry of [...group.listeners]){
      if(!current()||groups.get(key)!==group)throw new Error('宿主事件来源已改变')
      if(entry.event!==event||!group.listeners.includes(entry))continue
      if(Date.now()>=deadline)throw new Error('事件处理超过总时间预算')
      const result=await entry.endpoint.invoke(entry,payload,id,deadline-Date.now(),()=>current()&&groups.get(key)===group)
      payload=args(result.args)
      if(result.ok!==true)throw new Error(typeof result.error==='string'?result.error:'宿主事件监听失败')
    }
    if(!current())throw new Error('宿主事件来源已改变')
  }finally{group.inflight--}
}
export function reportHelperHostEventError(sessionId:string,storyId:string,error:unknown):void{
  for(const endpoint of groups.get(JSON.stringify([sessionId,storyId]))?.endpoints??[])endpoint.post({action:'helperEventResult',ok:false,args:[],error:String(error instanceof Error?error.message:error).slice(0,2000)})
}
export function hasHelperEventAudience(sessionId:string):boolean{
  return [...groups].some(([key,group])=>JSON.parse(key)[0]===sessionId&&group.endpoints.size>0)
}
