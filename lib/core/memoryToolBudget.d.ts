import type { MemoryEntry } from './types.js';
export interface MemoryToolHit {
    id: string;
    path: string;
    archived: boolean;
    sourceRange?: string;
    sourceRangeOmitted?: boolean;
    score: number;
    tags: string[];
    keys: string[];
    body: string;
    truncated: boolean;
    metadataTruncated: boolean;
    tagsTruncated: boolean;
    keysTruncated: boolean;
}
export interface MemoryToolResponse {
    ok: boolean;
    error?: string;
    hint?: string;
    count?: number;
    omitted?: number;
    truncated?: boolean;
    tokensUsed: number;
    results?: MemoryToolHit[];
}
/**
 * 库里有记忆却一条都没匹配上时给模型的提示。检索只看字面：问「谁在偷药」找不到写着「止痛剂少了两箱」的记忆，
 * 这种情况靠模型换一个说法重查，或者去看目录里的摘要，而不是当作没有这件事。
 */
export declare const MEMORY_SEARCH_NO_MATCH_HINT = "\u6CA1\u6709\u5339\u914D\u3002\u8BB0\u5FC6\u6309\u5B57\u9762\u68C0\u7D22\uFF1A\u6362\u6210\u8BB0\u5FC6\u91CC\u4F1A\u51FA\u73B0\u7684\u4EBA\u540D\u3001\u7269\u540D\u6216\u8FD1\u4E49\u7684\u8BF4\u6CD5\u518D\u67E5\u4E00\u6B21\uFF1B\u4ECD\u6CA1\u6709\u65F6\u7528 tavern_asset_list \u770B memory \u76EE\u5F55\u91CC\u7684\u6458\u8981\u3002";
/**
 * 小于合法响应头的预算不能表达 JSON，返回固定业务拒绝；成功时 tokensUsed 严格计入最终自身字段。
 * emptyHint 只在没有任何命中时附上（预算容不下就不附）；库本身为空时调用方不应传它。
 */
export declare function budgetMemorySearch(hits: readonly {
    entry: MemoryEntry;
    score: number;
}[], budget: number, options?: {
    emptyHint?: string;
}): MemoryToolResponse;
