/**
 * 宏展开器（纯函数，除 MacroContext.store 为一次组装内的可变变量表）。
 *
 * 支持清单：
 * - `{{char}}` / `{{charname}}`：角色名
 * - `{{user}}` / `{{username}}`：用户人设名
 * - `{{outlet::Name}}`：世界书 Outlet；未匹配为空串。替换结果不再扫描（禁止嵌套 outlet）
 * - `{{time}}` / `{{date}}` / `{{datetime}}` / `{{weekday}}`：当前时间（可经 vars 覆盖）
 * - `{{trim}}` / `{{noop}}`：删除
 * - `{{//…}}`：注释，删除（社区预设用来写作者说明）
 * - `{{setvar::name::value}}` / `{{getvar::name}}`：一次组装内的变量表
 *   （setlocalvar/setglobalvar 视为 setvar；get* 同 getvar。不落盘。）
 * - `{{lastusermessage}}` / `{{lastMessage}}`：最近一条用户消息
 * - `{{random::A::B}}` / `{{pick::A,B}}` / `{{random:1,10}}`：掷骰（本轮宏，禁止进 standing）
 *
 * 这是组装前预处理：setvar 条目展开后变空，不进模型；getvar 处变成真正的写作规则。
 * 不是把 ST 宏引擎原样扔给模型。
 *
 * 未支持的宏保留原样并回调 onUnknown。
 */
import type { MacroContext } from './types.js';
export type { MacroContext };
/** 同一种子每次调用生成独立流；同一 turn 多步组装应各拿一份新流。 */
export declare function createTurnRandom(seed: number): () => number;
export declare function hashToSeed(text: string): number;
/**
 * 展开 text 中的宏。outlet 替换结果不二次扫描（SillyTavern：禁止嵌套 outlet）。
 * setvar/getvar 经 MacroContext.store 在一次组装内跨条目共享。
 */
export declare function expandMacros(text: string, ctx: MacroContext, now?: Date): string;
/**
 * 只展开身份宏。用于开场白展示、世界书扫描、入模历史——这些地方不该跑 setvar/时钟。
 * `{{user}}` 变成当前人设名，才能和世界书键互相命中。
 */
export declare function expandIdentityMacros(text: string, ctx: Pick<MacroContext, 'char' | 'user'>): string;
/** 收集文本中出现的宏名（调试用）。 */
export declare function listMacros(text: string): string[];
/** 条目是否含本轮才稳定的宏（应进 turnContext，避免打穿 standing KV）。 */
export declare function hasTurnLocalMacros(text: string): boolean;
/** SillyTavern EJS / STscript。本插件不执行，原文注入只会污染上下文。 */
export declare function hasUnevaluatedScript(text: string): boolean;
