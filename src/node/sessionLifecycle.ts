/** 宿主会话事件的副作用：开启/提交剧情 WAL，持久模板恢复及每轮缓存清理。调用方负责按会话排队。 */
import type { TavernState } from './state.js'
import type { Session } from '@deepseek-ai/dsh-session'
import { completeTemplateOutput } from './templateOutput.js'
import { loadTemplateState, saveTemplateState } from '../state/template.js'
import { closeTemplateGenerationState } from '../state/templateContinuation.js'
import { withWorkspaceLock } from '../state/workspaceLock.js'
import { helperMvuPending, queueHelperMvuTurn } from './helperMvu.js'
import { helperMvuHasAssistant } from './helperMvuLifecycle.js'

/** 暂缓开层只标记当前宿主轮，不能用它收口旧 MVU 楼层或抹掉待恢复输入。 */
const deferredTurns = new WeakMap<TavernState, Map<string, number>>()

export async function onTurnStart(state:TavernState,sessionId:string,turn:number,session?:Pick<Session,'id'|'snapshotEvents'>):Promise<void> {
  state.currentTurns.set(sessionId,turn)
  state.currentSteps.set(sessionId,1)
  let deferred=deferredTurns.get(state)
  if(!deferred){deferred=new Map();deferredTurns.set(state,deferred)}
  deferred.set(sessionId,turn)
  if (await helperMvuPending(state,sessionId,!session || helperMvuHasAssistant(session))) return
  deferredTurns.get(state)?.delete(sessionId)
  const binding = await state.loadBinding(sessionId)
  if (!binding) return
  const ws = await state.storyWorkspace(binding.cardId,binding.storyId)
  await withWorkspaceLock(ws.fs.root,async()=> {
    const floor = `${sessionId}#t${turn}`
    const stored = await loadTemplateState(ws.fs)
    const generation = stored.generation
    if (generation?.sessionId===sessionId) {
      if (generation.cardId!==binding.cardId || generation.storyId!==binding.storyId) throw new Error('模板轮次恢复的剧情归属不一致')
      if (generation.turn>turn) throw new Error('宿主轮次早于已保存的模板计划，请先回滚剧情')
      if (generation.turn===turn) {
        const original = await ws.wal.validateFloor(floor)
        if (generation.status!=='prepared' || original.committed) throw new Error('该模板楼层已经结束或缺失，不能重复开始')
        state.openFloors.set(sessionId,{cardId:binding.cardId,storyId:binding.storyId,floor})
        return
      }
      if (generation.status==='prepared') {
        await ws.wal.validateFloor(generation.floor)
        closeTemplateGenerationState(stored,'terminated')
        await saveTemplateState(ws.fs.withFloor(generation.floor),stored)
        await ws.wal.commitFloor(generation.floor)
      }
    }
    await ws.wal.beginFloor(floor)
    state.openFloors.set(sessionId,{cardId:binding.cardId,storyId:binding.storyId,floor})
  })
}

export async function onTurnEnd(state:TavernState,sessionId:string,session?:Pick<Session,'id'|'snapshotEvents'>):Promise<void> {
  if(session && session.id!==sessionId)throw new Error('模板结束事件与目标会话不一致')
  const ending=[...(session?.snapshotEvents()??[])].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end')
  const key=ending?.type==='turn/end'?sessionId+'#t'+ending.data.turn:undefined
  if(ending?.type==='turn/end' && deferredTurns.get(state)?.get(sessionId)===ending.data.turn) {
    deferredTurns.get(state)?.delete(sessionId)
    state.currentTurns.delete(sessionId)
    state.currentSteps.delete(sessionId)
    return
  }
  if(!key)return finishTurn(state,sessionId,session)
  const storyId=state.openFloors.get(sessionId)?.storyId??(await state.loadBinding(sessionId))?.storyId
  const record=(error?:unknown)=>{
    if(!key||ending?.type!=='turn/end')return
    state.helperTurnClosures.delete(key)
    state.helperTurnClosures.set(key,{seq:ending.seq,storyId,...(error===undefined?{}:{error:String(error instanceof Error?error.message:error).slice(0,2000)})})
    while(state.helperTurnClosures.size>256)state.helperTurnClosures.delete(state.helperTurnClosures.keys().next().value!)
  }
  try{await finishTurn(state,sessionId,session);record()}
  catch(error){record(error);throw error}
}

async function finishTurn(state:TavernState,sessionId:string,session?:Pick<Session,'id'|'snapshotEvents'>):Promise<void> {
  if (session && session.id!==sessionId) throw new Error('模板结束事件与目标会话不一致')
  let templateError:unknown,helperQueueError:unknown
  if(session){
    try{await completeTemplateOutput(state,session)}
    catch(error){templateError=error}
    if(!templateError)try{await queueHelperMvuTurn(state,sessionId,session)}
    catch(error){templateError=error;helperQueueError=error}
    if(templateError)state.recordTriggerLog(sessionId,[...(state.turnPlans.get(sessionId)?.result.logLines ?? []),`[template:error] ${String(templateError)}`])
  }
  // 优先原开层归属；进程重启后只接受当前剧情内同会话同结束帧的持久回执。
  let entry = state.openFloors.get(sessionId)
  const events = session?.snapshotEvents() ?? []
  const ending = [...events].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end')
  if (!entry && session?.id===sessionId && ending?.type==='turn/end') {
    const binding = await state.loadBinding(sessionId)
    if (binding) {
      const ws = await state.storyWorkspace(binding.cardId,binding.storyId)
      const generation = (await loadTemplateState(ws.fs)).generation
      if (generation?.sessionId===sessionId && generation.turn===ending.data.turn) {
        if (generation.cardId!==binding.cardId || generation.storyId!==binding.storyId) throw new Error('模板结束恢复的剧情归属不一致')
        await ws.wal.validateFloor(generation.floor)
        entry = {cardId:generation.cardId,storyId:generation.storyId,floor:generation.floor}
      }
    }
  }
  state.openFloors.delete(sessionId)
  state.currentTurns.delete(sessionId)
  state.currentSteps.delete(sessionId)
  state.stepNoticeMarks.delete(sessionId)
  state.wiCache.delete(sessionId)
  state.turnPlans.delete(sessionId)
  state.pendingTurnPlans.delete(sessionId)
  state.pendingInputs.delete(sessionId)
  state.pendingTemplateInputs.delete(sessionId)
  if (entry) {
    const ws = await state.storyWorkspace(entry.cardId,entry.storyId)
    await withWorkspaceLock(ws.fs.root,async()=> {
      await ws.wal.validateFloor(entry.floor)
      if (!templateError) {
        try {
          const stored = await loadTemplateState(ws.fs), generation = stored.generation
          if (generation?.status==='prepared' && generation.sessionId===sessionId && generation.cardId===entry.cardId
            && generation.storyId===entry.storyId && generation.floor===entry.floor) {
            const completed = ending?.type==='turn/end' && ending.data.turn===generation.turn && ending.data.reason.kind==='completed'
              && events.some(event=>{
                if (event.type!=='assistant/message' || event.data.turn!==generation.turn || event.data.interrupted || event.seq>=ending.seq) return false
                const chunks = events.filter(chunk=>chunk.type==='assistant/chunk' && chunk.data.turn===generation.turn && chunk.data.step===event.data.step)
                const last = chunks.at(-1)
                return chunks.filter(chunk=>chunk.type==='assistant/chunk' && chunk.data.chunk.type==='finish').length===1
                  && last?.type==='assistant/chunk' && last.data.chunk.type==='finish' && last.data.chunk.reason.kind==='stop' && last.seq<event.seq
              })
            closeTemplateGenerationState(stored,completed?'completed':'terminated')
            await saveTemplateState(ws.fs.withFloor(entry.floor),stored)
          }
        } catch (error) { templateError = error }
      }
      // MVU 登记失败时必须保留未提交楼层，后台可从正常 stop 原文重建任务；提交会把故障伪装成成功并放行下一轮。
      if(!helperQueueError)await ws.wal.commitFloor(entry.floor)
    })
  }
  if (templateError) throw templateError
}
