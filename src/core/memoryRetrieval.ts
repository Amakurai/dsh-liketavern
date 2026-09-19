/**
 * 长期记忆检索结果的纯函数治理：统一时间衰减参数，并在 token 预算内挑选正文。
 */
import type { MemoryEntry } from './types.js'
import { clipToTokenBudget, estimateTokens } from './tokenize.js'

const DAY_MS = 24 * 60 * 60 * 1000
/** 自动入模超取有界；最终条数仍由 retrievalTopK 单独限制。 */
export const MEMORY_CANDIDATE_LIMIT = 200
const CANDIDATE_MULTIPLIER = 4

/** 只对入模候选超取，手动 memory_search 仍使用 memorySearchOptions 的原始 topK。 */
export function memoryCandidateCount(topK: number): number {
  const normalized = memorySearchOptions(topK, 0).topK
  return Math.min(MEMORY_CANDIDATE_LIMIT, normalized * CANDIDATE_MULTIPLIER)
}

/** 摘要的完整叶来源集合由存储层按当前剧情解析；普通原文不设此字段，始终可补充摘要细节。 */
export interface MemoryBodyCandidate {
  entry: Pick<MemoryEntry, 'body'>
  summarySourceIds?: readonly string[]
}

/** 配置天数转 BM25 的毫秒半衰期；0/非法值表示不衰减。 */
export function memorySearchOptions(topK: number, halfLifeDays: number): { topK: number; halfLifeMs?: number } {
  const normalizedTopK = Number.isFinite(topK) ? Math.max(0, Math.floor(topK)) : 0
  const milliseconds = halfLifeDays * DAY_MS
  const halfLifeMs = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined
  return halfLifeMs === undefined ? { topK: normalizedTopK } : { topK: normalizedTopK, halfLifeMs }
}

/**
 * 按相关性顺序装入预算，跳过空正文与已选正文的重复项（仅忽略首尾空白），限制最终条数。
 * 同一完整叶来源集合的摘要优先保留首个可装入条目，其它摘要延后补位；来源原文不受影响。
 * 单条过大时继续寻找后续可完整放入的条目；
 * 若没有任何完整条目可用，则截取最高相关的超大条目，避免本轮记忆层完全为空。
 */
export function selectMemoryBodies(
  hits: readonly MemoryBodyCandidate[],
  tokenBudget: number,
  topK = hits.length,
): string[] {
  const budget = Number.isFinite(tokenBudget) ? Math.max(0, Math.floor(tokenBudget)) : 0
  const limit = memorySearchOptions(topK, 0).topK
  if (budget === 0 || limit === 0) return []
  const selected: string[] = []
  const selectedBodies = new Set<string>()
  const selectedSummarySources = new Set<string>()
  const deferred: MemoryBodyCandidate[] = []
  let used = 0
  let firstOversized: string | null = null
  const select = (hit: MemoryBodyCandidate, diversify: boolean): void => {
    const body = hit.entry.body
    const identity = body.trim()
    if (!identity || selectedBodies.has(identity)) return
    const sources = hit.summarySourceIds?.length ? JSON.stringify([...new Set(hit.summarySourceIds)].sort()) : undefined
    if (diversify && sources && selectedSummarySources.has(sources)) {
      deferred.push(hit)
      return
    }
    const tokens = estimateTokens(body)
    if (used + tokens <= budget) {
      selected.push(body)
      selectedBodies.add(identity)
      if (sources) selectedSummarySources.add(sources)
      used += tokens
    } else if (firstOversized === null) {
      firstOversized = body
    }
  }
  for (const hit of hits) {
    if (selected.length >= limit) break
    select(hit, true)
  }
  for (const hit of deferred) {
    if (selected.length >= limit) break
    select(hit, false)
  }
  if (selected.length > 0 || firstOversized === null) return selected
  const clipped = clipToTokenBudget(firstOversized, budget)
  return clipped.text.trim() ? [clipped.text] : []
}
