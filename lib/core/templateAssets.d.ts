/** 角色模板的数据快照：提供 ST 常用根字段与 data 字段，只复制角色资产，不携带 PNG 或内部存储记录。 */
import type { CharacterCard } from './types.js';
export declare function templateCardData(card: CharacterCard): Record<string, unknown>;
