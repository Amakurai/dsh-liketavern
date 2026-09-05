/** 将世界书头部装饰器归一到现有位置与启用规则；条件交给隔离沙箱在 WI 扫描前判断。 */
import type { WorldInfoEntry } from './types.js';
export declare function normalizeTemplateLore(entry: WorldInfoEntry): WorldInfoEntry;
/** ST 特殊条目只映射到 Tavern 自有通道；绝对消息定位需要独立适配，不能悄悄降级。 */
export declare function templateLoreEntries(entries: WorldInfoEntry[]): WorldInfoEntry[];
