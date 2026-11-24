import type { Context } from '@deepseek-ai/cordis';
import type { SessionBinding } from '../core/binding.js';
import type { HelperFrameClose, HelperFrameLease, HelperFrameOpen, HelperFrameWriteGuard } from '../core/helperFrame.js';
import type { TavernState } from './state.js';
export declare function openHelperFrame(ctx: Context, state: TavernState, request: HelperFrameOpen): Promise<{
    token: string;
}>;
export declare function closeHelperFrame(state: TavernState, request: HelperFrameClose): void;
/** 会话卸载或解绑时撤销该会话的全部活动卡面租约，保留有界墓碑释放连接预算并阻止迟到写入。 */
export declare function revokeSessionHelperFrames(state: TavernState, sessionId: string): void;
/** 绑定变更后撤销不再匹配新绑定指纹的活动卡面租约，避免旧帧继续占用 1024 预算或持有失效令牌。 */
export declare function revokeStaleBindingHelperFrames(state: TavernState, sessionId: string, binding: SessionBinding): void;
export declare function helperFrameWriteGuard(state: TavernState, scope: {
    sessionId: string;
    messageId?: number;
    storyId?: string;
}, lease?: HelperFrameLease): HelperFrameWriteGuard | undefined;
