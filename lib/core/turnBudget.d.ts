/**
 * turn 层预算(纯函数):约束「每轮 runtime context 快照」里各部分的体积。
 *
 * 为什么 turn 层要独立于上下文窗口设上限:
 * dsh 把 runtime context 每轮追加成新的 user 快照,快照内容对新请求而言
 * 永远是未缓存前缀(DeepSeek 前缀缓存只认追加点之前的字节)。世界书/变化层
 * 这类「大体量、跨轮基本重复」的内容一旦搭上快照通道,就是每轮全价重付——
 * 实测一个会话的快照可达 ~37k 字符/轮,占总 miss 的大头。
 * 大窗口模型(v4-flash 宣告 1M)下按百分比折算的预算(25% = 25 万 token)
 * 完全约束不住;因此:
 * 1. 百分比预算的折算基数 clamp 到 WI_PERCENT_WINDOW_BASE(对齐传统窗口量级),
 *    超出部分交给固定 tokenBudget / 按条工具补读;
 * 2. 变化层(world delta)按 WORLD_DELTA_TURN_BUDGET 从最新往旧装载,
 *    装不下的不再进快照,模型可经 tavern_lore_read(source=delta)按条补读。
 */
import type { WorldDelta } from './types.js';
/** 百分比预算的折算基数上限:窗口再大也只按传统 128K 量级折算。 */
export declare const WI_PERCENT_WINDOW_BASE = 131072;
/** 变化层每轮进快照的 token 上限:从最新往旧装载,更旧的丢给工具补读。 */
export declare const WORLD_DELTA_TURN_BUDGET = 1500;
/** 从最新往旧装载变化层,超出预算的裁掉。输入须已是活跃列表(未 revoked、未过期)。 */
export declare function clipWorldDeltasForTurn(deltas: readonly WorldDelta[], estimateTokens: (text: string) => number, budget?: number): {
    kept: WorldDelta[];
    dropped: number;
};
