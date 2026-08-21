import type { ReactNode } from 'react';
import { type UseSessions } from './mode.js';
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
/** 宿主 owner props 里的图片渲染器（rc.2 起替代 loadImage，见 conversation.chat.node 契约）。 */
type RenderMessageImages = (owner: {
    images: readonly {
        attachment: unknown;
    }[];
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
    sessions?: {
        open(id: string): void;
        refresh?: () => Promise<void>;
    };
    useSessions?: UseSessions;
    node: AssistantNode;
    renderMessageImages?: RenderMessageImages;
    useTurnData?: (key: string) => unknown;
    openFile?: (path: string) => void;
    fileMentions?: (owner: TurnTailOwner) => unknown;
    t?: (key: string, vars?: Record<string, unknown>) => string;
}): any;
export {};
