let snapshot = [];
const retries = new Map(), enables = new Map();
const cancels = new Map(), branchOpeners = new Map();
/** 浏览器拒绝跨窗口读取时给出兼容说明；只用于展示，不改变失败状态或放行权限。 */
export function isScriptWindowAccessError(error) {
    if (!error)
        return false;
    const message = error.slice(0, 2000);
    return /Blocked a frame with origin [^\r\n]* from accessing a cross-origin frame/i.test(message)
        || /Permission denied to access property [^\r\n]* on cross-origin object/i.test(message);
}
export function retryScriptMvu(sessionId) { retries.get(sessionId)?.(); }
/** 设置页的取消等待入口；运行时已卸载时返回 false，不假装已取消。 */
export async function cancelScriptMvu(sessionId) {
    const cancel = cancels.get(sessionId);
    if (!cancel)
        return false;
    await cancel();
    return true;
}
/** 后台脚本编辑分支导航失败后的手动打开入口。 */
export async function openScriptEditedBranch(sessionId) {
    const open = branchOpeners.get(sessionId);
    if (!open)
        return false;
    await open();
    return true;
}
/** 设置页的一键开启；运行时已卸载时返回 false 由调用方提示，不假装已开启。 */
export async function enableScriptMvu(sessionId) {
    const enable = enables.get(sessionId);
    if (!enable)
        return false;
    await enable();
    return true;
}
const owners = new Map(), listeners = new Set();
const notify = () => { for (const listener of [...listeners])
    listener(); };
export const scriptStatusStore = { getSnapshot: () => snapshot, subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
export function publishScriptStatus(owner, status, retry, enable, actions) {
    if (retry)
        retries.set(status.sessionId, retry);
    else
        retries.delete(status.sessionId);
    if (enable)
        enables.set(status.sessionId, enable);
    else
        enables.delete(status.sessionId);
    if (actions?.cancel)
        cancels.set(status.sessionId, actions.cancel);
    else
        cancels.delete(status.sessionId);
    if (actions?.openBranch)
        branchOpeners.set(status.sessionId, actions.openBranch);
    else
        branchOpeners.delete(status.sessionId);
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
    enables.delete(sessionId);
    cancels.delete(sessionId);
    branchOpeners.delete(sessionId);
    owners.delete(sessionId);
    snapshot = snapshot.filter(item => item.sessionId !== sessionId);
    notify();
}
