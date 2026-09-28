/**
 * 前缀缓存用量汇总：纯函数，把宿主 assistant/message 携带的 TokenUsage 按轮累计。
 * 宿主口径互不重叠：inputTokens 只含未缓存输入，缓存命中另记 cacheReadTokens。
 * 命中率 = 缓存读 / 全部输入（未缓存 + 缓存读 + 缓存写）；未上报 usage 的步骤不计入，也不当作 0 命中。
 */

export interface StepUsage {
  turn: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface CacheUsageTotals {
  steps: number
  /** 未缓存输入：每轮真正按全价计费的部分。 */
  uncachedInput: number
  cacheRead: number
  cacheWrite: number
  output: number
  /** 0–1；没有任何输入时为 null。 */
  hitRate: number | null
}

export interface CacheUsageSummary {
  /** 按轮升序，只保留最近 limit 轮。 */
  turns: Array<CacheUsageTotals & { turn: number }>
  /** 全部已上报步骤的累计，不受 limit 影响。 */
  total: CacheUsageTotals
}

function emptyTotals(): CacheUsageTotals {
  return { steps: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, hitRate: null }
}

/** 宿主数值来自持久化日志；负数、NaN 或非数字一律按 0，不让一条坏记录污染整份统计。 */
function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function add(totals: CacheUsageTotals, usage: StepUsage): void {
  totals.steps++
  totals.uncachedInput += count(usage.inputTokens)
  totals.cacheRead += count(usage.cacheReadTokens)
  totals.cacheWrite += count(usage.cacheWriteTokens)
  totals.output += count(usage.outputTokens)
}

function finish<T extends CacheUsageTotals>(totals: T): T {
  const input = totals.uncachedInput + totals.cacheRead + totals.cacheWrite
  return { ...totals, hitRate: input > 0 ? totals.cacheRead / input : null }
}

export function summarizeCacheUsage(steps: readonly StepUsage[], limit = 20): CacheUsageSummary {
  const byTurn = new Map<number, CacheUsageTotals & { turn: number }>()
  const total = emptyTotals()
  for (const usage of steps) {
    let turn = byTurn.get(usage.turn)
    if (!turn) byTurn.set(usage.turn, turn = { turn: usage.turn, ...emptyTotals() })
    add(turn, usage)
    add(total, usage)
  }
  const turns = [...byTurn.values()].sort((a, b) => a.turn - b.turn).slice(-Math.max(0, limit)).map(finish)
  return { turns, total: finish(total) }
}
