/**
 * 预设采样的数据边界与 ST 字段映射。
 * 只解析明确支持的字段；停止序列有界，非法值明确拒绝；不把任意预设字段透传给模型。
 * top_p 与惩罚值保留供展示/导出，是否透传仍由 callConfig 的宿主契约决定。
 */
import { array, maxLength, maximum, minimum, nullable, number, optional, safeParse, string, strictObject } from 'zod/mini';
export const MAX_PRESET_STOP_SEQUENCES = 16;
export const MAX_PRESET_STOP_CHARS = 1024;
export const MAX_PRESET_OUTPUT_TOKENS = 2_000_000;
const samplingSchema = strictObject({
    temperature: optional(number().check(minimum(0), maximum(2))),
    topP: optional(number().check(minimum(0), maximum(1))),
    maxTokens: optional(nullable(number().check(minimum(1), maximum(MAX_PRESET_OUTPUT_TOKENS)))),
    stop: optional(array(string().check(maxLength(MAX_PRESET_STOP_CHARS))).check(maxLength(MAX_PRESET_STOP_SEQUENCES))),
    presencePenalty: optional(number().check(minimum(-2), maximum(2))),
    frequencyPenalty: optional(number().check(minimum(-2), maximum(2))),
});
/** 导入、存储、导出共用严格校验；不靠 TypeScript 类型信任外部 JSON。 */
export function parsePresetSampling(value) {
    const result = safeParse(samplingSchema, value);
    if (!result.success)
        throw new Error(`预设采样参数无效：${result.error.message}`);
    const sampling = result.data;
    if (sampling.maxTokens !== undefined && sampling.maxTokens !== null && !Number.isSafeInteger(sampling.maxTokens)) {
        throw new Error('预设采样 maxTokens 必须是整数');
    }
    if (sampling.stop?.some(stop => stop.length === 0))
        throw new Error('预设采样 stop 不能包含空字符串');
    return sampling;
}
const ST_NUMBER_FIELDS = [
    ['temperature', 'temperature'], ['top_p', 'topP'], ['openai_max_tokens', 'maxTokens'],
    ['presence_penalty', 'presencePenalty'], ['frequency_penalty', 'frequencyPenalty'],
];
/** ST 数值历史上也可能序列化为数字字符串；错型仍交给严格校验拒绝。 */
function importedNumber(value) {
    if (typeof value === 'string' && value.trim() !== '')
        return Number(value);
    return value;
}
/** 顶层 stop 是兼容扩展；也接收随文件附带的 ST custom_stopping_strings JSON 数组字符串。 */
export function importStPresetSampling(raw, warnings) {
    const candidate = {};
    if (raw.reasoning_effort !== undefined) {
        warnings.push('未应用预设 reasoning_effort；ST 的模型专用映射不通用，思考档位仍由插件与宿主模型设置决定');
    }
    for (const [source, target] of ST_NUMBER_FIELDS) {
        if (raw[source] !== undefined)
            candidate[target] = importedNumber(raw[source]);
    }
    if (raw.stop !== undefined) {
        candidate.stop = typeof raw.stop === 'string' ? [raw.stop] : raw.stop;
    }
    else if (raw.custom_stopping_strings !== undefined) {
        const encoded = raw.custom_stopping_strings;
        if (typeof encoded !== 'string' || encoded.length > MAX_PRESET_STOP_SEQUENCES * (MAX_PRESET_STOP_CHARS * 6 + 4) + 2) {
            throw new Error('预设采样 custom_stopping_strings 必须是有界 JSON 数组字符串');
        }
        try {
            candidate.stop = encoded === '' ? [] : JSON.parse(encoded);
        }
        catch {
            throw new Error('预设采样 custom_stopping_strings 不是有效的 JSON 数组');
        }
    }
    if (Object.keys(candidate).length === 0)
        return undefined;
    const sampling = parsePresetSampling(candidate);
    const retained = ST_NUMBER_FIELDS.filter(([source, target]) => (target === 'topP' || target === 'presencePenalty' || target === 'frequencyPenalty') && raw[source] !== undefined)
        .map(([source]) => source);
    if (retained.length > 0)
        warnings.push(`已保留 ${retained.join('、')}；当前宿主不透传这些采样参数`);
    if (raw.custom_stopping_strings_macro && sampling.stop?.some(stop => stop.includes('{{'))) {
        warnings.push('停止序列中的 ST 宏按字面保留，当前预设采样不展开宏');
    }
    return sampling;
}
/** 导出只包含实际定义的字段，避免给旧预设补上默认值从而意外覆盖全局配置。 */
export function exportStPresetSampling(value) {
    if (value === undefined)
        return {};
    const sampling = parsePresetSampling(value);
    const result = {};
    for (const [target, source] of ST_NUMBER_FIELDS) {
        if (sampling[source] !== undefined)
            result[target] = sampling[source];
    }
    if (sampling.stop !== undefined)
        result.stop = [...sampling.stop];
    return result;
}
/** 每轮首次组装合并并复制一次；冻结计划之后沿用这份采样快照。 */
export function resolvePresetSampling(global, preset) {
    const overrides = preset === undefined ? {} : parsePresetSampling(preset);
    // 显式 undefined 等同于未提供；空 stop 和 null maxTokens 是有意清除全局预设值。
    const defined = Object.fromEntries(Object.entries(overrides).filter(([, value]) => value !== undefined));
    return { ...global, ...defined, stop: [...(overrides.stop ?? global.stop)] };
}
