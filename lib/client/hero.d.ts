import { type UseSessions } from './mode.js';
import type { TavernRemote } from './types.js';
import './styles.js';
interface HeroSession {
    blank?: boolean;
    promptAttempted?: boolean;
}
interface HeroProps {
    remote: TavernRemote;
    sessionId: string;
    sessions: {
        open(id: string): void;
        refresh?: () => Promise<void>;
    };
    session?: HeroSession;
    useSessions?: UseSessions;
}
/** 会话切换时卸载旧选择器，异步结果不能把忙碌态、错误或弹窗带到新会话。 */
export declare function TavernHeroCharacter(props: HeroProps): import("react").JSX.Element;
export {};
