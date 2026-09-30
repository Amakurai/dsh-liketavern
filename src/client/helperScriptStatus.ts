/** 页面内脚本运行诊断：只存有界状态，不存代码、变量或剧情正文；卸载后清除对应会话。 */
export interface ScriptRuntimeStatus {
  sessionId:string
  cardId:string
  state:'loading'|'disabled'|'waiting'|'running'|'error'
  error?:string
  nativeMvu:boolean
  /** 绑定未表态且脚本含官方 MVU 入口：页面会在会话空闲时自动开启。 */
  mvuFollow?:boolean
  mvuBusy?:boolean
  mvuError?:string
  scripts:{id:string;name:string;state:'loading'|'ready'|'error';error?:string;native:boolean}[]
}
let snapshot:readonly ScriptRuntimeStatus[]=[]
const retries=new Map<string,()=>void>(),enables=new Map<string,()=>Promise<void>>()
/** 浏览器拒绝跨窗口读取时给出兼容说明；只用于展示，不改变失败状态或放行权限。 */
export function isScriptWindowAccessError(error:string|undefined):boolean {
  if(!error)return false
  const message=error.slice(0,2000)
  return /Blocked a frame with origin [^\r\n]* from accessing a cross-origin frame/i.test(message)
    || /Permission denied to access property [^\r\n]* on cross-origin object/i.test(message)
}
export function retryScriptMvu(sessionId:string):void {retries.get(sessionId)?.()}
/** 设置页的一键开启；运行时已卸载时返回 false 由调用方提示，不假装已开启。 */
export async function enableScriptMvu(sessionId:string):Promise<boolean> {
  const enable=enables.get(sessionId)
  if(!enable)return false
  await enable()
  return true
}
const owners=new Map<string,symbol>(),listeners=new Set<()=>void>()
const notify=()=>{for(const listener of listeners)listener()}
export const scriptStatusStore={getSnapshot:()=>snapshot,subscribe:(listener:()=>void)=>{listeners.add(listener);return()=>{listeners.delete(listener)}}}
export function publishScriptStatus(owner:symbol,status:ScriptRuntimeStatus,retry?:()=>void,enable?:()=>Promise<void>):void {
  if(retry)retries.set(status.sessionId,retry)
  if(enable)enables.set(status.sessionId,enable)
  owners.set(status.sessionId,owner)
  const previous=snapshot.find(item=>item.sessionId===status.sessionId)
  if(JSON.stringify(previous)===JSON.stringify(status))return
  snapshot=[...snapshot.filter(item=>item.sessionId!==status.sessionId),status];notify()
}
export function clearScriptStatus(owner:symbol,sessionId:string):void {
  if(owners.get(sessionId)!==owner)return
  retries.delete(sessionId);enables.delete(sessionId);owners.delete(sessionId);snapshot=snapshot.filter(item=>item.sessionId!==sessionId);notify()
}
