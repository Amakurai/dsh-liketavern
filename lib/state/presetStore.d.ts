import type { PromptPreset } from '../core/types.js';
export interface ParseStPresetResult {
    preset: PromptPreset;
    warnings: string[];
}
/**
 * 解析 ST 预设 JSON。缺 prompts 数组时抛中文错误；
 * 无法映射的条目不中断导入，记入 warnings。
 */
export declare function parseStPreset(json: unknown): ParseStPresetResult;
/** 导出为 ST 形态：prompts + 单个 prompt_order（character_id 100001）。 */
export declare function exportStPreset(preset: PromptPreset): unknown;
