/** 百分比预算的折算基数上限:窗口再大也只按传统 128K 量级折算。 */
export const WI_PERCENT_WINDOW_BASE = 131072;
/** 变化层每轮进快照的 token 上限:从最新往旧装载,更旧的丢给工具补读。 */
export const WORLD_DELTA_TURN_BUDGET = 1500;
/** 从最新往旧装载变化层,超出预算的裁掉。输入须已是活跃列表(未 revoked、未过期)。 */
export function clipWorldDeltasForTurn(deltas, estimateTokens, budget = WORLD_DELTA_TURN_BUDGET) {
    const newestFirst = [...deltas].reverse();
    const kept = [];
    let used = 0;
    let dropped = 0;
    for (const delta of newestFirst) {
        const cost = estimateTokens(delta.content);
        if (used + cost > budget) {
            dropped += 1;
            continue;
        }
        used += cost;
        kept.push(delta);
    }
    // 恢复原时序(旧→新),与未裁剪时的展示顺序一致
    return { kept: kept.reverse(), dropped };
}
