/** 记忆工具的完整 JSON 预算：正文优先，展示标签可裁剪，定位字段完整保留或明确省略；不修改存储条目。 */
import { clipAssetJsonText, countPrettyArrayItemChars, resolveReadableAssetPath, stabilizeJsonTokenCount, stampAssetTokens } from './assetRead.js';
import { countTokenChars } from './tokenize.js';
/**
 * 库里有记忆却一条都没匹配上时给模型的提示。检索只看字面：问「谁在偷药」找不到写着「止痛剂少了两箱」的记忆，
 * 这种情况靠模型换一个说法重查，或者去看目录里的摘要，而不是当作没有这件事。
 */
export const MEMORY_SEARCH_NO_MATCH_HINT = '没有匹配。记忆按字面检索：换成记忆里会出现的人名、物名或近义的说法再查一次；仍没有时用 tavern_asset_list 看 memory 目录里的摘要。';
/**
 * 小于合法响应头的预算不能表达 JSON，返回固定业务拒绝；成功时 tokensUsed 严格计入最终自身字段。
 * emptyHint 只在没有任何命中时附上（预算容不下就不附）；库本身为空时调用方不应传它。
 */
export function budgetMemorySearch(hits, budget, options) {
    const limit = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : 0;
    const results = [];
    const out = { ok: true, count: hits.length, omitted: hits.length,
        truncated: hits.length > 0, tokensUsed: 0, results };
    const shellCache = new Map();
    const shellCounts = (len, truncated, hasHint) => {
        const key = `${len}:${truncated ? 1 : 0}:${hasHint ? 1 : 0}`;
        let cached = shellCache.get(key);
        if (!cached) {
            const shell = { ok: true, count: hits.length, omitted: hits.length - len, truncated, tokensUsed: 0,
                results: [], ...(hasHint && out.hint ? { hint: out.hint } : {}) };
            cached = countTokenChars(JSON.stringify(shell, null, 2));
            shellCache.set(key, cached);
        }
        return cached;
    };
    let anyPrevTruncated = false;
    let itemsCjk = 0;
    let itemsOther = 0;
    const refresh = () => {
        out.omitted = hits.length - results.length;
        out.truncated = out.omitted > 0 || results.some((r) => r.truncated || r.metadataTruncated);
        return stampAssetTokens(out).tokensUsed;
    };
    if (refresh() > limit)
        return stampAssetTokens({ ok: false, error: 'memory-budget-too-small：预算不足以容纳完整 JSON 响应', tokensUsed: 0 });
    if (hits.length === 0) {
        if (options?.emptyHint) {
            out.hint = options.emptyHint;
            if (refresh() > limit) {
                delete out.hint;
                refresh();
            }
        }
        return out;
    }
    if (hits.length) {
        out.hint = '部分内容已裁剪或省略；可用返回的完整 path 按条读取。';
        if (refresh() > limit)
            delete out.hint;
    }
    const hasHint = Boolean(out.hint);
    for (const hit of hits) {
        const path = `memory/${hit.entry.file}`;
        const readable = resolveReadableAssetPath(path);
        if (!readable.ok || readable.path !== path)
            continue;
        const item = { id: hit.entry.id, path, archived: hit.entry.archived, sourceRange: hit.entry.sourceRange,
            score: hit.score, tags: [], keys: [], body: '', truncated: hit.entry.body.length > 0,
            metadataTruncated: hit.entry.tags.length > 0 || hit.entry.keys.length > 0,
            tagsTruncated: hit.entry.tags.length > 0, keysTruncated: hit.entry.keys.length > 0 };
        results.push(item);
        const nextLen = results.length;
        const itemDeltaWithSource = countPrettyArrayItemChars(item, 2);
        const estimateWithItem = (delta, itemTrunc) => {
            const shell = shellCounts(nextLen, hits.length > nextLen || anyPrevTruncated || itemTrunc, hasHint);
            return stabilizeJsonTokenCount(shell.cjk + itemsCjk + delta.cjk, shell.other + 2 + 2 * nextLen + itemsOther + delta.other);
        };
        if (estimateWithItem(itemDeltaWithSource, true) > limit) {
            delete item.sourceRange;
            item.sourceRangeOmitted = true;
            item.metadataTruncated = true;
            const itemDeltaNoSource = countPrettyArrayItemChars(item, 2);
            if (estimateWithItem(itemDeltaNoSource, true) > limit) {
                results.pop();
                continue;
            }
        }
        const baseDelta = item.sourceRangeOmitted ? countPrettyArrayItemChars(item, 2) : itemDeltaWithSource;
        // 留给布尔标记和 tokensUsed 数位变化的余量来自本响应预算，不增加输出上限。
        const usedBeforeBody = estimateWithItem(baseDelta, true);
        const body = clipAssetJsonText(hit.entry.body, limit - usedBeforeBody - 16);
        item.body = body.text;
        item.truncated = body.truncated;
        let itemDelta = countPrettyArrayItemChars(item, 2);
        let itemTruncated = item.truncated || item.metadataTruncated;
        const fill = (field, source) => {
            let clipped = false;
            for (const value of source) {
                const usedSoFar = estimateWithItem(itemDelta, true);
                const text = clipAssetJsonText(value, limit - usedSoFar - 8);
                if (!text.text && value) {
                    clipped = true;
                    break;
                }
                item[field].push(text.text);
                const nextDelta = countPrettyArrayItemChars(item, 2);
                if (estimateWithItem(nextDelta, true) > limit) {
                    item[field].pop();
                    clipped = true;
                    break;
                }
                itemDelta = nextDelta;
                if (text.truncated) {
                    clipped = true;
                    break;
                }
            }
            return clipped || item[field].length < source.length;
        };
        item.keysTruncated = fill('keys', hit.entry.keys);
        item.tagsTruncated = fill('tags', hit.entry.tags);
        item.metadataTruncated = item.keysTruncated || item.tagsTruncated || Boolean(item.sourceRangeOmitted);
        itemTruncated = item.truncated || item.metadataTruncated;
        itemDelta = countPrettyArrayItemChars(item, 2);
        // 不允许预算耗尽后继续输出下一条的标签；随后条目仍可因定位较短而装入。
        if (estimateWithItem(itemDelta, itemTruncated) > limit) {
            results.pop();
            continue;
        }
        anyPrevTruncated ||= itemTruncated;
        itemsCjk += itemDelta.cjk;
        itemsOther += itemDelta.other;
    }
    while (refresh() > limit && results.length > 0)
        results.pop();
    if (!out.truncated) {
        delete out.hint;
        refresh();
    }
    return out;
}
