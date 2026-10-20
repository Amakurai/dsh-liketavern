/** 宿主会话事件的副作用：开启/提交剧情 WAL，持久模板恢复及每轮缓存清理。调用方负责按会话排队。 */
import type { TavernState } from './state.js'
import type { Session } from '@deepseek-ai/dsh-session'
import { completeTemplateOutput, TemplateOutputCommitError } from './templateOutput.js'
import { loadTemplateGenerationIdentity, loadTemplateMetadata, loadTemplateState, saveTemplateState } from '../state/template.js'
import { closeTemplateGenerationState } from '../state/templateContinuation.js'
import { withWorkspaceLock } from '../state/workspaceLock.js'
import { helperMvuPending, queueHelperMvuTurn } from './helperMvu.js'
import { helperMvuHasAssistant } from './helperMvuLifecycle.js'
import { hasNormalAssistantStop } from './assistantStream.js'
import { assertActiveTemplateRuntime, TemplateRuntimeCompatibilityError } from './templateRuntimeGuard.js'

/** 暂缓开层只标记当前宿主轮，不能用它收口旧 MVU 楼层或抹掉待恢复输入。 */
const deferredTurns = new WeakMap<TavernState, Map<string, number>>()

export async function onTurnStart(state:TavernState,sessionId:string,turn:number,session?:Pick<Session,'id'|'snapshotEvents'>):Promise<void> {
  if(session && session.id!==sessionId) throw new Error('模板开始事件与目标会话不一致')
  if(session) await recoverTemplateCommit(state,sessionId,turn,session)
  // 收口提交失败保留的句柄仍属于旧楼层；新宿主事件不能覆盖它或把旧 WAL 当作新轮写入目标。
  const open=state.openFloors.get(sessionId)
  if(open&&open.floor!==`${sessionId}#t${turn}`){
    // 收口前置校验失败可能仍保留旧轮号；新宿主轮已到来，旧句柄只能重试收口、不能再写。
    state.currentTurns.delete(sessionId)
    state.currentSteps.delete(sessionId)
    throw new Error('上一楼层尚未完成，请先重试结束事件恢复提交，再开启新轮次')
  }
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
    const stored = await loadTemplateMetadata(ws.fs)
    await assertActiveTemplateRuntime(stored,sessionId)
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
        const previous=await ws.wal.validateFloor(generation.floor)
        const events=session?.snapshotEvents()
        const ending=events?.find(event=>event.type==='turn/end' && event.data.turn===generation.turn)
        if(!previous.committed && (!ending || ending.type==='turn/end' && ending.data.reason.kind==='completed'
          && events?.some(event=>event.type==='assistant/message' && event.data.turn===generation.turn && hasNormalAssistantStop(event)))) {
          throw new Error('上一楼层回复尚未保存，请重试原结束事件或回退剧情，不能终止待提交回复')
        }
        // 只有确实要改写整份状态时才取历史输出，不能把只读投影作为持久化正文。
        const complete=await loadTemplateState(ws.fs)
        closeTemplateGenerationState(complete,'terminated')
        await saveTemplateState(ws.fs.withFloor(generation.floor),complete)
        await ws.wal.commitFloor(generation.floor)
      }
    }
    await ws.wal.beginFloor(floor)
    state.openFloors.set(sessionId,{cardId:binding.cardId,storyId:binding.storyId,floor})
  })
}

/** 新轮开始前用旧正常结束帧恢复提交；冻结计划与消息原文仍来自原楼层，不重新请求模型。 */
async function recoverTemplateCommit(state:TavernState,sessionId:string,turn:number,session:Pick<Session,'id'|'snapshotEvents'>):Promise<void> {
  const binding=await state.loadBinding(sessionId)
  if(!binding) return
  const ws=await state.storyWorkspace(binding.cardId,binding.storyId)
  const generation=await loadTemplateGenerationIdentity(ws.fs)
  if(!generation || generation.sessionId!==sessionId || generation.turn>=turn) return
  if(generation.cardId!==binding.cardId || generation.storyId!==binding.storyId) throw new Error('模板轮次恢复的剧情归属不一致')
  const floor=await ws.wal.validateFloor(generation.floor)
  if(floor.committed) return
  const events=session.snapshotEvents()
  const boundary=events.findIndex(event=>event.type==='turn/end' && event.data.turn===generation.turn)
  const ending=events[boundary]
  if(ending?.type!=='turn/end' || ending.data.reason.kind!=='completed') return
  const previous={id:session.id,snapshotEvents:()=>events.slice(0,boundary+1)}
  await onTurnEnd(state,sessionId,previous)
}

export async function onTurnEnd(state:TavernState,sessionId:string,session?:Pick<Session,'id'|'snapshotEvents'>):Promise<void> {
  if(session && session.id!==sessionId)throw new Error('模板结束事件与目标会话不一致')
  const ending=[...(session?.snapshotEvents()??[])].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end')
  const key=ending?.type==='turn/end'?sessionId+'#t'+ending.data.turn:undefined
  if(ending?.type==='turn/end' && deferredTurns.get(state)?.get(sessionId)===ending.data.turn) {
    deferredTurns.get(state)?.delete(sessionId)
    state.currentTurns.delete(sessionId)
    state.currentSteps.delete(sessionId)
    // 门控已把未进入模型的原输入放回宿主队列；下次 claim 会按新轮重新发布。
    state.pendingInputs.delete(sessionId)
    state.pendingTemplateInputs.delete(sessionId)
    return
  }
  if(!key)return finishTurn(state,sessionId,session)
  // 重复投递的旧结束帧不能借当前 openFloors 收口后来的轮次，也不能覆写旧成功回执。
  const active=state.openFloors.get(sessionId)
  if(active && active.floor!==key)throw new Error('宿主结束帧与当前楼层不一致')
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
  const events = session?.snapshotEvents() ?? []
  const ending = [...events].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end')
  // 只有宿主结束帧可能处理持久回复；无事件清理不新增绑定 I/O。已有开层仍由最终提交锁内预检保护。
  if(ending?.type==='turn/end') {
    // 换绑取消仍在结束原楼层；新剧情的坏模板不能阻止旧 WAL 收口，下一轮会独立校验新剧情。
    const binding=state.openFloors.get(sessionId)??await state.loadBinding(sessionId)
    if(binding) {
      const ws=await state.storyWorkspace(binding.cardId,binding.storyId)
      await withWorkspaceLock(ws.fs.root,async()=>{await assertActiveTemplateRuntime(await loadTemplateMetadata(ws.fs),sessionId)})
    }
  }
  let templateError:unknown,helperQueueError:unknown
  if(session){
    try{await completeTemplateOutput(state,session)}
    catch(error){
      // 缓存日志也可能在首检后才被选中；兼容性失败保留缓存和原 WAL，修复安装或回滚后才能重试。
      if(error instanceof TemplateRuntimeCompatibilityError)throw error
      templateError=error
    }
    if(!templateError)try{await queueHelperMvuTurn(state,sessionId,session)}
    catch(error){templateError=error;helperQueueError=error}
    if(templateError)state.recordTriggerLog(sessionId,[...(state.turnPlans.get(sessionId)?.result.logLines ?? []),`[template:error] ${String(templateError)}`])
  }
  // 优先原开层归属；进程重启后只接受当前剧情内同会话同结束帧的持久回执。
  let entry = state.openFloors.get(sessionId)
  if (!entry && session?.id===sessionId && ending?.type==='turn/end') {
    const binding = await state.loadBinding(sessionId)
    if (binding) {
      const ws = await state.storyWorkspace(binding.cardId,binding.storyId)
      const generation = await loadTemplateGenerationIdentity(ws.fs)
      if (generation?.sessionId===sessionId && generation.turn===ending.data.turn) {
        if (generation.cardId!==binding.cardId || generation.storyId!==binding.storyId) throw new Error('模板结束恢复的剧情归属不一致')
        await ws.wal.validateFloor(generation.floor)
        entry = {cardId:generation.cardId,storyId:generation.storyId,floor:generation.floor}
      }
    }
  }
  const clearTurn=()=> {
    state.currentTurns.delete(sessionId)
    state.currentSteps.delete(sessionId)
    state.stepNoticeMarks.delete(sessionId)
    state.wiCache.delete(sessionId)
    state.turnPlans.delete(sessionId)
    state.pendingTurnPlans.delete(sessionId)
    state.pendingInputs.delete(sessionId)
    state.pendingTemplateInputs.delete(sessionId)
  }
  if (entry) {
    const ws = await state.storyWorkspace(entry.cardId,entry.storyId)
    await withWorkspaceLock(ws.fs.root,async()=> {
      // 开始预检与最终提交分属两次持锁；复核最新状态，不能将间隙恢复的旧日志按通用错误路径收口。
      const metadata=await loadTemplateMetadata(ws.fs)
      await assertActiveTemplateRuntime(metadata,sessionId)
      // 回复结束后的维护恢复也可能改变兼容性；最后一次预检成功前仍保留本轮缓存和待发布计划。
      clearTurn()
      await ws.wal.validateFloor(entry.floor)
      if (!templateError) {
        try {
          const generation = metadata.generation
          if (generation?.status==='prepared' && generation.sessionId===sessionId && generation.cardId===entry.cardId
            && generation.storyId===entry.storyId && generation.floor===entry.floor) {
            const completed = ending?.type==='turn/end' && ending.data.turn===generation.turn && ending.data.reason.kind==='completed'
              && events.some(event=>{
                if (event.type!=='assistant/message' || event.data.turn!==generation.turn || event.data.interrupted || event.seq>=ending.seq) return false
                return hasNormalAssistantStop(event)
              })
            const stored = await loadTemplateState(ws.fs)
            closeTemplateGenerationState(stored,completed?'completed':'terminated')
            await saveTemplateState(ws.fs.withFloor(entry.floor),stored)
          }
        } catch (error) { templateError = new TemplateOutputCommitError(error) }
      }
      // 模板回复未提交：保留原楼层归属，由同一结束事件重试真正收口。
      if(templateError instanceof TemplateOutputCommitError) throw templateError
      // MVU 登记失败时必须保留未提交楼层，后台可从正常 stop 原文重建任务；提交会把故障伪装成成功并放行下一轮。
      // 开层句柄照常释放：helperMvu.unregisteredFloor 正是按「未提交、未登记、不在 openFloors」识别待恢复楼层。
      if(!helperQueueError)await ws.wal.commitFloor(entry.floor)
    })
  } else clearTurn()
  // 最终校验或提交失败时保留原楼层归属，供同一结束事件重试。没有模板 generation
  // 的普通楼层无法从模板恢复；提前清掉句柄会让重试虚报成功却漏掉 WAL 提交。
  state.openFloors.delete(sessionId)
  if (templateError) throw templateError
}
