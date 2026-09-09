let snapshot = [];
const retries = new Map();
export function retryScriptMvu(sessionId) { retries.get(sessionId)?.(); }
const owners = new Map(), listeners = new Set();
const notify = () => { for (const listener of listeners)
    listener(); };
export const scriptStatusStore = { getSnapshot: () => snapshot, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
export function publishScriptStatus(owner, status, retry) {
    if (retry)
        retries.set(status.sessionId, retry);
    owners.set(status.sessionId, owner);
    const previous = snapshot.find(item => item.sessionId === status.sessionId);
    if (JSON.stringify(previous) === JSON.stringify(status))
        return;
    snapshot = [...snapshot.filter(item => item.sessionId !== status.sessionId), status];
    notify();
}
export function clearScriptStatus(owner, sessionId) {
    if (owners.get(sessionId) !== owner)
        return;
    retries.delete(sessionId);
    owners.delete(sessionId);
    snapshot = snapshot.filter(item => item.sessionId !== sessionId);
    notify();
}
