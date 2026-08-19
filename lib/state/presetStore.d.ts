/**
 * SillyTavern 预设（Prompt Manager）JSON ⇄ PromptPreset。
 *
 * ST 预设形态：{prompts: [...], prompt_order: [{character_id, order: [{identifier, enabled}]}]}。
 * `prompts` 是条目库；真正的栈与开关在 prompt_order 里。Chat Completion 用 dummy
 * character_id 100001（openai.js）；PromptManager 构造默认曾是 100000，社区预设常同时带着
 * 一份只含内建槽位的 100000 骨架——导入必须优先 100001，不能取数组第一项。
 * 未列入所选 order 的库条目关闭并附在栈末，记一条摘要（不逐条 warning）。
 * 无 prompt_order 时全部启用。relative 条目的 order 取自栈序；in-chat 仍用 injection_order。
 * `extensions.regex_scripts` 原样挂到 PromptPreset.regexScripts（编译在 rulesFor）。
 */
import type { PromptPreset } from '../core/types.js';
export interface ParseStPresetResult {
    preset: PromptPreset;
    warnings: string[];
}
/**
 * 解析 ST 预设 JSON。缺 prompts 数组时抛中文错误；
 * 无法映射的字段与条目不中断导入，记入 warnings。
 */
export declare function parseStPreset(json: unknown): ParseStPresetResult;
/** 导出为 ST 形态：prompts + 单个 prompt_order（character_id 100001）。 */
export declare function exportStPreset(preset: PromptPreset): unknown;
