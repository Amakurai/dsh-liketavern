import { exportHelperScriptTrees, helperScriptSettings } from './helperScripts.js';
export function exportStPreset(preset) {
    const prompts = preset.entries.map((entry) => ({
        identifier: entry.identifier,
        name: entry.name,
        role: entry.role,
        content: entry.content,
        marker: entry.marker,
        system_prompt: entry.role === 'system',
        injection_position: entry.position === 'in-chat' ? 1 : 0,
        injection_depth: entry.depth,
        injection_order: entry.order,
        ...(entry.forbidOverrides ? { forbid_overrides: true } : {}),
        ...(entry.extension ? { extension: true } : {}),
        ...(entry.injectionTrigger?.length ? { injection_trigger: [...entry.injectionTrigger] } : {}),
    }));
    const order = preset.entries.map((entry) => ({ identifier: entry.identifier, enabled: entry.enabled }));
    const exported = {
        name: preset.name,
        identifier: preset.identifier,
        prompts,
        prompt_order: [{ character_id: 100001, order }],
    };
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
