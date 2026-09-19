/** 在宿主 llm/stream 边界只读观察真实请求；不改冻结消息，不另开生成通道，不落盘。 */
import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import type { TavernState } from './state.js'
import { isTavernRuntimeSession } from './tavernSession.js'

/** 私有计划用于 Session 重放，既不是入模内容，也不应随每轮历史反复序列化到诊断。 */
function diagnosticMessage(message: GenerateOptions['messages'][number]): unknown {
  if (!message.source || !('tavernPromptPlan' in message.source) && message.source.kind !== 'tavern-prompt-plan') return message
  const source: Record<string, unknown> = { ...message.source }
  delete source.tavernPromptPlan
  if (source.kind === 'tavern-prompt-plan') delete source.plan
  return { ...message, source }
}

/** 同一有界缓存既记录宿主输入，也允许布局适配器覆盖为实际投影后的消息。 */
export function recordRequestDiagnostics(state:TavernState,id:string,options:GenerateOptions,stage:'host'|'tavern-adapter'='host',projectionNotes:readonly string[]=[]):void {
  let raw: string
  try {
    const { signal: _signal, ...request } = options
    raw = JSON.stringify({ observedAt: new Date().toISOString(), stage, ...(projectionNotes.length ? {projectionNotes} : {}), turn: state.currentTurns.get(id),
      step: state.currentSteps.get(id), request: { ...request, messages: request.messages.map(diagnosticMessage) } }, null, 2)
  } catch {
    // 诊断属于旁路；第三方来源元数据不能序列化时，也不能阻断真实适配器的消息发送。
    raw = JSON.stringify({ observedAt: new Date().toISOString(), stage, error: '本次请求诊断无法序列化；生成继续。' })
  }
  const limit = 2 * 1024 * 1024
  state.requestDiagnostics.delete(id)
  state.requestDiagnostics.set(id, { text: raw.slice(0, limit), truncated: raw.length > limit })
  while (state.requestDiagnostics.size > 8) state.requestDiagnostics.delete(state.requestDiagnostics.keys().next().value!)
}

export function registerRequestDiagnostics(ctx: Context, state: TavernState): void {
  ctx.on('llm/stream', (options, next) => {
    const id = options.sessionId
    const session = id ? ctx.sessions.get(id) : undefined
    try {
      if (id && session && !options.purpose && isTavernRuntimeSession(ctx, session)) {
        recordRequestDiagnostics(state,id,options)
      }
    } catch (error) { ctx.logger.warn(`dsh-tavern: 请求诊断记录失败：${String(error)}`) }
    return next()
  })
}
