/**
 * 角色卡 data 投影：保留 V3/未来规范的直接字段位置，同时将已建模字段和扩展留给调用方覆盖。
 * 导入时为了运行兼容，直接未知字段也会镜像到 CharacterCard.extensions；
 * 导出与模板快照必须借助 raw 还原来源，不能因此把 data.assets 搬成 data.extensions.assets。
 */
import type { CharacterCard } from './types.js';
/** 与卡解析器一致：别名只在真能归一化为非空世界书时才具有业务语义。 */
export declare function isNonEmptyCharacterBook(value: unknown): boolean;
/**
 * 归一化时判定字段是否已消费；无效 lorebook/characterBook 只是厂商自定义字段，
 * 必须像其它未知 V3 字段一样镜像并保留原位置。
 */
export declare function isKnownCharacterDataKey(key: string, value: unknown): boolean;
export interface CharacterDataExtras {
    /** 保持在 data 根上的 V3/自定义字段。 */
    fields: Record<string, unknown>;
    /** 仍属于 data.extensions 的字段。 */
    extensions: Record<string, unknown>;
}
/**
 * CCv3 nickname 只改变提示词里的角色身份（包括 {{char}}）；
 * 资产列表、标题和绑定仍展示稳定的 card.name。
 */
export declare function characterPromptName(card: CharacterCard): string;
/**
 * 从原始卡片记住未建模字段的原位置，再用当前 extensions 中的镜像值覆盖。
 * raw 只负责判定来源，不能作为普通 nested 扩展的值回退，否则用户删掉的旧脚本会复活；
 * 唯一例外是 direct/nested 同名冲突，此时扁平镜像只能表达 direct，raw 才是 nested 的唯一副本。
 */
export declare function characterDataExtras(card: CharacterCard): CharacterDataExtras;
