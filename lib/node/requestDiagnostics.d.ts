/** 在宿主 llm/stream 边界只读观察真实请求；不改冻结消息，不另开生成通道，不落盘。 */
import type { Context } from '@deepseek-ai/cordis';
import type { TavernState } from './state.js';
export declare function registerRequestDiagnostics(ctx: Context, state: TavernState): void;
