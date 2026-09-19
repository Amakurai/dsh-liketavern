import type { PresetSamplingSettings, SamplingSettings } from './types.js';
export declare const MAX_PRESET_STOP_SEQUENCES = 16;
export declare const MAX_PRESET_STOP_CHARS = 1024;
export declare const MAX_PRESET_OUTPUT_TOKENS = 2000000;
/** 导入、存储、导出共用严格校验；不靠 TypeScript 类型信任外部 JSON。 */
export declare function parsePresetSampling(value: unknown): PresetSamplingSettings;
/** 顶层 stop 是兼容扩展；也接收随文件附带的 ST custom_stopping_strings JSON 数组字符串。 */
export declare function importStPresetSampling(raw: Record<string, unknown>, warnings: string[]): PresetSamplingSettings | undefined;
/** 导出只包含实际定义的字段，避免给旧预设补上默认值从而意外覆盖全局配置。 */
export declare function exportStPresetSampling(value: PresetSamplingSettings | undefined): Record<string, unknown>;
/** 每轮首次组装合并并复制一次；冻结计划之后沿用这份采样快照。 */
export declare function resolvePresetSampling(global: SamplingSettings, preset: PresetSamplingSettings | undefined): SamplingSettings;
