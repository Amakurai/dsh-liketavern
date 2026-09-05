import type { TavernRemote } from '../types.js';
interface MemorySectionProps {
    remote: TavernRemote;
    initialContext?: {
        cardId: string;
        storyId: string;
    };
}
/** 聊天入口独立使用剧情草稿范围；设置面板已有范围时复用父级存储与恢复提示。 */
export declare function MemorySection(props: MemorySectionProps): import("react").JSX.Element;
export {};
