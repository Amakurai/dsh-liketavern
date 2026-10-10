/**
 * 记忆的空闲维护，两件事共用一次 agent.runMaintenance，每次空闲只做其中一件：
 * - 异步压缩：memory_write 超容量时只标记（state.pendingMemoryCompress），
 *   turn 结束后用当前会话模型把最旧一批记忆合并为一条。
 * - 检索别名：没有待压缩的批次时，为还没有别名的记忆请模型补上（见 core/memoryAliases.ts）。
 *   别名是派生数据，写进 memory/aliases.json，不改记忆文件；失败不留痕迹，下一个结束的轮次再试。
 *
 * 语义约定：maintenance 在楼层之外运行，写入走 state.plainWorkspace 的
 * floor=null 文件面，压缩本身不记 WAL；原文归档并保留来源链。
 * 源记忆回滚时先展开相关摘要再撤销原文，避免摘要残留已撤销事实。即使同卡的
 * 另一会话正在生成中（其楼层由 withFloor 派生实例持有），这里也绝不会被记进 WAL。
 * 同步压缩曾阻塞该 step 的 LLM 流式调用数秒，挪到 idle 期后写工具立即返回。
 */
import type { Context } from '@deepseek-ai/cordis';
import type { LlmRuntime } from '@deepseek-ai/dsh-llm';
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
/**
 * 请模型为一批记忆写检索别名；返回与输入等长的数组（没有对应行的位置为 null）。
 * 只接受正常 stop 终止帧：超时、截断、取消、出错都返回 null，调用方不保存任何东西。
 */
export declare function requestMemoryAliases(llm: LlmRuntime, provider: string, model: string, bodies: string[], maintenanceSignal?: AbortSignal): Promise<Array<string[] | null> | null>;
/**
 * 为最新的一批还没有别名的记忆生成并保存别名。
 * 无模型、取消或请求失败返回 null（什么都不保存，以后重试）；成功返回保存的条数与其中拿到别名的条数。
 * 正常结束的回复里没有对应行的记忆记为空列表：不为同一段正文反复请求。
 */
export declare function expandMemoryAliases(state: TavernState, llm: LlmRuntime | undefined, cardId: string, provider: string | undefined, model: string | undefined, storyId?: string, maintenanceSignal?: AbortSignal): Promise<{
    saved: number;
    named: number;
} | null>;
/**
 * agent 面注册：turn 结束（status → idle）且本会话工作区有压缩标记、或有记忆还没有检索别名时，runMaintenance 执行维护。
 * runMaintenance 在 turn-driving 时会同步 throw（与本事件的 idle 之间存在输入竞态）——
 * 任务未执行则保留标记待下次 idle；失败保留 pending，但每个已结束轮次只尝试一次。
 */
export declare function registerMemoryMaintenance(ctx: Context, state: TavernState, llm: LlmRuntime | undefined): void;
