/** 页面内脚本运行诊断：只存有界状态，不存代码、变量或剧情正文；卸载后清除对应会话。 */
export interface ScriptRuntimeStatus {
  sessionId:string
  cardId:string
  state:'loading'|'disabled'|'waiting'|'running'|'error'
  error?:string
  nativeMvu:boolean
  mvuBusy?:boolean
  mvuError?:string
  scripts:{id:string;name:string;state:'loading'|'ready'|'error';error?:string;native:boolean}[]
}
let snapshot:readonly ScriptRuntimeStatus[]=[]
const retries=new Map<string,()=>void>()
export function retryScriptMvu(sessionId:string):void {retries.get(sessionId)?.()}
const owners=new Map<string,symbol>(),listeners=new Set<()=>void>()
const notify=()=>{for(const listener of listeners)listener()}
export const scriptStatusStore={getSnapshot:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}}
export function publishScriptStatus(owner:symbol,status:ScriptRuntimeStatus,retry?:()=>void):void {
  if(retry)retries.set(status.sessionId,retry)
  owners.set(status.sessionId,owner)
  const previous=snapshot.find(item=>item.sessionId===status.sessionId)
  if(JSON.stringify(previous)===JSON.stringify(status))return
  snapshot=[...snapshot.filter(item=>item.sessionId!==status.sessionId),status];notify()
}
export function clearScriptStatus(owner:symbol,sessionId:string):void {
  if(owners.get(sessionId)!==owner)return
  retries.delete(sessionId);owners.delete(sessionId);snapshot=snapshot.filter(item=>item.sessionId!==sessionId);notify()
}
