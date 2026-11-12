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
const windowMessageChannels = new WeakMap();
/**
 * 共享 window message 分发器：同一会话挂载数十张交互卡 iframe 时，不在 window 上重复挂 N 个监听器。
 * 已知 contentWindow 按 event.source 做 O(1) 路由；调用方内部仍保留自身的 contentWindow 与运行时令牌复核。
 */
export function subscribeWindowMessage(source, callback) {
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function')
        return () => { };
    const target = window;
    let channel = windowMessageChannels.get(target);
    if (!channel) {
        const bySource = new Map();
        const dynamic = new Set();
        const handler = (rawEvent) => {
            const event = rawEvent;
            if (event.source != null) {
                const scoped = bySource.get(event.source);
                if (scoped)
                    for (const fn of [...scoped])
                        fn(event);
            }
            if (dynamic.size > 0) {
                for (const fn of [...dynamic])
                    fn(event);
            }
        };
        channel = { bySource, dynamic, handler };
        windowMessageChannels.set(target, channel);
        target.addEventListener('message', handler);
    }
    if (source != null) {
        let set = channel.bySource.get(source);
        if (!set) {
            set = new Set();
            channel.bySource.set(source, set);
        }
        set.add(callback);
    }
    else {
        channel.dynamic.add(callback);
    }
    return () => {
        const active = windowMessageChannels.get(target);
        if (!active)
            return;
        if (source != null) {
            const set = active.bySource.get(source);
            if (set) {
                set.delete(callback);
                if (set.size === 0)
                    active.bySource.delete(source);
            }
        }
        else {
            active.dynamic.delete(callback);
        }
        if (active.bySource.size === 0 && active.dynamic.size === 0) {
            windowMessageChannels.delete(target);
            target.removeEventListener('message', active.handler);
        }
    };
}
