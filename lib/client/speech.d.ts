import type { TavernRemote } from './types.js';
import './styles.js';
export declare function SpeechBubble(props: {
    remote: TavernRemote;
    sessionId: string;
    cardId: string;
    name: string;
    rawText: string;
    streaming?: boolean;
    /** 会话级交互卡开关（binding.interactiveCards）；null/缺省回落全局设置。 */
    interactiveCards?: boolean | null;
    onSwipeGreeting?: (index: number) => void;
}): import("react").JSX.Element;
