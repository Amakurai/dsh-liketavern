import { type WIEngineInput, type WIEngineResult, type WorldInfoEntry } from './types.js';
/**
 * 触发键字符数硬上限（归一化侧 state/lorebook.ts 导入共用，集中在此定义）：
 * 正常键是短语、正则键也在百级；超长键的扫描/回溯成本不可控。
 * 引擎侧超限键按「永不命中」处理（与非法正则键同口径），归一化侧直接拒绝导入。
 */
export declare const MAX_WI_KEY_CHARS = 500;
/**
 * 条目是否确定常驻：无本轮宏、概率、分组或定时条件。与 assemble 的渲染分流
 * 共用同一判定，两处不得漂移。standing 侧条目豁免 turn 层预算（走钉死的 system 段，
 * 命中前缀缓存；live 通道体积由 node/pipeline 单独检查）。
 */
export declare function isStandingSafeEntry(entry: WorldInfoEntry): boolean;
/**
 * 求值一轮世界书触发。返回激活条目（按位置分桶）、触发日志与新的定时状态。
 * 纯函数：不修改入参；timerState 的持久化由调用方经事务层完成。
 */
export declare function evaluateWorldInfo(input: WIEngineInput): WIEngineResult;
