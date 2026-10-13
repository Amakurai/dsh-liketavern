/** 消息变量快照契约：稳定消息身份与文本索引分离，只把当前剧情可见的快照送入隔离器。 */
import { type TemplateVariables } from './template.js';
export interface TemplateMessageIdentity {
    messageId: string;
    hostMessageId?: number;
    swipeId: 0;
}
export interface TemplateMessageVariables {
    version: 1;
    snapshots: Record<string, {
        values: TemplateVariables;
        initialized: boolean;
    }>;
}
export declare const emptyTemplateMessageVariables: () => TemplateMessageVariables;
/** 单条可写变量仍有独立预算；历史集合只受完整模板文档的资源容量约束。 */
export declare const TEMPLATE_MESSAGE_VARIABLES_LIMIT: number;
export declare const TEMPLATE_MESSAGE_VARIABLES_TOTAL_LIMIT: number;
export declare function parseTemplateMessageVariables(value: unknown, _scope?: 'visible' | 'stored'): TemplateMessageVariables;
export declare function parseTemplateMessageIdentities(value: unknown, length: number): TemplateMessageIdentity[];
export declare function visibleTemplateMessageVariables(value: TemplateMessageVariables | undefined, identities: readonly TemplateMessageIdentity[]): TemplateMessageVariables;
export declare function mergeTemplateMessageVariables(previous: TemplateMessageVariables | undefined, next: TemplateMessageVariables, identities: readonly TemplateMessageIdentity[]): TemplateMessageVariables;
