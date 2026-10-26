/** 消息编辑分支的 seed：保留日志序号和后续正文，以可忽略标记替代过时压缩与已改正文的流式片段。 */
import {Session,type SessionEvent} from '@deepseek-ai/dsh-session'
import {createAssistantMessage,createUserMessage,type ContentBlock} from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {'tavern/message-edit-marker':{originalType:string;reason:'stale-compaction'|'edited-stream'|'deleted-message'}}
}
function marker(event:SessionEvent,reason:'stale-compaction'|'edited-stream'|'deleted-message'):SessionEvent{return {type:'tavern/message-edit-marker',seq:event.seq,time:event.time,ignorable:true,data:{originalType:event.type,reason}}}
function editedContent(blocks:readonly ContentBlock[],text:string):ContentBlock[]{
  let placed=false
  const edited=blocks.flatMap<ContentBlock>(block=>{if(block.type!=='text')return [block];if(placed)return [];placed=true;return [{type:'text',text}]})
  // 工具调用或推理独占的回复原本没有 text 块，正文编辑仍须实际写入，而不能只换消息身份。
  return placed?edited:[...edited,{type:'text',text}]
}
type OpenCompaction={
  seqs:number[]
  id:unknown
  commandId?:string
  turn:unknown
  summarized:boolean
  checkpointed:boolean
  shadowedRange?:{start:number;end:number}
  shadowedSeqs?:readonly number[]
  awaitingCheckpoint:boolean
  crossedTurn:boolean
}
function staleCompactionSeqs(events:readonly SessionEvent[],first:number,removed:ReadonlySet<number>):Set<number>{
  const stale=new Set<number>(),staleCommandIds=new Set<string>(),pairedPruneResults=new Set<number>(),shadowedInHistorySystems=new Set<number>()
  let open:OpenCompaction|undefined,surfaceSeen=false,protectedHead:number|undefined
  const recordStaleShadowedSystems=(seqs:readonly unknown[]|undefined)=>{
    if(!Array.isArray(seqs))return
    for(const seq of seqs)if(typeof seq==='number'&&seq!==protectedHead){
      const target=events[seq]
      if(target?.type==='system/message'&&target.surfaceOp==='append')shadowedInHistorySystems.add(seq)
    }
  }
  const markOpenStale=(item:OpenCompaction)=>{
    for(const seq of item.seqs)stale.add(seq)
    if(item.commandId)staleCommandIds.add(item.commandId)
    recordStaleShadowedSystems(item.shadowedSeqs)
  }
  for(const [index,event] of events.entries()){
    const type=String(event.type)
    const isSurface='surfaceOp' in event&&event.surfaceOp!==undefined
    if(isSurface&&!surfaceSeen){
      surfaceSeen=true
      if(event.type==='system/message'&&event.surfaceOp==='append')protectedHead=event.seq
    }
    const isReplacement='surfaceOp' in event&&Boolean(event.surfaceOp)&&event.surfaceOp!=='append'
    const isCheckpoint=event.type==='user/message'&&isReplacement&&(event.data.source as {kind?:string}).kind==='compact-checkpoint'
    if(open?.awaitingCheckpoint&&!isCheckpoint){
      markOpenStale(open)
      open=undefined
    }
    if(open&&(type==='turn/start'||type==='turn/end')){
      open.crossedTurn=true
      continue
    }
    if(type==='command/run'){
      const data=event.data as {name?:unknown;commandId?:unknown}
      if(data.name==='compact'&&typeof data.commandId==='string'&&event.seq>=first){
        stale.add(event.seq)
        staleCommandIds.add(data.commandId)
      }
      continue
    }
    if(type==='command/done'){
      const data=event.data as {commandId?:unknown;sourceEventSeq?:unknown}
      const commandId=typeof data.commandId==='string'?data.commandId:undefined
      const brokenSource=typeof data.sourceEventSeq==='number'&&(stale.has(data.sourceEventSeq)||removed.has(data.sourceEventSeq))
      if(commandId&&staleCommandIds.has(commandId)||brokenSource){
        stale.add(event.seq)
        if(commandId)staleCommandIds.add(commandId)
      }
      continue
    }
    if(type==='compaction/start'){
      if(open)markOpenStale(open)
      const data=event.data as {compactionId?:unknown;turn?:unknown;sourceCommandId?:unknown}
      const commandId=typeof data.sourceCommandId==='string'?data.sourceCommandId:undefined
      open={seqs:[event.seq],id:data.compactionId,commandId,turn:data.turn,summarized:false,checkpointed:false,awaitingCheckpoint:false,crossedTurn:false}
      if(event.seq>=first||commandId&&staleCommandIds.has(commandId))markOpenStale(open)
      continue
    }
    if(type==='compaction/summary'){
      const data=event.data as {compactionId?:unknown;shadowedRange?:{start:number;end:number};shadowedSeqs?:readonly number[];sourceCommandId?:unknown}
      const commandId=typeof data.sourceCommandId==='string'?data.sourceCommandId:undefined
      if(open&&!open.crossedTurn&&!open.summarized&&!open.checkpointed&&data.compactionId===open.id&&commandId===open.commandId&&data.shadowedRange&&typeof data.shadowedRange.start==='number'&&typeof data.shadowedRange.end==='number'){
        open.seqs.push(event.seq)
        open.summarized=true
        open.shadowedRange=data.shadowedRange
        open.shadowedSeqs=data.shadowedSeqs
        open.awaitingCheckpoint=true
        if(event.seq>=first||open.commandId&&staleCommandIds.has(open.commandId))markOpenStale(open)
      }else{
        if(open){markOpenStale(open);open=undefined}
        stale.add(event.seq)
        recordStaleShadowedSystems(data.shadowedSeqs)
        if(commandId)staleCommandIds.add(commandId)
      }
      continue
    }
    if(isCheckpoint){
      const source=event.data.source as {compactionId?:unknown;sourceCommandId?:unknown}
      const commandId=typeof source.sourceCommandId==='string'?source.sourceCommandId:undefined
      const surfaceOp=event.surfaceOp as {op?:string;startSeq?:number;endSeq?:number}
      const matchesRange=Boolean(open?.shadowedRange&&surfaceOp.op==='replace'&&surfaceOp.startSeq===open.shadowedRange.start&&surfaceOp.endSeq===open.shadowedRange.end)
      if(open&&!open.crossedTurn&&open.summarized&&!open.checkpointed&&source.compactionId===open.id&&commandId===open.commandId&&matchesRange){
        open.seqs.push(event.seq)
        open.checkpointed=true
        open.awaitingCheckpoint=false
        if(event.seq>=first||open.commandId&&staleCommandIds.has(open.commandId))markOpenStale(open)
      }else{
        if(open){markOpenStale(open);open=undefined}
        stale.add(event.seq)
        recordStaleShadowedSystems(event.sourceEventSeqs)
        if(commandId)staleCommandIds.add(commandId)
      }
      continue
    }
    if(type==='compaction/end'||type==='session/end-seed'){
      if(open){
        const data=event.data as {compactionId?:unknown;turn?:unknown;error?:unknown;sourceCommandId?:unknown}
        const commandId=type==='compaction/end'&&typeof data.sourceCommandId==='string'?data.sourceCommandId:undefined
        const failed=type==='compaction/end'&&data.error!==undefined
        const mismatched=type==='compaction/end'&&(open.crossedTurn||data.compactionId!==open.id||commandId!==open.commandId||data.turn!==open.turn)
        const incomplete=failed?(open.summarized||open.checkpointed):(!open.summarized||!open.checkpointed)
        if(event.seq>=first||mismatched||incomplete||open.seqs.some(seq=>stale.has(seq))||open.commandId&&staleCommandIds.has(open.commandId)){
          markOpenStale(open)
          if(type==='compaction/end'){
            stale.add(event.seq)
            if(commandId)staleCommandIds.add(commandId)
          }
        }
        open=undefined
      }else if(type==='compaction/end'){
        stale.add(event.seq)
        const commandId=(event.data as {sourceCommandId?:unknown}).sourceCommandId
        if(typeof commandId==='string')staleCommandIds.add(commandId)
      }
      continue
    }
    if(type==='compaction/prune'){
      const next=events[index+1]
      const range=(event.data as {shadowedRange?:{start?:number;end?:number}}).shadowedRange
      const nextOp=next&&'surfaceOp' in next&&typeof next.surfaceOp==='object'&&next.surfaceOp!==null?next.surfaceOp as {op?:string;startSeq?:number;endSeq?:number}:undefined
      const paired=Boolean(event.seq<first&&next?.type==='tool/result'&&nextOp?.op==='replace'&&typeof range?.start==='number'&&range.start===nextOp.startSeq&&range.end===nextOp.endSeq&&!stale.has(range.start)&&!removed.has(range.start)&&next.seq<first&&!removed.has(next.seq))
      if(paired&&next)pairedPruneResults.add(next.seq)
      else stale.add(event.seq)
      continue
    }
    if(event.type==='tool/result'&&isReplacement){
      if(!pairedPruneResults.has(event.seq))stale.add(event.seq)
      continue
    }
    if(type==='image/offload'){
      // Session.create 在无额外 message projection 时不支持重放 image/offload；图片卸载不改变表层节点配对，统一转为可忽略标记。
      stale.add(event.seq)
      continue
    }
    if(event.type==='system/message'&&isReplacement){
      const targetSeq=typeof event.surfaceOp==='object'&&event.surfaceOp!==null&&event.surfaceOp.op==='replace'&&event.surfaceOp.startSeq===event.surfaceOp.endSeq?event.surfaceOp.startSeq:undefined
      if(targetSeq===undefined||events[targetSeq]?.type!=='system/message'||stale.has(targetSeq))stale.add(event.seq)
      else if(targetSeq===protectedHead){
        protectedHead=event.seq
        for(const seq of shadowedInHistorySystems)if(seq<event.seq)stale.add(seq)
      }
      continue
    }
    if(event.seq>=first&&(type.startsWith('compaction/')||isReplacement))stale.add(event.seq)
  }
  if(open)markOpenStale(open)
  for(const event of events)if(String(event.type)==='command/done'){
    const data=event.data as {commandId?:unknown;sourceEventSeq?:unknown}
    const commandId=typeof data.commandId==='string'?data.commandId:undefined
    if(typeof data.sourceEventSeq==='number'&&(stale.has(data.sourceEventSeq)||removed.has(data.sourceEventSeq))){
      stale.add(event.seq)
      if(commandId)staleCommandIds.add(commandId)
    }
  }
  if(staleCommandIds.size){
    for(const event of events){
      const type=String(event.type)
      if(type==='command/run'||type==='command/done'){
        const id=(event.data as {commandId?:unknown}).commandId
        if(typeof id==='string'&&staleCommandIds.has(id))stale.add(event.seq)
      }else if(type.startsWith('compaction/')){
        const id=(event.data as {sourceCommandId?:unknown}).sourceCommandId
        if(typeof id==='string'&&staleCommandIds.has(id))stale.add(event.seq)
      }else if(event.type==='user/message'){
        const id=(event.data.source as {sourceCommandId?:unknown}).sourceCommandId
        if(typeof id==='string'&&staleCommandIds.has(id))stale.add(event.seq)
      }
    }
  }
  return stale
}
function citesRemovedMessage(event:SessionEvent,removed:ReadonlySet<number>):boolean{
  const type=String(event.type)
  if(type!=='session/title'&&type!=='session/title-llm-request')return false
  const seqs=(event.data as {messageSeqs?:unknown}).messageSeqs
  return Array.isArray(seqs)&&seqs.some(seq=>typeof seq==='number'&&removed.has(seq))
}
export function editedHistorySeed(events:readonly SessionEvent[],edits:ReadonlyMap<number,string>,deleted:ReadonlySet<number>=new Set()):SessionEvent[]{
  if(!edits.size&&!deleted.size)return [...events]
  const eventSeqs=new Set<number>(events.map(event=>event.seq))
  if([...deleted].some(seq=>!eventSeqs.has(seq)))throw new Error('删除目标不在日志中')
  const removed=new Set(deleted),deleteSteps=new Set<string>(),deleteCallIds=new Set<string>(),steps=new Set<string>()
  for(const event of events)if(deleted.has(event.seq)){
    if(edits.has(event.seq)||!['user/message','assistant/message'].includes(event.type)||'surfaceOp' in event&&event.surfaceOp!==undefined&&event.surfaceOp!=='append')throw new Error('删除目标不是独立可见消息')
    if(event.type==='assistant/message'){
      deleteSteps.add(event.data.turn+':'+event.data.step)
      for(const block of event.data.message.content)if(block.type==='tool-call')deleteCallIds.add(block.id)
    }
  }
  for(const event of events){
    if(!['assistant/message','assistant/attempt','tool/call','tool/result'].includes(event.type))continue
    const data=event.data as {turn:number;step:number;callId?:string}
    if(!deleteSteps.has(data.turn+':'+data.step))continue
    if(event.type==='assistant/message'&&event.surfaceOp==='append'&&!deleted.has(event.seq))throw new Error('删除目标与另一条 assistant 消息共用步骤')
    if(event.type==='tool/call'&&typeof data.callId==='string')deleteCallIds.add(data.callId)
    removed.add(event.seq)
  }
  if(deleteCallIds.size){
    for(const event of events){
      const type=String(event.type)
      if(type!=='tool/ptc-dispatch-start'&&type!=='tool/ptc-dispatch')continue
      const data=event.data as {rootCallId?:unknown;parentCallId?:unknown}
      if(typeof data.rootCallId==='string'&&deleteCallIds.has(data.rootCallId)||typeof data.parentCallId==='string'&&deleteCallIds.has(data.parentCallId))removed.add(event.seq)
    }
  }
  const first=Math.min(...edits.keys(),...removed),staleCompactions=staleCompactionSeqs(events,first,removed)
  for(const event of events)if(edits.has(event.seq)&&event.type==='assistant/message')steps.add(event.data.turn+':'+event.data.step)
  const seed=events.map(event=>{
    if(removed.has(event.seq)||citesRemovedMessage(event,removed))return marker(event,'deleted-message')
    if(staleCompactions.has(event.seq))return marker(event,'stale-compaction')
    if(event.type==='assistant/attempt'&&steps.has(event.data.turn+':'+event.data.step))return marker(event,'edited-stream')
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
      return {...rest,data:{...data,message,stream:[]}}
    }
    throw new Error('目标不是可见消息')
  })
  // 与实际宿主使用同一个 seed 校验器，拒绝坏引用/不连续日志后才允许复制剧情和发布。
  Session.create('session-tavern-edit-validation' as Session['id'],seed)
  return seed
}
