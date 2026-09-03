/**
 * 当前会话是否跑在 tavern agent 预设上。host 用会话投影 / 活 agent 判定，
 * 避免非 Tavern 会话被楼层 WAL、开场白写入等副作用碰到。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { Session } from '@deepseek-ai/dsh-session'
import { isTavernPresetId } from '../core/tavernMode.js'

/** ctx.sessionProjections 的最小结构面（避免把 dsh-session-projection 加进依赖）。 */
interface SessionProjectionsLike {
  stateOf(session: Session, key: 'agentPreset'): string | null | undefined
}

/**
 * 会话当前预设：0.1.2 起官方路径是 agentPreset 会话投影（header.agentPreset 初始值 +
 * agent-preset/selected 事件推进，宿主注释明确要求读投影而不是只读 header）。
 * 投影服务缺席（或尚未注册该键）时手动折叠同一份日志兜底，语义与投影一致。
 */
export function sessionPresetId(ctx: Context, session: Session): string | null {
  const projections = ctx.get('sessionProjections') as SessionProjectionsLike | undefined
  if (typeof projections?.stateOf === 'function') {
    const projected = projections.stateOf(session, 'agentPreset')
    if (projected !== undefined) return projected
  }
  let preset = session.header.agentPreset ?? null
  for (const event of session.snapshotEvents()) {
    if (event.type === 'agent-preset/selected') preset = (event.data as { agentPreset: string }).agentPreset
  }
  return preset
}

/** 活 agent 的组成预设优先；否则读会话预设投影（header + 之后的 agent-preset/selected）。 */
export function isTavernRuntimeSession(ctx: Context, session: Session): boolean {
  const presets = ctx.get('agentPresets') as AgentPresets | undefined
  const agent = ctx.agents.get(session.id)
  const live = agent && presets ? presets.composedPreset(agent.ctx) : undefined
  return isTavernPresetId(live ?? sessionPresetId(ctx, session))
}
