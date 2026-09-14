import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
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
