import type { WISource, WorldInfoEntry } from './types.js';
export declare const LORE_READ_DEFAULT_TOPK = 6;
export declare const LORE_READ_MAX_TOPK = 20;
export declare const LORE_READ_TOKEN_BUDGET = 2500;
export declare const LORE_CATALOG_PREVIEW = 80;
export declare const LORE_CATALOG_MAX = 400;
export interface LoreCatalogItem {
    uid: string;
    key: string;
    source: WISource;
    sourceRef: string;
    comment: string;
    keys: string[];
    enabled: boolean;
    constant: boolean;
    tokens: number;
    preview: string;
    metadataTruncated?: boolean;
    keysOmitted?: number;
}
export interface LoreReadQuery {
    uid?: string;
    query?: string;
    source?: string;
    topK?: number;
}
export declare function clampLoreTopK(value: number | undefined): number;
export declare function toLoreCatalogItem(entry: WorldInfoEntry): LoreCatalogItem;
/** uid 不裁剪：空白也是合法存储身份；仅缺省/空串 uid 且无查询才进入目录。 */
export declare function isLoreCatalogQuery(q: LoreReadQuery): boolean;
export declare function selectLoreEntries(entries: readonly WorldInfoEntry[], q: LoreReadQuery): WorldInfoEntry[];
export interface LoreContentItem {
    uid: string;
    key: string;
    source: WISource;
    sourceRef: string;
    comment: string;
    keys: string[];
    enabled: boolean;
    constant: boolean;
    content: string;
    truncated: boolean;
    metadataTruncated?: boolean;
    keysOmitted?: number;
}
export interface LoreBudgetResult<T> {
    ok: boolean;
    mode: 'catalog' | 'content';
    count: number;
    entries: T[];
    tokensUsed: number;
    omitted: number;
    truncated: boolean;
    hint?: string;
    error?: string;
}
export declare function budgetLoreCatalog(entries: readonly WorldInfoEntry[], budget?: number, extraHint?: string): LoreBudgetResult<LoreCatalogItem>;
/** 正文按实际序列化响应拟合；控制字符转义、Unicode 代理对和字段计数都不能突破整份预算。 */
export declare function clipLoreContents(entries: readonly WorldInfoEntry[], budget?: number, extraHint?: string): LoreBudgetResult<LoreContentItem>;
