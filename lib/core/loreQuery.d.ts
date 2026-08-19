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
}
export interface LoreReadQuery {
    uid?: string;
    query?: string;
    source?: string;
    topK?: number;
}
export declare function clampLoreTopK(value: number | undefined): number;
export declare function toLoreCatalogItem(entry: WorldInfoEntry): LoreCatalogItem;
/** uid / query 都空 = 目录模式（返回全部摘要，截到 LORE_CATALOG_MAX）。 */
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
}
export declare function clipLoreContents(entries: readonly WorldInfoEntry[], budget?: number): {
    entries: LoreContentItem[];
    tokensUsed: number;
    omitted: number;
};
