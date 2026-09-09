/** 消息编辑分支的 seed：保留日志序号和后续正文，以可忽略标记替代过时压缩与已改正文的流式片段。 */
import {Session,type SessionEvent} from '@deepseek-ai/dsh-session'
import {createAssistantMessage,createUserMessage,type ContentBlock} from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {'tavern/message-edit-marker':{originalType:string;reason:'stale-compaction'|'edited-stream'|'deleted-message'}}
}
function marker(event:SessionEvent,reason:'stale-compaction'|'edited-stream'|'deleted-message'):SessionEvent{return {type:'tavern/message-edit-marker',seq:event.seq,time:event.time,ignorable:true,data:{originalType:event.type,reason}}}
function editedContent(blocks:readonly ContentBlock[],text:string):ContentBlock[]{
  let placed=false
  return blocks.flatMap<ContentBlock>(block=>{if(block.type!=='text')return [block];if(placed)return [];placed=true;return [{type:'text',text}]})
}
export function editedHistorySeed(events:readonly SessionEvent[],edits:ReadonlyMap<number,string>,deleted:ReadonlySet<number>=new Set()):SessionEvent[]{
  if(!edits.size&&!deleted.size)return [...events]
  const eventSeqs=new Set<number>(events.map(event=>event.seq))
  if([...deleted].some(seq=>!eventSeqs.has(seq)))throw new Error('删除目标不在日志中')
  const removed=new Set(deleted),deleteSteps=new Set<string>(),steps=new Set<string>()
  for(const event of events)if(deleted.has(event.seq)){
    if(edits.has(event.seq)||!['user/message','assistant/message'].includes(event.type)||'surfaceOp' in event&&event.surfaceOp!==undefined&&event.surfaceOp!=='append')throw new Error('删除目标不是独立可见消息')
    if(event.type==='assistant/message')deleteSteps.add(event.data.turn+':'+event.data.step)
  }
  for(const event of events){
    if(!['assistant/message','assistant/chunk','tool/call','tool/result'].includes(event.type))continue
    const data=event.data as {turn:number;step:number}
    if(!deleteSteps.has(data.turn+':'+data.step))continue
    if(event.type==='assistant/message'&&event.surfaceOp==='append'&&!deleted.has(event.seq))throw new Error('删除目标与另一条 assistant 消息共用步骤')
    removed.add(event.seq)
  }
  const first=Math.min(...edits.keys(),...removed)
  for(const event of events)if(edits.has(event.seq)&&event.type==='assistant/message')steps.add(event.data.turn+':'+event.data.step)
  const seed=events.map(event=>{
    if(removed.has(event.seq))return marker(event,'deleted-message')
    if(String(event.type).startsWith('compaction/'))return marker(event,'stale-compaction')
    if(event.seq>=first&&'surfaceOp' in event&&event.surfaceOp&&event.surfaceOp!=='append')return marker(event,'stale-compaction')
    if(event.type==='assistant/chunk'&&steps.has(event.data.turn+':'+event.data.step))return marker(event,'edited-stream')
    const text=edits.get(event.seq)
    if(text===undefined)return event
    if(event.type==='user/message'){
      const message=createUserMessage({source:event.data.source,content:editedContent(event.data.content,text)})
      const {sourceEventSeqs:_sources,...rest}=event;return {...rest,data:message}
    }
    if(event.type==='assistant/message'){
      if(typeof event.data.message.source.provider!=='string'||typeof event.data.message.source.model!=='string')throw new Error('历史 assistant 消息缺少宿主模型来源')
      const message=createAssistantMessage({source:{provider:event.data.message.source.provider,model:event.data.message.source.model},content:editedContent(event.data.message.content,text)})
      const {sourceEventSeqs:_sources,...rest}=event,{interrupted:_interrupted,...data}=event.data
      return {...rest,data:{...data,message}}
    }
    throw new Error('目标不是可见消息')
  })
  // 与实际宿主使用同一个 seed 校验器，拒绝坏引用/不连续日志后才允许复制剧情和发布。
  Session.create('session-tavern-edit-validation' as Session['id'],seed)
  return seed
}
