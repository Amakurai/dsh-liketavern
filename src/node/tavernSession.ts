/**
 * 当前会话是否跑在 tavern agent 预设上。host 用会话日志 / 活 agent 判定，
 * 避免非 Tavern 会话被楼层 WAL、开场白写入等副作用碰到。
 */
import type { Context } from '@deepseek-ai/cordis'
import { resolveSessionPreset, type AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import { isTavernPresetId } from '../core/tavernMode.js'

/** 活 agent 的组成预设优先；否则读会话日志（header + 之后的 agent-preset/selected）。 */
export function isTavernRuntimeSession(ctx: Context, session: Session): boolean {
  const presets = ctx.get('agentPresets') as AgentPresets | undefined
  const agent = ctx.agents.get(session.id)
  const live = agent && presets ? presets.composedPreset(agent.ctx) : undefined
  return isTavernPresetId(live ?? resolveSessionPreset(session))
}
