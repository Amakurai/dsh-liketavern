let snapshot = [];
const retries = new Map();
/** 浏览器拒绝跨窗口读取时给出兼容说明；只用于展示，不改变失败状态或放行权限。 */
export function isScriptWindowAccessError(error) {
    if (!error)
        return false;
    const message = error.slice(0, 2000);
    return /Blocked a frame with origin [^\r\n]* from accessing a cross-origin frame/i.test(message)
        || /Permission denied to access property [^\r\n]* on cross-origin object/i.test(message);
}
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
