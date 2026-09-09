/** 酒馆助手卡面兼容：同步消息快照、窄开场白操作、宏与错误提示；不提供宿主通用 RPC。 */
import type { HelperSnapshot } from './helperRuntime.js';
export interface CardHelperContext {
    snapshot?: HelperSnapshot;
    message?: string;
    /** 当前卡面的宿主消息 seq；独立开场白/预览为 0，不冒充完整 ST 聊天序号。 */
    messageId?: number;
    name?: string;
    userName?: string;
    frameIndex?: number;
    canSwipe?: boolean;
    scriptFrame?: boolean;
}
export interface CardHelperLabels {
    diagnostics: string;
    unsupported: string;
}
/** 自包含函数注入 opaque-origin iframe；返回清理器供 document.write 重装使用。 */
export declare function installCardHelper(context: CardHelperContext, greetings: string[], greetingIndex: number, source: string, labels: CardHelperLabels): () => void;
