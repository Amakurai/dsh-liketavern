/**
 * 工作区资产阅读：路径消毒、可读白名单、预设条目目录。
 * 只允许角色工作区内的文本文件；WAL 与二进制一律拒绝。
 */
import { clipToTokenBudget } from './tokenize.js';
import type { PresetEntry, PromptPreset } from './types.js';
export declare const ASSET_READ_TOKEN_BUDGET = 3000;
/** 资产工具的完整 JSON 输出预算；包括目录、正文、元数据、转义与展示缩进。 */
export declare const ASSET_OUTPUT_TOKEN_BUDGET = 3000;
export declare const ASSET_CATALOG_MAX = 200;
export declare const PRESET_CATALOG_PREVIEW = 80;
export declare function resolveReadableAssetPath(raw: string): {
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
};
export declare function isPresetCatalogToken(value: string): boolean;
export interface PresetCatalogItem {
    identifier: string;
    name: string;
    enabled: boolean;
    role: PresetEntry['role'];
    position: PresetEntry['position'];
    marker: boolean;
    markerId: string | null;
    tokens: number;
    preview: string;
    truncated?: boolean;
}
export declare function toPresetCatalogItem(entry: PresetEntry): PresetCatalogItem;
export declare function listPresetCatalog(preset: PromptPreset): PresetCatalogItem[];
export declare function findPresetEntry(preset: PromptPreset, identifier: string): PresetEntry | undefined;
export declare function clipAssetText(text: string, budget?: number): ReturnType<typeof clipToTokenBudget>;
/** 与工具 render 的 pretty JSON 同口径；控制字符的转义也参与预算。 */
export declare function assetOutputTokens(value: unknown): number;
/** 文本按 JSON 字符串而非原文计费，避免控制字符被转义后膨胀；返回 tokens 仍是原文粗估。 */
export declare function clipAssetJsonText(text: string, budget: number): ReturnType<typeof clipToTokenBudget>;
export interface AssetCatalogStats {
    count: number;
    omitted: number;
    truncated: boolean;
    tokensUsed: number;
}
/** 预算计数本身也会改变 JSON 长度，迭代至稳定后才报告完整输出用量。 */
export declare function stampAssetTokens<T extends {
    tokensUsed: number;
}>(value: T, wrap?: (value: T) => unknown): T;
export interface PresetCatalog extends AssetCatalogStats {
    id?: string;
    idOmitted?: boolean;
    name: string;
    metadataTruncated: boolean;
    entries: PresetCatalogItem[];
}
/** 预设目录仅对展示字段裁剪；identifier 与 markerId 太长时整条省略并保留真实总数。 */
export declare function budgetPresetCatalog(preset: PromptPreset, budget?: number): PresetCatalog;
export interface AssetFileCatalog extends AssetCatalogStats {
    files: string[];
}
/** 路径不裁剪；所有 JSON 引号、转义及数组展示开销都包含在文件目录的预算中。 */
export declare function budgetAssetFiles(paths: readonly string[], budget?: number): AssetFileCatalog;
export interface AssetIndexCatalog extends AssetCatalogStats {
    updatedAt?: string;
    metadataTruncated: boolean;
    files: Array<{
        path: string;
        summary: string;
        tokens: number;
        truncated: boolean;
    }>;
}
/** 索引是派生目录，不透传未知 JSON；只保留当前实际可读文件，禁止广告失效或内部路径。 */
export declare function budgetAssetIndex(value: unknown, readablePaths: readonly string[], budget?: number): AssetIndexCatalog | null;
