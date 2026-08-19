/**
 * 工作区资产阅读：路径消毒、可读白名单、预设条目目录。
 * 只允许角色工作区内的文本文件；WAL 与二进制一律拒绝。
 */
import { clipToTokenBudget } from './tokenize.js';
import type { PresetEntry, PromptPreset } from './types.js';
export declare const ASSET_READ_TOKEN_BUDGET = 3000;
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
}
export declare function toPresetCatalogItem(entry: PresetEntry): PresetCatalogItem;
export declare function listPresetCatalog(preset: PromptPreset): PresetCatalogItem[];
export declare function findPresetEntry(preset: PromptPreset, identifier: string): PresetEntry | undefined;
export declare function clipAssetText(text: string, budget?: number): ReturnType<typeof clipToTokenBudget>;
