import type { CharacterCard, PromptPreset, RegexRule } from '../core/types.js';
import type { Persona } from '../core/persona.js';
export declare function characterEditRevision(card: CharacterCard): string;
/** 人设编辑同样按用户可编辑字段生成版本；传输版本不写回资产，缺省世界书与 null 等价。 */
export declare function personaEditRevision(persona: Persona): string;
/** 整表正则版本保留规则顺序与全部执行字段，避免只改名称或开关时覆盖另一窗口的匹配式。 */
export declare function regexEditRevision(rules: RegexRule[]): string;
/** 世界书版本来自实际读取/写入的完整 JSON，包含当前绑定及保留副本，不能只比较可见条目。 */
export declare function jsonEditRevision(value: unknown): string;
/** 脚本库有独立版本且由保存端保留；其余预设字段（包括扩展字段）都参与冲突校验。 */
export declare function presetEditRevision(preset: PromptPreset): string;
