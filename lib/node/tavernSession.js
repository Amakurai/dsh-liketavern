import { resolveSessionPreset } from '@deepseek-ai/dsh-agent-presets';
import { isTavernPresetId } from '../core/tavernMode.js';
/** 活 agent 的组成预设优先；否则读会话日志（header + 之后的 agent-preset/selected）。 */
export function isTavernRuntimeSession(ctx, session) {
    const presets = ctx.get('agentPresets');
    const agent = ctx.agents.get(session.id);
    const live = agent && presets ? presets.composedPreset(agent.ctx) : undefined;
    return isTavernPresetId(live ?? resolveSessionPreset(session));
}
