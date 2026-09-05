/** 展示用历史读取：优先在线会话，冷会话只检查不可变日志，不触发恢复写入或启动 agent。 */
import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
export declare function readDisplaySessionEvents(ctx: Context, sessionId: string): Promise<readonly SessionEvent[]>;
