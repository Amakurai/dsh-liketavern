/**
 * 世界书按条阅读：目录摘要、uid/关键词筛选、正文预算截断。
 * 给模型工具用，避免整本 JSON 灌进上下文。
 */
import { estimateTokens } from './tokenize.js'
import { assetOutputTokens, clipAssetJsonText, stampAssetTokens } from './assetRead.js'
import type { WISource, WorldInfoEntry } from './types.js'

export const LORE_READ_DEFAULT_TOPK = 6
export const LORE_READ_MAX_TOPK = 20
export const LORE_READ_TOKEN_BUDGET = 2500
export const LORE_CATALOG_PREVIEW = 80
export const LORE_CATALOG_MAX = 400

export interface LoreCatalogItem {
  uid: string
  key: string
  source: WISource
  sourceRef: string
  comment: string
  keys: string[]
  enabled: boolean
  constant: boolean
  tokens: number
  preview: string
  metadataTruncated?: boolean
  keysOmitted?: number
}

export interface LoreReadQuery {
  uid?: string
  query?: string
  source?: string
  topK?: number
}

export function clampLoreTopK(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return LORE_READ_DEFAULT_TOPK
  return Math.min(LORE_READ_MAX_TOPK, Math.floor(value))
}

export function toLoreCatalogItem(entry: WorldInfoEntry): LoreCatalogItem {
  const preview = entry.content.replace(/\s+/g, ' ').trim().slice(0, LORE_CATALOG_PREVIEW)
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
  }
}

function sourceOf(raw: string | undefined): WISource | undefined {
  if (raw === 'chat' || raw === 'persona' || raw === 'character' || raw === 'global' || raw === 'delta') return raw
  return undefined
}

function scoreLore(entry: WorldInfoEntry, needle: string): number {
  if (!needle) return 1
  if (entry.uid === needle || entry.key === needle) return 100
  const q = needle.toLowerCase()
  if (entry.uid.toLowerCase() === q || entry.key.toLowerCase() === q) return 95
  if (entry.keys.some((k) => k.toLowerCase() === q)) return 80
  if (entry.keys.some((k) => k.toLowerCase().includes(q))) return 60
  if (entry.secondaryKeys.some((k) => k.toLowerCase().includes(q))) return 50
  if (entry.comment.toLowerCase().includes(q)) return 40
  if (entry.content.toLowerCase().includes(q)) return 20
  if (entry.key.toLowerCase().includes(q)) return 10
  return 0
}

function matchesUid(entry: WorldInfoEntry, uid: string): boolean {
  return entry.uid === uid || entry.key === uid || entry.key.endsWith(`:${uid}`)
}

/** uid / query 都空 = 目录模式（返回全部摘要，截到 LORE_CATALOG_MAX）。 */
export function isLoreCatalogQuery(q: LoreReadQuery): boolean {
  return !q.uid?.trim() && !q.query?.trim()
}

export function selectLoreEntries(entries: readonly WorldInfoEntry[], q: LoreReadQuery): WorldInfoEntry[] {
  const source = sourceOf(q.source?.trim())
  const scoped = source ? entries.filter((e) => e.source === source) : [...entries]
  if (q.uid) {
    // 完整 key 是跨书身份，优先于同名 uid/后缀；先保留原始身份，未命中才兼容去空白查询。
    const byIdentity = (uid: string) => {
      const keys = scoped.filter(entry => entry.key === uid)
      if (keys.length) return keys
      const ids = scoped.filter(entry => entry.uid === uid)
      return ids.length ? ids : scoped.filter(entry => matchesUid(entry, uid))
    }
    const exact = byIdentity(q.uid)
    if (exact.length) return exact
    const uid = q.uid.trim()
    if (uid) return byIdentity(uid)
  }
  const query = q.query?.trim()
  if (!query) return scoped
  const ranked = scoped
    .map((entry) => ({ entry, score: scoreLore(entry, query) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.entry.order - a.entry.order)
  return ranked.slice(0, clampLoreTopK(q.topK)).map((x) => x.entry)
}

export interface LoreContentItem {
  uid: string
  key: string
  source: WISource
  sourceRef: string
  comment: string
  keys: string[]
  enabled: boolean
  constant: boolean
  content: string
  truncated: boolean
  metadataTruncated?: boolean
  keysOmitted?: number
}

export interface LoreBudgetResult<T> {
  ok: boolean
  mode: 'catalog' | 'content'
  count: number
  entries: T[]
  tokensUsed: number
  omitted: number
  truncated: boolean
  hint?: string
  error?: string
}

/** 只裁剪展示元数据；触发键逐项完整保留或省略，uid/key/sourceRef 等定位字段绝不改写。 */
function boundedLoreMetadata(entry: WorldInfoEntry) {
  const comment = clipAssetJsonText(entry.comment, 80), keys: string[] = []
  for (const key of entry.keys) {
    if (assetOutputTokens([...keys, key]) <= 120) keys.push(key)
  }
  return { uid: entry.uid, key: entry.key, source: entry.source, sourceRef: entry.sourceRef,
    comment: comment.text, keys, enabled: entry.enabled, constant: entry.constant,
    keysOmitted: entry.keys.length - keys.length, metadataTruncated: comment.truncated || keys.length < entry.keys.length }
}

/** 目录和正文共用完整 pretty JSON 预算，包含提示、统计和 tokensUsed 自身；大定位跳过后继续找小条目。 */
function budgetLoreItems<T extends { metadataTruncated?: boolean; truncated?: boolean }>(
  entries: readonly WorldInfoEntry[], mode: 'catalog' | 'content', budget: number,
  build: (entry: WorldInfoEntry) => T,
  fill?: (item: T, entry: WorldInfoEntry, make: () => LoreBudgetResult<T>, limit: number) => void,
): LoreBudgetResult<T> {
  const limit = Math.max(0, Math.floor(budget)), out: T[] = []
  const make = () => stampAssetTokens({ ok: true, mode, count: entries.length, entries: out, tokensUsed: 0,
    omitted: entries.length - out.length,
    truncated: entries.length > out.length || out.some(item => item.metadataTruncated || item.truncated),
    ...(mode === 'catalog' ? { hint: '用 uid 或完整 key 取正文；disabled 条目仍可读。' }
      : entries.length === 0 ? { hint: '无匹配。先不带参数看目录。' } : {}),
  } as LoreBudgetResult<T>)
  if (make().tokensUsed > limit) throw new Error('世界书输出预算不足以容纳响应元数据')
  for (const entry of entries) {
    if (mode === 'catalog' && out.length >= LORE_CATALOG_MAX) break
    const item = build(entry)
    out.push(item)
    if (make().tokensUsed > limit) { out.pop(); continue }
    fill?.(item, entry, make, limit)
  }
  const result = make()
  if (entries.length && !out.length) {
    result.ok = false
    result.error = 'lore-output-too-large：完整定位字段超过输出预算，请选择其它条目或缩小阅读范围'
    stampAssetTokens(result)
  }
  if (result.tokensUsed > limit) throw new Error('世界书完整输出超过预算')
  return result
}

export function budgetLoreCatalog(entries: readonly WorldInfoEntry[], budget = LORE_READ_TOKEN_BUDGET): LoreBudgetResult<LoreCatalogItem> {
  return budgetLoreItems(entries, 'catalog', budget, entry => {
    const preview = clipAssetJsonText(toLoreCatalogItem(entry).preview, 80), metadata = boundedLoreMetadata(entry)
    return { ...metadata, tokens: estimateTokens(entry.content), preview: preview.text,
      metadataTruncated: preview.truncated || metadata.metadataTruncated }
  })
}

/** 正文按实际序列化响应拟合；控制字符转义、Unicode 代理对和字段计数都不能突破整份预算。 */
export function clipLoreContents(entries: readonly WorldInfoEntry[], budget = LORE_READ_TOKEN_BUDGET): LoreBudgetResult<LoreContentItem> {
  return budgetLoreItems<LoreContentItem>(entries, 'content', budget, entry => ({ ...boundedLoreMetadata(entry), content: '', truncated: false }),
    (item, entry, make, limit) => {
      item.content = entry.content
      if (make().tokensUsed <= limit) return
      item.truncated = true
      const suffix = '…（已截断）'
      item.content = suffix
      if (make().tokensUsed > limit) { item.content = ''; return }
      let lo = 0, hi = entry.content.length
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2)
        item.content = `${entry.content.slice(0, mid)}${suffix}`
        if (make().tokensUsed <= limit) lo = mid
        else hi = mid - 1
      }
      if (lo > 0 && /[\uD800-\uDBFF]/.test(entry.content[lo - 1]!) && /[\uDC00-\uDFFF]/.test(entry.content[lo] ?? '')) lo--
      item.content = `${entry.content.slice(0, lo)}${suffix}`
    })
}
