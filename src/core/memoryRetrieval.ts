/**
 * 长期记忆检索结果的纯函数治理：统一时间衰减参数，并在 token 预算内挑选正文。
 */
import type { MemoryEntry } from './types.js'
import { clipToTokenBudget, estimateTokens } from './tokenize.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** 配置天数转 BM25 的毫秒半衰期；0/非法值表示不衰减。 */
export function memorySearchOptions(topK: number, halfLifeDays: number): { topK: number; halfLifeMs?: number } {
  const normalizedTopK = Number.isFinite(topK) ? Math.max(0, Math.floor(topK)) : 0
  const milliseconds = halfLifeDays * DAY_MS
  const halfLifeMs = Number.isFinite(milliseconds) && milliseconds > 0 ? milliseconds : undefined
  return halfLifeMs === undefined ? { topK: normalizedTopK } : { topK: normalizedTopK, halfLifeMs }
}

/**
 * 按相关性顺序装入预算，跳过空正文与已选正文的重复项（仅忽略首尾空白）。
 * 单条过大时继续寻找后续可完整放入的条目；
 * 若没有任何完整条目可用，则截取最高相关的超大条目，避免本轮记忆层完全为空。
 */
export function selectMemoryBodies(
  hits: readonly { entry: Pick<MemoryEntry, 'body'> }[],
  tokenBudget: number,
): string[] {
  const budget = Number.isFinite(tokenBudget) ? Math.max(0, Math.floor(tokenBudget)) : 0
  if (budget === 0) return []
  const selected: string[] = []
  const selectedBodies = new Set<string>()
  let used = 0
  let firstOversized: string | null = null
  for (const hit of hits) {
    const body = hit.entry.body
    const identity = body.trim()
    if (!identity || selectedBodies.has(identity)) continue
    const tokens = estimateTokens(body)
    if (used + tokens <= budget) {
      selected.push(body)
      selectedBodies.add(identity)
      used += tokens
    } else if (firstOversized === null) {
      firstOversized = body
    }
  }
  if (selected.length > 0 || firstOversized === null) return selected
  const clipped = clipToTokenBudget(firstOversized, budget)
  return clipped.text.trim() ? [clipped.text] : []
}
