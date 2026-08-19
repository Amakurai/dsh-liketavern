/**
 * 世界书 JSON ⇄ 归一化 WorldInfoEntry。
 *
 * 兼容三种输入外形：
 * 1. SillyTavern 原生 World Info 文件：{entries: {"0": {...}}}（对象 map，map 键即 uid）。
 * 2. {entries: [...]}（数组；条目按字段特征逐个判定为原生 WI 或 character_book 形态）。
 * 3. 角色卡 character_book 的条目数组（顶层即数组，或 entries 为数组且条目带 keys/extensions 等特征）。
 *
 * 字段容错：字符串数字转 number、非 boolean 转 boolean；非法 position/selectiveLogic/role 回落默认；
 * 条目级 null（caseSensitive/matchWholeWords/scanDepth/sticky/cooldown/delay）保留 null = 跟随全局。
 */
import type { WISource, WorldDelta, WorldInfoEntry } from '../core/types.js';
export interface ParseLorebookOptions {
    source: WISource;
    sourceRef: string;
}
/**
 * 解析世界书 JSON 为归一化条目数组。
 * 非对象/缺 entries 时抛中文错误；非对象条目静默跳过。
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
