/**
 * 当前会话是否跑在 tavern agent 预设上。
 * 英雄区座位与会话列表摘要都用 id `tavern`（见 presets/tavern/agent.cordis.yml）。
 * 判定失败时视为「不是 Tavern」——宁可少画插件 UI，也不要挡住原生 dsh。
 */
import { isTavernPresetId, TAVERN_AGENT_PRESET } from '../core/tavernMode.js'

export { TAVERN_AGENT_PRESET }

export type SessionsListState = {
  // 0.1.2 起预设 id 只落在会话投影里（SessionSummary.projectionValues.agentPreset），
  // 顶层不再有 agentPreset 字段。
  byId: Record<string, { projectionValues?: { agentPreset?: string | null } } | undefined>
}

export type UseSessions = (selector: (state: SessionsListState) => unknown) => unknown

export function readAgentPreset(useSessions: UseSessions | undefined, sessionId: string): string | undefined {
  if (!useSessions) return undefined
  return useSessions((s) => s.byId?.[sessionId]?.projectionValues?.agentPreset ?? undefined) as string | undefined
}

export function isTavernSession(useSessions: UseSessions | undefined, sessionId: string): boolean {
  return isTavernPresetId(readAgentPreset(useSessions, sessionId))
}

