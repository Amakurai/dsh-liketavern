import { type WIEngineInput, type WIEngineResult } from './types.js';
/**
 * 求值一轮世界书触发。返回激活条目（按位置分桶）、触发日志与新的定时状态。
 * 纯函数：不修改入参；timerState 的持久化由调用方经事务层完成。
 */
export declare function evaluateWorldInfo(input: WIEngineInput): WIEngineResult;
