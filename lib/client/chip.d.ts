import { type UseSessions } from './mode.js';
import type { SessionBinding, TavernRemote, TavernSettings } from './types.js';
export declare function defaultBinding(sessionId: string, cardId: string, defaults?: TavernSettings['defaults']): SessionBinding;
export declare function bindingFromDefaults(remote: TavernRemote, sessionId: string, cardId: string): Promise<SessionBinding>;
/** 独立于脚本运行器和全局交互开关的恢复入口；只在确认后放弃任务，不触碰宿主输入队列。 */
export declare function HelperMvuAbandonAction(props: {
    remote: TavernRemote;
    sessionId: string;
    storyId: string;
    onChanged: () => void;
}): import("react").JSX.Element;
export declare function TavernHeaderChip(props: {
    remote: TavernRemote;
    sessionId: string;
    sessions: {
        open(id: string): void;
        refresh?: () => Promise<void>;
    };
    onCancel?: () => Promise<void>;
    useSessions?: UseSessions;
}): import("react").JSX.Element | null;
