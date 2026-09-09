import type { HelperSnapshot } from '../core/helperRuntime.js';
type NativeMvu = {
    current: () => boolean;
    snapshot: () => HelperSnapshot | undefined;
};
type Message = Record<string, unknown>;
export declare function attachHelperEvents(sessionId: string, storyId: string, send: (message: Message) => void, nativeMvu?: NativeMvu): {
    matchesRuntime: (id: unknown) => boolean;
    receive: (value: unknown) => void;
    dispose: () => void;
};
/** 仅宿主代码调用此入口；事件来自实际显示生命周期，不接受 iframe 指定会话或历史位置。 */
export declare function emitHelperHostEvent(sessionId: string, storyId: string, event: 'character_message_rendered' | 'user_message_rendered' | 'chat_id_changed' | 'message_sent' | 'message_received' | 'generation_started' | 'generation_ended' | 'generation_stopped', data: unknown[], current?: () => boolean): Promise<void>;
export declare function reportHelperHostEventError(sessionId: string, storyId: string, error: unknown): void;
export declare function hasHelperEventAudience(sessionId: string): boolean;
export {};
