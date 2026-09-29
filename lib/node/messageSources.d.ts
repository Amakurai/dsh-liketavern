/** Tavern 持久消息来源：使用宿主公开的可扩展来源表，不借用已移除的通用 plugin 来源。 */
import type { ContextFormed } from '@deepseek-ai/dsh-llm';
declare module '@deepseek-ai/dsh-llm' {
    interface MessageSourceMap {
        'dsh-tavern': {
            kind: 'dsh-tavern';
        } & ContextFormed;
    }
}
export { isTavernNotice } from '../core/messageSources.js';
