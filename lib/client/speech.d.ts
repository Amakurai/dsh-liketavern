import type { TavernRemote } from './types.js';
import { type HelperSnapshot } from '../core/helperRuntime.js';
import type { HelperWorldbookContext, HelperWorldbookRequest, HelperWorldbookResult, HelperWorldbookRebindRequest } from '../core/helperWorldbook.js';
import { type HelperScriptCommit, type HelperScriptContext, type HelperScriptView } from '../core/helperScripts.js';
import { type HelperMessageEditRequest, type HelperMessageEditResult } from '../core/helperChatEdits.js';
import { type HelperDisplayLease, type HelperDisplayRequest } from './helperDisplay.js';
export declare function SpeechHtmlFrame(props: {
    onFrameReady?: () => void;
    onScriptError?: (message: string) => void;
    onScriptReady?: (ready: boolean) => void;
    registerDisplayGuard?: (guard: (request: HelperDisplayRequest) => Promise<HelperDisplayLease>) => () => void;
    srcDoc: string;
    title: string;
    widget: boolean;
    compact?: boolean;
    onMessageEdit?: (request: HelperMessageEditRequest) => Promise<HelperMessageEditResult>;
    onMessageBranch?: (branch: NonNullable<HelperMessageEditResult['branch']>) => Promise<void>;
    onSwipeGreeting?: (index: number) => void;
    onHelperCommit?: (request: {
        storyId: string;
        historyRevision: string;
        changes: unknown;
    }) => Promise<HelperSnapshot>;
    onHelperRefresh?: () => Promise<HelperSnapshot>;
    onScriptCommit?: (request: HelperScriptCommit) => Promise<HelperScriptView>;
    onScriptRefresh?: () => Promise<HelperScriptContext>;
    onWorldbookRequest?: (request: HelperWorldbookRequest) => Promise<HelperWorldbookResult>;
    onWorldbookRefresh?: () => Promise<HelperWorldbookContext>;
    onWorldbookBind?: (request: HelperWorldbookRebindRequest) => Promise<HelperWorldbookContext>;
    helperBinding?: {
        sessionId: string;
        storyId: string;
    };
}): import("react").JSX.Element;
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
    onMessageBranch?: (branch: NonNullable<HelperMessageEditResult['branch']>) => Promise<void>;
    onSwipeGreeting?: (index: number) => void | Promise<void>;
}
/** 按会话和角色卸载旧气泡状态，慢请求的报错不能留到新会话。 */
export declare function SpeechBubble(props: SpeechBubbleProps): import("react").JSX.Element;
export {};
