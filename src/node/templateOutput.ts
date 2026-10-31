/** 正常 stop 回复只在 turn/end 处理一次；冻结闭包可从当前剧情恢复，状态与展示快照原子落盘。 */
import type { Session } from '@deepseek-ai/dsh-session'
import { hasNormalAssistantStop } from './assistantStream.js'
import { hasEjs, type TemplateMessageMetadata } from '../core/template.js'
import { normalizeTemplateLore } from '../core/templateLore.js'
import { loadTemplateState, saveTemplateState, templateTextHash } from '../state/template.js'
import { templateGenerationContext } from '../state/templateGeneration.js'
import { closeTemplateGenerationState } from '../state/templateContinuation.js'
import { withWorkspaceLock } from '../state/workspaceLock.js'
import { isolated } from './isolated.js'
import type { TavernState } from './state.js'
import { mergeTemplateMessageVariables, visibleTemplateMessageVariables } from '../core/templateMessageVariables.js'
import { TEMPLATE_DISPLAY_PARTS_VERSION } from '../core/templateDisplay.js'
import { assertActiveTemplateRuntime } from './templateRuntimeGuard.js'

/** 计算已成功但提交未确认：保留原 prepared 与 WAL，不能按模板脚本异常放弃回复。 */
export class TemplateOutputCommitError extends Error {
  constructor(cause:unknown) {
    super(`模板回复尚未保存，将保留原楼层供重试或回退：${cause instanceof Error?cause.message:String(cause)}`,{cause})
    this.name='TemplateOutputCommitError'
  }
}

export async function completeTemplateOutput(state:TavernState,session:Pick<Session,'id'|'snapshotEvents'>):Promise<void> {
  const events = session.snapshotEvents()
  const ending = [...events].reverse().find(event=>event.type==='turn/start'||event.type==='turn/end')
  if (ending?.type!=='turn/end' || ending.data.reason.kind!=='completed') return
  const turn = ending.data.turn
  const binding = await state.loadStoryBinding(session.id)
  if (!binding) return
  const ws = await state.storyWorkspace(binding.cardId,binding.storyId)
  await withWorkspaceLock(ws.fs.root,async()=> {
    const stored = await loadTemplateState(ws.fs)
    const generation = stored.generation
    const open = state.openFloors.get(session.id)
    const plan = state.turnPlans.get(session.id)
    if (state.currentTurns.has(session.id) && state.currentTurns.get(session.id)!==turn) return
    if (open && (open.cardId!==binding.cardId || open.storyId!==binding.storyId)) return
    if (plan && (plan.turn!==turn || plan.cardId!==binding.cardId || plan.storyId!==binding.storyId)) return
    const ownGeneration = generation?.sessionId===session.id && generation.turn===turn
    if (ownGeneration && (generation.cardId!==binding.cardId || generation.storyId!==binding.storyId)) throw new Error('模板回复恢复的剧情归属不一致')
    if (ownGeneration && generation.status!=='prepared') return
    const context = plan?.result.templateContext ?? (ownGeneration && generation.status==='prepared' ? templateGenerationContext(generation) : undefined)
    const replay = plan?.result.templateReplay ?? (ownGeneration && generation.status==='prepared' ? generation.replay : undefined)
    const floor = open?.floor ?? (ownGeneration ? generation.floor : undefined)
    // 生命周期首检和回复计算分属两次持锁；维护恢复的新根不能被旧缓存执行后覆盖。
    await assertActiveTemplateRuntime(stored,session.id,replay)
    if (!context || !floor) return
    if (floor!==`${session.id}#t${turn}`) throw new Error('模板回复恢复楼层与宿主结束帧不一致')
    await ws.wal.validateFloor(floor)
    const history = context.history.map(message=>({...message}))
    const historyIdentities=context.historyIdentities?.map(identity=>({...identity}))
    const candidates:Array<{id:string;text:string;metadata:TemplateMessageMetadata;step:number;seq:number}> = []
    for (const event of events) {
      if (event.type!=='assistant/message' || event.data.turn!==turn || event.data.interrupted || event.seq>=ending.seq) continue
      const text = event.data.message.content.filter(block=>block.type==='text').map(block=>block.text).join('\n')
      if (!text.trim()) continue
      const metadata:TemplateMessageMetadata = {index:history.length,role:'assistant',name:context.char,swipeId:0,hostMessageId:event.seq}
      history.push({role:'assistant',content:text,name:context.char})
      historyIdentities?.push({messageId:event.data.message.id,hostMessageId:event.seq,swipeId:0})
      candidates.push({id:String(event.seq),text,metadata,step:event.data.step,seq:event.seq})
    }
    const normalizedEntries = context.entries.map(normalizeTemplateLore)
    const before = normalizedEntries.filter(entry=>entry.enabled && !entry.templateOnlyPreload && /^\[RENDER:BEFORE\]/i.test(entry.comment))
    const after = normalizedEntries.filter(entry=>entry.enabled && !entry.templateOnlyPreload && /^\[RENDER:AFTER\]/i.test(entry.comment))
    const pending:typeof candidates = []
    for (const candidate of candidates) {
      const message = events.find(event=>event.seq===candidate.seq)
      if (message?.type!=='assistant/message' || !hasNormalAssistantStop(message)) continue
      if (!historyIdentities && !hasEjs(candidate.text) && !before.length && !after.length && !context.regexRules?.length && !context.hasMessageRegex) continue
      if (stored.outputs[candidate.id]?.hash===templateTextHash(candidate.text)) continue
      if (stored.outputs[candidate.id]) throw new Error('已处理的模板回复发生改写，请回滚该楼层后继续')
      pending.push(candidate)
    }
    if (!pending.length) return
    const result = await isolated('template',{texts:pending.map(candidate=>candidate.text),decorateOutput:true,replay,templateContinuation:stored.continuation,
      context:{...context,history,historyIdentities,messageVariables:historyIdentities ? visibleTemplateMessageVariables(stored.messageVariables,historyIdentities) : undefined,
        renderMessages:pending.map(candidate=>candidate.metadata),variables:stored.variables,phase:'render'}})
    if (result.texts.length!==pending.length || result.parts.length!==pending.length) throw new Error('模板回复结果与宿主消息数量不一致')
    try {
      stored.variables = result.variables
      if(result.templateContinuation) stored.continuation=result.templateContinuation
      if(historyIdentities) stored.messageVariables=mergeTemplateMessageVariables(stored.messageVariables,result.messageVariables,historyIdentities)
      pending.forEach((candidate,index)=>{ stored.outputs[candidate.id] = {hash:templateTextHash(candidate.text),text:result.texts[index]!,parts:result.parts[index],partsVersion:TEMPLATE_DISPLAY_PARTS_VERSION} })
      if (ownGeneration) closeTemplateGenerationState(stored,'completed')
      const latest = await state.loadStoryBinding(session.id)
      if (latest?.cardId!==binding.cardId || latest.storyId!==binding.storyId) throw new Error('模板回复提交前剧情绑定已变化')
      await saveTemplateState(ws.fs.withFloor(floor),stored)
    } catch(error) {throw new TemplateOutputCommitError(error)}
  })
}
