import type { Context } from '@deepseek-ai/cordis';
import type { HelperFrameClose, HelperFrameLease, HelperFrameOpen, HelperFrameWriteGuard } from '../core/helperFrame.js';
import type { TavernState } from './state.js';
export declare function openHelperFrame(ctx: Context, state: TavernState, request: HelperFrameOpen): Promise<{
    token: string;
}>;
export declare function closeHelperFrame(state: TavernState, request: HelperFrameClose): void;
export declare function helperFrameWriteGuard(state: TavernState, scope: {
    sessionId: string;
    messageId?: number;
    storyId?: string;
}, lease?: HelperFrameLease): HelperFrameWriteGuard | undefined;
