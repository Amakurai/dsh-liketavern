import type { ChatMessage, ChatRole } from './types.js';
import { z } from 'zod';
export interface PromptHistoryAnchor {
    inputIndex: number;
    /** 缺失时只可用于模拟；真实请求投影不得凭正文或数组位置猜测宿主消息。 */
    messageId?: string;
    role: ChatRole;
    /** system 与宿主合成输入不计入聊天深度。 */
    chat: boolean;
}
export type PromptLayoutPlacement = {
    kind: 'before-history' | 'after-history';
    anchor?: PromptHistoryAnchor;
    order?: number;
} | {
    kind: 'depth';
    depth: number;
    order: number;
    previous?: PromptHistoryAnchor;
    next?: PromptHistoryAnchor;
} | {
    kind: 'history-relative';
    anchor: PromptHistoryAnchor;
    side: 'before' | 'after';
} | {
    kind: 'entry-relative';
    entryKey: string;
    side: 'before' | 'after';
};
/** 与模拟消息逐项对应的身份；后置 INSERT 使用它找布局边界，不按正文反推。 */
export type PromptMessageProvenance = {
    kind: 'history';
    anchor: PromptHistoryAnchor;
} | {
    kind: 'layout';
    entryKey: string;
};
export interface PromptLayoutEntry {
    /** 轮内唯一、JSON 重放稳定；宿主消息 ID 必须另外按当前轮与此 key 派生。 */
    key: string;
    role: ChatRole;
    content: string;
    sourceKeys: string[];
    turnLocal: boolean;
    placement: PromptLayoutPlacement;
    /** 旧模板回调只提供扁平通道，无法恢复精确位置；投影器必须显式处理此限制。 */
    compatibilityFallback?: true;
}
export interface PromptLayout {
    version: 1;
    history: PromptHistoryAnchor[];
    /** 最终 ST 顺序；只有插件内容，没有历史正文副本，assistant 仍是普通消息角色。 */
    entries: PromptLayoutEntry[];
}
export type PromptLayoutFragment = Omit<PromptLayoutEntry, 'key'>;
/** 持久化边界共用同一结构校验；旧记录应由调用方将整个 layout 字段设为可选。 */
export declare const PromptLayoutSchema: z.ZodType<PromptLayout>;
export declare function parsePromptLayout(value: unknown): PromptLayout;
/** 正则与模板可改模拟正文，但锚点身份始终取原始输入的对应项。 */
export declare function promptHistoryAnchors(history: readonly ChatMessage[], messageIds?: readonly (string | undefined)[], chatFlags?: readonly boolean[]): PromptHistoryAnchor[];
/** depth 只数本轮首次组装时的真实聊天；后续工具步骤不移动已冻结的边界。 */
export declare function promptDepthPlacement(history: readonly PromptHistoryAnchor[], depth: number, order: number): PromptLayoutPlacement;
/** 拷贝所有可变元数据，防止后面的模拟预算裁剪或调用方改写污染可持久化快照。 */
export declare function createPromptLayout(history: readonly PromptHistoryAnchor[], fragments: readonly PromptLayoutFragment[]): PromptLayout;
