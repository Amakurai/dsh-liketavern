import type { ReactNode, ComponentProps } from 'react';
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { type UseSessions } from './mode.js';
import type { TavernSessions } from './navigation.js';
import type { TavernRemote } from './types.js';
interface AssistantBlock {
    kind: string;
    text?: string;
    attachment?: unknown;
    block?: unknown;
}
interface AssistantNode {
    location?: {
        kind?: string;
        turn?: {
            status?: string;
            turn?: number;
        };
    };
    data: {
        status: string;
        blocks: AssistantBlock[];
        finalNode?: {
            seq?: number;
        };
    };
}
/** 宿主 owner props 里的会话图片加载器（0.2.1-rc.1 起配合 conversation.images.content factory 渲染消息图片）。 */
type MessageImageLoader = (attachmentId: string, signal?: AbortSignal) => Promise<unknown>;
/** 宿主 Slot 注入的 Factory 渲染器（调用 conversation.images.content）。 */
type RenderImagesFactorySlot = (name: 'conversation.images.content', props: {
    images: readonly {
        attachment: unknown;
    }[];
    loadImage?: MessageImageLoader;
    align: 'start' | 'end';
}) => ReactNode;
/** 兼容直接传入图片渲染回调的测试与辅助调用。 */
type RenderMessageImages = (owner: {
    images: readonly {
        attachment: unknown;
    }[];
    loadImage?: MessageImageLoader;
    align: 'start' | 'end';
}) => ReactNode;
/** fileMentions 的入参（宿主 AssistantNodeView 同款：turn-tail owner）。 */
interface TurnTailOwner {
    turn: {
        status?: string;
    };
    seq: number;
    openFile?: (path: string) => void;
}
export declare function TavernAssistantNode(props: {
    remote: TavernRemote;
    sessionId: string;
    sessions?: Pick<TavernSessions, 'open' | 'refresh' | 'binding'>;
    useSessions?: UseSessions;
    node: AssistantNode;
    /**
     * 0.1.7 起宿主把同时含思考与正文的步骤拆成两次渲染：reasoning 段放进「用时」折叠区
     * （折叠时隐藏但仍挂载），response 段是正文。忽略它会在折叠区里再挂一整份卡面与脚本。
     */
    groupPart?: string;
    loadImage?: MessageImageLoader;
    renderFactorySlot?: RenderImagesFactorySlot;
    renderMessageImages?: RenderMessageImages;
    useTurnData?: (key: string) => unknown;
    openFile?: (path: string) => void;
    fileMentions?: (owner: TurnTailOwner) => ComponentProps<typeof MarkdownText>['fileMentions'];
}): import("react").JSX.Element | null;
export {};
