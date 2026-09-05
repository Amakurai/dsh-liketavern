import type { TavernRemote } from './types.js';
interface SpeechBubbleProps {
    remote: TavernRemote;
    sessionId: string;
    cardId: string;
    name: string;
    rawText: string;
    messageId?: number;
    streaming?: boolean;
    /** 会话级交互卡开关（binding.interactiveCards）；null/缺省回落全局设置。 */
    interactiveCards?: boolean | null;
    onSwipeGreeting?: (index: number) => void | Promise<void>;
}
/** 按会话和角色卸载旧气泡状态，慢请求的报错不能留到新会话。 */
export declare function SpeechBubble(props: SpeechBubbleProps): import("react").JSX.Element;
export {};
