/**
 * 当前会话是否跑在 tavern agent 预设上。
 * 英雄区座位与会话列表摘要都用 id `tavern`（见 presets/tavern/agent.cordis.yml）。
 * 判定失败时视为「不是 Tavern」——宁可少画插件 UI，也不要挡住原生 dsh。
 */
import { TAVERN_AGENT_PRESET } from '../core/tavernMode.js';
export { TAVERN_AGENT_PRESET };
export type SessionsListState = {
    current?: string;
    byId: Record<string, {
        agentPreset?: string;
    } | undefined>;
};
export type UseSessions = (selector: (state: SessionsListState) => unknown) => unknown;
export declare function readAgentPreset(useSessions: UseSessions | undefined, sessionId: string): string | undefined;
export declare function isTavernSession(useSessions: UseSessions | undefined, sessionId: string): boolean;
/** 当前打开的会话是否为 Tavern 模式（slot 全局注册时用来决定要不要接管 assistant-step）。 */
export declare function isCurrentTavernSession(list: {
    getSnapshot(): SessionsListState;
}): boolean;
