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
  mvuRestartRequired?:boolean
  mvuCanCancel?:boolean
  mvuCanceling?:boolean
  mvuCancelError?:string
  /** 后台脚本改写消息创建子分支后若自动导航失败，在此暴露错误与手动打开入口。 */
  editedBranchError?:string
  editedBranchTitle?:string
  scripts:{id:string;name:string;state:'loading'|'ready'|'error';error?:string;native:boolean}[]
}
let snapshot:readonly ScriptRuntimeStatus[]=[]
const retries=new Map<string,()=>void>(),enables=new Map<string,()=>Promise<void>>()
const cancels=new Map<string,()=>Promise<void>>(),branchOpeners=new Map<string,()=>Promise<void>>()
/** 浏览器拒绝跨窗口读取时给出兼容说明；只用于展示，不改变失败状态或放行权限。 */
export function isScriptWindowAccessError(error:string|undefined):boolean {
  if(!error)return false
  const message=error.slice(0,2000)
  return /Blocked a frame with origin [^\r\n]* from accessing a cross-origin frame/i.test(message)
    || /Permission denied to access property [^\r\n]* on cross-origin object/i.test(message)
}
export function retryScriptMvu(sessionId:string):void {retries.get(sessionId)?.()}
/** 设置页的取消等待入口；运行时已卸载时返回 false，不假装已取消。 */
export async function cancelScriptMvu(sessionId:string):Promise<boolean> {
  const cancel=cancels.get(sessionId)
  if(!cancel)return false
  await cancel()
  return true
}
/** 后台脚本编辑分支导航失败后的手动打开入口。 */
export async function openScriptEditedBranch(sessionId:string):Promise<boolean> {
  const open=branchOpeners.get(sessionId)
  if(!open)return false
  await open()
  return true
}
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
export function publishScriptStatus(
  owner:symbol,
  status:ScriptRuntimeStatus,
  retry?:()=>void,
  enable?:()=>Promise<void>,
  actions?:{cancel?:()=>Promise<void>;openBranch?:()=>Promise<void>},
):void {
  if(retry)retries.set(status.sessionId,retry)
  else retries.delete(status.sessionId)
  if(enable)enables.set(status.sessionId,enable)
  else enables.delete(status.sessionId)
  if(actions?.cancel)cancels.set(status.sessionId,actions.cancel)
  else cancels.delete(status.sessionId)
  if(actions?.openBranch)branchOpeners.set(status.sessionId,actions.openBranch)
  else branchOpeners.delete(status.sessionId)
  owners.set(status.sessionId,owner)
  const previous=snapshot.find(item=>item.sessionId===status.sessionId)
  if(JSON.stringify(previous)===JSON.stringify(status))return
  snapshot=[...snapshot.filter(item=>item.sessionId!==status.sessionId),status];notify()
}
export function clearScriptStatus(owner:symbol,sessionId:string):void {
  if(owners.get(sessionId)!==owner)return
  retries.delete(sessionId);enables.delete(sessionId);cancels.delete(sessionId);branchOpeners.delete(sessionId);owners.delete(sessionId);snapshot=snapshot.filter(item=>item.sessionId!==sessionId);notify()
}
