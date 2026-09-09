import type { PromptPreset } from '../core/types.js';
export { exportStPreset } from '../core/presetExport.js';
/** 保存、磁盘读取共用的数据边界；返回独立副本，保留内部条目顺序及脚本私有数据。 */
export declare function parseStoredPreset(value: unknown): PromptPreset;
export interface ParseStPresetResult {
    preset: PromptPreset;
    warnings: string[];
}
/**
 * 解析 ST 预设 JSON。缺 prompts 数组时抛中文错误；
 * 无法映射的条目不中断导入，记入 warnings。
 */
export declare function parseStPreset(json: unknown): ParseStPresetResult;
