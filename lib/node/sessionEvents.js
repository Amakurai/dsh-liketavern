import { SessionPersistenceNotFoundError } from '@deepseek-ai/dsh-session-persistence';
export async function readDisplaySessionEvents(ctx, sessionId) {
    const live = ctx.sessions.get(sessionId);
    if (live)
        return live.snapshotEvents();
    const persistence = ctx.get('sessionPersistence');
    if (!persistence)
        return [];
    try {
        const inspection = await persistence.inspect(sessionId);
        if (inspection.meta.id !== sessionId)
            throw new Error('展示历史的宿主会话归属不一致');
        return ctx.sessions.get(sessionId)?.snapshotEvents() ?? inspection.events;
    }
    catch (error) {
        if (error instanceof SessionPersistenceNotFoundError)
            return [];
        throw error;
    }
}
