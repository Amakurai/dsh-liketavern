import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
import { isHostInjectedUserMessage, isSyntheticUserText } from '../core/dshPrompt.js';
import { sessionHasUserMessage } from '../core/greetingLog.js';
const userMessagePresence = new WeakMap();
const eventIndexes = new WeakMap();
const assistantDepthIndexes = new WeakMap();
function currentSnapshot(events, cached) {
    const last = events.at(-1);
    return cached?.length === events.length && cached.last === last && cached.lastSeq === last?.seq;
}
export function findLastEvent(events, predicate) {
    for (let i = events.length - 1; i >= 0; i--) {
        const event = events[i];
        if (predicate(event))
            return event;
    }
    return undefined;
}
export function displaySessionHasUserMessage(events) {
    const cached = userMessagePresence.get(events);
    if (currentSnapshot(events, cached))
        return cached.value;
    const value = sessionHasUserMessage(events);
    const last = events.at(-1);
    userMessagePresence.set(events, { length: events.length, last, lastSeq: last?.seq, value });
    return value;
}
/** 按不可变快照建立一次 seq 索引；兼容测试桩及未来可能返回的非零起点只读切片。 */
export function displaySessionEventAt(events, seq) {
    if (!Number.isSafeInteger(seq) || seq < 0)
        return undefined;
    let cached = eventIndexes.get(events);
    if (!currentSnapshot(events, cached)) {
        const last = events.at(-1), value = new Map(events.map(event => [event.seq, event]));
        cached = { length: events.length, last, lastSeq: last?.seq, value };
        eventIndexes.set(events, cached);
    }
    return cached.value.get(seq);
}
/**
 * 按不可变快照计算每条真实 assistant 消息的展示深度（0 = 最新真实消息，跳过宿主合成 user 消息），
 * 与 `applyRegexToMessages` 和 SillyTavern `getRegexedString` 深度口径完全一致。
 */
export function displayAssistantDepthAt(events, seq) {
    if (!Number.isSafeInteger(seq) || seq < 0)
        return undefined;
    let cached = assistantDepthIndexes.get(events);
    if (!currentSnapshot(events, cached)) {
        const depths = new Map();
        let depthFromEnd = 0;
        for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i];
            if (event.type !== 'user/message' && event.type !== 'assistant/message')
                continue;
            if ('surfaceOp' in event && event.surfaceOp !== undefined && event.surfaceOp !== 'append')
                continue;
            if (event.type === 'user/message' && isHostInjectedUserMessage(event.data))
                continue;
            const message = event.type === 'user/message' ? event.data : event.data.message;
            const text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
            if (!text.trim() || (event.type === 'user/message' && isSyntheticUserText(text)))
                continue;
            if (event.type === 'assistant/message')
                depths.set(event.seq, depthFromEnd);
            depthFromEnd++;
        }
        const last = events.at(-1);
        cached = { length: events.length, last, lastSeq: last?.seq, value: depths };
        assistantDepthIndexes.set(events, cached);
    }
    return cached.value.get(seq);
}
export async function readDisplaySessionEvents(ctx, sessionId) {
    const live = ctx.sessions.get(sessionId);
    if (live)
        return live.snapshotEvents();
    const persistence = ctx.get('sessionPersistence');
    if (!persistence)
        return [];
    try {
        const handle = await persistence.open(sessionId, 'read');
        try {
            if (handle.id !== sessionId || handle.header.id !== sessionId)
                throw new Error('展示历史的宿主会话归属不一致');
            const { events } = await handle.read();
            return ctx.sessions.get(sessionId)?.snapshotEvents() ?? events;
        }
        finally {
            await handle.close();
        }
    }
    catch (error) {
        if (error instanceof SessionPersistenceNotFoundError)
            return [];
        throw error;
    }
}
