import type { Context } from '@deepseek-ai/cordis';
import { type LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { TavernState } from './state.js';
/** 用指定模型把一批旧记忆压缩合并为一条；失败返回 null。 */
export declare function compressMemoryBatch(llm: LlmRuntime, provider: string, model: string, bodies: string[], maintenanceSignal?: AbortSignal): Promise<string | null>;
/**
 * 压缩指定角色工作区最旧的一批记忆（compressBatch 条）为一条。
 * 无模型 / 空批次 / 合并失败返回 null；成功返回合并正文与归档条数。
 */
export declare function compressOldestMemories(state: TavernState, llm: LlmRuntime | undefined, cardId: string, provider: string | undefined, model: string | undefined, storyId?: string, maintenanceSignal?: AbortSignal): Promise<{
    merged: string;
    archived: number;
} | null>;
/** attempted 登记表上限：与 triggerLogs/helperTurnClosures 的有界淘汰口径一致，剧情数量增长不让进程内登记无界膨胀。 */
export declare const ATTEMPTED_KEYS_MAX = 256;
/** 「每个已结束轮次只尝试一次」的登记表更新；超限时淘汰最旧 key（Map 迭代序 = 插入序）。 */
export declare function noteAttemptedMarker(attempted: Map<string, string>, key: string, marker: string, max?: number): void;
/**
 * agent 面注册：turn 结束（status → idle）且本会话工作区有压缩标记、或有记忆还没有检索别名时，runMaintenance 执行维护。
 * runMaintenance 在 turn-driving 时会同步 throw（与本事件的 idle 之间存在输入竞态）——
 * 任务未执行则保留标记待下次 idle；失败保留 pending，但每个已结束轮次只尝试一次。
 * 别名补全遇到新输入立即取消让路，不计为本轮尝试；压缩照常完成。
 */
export declare function registerMemoryMaintenance(ctx: Context, state: TavernState, llm: LlmRuntime | undefined): void;
