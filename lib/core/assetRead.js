/**
 * 工作区资产阅读：路径消毒、可读白名单、预设条目目录。
 * 只允许角色工作区内的文本文件；WAL 与二进制一律拒绝。
 */
import { clipToTokenBudget, estimateTokens } from './tokenize.js';
export const ASSET_READ_TOKEN_BUDGET = 3000;
export const PRESET_CATALOG_PREVIEW = 80;
const TEXT_EXT = /\.(md|json|jsonl|txt)$/i;
export function resolveReadableAssetPath(raw) {
    const trimmed = raw.trim();
    if (!trimmed)
        return { ok: false, error: '需要 path（工作区相对路径）' };
    const slashed = trimmed.replaceAll('\\', '/');
    if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed))
        return { ok: false, error: '禁止绝对路径' };
    const parts = slashed.split('/');
    if (parts.some((p) => p === '' || p === '..'))
        return { ok: false, error: '路径不合法' };
    // 先归一化再判定：'.' 段必须在 WAL 前缀比对之前折掉，且返回的 path 用折叠后的规范形式。
    // 否则 'state/./wal/x.jsonl' 能绕过下面的前缀检查，而 WorkspaceFs.abs 又会把它还原成 WAL 路径。
    const path = parts.filter((p) => p !== '.').join('/');
    if (!path)
        return { ok: false, error: '路径不合法' };
    const lower = path.toLowerCase();
    if (lower === 'stories' || lower.startsWith('stories/') || lower === 'story.json')
        return { ok: false, error: '不读取其它剧情或内部元数据' };
    if (lower === 'state/wal' || lower.startsWith('state/wal/'))
        return { ok: false, error: '不读取 WAL 快照' };
    if (lower === 'state/template.json')
        return { ok: false, error: '不读取内部模板状态与回复快照' };
    if (lower === 'state/helper.json' || lower === 'state/helper-mvu-abandon.json')
        return { ok: false, error: '不读取内部酒馆助手状态' };
    if (/\.(png|jpe?g|webp|gif|bin)$/i.test(path))
        return { ok: false, error: '不读取二进制资源' };
    if (!TEXT_EXT.test(path))
        return { ok: false, error: '只允许 md / json / jsonl / txt' };
    return { ok: true, path };
}
export function isPresetCatalogToken(value) {
    const t = value.trim().toLowerCase();
    return t === '' || t === '*' || t === 'list' || t === 'catalog';
}
export function toPresetCatalogItem(entry) {
    return {
        identifier: entry.identifier,
        name: entry.name,
        enabled: entry.enabled,
        role: entry.role,
        position: entry.position,
        marker: entry.marker,
        markerId: entry.markerId ?? null,
        tokens: estimateTokens(entry.content),
        preview: entry.content.replace(/\s+/g, ' ').trim().slice(0, PRESET_CATALOG_PREVIEW),
    };
}
export function listPresetCatalog(preset) {
    return preset.entries.map(toPresetCatalogItem);
}
export function findPresetEntry(preset, identifier) {
    const id = identifier.trim();
    return preset.entries.find((e) => e.identifier === id);
}
export function clipAssetText(text, budget = ASSET_READ_TOKEN_BUDGET) {
    return clipToTokenBudget(text, budget);
}
