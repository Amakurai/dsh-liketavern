/** 宿主文本历史的稳定身份投影：只遍历 deriveMessages 的可见消息，pending 按原始 Message.id 抵消。 */
import type { Message } from '@deepseek-ai/dsh-llm';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { ChatMessage } from '../core/types.js';
import type { TemplateMessageIdentity } from '../core/templateMessageVariables.js';
export declare function buildTemplateMessageHistory(messages: readonly Message[], pending: readonly {
    id: string;
    text: string;
}[], charName: string, userName: string, events?: readonly SessionEvent[]): {
    history: ChatMessage[];
    identities: TemplateMessageIdentity[];
};
