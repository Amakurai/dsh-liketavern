import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** 会话原生 MVU 调度器：后台轮询持久任务，绑定脚本就绪与租约，沙箱计算完成后才提交结果。 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { buildCardSrcDoc } from '../core/cardFrame.js';
import { helperJson, helperRecord } from '../core/helperRuntime.js';
import { attachHelperEvents } from './helperEventRouter.js';
import { notifyHelperStory } from './helperNotifications.js';
import { useT } from './i18n.js';
import { Btn, Err, Muted } from './util.js';
export function HelperMvuRunner(props) {
    const t = useT(), frame = useRef(null), live = useRef(props);
    live.current = props;
    const [error, setError] = useState(null), [busy, setBusy] = useState(false), [restartRequired, setRestartRequired] = useState(false);
    const [canceling, setCanceling] = useState(false), [cancelError, setCancelError] = useState(null), cancelPending = useRef(false);
    const cancelWaiting = async () => {
        if (!props.onCancel || cancelPending.current)
            return;
        cancelPending.current = true;
        setCanceling(true);
        setCancelError(null);
        try {
            await props.onCancel();
        }
        catch (value) {
            setCancelError(String(value instanceof Error ? value.message : value));
        }
        finally {
            cancelPending.current = false;
            setCanceling(false);
        }
    };
    const retry = useRef(() => { });
    useEffect(() => { props.onStatus?.({ error, busy, retry: () => retry.current() }); }, [error, busy, props.onStatus]);
    const srcDoc = useMemo(() => buildCardSrcDoc('', { greetings: [], greetingIndex: 0, helperSnapshot: props.snapshot, mvuRunner: true }), [props.sessionId, props.storyId]);
    useLayoutEffect(() => {
        let active = true, frameRuntime = '', running = false, polling = false, failed = false, committing = false;
        let work, result, deadline = 0, renewAt = 0, requestId = '', restart = false;
        const runtimeId = crypto.randomUUID(), { sessionId, storyId } = props;
        const send = (message) => { if (active)
            frame.current?.contentWindow?.postMessage({ source: 'dsh-tavern-card', ...message }, '*'); };
        const valid = () => active && running && !failed && live.current.ready && Boolean(work?.job) && Date.now() < deadline;
        const endpoint = attachHelperEvents(sessionId, storyId, send, { current: valid, snapshot: () => work?.snapshot });
        const fail = (value) => { if (active) {
            failed = true;
            running = false;
            setBusy(false);
            setError(String(value instanceof Error ? value.message : value).slice(0, 2000));
        } };
        const complete = () => {
            work = undefined;
            result = undefined;
            running = false;
            failed = false;
            restart = false;
            setRestartRequired(false);
            setBusy(false);
            setError(null);
            notifyHelperStory(sessionId, storyId);
        };
        const commit = async () => {
            if (!work?.job || !work.token || result === undefined || committing)
                return;
            if (!live.current.ready)
                throw new Error('脚本尚未就绪，MVU 结果等待重试');
            committing = true;
            try {
                const response = await live.current.remote.commitHelperMvuJob({ sessionId, storyId, runtimeId, jobId: work.job.id, token: work.token, data: result });
                if (!response.ok)
                    throw new Error(response.error.message);
                if (!active)
                    return;
                complete();
            }
            finally {
                committing = false;
            }
        };
        const poll = async () => {
            if (!active || polling || !frameRuntime || !live.current.ready)
                return;
            if (failed && result === undefined)
                return;
            if (running && Date.now() > deadline) {
                fail('MVU 任务执行超时；任务已保留');
                return;
            }
            if (work && Date.now() < renewAt)
                return;
            polling = true;
            try {
                const response = await live.current.remote.prepareHelperMvuJob({ sessionId, storyId, runtimeId });
                if (!response.ok)
                    throw new Error(response.error.message);
                if (!active)
                    return;
                const next = response.value;
                renewAt = Date.now() + 20000;
                if (work) {
                    if (next.job?.id !== work.job?.id || next.token !== work.token) {
                        const previous = work, receipt = next.completed?.find(item => item.id === previous.job?.id);
                        if (receipt && result !== undefined) {
                            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(helperJson(result))));
                            if (!active || work !== previous)
                                return;
                            const hex = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
                            if (hex === receipt.digest) {
                                complete();
                                return;
                            }
                        }
                        restart = true;
                        setRestartRequired(true);
                        throw new Error('MVU 租约已改变；请重新读取任务，未提交的变量钩子将重新执行');
                    }
                    return;
                }
                setBusy(next.status === 'waiting');
                if (failed || !live.current.ready || next.status !== 'pending' || !next.job || !next.token || !next.snapshot)
                    return;
                work = next;
                running = true;
                deadline = Date.now() + 300000;
                requestId = crypto.randomUUID();
                setBusy(true);
                setError(null);
                send({ action: 'helperMvuRun', runtimeId: frameRuntime, requestId, work: next });
            }
            catch (value) {
                fail(value);
            }
            finally {
                polling = false;
            }
        };
        const receive = (event) => {
            if (!active || event.source !== frame.current?.contentWindow || !helperRecord(event.data) || event.data.source !== 'dsh-tavern-card')
                return;
            const value = event.data;
            if (typeof value.action === 'string' && value.action.startsWith('helperEvent')) {
                endpoint.receive(value);
                return;
            }
            if (value.action === 'helperMvuReady' && endpoint.matchesRuntime(value.runtimeId)) {
                if (frameRuntime && frameRuntime !== value.runtimeId) {
                    fail('MVU 执行沙箱已重建');
                    return;
                }
                frameRuntime = String(value.runtimeId);
                void poll();
                return;
            }
            if (value.action === 'helperSnapshotGet' && typeof value.requestId === 'string' && value.storyId === storyId) {
                send({ action: 'helperSnapshotResult', requestId: value.requestId, ok: true, snapshot: work?.snapshot ?? live.current.snapshot });
                return;
            }
            if (value.action !== 'helperMvuResult' || !endpoint.matchesRuntime(value.runtimeId) || value.requestId !== requestId || !running)
                return;
            if (!valid()) {
                fail('MVU 任务或脚本就绪状态已改变');
                return;
            }
            if (value.ok !== true) {
                fail(value.error);
                return;
            }
            try {
                result = helperJson(value.data);
                void commit().catch(fail);
            }
            catch (error) {
                fail(error);
            }
        };
        retry.current = () => {
            failed = false;
            setError(null);
            if (restart) {
                restart = false;
                setRestartRequired(false);
                result = undefined;
                work = undefined;
                running = false;
                renewAt = 0;
                void poll();
            }
            else if (result !== undefined) {
                setBusy(true);
                void commit().catch(fail);
            }
            else {
                work = undefined;
                running = false;
                renewAt = 0;
                void poll();
            }
        };
        window.addEventListener('message', receive);
        const timer = setInterval(() => { void poll(); }, 1000);
        return () => { active = false; clearInterval(timer); endpoint.dispose(); window.removeEventListener('message', receive); retry.current = () => { }; };
    }, [props.sessionId, props.storyId, srcDoc]);
    return _jsxs("span", { children: [_jsx(Muted, { children: t(!props.ready ? 'speech.mvuWaiting' : busy ? 'speech.mvuRunning' : 'speech.mvuReady') }), _jsx(Err, { message: error }), _jsx(Err, { message: cancelError }), props.onCancel && (!props.ready || busy || error) && _jsx(Btn, { disabled: canceling, onClick: () => { void cancelWaiting(); }, children: t('speech.mvuCancel') }), error && _jsx(Btn, { onClick: () => retry.current(), children: t(restartRequired ? 'speech.mvuRestart' : 'speech.mvuRetry') }), _jsx("iframe", { ref: frame, srcDoc: srcDoc, sandbox: "allow-scripts", title: t('speech.mvuTitle'), hidden: true })] });
}
