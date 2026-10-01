/** 本轮提示词输入追踪：只保存宿主已认领但尚未进入 user/message 的消息，排队的未来输入不参与冻结计划。 */
import type { Context } from '@deepseek-ai/cordis';
import type { TavernState } from './state.js';
export declare function registerPromptInputTracking(ctx: Context, state: TavernState): void;
