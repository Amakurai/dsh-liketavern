/** 预设的纯数据导出：面板与后端共用完整 ST 格式，保留条目纪律并遵守脚本数据导出设置。 */
import type { PresetEntry, PromptPreset } from './types.js';
/** ST 的 system_prompt 标记内建条目，与模型消息 role 独立；旧数据按官方内建槽位回退。 */
export declare function isStSystemPrompt(entry: Pick<PresetEntry, 'identifier' | 'marker' | 'systemPrompt'>): boolean;
export declare function exportStPreset(preset: PromptPreset): unknown;
