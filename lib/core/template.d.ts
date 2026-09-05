/** 模板跨隔离边界的数据契约；只接受有界 JSON，禁止原型路径与不可序列化状态。 */
import type { ChatMessage, ChatRole, WorldInfoEntry } from './types.js';
import type { TemplateMessageIdentity, TemplateMessageVariables } from './templateMessageVariables.js';
export type TemplateValue = null | boolean | number | string | TemplateValue[] | {
    [key: string]: TemplateValue;
};
export type TemplateVariables = Record<string, TemplateValue>;
export interface TemplateScopes {
    global: TemplateVariables;
    local: TemplateVariables;
    message: TemplateVariables;
}
/** ST 文本索引与宿主事件序号分开传递；swipe 只表示当前剧情内的版本，不跨兄弟剧情读取。 */
export interface TemplateMessageMetadata {
    index: number;
    role: ChatRole;
    name?: string;
    swipeId: number;
    hostMessageId?: number;
}
export interface TemplateContext {
    variables: TemplateScopes;
    char: string;
    user: string;
    card: Record<string, unknown>;
    entries: WorldInfoEntry[];
    presets: Array<{
        identifier: string;
        name: string;
        content: string;
    }>;
    history: ChatMessage[];
    historyIdentities?: TemplateMessageIdentity[];
    messageVariables?: TemplateMessageVariables;
    now: number;
    seed: number;
    phase: 'generate' | 'render';
    sessionId?: string;
    cardId?: string;
    generationType?: string;
    /** 当前宿主实际选择的模型标识，与本轮计划一起冻结；独立预览没有模型时为空。 */
    model?: string;
    charAvatar?: string;
    userAvatar?: string;
    /** 正常回复逐条处理的文本消息元数据，顺序与 template 任务的 texts 对应。 */
    renderMessages?: TemplateMessageMetadata[];
    /** 生成阶段注册、供本轮正常回复使用的字符串替换规则；不提升为跨剧情全局规则。 */
    regexRules?: TemplateRegexDescriptor[];
    hasMessageRegex?: boolean;
}
export interface TemplateRegexDescriptor {
    source: string;
    flags: string;
    replacement: string;
    options: Record<string, string | number | boolean | null>;
}
export declare const emptyTemplateScopes: () => TemplateScopes;
export declare const hasEjs: (text: string) => boolean;
export declare function validateTemplateJson(value: unknown, depth?: number): asserts value is TemplateValue;
export declare function parseTemplateScopes(value: unknown): TemplateScopes;
