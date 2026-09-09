/** 实时消息通知的只读屏障：固定剧情内映射宿主序号，只有已成功收口的楼层允许发送完成事件。 */
import type {Context} from '@deepseek-ai/cordis'
import type {TavernMethodRequests,TavernMethodResults} from '../remote.js'
import {withWorkspaceLock} from '../state/workspaceLock.js'
import {loadTemplateState} from '../state/template.js'
import {helperHistoryOf,helperHistoryRevision} from './helperRuntime.js'
import {readDisplaySessionEvents} from './sessionEvents.js'
import type {TavernState} from './state.js'

export async function getHelperEventState(ctx:Context,state:TavernState,request:TavernMethodRequests['getHelperEventState']):Promise<TavernMethodResults['getHelperEventState']>{
  const initial=await state.loadBinding(request.sessionId)
  if(!initial?.storyId)throw new Error('会话未绑定可用剧情')
  const ws=await state.storyWorkspace(initial.cardId,initial.storyId)
  return withWorkspaceLock(ws.fs.root,()=>withWorkspaceLock(state.paths.sessions,async()=>{
    const binding=await state.loadBinding(request.sessionId)
    if(!binding||binding.cardId!==initial.cardId||binding.storyId!==initial.storyId||request.storyId!==undefined&&request.storyId!==binding.storyId)throw new Error('事件剧情绑定已经改变')
    if(!state.config.interactiveCards||binding.interactiveCards===false)throw new Error('当前剧情未启用交互卡')
    const events=await readDisplaySessionEvents(ctx,request.sessionId)
    const history=helperHistoryOf(events,{char:'Assistant',user:'User'})
    if(request.closedSeq!==undefined){
      const ending=events.find(event=>event.seq===request.closedSeq)
      if(ending?.type!=='turn/end')throw new Error('事件目标不是已结束的宿主轮次')
      const floor=request.sessionId+'#t'+ending.data.turn,receipt=state.helperTurnClosures.get(floor)
      if(!receipt||receipt.seq!==ending.seq||receipt.storyId!==binding.storyId)throw new Error('事件轮次尚无可用的剧情收口回执')
      if(receipt.error!==undefined)throw new Error('剧情收口失败：'+receipt.error)
      const meta=await ws.wal.validateFloor(floor)
      if(!meta.committed)throw new Error('事件楼层尚未完成 WAL 提交')
      const generation=(await loadTemplateState(ws.fs)).generation
      if(generation?.sessionId===request.sessionId&&generation.turn===ending.data.turn&&generation.status==='prepared')throw new Error('事件轮次模板尚未收口')
    }
    const lastBoundary=[...events].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end')
    const lastEnd=[...events].reverse().find(event=>event.type==='turn/end')
    return {storyId:binding.storyId!,historyRevision:helperHistoryRevision(history),
      messages:history.map(({seq,role},message_id)=>({seq,role,message_id})),
      writable:!state.openFloors.has(request.sessionId)&&lastBoundary?.type!=='turn/start',closedThrough:lastEnd?.seq??-1}
  }))
}
