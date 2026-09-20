import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
const userMessagePresence = new WeakMap();
const eventIndexes = new WeakMap();
function currentSnapshot(events, cached) {
    const last = events.at(-1);
    return cached?.length === events.length && cached.last === last && cached.lastSeq === last?.seq;
}
export function displaySessionHasUserMessage(events) {
    const cached = userMessagePresence.get(events);
    if (currentSnapshot(events, cached))
        return cached.value;
    const value = events.some(event => event.type === 'user/message');
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
