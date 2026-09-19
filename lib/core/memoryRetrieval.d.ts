/**
 * 长期记忆检索结果的纯函数治理：统一时间衰减参数，并在 token 预算内挑选正文。
 */
import type { MemoryEntry } from './types.js';
/** 自动入模超取有界；最终条数仍由 retrievalTopK 单独限制。 */
export declare const MEMORY_CANDIDATE_LIMIT = 200;
/** 只对入模候选超取，手动 memory_search 仍使用 memorySearchOptions 的原始 topK。 */
export declare function memoryCandidateCount(topK: number): number;
/** 摘要的完整叶来源集合由存储层按当前剧情解析；普通原文不设此字段，始终可补充摘要细节。 */
export interface MemoryBodyCandidate {
    entry: Pick<MemoryEntry, 'body'>;
    summarySourceIds?: readonly string[];
}
/** 配置天数转 BM25 的毫秒半衰期；0/非法值表示不衰减。 */
export declare function memorySearchOptions(topK: number, halfLifeDays: number): {
    topK: number;
    halfLifeMs?: number;
};
/**
 * 按相关性顺序装入预算，跳过空正文与已选正文的重复项（仅忽略首尾空白），限制最终条数。
 * 同一完整叶来源集合的摘要优先保留首个可装入条目，其它摘要延后补位；来源原文不受影响。
 * 单条过大时继续寻找后续可完整放入的条目；
 * 若没有任何完整条目可用，则截取最高相关的超大条目，避免本轮记忆层完全为空。
 */
export declare function selectMemoryBodies(hits: readonly MemoryBodyCandidate[], tokenBudget: number, topK?: number): string[];
