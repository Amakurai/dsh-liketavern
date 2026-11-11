/**
 * 客户端共享 window 自定义事件分发器：长历史同时挂载数十个聊天气泡、操作条与头部控件时，
 * 不在 window 上重复注册成百上千个监听器。每个事件名在同一个 window 实例上只挂 1 个监听器，
 * 按路由键（sessionId 或 cardId）以及可选的无 detail 全局广播做 O(1) 分发；按 EventTarget
 * WeakMap 隔离，兼容单测替换全局 window 的场景。
 */
const windowEventChannels = new WeakMap();
export function subscribeKeyedWindowEvent(eventName, key, acceptEmptyDetail, callback) {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function')
        return () => { };
    const target = window;
    let channels = windowEventChannels.get(target);
    if (!channels) {
        channels = new Map();
        windowEventChannels.set(target, channels);
    }
    let channel = channels.get(eventName);
    if (!channel) {
        const byKey = new Map();
        const wildcard = new Set();
        const handler = (event) => {
            const detail = event.detail;
            if (!detail) {
                for (const fn of [...wildcard])
                    fn();
                return;
            }
            const listeners = byKey.get(detail);
            if (listeners)
                for (const fn of [...listeners])
                    fn();
        };
        channel = { byKey, wildcard, handler };
        channels.set(eventName, channel);
        target.addEventListener(eventName, handler);
    }
    let keySet = channel.byKey.get(key);
    if (!keySet) {
        keySet = new Set();
        channel.byKey.set(key, keySet);
    }
    keySet.add(callback);
    if (acceptEmptyDetail)
        channel.wildcard.add(callback);
    return () => {
        const activeChannel = channels?.get(eventName);
        if (!activeChannel)
            return;
        const set = activeChannel.byKey.get(key);
        if (set) {
            set.delete(callback);
            if (set.size === 0)
                activeChannel.byKey.delete(key);
        }
        if (acceptEmptyDetail)
            activeChannel.wildcard.delete(callback);
        if (activeChannel.byKey.size === 0 && activeChannel.wildcard.size === 0) {
            channels?.delete(eventName);
            target.removeEventListener(eventName, activeChannel.handler);
        }
    };
}
