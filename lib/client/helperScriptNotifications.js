/** 脚本库保存已由沙箱确认后的运行器通知；只按固定会话和剧情分发，不接受第三方目标。 */
const listeners = new Map();
export function watchHelperScripts(sessionId, storyId, listener) {
    const key = JSON.stringify([sessionId, storyId]), group = listeners.get(key) ?? new Set();
    listeners.set(key, group);
    group.add(listener);
    return () => { group.delete(listener); if (!group.size)
        listeners.delete(key); };
}
export function notifyHelperScripts(sessionId, storyId) {
    for (const listener of listeners.get(JSON.stringify([sessionId, storyId])) ?? [])
        listener();
}
/** 设置页资产保存完成后通知页面内运行器重新读取绑定库；无需暴露剧情数据。 */
const assetListeners = new Set();
export function watchHelperScriptAssets(listener) {
    assetListeners.add(listener);
    return () => { assetListeners.delete(listener); };
}
export function notifyHelperScriptAssets(target) { for (const listener of assetListeners)
    listener(target); }
