import { BINDING_CHANGED_EVENT } from './actions.js';
import { emitHelperHostEvent, reportHelperHostEventError } from './helperEventRouter.js';
import { notifyHelperStory } from './helperNotifications.js';
import { isCurrentTavernSession } from './mode.js';
const MAX_QUEUE = 256, MAX_TURNS = 64, MAX_ASSISTANTS = 4096;
class SourceChanged extends Error {
}
/** 仅解析当前已保留会话的公开 binding，不调用 open/历史分页；旧宿主没有 binding 时不安装。 */
export function installHelperLiveEvents(sessions, remote) {
    if (!sessions.binding)
        return () => { };
    let active = true, selected;
    const current = (view, epoch = view.epoch) => active && selected === view && view.active && view.epoch === epoch;
    const report = (view, error) => {
        if (current(view) && !(error instanceof SourceChanged))
            reportHelperHostEventError(view.sessionId, view.storyId ?? '', error);
    };
    const cancel = (view) => {
        view.epoch++;
        for (const stop of [...view.requests])
            stop();
        view.queue = [];
        view.turns.clear();
        view.assistantCount = 0;
        view.running = false;
    };
    const read = (view, request, epoch = view.epoch) => {
        if (!current(view, epoch))
            return Promise.reject(new SourceChanged('宿主事件来源已改变'));
        return new Promise((resolve, reject) => {
            let done = false;
            const finish = (error, result) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                view.requests.delete(stop);
                if (error)
                    reject(error);
                else if (!current(view, epoch))
                    reject(new SourceChanged('宿主事件来源已改变'));
                else
                    resolve(result);
            };
            const stop = () => finish(new SourceChanged('宿主事件来源已改变'));
            const timer = setTimeout(() => finish(new Error('宿主消息事件快照读取超时')), 25000);
            view.requests.add(stop);
            try {
                void remote.getHelperEventState(request).then(result => {
                    if (!result.ok)
                        finish(new Error(result.error.message));
                    else
                        finish(undefined, result.value);
                }, finish);
            }
            catch (error) {
                finish(error);
            }
        });
    };
    const baseline = (view, snapshot) => {
        view.revision = snapshot.revision;
        for (const entry of snapshot.entries)
            view.highwater = Math.max(view.highwater, entry.event.seq);
    };
    const reset = (view, snapshot) => {
        cancel(view);
        baseline(view, snapshot);
        if (!view.ready)
            initialize(view);
        if (view.storyId)
            notifyHelperStory(view.sessionId, view.storyId);
    };
    const dispatch = async (view, signal, epoch) => {
        const state = await read(view, { sessionId: view.sessionId, storyId: view.storyId,
            ...(signal.kind === 'end' ? { closedSeq: signal.seq } : {}) }, epoch);
        if (view.storyId !== undefined && state.storyId !== view.storyId)
            throw new Error('宿主消息事件的剧情绑定已改变');
        view.storyId = state.storyId;
        const valid = () => current(view, epoch) && view.storyId === state.storyId;
        const emit = (event, data) => emitHelperHostEvent(view.sessionId, state.storyId, event, data, valid);
        if (!valid())
            return;
        if (signal.kind === 'start')
            await emit('generation_started', ['normal', {}, false]);
        else if (signal.kind === 'user') {
            const message = state.messages.find(item => item.seq === signal.seq && item.role === 'user');
            if (message) {
                notifyHelperStory(view.sessionId, state.storyId);
                await emit('message_sent', [message.message_id]);
            }
        }
        else {
            if (state.closedThrough < signal.seq)
                throw new Error('宿主消息事件尚未完成剧情收口');
            notifyHelperStory(view.sessionId, state.storyId);
            if (!signal.completed) {
                await emit('generation_stopped', []);
                return;
            }
            for (const seq of signal.assistants) {
                if (!valid())
                    return;
                const message = state.messages.find(item => item.seq === seq && item.role === 'assistant');
                if (message)
                    await emit('message_received', [message.message_id, 'normal']);
            }
            if (!valid())
                return;
            const last = state.messages.filter(item => item.seq <= signal.seq).at(-1);
            await emit('generation_ended', [last?.message_id ?? -1]);
        }
    };
    const drain = (view) => {
        if (view.running || !view.ready || !current(view))
            return;
        const epoch = view.epoch;
        view.running = true;
        void (async () => {
            while (current(view, epoch) && view.queue.length) {
                const signal = view.queue.shift();
                try {
                    await dispatch(view, signal, epoch);
                }
                catch (error) {
                    if (current(view, epoch))
                        report(view, error);
                }
            }
        })().finally(() => {
            if (!current(view, epoch))
                return;
            view.running = false;
            if (view.queue.length)
                drain(view);
        });
    };
    const enqueue = (view, signal) => {
        if (view.queue.length >= MAX_QUEUE)
            throw new Error('宿主消息事件超过待处理预算');
        view.queue.push(signal);
    };
    const initialize = (view) => {
        const epoch = view.epoch;
        void read(view, { sessionId: view.sessionId }, epoch).then(state => {
            if (!current(view, epoch))
                return;
            view.storyId = state.storyId;
            view.ready = true;
            drain(view);
        }).catch(error => {
            if (!current(view, epoch))
                return;
            report(view, error);
            cancel(view);
            view.ready = false;
        });
    };
    const capture = (view, event) => {
        if (event.seq <= view.highwater)
            return;
        view.highwater = event.seq;
        if (event.type === 'turn/start') {
            let turn = view.turns.get(event.data.turn);
            if (!turn) {
                if (view.turns.size >= MAX_TURNS)
                    throw new Error('宿主消息事件超过待完成轮次预算');
                turn = { started: false, assistants: [] };
                view.turns.set(event.data.turn, turn);
            }
            if (!turn.started) {
                turn.started = true;
                enqueue(view, { kind: 'start', seq: event.seq });
            }
        }
        else if (event.type === 'user/message' && (event.surfaceOp === undefined || event.surfaceOp === 'append')) {
            enqueue(view, { kind: 'user', seq: event.seq });
        }
        else if (event.type === 'assistant/message' && (event.surfaceOp === undefined || event.surfaceOp === 'append') && !event.data.interrupted) {
            let turn = view.turns.get(event.data.turn);
            if (!turn) {
                if (view.turns.size >= MAX_TURNS)
                    throw new Error('宿主消息事件超过待完成轮次预算');
                turn = { started: false, assistants: [] };
                view.turns.set(event.data.turn, turn);
            }
            if (view.assistantCount >= MAX_ASSISTANTS)
                throw new Error('宿主消息事件超过待完成回复预算');
            turn.assistants.push(event.seq);
            view.assistantCount++;
        }
        else if (event.type === 'turn/end') {
            const turn = view.turns.get(event.data.turn);
            if (!turn)
                return;
            view.turns.delete(event.data.turn);
            view.assistantCount -= turn.assistants.length;
            enqueue(view, { kind: 'end', seq: event.seq, completed: event.data.reason.kind === 'completed', assistants: turn.assistants });
        }
    };
    const sync = () => {
        const sessionId = isCurrentTavernSession(sessions.list) ? sessions.list.getSnapshot().current : undefined;
        const binding = sessionId ? sessions.binding?.(sessionId) : undefined;
        if (selected?.sessionId === sessionId && selected?.source === binding?.eventSource)
            return;
        if (selected) {
            selected.active = false;
            cancel(selected);
            selected.dispose();
            selected = undefined;
        }
        if (!active || !sessionId || !binding || binding.sessionId !== sessionId)
            return;
        const view = { sessionId, source: binding.eventSource, active: true, epoch: 0, revision: -1, highwater: -1,
            turns: new Map(), assistantCount: 0, queue: [], running: false, ready: false, requests: new Set(), dispose: () => { }, probe: 0 };
        selected = view;
        baseline(view, view.source.getSnapshot());
        view.dispose = view.source.subscribe(() => {
            if (!current(view))
                return;
            const snapshot = view.source.getSnapshot();
            if (snapshot.revision <= view.revision)
                return;
            view.revision = snapshot.revision;
            if (snapshot.change.kind === 'replace') {
                reset(view, snapshot);
                return;
            }
            if (snapshot.change.kind === 'prepend')
                return;
            try {
                for (const entry of snapshot.change.entries)
                    capture(view, entry.event);
            }
            catch (error) {
                report(view, error);
                reset(view, snapshot);
                return;
            }
            drain(view);
        });
        // 订阅先于异步身份读取；读取期间到达的 live append 仍完整留在同步游标中。
        initialize(view);
    };
    const changed = (event) => {
        const view = selected;
        if (!view || event.detail !== view.sessionId)
            return;
        const epoch = view.epoch, probe = ++view.probe;
        void read(view, { sessionId: view.sessionId }, epoch).then(state => {
            if (!current(view, epoch) || probe !== view.probe)
                return;
            const different = view.storyId !== undefined && view.storyId !== state.storyId, suspended = !view.ready;
            view.storyId = state.storyId;
            view.ready = true;
            if (different || suspended)
                reset(view, view.source.getSnapshot());
            drain(view);
        }).catch(error => {
            if (!current(view, epoch) || probe !== view.probe)
                return;
            report(view, error);
            cancel(view);
            baseline(view, view.source.getSnapshot());
            view.ready = false;
        });
    };
    const unsub = sessions.list.subscribe(sync);
    if (typeof window !== 'undefined')
        window.addEventListener(BINDING_CHANGED_EVENT, changed);
    sync();
    return () => {
        active = false;
        unsub();
        if (typeof window !== 'undefined')
            window.removeEventListener(BINDING_CHANGED_EVENT, changed);
        if (selected) {
            selected.active = false;
            cancel(selected);
            selected.dispose();
            selected = undefined;
        }
    };
}
