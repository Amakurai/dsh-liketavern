/**
 * Tavern agent 预设身份。host / client 共用，避免各写一份字面量。
 * 会话列表里的 agentPreset 通常是目录 id `tavern`；偶发带路径前缀时取最后一段。
 */
export const TAVERN_AGENT_PRESET = 'tavern';
/** 是否为插件安装的 tavern agent 预设（只有这时才介入对话 UI 与楼层副作用）。 */
export function isTavernPresetId(id) {
    if (!id)
        return false;
    const trimmed = id.trim();
    if (!trimmed)
        return false;
    const last = trimmed.split(/[/\\:]/).pop() ?? trimmed;
    return last === TAVERN_AGENT_PRESET;
}
