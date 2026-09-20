import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { type HelperDisplayContext, type HelperSnapshot } from '../core/helperRuntime.js';
import type { WorkspaceFs } from '../state/workspaceFs.js';
import type { TavernState } from './state.js';
import { type HelperScriptBundle } from '../core/helperScripts.js';
export declare function helperHistoryOf(events: readonly SessionEvent[], names: {
    char: string;
    user: string;
}): {
    seq: number;
    identity: string;
    name: string;
    role: "user" | "assistant";
    message: string;
}[];
export declare function helperHistoryRevision(history: ReturnType<typeof helperHistoryOf>): string;
/**
 * 纯文本展示只返回剧情/历史身份与当前消息角色；仍在剧情锁内二次读取，
 * 与完整 HelperSnapshot 保持同一套绑定和历史修订校验，但不读取、复制变量表。
 */
export declare function getHelperDisplayContext(ctx: Context, state: TavernState, sessionId: string, messageId: number): Promise<HelperDisplayContext>;
export declare function getHelperSnapshot(ctx: Context, state: TavernState, sessionId: string, messageId: number): Promise<HelperSnapshot>;
export declare function getHelperScriptBundle(ctx: Context, state: TavernState, sessionId: string): Promise<HelperScriptBundle>;
export declare function commitHelperVariables(ctx: Context, state: TavernState, request: {
    sessionId: string;
    messageId: number;
    storyId: string;
    historyRevision: string;
    changes: unknown;
}): Promise<HelperSnapshot>;
/** 聊天世界书等沙箱剧情写入复用楼层纪律；先验证业务内容，再调用 begin，最后 WAL 提交。 */
export declare function withHelperStoryWrite<T>(ctx: Context, state: TavernState, sessionId: string, messageId: number, storyId: string, write: (fs: WorkspaceFs, begin: () => Promise<void>) => Promise<T>): Promise<T>;
