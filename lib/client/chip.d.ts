import { type UseSessions } from './mode.js';
import type { SessionBinding, TavernRemote, TavernSettings } from './types.js';
export declare function defaultBinding(sessionId: string, cardId: string, defaults?: TavernSettings['defaults']): SessionBinding;
export declare function bindingFromDefaults(remote: TavernRemote, sessionId: string, cardId: string): Promise<SessionBinding>;
export declare function TavernHeaderChip(props: {
    remote: TavernRemote;
    sessionId: string;
    sessions: {
        open(id: string): void;
        refresh?: () => Promise<void>;
    };
    useSessions?: UseSessions;
}): any;
