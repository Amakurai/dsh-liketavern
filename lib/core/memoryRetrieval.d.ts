/**
 * 长期记忆检索结果的纯函数治理：统一时间衰减参数，并在 token 预算内挑选正文。
 */
import type { MemoryEntry } from './types.js';
/** 配置天数转 BM25 的毫秒半衰期；0/非法值表示不衰减。 */
export declare function memorySearchOptions(topK: number, halfLifeDays: number): {
    topK: number;
    halfLifeMs?: number;
};
/**
 * 按相关性顺序装入预算。单条过大时继续寻找后续可完整放入的条目；
 * 若没有任何完整条目可用，则截取最高相关的超大条目，避免本轮记忆层完全为空。
 */
export declare function selectMemoryBodies(hits: readonly {
    entry: Pick<MemoryEntry, 'body'>;
}[], tokenBudget: number): string[];
