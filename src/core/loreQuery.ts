/**
 * 世界书按条阅读：目录摘要、uid/关键词筛选、正文预算截断。
 * 给模型工具用，避免整本 JSON 灌进上下文。
 */
import { clipToTokenBudget, estimateTokens } from './tokenize.js'
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
  const uid = q.uid?.trim()
  if (uid) return scoped.filter((e) => matchesUid(e, uid))
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
}

export function clipLoreContents(
  entries: readonly WorldInfoEntry[],
  budget = LORE_READ_TOKEN_BUDGET,
): { entries: LoreContentItem[]; tokensUsed: number; omitted: number } {
  const out: LoreContentItem[] = []
  let used = 0
  let omitted = 0
  for (const entry of entries) {
    const remain = budget - used
    if (remain <= 0) {
      omitted += 1
      continue
    }
    const clipped = clipToTokenBudget(entry.content, remain)
    out.push({
      uid: entry.uid,
      key: entry.key,
      source: entry.source,
      sourceRef: entry.sourceRef,
      comment: entry.comment,
      keys: entry.keys,
      enabled: entry.enabled,
      constant: entry.constant,
      content: clipped.text,
      truncated: clipped.truncated,
    })
    used += clipped.tokens
  }
  return { entries: out, tokensUsed: used, omitted }
}
