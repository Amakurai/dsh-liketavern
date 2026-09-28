/**
 * 前缀缓存用量汇总：纯函数，把宿主 assistant/message 携带的 TokenUsage 按轮累计。
 * 宿主口径互不重叠：inputTokens 只含未缓存输入，缓存命中另记 cacheReadTokens。
 * 命中率 = 缓存读 / 全部输入（未缓存 + 缓存读 + 缓存写）；未上报 usage 的步骤不计入，也不当作 0 命中。
 */
export interface StepUsage {
    turn: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
}
export interface CacheUsageTotals {
    steps: number;
    /** 未缓存输入：每轮真正按全价计费的部分。 */
    uncachedInput: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    /** 0–1；没有任何输入时为 null。 */
    hitRate: number | null;
}
export interface CacheUsageSummary {
    /** 按轮升序，只保留最近 limit 轮。 */
    turns: Array<CacheUsageTotals & {
        turn: number;
    }>;
    /** 全部已上报步骤的累计，不受 limit 影响。 */
    total: CacheUsageTotals;
}
export declare function summarizeCacheUsage(steps: readonly StepUsage[], limit?: number): CacheUsageSummary;
