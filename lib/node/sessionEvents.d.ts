/** 展示用历史读取：优先在线会话，冷会话只检查不可变日志，不触发恢复写入或启动 agent。 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
export declare function displaySessionHasUserMessage(events: readonly SessionEvent[]): boolean;
/** 按不可变快照建立一次 seq 索引；兼容测试桩及未来可能返回的非零起点只读切片。 */
export declare function displaySessionEventAt(events: readonly SessionEvent[], seq: number): SessionEvent | undefined;
export declare function readDisplaySessionEvents(ctx: Context, sessionId: string): Promise<readonly SessionEvent[]>;
