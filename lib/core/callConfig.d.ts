/**
 * 把 Tavern 采样合入 dsh LlmCallConfig。
 * reasoningEffort 是适配器私有 id：只发送模型公布的档位，避免 UNSUPPORTED_REASONING_EFFORT。
 * 公布档不可用时的兜底（含 deepseek-official 关思考）统一走 resolveTavernReasoningEffort。
 */
import type { SamplingSettings } from './types.js';
export interface AdvertisedReasoning {
    id: string;
}
/** 模型公布的 reasoning 元数据（结构对齐 dsh 的 `LlmResolvedModelInfo['reasoning']`；core 不依赖平台类型）。 */
export interface AdvertisedReasoningInfo {
    efforts?: readonly AdvertisedReasoning[];
    defaultEffort?: string;
}
/**
 * 按 Tavern「深度思考」设置挑选 reasoningEffort。
 * disabled → 公布的 off 档（没有则 undefined，调用方不得瞎填）；
 * low/high → 模型公布了该档则显式指定，否则回退自动；
 * enabled → 自动：保留会话已选的非 off 档，否则模型默认，否则第一个非 off 档。
 */
export declare function pickReasoningEffort(thinking: SamplingSettings['thinking'], efforts: readonly AdvertisedReasoning[] | undefined, defaultEffort: string | undefined, current: string | undefined): string | undefined;
/**
 * 三级挑选 reasoningEffort：agent/request 与 impersonate 共用这一处，别再各写一份。
 * ① 模型公布档 → `pickReasoningEffort`；
 * ② 公布档给不出结果、且深度思考关闭的 deepseek-official → `off`（元数据解析失败时也要关得掉）；
 * ③ 其余按「无公布信息」自动挑选（关闭则不瞎填）。
 * 放在 core：本函数只做纯挑选、绝不抛错；llm 服务与可能抛错的模型元数据解析留在各自的 node 调用点，
 * 解析失败就传 `undefined` 的 reasoning 进来。
 */
export declare function resolveTavernReasoningEffort(thinking: SamplingSettings['thinking'], reasoning: AdvertisedReasoningInfo | undefined, current: string | undefined, provider: string | undefined): string | undefined;
export interface CallConfigPatch {
    temperature?: number;
    maxTokens?: number;
    stop?: string[];
    reasoningEffort?: string;
}
/** 透传 temperature / maxTokens / stop，并在有合法档位时写入 reasoningEffort。 */
export declare function mergeTavernCallConfig<T extends CallConfigPatch>(config: T, sampling: SamplingSettings, reasoningEffort: string | undefined): T;
