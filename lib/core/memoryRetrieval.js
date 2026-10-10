import { clipToTokenBudget, estimateTokens } from './tokenize.js';
const DAY_MS = 24 * 60 * 60 * 1000;
/** 自动入模超取有界；最终条数仍由 retrievalTopK 单独限制。 */
export const MEMORY_CANDIDATE_LIMIT = 200;
const CANDIDATE_MULTIPLIER = 4;
/** 只对入模候选超取，手动 memory_search 仍使用 memorySearchOptions 的原始 topK。 */
export function memoryCandidateCount(topK) {
    const normalized = memorySearchOptions(topK, 0).topK;
    return Math.min(MEMORY_CANDIDATE_LIMIT, normalized * CANDIDATE_MULTIPLIER);
}
/**
 * 最新一条用户输入里的词在检索中额外加的倍数（与它在整段查询里的 1 倍合计 5 倍）。
 * 整段查询往往是几百字的叙述，一句短问题的几个词会被淹没；加权按命中分相加而不是按排名融合，
 * 所以闲聊输入偶然撞上的弱命中加不了多少分，不会挤掉前文场景的强命中。
 */
export const MEMORY_FOCUS_BOOST = 4;
/**
 * 自动入模的检索查询：取最近 count 条消息。窗口里最后一条是用户输入、且前面还有别的内容时，
 * 把它作为强调片段；续写或重新生成（最后一条是助手）以及只有这一条输入时不强调——
 * 后者全部词等比例放大，排序不变。
 */
export function memoryQuery(messages, count) {
    const size = Number.isFinite(count) ? Math.max(1, Math.floor(count)) : 1;
    const window = messages.slice(-size).filter((message) => message.content.trim());
    const query = window.map((message) => message.content).join('\n');
    const latest = messages.at(-1);
    if (window.length < 2 || latest?.role !== 'user' || !latest.content.trim())
        return { query };
    return { query, boost: { query: latest.content, weight: MEMORY_FOCUS_BOOST } };
}
/** 配置天数转 BM25 的毫秒半衰期；0/非法值表示不衰减。 */
export function memorySearchOptions(topK, halfLifeDays) {
    const normalizedTopK = Number.isFinite(topK) ? Math.max(0, Math.floor(topK)) : 0;
    const milliseconds = halfLifeDays * DAY_MS;
    const halfLifeMs = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined;
    return halfLifeMs === undefined ? { topK: normalizedTopK } : { topK: normalizedTopK, halfLifeMs };
}
/**
 * 按相关性顺序装入预算，跳过空正文与已选正文的重复项（仅忽略首尾空白），限制最终条数。
 * 同一完整叶来源集合的摘要优先保留首个可装入条目，其它摘要延后补位；来源原文不受影响。
 * 单条过大时继续寻找后续可完整放入的条目；
 * 若没有任何完整条目可用，则截取最高相关的超大条目，避免本轮记忆层完全为空。
 */
export function selectMemoryBodies(hits, tokenBudget, topK = hits.length) {
    const budget = Number.isFinite(tokenBudget) ? Math.max(0, Math.floor(tokenBudget)) : 0;
    const limit = memorySearchOptions(topK, 0).topK;
    if (budget === 0 || limit === 0)
        return [];
    const selected = [];
    const selectedBodies = new Set();
    const selectedSummarySources = new Set();
    const deferred = [];
    let used = 0;
    let firstOversized = null;
    const select = (hit, diversify) => {
        const body = hit.entry.body;
        const identity = body.trim();
        if (!identity || selectedBodies.has(identity))
            return;
        const sources = hit.summarySourceIds?.length ? JSON.stringify([...new Set(hit.summarySourceIds)].sort()) : undefined;
        if (diversify && sources && selectedSummarySources.has(sources)) {
            deferred.push(hit);
            return;
        }
        const tokens = estimateTokens(body);
        if (used + tokens <= budget) {
            selected.push(body);
            selectedBodies.add(identity);
            if (sources)
                selectedSummarySources.add(sources);
            used += tokens;
        }
        else if (firstOversized === null) {
            firstOversized = body;
        }
    };
    for (const hit of hits) {
        if (selected.length >= limit)
            break;
        select(hit, true);
    }
    for (const hit of deferred) {
        if (selected.length >= limit)
            break;
        select(hit, false);
    }
    if (selected.length > 0 || firstOversized === null)
        return selected;
    const clipped = clipToTokenBudget(firstOversized, budget);
    return clipped.text.trim() ? [clipped.text] : [];
}
