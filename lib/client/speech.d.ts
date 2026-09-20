import type { ComponentProps, ReactNode } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
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
    /** 重绘候选已真实挂载但尚未发布；允许只读查询和事件订阅，禁止产生剧情副作用。 */
    readOnly?: boolean;
    /** 候选发布前尝试剧情写入时，立即废弃候选并保留旧卡。 */
    onReadOnlyViolation?: () => void;
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
    /** 角色资产保存后的修订信号；变更时重取头像与卡面宏/开场白，不作为沙箱身份。 */
    characterRevision?: string;
    /** 同一卡片的剧情、人设、预设或世界书绑定变化；需重新执行 output/render。 */
    bindingRevision?: string;
    name: string;
    rawText: string;
    /** 宿主按当前 turn-tail 核验出的文件链接解析器；不可由卡面或文本自行构造。 */
    fileMentions?: ComponentProps<typeof MarkdownText>['fileMentions'];
    /** 必须由宿主 owner 渲染的消息图片，放在正文列内以与卡片内容对齐。 */
    media?: ReactNode;
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
