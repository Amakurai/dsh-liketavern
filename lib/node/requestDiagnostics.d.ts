/** 在宿主 llm/stream 边界只读观察真实请求；不改冻结消息，不另开生成通道，不落盘。 */
import type { Context } from '@deepseek-ai/cordis';
import type { GenerateOptions } from '@deepseek-ai/dsh-llm';
import type { TavernState } from './state.js';
/** 同一有界缓存既记录宿主输入，也允许布局适配器覆盖为实际投影后的消息。 */
export declare function recordRequestDiagnostics(state: TavernState, id: string, options: GenerateOptions, stage?: 'host' | 'tavern-adapter', projectionNotes?: readonly string[]): void;
export declare function registerRequestDiagnostics(ctx: Context, state: TavernState): void;
