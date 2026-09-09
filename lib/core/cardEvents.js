/** 酒馆助手事件：预览本地分发，真实剧情经窄桥按监听顺序串行跨 iframe 调用，关闭/重写时撤销。 */
export function installCardEvents(shared = false) {
    const root = window;
    const listeners = new Map();
    let active = true;
    const runtimeId = shared ? crypto.randomUUID() : '';
    root.__dshTavernEventRuntimeId = runtimeId;
    let serial = 0;
    const outgoing = new Map();
    const incoming = new Map();
    const post = (action, value = {}) => parent.postMessage({ source: 'dsh-tavern-card', runtimeId, action, ...value }, '*');
    const report = (error) => { const handler = root.__dshTavernReportError; if (typeof handler === 'function')
        handler(error); };
    function json(value) {
        const text = JSON.stringify(value, (key, item) => {
            if (['__proto__', 'prototype', 'constructor'].includes(key) || typeof item === 'function' || typeof item === 'symbol' || typeof item === 'undefined' || typeof item === 'bigint' || typeof item === 'number' && !Number.isFinite(item))
                throw new Error('跨卡面事件只接受普通 JSON 数据');
            return item;
        });
        if (new TextEncoder().encode(text).length > 256 * 1024)
            throw new Error('跨卡面事件参数超过 256 KiB');
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed) || parsed.length > 64)
            throw new Error('事件参数无效');
        return parsed;
    }
    // 在每个监听回执后更新发送方原对象，使变量对象的逐监听修改可以继续传递。
    function reconcile(target, source) {
        if (!target || !source || typeof target !== 'object' || typeof source !== 'object' || Array.isArray(target) !== Array.isArray(source))
            return source;
        const left = target, right = source;
        for (const key of Object.keys(left))
            if (!Object.hasOwn(right, key))
                delete left[key];
        for (const key of Object.keys(right))
            left[key] = reconcile(left[key], right[key]);
        if (Array.isArray(target) && Array.isArray(source))
            target.length = source.length;
        return target;
    }
    function emitShared(event, data, excludeSelf = false) {
        if (!active)
            return Promise.reject(new Error('Card event runtime has been disposed'));
        if (outgoing.size >= 16)
            return Promise.reject(new Error('事件发送超过并发预算'));
        const requestId = `${runtimeId}:${++serial}`;
        return new Promise((resolve, reject) => {
            const args = json(data);
            const timer = setTimeout(() => { outgoing.delete(requestId); reject(new Error('跨卡面事件等待超时')); }, 60000);
            outgoing.set(requestId, { data, resolve, reject, timer });
            post('helperEventEmit', { requestId, event, args, excludeSelf });
        });
    }
    const receive = (event) => {
        if (!active || event.source !== parent)
            return;
        const value = event.data;
        if (!value || value.source !== 'dsh-tavern-card' || value.runtimeId !== runtimeId)
            return;
        if (value.action === 'helperEventResult') {
            const pending = outgoing.get(value.requestId);
            if (!pending) {
                if (value.ok === false)
                    report(value.error);
                return;
            }
            outgoing.delete(value.requestId);
            clearTimeout(pending.timer);
            try {
                if (Array.isArray(value.args) && value.args.length === pending.data.length)
                    reconcile(pending.data, json(value.args));
                if (value.ok !== true)
                    throw new Error(String(value.error ?? '跨卡面事件失败'));
                pending.resolve();
            }
            catch (error) {
                pending.reject(error instanceof Error ? error : new Error(String(error)));
            }
            return;
        }
        if (value.action === 'helperEventCancel' || value.action === 'helperEventExecute') {
            const delivery = incoming.get(value.deliveryId);
            if (!delivery)
                return;
            if (value.action === 'helperEventCancel') {
                clearTimeout(delivery.timer);
                incoming.delete(value.deliveryId);
            }
            else
                delivery.execute?.();
            return;
        }
        if (value.action !== 'helperEventDeliver')
            return;
        const match = [...listeners.entries()].flatMap(([event, entries]) => entries.map(entry => ({ event, entry }))).find(item => item.entry.id === value.listenerId);
        if (!match) {
            post('helperEventReply', { deliveryId: value.deliveryId, ok: true, args: value.args, ...(value.host === true ? { invoked: false, canceled: true } : {}) });
            return;
        }
        const data = json(value.args), original = json(data), own = outgoing.get(value.emissionId);
        const args = own ? reconcile(own.data, data) : data;
        if (match.entry.once && value.host !== true)
            eventRemoveListener(match.event, match.entry.listener);
        const invoke = async () => {
            let invoked = false;
            try {
                if (value.host === true && !listeners.get(match.event)?.includes(match.entry)) {
                    post('helperEventReply', { deliveryId: value.deliveryId, ok: true, args: json(args), invoked: false, canceled: true });
                    return;
                }
                if (value.host === true && match.entry.once)
                    eventRemoveListener(match.event, match.entry.listener);
                invoked = true;
                await match.entry.listener(...args);
                if (active)
                    post('helperEventReply', { deliveryId: value.deliveryId, ok: true, args: json(args) });
            }
            catch (error) {
                let safe = original;
                try {
                    safe = json(args);
                }
                catch { }
                if (active)
                    post('helperEventReply', { deliveryId: value.deliveryId, ok: false, invoked, ...(value.host === true && !invoked ? { canceled: !listeners.get(match.event)?.includes(match.entry) } : {}), error: String(error instanceof Error ? error.message : error).slice(0, 2000), args: safe });
            }
        };
        if (value.host !== true) {
            void invoke().catch(report);
            return;
        }
        if (typeof value.deliveryId !== 'string' || incoming.has(value.deliveryId) || incoming.size >= 64 || !Number.isSafeInteger(value.timeoutMs) || value.timeoutMs <= 0 || value.timeoutMs > 15000) {
            post('helperEventReply', { deliveryId: value.deliveryId, ok: false, invoked: false, args: original, error: '宿主事件准备超过预算或身份无效' });
            return;
        }
        const deliveryId = value.deliveryId;
        const delivery = { timer: setTimeout(() => {
                if (incoming.get(deliveryId) !== delivery)
                    return;
                incoming.delete(deliveryId);
                if (active)
                    post('helperEventReply', { deliveryId, ok: false, invoked: false, args: original, error: '宿主事件准备等待超时' });
            }, value.timeoutMs) };
        const release = () => { clearTimeout(delivery.timer); incoming.delete(deliveryId); };
        incoming.set(deliveryId, delivery);
        // 只准备快照，不在异步读取结束后自行运行监听；宿主必须重新核验来源并授权本次执行。
        void (async () => {
            try {
                const prepare = value.mvuSnapshot ? root.__dshTavernPrepareMvuEvent : root.__dshTavernPrepareHostEvent;
                if (typeof prepare === 'function')
                    await prepare(value.mvuSnapshot);
                if (!active || incoming.get(deliveryId) !== delivery)
                    return;
                if (!listeners.get(match.event)?.includes(match.entry)) {
                    release();
                    post('helperEventReply', { deliveryId, ok: true, args: json(args), invoked: false, canceled: true });
                    return;
                }
                delivery.execute = () => { if (!active || incoming.get(deliveryId) !== delivery)
                    return; release(); void invoke().catch(report); };
                post('helperEventPrepared', { deliveryId, args: json(args) });
            }
            catch (error) {
                if (!active || incoming.get(deliveryId) !== delivery)
                    return;
                release();
                post('helperEventReply', { deliveryId, ok: false, invoked: false, canceled: !listeners.get(match.event)?.includes(match.entry), args: original, error: String(error instanceof Error ? error.message : error).slice(0, 2000) });
            }
        })().catch(report);
    };
    if (shared) {
        window.addEventListener('message', receive);
        post('helperEventConnect');
    }
    function eventRemoveListener(event, listener) {
        if (shared)
            for (const entry of listeners.get(event) ?? [])
                if (entry.listener === listener)
                    post('helperEventUnsubscribe', { listenerId: entry.id });
        const next = (listeners.get(event) ?? []).filter(entry => entry.listener !== listener);
        if (next.length)
            listeners.set(event, next);
        else
            listeners.delete(event);
    }
    function subscribe(event, listener, once = false, position) {
        if (!active)
            throw new Error('Card event runtime has been disposed');
        if (typeof event !== 'string' || !event || event.length > 256 || typeof listener !== 'function')
            throw new Error('Invalid card event listener');
        const entries = listeners.get(event) ?? [];
        const existing = entries.find(entry => entry.listener === listener);
        if (!existing && [...listeners.values()].reduce((sum, list) => sum + list.length, 0) >= 1024)
            throw new Error('Card event listener limit exceeded');
        if (!existing || position) {
            const next = entries.filter(entry => entry !== existing);
            const entry = existing ?? { listener, once, id: `listener-${++serial}` };
            if (position === 'first')
                next.unshift(entry);
            else
                next.push(entry);
            listeners.set(event, next);
            if (shared)
                post('helperEventSubscribe', { listenerId: entry.id, event, once: entry.once, position: position ?? 'normal' });
        }
        return { stop: () => eventRemoveListener(event, listener) };
    }
    function eventOn(event, listener) { return subscribe(event, listener); }
    function eventOnce(event, listener) { return subscribe(event, listener, true); }
    function eventMakeFirst(event, listener) { return subscribe(event, listener, false, 'first'); }
    function eventMakeLast(event, listener) { return subscribe(event, listener, false, 'last'); }
    async function eventEmit(event, ...data) {
        if (shared)
            return emitShared(event, data);
        return emitLocal(event, ...data);
    }
    async function emitLocal(event, ...data) {
        for (const entry of [...(listeners.get(event) ?? [])]) {
            if (!active || !listeners.get(event)?.includes(entry))
                continue;
            if (entry.once)
                eventRemoveListener(event, entry.listener);
            await entry.listener(...data);
        }
    }
    function eventEmitAndWait(event, ...data) {
        for (const entry of [...(listeners.get(event) ?? [])]) {
            if (!active || !listeners.get(event)?.includes(entry))
                continue;
            if (entry.once)
                eventRemoveListener(event, entry.listener);
            const result = entry.listener(...data);
            // 同步接口不吞掉异步监听失败，交给 iframe 的 unhandledrejection 提示。
            if (result instanceof Promise)
                void result.then(() => { });
        }
        if (shared)
            void emitShared(event, data, true).catch(report);
    }
    function eventClearEvent(event) { for (const entry of [...(listeners.get(event) ?? [])])
        eventRemoveListener(event, entry.listener); }
    function eventClearListener(listener) {
        for (const event of listeners.keys())
            eventRemoveListener(event, listener);
    }
    function eventClearAll() { for (const event of [...listeners.keys()])
        eventClearEvent(event); }
    const iframe_events = Object.freeze({
        MESSAGE_IFRAME_RENDER_STARTED: 'message_iframe_render_started', MESSAGE_IFRAME_RENDER_ENDED: 'message_iframe_render_ended',
        GENERATION_STARTED: 'js_generation_started', GENERATION_ENDED: 'js_generation_ended',
        STREAM_TOKEN_RECEIVED_FULLY: 'js_stream_token_received_fully', STREAM_TOKEN_RECEIVED_INCREMENTALLY: 'js_stream_token_received_incrementally',
    });
    // 常量便于既有脚本注册监听；宿主事件不会被伪装成已发生。
    const tavern_events = Object.freeze({
        APP_READY: 'app_ready', CHAT_CHANGED: 'chat_id_changed', MESSAGE_RECEIVED: 'message_received', MESSAGE_SENT: 'message_sent',
        MESSAGE_UPDATED: 'message_updated', MESSAGE_EDITED: 'message_edited', MESSAGE_DELETED: 'message_deleted', MESSAGE_SWIPED: 'message_swiped',
        USER_MESSAGE_RENDERED: 'user_message_rendered', CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
        GENERATION_STARTED: 'generation_started', GENERATION_ENDED: 'generation_ended', GENERATION_STOPPED: 'generation_stopped',
    });
    const api = { eventOn, eventOnce, eventMakeFirst, eventMakeLast, eventEmit, eventEmitAndWait,
        eventRemoveListener, eventClearEvent, eventClearListener, eventClearAll, iframe_events, tavern_events };
    Object.assign(root, api);
    root.__dshTavernEmitLocal = emitLocal;
    root.TavernHelper = Object.assign(root.TavernHelper ?? {}, api);
    return () => {
        active = false;
        eventClearAll();
        if (shared) {
            post('helperEventDisconnect');
            window.removeEventListener('message', receive);
        }
        for (const pending of outgoing.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('卡面事件运行时已关闭'));
        }
        outgoing.clear();
        for (const pending of incoming.values())
            clearTimeout(pending.timer);
        incoming.clear();
        if (root.__dshTavernEmitLocal === emitLocal)
            delete root.__dshTavernEmitLocal;
    };
}
