import type { Context } from '@deepseek-ai/cordis';
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session';
import { type HelperMvuWork } from '../core/helperMvu.js';
import type { SessionBinding } from '../core/binding.js';
import type { TavernState } from './state.js';
type Snapshot = Pick<Session, 'id' | 'snapshotEvents'>;
type Request = {
    sessionId: string;
    storyId: string;
    runtimeId: string;
};
export declare function revokeHelperMvuLease(state: TavernState, sessionId: string, storyId: string): void;
export declare const queueHelperMvuTurn: (state: TavernState, sessionId: string, session: Snapshot) => Promise<void>;
export declare const queueHelperMvuStop: (state: TavernState, sessionId: string, session: Snapshot) => Promise<void>;
export declare function helperMvuPending(state: TavernState, sessionId: string, includeInitialization?: boolean, initAnchorTurn?: number | null): Promise<boolean>;
/** 续写前预检：原生 MVU 开启时核对来源回复能否被续写链路恢复，避免开启注定无法收口的续写轮。 */
export declare function assertHelperMvuContinuable(state: TavernState, sessionId: string, events: readonly SessionEvent[], bindingOverride?: SessionBinding | null): Promise<void>;
/** 脚本加载阶段允许先播种数据；任务一经登记，普通变量/消息/世界书写必须等待本批事务完成。 */
export declare function assertHelperMvuWritable(state: TavernState, sessionId: string, options?: {
    waitForAdoption?: boolean;
}): Promise<void>;
/** 统一判定可作为 MVU 初始化/锚点的最新完成角色回复，供门控与任务准备共用，避免判定漂移。 */
export declare function latestCompletedMvuAssistant(events: readonly SessionEvent[]): SessionEvent<'assistant/message'> | undefined;
/** 后台脚本在任何沙箱挂载前取得安全锚点并播种静态 data；不会领取执行租约或执行第三方代码。 */
export declare function ensureHelperMvuScriptAnchor(ctx: Context, state: TavernState, sessionId: string, storyId: string): Promise<number | null>;
export declare function prepareHelperMvuJob(ctx: Context, state: TavernState, request: Request): Promise<HelperMvuWork>;
export declare function commitHelperMvuJob(ctx: Context, state: TavernState, request: Request & {
    jobId: string;
    token: string;
    data: unknown;
}): Promise<HelperMvuWork>;
export {};
