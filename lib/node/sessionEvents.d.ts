/** 展示用历史读取：优先在线会话，冷会话只检查不可变日志，不触发恢复写入或启动 agent。 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** 逆序查找最近一条满足条件的会话事件，避免 `[...events].reverse()` 在长历史上反复复制数组。 */
export declare function findLastEvent<E extends SessionEvent>(events: readonly SessionEvent[], predicate: (event: SessionEvent) => event is E): E | undefined;
export declare function findLastEvent(events: readonly SessionEvent[], predicate: (event: SessionEvent) => boolean): SessionEvent | undefined;
export declare function displaySessionHasUserMessage(events: readonly SessionEvent[]): boolean;
/** 按不可变快照建立一次 seq 索引；兼容测试桩及未来可能返回的非零起点只读切片。 */
export declare function displaySessionEventAt(events: readonly SessionEvent[], seq: number): SessionEvent | undefined;
export declare function readDisplaySessionEvents(ctx: Context, sessionId: string): Promise<readonly SessionEvent[]>;
