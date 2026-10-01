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
/** 小于合法响应头的预算不能表达 JSON，返回固定业务拒绝；成功时 tokensUsed 严格计入最终自身字段。 */
export declare function budgetMemorySearch(hits: readonly {
    entry: MemoryEntry;
    score: number;
}[], budget: number): MemoryToolResponse;
