/**
 * 工作区资产阅读：路径消毒、可读白名单、预设条目目录。
 * 只允许角色工作区内的文本文件；WAL 与二进制一律拒绝。
 */
import { clipToTokenBudget, countTokenChars, estimateTokens, isTokenCjkCode, type TokenCharCounts } from './tokenize.js'
import type { PresetEntry, PromptPreset } from './types.js'

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
  if (lower === 'state/wal' || lower.startsWith('state/wal/') || lower === 'state/wal-coverage.json' || lower === 'state/wal-recovery.json') return { ok: false, error: '不读取 WAL 快照' }
  if (lower === 'state/template.json' || ['state/template-data', 'state/template-generation'].some((dir) => lower === dir || lower.startsWith(`${dir}/`))) return { ok: false, error: '不读取内部模板状态与回复快照' }
  if (lower === 'state/helper.json' || lower === 'state/helper-mvu-abandon.json') return { ok: false, error: '不读取内部酒馆助手状态' }
  if (lower === 'memory/aliases.json') return { ok: false, error: '不读取内部记忆别名索引' }
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
    preview: (() => {
      const normalized = entry.content.replace(/\s+/g, ' ').trim()
      let end = PRESET_CATALOG_PREVIEW
      if (end < normalized.length && end > 0 && /[\uD800-\uDBFF]/.test(normalized[end - 1]!) && /[\uDC00-\uDFFF]/.test(normalized[end] ?? '')) end--
      return normalized.slice(0, end)
    })(),
  }
}

export function listPresetCatalog(preset: PromptPreset): PresetCatalogItem[] {
  return preset.entries.map(toPresetCatalogItem)
}

export function findPresetEntry(preset: PromptPreset, identifier: string, options?: { exact?: boolean }): PresetEntry | undefined {
  // identifier 是存储身份；默认精确匹配优先、未命中才兼容去空白查询，精确模式禁止回退。
  const exact = preset.entries.find((e) => e.identifier === identifier)
  if (exact || options?.exact) return exact
  const id = identifier.trim()
  return preset.entries.find((e) => e.identifier === id)
}

/** 与工具 render 的 pretty JSON 同口径；控制字符的转义也参与预算。 */
export function assetOutputTokens(value: unknown): number {
  return estimateTokens(JSON.stringify(value, null, 2) ?? 'null')
}

/** 文本按 JSON 字符串而非原文计费，避免控制字符被转义后膨胀；返回 tokens 仍是原文粗估。 */
export function clipAssetJsonText(text: string, budget: number): ReturnType<typeof clipToTokenBudget> {
  if (!text) return { text: '', truncated: false, tokens: 0 }
  const limit = Number.isNaN(budget) ? 0 : Math.max(0, Math.floor(budget))
  const suffix = '…（已截断）'
  // suffix = 3 CJK + 3 other；外层 JSON 引号已在 jsonOther 初值 2 中计入。
  let rawCjk = 0, rawOther = 0, jsonCjk = 0, jsonOther = 2
  let lo = 0, loRawCjk = 0, loRawOther = 0
  let exceeded = false
  for (let i = 0; i < text.length;) {
    const code = text.charCodeAt(i)
    let step = 1
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = i + 1 < text.length ? text.charCodeAt(i + 1) : 0
      if (next >= 0xdc00 && next <= 0xdfff) {
        step = 2
        rawOther += 2
        jsonOther += 2
      } else {
        rawOther += 1
        jsonOther += 6
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      rawOther += 1
      jsonOther += 6
    } else if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
      rawOther += 1
      jsonOther += 2
    } else if (code < 0x20) {
      rawOther += 1
      jsonOther += 6
    } else if (isTokenCjkCode(code)) {
      rawCjk += 1
      jsonCjk += 1
    } else {
      rawOther += 1
      jsonOther += 1
    }
    const nextIndex = i + step
    if (jsonCjk + 3 + Math.ceil((jsonOther + 3) / 4) <= limit) {
      lo = nextIndex
      loRawCjk = rawCjk
      loRawOther = rawOther
    }
    if (jsonCjk + Math.ceil(jsonOther / 4) > limit) {
      exceeded = true
      break
    }
    i = nextIndex
  }
  if (!exceeded) return { text, truncated: false, tokens: rawCjk + Math.ceil(rawOther / 4) }
  // JSON.stringify(suffix) = '"…（已截断）"' -> 3 CJK + 5 other = 5 tokens。
  if (limit < 5) return { text: '', truncated: true, tokens: 0 }
  const clipped = `${text.slice(0, lo)}${suffix}`
  return { text: clipped, truncated: true, tokens: loRawCjk + 3 + Math.ceil((loRawOther + 3) / 4) }
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

/** 与 stampAssetTokens 同口径的零分配不动点计算：tokensUsed 从 0 变为多位整数只增加 ASCII 数字位数。 */
export function stabilizeJsonTokenCount(cjk: number, otherAtZero: number): number {
  let tokensUsed = 0
  for (let i = 0; i < 8; i++) {
    const digits = tokensUsed < 10 ? 1 : tokensUsed < 100 ? 2 : tokensUsed < 1000 ? 3 : String(tokensUsed).length
    const next = cjk + Math.ceil((otherAtZero + digits - 1) / 4)
    if (next === tokensUsed) break
    tokensUsed = next
  }
  return tokensUsed
}

/** 统计单个数组元素在 pretty JSON（缩进 arrayIndent + 2 空格）中的增量字符数。 */
export function countPrettyArrayItemChars(item: unknown, arrayIndent: number): TokenCharCounts {
  const json = JSON.stringify(item, null, 2) ?? 'null'
  const counts = countTokenChars(json)
  let lines = 1
  for (let i = 0; i < json.length; i++) if (json.charCodeAt(i) === 0x0a) lines++
  return { cjk: counts.cjk, other: counts.other + (arrayIndent + 2) * lines }
}

/** 定位字段只能完整保留或省略整条；条数与完整 JSON 预算同时约束，跳过大条目后仍可发现小条目。 */
function boundCatalog<T, R extends AssetCatalogStats>(
  candidates: Iterable<T>, count: number, budget: number, metadataTruncated: boolean,
  build: (items: T[], stats: AssetCatalogStats) => R, wrap: (value: R) => unknown, arrayIndent: number,
): R {
  const items: T[] = []
  let itemsCjk = 0, itemsOther = 0
  const shellCache = new Map<number, TokenCharCounts>()
  const shellCounts = (len: number, truncated: boolean): TokenCharCounts => {
    const key = len * 2 + (truncated ? 1 : 0)
    let cached = shellCache.get(key)
    if (!cached) {
      const shell = wrap(build([], { count, omitted: count - len, truncated, tokensUsed: 0 }))
      cached = countTokenChars(JSON.stringify(shell, null, 2) ?? 'null')
      shellCache.set(key, cached)
    }
    return cached
  }
  const estimateWith = (len: number, cjk: number, other: number): number => {
    const shell = shellCounts(len, metadataTruncated || count > len)
    if (len === 0) return stabilizeJsonTokenCount(shell.cjk, shell.other)
    // 非空数组把壳中的 '[]'（2 other）替换为 '[\n' + 元素（含各自缩进）+ (len-1)*',\n' + '\n' + ' '.repeat(arrayIndent) + ']'。
    return stabilizeJsonTokenCount(shell.cjk + cjk, shell.other + arrayIndent + 2 * len + other)
  }
  for (const item of candidates) {
    if (items.length >= ASSET_CATALOG_MAX) break
    const delta = countPrettyArrayItemChars(item, arrayIndent)
    if (estimateWith(items.length + 1, itemsCjk + delta.cjk, itemsOther + delta.other) <= budget) {
      items.push(item)
      itemsCjk += delta.cjk
      itemsOther += delta.other
    }
  }
  const result = stampAssetTokens(build(items, { count, omitted: count - items.length,
    truncated: metadataTruncated || count > items.length, tokensUsed: 0 }), wrap)
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
      metadataTruncated, entries, ...stats }), value => ({ preset: value }), 4)
}

export interface AssetFileCatalog extends AssetCatalogStats { files: string[] }

/** 路径不裁剪；所有 JSON 引号、转义及数组展示开销都包含在文件目录的预算中。 */
export function budgetAssetFiles(paths: readonly string[], budget = ASSET_OUTPUT_TOKEN_BUDGET): AssetFileCatalog {
  return boundCatalog(paths, paths.length, budget, false,
    (files, stats) => ({ files, ...stats }), value => ({ files: value.files, fileCount: value.count,
      filesOmitted: value.omitted, filesTruncated: value.truncated, filesTokensUsed: value.tokensUsed }), 2)
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
    (files, stats) => ({ ...(updatedAt === undefined ? {} : { updatedAt }), metadataTruncated, files, ...stats }), value => ({ index: value }), 4)
}
