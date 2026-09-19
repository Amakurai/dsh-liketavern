import { exportHelperScriptTrees, helperScriptSettings } from './helperScripts.js';
import { exportStPresetSampling } from './presetSampling.js';
/** ST 的 system_prompt 标记内建条目，与模型消息 role 独立；旧数据按官方内建槽位回退。 */
export function isStSystemPrompt(entry) {
    return entry.systemPrompt ?? (entry.marker || ['main', 'nsfw', 'jailbreak', 'enhanceDefinitions'].includes(entry.identifier));
}
export function exportStPreset(preset) {
    const prompts = preset.entries.map((entry) => ({
        identifier: entry.identifier,
        name: entry.name,
        role: entry.role,
        content: entry.content,
        marker: entry.marker,
        system_prompt: isStSystemPrompt(entry),
        injection_position: entry.position === 'in-chat' ? 1 : 0,
        injection_depth: entry.depth,
        injection_order: entry.order,
        ...(entry.forbidOverrides ? { forbid_overrides: true } : {}),
        ...(entry.extension ? { extension: true } : {}),
        ...(entry.injectionTrigger?.length ? { injection_trigger: [...entry.injectionTrigger] } : {}),
    }));
    // 编辑器改 order 不重排源数组；relative 栈序须与组装一致。深度条目保留原位，避免同 depth/order 的先后被改写。
    const relative = preset.entries.filter(entry => entry.position !== 'in-chat')
        .sort((a, b) => a.order - b.order);
    let relativeIndex = 0;
    const order = preset.entries.map(entry => {
        const ordered = entry.position === 'in-chat' ? entry : relative[relativeIndex++];
        return { identifier: ordered.identifier, enabled: ordered.enabled };
    });
    const exported = {
        ...exportStPresetSampling(preset.sampling),
        name: preset.name,
        identifier: preset.identifier,
        prompts,
        prompt_order: [{ character_id: 100001, order }],
    };
    for (const [source, target] of [['worldInfo', 'wi_format'], ['scenario', 'scenario_format'], ['personality', 'personality_format']]) {
        if (preset.formatting?.[source] !== undefined)
            exported[target] = preset.formatting[source];
    }
    if (preset.regexScripts?.length)
        exported.extensions = { regex_scripts: preset.regexScripts };
    if (preset.helperSettings !== undefined) {
        const settings = helperScriptSettings(preset.helperSettings);
        exported.extensions = {
            ...(exported.extensions ?? {}),
            tavern_helper: { ...settings, scripts: exportHelperScriptTrees(settings.scripts ?? []) },
        };
    }
    return exported;
}
