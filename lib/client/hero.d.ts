import { type UseSessions } from './mode.js';
import type { TavernRemote } from './types.js';
import './styles.js';
interface HeroSession {
    blank?: boolean;
    composerPhase?: string;
}
export declare function TavernHeroCharacter(props: {
    remote: TavernRemote;
    sessionId: string;
    sessions: {
        open(id: string): void;
    };
    session?: HeroSession;
    useSessions?: UseSessions;
}): any;
export {};
