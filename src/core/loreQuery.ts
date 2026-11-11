/**
 * 世界书按条阅读：目录摘要、uid/关键词筛选、正文预算截断。
 * 给模型工具用，避免整本 JSON 灌进上下文。
 */
import { countJsonStringTokenChars, countTokenChars, estimateTokens, isTokenCjkCode, type TokenCharCounts } from './tokenize.js'
import { clipAssetJsonText, countPrettyArrayItemChars, stabilizeJsonTokenCount, stampAssetTokens } from './assetRead.js'
import type { WISource, WorldInfoEntry } from './types.js'

export const LORE_READ_DEFAULT_TOPK = 6
export const LORE_READ_MAX_TOPK = 20
export const LORE_READ_TOKEN_BUDGET = 2500
const LORE_CATALOG_PREVIEW = 80
const LORE_CATALOG_MAX = 400

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
  return Math.min(LORE_READ_MAX_TOPK, Math.max(1, Math.floor(value)))
}

export function toLoreCatalogItem(entry: WorldInfoEntry): LoreCatalogItem {
  const normalized = entry.content.replace(/\s+/g, ' ').trim()
  let end = LORE_CATALOG_PREVIEW
  if (end < normalized.length && end > 0 && /[\uD800-\uDBFF]/.test(normalized[end - 1]!) && /[\uDC00-\uDFFF]/.test(normalized[end] ?? '')) end--
  const preview = normalized.slice(0, end)
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

/** uid 不裁剪：空白也是合法存储身份；仅缺省/空串 uid 且无查询才进入目录。 */
export function isLoreCatalogQuery(q: LoreReadQuery): boolean {
  return !q.uid && !q.query?.trim()
}

export function selectLoreEntries(entries: readonly WorldInfoEntry[], q: LoreReadQuery): WorldInfoEntry[] {
  // 未识别的非空来源仍是限定条件，不能静默扩大到全部来源；工具入口另给明确参数错误。
  const source = q.source?.trim()
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
    return []
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
  let keysCjk = 0, keysOther = 0
  for (const key of entry.keys) {
    const kc = countJsonStringTokenChars(key)
    const nextCjk = keysCjk + kc.cjk
    const nextOther = keys.length === 0 ? 6 + kc.other : keysOther + 4 + kc.other
    if (nextCjk + Math.ceil(nextOther / 4) <= 120) {
      keys.push(key)
      keysCjk = nextCjk
      keysOther = nextOther
    }
  }
  return { uid: entry.uid, key: entry.key, source: entry.source, sourceRef: entry.sourceRef,
    comment: comment.text, keys, enabled: entry.enabled, constant: entry.constant,
    keysOmitted: entry.keys.length - keys.length, metadataTruncated: comment.truncated || keys.length < entry.keys.length }
}

/** 目录和正文共用完整 pretty JSON 预算，包含提示、统计和 tokensUsed 自身；大定位跳过后继续找小条目。 */
function budgetLoreItems<T extends { metadataTruncated?: boolean; truncated?: boolean }>(
  entries: readonly WorldInfoEntry[], mode: 'catalog' | 'content', budget: number,
  build: (entry: WorldInfoEntry) => T,
  fill?: (
    item: T,
    entry: WorldInfoEntry,
    tokensWithDelta: (deltaCjk: number, deltaOther: number, itemTruncated: boolean) => number,
    limit: number,
  ) => TokenCharCounts,
  extraHint?: string,
): LoreBudgetResult<T> {
  const limit = Math.max(0, Math.floor(budget)), out: T[] = []
  const baseHint = mode === 'catalog' ? '用 uid 或完整 key 取正文；disabled 条目仍可读。' : entries.length === 0 ? '无匹配。先不带参数看目录。' : ''
  const mergedHint = extraHint ? (baseHint ? `${baseHint} ${extraHint}` : extraHint) : baseHint
  const make = () => stampAssetTokens({ ok: true, mode, count: entries.length, entries: out, tokensUsed: 0,
    omitted: entries.length - out.length,
    truncated: entries.length > out.length || out.some(item => item.metadataTruncated || item.truncated),
    ...(mergedHint ? { hint: mergedHint } : {}),

  } as LoreBudgetResult<T>)
  const shellCache = new Map<number, TokenCharCounts>()
  const shellCounts = (len: number, truncated: boolean): TokenCharCounts => {
    const key = len * 2 + (truncated ? 1 : 0)
    let cached = shellCache.get(key)
    if (!cached) {
      const shell: LoreBudgetResult<T> = { ok: true, mode, count: entries.length, entries: [], tokensUsed: 0,
        omitted: entries.length - len, truncated, ...(mergedHint ? { hint: mergedHint } : {}) }
      cached = countTokenChars(JSON.stringify(shell, null, 2))
      shellCache.set(key, cached)
    }
    return cached
  }
  const estimateWith = (len: number, anyTruncated: boolean, cjk: number, other: number): number => {
    const shell = shellCounts(len, entries.length > len || anyTruncated)
    if (len === 0) return stabilizeJsonTokenCount(shell.cjk, shell.other)
    return stabilizeJsonTokenCount(shell.cjk + cjk, shell.other + 2 + 2 * len + other)
  }
  if (estimateWith(0, false, 0, 0) > limit) throw new Error('世界书输出预算不足以容纳响应元数据')
  let itemsCjk = 0, itemsOther = 0, anyItemTruncated = false
  for (const entry of entries) {
    if (mode === 'catalog' && out.length >= LORE_CATALOG_MAX) break
    const item = build(entry)
    const itemTrunc = Boolean(item.metadataTruncated || item.truncated)
    const delta = countPrettyArrayItemChars(item, 2)
    const nextLen = out.length + 1
    if (estimateWith(nextLen, anyItemTruncated || itemTrunc, itemsCjk + delta.cjk, itemsOther + delta.other) > limit) continue
    out.push(item)
    itemsCjk += delta.cjk
    itemsOther += delta.other
    if (fill) {
      const extra = fill(
        item,
        entry,
        (dCjk, dOther, trunc) => estimateWith(nextLen, anyItemTruncated || itemTrunc || trunc, itemsCjk + dCjk, itemsOther + dOther),
        limit,
      )
      itemsCjk += extra.cjk
      itemsOther += extra.other
    }
    if (item.metadataTruncated || item.truncated) anyItemTruncated = true
  }
  const result = make()
  if (entries.length && !out.length) {
    result.ok = false
    result.error = 'lore-output-too-large：完整定位字段超过输出预算，请选择其它条目或缩小阅读范围'
    stampAssetTokens(result)
    // 尽量保留结构化错误码；空间不足时先省略提示，再缩短错误文案。
    if (result.tokensUsed > limit) { delete result.hint; stampAssetTokens(result) }
    if (result.tokensUsed > limit) { result.error = 'lore-output-too-large'; stampAssetTokens(result) }
    // 连最小错误响应也放不下时明确失败，不能返回超预算结果。
    if (result.tokensUsed > limit) throw new Error('世界书错误响应超过输出预算')
    return result
  }
  if (result.tokensUsed > limit) throw new Error('世界书完整输出超过预算')
  return result
}

export function budgetLoreCatalog(entries: readonly WorldInfoEntry[], budget = LORE_READ_TOKEN_BUDGET, extraHint?: string): LoreBudgetResult<LoreCatalogItem> {
  return budgetLoreItems(entries, 'catalog', budget, entry => {
    const preview = clipAssetJsonText(toLoreCatalogItem(entry).preview, 80), metadata = boundedLoreMetadata(entry)
    return { ...metadata, tokens: estimateTokens(entry.content), preview: preview.text,
      metadataTruncated: preview.truncated || metadata.metadataTruncated }
  }, undefined, extraHint)
}

/** 正文按实际序列化响应拟合；控制字符转义、Unicode 代理对和字段计数都不能突破整份预算。 */
export function clipLoreContents(entries: readonly WorldInfoEntry[], budget = LORE_READ_TOKEN_BUDGET, extraHint?: string): LoreBudgetResult<LoreContentItem> {
  return budgetLoreItems<LoreContentItem>(entries, 'content', budget, entry => ({ ...boundedLoreMetadata(entry), content: '', truncated: false }),
    (item, entry, tokensWithDelta, limit) => {
      const suffix = '…（已截断）'
      // item 初始为 content: "", truncated: false；设为 truncated: true 时 JSON 字面量从 false(5) 变为 true(4)，即 -1 other。
      let jsonCjk = 0, jsonOther = 0
      let lo = 0, loJsonCjk = 0, loJsonOther = 0
      let exceeded = false
      const content = entry.content
      for (let i = 0; i < content.length;) {
        const code = content.charCodeAt(i)
        let step = 1
        if (code >= 0xd800 && code <= 0xdbff) {
          const next = i + 1 < content.length ? content.charCodeAt(i + 1) : 0
          if (next >= 0xdc00 && next <= 0xdfff) {
            step = 2
            jsonOther += 2
          } else {
            jsonOther += 6
          }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
          jsonOther += 6
        } else if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d) {
          jsonOther += 2
        } else if (code < 0x20) {
          jsonOther += 6
        } else if (isTokenCjkCode(code)) {
          jsonCjk += 1
        } else {
          jsonOther += 1
        }
        const nextIndex = i + step
        if (tokensWithDelta(jsonCjk + 3, jsonOther + 3 - 1, true) <= limit) {
          lo = nextIndex
          loJsonCjk = jsonCjk
          loJsonOther = jsonOther
        }
        if (tokensWithDelta(jsonCjk, jsonOther, false) > limit) {
          exceeded = true
          break
        }
        i = nextIndex
      }
      if (!exceeded) {
        item.content = content
        return { cjk: jsonCjk, other: jsonOther }
      }
      item.truncated = true
      if (tokensWithDelta(3, 3 - 1, true) > limit) {
        item.content = ''
        return { cjk: 0, other: -1 }
      }
      item.content = `${content.slice(0, lo)}${suffix}`
      return { cjk: loJsonCjk + 3, other: loJsonOther + 3 - 1 }
    }, extraHint)
}
