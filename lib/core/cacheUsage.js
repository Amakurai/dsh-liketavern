/**
 * 前缀缓存用量汇总：纯函数，把宿主 assistant/message 携带的 TokenUsage 按轮累计。
 * 宿主口径互不重叠：inputTokens 只含未缓存输入，缓存命中另记 cacheReadTokens。
 * 命中率 = 缓存读 / 全部输入（未缓存 + 缓存读 + 缓存写）；未上报 usage 的步骤不计入，也不当作 0 命中。
 */
function emptyTotals() {
    return { steps: 0, uncachedInput: 0, cacheRead: 0, cacheWrite: 0, output: 0, hitRate: null };
}
/** 宿主数值来自持久化日志；负数、NaN 或非数字一律按 0，不让一条坏记录污染整份统计。 */
function count(value) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
function add(totals, usage) {
    totals.steps++;
    totals.uncachedInput += count(usage.inputTokens);
    totals.cacheRead += count(usage.cacheReadTokens);
    totals.cacheWrite += count(usage.cacheWriteTokens);
    totals.output += count(usage.outputTokens);
}
function finish(totals) {
    const input = totals.uncachedInput + totals.cacheRead + totals.cacheWrite;
    return { ...totals, hitRate: input > 0 ? totals.cacheRead / input : null };
}
export function summarizeCacheUsage(steps, limit = 20) {
    const byTurn = new Map();
    const total = emptyTotals();
    for (const usage of steps) {
        let turn = byTurn.get(usage.turn);
        if (!turn)
            byTurn.set(usage.turn, turn = { turn: usage.turn, ...emptyTotals() });
        add(turn, usage);
        add(total, usage);
    }
    // slice(-0) 等同 slice(0)，会把应隐藏的轮次全部展示；先归一化，再单独处理关闭展示。
    const count = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    const turns = count === 0 ? [] : [...byTurn.values()].sort((a, b) => a.turn - b.turn).slice(-count).map(finish);
    return { turns, total: finish(total) };
}
