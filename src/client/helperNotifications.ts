/** 当前页面内的剧情变量变更通知；只在真实 remote 保存成功后广播，不传递脚本或任意宿主调用。 */
const listeners=new Map<string,Set<()=>void>>()
export function watchHelperStory(sessionId:string,storyId:string,listener:()=>void):()=>void {
  const key=JSON.stringify([sessionId,storyId])
  let group=listeners.get(key)
  if(!group) {group=new Set();listeners.set(key,group)}
  group.add(listener)
  return ()=>{group!.delete(listener);if(!group!.size) listeners.delete(key)}
}
export function notifyHelperStory(sessionId:string,storyId:string):void {
  for(const listener of listeners.get(JSON.stringify([sessionId,storyId]))??[]) listener()
}
