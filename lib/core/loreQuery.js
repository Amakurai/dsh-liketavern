/**
 * 世界书按条阅读：目录摘要、uid/关键词筛选、正文预算截断。
 * 给模型工具用，避免整本 JSON 灌进上下文。
 */
import { estimateTokens } from './tokenize.js';
import { assetOutputTokens, clipAssetJsonText, stampAssetTokens } from './assetRead.js';
export const LORE_READ_DEFAULT_TOPK = 6;
export const LORE_READ_MAX_TOPK = 20;
export const LORE_READ_TOKEN_BUDGET = 2500;
export const LORE_CATALOG_PREVIEW = 80;
export const LORE_CATALOG_MAX = 400;
export function clampLoreTopK(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return LORE_READ_DEFAULT_TOPK;
    return Math.min(LORE_READ_MAX_TOPK, Math.floor(value));
}
export function toLoreCatalogItem(entry) {
    const preview = entry.content.replace(/\s+/g, ' ').trim().slice(0, LORE_CATALOG_PREVIEW);
    return {
        uid: entry.uid,
        key: entry.key,
        source: entry.source,
        sourceRef: entry.sourceRef,
        comment: entry.comment,
        keys: entry.keys,
        enabled: entry.enabled,
        constant: entry.constant,
        tokens: estimateTokens(entry.content),
        preview,
    };
}
function sourceOf(raw) {
    if (raw === 'chat' || raw === 'persona' || raw === 'character' || raw === 'global' || raw === 'delta')
        return raw;
    return undefined;
}
function scoreLore(entry, needle) {
    if (!needle)
        return 1;
    if (entry.uid === needle || entry.key === needle)
        return 100;
    const q = needle.toLowerCase();
    if (entry.uid.toLowerCase() === q || entry.key.toLowerCase() === q)
        return 95;
    if (entry.keys.some((k) => k.toLowerCase() === q))
        return 80;
    if (entry.keys.some((k) => k.toLowerCase().includes(q)))
        return 60;
    if (entry.secondaryKeys.some((k) => k.toLowerCase().includes(q)))
        return 50;
    if (entry.comment.toLowerCase().includes(q))
        return 40;
    if (entry.content.toLowerCase().includes(q))
        return 20;
    if (entry.key.toLowerCase().includes(q))
        return 10;
    return 0;
}
function matchesUid(entry, uid) {
    return entry.uid === uid || entry.key === uid || entry.key.endsWith(`:${uid}`);
}
/** uid / query 都空 = 目录模式（返回全部摘要，截到 LORE_CATALOG_MAX）。 */
export function isLoreCatalogQuery(q) {
    return !q.uid?.trim() && !q.query?.trim();
}
export function selectLoreEntries(entries, q) {
    const source = sourceOf(q.source?.trim());
    const scoped = source ? entries.filter((e) => e.source === source) : [...entries];
    const uid = q.uid?.trim();
    if (uid)
        return scoped.filter((e) => matchesUid(e, uid));
    const query = q.query?.trim();
    if (!query)
        return scoped;
    const ranked = scoped
        .map((entry) => ({ entry, score: scoreLore(entry, query) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.entry.order - a.entry.order);
    return ranked.slice(0, clampLoreTopK(q.topK)).map((x) => x.entry);
}
/** 只裁剪展示元数据；触发键逐项完整保留或省略，uid/key/sourceRef 等定位字段绝不改写。 */
function boundedLoreMetadata(entry) {
    const comment = clipAssetJsonText(entry.comment, 80), keys = [];
    for (const key of entry.keys) {
        if (assetOutputTokens([...keys, key]) <= 120)
            keys.push(key);
    }
    return { uid: entry.uid, key: entry.key, source: entry.source, sourceRef: entry.sourceRef,
        comment: comment.text, keys, enabled: entry.enabled, constant: entry.constant,
        keysOmitted: entry.keys.length - keys.length, metadataTruncated: comment.truncated || keys.length < entry.keys.length };
}
/** 目录和正文共用完整 pretty JSON 预算，包含提示、统计和 tokensUsed 自身；大定位跳过后继续找小条目。 */
function budgetLoreItems(entries, mode, budget, build, fill) {
    const limit = Math.max(0, Math.floor(budget)), out = [];
    const make = () => stampAssetTokens({ ok: true, mode, count: entries.length, entries: out, tokensUsed: 0,
        omitted: entries.length - out.length,
        truncated: entries.length > out.length || out.some(item => item.metadataTruncated || item.truncated),
        ...(mode === 'catalog' ? { hint: '用 uid 或完整 key 取正文；disabled 条目仍可读。' }
            : entries.length === 0 ? { hint: '无匹配。先不带参数看目录。' } : {}),
    });
    if (make().tokensUsed > limit)
        throw new Error('世界书输出预算不足以容纳响应元数据');
    for (const entry of entries) {
        if (mode === 'catalog' && out.length >= LORE_CATALOG_MAX)
            break;
        const item = build(entry);
        out.push(item);
        if (make().tokensUsed > limit) {
            out.pop();
            continue;
        }
        fill?.(item, entry, make, limit);
    }
    const result = make();
    if (entries.length && !out.length) {
        result.ok = false;
        result.error = 'lore-output-too-large：完整定位字段超过输出预算，请选择其它条目或缩小阅读范围';
        stampAssetTokens(result);
    }
    if (result.tokensUsed > limit)
        throw new Error('世界书完整输出超过预算');
    return result;
}
export function budgetLoreCatalog(entries, budget = LORE_READ_TOKEN_BUDGET) {
    return budgetLoreItems(entries, 'catalog', budget, entry => {
        const preview = clipAssetJsonText(toLoreCatalogItem(entry).preview, 80), metadata = boundedLoreMetadata(entry);
        return { ...metadata, tokens: estimateTokens(entry.content), preview: preview.text,
            metadataTruncated: preview.truncated || metadata.metadataTruncated };
    });
}
/** 正文按实际序列化响应拟合；控制字符转义、Unicode 代理对和字段计数都不能突破整份预算。 */
export function clipLoreContents(entries, budget = LORE_READ_TOKEN_BUDGET) {
    return budgetLoreItems(entries, 'content', budget, entry => ({ ...boundedLoreMetadata(entry), content: '', truncated: false }), (item, entry, make, limit) => {
        item.content = entry.content;
        if (make().tokensUsed <= limit)
            return;
        item.truncated = true;
        const suffix = '…（已截断）';
        item.content = suffix;
        if (make().tokensUsed > limit) {
            item.content = '';
            return;
        }
        let lo = 0, hi = entry.content.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            item.content = `${entry.content.slice(0, mid)}${suffix}`;
            if (make().tokensUsed <= limit)
                lo = mid;
            else
                hi = mid - 1;
        }
        if (lo > 0 && /[\uD800-\uDBFF]/.test(entry.content[lo - 1]) && /[\uDC00-\uDFFF]/.test(entry.content[lo] ?? ''))
            lo--;
        item.content = `${entry.content.slice(0, lo)}${suffix}`;
    });
}
