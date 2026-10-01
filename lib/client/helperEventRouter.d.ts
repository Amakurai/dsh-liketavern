import type { HelperSnapshot } from '../core/helperRuntime.js';
type NativeMvu = {
    current: () => boolean;
    snapshot: () => HelperSnapshot | undefined;
};
type Message = Record<string, unknown>;
/** 预览只建立本帧身份租约；没有剧情分组，不接收跨卡监听、发送或业务授权。 */
export declare function attachCardBridgeRuntime(send: (message: Message) => void, retiredRuntimes?: Set<string>): {
    matchesRuntime: (id: unknown) => boolean;
    runtimeId: () => string;
    post: (message: Message) => void;
    setHostEventsEnabled: (enabled: boolean) => void;
    receive: (value: unknown) => void;
    dispose: () => void;
};
export declare function attachHelperEvents(sessionId: string, storyId: string, send: (message: Message) => void, nativeMvu?: NativeMvu, retiredRuntimes?: Set<string>): {
    matchesRuntime: (id: unknown) => boolean;
    /** 仅可信 UI 使用：业务桥与宿主事件共用当前沙箱身份，避免回执跨 document.write 运行时。 */
    runtimeId: () => string;
    post: (message: Message) => void;
    /** 重绘锁定旧卡时只暂停宿主生命周期事件；普通卡间事件和监听注册仍保持原运行时。 */
    setHostEventsEnabled: (enabled: boolean) => void;
    receive: (value: unknown) => void;
    dispose: () => void;
};
/** 仅宿主代码调用此入口；事件来自实际显示生命周期，不接受 iframe 指定会话或历史位置。 */
export declare function emitHelperHostEvent(sessionId: string, storyId: string, event: 'character_message_rendered' | 'user_message_rendered' | 'chat_id_changed' | 'message_sent' | 'message_received' | 'generation_started' | 'generation_ended' | 'generation_stopped', data: unknown[], current?: () => boolean): Promise<void>;
export declare function reportHelperHostEventError(sessionId: string, storyId: string, error: unknown): void;
export declare function hasHelperEventAudience(sessionId: string): boolean;
export {};
