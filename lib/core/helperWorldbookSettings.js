/** 世界书全局设置兼容编解码；字段白名单、有界普通 JSON 与旧字段/原生字段一一对应。工厂可原样注入沙箱。 */
import { helperJson } from './helperRuntime.js';
export function createHelperWorldbookSettingsCodec(json) {
    const fields = { scan_depth: 'scanDepth', context_percentage: 'contextPercent', budget_cap: 'tokenBudget', min_activations: 'minActivations', max_depth: 'maxScanDepth', max_recursion_steps: 'maxRecursionSteps', insertion_strategy: 'characterStrategy', include_names: 'includeNames', recursive: 'recursiveScan', case_sensitive: 'caseSensitive', match_whole_words: 'matchWholeWords', use_group_scoring: 'useGroupScoring', overflow_alert: 'overflowWarning' };
    const choices = ['evenly', 'character_first', 'global_first'];
    function patch(input) {
        const value = json(input, 16384);
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new Error('世界书设置必须为对象');
        for (const [key, item] of Object.entries(value)) {
            if (key === 'selected_global_lorebooks') {
                if (!Array.isArray(item) || item.length > 64 || item.some(name => typeof name !== 'string' || !name.trim() || name.length > 256))
                    throw new Error('世界书选择必须为至多 64 项名称数组');
            }
            else if (!Object.hasOwn(fields, key))
                throw new Error('未知世界书设置字段：' + key);
            else if (key === 'insertion_strategy') {
                if (!choices.includes(item))
                    throw new Error('世界书插入策略无效');
            }
            else if (['include_names', 'recursive', 'case_sensitive', 'match_whole_words', 'use_group_scoring', 'overflow_alert'].includes(key)) {
                if (typeof item !== 'boolean')
                    throw new Error('世界书设置开关必须为布尔值');
            }
            else {
                const max = key === 'context_percentage' ? 100 : key === 'budget_cap' ? 1000000 : key === 'min_activations' ? 2000 : 1000;
                if (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > max || key !== 'context_percentage' && !Number.isInteger(item))
                    throw new Error('世界书设置数值越界：' + key);
            }
        }
        return value;
    }
    function toNative(input) { const value = patch(input), out = {}; for (const [key, item] of Object.entries(value)) {
        if (key === 'selected_global_lorebooks')
            continue;
        out[fields[key]] = key === 'insertion_strategy' ? choices.indexOf(item) : item;
    } return out; }
    function fromNative(input, selected) { const out = { selected_global_lorebooks: [...selected] }; for (const [key, native] of Object.entries(fields)) {
        const value = input[native];
        out[key] = key === 'insertion_strategy' ? choices[value] : value ?? 0;
    } return out; }
    function nativePatch(input) { const value = json(input, 16384); if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('会话世界书设置必须为对象'); const legacy = {}; for (const [native, item] of Object.entries(value)) {
        const key = Object.keys(fields).find(key => fields[key] === native);
        if (!key)
            throw new Error('未知会话世界书设置：' + native);
        legacy[key] = key === 'insertion_strategy' ? choices[item] : item;
    } return toNative(legacy); }
    return { patch, toNative, fromNative, nativePatch };
}
export const helperWorldbookSettingsCodec = createHelperWorldbookSettingsCodec(helperJson);
