import type { WISource, WorldDelta, WorldInfoEntry } from '../core/types.js';
/** 单文件条目数上限：社区大书在千级，2000 已留足余量。预设（presetStore）同口径复用。 */
export declare const MAX_LOREBOOK_ENTRIES = 2000;
/**
 * 单条正文字符数上限：≈2.5 万 token，超出任何合理条目。
 * 预设（presetStore）单条 prompt 正文同口径复用。
 */
export declare const MAX_LOREBOOK_CONTENT_CHARS = 100000;
export interface ParseLorebookOptions {
    source: WISource;
    sourceRef: string;
}
/**
 * 解析世界书 JSON 为归一化条目数组。
 * 非对象/缺 entries 时抛中文错误；条目数/正文/键超限或键容器、content 错型同样抛错拒绝导入。
 */
export declare function parseLorebook(json: unknown, opts: ParseLorebookOptions): WorldInfoEntry[];
/**
 * 导出为 SillyTavern 原生形态 {entries: {<uid>: {...}}}（camelCase 字段对齐原生 WI JSON）。
 * name 不写入文件（ST 原生世界书 JSON 无此字段），保留在签名中供调用方传递命名上下文。
 */
export declare function exportLorebook(entries: WorldInfoEntry[], name: string): unknown;
/**
 * 固化导出用：把生效中的 delta 合并进原书条目，返回新数组（不改入参）。
 * - update → 替换 ref 条目 content
 * - invalidate → 标记 ref 条目 enabled=false
 * - add → 追加新条目（source 'global'，uid `delta-<id>`，position 默认 AfterCharDefs）
 * revoked 与已过期（expires <= 当前时间）的 delta 忽略；ref 未命中的 update/invalidate 同样忽略。
 */
export declare function mergeDeltasForExport(originals: WorldInfoEntry[], deltas: WorldDelta[]): WorldInfoEntry[];
