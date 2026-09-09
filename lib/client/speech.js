import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 角色发言条：头像 + 名字 + 正文。正文经 output/render 正则后，
 * 再收起 UpdateVariable 等机读标签；整页 HTML 进沙箱 iframe，其余走 Markdown。
 *
 * 封面 iframe：允许 https 图片/字体；注入 ST getChatMessages/setChatMessage stub，
 * 卡内按钮经 postMessage 请求宿主 swipeGreeting。无 allow-same-origin。
 * 正则若只把标记换成 HTML，iframe 下面仍渲染剩余正文。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { IconCopyOutline16, MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives';
import { buildCardSrcDoc, parseCardBridgeMessage } from '../core/cardFrame.js';
import { ScriptChoices, publishScriptChoices, clearScriptChoices, parseScriptChoices } from './helperChoices.js';
import { cardVariableLabels } from './cardVariableLabels.js';
import { stripDisplayMeta } from '../core/displaySanitize.js';
import { cachedAvatar, invalidateSessionBinding } from './cache.js';
import { BINDING_CHANGED_EVENT } from './actions.js';
import { useT, useMarkdownLabels } from './i18n.js';
import { Avatar, Btn, Err, IconBtn, useLoader, useToast } from './util.js';
import { CARD_VARIABLE_STYLES } from './styles.js';
import { helperJson, helperChanges, helperRecord } from '../core/helperRuntime.js';
import { watchHelperStory, notifyHelperStory } from './helperNotifications.js';
import { notifyHelperScripts } from './helperScriptNotifications.js';
import { parseHelperScriptTrees } from '../core/helperScripts.js';
import { parseHelperMessageEdits } from '../core/helperChatEdits.js';
import { prepareHelperDisplay, registerHelperDisplay, waitHelperDisplay, HelperDisplayError } from './helperDisplay.js';
import { emitHelperHostEvent, hasHelperEventAudience } from './helperEventRouter.js';
import { attachHelperEvents } from './helperEventRouter.js';
function displayFailure(error, t) {
    if (error instanceof HelperDisplayError)
        return t(error.code === 'busy' ? 'speech.helperDisplayBusy' : error.code === 'timeout' ? 'speech.helperDisplayTimeout' : 'speech.helperDisplayStale');
    return error instanceof Error ? error.message : String(error);
}
export function SpeechHtmlFrame(props) {
    const iframeRef = useRef(null);
    const [frameH, setFrameH] = useState(null);
    const t = useT();
    const [editedBranch, setEditedBranch] = useState(null);
    const [branchError, setBranchError] = useState(null);
    const srcDoc = props.srcDoc;
    // 普通 React 重绘不销毁正在等待的回执；只有卡面文档替换或卸载才取消回复。
    const handlers = useRef({ onFrameReady: props.onFrameReady, onScriptError: props.onScriptError, onScriptReady: props.onScriptReady, onMessageEdit: props.onMessageEdit, onMessageBranch: props.onMessageBranch, onSwipeGreeting: props.onSwipeGreeting, onHelperCommit: props.onHelperCommit, onHelperRefresh: props.onHelperRefresh, onScriptCommit: props.onScriptCommit, onScriptRefresh: props.onScriptRefresh, onWorldbookRequest: props.onWorldbookRequest, onWorldbookRefresh: props.onWorldbookRefresh, onWorldbookBind: props.onWorldbookBind, t });
    handlers.current = { onFrameReady: props.onFrameReady, onScriptError: props.onScriptError, onScriptReady: props.onScriptReady, onMessageEdit: props.onMessageEdit, onMessageBranch: props.onMessageBranch, onSwipeGreeting: props.onSwipeGreeting, onHelperCommit: props.onHelperCommit, onHelperRefresh: props.onHelperRefresh, onScriptCommit: props.onScriptCommit, onScriptRefresh: props.onScriptRefresh, onWorldbookRequest: props.onWorldbookRequest, onWorldbookRefresh: props.onWorldbookRefresh, onWorldbookBind: props.onWorldbookBind, t };
    useEffect(() => {
        setFrameH(null);
    }, [srcDoc]);
    useEffect(() => {
        if (!props.helperBinding)
            return;
        const { sessionId, storyId } = props.helperBinding;
        return watchHelperStory(sessionId, storyId, () => iframeRef.current?.contentWindow?.postMessage({
            source: 'dsh-tavern-card', action: 'helperSnapshotInvalidated', storyId,
        }, '*'));
    }, [props.helperBinding?.sessionId, props.helperBinding?.storyId]);
    useLayoutEffect(() => {
        let active = true;
        const eventEndpoint = props.helperBinding ? attachHelperEvents(props.helperBinding.sessionId, props.helperBinding.storyId, message => { if (active)
            iframeRef.current?.contentWindow?.postMessage(message, '*'); }) : undefined;
        let editPending = false, editFinished = false, frameReady = false, legacyHeight = false;
        const pending = new Set(), scriptReceipts = new Set(), editReceipts = new Map();
        let displayBusy = false, guardSerial = 0;
        const heldGuards = new Set(), guardEpoch = crypto.randomUUID();
        const displayReceipts = new Map();
        const guards = new Map();
        const unlock = (id) => iframeRef.current?.contentWindow?.postMessage({ source: 'dsh-tavern-card', action: 'helperDisplayUnlock', requestId: id }, '*');
        const unregisterGuard = props.registerDisplayGuard?.(request => {
            if (pending.size || editPending || editFinished || guards.size)
                return Promise.reject(new Error(handlers.current.t('speech.helperSaveBusy')));
            const id = 'display-guard:' + guardEpoch + ':' + (++guardSerial);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => { guards.delete(id); unlock(id); reject(new Error(handlers.current.t('speech.helperSaveBusy'))); }, 5000);
                guards.set(id, { resolve, reject, timer });
                iframeRef.current?.contentWindow?.postMessage({ source: 'dsh-tavern-card', action: 'helperDisplayGuard', requestId: id, storyId: request.storyId, historyRevision: request.historyRevision }, '*');
            });
        });
        const choiceOwner = Symbol('script-choices');
        let choiceSerial = 0;
        const onMsg = (e) => {
            if (!iframeRef.current || e.source !== iframeRef.current.contentWindow)
                return;
            const value = e.data;
            if (helperRecord(value) && ['iframe-resize', 'resizeIframe'].includes(String(value.type)) && typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0) {
                legacyHeight = true;
                setFrameH(Math.min(8000, Math.max(80, Math.ceil(value.height))));
                return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && value.action === 'helperFrameReady') {
                if (!frameReady && eventEndpoint?.matchesRuntime(value.runtimeId)) {
                    frameReady = true;
                    handlers.current.onFrameReady?.();
                }
                return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && value.action === 'helperDisplayGuardResult' && typeof value.requestId === 'string') {
                const id = value.requestId, guard = guards.get(id);
                if (!guard)
                    return;
                guards.delete(id);
                clearTimeout(guard.timer);
                if (value.ok !== true || pending.size || editPending) {
                    unlock(id);
                    guard.reject(new Error(typeof value.error === 'string' ? value.error : handlers.current.t('speech.helperSaveBusy')));
                    return;
                }
                heldGuards.add(id);
                let held = true;
                const expires = Date.now() + 35000;
                const check = () => { if (!active || !held || Date.now() > expires)
                    throw new Error(handlers.current.t('speech.helperStoryChanged')); };
                guard.resolve({ check, commit: check, cancel: () => { if (held) {
                        held = false;
                        heldGuards.delete(id);
                        unlock(id);
                    } } });
                return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && value.action === 'helperDisplayApplied' && typeof value.requestId === 'string') {
                const receipt = displayReceipts.get(value.requestId);
                if (!receipt)
                    return;
                displayReceipts.delete(value.requestId);
                clearTimeout(receipt.timer);
                try {
                    receipt.lease.commit();
                }
                catch (error) {
                    setBranchError(displayFailure(error, handlers.current.t));
                }
                finally {
                    receipt.lease.cancel();
                    displayBusy = false;
                }
                return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && value.action === 'helperDisplayRefresh' && typeof value.requestId === 'string' && value.requestId.length <= 96) {
                const target = iframeRef.current.contentWindow, requestId = value.requestId;
                const respond = (data) => { if (active && iframeRef.current?.contentWindow === target)
                    target?.postMessage({ source: 'dsh-tavern-card', action: 'helperDisplayResult', requestId, ...data }, '*'); };
                if (displayBusy || pending.size || editPending || editFinished) {
                    respond({ ok: false, error: handlers.current.t('speech.helperSaveBusy') });
                    return;
                }
                displayBusy = true;
                void (async () => {
                    const binding = props.helperBinding;
                    if (!binding || value.storyId !== binding.storyId || typeof value.historyRevision !== 'string' || value.historyRevision.length > 96 || value.ids !== null && (!Array.isArray(value.ids) || value.ids.length > 4096 || value.ids.some(id => typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= 4096)))
                        throw new Error(handlers.current.t('speech.helperUnsupported'));
                    const snapshot = await waitHelperDisplay(Promise.resolve(handlers.current.onHelperRefresh?.()), AbortSignal.timeout(5000));
                    if (!snapshot || snapshot.storyId !== value.storyId || snapshot.historyRevision !== value.historyRevision || Array.isArray(value.ids) && value.ids.some(id => Number(id) >= snapshot.messages.length))
                        throw new Error(handlers.current.t('speech.helperStoryChanged'));
                    const lease = await prepareHelperDisplay(binding.sessionId, { storyId: binding.storyId, historyRevision: value.historyRevision, ids: value.ids });
                    if (!active) {
                        lease.cancel();
                        return;
                    }
                    const timer = setTimeout(() => { displayReceipts.delete(requestId); lease.cancel(); displayBusy = false; }, 10000);
                    displayReceipts.set(requestId, { lease, timer });
                    respond({ ok: true });
                })().catch(error => { displayBusy = false; respond({ ok: false, error: displayFailure(error, handlers.current.t) }); });
                return;
            }
            if (heldGuards.size && helperRecord(value) && value.source === 'dsh-tavern-card' && typeof value.action === 'string') {
                const responses = { helperMessageEdit: 'helperMessageEditResult', helperVariablesCommit: 'helperVariablesResult', helperSnapshotGet: 'helperSnapshotResult', helperScriptLibraryCommit: 'helperScriptLibraryResult', helperScriptLibrariesGet: 'helperScriptLibrariesResult', helperWorldbookOperation: 'helperWorldbookResult', helperWorldbookContextGet: 'helperWorldbookContextResult', helperWorldbookBind: 'helperWorldbookBindResult' };
                const action = responses[value.action];
                if (action) {
                    iframeRef.current.contentWindow?.postMessage({ source: 'dsh-tavern-card', action, requestId: value.requestId, ok: false, error: handlers.current.t('speech.helperSaveBusy') }, '*');
                    return;
                }
                if (value.action === 'swipeGreeting')
                    return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && value.action === 'helperMessageEditApplied' && typeof value.requestId === 'string') {
                const branch = editReceipts.get(value.requestId);
                if (branch) {
                    editReceipts.delete(value.requestId);
                    void handlers.current.onMessageBranch?.(branch).catch(error => { if (active)
                        setBranchError(String(error)); });
                }
                return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && value.action === 'helperMessageEdit' && typeof value.requestId === 'string' && value.requestId.length <= 96) {
                const target = iframeRef.current.contentWindow, requestId = value.requestId;
                const respond = (result) => { if (active && iframeRef.current?.contentWindow === target)
                    target?.postMessage({ source: 'dsh-tavern-card', action: 'helperMessageEditResult', requestId, ...result }, '*'); };
                if (pending.has(requestId))
                    return;
                if (pending.size >= 4 || editPending || editFinished || editReceipts.size) {
                    respond({ ok: false, error: handlers.current.t('speech.helperSaveBusy') });
                    return;
                }
                pending.add(requestId);
                editPending = true;
                void (async () => {
                    if (!handlers.current.onMessageEdit || !handlers.current.onMessageBranch || typeof value.storyId !== 'string' || value.storyId !== props.helperBinding?.storyId || typeof value.historyRevision !== 'string' || value.historyRevision.length > 96)
                        throw new Error(handlers.current.t('speech.helperUnsupported'));
                    const result = await handlers.current.onMessageEdit({ storyId: value.storyId, historyRevision: value.historyRevision, edits: parseHelperMessageEdits(value.edits), ...(value.before === undefined ? {} : { before: parseHelperMessageEdits(value.before) }) });
                    if (active && result.branch) {
                        editFinished = true;
                        editReceipts.set(requestId, result.branch);
                        setEditedBranch(result.branch);
                        setBranchError(null);
                    }
                    respond({ ok: true, result });
                })().catch(error => respond({ ok: false, error: error instanceof Error ? error.message : String(error) })).finally(() => { editPending = false; pending.delete(requestId); });
                return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && value.action === 'helperScriptChoices' && props.onScriptReady && props.helperBinding && eventEndpoint?.matchesRuntime(value.runtimeId)) {
                const serial = ++choiceSerial, binding = props.helperBinding;
                void (async () => { try {
                    if (typeof value.messageId !== 'number')
                        throw new Error('选项目标消息无效');
                    const choices = parseScriptChoices(value.choices), context = await handlers.current.onHelperRefresh?.();
                    if (!active || serial !== choiceSerial)
                        return;
                    if (!context || context.storyId !== binding.storyId || context.storyId !== value.storyId || context.historyRevision !== value.historyRevision)
                        throw new Error(handlers.current.t('speech.helperStoryChanged'));
                    publishScriptChoices(choiceOwner, binding.sessionId, context, value.messageId, choices);
                }
                catch (error) {
                    if (active && serial === choiceSerial) {
                        clearScriptChoices(choiceOwner);
                        handlers.current.onScriptError?.(error instanceof Error ? error.message : String(error));
                    }
                } })();
                return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && value.action === 'helperScriptDiagnostic' && eventEndpoint?.matchesRuntime(value.runtimeId) && typeof value.error === 'string' && value.error.length > 0 && value.error.length <= 2000) {
                choiceSerial++;
                clearScriptChoices(choiceOwner);
                handlers.current.onScriptError?.(value.error);
                handlers.current.onScriptReady?.(false);
                return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && value.action === 'helperScriptReady' && eventEndpoint?.matchesRuntime(value.runtimeId)) {
                handlers.current.onScriptReady?.(value.ok === true);
                return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && typeof value.action === 'string' && value.action.startsWith('helperEvent')) {
                (value.action === 'helperEventConnect' || value.action === 'helperEventDisconnect') && handlers.current.onScriptReady?.(false);
                eventEndpoint?.receive(value);
                return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && value.action === 'helperScriptLibraryApplied' && typeof value.requestId === 'string') {
                if (scriptReceipts.has(value.requestId) && props.helperBinding) {
                    scriptReceipts.clear();
                    notifyHelperScripts(props.helperBinding.sessionId, props.helperBinding.storyId);
                }
                return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && (value.action === 'helperScriptLibraryCommit' || value.action === 'helperScriptLibrariesGet') && typeof value.requestId === 'string' && value.requestId.length <= 96) {
                const target = iframeRef.current.contentWindow, requestId = value.requestId, resultAction = value.action === 'helperScriptLibraryCommit' ? 'helperScriptLibraryResult' : 'helperScriptLibrariesResult';
                const respond = (result) => { if (active && iframeRef.current?.contentWindow === target)
                    target?.postMessage({ source: 'dsh-tavern-card', action: resultAction, requestId, ...result }, '*'); };
                if (pending.has(requestId))
                    return;
                if (pending.size >= 4) {
                    respond({ ok: false, error: handlers.current.t('speech.helperSaveBusy') });
                    return;
                }
                pending.add(requestId);
                void (async () => {
                    if (typeof value.storyId !== 'string' || value.storyId !== props.helperBinding?.storyId)
                        throw new Error(handlers.current.t('speech.helperStoryChanged'));
                    if (value.action === 'helperScriptLibrariesGet') {
                        if (!handlers.current.onScriptRefresh)
                            throw new Error(handlers.current.t('speech.helperUnsupported'));
                        const context = await handlers.current.onScriptRefresh();
                        if (context.storyId !== value.storyId)
                            throw new Error(handlers.current.t('speech.helperStoryChanged'));
                        respond({ ok: true, context });
                        return;
                    }
                    if (!handlers.current.onScriptCommit || typeof value.bindingRevision !== 'string' || value.bindingRevision.length > 96 || typeof value.revision !== 'string' || value.revision.length > 96 || !['global', 'preset', 'character'].includes(String(value.type)))
                        throw new Error(handlers.current.t('speech.helperUnsupported'));
                    const library = await handlers.current.onScriptCommit({ storyId: value.storyId, bindingRevision: value.bindingRevision, type: value.type, revision: value.revision, trees: parseHelperScriptTrees(value.trees) });
                    if (active) {
                        scriptReceipts.add(requestId);
                        if (scriptReceipts.size > 16)
                            scriptReceipts.delete(scriptReceipts.values().next().value);
                    }
                    respond({ ok: true, library });
                })().catch(error => respond({ ok: false, error: error instanceof Error ? error.message : String(error) })).finally(() => pending.delete(requestId));
                return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && (value.action === 'helperWorldbookOperation' || value.action === 'helperWorldbookContextGet' || value.action === 'helperWorldbookBind') && typeof value.requestId === 'string' && value.requestId.length <= 96) {
                const target = iframeRef.current.contentWindow, requestId = value.requestId, resultAction = value.action === 'helperWorldbookOperation' ? 'helperWorldbookResult' : value.action === 'helperWorldbookBind' ? 'helperWorldbookBindResult' : 'helperWorldbookContextResult';
                const respond = (result) => { if (active && iframeRef.current?.contentWindow === target)
                    target?.postMessage({ source: 'dsh-tavern-card', action: resultAction, requestId, ...result }, '*'); };
                if (pending.has(requestId))
                    return;
                if (pending.size >= 4) {
                    respond({ ok: false, error: handlers.current.t('speech.helperSaveBusy') });
                    return;
                }
                pending.add(requestId);
                void (async () => {
                    if (typeof value.storyId !== 'string' || value.storyId !== props.helperBinding?.storyId)
                        throw new Error(handlers.current.t('speech.helperStoryChanged'));
                    if (value.action === 'helperWorldbookBind') {
                        if (!handlers.current.onWorldbookBind || typeof value.bindingRevision !== 'string' || value.bindingRevision.length > 96 || !['global', 'character', 'chat', 'ensure-chat', 'settings'].includes(String(value.kind)))
                            throw new Error(handlers.current.t('speech.helperUnsupported'));
                        const context = await handlers.current.onWorldbookBind({ storyId: value.storyId, bindingRevision: value.bindingRevision, kind: value.kind, selection: helperJson(value.selection, 16384) });
                        if (context.storyId !== value.storyId)
                            throw new Error(handlers.current.t('speech.helperStoryChanged'));
                        respond({ ok: true, context });
                        return;
                    }
                    if (value.action === 'helperWorldbookContextGet') {
                        if (!handlers.current.onWorldbookRefresh)
                            throw new Error(handlers.current.t('speech.helperUnsupported'));
                        const context = await handlers.current.onWorldbookRefresh();
                        if (context.storyId !== value.storyId)
                            throw new Error(handlers.current.t('speech.helperStoryChanged'));
                        respond({ ok: true, context });
                        return;
                    }
                    if (!handlers.current.onWorldbookRequest || typeof value.bindingRevision !== 'string' || value.bindingRevision.length > 96 || typeof value.name !== 'string' || value.name.length > 256 || !['get', 'replace', 'create', 'upsert', 'delete'].includes(String(value.operation)) || value.revision !== undefined && (typeof value.revision !== 'string' || value.revision.length > 96))
                        throw new Error(handlers.current.t('speech.helperUnsupported'));
                    const result = await handlers.current.onWorldbookRequest({ storyId: value.storyId, bindingRevision: value.bindingRevision, name: value.name, operation: value.operation, ...(value.revision === undefined ? {} : { revision: value.revision }), ...(value.entries === undefined ? {} : { entries: helperJson(value.entries, 8 * 1024 * 1024) }), ...(value.label === undefined ? {} : { label: value.label }) });
                    respond({ ok: true, result });
                })().catch(error => respond({ ok: false, error: error instanceof Error ? error.message : String(error) })).finally(() => pending.delete(requestId));
                return;
            }
            if (helperRecord(value) && value.source === 'dsh-tavern-card' && (value.action === 'helperVariablesCommit' || value.action === 'helperSnapshotGet')
                && typeof value.requestId === 'string' && value.requestId.length <= 96) {
                const target = iframeRef.current.contentWindow, requestId = value.requestId;
                const resultAction = value.action === 'helperSnapshotGet' ? 'helperSnapshotResult' : 'helperVariablesResult';
                const respond = (result) => {
                    if (active && iframeRef.current?.contentWindow === target)
                        target?.postMessage({ source: 'dsh-tavern-card', action: resultAction, requestId, ...result }, '*');
                };
                if (pending.has(requestId))
                    return;
                if (pending.size >= 4) {
                    respond({ ok: false, error: handlers.current.t('speech.helperSaveBusy') });
                    return;
                }
                pending.add(requestId);
                void (async () => {
                    if (value.action === 'helperSnapshotGet') {
                        const refresh = handlers.current.onHelperRefresh;
                        if (!refresh || typeof value.storyId !== 'string')
                            throw new Error(handlers.current.t('speech.helperUnsupported'));
                        const snapshot = await refresh();
                        if (snapshot.storyId !== value.storyId)
                            throw new Error(handlers.current.t('speech.helperStoryChanged'));
                        respond({ ok: true, snapshot });
                        return;
                    }
                    const commit = handlers.current.onHelperCommit;
                    if (!commit || typeof value.storyId !== 'string' || typeof value.historyRevision !== 'string')
                        throw new Error(handlers.current.t('speech.helperUnsupported'));
                    const snapshot = await commit({ storyId: value.storyId, historyRevision: value.historyRevision, changes: helperChanges(value.changes) });
                    respond({ ok: true, scopes: snapshot.scopes });
                })().catch(error => respond({ ok: false, error: error instanceof Error ? error.message : String(error) })).finally(() => pending.delete(requestId));
                return;
            }
            const parsed = parseCardBridgeMessage(e.data);
            if (!parsed)
                return;
            if (parsed.action === 'swipeGreeting' && typeof parsed.index === 'number') {
                handlers.current.onSwipeGreeting?.(parsed.index);
            }
            if (!legacyHeight && parsed.action === 'resize' && typeof parsed.height === 'number' && Number.isFinite(parsed.height)) {
                setFrameH(Math.min(8000, Math.max(80, Math.ceil(parsed.height))));
            }
        };
        window.addEventListener('message', onMsg);
        return () => { active = false; clearScriptChoices(choiceOwner); unregisterGuard?.(); for (const [id, guard] of guards) {
            clearTimeout(guard.timer);
            unlock(id);
            guard.reject(new Error('卡面已关闭'));
        } for (const receipt of displayReceipts.values()) {
            clearTimeout(receipt.timer);
            receipt.lease.cancel();
        } eventEndpoint?.dispose(); window.removeEventListener('message', onMsg); };
    }, [srcDoc, props.helperBinding?.sessionId, props.helperBinding?.storyId]);
    const frameStyle = frameH != null
        ? { height: frameH, minHeight: 0, overflow: 'hidden' }
        : props.compact
            ? { height: 80, minHeight: 0, overflow: 'auto' }
            : props.widget
                ? { height: 280, minHeight: 0, overflow: 'auto' }
                : { overflow: 'auto' };
    return (_jsxs(_Fragment, { children: [_jsx("iframe", { ref: iframeRef, className: `dsh-tavern-speechHtml${props.widget || props.compact ? ' is-widget' : ''}`, sandbox: "allow-scripts", srcDoc: srcDoc, title: props.title, style: frameStyle }), editedBranch && _jsxs("div", { className: "dsh-tavern-cardBackupBar", children: [_jsx(Btn, { onClick: () => { void props.onMessageBranch?.(editedBranch).catch(error => setBranchError(String(error))); }, children: t('speech.openEditedBranch') }), _jsx(Err, { message: branchError })] })] }));
}
/** 按会话和角色卸载旧气泡状态，慢请求的报错不能留到新会话。 */
export function SpeechBubble(props) {
    return _jsx(SpeechBubbleSession, { ...props }, `${props.sessionId}:${props.cardId}`);
}
function SpeechBubbleSession(props) {
    const { remote, sessionId, cardId, name, rawText, streaming, onSwipeGreeting } = props;
    const t = useT();
    const markdownLabels = useMarkdownLabels();
    // 头像走进程内缓存（key=cardId，TTL 60s）：同一会话的 N 条气泡不再各传一次 dataURL。
    const avatar = useLoader(() => cachedAvatar(remote, cardId), [cardId], Boolean(cardId));
    const loaded = useLoader(() => remote.renderOutputText({ sessionId, text: rawText, messageId: props.messageId }), [sessionId, rawText, props.messageId], Boolean(rawText) && !streaming);
    const [display, setDisplay] = useState(null);
    const rendered = { state: useMemo(() => display?.base === loaded.state ? { status: 'ready', value: display.value } : loaded.state, [display, loaded.state]) };
    const displayGuards = useRef(new Set());
    const renderLatest = useRef(rendered.state);
    renderLatest.current = rendered.state;
    useEffect(() => {
        if (props.messageId === undefined || streaming)
            return;
        let alive = true;
        const readyTasks = new Set();
        const stop = registerHelperDisplay(sessionId, async (request, signal) => {
            const current = renderLatest.current;
            if (current.status !== 'ready')
                throw new HelperDisplayError('stale');
            // 旧气泡的显示快照可以落后于新消息；仅冻结剧情归属，目标下标和修订必须以当前宿主快照为准。
            if (current.value.helper && current.value.helper.storyId !== request.storyId)
                throw new HelperDisplayError('stale');
            const response = await waitHelperDisplay(remote.getHelperSnapshot({ sessionId, messageId: props.messageId }), signal);
            if (!response.ok)
                throw new Error(response.error.message);
            const snapshot = response.value;
            if (snapshot.storyId !== request.storyId || snapshot.historyRevision !== request.historyRevision)
                throw new HelperDisplayError('stale');
            if (request.ids !== null && !request.ids.includes(snapshot.currentMessageId))
                return null;
            const leases = [];
            try {
                const results = await Promise.allSettled([...displayGuards.current].map(guard => guard(request)));
                for (const result of results)
                    if (result.status === 'fulfilled')
                        leases.push(result.value);
                const failed = results.find(result => result.status === 'rejected');
                if (failed?.status === 'rejected')
                    throw failed.reason;
                const next = await waitHelperDisplay(remote.renderOutputText({ sessionId, text: rawText, messageId: props.messageId }), signal);
                if (!next.ok)
                    throw new Error(next.error.message);
                const verified = next.value.helper ? { ok: true, value: next.value.helper } : await waitHelperDisplay(remote.getHelperSnapshot({ sessionId, messageId: props.messageId }), signal);
                if (!verified.ok || verified.value.storyId !== request.storyId || verified.value.historyRevision !== request.historyRevision)
                    throw new HelperDisplayError('stale');
                const check = () => { if (!alive || renderLatest.current !== current)
                    throw new HelperDisplayError('stale'); for (const lease of leases)
                    lease.check(); };
                check();
                let timer, resolve, reject;
                const ready = new Promise((yes, no) => { resolve = yes; reject = no; });
                void ready.catch(() => { });
                const cancelReady = () => completion.reject(new HelperDisplayError('stale'));
                const completion = { resolve: () => { clearTimeout(timer); readyTasks.delete(cancelReady); resolve(); }, reject: (error) => { clearTimeout(timer); readyTasks.delete(cancelReady); reject(error); } };
                return { check, after: () => ready, current: () => alive && renderLatest.current.status === 'ready' && renderLatest.current.value === next.value,
                    cancel: () => { completion.reject(new HelperDisplayError('stale')); for (const lease of leases)
                        lease.cancel(); }, commit: () => {
                        check();
                        for (const cancel of readyTasks)
                            cancel();
                        readyTasks.clear();
                        readyTasks.add(cancelReady);
                        timer = setTimeout(() => completion.reject(new HelperDisplayError('timeout')), 60000);
                        setDisplay(previous => ({ base: loaded.state, value: next.value, revision: (previous?.revision ?? 0) + 1, completion }));
                    } };
            }
            catch (error) {
                for (const lease of leases)
                    lease.cancel();
                throw error;
            }
        });
        return () => { alive = false; for (const cancel of readyTasks)
            cancel(); readyTasks.clear(); stop(); };
    }, [sessionId, props.messageId, rawText, streaming, loaded.state]);
    const avatarUrl = avatar.state.status === 'ready' ? avatar.state.value.dataUrl : null;
    // 交互卡渲染决策：会话绑定有值时优先于全局设置（renderOutputText 回包的
    // interactiveCards 即全局值）。HTML 抽取在服务端按全局开关做，会话关 → 不渲染
    // 封面 iframe；正文若已随抽取变空，回退原始文本，对齐全局关闭的「纯文本显示」。
    const interactive = props.interactiveCards ?? (rendered.state.status === 'ready' ? rendered.state.value.interactiveCards : true);
    const htmls = !streaming && interactive && rendered.state.status === 'ready'
        ? rendered.state.value.htmls && rendered.state.value.htmls.length > 0
            ? rendered.state.value.htmls
            : rendered.state.value.html
                ? [rendered.state.value.html]
                : []
        : [];
    const text = !streaming && rendered.state.status === 'ready'
        ? interactive || rendered.state.value.text || rendered.state.value.parts !== undefined
            ? rendered.state.value.text
            : stripDisplayMeta(rawText)
        : stripDisplayMeta(rawText);
    const whitelist = rendered.state.status === 'ready' ? rendered.state.value.whitelist : [];
    const greetings = rendered.state.status === 'ready' ? rendered.state.value.greetings ?? [] : [];
    const greetingIndex = rendered.state.status === 'ready' ? rendered.state.value.greetingIndex ?? 0 : 0;
    const canSwipe = rendered.state.status === 'ready' ? rendered.state.value.canSwipeGreeting !== false : false;
    const toast = useToast();
    const swipeBusy = useRef(false);
    const [swipeError, setSwipeError] = useState(null);
    const swipeGreeting = async (index) => {
        if (swipeBusy.current)
            return;
        if (!canSwipe) {
            setSwipeError(t('speech.swipeStarted'));
            return;
        }
        if (!onSwipeGreeting) {
            setSwipeError(t('speech.navigationUnavailable'));
            return;
        }
        swipeBusy.current = true;
        setSwipeError(null);
        try {
            await onSwipeGreeting(index);
        }
        catch (cause) {
            setSwipeError(cause instanceof Error ? cause.message : String(cause));
        }
        finally {
            swipeBusy.current = false;
        }
    };
    /** 复制纯文本：优先 navigator.clipboard，沙盒/权限被拒时回退 execCommand。 */
    const onCopy = async () => {
        const plain = text || stripDisplayMeta(rawText);
        const fallback = () => {
            try {
                const ta = document.createElement('textarea');
                ta.value = plain;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                const ok = document.execCommand('copy');
                ta.remove();
                toast.show(ok ? t('speech.copied') : t('speech.copyFailed'));
            }
            catch {
                toast.show(t('speech.copyFailed'));
            }
        };
        try {
            await navigator.clipboard.writeText(plain);
            toast.show(t('speech.copied'));
        }
        catch {
            fallback();
        }
    };
    const storedParts = !streaming && rendered.state.status === 'ready' ? rendered.state.value.parts : undefined;
    const visibleParts = storedParts
        ? storedParts.filter(part => interactive || part.kind === 'markdown')
        : [...htmls.map(html => ({ kind: 'html', text: html })), ...(text ? [{ kind: 'markdown', text }] : [])];
    if (!visibleParts.length)
        visibleParts.push({ kind: 'markdown', text: text || ' ' });
    const cycleRef = useRef(null);
    if (cycleRef.current?.state !== rendered.state)
        cycleRef.current = { state: rendered.state, seen: new Set(), done: false, active: true };
    const cycle = cycleRef.current, htmlCount = visibleParts.filter(part => part.kind === 'html').length;
    const [lifecycleError, setLifecycleError] = useState(null);
    const completeDisplay = () => {
        if (cycleRef.current !== cycle || cycle.done || cycle.seen.size < htmlCount || streaming || rendered.state.status !== 'ready')
            return;
        cycle.done = true;
        const current = () => cycle.active && cycleRef.current === cycle && renderLatest.current === cycle.state;
        const completion = display?.base === loaded.state ? display.completion : undefined;
        void (async () => {
            if (props.messageId === undefined || !hasHelperEventAudience(sessionId))
                return;
            const response = rendered.state.status === 'ready' && rendered.state.value.helper ? { ok: true, value: rendered.state.value.helper } : await waitHelperDisplay(remote.getHelperSnapshot({ sessionId, messageId: props.messageId }), AbortSignal.timeout(5000));
            if (!response.ok)
                throw new Error(response.error.message);
            if (!current())
                throw new HelperDisplayError('stale');
            const snapshot = response.value, message = snapshot.messages[snapshot.currentMessageId];
            if (!message)
                throw new HelperDisplayError('stale');
            await emitHelperHostEvent(sessionId, snapshot.storyId, message.role === 'user' ? 'user_message_rendered' : 'character_message_rendered', message.role === 'user' ? [snapshot.currentMessageId] : [snapshot.currentMessageId, 'normal'], current);
        })().then(() => completion?.resolve()).catch(error => { completion?.reject(error); if (current())
            setLifecycleError({ cycle, message: displayFailure(error, t) }); });
    };
    useEffect(() => { if (!htmlCount)
        completeDisplay(); }, [rendered.state, htmlCount, streaming]);
    useEffect(() => { cycle.active = true; return () => { cycle.active = false; }; }, [cycle]);
    const content = visibleParts.map((part, i) => {
        if (part.kind === 'markdown')
            return _jsx(MarkdownText, { text: part.text, streaming: Boolean(streaming), labels: markdownLabels }, `text:${i}`);
        const srcDoc = buildCardSrcDoc(part.text, { greetings, greetingIndex, connectHosts: whitelist,
            helperSnapshot: rendered.state.status === 'ready' ? rendered.state.value.helper : undefined,
            scriptLibraries: rendered.state.status === 'ready' ? rendered.state.value.helperScripts : undefined,
            worldbooks: rendered.state.status === 'ready' ? rendered.state.value.helperWorldbooks : undefined,
            scriptLibraryLabels: { saving: t('speech.scriptSaving'), saved: t('speech.scriptSaved'), failed: t('speech.scriptSaveFailed') },
            persistenceLabels: { saving: t('speech.helperSaving'), saved: t('speech.helperSaved'), failed: t('speech.helperSaveFailed'), refresh: t('speech.helperRefresh') },
            helperContext: { message: rawText, messageId: canSwipe ? 0 : props.messageId ?? 0, name,
                userName: rendered.state.status === 'ready' ? rendered.state.value.userName : undefined,
                frameIndex: i, canSwipe: canSwipe && Boolean(onSwipeGreeting) },
            helperLabels: { diagnostics: t('speech.helperMessages'), unsupported: t('speech.helperUnsupported') },
            variableStyles: CARD_VARIABLE_STYLES,
            variableLabels: cardVariableLabels(t, rendered.state.status === 'ready' && rendered.state.value.helper ? t('speech.helperDataNote') : t('speech.cardDataNote')),
        });
        const widget = visibleParts.length > 1;
        const frame = (_jsx(SpeechHtmlFrame, { onFrameReady: () => { if (cycleRef.current === cycle) {
                cycle.seen.add(i);
                completeDisplay();
            } }, registerDisplayGuard: guard => { displayGuards.current.add(guard); return () => { displayGuards.current.delete(guard); }; }, srcDoc: srcDoc, title: part.title || name, widget: widget, compact: Boolean(storedParts), helperBinding: rendered.state.status === 'ready' && rendered.state.value.helper ? { sessionId, storyId: rendered.state.value.helper.storyId } : undefined, onSwipeGreeting: (index) => void swipeGreeting(index), onMessageBranch: props.onMessageBranch, onMessageEdit: props.messageId === undefined ? undefined : async (request) => { const result = await remote.editHelperMessages({ ...request, sessionId: props.sessionId, messageId: props.messageId }); if (!result.ok)
                throw new Error(result.error.message); if (result.value.snapshot)
                notifyHelperStory(props.sessionId, result.value.snapshot.storyId); return result.value; }, onWorldbookBind: props.messageId === undefined ? undefined : async (request) => { const result = await remote.rebindHelperWorldbooks({ ...request, sessionId: props.sessionId, messageId: props.messageId }); if (!result.ok)
                throw new Error(result.error.message); invalidateSessionBinding(props.sessionId); window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: props.sessionId })); return result.value; }, onWorldbookRequest: props.messageId === undefined ? undefined : async (request) => { const result = await remote.helperWorldbookOperation({ ...request, sessionId: props.sessionId, messageId: props.messageId }); if (!result.ok)
                throw new Error(result.error.message); return result.value; }, onWorldbookRefresh: props.messageId === undefined ? undefined : async () => { const helper = rendered.state.status === 'ready' ? rendered.state.value.helper : undefined; if (!helper)
                throw new Error(t('speech.helperUnsupported')); const result = await remote.getHelperWorldbookContext({ sessionId: props.sessionId, storyId: helper.storyId }); if (!result.ok)
                throw new Error(result.error.message); return result.value; }, onScriptCommit: props.messageId === undefined ? undefined : async (request) => { const result = await remote.commitSessionHelperScripts({ ...request, sessionId: props.sessionId }); if (!result.ok)
                throw new Error(result.error.message); return result.value; }, onScriptRefresh: props.messageId === undefined ? undefined : async () => { const helper = rendered.state.status === 'ready' ? rendered.state.value.helper : undefined; if (!helper)
                throw new Error(t('speech.helperUnsupported')); const result = await remote.getSessionHelperScripts({ sessionId: props.sessionId, storyId: helper.storyId }); if (!result.ok)
                throw new Error(result.error.message); return result.value; }, onHelperCommit: props.messageId === undefined ? undefined : async (request) => {
                const result = await remote.commitHelperVariables({ ...request, sessionId, messageId: props.messageId });
                if (!result.ok)
                    throw new Error(result.error.message);
                notifyHelperStory(sessionId, result.value.storyId);
                return result.value;
            }, onHelperRefresh: props.messageId === undefined ? undefined : async () => {
                const result = await remote.getHelperSnapshot({ sessionId, messageId: props.messageId });
                if (!result.ok)
                    throw new Error(result.error.message);
                return result.value;
            } }, `${i}:${part.text.length}:${display?.base === loaded.state ? display.revision : 0}`));
        return part.title ? _jsxs("details", { className: "dsh-tavern-reason", children: [_jsx("summary", { children: part.title }), frame] }, `fold:${i}`) : frame;
    });
    return (_jsxs("div", { className: "dsh-tavern-speech dsh-tavern-rise", children: [_jsx(Avatar, { url: avatarUrl, name: name, size: 40, className: "dsh-tavern-speechAvatar" }), _jsxs("div", { className: "dsh-tavern-speechBody", children: [_jsx("div", { className: "dsh-tavern-speechName", children: name }), _jsx(Err, { message: swipeError }), _jsx(Err, { message: lifecycleError?.cycle === cycle ? lifecycleError.message : null }), _jsx(Err, { message: rendered.state.status === 'error' ? rendered.state.message : null }), content, !streaming && rendered.state.status === 'ready' && rendered.state.value.helper && _jsx(ScriptChoices, { sessionId: sessionId, context: rendered.state.value.helper })] }), _jsx("div", { className: "dsh-tavern-speechCopy", children: _jsx(IconBtn, { label: t('speech.copy'), onClick: () => void onCopy(), children: _jsx(IconCopyOutline16, {}) }) }), toast.node] }));
}
