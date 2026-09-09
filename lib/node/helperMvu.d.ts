import type { Context } from '@deepseek-ai/cordis';
import type { Session } from '@deepseek-ai/dsh-session';
import { type HelperMvuWork } from '../core/helperMvu.js';
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
export declare function helperMvuPending(state: TavernState, sessionId: string, includeInitialization?: boolean): Promise<boolean>;
/** 脚本加载阶段允许先播种数据；任务一经登记，普通变量/消息/世界书写必须等待本批事务完成。 */
export declare function assertHelperMvuWritable(state: TavernState, sessionId: string): Promise<void>;
/** 后台脚本在任何沙箱挂载前取得安全锚点并播种静态 data；不会领取执行租约或执行第三方代码。 */
export declare function ensureHelperMvuScriptAnchor(ctx: Context, state: TavernState, sessionId: string, storyId: string): Promise<number | null>;
export declare function prepareHelperMvuJob(ctx: Context, state: TavernState, request: Request): Promise<HelperMvuWork>;
export declare function commitHelperMvuJob(ctx: Context, state: TavernState, request: Request & {
    jobId: string;
    token: string;
    data: unknown;
}): Promise<HelperMvuWork>;
export {};
