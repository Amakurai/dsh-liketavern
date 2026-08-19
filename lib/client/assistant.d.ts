import { type UseSessions } from './mode.js';
import type { TavernRemote } from './types.js';
interface AssistantBlock {
    kind: string;
    text?: string;
    attachment?: unknown;
    block?: unknown;
}
interface AssistantNode {
    data: {
        status: string;
        blocks: AssistantBlock[];
        finalNode?: unknown;
    };
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
    loadImage?: (attachment: unknown) => Promise<string>;
    fileMentions?: unknown;
    t?: (key: string, vars?: Record<string, unknown>) => string;
}): any;
export {};
