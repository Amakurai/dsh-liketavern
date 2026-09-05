/** 在宿主 llm/stream 边界只读观察真实请求；不改冻结消息，不另开生成通道，不落盘。 */
import type { Context } from '@deepseek-ai/cordis'
import type { TavernState } from './state.js'
import { isTavernRuntimeSession } from './tavernSession.js'

export function registerRequestDiagnostics(ctx: Context, state: TavernState): void {
  ctx.on('llm/stream', (options, next) => {
    const id = options.sessionId
    const session = id ? ctx.sessions.get(id) : undefined
    try {
      if (id && session && !options.purpose && isTavernRuntimeSession(ctx, session)) {
        const { signal: _signal, ...request } = options
        const raw = JSON.stringify({ observedAt: new Date().toISOString(), turn: state.currentTurns.get(id),
          step: state.currentSteps.get(id), request }, null, 2)
        const limit = 2 * 1024 * 1024
        state.requestDiagnostics.delete(id)
        state.requestDiagnostics.set(id, { text: raw.slice(0, limit), truncated: raw.length > limit })
        // 至多保存八个会话的最近请求；重启后没有旧快照，UI 明示 unavailable。
        while (state.requestDiagnostics.size > 8) state.requestDiagnostics.delete(state.requestDiagnostics.keys().next().value!)
      }
    } catch (error) { ctx.logger.warn(`dsh-tavern: 请求诊断记录失败：${String(error)}`) }
    return next()
  })
}
