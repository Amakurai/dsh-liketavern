/** 酒馆助手运行层的数据契约和有界 JSON 校验；浏览器与持久层共享，不执行第三方函数。 */
import type { HelperSwipeSet } from './helperSwipes.js';
export type HelperTable = Record<string, unknown>;
export type HelperScopes = Record<string, HelperTable>;
export interface HelperMessage {
    message_id: number;
    name: string;
    role: 'user' | 'assistant' | 'system';
    is_hidden: boolean;
    message: string;
    data: HelperTable;
    extra: HelperTable;
    swipe?: HelperSwipeSet;
}
export interface HelperSnapshot {
    storyId: string;
    historyRevision: string;
    currentMessageId: number;
    messages: HelperMessage[];
    scopes: HelperScopes;
    writable: boolean;
}
export interface HelperVariableChange {
    key: string;
    before: HelperTable;
    value: HelperTable;
}
export declare const HELPER_MAX_BYTES: number;
export declare function helperRecord(value: unknown): value is HelperTable;
/** 不求值 getter/toJSON；拒绝污染键、循环、非有限数和超深数据，再复制普通 JSON。 */
export declare function helperJson(value: unknown, maxBytes?: number): unknown;
export declare function helperTable(value: unknown): HelperTable;
export declare function helperScopeKey(key: string): [string, string | number];
export declare function helperChanges(value: unknown): HelperVariableChange[];
