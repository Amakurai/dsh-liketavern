import type {HelperScriptTarget} from '../core/helperScripts.js'
/** 脚本库保存已由沙箱确认后的运行器通知；只按固定会话和剧情分发，不接受第三方目标。 */
const listeners=new Map<string,Set<()=>void>>()
export function watchHelperScripts(sessionId:string,storyId:string,listener:()=>void):()=>void {
  const key=JSON.stringify([sessionId,storyId]),group=listeners.get(key)??new Set<()=>void>()
  listeners.set(key,group);group.add(listener)
  return ()=>{group.delete(listener);if(!group.size)listeners.delete(key)}
}
export function notifyHelperScripts(sessionId:string,storyId:string):void {
  for(const listener of listeners.get(JSON.stringify([sessionId,storyId]))??[])listener()
}

/** 设置页资产保存完成后通知页面内运行器重新读取绑定库；无需暴露剧情数据。 */
const assetListeners=new Set<(target:HelperScriptTarget)=>void>()
export function watchHelperScriptAssets(listener:(target:HelperScriptTarget)=>void):()=>void {
  assetListeners.add(listener);return ()=>{assetListeners.delete(listener)}
}
export function notifyHelperScriptAssets(target:HelperScriptTarget):void {for(const listener of assetListeners)listener(target)}
