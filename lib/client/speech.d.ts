import type { TavernRemote } from './types.js';
import './styles.js';
export declare function SpeechBubble(props: {
    remote: TavernRemote;
    sessionId: string;
    cardId: string;
    name: string;
    rawText: string;
    streaming?: boolean;
    onSwipeGreeting?: (index: number) => void;
}): any;
