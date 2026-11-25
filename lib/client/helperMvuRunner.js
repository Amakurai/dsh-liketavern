import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** 会话原生 MVU 调度器：后台轮询持久任务，绑定脚本就绪与租约，沙箱计算完成后才提交结果。 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { describeError } from '../core/guards.js';
import { buildCardSrcDoc } from '../core/cardFrame.js';
import { helperJson, helperRecord } from '../core/helperRuntime.js';
import { attachHelperEvents } from './helperEventRouter.js';
import { notifyHelperStory, watchHelperStory } from './helperNotifications.js';
import { useT } from './i18n.js';
import { Btn, Err, Muted } from './util.js';
import { subscribeWindowMessage } from './windowEvents.js';
import { randomUuid, sha256Hex } from '../core/secureRandom.js';
const IDLE_POLL_BASE_DELAY_MS = 2_000;
const IDLE_POLL_MAX_DELAY_MS = 30_000;
export function HelperMvuRunner(props) {
    const t = useT(), frame = useRef(null), live = useRef(props);
    live.current = props;
    const [error, setError] = useState(null), [busy, setBusy] = useState(false), [restartRequired, setRestartRequired] = useState(false);
    const [canceling, setCanceling] = useState(false), [cancelError, setCancelError] = useState(null), cancelPending = useRef(false), mounted = useRef(true);
    const [sandboxGen, setSandboxGen] = useState(0);
    // 同一 (sessionId, storyId) 下沙箱因卡死/脚本失联重建时沿用宿主侧租约身份，避免服务端 90s 租约自锁。
    const runnerIdentity = useRef({ key: '', runtimeId: '' });
    useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
    const cancelWaiting = async () => {
        if (!live.current.onCancel || cancelPending.current)
            return;
        cancelPending.current = true;
        setCanceling(true);
        setCancelError(null);
        try {
            await live.current.onCancel();
        }
        catch (value) {
            if (mounted.current)
                setCancelError(describeError(value));
        }
        finally {
            cancelPending.current = false;
            if (mounted.current)
                setCanceling(false);
        }
    };
    const cancelRef = useRef(cancelWaiting);
    cancelRef.current = cancelWaiting;
    const retry = useRef(() => { }), pollRef = useRef(() => { });
    const canCancel = Boolean(props.onCancel && (!props.ready || busy || error));
    const hasCancel = Boolean(props.onCancel);
    useEffect(() => { props.onStatus?.({ error, busy, restartRequired, canCancel, canceling, cancelError, retry: () => retry.current(), cancel: hasCancel ? () => cancelRef.current() : undefined }); }, [error, busy, restartRequired, canCancel, canceling, cancelError, hasCancel, props.onStatus]);
    const srcDoc = useMemo(() => buildCardSrcDoc('', { greetings: [], greetingIndex: 0, helperSnapshot: props.snapshot, mvuRunner: true }), [props.sessionId, props.storyId]);
    useLayoutEffect(() => {
        let active = true, frameRuntime = '', running = false, sandboxBusy = false, polling = false, failed = false, committing = false, wakeQueued = false, selfNotifying = false;
        let work, result, deadline = 0, renewAt = 0, renewFailures = 0, idlePollAt = 0, idleAttempts = 0, requestId = '', restart = false;
        let timerId;
        const nextPollDelay = () => {
            const now = Date.now();
            if (running) {
                const wakeAt = deadline > 0 ? Math.min(renewAt || deadline, deadline) : renewAt || now + 1000;
                return Math.max(250, Math.min(20000, wakeAt - now));
            }
            if (work && renewAt > now)
                return Math.max(250, Math.min(20000, renewAt - now));
            if (idlePollAt > now)
                return Math.max(250, idlePollAt - now);
            return 1000;
        };
        const scheduleTimer = () => {
            if (timerId !== undefined) {
                clearTimeout(timerId);
                timerId = undefined;
            }
            if (!active || (failed && result === undefined) || restart)
                return;
            if (!running && (!frameRuntime || !live.current.ready))
                return;
            timerId = setTimeout(() => { timerId = undefined; void poll(); }, nextPollDelay());
        };
        const { sessionId, storyId } = props;
        const identityKey = `${sessionId}\0${storyId}`;
        if (runnerIdentity.current.key !== identityKey) {
            runnerIdentity.current = { key: identityKey, runtimeId: randomUuid() };
        }
        const runtimeId = runnerIdentity.current.runtimeId;
        const requests = new Set();
        // RPC 无响应也必须释放本地在途锁；迟到响应只结束原 Promise，不能覆盖重试后的任务。
        const request = async (call) => {
            let timer, cancel;
            const timeout = new Promise((_resolve, reject) => {
                cancel = () => reject(new Error(t('speech.mvuRequestTimeout')));
                timer = setTimeout(cancel, 20000);
                requests.add(cancel);
            });
            try {
                return await Promise.race([Promise.resolve().then(call), timeout]);
            }
            finally {
                clearTimeout(timer);
                requests.delete(cancel);
            }
        };
        const send = (message) => { if (active)
            frame.current?.contentWindow?.postMessage({ source: 'dsh-tavern-card', ...message }, '*'); };
        const valid = () => active && running && !failed && live.current.ready && Boolean(work?.job) && Date.now() < deadline;
        const endpoint = attachHelperEvents(sessionId, storyId, send, { current: valid, snapshot: () => work?.snapshot });
        const fail = (value) => { if (active) {
            failed = true;
            running = false;
            if (result === undefined && timerId !== undefined) {
                clearTimeout(timerId);
                timerId = undefined;
            }
            setBusy(false);
            setError(describeError(value).slice(0, 2000));
        } };
        const complete = (next) => {
            work = undefined;
            result = undefined;
            running = false;
            failed = false;
            restart = false;
            renewFailures = 0;
            if (next && next.status === 'idle' && !next.awaitingTurnEnd) {
                idleAttempts = 1;
                idlePollAt = Date.now() + IDLE_POLL_BASE_DELAY_MS;
            }
            else {
                idleAttempts = 0;
                idlePollAt = 0;
            }
            setRestartRequired(false);
            setBusy(false);
            setError(null);
            selfNotifying = true;
            try {
                notifyHelperStory(sessionId, storyId);
            }
            finally {
                selfNotifying = false;
            }
            scheduleTimer();
        };
        const commit = async () => {
            if (!work?.job || !work.token || result === undefined || committing)
                return;
            if (!live.current.ready)
                throw new Error(t('speech.mvuScriptsNotReady'));
            committing = true;
            try {
                const payload = { sessionId, storyId, runtimeId, jobId: work.job.id, token: work.token, data: result };
                const response = await request(() => live.current.remote.commitHelperMvuJob(payload));
                if (!response.ok)
                    throw new Error(response.error.message);
                if (!active)
                    return;
                complete(response.value);
            }
            finally {
                committing = false;
                if (wakeQueued && active) {
                    wakeQueued = false;
                    void poll();
                }
                else
                    scheduleTimer();
            }
        };
        const poll = async () => {
            if (!active || polling || committing)
                return;
            if ((failed && result === undefined) || restart)
                return;
            if (running && !live.current.ready) {
                fail(t('speech.mvuScriptsNotReady'));
                return;
            }
            if (running && Date.now() > deadline) {
                fail(t('speech.mvuExecutionTimeout'));
                return;
            }
            if (!frameRuntime || !live.current.ready)
                return;
            if (work && Date.now() < renewAt) {
                scheduleTimer();
                return;
            }
            if (!work && Date.now() < idlePollAt) {
                scheduleTimer();
                return;
            }
            polling = true;
            const expectedWork = work;
            try {
                const response = await request(() => live.current.remote.prepareHelperMvuJob({ sessionId, storyId, runtimeId }));
                if (!active || work !== expectedWork)
                    return;
                if (!response.ok)
                    throw new Error(response.error.message);
                const next = response.value;
                renewFailures = 0;
                renewAt = Date.now() + 20000;
                if (work) {
                    if (next.job?.id !== work.job?.id || next.token !== work.token) {
                        const previous = work, receipt = next.completed?.find(item => item.id === previous.job?.id);
                        if (receipt && result !== undefined) {
                            const hex = await sha256Hex(JSON.stringify(helperJson(result)));
                            if (!active || work !== previous)
                                return;
                            if (hex === receipt.digest) {
                                complete();
                                return;
                            }
                        }
                        restart = true;
                        setRestartRequired(true);
                        throw new Error(t('speech.mvuLeaseChanged'));
                    }
                    if (running && result === undefined)
                        setError(null);
                    return;
                }
                setBusy(next.status === 'waiting');
                if (failed || !live.current.ready || next.status !== 'pending' || !next.job || !next.token || !next.snapshot) {
                    if (next.status === 'waiting' || next.awaitingTurnEnd) {
                        idleAttempts = 0;
                        idlePollAt = Date.now() + 1000;
                    }
                    else {
                        const delay = Math.min(IDLE_POLL_MAX_DELAY_MS, IDLE_POLL_BASE_DELAY_MS * 2 ** Math.min(idleAttempts, 4));
                        idleAttempts++;
                        idlePollAt = Date.now() + delay;
                    }
                    return;
                }
                idleAttempts = 0;
                idlePollAt = 0;
                work = next;
                running = true;
                sandboxBusy = true;
                deadline = Date.now() + 300000;
                requestId = randomUuid();
                setBusy(true);
                setError(null);
                send({ action: 'helperMvuRun', runtimeId: frameRuntime, requestId, work: next });
            }
            catch (value) {
                if (work === expectedWork) {
                    if (work)
                        renewAt = Date.now() + Math.min(60000, 5000 * 2 ** Math.min(renewFailures++, 4));
                    // 沙箱计算中遇到瞬时续租错误不中止 running，也不停轮询；保留计算结果接收能力并按 renewAt 退避重试续租。
                    if (running && result === undefined && !restart) {
                        if (active)
                            setError(describeError(value).slice(0, 2000));
                    }
                    else
                        fail(value);
                }
            }
            finally {
                polling = false;
                if (wakeQueued && active) {
                    wakeQueued = false;
                    void poll();
                }
                else
                    scheduleTimer();
            }
        };
        const wake = () => { if (selfNotifying)
            return; idleAttempts = 0; idlePollAt = 0; if (polling || committing) {
            wakeQueued = true;
            return;
        } void poll(); };
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
                    fail(t('speech.mvuSandboxChanged'));
                    return;
                }
                frameRuntime = String(value.runtimeId);
                wake();
                return;
            }
            // 快照读取与其它业务回执同口径：卡面重建后的旧运行时迟到请求不能拿到当前剧情快照，回执亦须携带 runtimeId。
            if (value.action === 'helperSnapshotGet' && typeof value.requestId === 'string' && value.storyId === storyId && endpoint.matchesRuntime(value.runtimeId)) {
                send({ action: 'helperSnapshotResult', runtimeId: value.runtimeId, requestId: value.requestId, ok: true, snapshot: work?.snapshot ?? live.current.snapshot });
                return;
            }
            if (value.action !== 'helperMvuResult' || !endpoint.matchesRuntime(value.runtimeId) || value.requestId !== requestId)
                return;
            sandboxBusy = false;
            if (!running || result !== undefined)
                return;
            if (!valid()) {
                fail(t('speech.mvuTaskChanged'));
                return;
            }
            if (value.ok !== true) {
                fail(value.error);
                return;
            }
            try {
                result = helperJson(value.data);
                void commit().catch(error => { fail(error); scheduleTimer(); });
            }
            catch (error) {
                fail(error);
            }
        };
        retry.current = () => {
            // 计算中遇到瞬时续租失败时，沙箱仍在执行：直接立即重试续租，避免把进行中的计算提前打断。
            if (running && result === undefined && !restart && !failed) {
                renewAt = 0;
                void poll();
                return;
            }
            // 旧任务超限/租约变更后沙箱仍占着 busy 锁：重建隔离 iframe，避免重发 helperMvuRun 立刻被拒绝。
            if (sandboxBusy) {
                setRestartRequired(false);
                setError(null);
                setBusy(false);
                setSandboxGen(n => n + 1);
                return;
            }
            failed = false;
            setError(null);
            idleAttempts = 0;
            idlePollAt = 0;
            if (restart) {
                restart = false;
                setRestartRequired(false);
                result = undefined;
                work = undefined;
                running = false;
                renewFailures = 0;
                renewAt = 0;
                void poll();
            }
            else if (result !== undefined) {
                setBusy(true);
                void commit().catch(error => { fail(error); scheduleTimer(); });
            }
            else {
                work = undefined;
                running = false;
                renewFailures = 0;
                renewAt = 0;
                void poll();
            }
        };
        pollRef.current = wake;
        const stopWatch = watchHelperStory(sessionId, storyId, wake);
        const unsubscribeMsg = subscribeWindowMessage(frame.current?.contentWindow, receive);
        scheduleTimer();
        return () => { active = false; if (timerId !== undefined)
            clearTimeout(timerId); stopWatch(); for (const cancel of requests)
            cancel(); endpoint.dispose(); unsubscribeMsg(); retry.current = () => { }; pollRef.current = () => { }; };
    }, [props.sessionId, props.storyId, srcDoc, sandboxGen]);
    useEffect(() => { pollRef.current(); }, [props.ready]);
    return _jsxs("span", { children: [_jsx(Muted, { children: t(!props.ready ? 'speech.mvuWaiting' : busy ? 'speech.mvuRunning' : 'speech.mvuReady') }), _jsx(Err, { message: error }), _jsx(Err, { message: cancelError }), canCancel && _jsx(Btn, { disabled: canceling, onClick: () => { void cancelWaiting(); }, children: t('speech.mvuCancel') }), error && _jsx(Btn, { onClick: () => retry.current(), children: t(restartRequired ? 'speech.mvuRestart' : 'speech.mvuRetry') }), _jsx("iframe", { ref: frame, srcDoc: srcDoc, sandbox: "allow-scripts", title: t('speech.mvuTitle'), hidden: true }, sandboxGen)] });
}
