import type { Context } from '@deepseek-ai/cordis';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { type HelperDisplayContext, type HelperSnapshot, type HelperSnapshotBase } from '../core/helperRuntime.js';
import type { WorkspaceFs } from '../state/workspaceFs.js';
import type { TavernState } from './state.js';
import { type HelperScriptAsset, type HelperScriptBundle } from '../core/helperScripts.js';
import type { SessionBinding } from '../core/binding.js';
import type { HelperFrameWriteGuard } from '../core/helperFrame.js';
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
 * 同一次展示批次共享的剧情读视图：剧情锁内只读取、校验一次历史与变量，再按消息 seq 派生
 * 各气泡的上下文或快照公共部分。逐条请求时每条都重读变量文件、重建整段消息列表，
 * 长历史首屏会退化为 O(消息数²)。
 */
export interface HelperDisplaySet {
    context(seq: number): HelperDisplayContext;
    /** 仅 withSnapshot=true 时存在；各气泡只差 currentMessageId，messages/scopes 共用引用。 */
    base?: HelperSnapshotBase;
}
export declare function loadHelperDisplaySet(ctx: Context, state: TavernState, sessionId: string, withSnapshot: boolean): Promise<HelperDisplaySet>;
/**
 * 纯文本展示只返回剧情/历史身份与当前消息角色；仍在剧情锁内二次读取，
 * 与完整 HelperSnapshot 保持同一套绑定和历史修订校验，但不读取、复制变量表。
 */
export declare function getHelperDisplayContext(ctx: Context, state: TavernState, sessionId: string, messageId: number): Promise<HelperDisplayContext>;
export declare function getHelperSnapshot(ctx: Context, state: TavernState, sessionId: string, messageId: number): Promise<HelperSnapshot>;
/** 会话实际加载的三类脚本库。预设被删除或损坏时与 getSessionHelperScripts 同口径：按没有预设脚本处理，不让整个脚本包失败。 */
export declare function sessionHelperLibraries(state: TavernState, binding: Pick<SessionBinding, 'presetId' | 'cardId'>): Promise<HelperScriptAsset[]>;
export declare function getHelperScriptBundle(ctx: Context, state: TavernState, sessionId: string): Promise<HelperScriptBundle>;
export declare function commitHelperVariables(ctx: Context, state: TavernState, request: {
    sessionId: string;
    messageId: number;
    storyId: string;
    historyRevision: string;
    changes: unknown;
}, beforeWrite?: HelperFrameWriteGuard): Promise<HelperSnapshot>;
/** 聊天世界书等沙箱剧情写入复用楼层纪律；先验证业务内容，再调用 begin，最后 WAL 提交。 */
export declare function withHelperStoryWrite<T>(ctx: Context, state: TavernState, sessionId: string, messageId: number, storyId: string, write: (fs: WorkspaceFs, begin: () => Promise<void>) => Promise<T>, beforeWrite?: HelperFrameWriteGuard): Promise<T>;
