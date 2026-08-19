/**
 * 把 Tavern 采样合入 dsh LlmCallConfig。
 * reasoningEffort 是适配器私有 id：只发送模型公布的档位，避免 UNSUPPORTED_REASONING_EFFORT。
 */
import type { SamplingSettings } from './types.js';
export interface AdvertisedReasoning {
    id: string;
}
/**
 * 按 Tavern「深度思考」开关挑选 reasoningEffort。
 * 关 → 公布的 off 档（没有则 undefined，调用方不得瞎填）；
 * 开 → 保留会话已选的非 off 档，否则模型默认，否则第一个非 off 档。
 */
export declare function pickReasoningEffort(thinking: SamplingSettings['thinking'], efforts: readonly AdvertisedReasoning[] | undefined, defaultEffort: string | undefined, current: string | undefined): string | undefined;
export interface CallConfigPatch {
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
    reasoningEffort?: string;
}
/** 透传 temperature / maxTokens / stop，并在有合法档位时写入 reasoningEffort。 */
export declare function mergeTavernCallConfig<T extends CallConfigPatch>(config: T, sampling: SamplingSettings, reasoningEffort: string | undefined): T;
