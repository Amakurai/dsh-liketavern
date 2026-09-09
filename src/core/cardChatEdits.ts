/** 卡面正文编辑：先等待变量保存，再提交固定历史版本；成功确认后宿主打开编辑分支，不在旧卡继续批量分叉。 */
import type {HelperSnapshot} from './helperRuntime.js'
import type {HelperMessageEditResult,HelperMessageTextEdit} from './helperChatEdits.js'
export function installCardChatEdits(parse:(input:unknown,lookup:(id:number)=>Record<string,unknown>|undefined)=>HelperMessageTextEdit[],json:(input:unknown)=>unknown):()=>void{
  const root=window as unknown as Record<string,unknown>,source='dsh-tavern-card',epoch=crypto.randomUUID()
  delete root.__dshTavernMessageBranch
  const previous=root.setChatMessages as (input:unknown)=>Promise<void>
  let active=true,busy=false,serial=0,branched=false
  let pending:{id:string;resolve:(result:HelperMessageEditResult)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}|null=null
  const receive=(event:MessageEvent)=>{
    const value=event.data
    if(event.source!==parent||!pending||value?.source!==source||value.action!=='helperMessageEditResult'||value.requestId!==pending.id)return
    const current=pending;pending=null;clearTimeout(current.timer)
    if(value.ok===true)current.resolve(value.result);else current.reject(new Error(typeof value.error==='string'?value.error:'消息编辑失败'))
  }
  async function submit(input:unknown,options:{refresh?:'none'|'affected'|'all'}={},deleting=false):Promise<void>{
    input=json(input) // 先验证普通 JSON，再决定是否走旧开场白分支。
    // 开场白专用调用沿用已有分支行为；其它批量请求不能被当成 swipe 半执行。
    if(!root.__dshTavernSnapshot&&Array.isArray(input)&&input.length===1&&input[0]&&Object.keys(input[0]).every(key=>['message_id','swipe_id'].includes(key))&&Object.hasOwn(input[0],'swipe_id'))return previous(input)
    if(!active||branched)throw new Error('消息编辑运行时已关闭或已创建分支')
    if(root.__dshTavernDisplayLocked)throw new Error('卡面正在重绘，请等待完成')
    if(busy)throw new Error('消息编辑仍在进行，请等待完成')
    if(!options||!['none','affected','all'].includes(options.refresh??'affected'))throw new Error('消息刷新选项无效')
    const read=root.getChatMessages as (id:number,option:{include_swipes:true})=>Record<string,unknown>[]
    const edits=deleting?input as HelperMessageTextEdit[]:parse(input,id=>read(id,{include_swipes:true})[0]);if(!(input as unknown[]).length)return
    const before=root.__dshTavernSnapshot as HelperSnapshot|undefined
    if(!before)throw new Error('当前卡面没有可编辑剧情')
    busy=true
    try{
      const transaction=root.__dshTavernMessageTransaction as (action:(snapshot:HelperSnapshot)=>Promise<HelperMessageEditResult>)=>Promise<HelperMessageEditResult>
      if(edits.length)await transaction(async snapshot=>{
      if(!active||snapshot.storyId!==before.storyId||snapshot.historyRevision!==before.historyRevision)throw new Error('等待期间聊天历史已改变')
      if(!snapshot.writable)throw new Error('生成期间不能编辑消息')
      const expected=edits.filter(edit=>edit.data!==undefined||edit.extra!==undefined||edit.pages!==undefined).map(edit=>{
        const index=edit.message_id<0?snapshot.messages.length+edit.message_id:edit.message_id,target=snapshot.messages[index]
        if(!target)throw new Error('消息序号越界')
        return {message_id:edit.message_id,...(edit.data!==undefined?{data:snapshot.scopes[JSON.stringify(['message',index])]??{}}:{}),...(edit.extra!==undefined?{extra:target.extra}:{}),...(edit.pages!==undefined?{pages:target.swipe??{active:0,pages:[{message:target.message,data:snapshot.scopes[JSON.stringify(['message',index])]??{},extra:target.extra}]}}:{})}
      })
      for(const row of expected){if(row.pages){const index=row.message_id<0?snapshot.messages.length+row.message_id:row.message_id;row.pages=json(row.pages) as NonNullable<HelperMessageTextEdit['pages']>;row.pages.pages[row.pages.active]!.data=snapshot.scopes[JSON.stringify(['message',index])]??{}}}
      const id=epoch+':'+(++serial)
      const result=await new Promise<HelperMessageEditResult>((resolve,reject)=>{
        const timer=setTimeout(()=>{pending=null;reject(new Error('消息编辑回执超时，请检查会话列表中的编辑分支后再操作'))},30000)
        pending={id,resolve,reject,timer};parent.postMessage({source,action:'helperMessageEdit',requestId:id,storyId:snapshot.storyId,historyRevision:snapshot.historyRevision,edits,...(expected.length?{before:expected}:{})},'*')
      })
      if(!active)throw new Error('卡面已关闭，请在会话列表查看编辑分支')
      if(result?.branch){branched=true;root.__dshTavernMessageBranch=result.branch;parent.postMessage({source,action:'helperMessageEditApplied',requestId:id},'*')}
      return result
      })
    }finally{busy=false}
    if(!branched&&(options.refresh??'affected')!=='none'){
      const ids=(input as {message_id:number}[]).map(row=>row.message_id<0?before.messages.length+row.message_id:row.message_id)
      await (root.__dshTavernRefreshDisplay as (ids:number[]|null)=>Promise<void>)(options.refresh==='all'?null:ids)
    }
  }
  const setChatMessages=(input:unknown,option?:{refresh?:'none'|'affected'|'all'})=>submit(input,option)
  async function deleteChatMessages(input:unknown,option?:{refresh?:'none'|'affected'|'all'}):Promise<void>{
    const ids=json(input)
    if(!Array.isArray(ids)||ids.length>4096)throw new Error('单次删除最多 4096 条消息')
    const messages=(root.__dshTavernSnapshot as HelperSnapshot|undefined)?.messages??[],seen=new Set<number>()
    const edits=ids.map(id=>{
      if(typeof id!=='number'||!Number.isSafeInteger(id))throw new Error('删除消息序号无效')
      const target=messages[id<0?messages.length+id:id]
      if(!target||seen.has(target.message_id))throw new Error('删除消息序号越界或重复')
      seen.add(target.message_id);return {message_id:id,delete:true as const}
    })
    await submit(edits,option,true)
  }
  Object.assign(root,{setChatMessages,deleteChatMessages});root.TavernHelper=Object.assign(root.TavernHelper??{},{setChatMessages,deleteChatMessages});window.addEventListener('message',receive)
  return()=>{active=false;window.removeEventListener('message',receive);if(pending){clearTimeout(pending.timer);pending.reject(new Error('卡面已关闭，请在会话列表检查编辑结果'));pending=null}}
}
