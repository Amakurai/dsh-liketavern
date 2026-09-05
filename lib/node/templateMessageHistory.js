import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface';
import { isSyntheticUserText } from '../core/dshPrompt.js';
export function buildTemplateMessageHistory(messages, pending, charName, userName, events = []) {
    const visible = new Set(messages.map(message => String(message.id)));
    const seqs = new Map();
    for (const event of events) {
        const message = deriveEventMessage(event);
        if (message && visible.has(message.id))
            seqs.set(message.id, event.seq);
    }
    const history = [], identities = [];
    const seen = new Set();
    const add = (id, role, content) => {
        if (!content.trim() || role === 'user' && isSyntheticUserText(content) || seen.has(id))
            return;
        seen.add(id);
        const name = role === 'assistant' ? charName : role === 'user' ? userName : undefined;
        history.push({ role, content, ...(name ? { name } : {}) });
        const seq = seqs.get(id);
        identities.push({ messageId: id, swipeId: 0, ...(seq !== undefined ? { hostMessageId: seq } : {}) });
    };
    for (const message of messages)
        add(message.id, message.role, message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
    for (const message of pending)
        add(message.id, 'user', message.text);
    return { history, identities };
}
