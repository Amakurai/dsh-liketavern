import { clipToTokenBudget, estimateTokens } from './tokenize.js';
const DAY_MS = 24 * 60 * 60 * 1000;
/** 配置天数转 BM25 的毫秒半衰期；0/非法值表示不衰减。 */
export function memorySearchOptions(topK, halfLifeDays) {
    const normalizedTopK = Math.max(0, Math.floor(topK));
    const halfLifeMs = Number.isFinite(halfLifeDays) && halfLifeDays > 0 ? halfLifeDays * DAY_MS : undefined;
    return halfLifeMs === undefined ? { topK: normalizedTopK } : { topK: normalizedTopK, halfLifeMs };
}
/**
 * 按相关性顺序装入预算。单条过大时继续寻找后续可完整放入的条目；
 * 若没有任何完整条目可用，则截取最高相关的超大条目，避免本轮记忆层完全为空。
 */
export function selectMemoryBodies(hits, tokenBudget) {
    const budget = Math.max(0, Math.floor(tokenBudget));
    if (budget === 0)
        return [];
    const selected = [];
    let used = 0;
    let firstOversized = null;
    for (const hit of hits) {
        const body = hit.entry.body;
        const tokens = estimateTokens(body);
        if (used + tokens <= budget) {
            selected.push(body);
            used += tokens;
        }
        else if (firstOversized === null) {
            firstOversized = body;
        }
    }
    if (selected.length > 0 || firstOversized === null)
        return selected;
    const clipped = clipToTokenBudget(firstOversized, budget);
    return clipped.text.trim() ? [clipped.text] : [];
}
