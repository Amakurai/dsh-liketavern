/**
 * 记忆异步压缩：memory_write 超容量时只标记（state.requestMemoryCompress），
 * turn 结束后经 agent.runMaintenance 用当前会话模型把最旧一批记忆合并为一条。
 *
 * 语义约定：maintenance 在楼层之外运行，WorkspaceFs 的 floor 为 null →
 * 压缩写入不记 WAL、不随楼层回滚（压缩是无损整理，不增删剧情事实；
 * 记忆条目本身的写入仍在 turn 内、照常回滚）。
 * 同步压缩曾阻塞该 step 的 LLM 流式调用数秒，挪到 idle 期后写工具立即返回。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
import type { TavernState } from './state.js';
/** 用指定模型把一批旧记忆压缩合并为一条；失败返回 null。 */
export declare function compressMemoryBatch(llm: LlmRuntime, provider: string, model: string, bodies: string[]): Promise<string | null>;
/**
 * 压缩指定角色工作区最旧的一批记忆（compressBatch 条）为一条。
 * 无模型 / 空批次 / 合并失败返回 null；成功返回合并正文与归档条数。
 */
export declare function compressOldestMemories(state: TavernState, llm: LlmRuntime | undefined, cardId: string, provider: string | undefined, model: string | undefined): Promise<{
    merged: string;
    archived: number;
} | null>;
/**
 * agent 面注册：turn 结束（status → idle）且本会话工作区有压缩标记时，runMaintenance 执行压缩。
 * runMaintenance 在 turn-driving 时会同步 throw（与本事件的 idle 之间存在输入竞态）——
 * 任务未执行则保留标记待下次 idle；执行过（无论成败）即清除，下一轮超容量写入会再标记。
 */
export declare function registerMemoryMaintenance(ctx: Context, state: TavernState, llm: LlmRuntime | undefined): void;
