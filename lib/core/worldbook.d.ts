import { type WIEngineInput, type WIEngineResult, type WorldInfoEntry } from './types.js';
/**
 * 触发键字符数硬上限（归一化侧 state/lorebook.ts 导入共用，集中在此定义）：
 * 正常键是短语、正则键也在百级；超长键的扫描/回溯成本不可控。
 * 引擎侧超限键按「永不命中」处理（与非法正则键同口径），归一化侧直接拒绝导入。
 */
export declare const MAX_WI_KEY_CHARS = 500;
/**
 * 预算计费用的条目文本：EJS 的脚本段（`<% %>`、`<%_ %>`、`<%# %>`）不会出现在注入正文里，
 * 按源码计费会让「大段判断 + 少量输出」的条件条目挤掉真正要注入的常驻条目。
 * 只去掉脚本段，保留字面文本与输出标签（`<%= %>`/`<%- %>` 以源码长度近似输出）；
 * 各分支字面文本都计入，所以仍是保守上界。`<%%` 是字面转义，不当作脚本段。
 */
export declare function worldInfoBudgetText(content: string): string;
/**
 * 条目是否确定常驻：无本轮宏、概率、分组或定时条件。与 assemble 的渲染分流
 * 共用同一判定，两处不得漂移。standing 侧条目豁免 turn 层预算（走钉死的 system 段，
 * 命中前缀缓存；live 通道体积由 node/pipeline 单独检查）。
 */
export declare function isStandingSafeEntry(entry: WorldInfoEntry): boolean;
/**
 * 引擎计费与组装分流共用的 standing 判定（两处必须调用同一函数，不得各自实现）。
 *
 * 组装侧（assemble.ts）传入自己的宏依赖判定 isDynamic，能精确识别「本轮才变」的条目；
 * 引擎侧在求值阶段拿不到组装期的变量依赖图，传 undefined 时按「正文不读取任何变量」的
 * 保守口径：宁可把静态 getvar 条目也计费，也不能把组装会改送 turn 的条目当 standing 豁免——
 * 否则 tokenBudget 对实际注入的正文失效（条目豁免了预算却每轮全价进 runtime context 快照）。
 * 残留差异只在「条目引用角色字段、而该字段自身含变量读取」这一种情况（引擎看不到字段值）。
 */
export declare function isStandingBudgetSafe(entry: WorldInfoEntry, isDynamic?: (text: string) => boolean): boolean;
/**
 * 求值一轮世界书触发。返回激活条目（按位置分桶）、触发日志与新的定时状态。
 * 纯函数：不修改入参；timerState 的持久化由调用方经事务层完成。
 */
export declare function evaluateWorldInfo(input: WIEngineInput): WIEngineResult;
