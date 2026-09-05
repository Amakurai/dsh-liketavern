/**
 * 宏展开器（纯函数，除 MacroContext.store 为一次组装内的可变变量表）。
 *
 * 支持清单：
 * - `{{char}}` / `{{charname}}`：角色名
 * - `{{user}}` / `{{username}}`：用户人设名
 * - `{{description}}` / `{{personality}}` / `{{scenario}}`：角色卡字段
 * - `{{persona}}`：当前用户人设描述
 * - `{{charFirstMessage}}` / `{{firstMessage}}`：角色开场白（ST 拼写为 charFirstMessage）
 * - `{{outlet::Name}}`：世界书 Outlet；未匹配为空串。替换结果不再扫描（禁止嵌套 outlet）
 * - `{{time}}` / `{{date}}` / `{{datetime}}` / `{{weekday}}`：当前时间（可经 vars 覆盖）
 * - `{{trim}}` / `{{noop}}`：删除
 * - `{{//…}}`：注释，删除（社区预设用来写作者说明）
 * - `{{setvar::name::value}}` / `{{getvar::name}}`：一次组装内的变量表
 *   （setlocalvar/setglobalvar 视为 setvar；get* 同 getvar。不落盘。）
 * - `{{lastusermessage}}` / `{{lastMessage}}`：最近一条用户消息
 * - `{{lastCharMessage}}`：最近一条 assistant 消息（本轮宏，禁止进 standing）
 * - `{{random::A::B}}` / `{{pick::A,B}}` / `{{random:1,10}}`：掷骰（本轮宏，禁止进 standing）
 *
 * 这是组装前预处理：setvar 条目展开后变空，不进模型；getvar 处变成真正的写作规则。
 * 不是把 ST 宏引擎原样扔给模型。
 *
 * 未支持的宏保留原样并回调 onUnknown。
 *
 * `postProcess` 逐个加工「宏解析出来的值」（对齐 ST substituteParamsExtended 的 postProcessFn）：
 * 正则 find 的转义代入、正则 replace 的 `$` 保护都靠它，宏之外的原文不受影响。
 */
import type { MacroContext } from './types.js';
export type { MacroContext };
/** 同一种子每次调用生成独立流；同一 turn 多步组装应各拿一份新流。 */
export declare function createTurnRandom(seed: number): () => number;
export declare function hashToSeed(text: string): number;
/**
 * 展开 text 中的宏。outlet 替换结果不二次扫描（SillyTavern：禁止嵌套 outlet）。
 * setvar/getvar 经 MacroContext.store 在一次组装内跨条目共享。
 *
 * postProcess 只作用于每个宏解析出来的值（不碰模板里的原文），调用方用它做
 * 正则转义或 `$` 保护。now 保持第三位，老调用方（只传 text/ctx 或再带 now）不受影响。
 */
export declare function expandMacros(text: string, ctx: MacroContext, now?: Date, postProcess?: (value: string) => string): string;
/**
 * 只展开身份宏。用于开场白展示、世界书扫描、入模历史——这些地方不该跑 setvar/时钟。
 * `{{user}}` 变成当前人设名，才能和世界书键互相命中。
 */
export declare function expandIdentityMacros(text: string, ctx: Pick<MacroContext, 'char' | 'user'>): string;
/** 条目是否含本轮才稳定的宏（应进 turnContext，避免打穿 standing KV）。 */
export declare function hasTurnLocalMacros(text: string): boolean;
/** 检测尚未处理的 EJS / STscript；EJS 由隔离执行器展开，STscript 仍不执行。 */
export declare function hasUnevaluatedScript(text: string): boolean;
