/**
 * 工作区资产阅读：路径消毒、可读白名单、预设条目目录。
 * 只允许角色工作区内的文本文件；WAL 与二进制一律拒绝。
 */
import { clipToTokenBudget, estimateTokens } from './tokenize.js'
import type { PresetEntry, PromptPreset } from './types.js'

export const ASSET_READ_TOKEN_BUDGET = 3000
/** 资产工具的完整 JSON 输出预算；包括目录、正文、元数据、转义与展示缩进。 */
export const ASSET_OUTPUT_TOKEN_BUDGET = 3000
export const ASSET_CATALOG_MAX = 200
export const PRESET_CATALOG_PREVIEW = 80

const TEXT_EXT = /\.(md|json|jsonl|txt)$/i

export function resolveReadableAssetPath(raw: string): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = raw.trim()
  if (!trimmed) return { ok: false, error: '需要 path（工作区相对路径）' }
  const slashed = trimmed.replaceAll('\\', '/')
  if (slashed.startsWith('/') || /^[A-Za-z]:/.test(slashed)) return { ok: false, error: '禁止绝对路径' }
  const parts = slashed.split('/')
  // Windows 的冒号还可打开 NTFS alternate data stream；它不在目录中出现，不能按扩展名白名单放行。
  // NUL 在各平台都不是可表示的文件名；在纯路径边界拒绝，避免 Node 参数异常终止整批 PTC。
  if (parts.some((p) => p === '' || p === '..' || p.includes(':') || p.includes('\u0000'))) return { ok: false, error: '路径不合法' }
  // 先归一化再判定：'.' 段必须在 WAL 前缀比对之前折掉，且返回的 path 用折叠后的规范形式。
  // 否则 'state/./wal/x.jsonl' 能绕过下面的前缀检查，而 WorkspaceFs.abs 又会把它还原成 WAL 路径。
  const path = parts.filter((p) => p !== '.').join('/')
  if (!path) return { ok: false, error: '路径不合法' }
  const lower = path.toLowerCase()
  if (lower === '.archive.json') return { ok: false, error: '不读取角色生命周期元数据' }
  if (lower === 'stories' || lower.startsWith('stories/') || lower === 'story.json') return { ok: false, error: '不读取其它剧情或内部元数据' }
  if (lower === 'state/wal' || lower.startsWith('state/wal/')) return { ok: false, error: '不读取 WAL 快照' }
  if (lower === 'state/template.json') return { ok: false, error: '不读取内部模板状态与回复快照' }
  if (lower === 'state/helper.json' || lower === 'state/helper-mvu-abandon.json') return { ok: false, error: '不读取内部酒馆助手状态' }
  if (/\.(png|jpe?g|webp|gif|bin)$/i.test(path)) return { ok: false, error: '不读取二进制资源' }
  if (!TEXT_EXT.test(path)) return { ok: false, error: '只允许 md / json / jsonl / txt' }
  return { ok: true, path }
}

export function isPresetCatalogToken(value: string): boolean {
  const t = value.trim().toLowerCase()
  return t === '' || t === '*' || t === 'list' || t === 'catalog'
}

export interface PresetCatalogItem {
  identifier: string
  name: string
  enabled: boolean
  role: PresetEntry['role']
  position: PresetEntry['position']
  marker: boolean
  markerId: string | null
  tokens: number
  preview: string
  truncated?: boolean
}

export function toPresetCatalogItem(entry: PresetEntry): PresetCatalogItem {
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
  }
}

export function listPresetCatalog(preset: PromptPreset): PresetCatalogItem[] {
  return preset.entries.map(toPresetCatalogItem)
}

export function findPresetEntry(preset: PromptPreset, identifier: string): PresetEntry | undefined {
  const id = identifier.trim()
  return preset.entries.find((e) => e.identifier === id)
}

export function clipAssetText(text: string, budget = ASSET_READ_TOKEN_BUDGET): ReturnType<typeof clipToTokenBudget> {
  return clipToTokenBudget(text, budget)
}

/** 与工具 render 的 pretty JSON 同口径；控制字符的转义也参与预算。 */
export function assetOutputTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value, null, 2) ?? 'null')
}

/** 文本按 JSON 字符串而非原文计费，避免控制字符被转义后膨胀；返回 tokens 仍是原文粗估。 */
export function clipAssetJsonText(text: string, budget: number): ReturnType<typeof clipToTokenBudget> {
  const limit = Math.max(0, Math.floor(budget))
  if (assetOutputTokens(text) <= limit) return { text, truncated: false, tokens: estimateTokens(text) }
  const suffix = '…（已截断）'
  if (assetOutputTokens(suffix) > limit) return { text: '', truncated: true, tokens: 0 }
  let lo = 0, hi = text.length
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    const candidate = `${text.slice(0, mid)}${suffix}`
    if (assetOutputTokens(candidate) <= limit) lo = mid
    else hi = mid - 1
  }
  // 不把代理对切成半个 Unicode 字符。
  if (lo > 0 && /[\uD800-\uDBFF]/.test(text[lo - 1]!) && /[\uDC00-\uDFFF]/.test(text[lo] ?? '')) lo--
  const clipped = `${text.slice(0, lo)}${suffix}`
  return { text: clipped, truncated: true, tokens: estimateTokens(clipped) }
}

export interface AssetCatalogStats {
  count: number
  omitted: number
  truncated: boolean
  tokensUsed: number
}

/** 预算计数本身也会改变 JSON 长度，迭代至稳定后才报告完整输出用量。 */
export function stampAssetTokens<T extends { tokensUsed: number }>(value: T, wrap: (value: T) => unknown = value => value): T {
  for (let i = 0; i < 8; i++) {
    const tokens = assetOutputTokens(wrap(value))
    if (tokens === value.tokensUsed) break
    value.tokensUsed = tokens
  }
  return value
}

/** 定位字段只能完整保留或省略整条；条数与完整 JSON 预算同时约束，跳过大条目后仍可发现小条目。 */
function boundCatalog<T, R extends AssetCatalogStats>(
  candidates: Iterable<T>, count: number, budget: number, metadataTruncated: boolean,
  build: (items: T[], stats: AssetCatalogStats) => R, wrap: (value: R) => unknown,
): R {
  const items: T[] = []
  const make = () => stampAssetTokens(build(items, { count, omitted: count - items.length,
    truncated: metadataTruncated || count > items.length, tokensUsed: 0 }), wrap)
  for (const item of candidates) {
    if (items.length >= ASSET_CATALOG_MAX) break
    items.push(item)
    if (make().tokensUsed > budget) items.pop()
  }
  const result = make()
  if (result.tokensUsed > budget) throw new Error('资产目录元数据超过输出预算')
  return result
}

export interface PresetCatalog extends AssetCatalogStats {
  id?: string
  idOmitted?: boolean
  name: string
  metadataTruncated: boolean
  entries: PresetCatalogItem[]
}

/** 预设目录仅对展示字段裁剪；identifier 与 markerId 太长时整条省略并保留真实总数。 */
export function budgetPresetCatalog(preset: PromptPreset, budget = ASSET_OUTPUT_TOKEN_BUDGET): PresetCatalog {
  const name = clipAssetJsonText(preset.name, 80)
  const header = stampAssetTokens({ id: preset.identifier, name: name.text, metadataTruncated: name.truncated,
    entries: [], count: preset.entries.length, omitted: preset.entries.length,
    truncated: name.truncated || preset.entries.length > 0, tokensUsed: 0 }, value => ({ preset: value }))
  const idOmitted = header.tokensUsed > budget
  let metadataTruncated = name.truncated || idOmitted
  const entries: PresetCatalogItem[] = []
  for (const entry of preset.entries) {
    const item = toPresetCatalogItem(entry)
    const entryName = clipAssetJsonText(item.name, 80), preview = clipAssetJsonText(item.preview, 80)
    const truncated = entryName.truncated || preview.truncated
    metadataTruncated ||= truncated
    entries.push({ ...item, name: entryName.text, preview: preview.text, truncated })
  }
  return boundCatalog(entries, preset.entries.length, budget, metadataTruncated,
    (entries, stats) => ({ ...(idOmitted ? { idOmitted: true } : { id: preset.identifier }), name: name.text,
      metadataTruncated, entries, ...stats }), value => ({ preset: value }))
}

export interface AssetFileCatalog extends AssetCatalogStats { files: string[] }

/** 路径不裁剪；所有 JSON 引号、转义及数组展示开销都包含在文件目录的预算中。 */
export function budgetAssetFiles(paths: readonly string[], budget = ASSET_OUTPUT_TOKEN_BUDGET): AssetFileCatalog {
  return boundCatalog(paths, paths.length, budget, false,
    (files, stats) => ({ files, ...stats }), value => ({ files: value.files, fileCount: value.count,
      filesOmitted: value.omitted, filesTruncated: value.truncated, filesTokensUsed: value.tokensUsed }))
}

export interface AssetIndexCatalog extends AssetCatalogStats {
  updatedAt?: string
  metadataTruncated: boolean
  files: Array<{ path: string; summary: string; tokens: number; truncated: boolean }>
}

/** 索引是派生目录，不透传未知 JSON；只保留当前实际可读文件，禁止广告失效或内部路径。 */
export function budgetAssetIndex(value: unknown, readablePaths: readonly string[], budget = ASSET_OUTPUT_TOKEN_BUDGET): AssetIndexCatalog | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as Record<string, unknown>
  if (!Array.isArray(source.files)) return null
  const readable = new Set(readablePaths), seen = new Set<string>()
  const updatedAt = typeof source.updatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/.test(source.updatedAt)
    && source.updatedAt.length <= 40 && Number.isFinite(Date.parse(source.updatedAt)) ? source.updatedAt : undefined
  let metadataTruncated = source.updatedAt !== undefined && updatedAt === undefined
  const files: AssetIndexCatalog['files'] = []
  for (const raw of source.files) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
    const item = raw as Record<string, unknown>
    if (typeof item.path !== 'string' || typeof item.summary !== 'string' || typeof item.tokens !== 'number'
      || !Number.isSafeInteger(item.tokens) || item.tokens < 0) continue
    const path = resolveReadableAssetPath(item.path)
    if (!path.ok || !readable.has(path.path) || seen.has(path.path)) continue
    seen.add(path.path)
    const summary = clipAssetJsonText(item.summary, 80)
    metadataTruncated ||= summary.truncated
    files.push({ path: path.path, summary: summary.text, tokens: item.tokens, truncated: summary.truncated })
  }
  return boundCatalog(files, source.files.length, budget, metadataTruncated,
    (files, stats) => ({ ...(updatedAt === undefined ? {} : { updatedAt }), metadataTruncated, files, ...stats }), value => ({ index: value }))
}
