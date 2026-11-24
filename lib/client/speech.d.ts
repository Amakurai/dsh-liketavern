import type { ComponentProps, ReactNode } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import type { SessionEventSource } from '@deepseek-ai/dsh-api-session-controller/client';
import { readHostColorScheme } from './displayPrefs.js';
import type { TavernRemote } from './types.js';
import { type HelperSnapshot } from '../core/helperRuntime.js';
import type { HelperWorldbookContext, HelperWorldbookRequest, HelperWorldbookResult, HelperWorldbookRebindRequest } from '../core/helperWorldbook.js';
import { type HelperScriptCommit, type HelperScriptContext, type HelperScriptView } from '../core/helperScripts.js';
import { type HelperMessageEditRequest, type HelperMessageEditResult } from '../core/helperChatEdits.js';
import { type HelperDisplayLease, type HelperDisplayRequest } from './helperDisplay.js';
import type { HelperFrameLease } from '../core/helperFrame.js';
type FrameWrite<T> = T & {
    frameLease?: HelperFrameLease;
};
export { readHostColorScheme };
export declare function SpeechHtmlFrame(props: {
    onFrameReady?: () => void;
    onScriptError?: (message: string) => void;
    /** 仅在 iframe 文档重建或新 runtimeId 重连时触发，供宿主清除上一运行时的故障记录；同运行时故障不可由 onScriptReady(true) 绕过。 */
    onScriptReset?: () => void;
    onScriptReady?: (ready: boolean) => void;
    registerDisplayGuard?: (guard: (request: HelperDisplayRequest) => Promise<HelperDisplayLease>) => () => void;
    srcDoc: string;
    title: string;
    widget: boolean;
    compact?: boolean;
    /** 重绘候选已真实挂载但尚未发布；允许只读查询和事件订阅，禁止产生剧情副作用。 */
    readOnly?: boolean;
    /** 活跃可见卡面正处于重载或重载失败态；禁止新剧情写入，但不得冒充 helperEventEmit 成功或吞掉在途 *Applied 回执。 */
    refreshing?: boolean;
    /** 候选发布前尝试剧情写入时，立即废弃候选并保留旧卡。 */
    onReadOnlyViolation?: () => void;
    /** 分支导航失败或重试成功时同步通知宿主容器（后台隐藏脚本借此在可见 UI 展示错误与手动打开入口）。 */
    onBranchError?: (branch: NonNullable<HelperMessageEditResult['branch']> | null, error: string | null) => void;
    remote?: TavernRemote;
    helperMessageId?: number;
    onMessageEdit?: (request: FrameWrite<HelperMessageEditRequest>) => Promise<HelperMessageEditResult>;
    onMessageBranch?: (branch: NonNullable<HelperMessageEditResult['branch']>) => Promise<void>;
    onSwipeGreeting?: (index: number, frameLease?: HelperFrameLease) => void | Promise<void>;
    onHelperCommit?: (request: FrameWrite<{
        storyId: string;
        historyRevision: string;
        changes: unknown;
    }>) => Promise<HelperSnapshot>;
    onHelperRefresh?: () => Promise<HelperSnapshot>;
    onScriptCommit?: (request: FrameWrite<HelperScriptCommit>) => Promise<HelperScriptView>;
    onScriptRefresh?: () => Promise<HelperScriptContext>;
    onWorldbookRequest?: (request: FrameWrite<HelperWorldbookRequest>) => Promise<HelperWorldbookResult>;
    onWorldbookRefresh?: () => Promise<HelperWorldbookContext>;
    onWorldbookBind?: (request: FrameWrite<HelperWorldbookRebindRequest>) => Promise<HelperWorldbookContext>;
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
    /** 当前会话的公开只读事件源；用于尚未持久化的续写消息展示。 */
    streamSource?: SessionEventSource;
    turn?: number;
    /** 会话级交互卡开关（binding.interactiveCards）；null/缺省回落全局设置。 */
    interactiveCards?: boolean | null;
    onMessageBranch?: (branch: NonNullable<HelperMessageEditResult['branch']>) => Promise<void>;
    onSwipeGreeting?: (index: number, frameLease?: HelperFrameLease) => void | Promise<void>;
}
/** 按会话和角色卸载旧气泡状态，慢请求的报错不能留到新会话。 */
export declare function SpeechBubble(props: SpeechBubbleProps): import("react").JSX.Element;
