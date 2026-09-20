import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** 会话级隐藏后台脚本容器：管理入口统一放在设置；解绑或切换会话时卸载各自的 opaque-origin iframe。 */
import { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { buildCardSrcDoc } from '../core/cardFrame.js';
import { helperScriptHtml, isNativeMvuFramework } from '../core/cardScript.js';
import { publishScriptStatus, clearScriptStatus } from './helperScriptStatus.js';
import { enabledHelperScripts, enabledHelperLibraries } from '../core/helperScripts.js';
import { HelperMvuRunner } from './helperMvuRunner.js';
import { openChildSession } from './openChild.js';
import { SpeechHtmlFrame } from './speech.js';
import { CHARACTER_CHANGED_EVENT, invalidateSessionBinding } from './cache.js';
import { BINDING_CHANGED_EVENT } from './actions.js';
import { watchHelperScripts, watchHelperScriptAssets } from './helperScriptNotifications.js';
import { notifyHelperStory, watchHelperStory } from './helperNotifications.js';
import { useT } from './i18n.js';
import { cardVariableLabels } from './cardVariableLabels.js';
import { useLoader } from './util.js';
import { CARD_VARIABLE_STYLES } from './styles.js';
export function HelperScripts(props) {
    const { remote, sessionId } = props, t = useT();
    const loader = useLoader(() => remote.getHelperScriptBundle({ sessionId }), [sessionId], true);
    const bundle = loader.state.status === 'ready' ? loader.state.value : undefined;
    // RPC 每次成功载入的是一组新沙箱；内容修订相同也不代表旧运行时仍在。
    const runtimeVersion = useMemo(() => crypto.randomUUID(), [bundle]);
    const currentRuntime = useRef(runtimeVersion);
    currentRuntime.current = runtimeVersion;
    const [ready, setReady] = useState({});
    const [failures, setFailures] = useState({});
    const owner = useRef(Symbol('script-runtime'));
    const [mvuState, setMvu] = useState({ version: runtimeVersion, error: null, busy: false });
    const mvu = mvuState.version === runtimeVersion ? mvuState : { error: null, busy: false };
    const retryMvu = useRef({ version: '', run: () => { } });
    const mvuStatus = useCallback((value) => { if (currentRuntime.current !== runtimeVersion)
        return; retryMvu.current = { version: runtimeVersion, run: value.retry }; setMvu(current => current.version === runtimeVersion && current.error === value.error && current.busy === value.busy ? current : { version: runtimeVersion, error: value.error, busy: value.busy }); }, [runtimeVersion]);
    useEffect(() => {
        if (bundle)
            return;
        // 重读期间 iframe 与 MVU 执行器已卸载；即使资产修订不变，也不能沿用旧运行时的就绪或故障。
        setReady({});
        setFailures({});
        retryMvu.current = { version: '', run: () => { } };
    }, [bundle]);
    useEffect(() => bundle ? watchHelperScripts(sessionId, bundle.storyId, () => loader.reload()) : undefined, [sessionId, bundle?.storyId, loader.reload]);
    const watchedCardId = props.cardId ?? bundle?.cardId;
    useEffect(() => {
        if (!watchedCardId)
            return;
        // HeaderChip 传入绑定中的稳定 cardId；重拉期间 bundle 暂时为空也不能漏掉连续保存事件。
        const changed = (event) => { if (event.detail === watchedCardId)
            loader.reload(); };
        window.addEventListener(CHARACTER_CHANGED_EVENT, changed);
        return () => window.removeEventListener(CHARACTER_CHANGED_EVENT, changed);
    }, [watchedCardId, loader.reload]);
    const libraries = bundle ? (bundle.libraries ?? [{ target: { type: 'character', cardId: bundle.cardId }, revision: bundle.revision, trees: bundle.trees }]) : [];
    let scripts = [], scriptError = null;
    try {
        scripts = enabledHelperLibraries(libraries);
    }
    catch (error) {
        scriptError = error instanceof Error ? error.message : String(error);
    }
    const waitingForMessage = Boolean(bundle?.enabled && bundle.messageId === null && !bundle.snapshot && !bundle.runtimeError && !scriptError && (scripts.length > 0 || bundle.helperMvu) && scripts.length <= 32);
    useEffect(() => {
        if (!waitingForMessage || !bundle)
            return;
        // 首条消息出现后启动等待中的脚本；已运行的沙箱自行刷新数据，不因普通剧情通知重启。
        let requested = false;
        const stop = watchHelperStory(sessionId, bundle.storyId, () => { if (!requested) {
            requested = true;
            loader.reload();
        } });
        const timer = setInterval(() => loader.reload(), 1000);
        return () => { stop(); clearInterval(timer); };
    }, [sessionId, bundle?.storyId, waitingForMessage, loader.reload]);
    const scriptVersion = JSON.stringify(libraries.map(library => [library.target, library.revision]));
    useEffect(() => watchHelperScriptAssets(target => { if (libraries.some(library => JSON.stringify(library.target) === JSON.stringify(target)))
        loader.reload(); }), [loader.reload, scriptVersion, bundle?.cardId]);
    const allReady = !scriptError && !bundle?.runtimeError && scripts.length <= 32 && scripts.every(script => ready[script.id] === runtimeVersion && failures[script.id]?.version !== runtimeVersion);
    // 超预算时一个脚本都不会挂载：状态必须显式报错，否则谎报 running 且 MVU 永远「等待脚本就绪」。
    const scriptsBudget = bundle?.enabled === true && scripts.length > 32;
    const status = { sessionId, cardId: bundle?.cardId ?? '', nativeMvu: bundle?.helperMvu === true, mvuBusy: mvu.busy, mvuError: mvu.error ?? undefined,
        state: loader.state.status === 'error' || scriptError || bundle?.runtimeError || mvu.error || scriptsBudget || scripts.some(script => failures[script.id]?.version === runtimeVersion) ? 'error' : !bundle ? 'loading' : !bundle.enabled ? 'disabled' : waitingForMessage ? 'waiting' : 'running',
        error: loader.state.status === 'error' ? loader.state.message : scriptError ?? bundle?.runtimeError ?? (scriptsBudget ? t('speech.scriptsBudget') : undefined),
        scripts: scripts.map(script => ({ id: script.id, name: script.name || script.id, native: isNativeMvuFramework(script.content), state: failures[script.id]?.version === runtimeVersion ? 'error' : ready[script.id] === runtimeVersion ? 'ready' : 'loading', error: failures[script.id]?.version === runtimeVersion ? failures[script.id]?.error : undefined })) };
    const statusKey = JSON.stringify(status);
    useEffect(() => { publishScriptStatus(owner.current, status, () => { if (retryMvu.current.version === currentRuntime.current)
        retryMvu.current.run(); }); }, [statusKey]);
    useEffect(() => () => clearScriptStatus(owner.current, sessionId), [sessionId]);
    return _jsxs("span", { className: "dsh-tavern-scriptHost", hidden: true, children: [bundle?.enabled && bundle.helperMvu && bundle.snapshot && _jsx(HelperMvuRunner, { remote: remote, sessionId: sessionId, storyId: bundle.storyId, snapshot: bundle.snapshot, ready: allReady, onStatus: mvuStatus, onCancel: props.onCancel }, runtimeVersion), _jsx("div", { children: bundle?.enabled && !bundle.runtimeError && !scriptError && bundle.snapshot && bundle.messageId !== null && scripts.length <= 32 && scripts.map(script => {
                    const snapshot = bundle.snapshot, messageId = bundle.messageId;
                    const assistantName = bundle.name ?? snapshot.messages.find(message => message.role === 'assistant')?.name ?? '';
                    const userName = bundle.userName ?? snapshot.messages.find(message => message.role === 'user')?.name ?? '';
                    const srcDoc = buildCardSrcDoc(helperScriptHtml(script.content), { greetings: [], greetingIndex: 0, helperSnapshot: snapshot,
                        worldbooks: bundle.worldbooks, scriptLibraries: bundle.scriptContext, scriptLibraryLabels: { saving: t('speech.scriptSaving'), saved: t('speech.scriptSaved'), failed: t('speech.scriptSaveFailed') },
                        scriptContext: { script, trees: bundle.trees, libraryType: libraries.find(library => enabledHelperScripts(library.trees).some(item => item.id === script.id))?.target.type, libraries: libraries.map(library => ({ type: library.target.type, trees: library.trees })) }, helperContext: { canSwipe: false, scriptFrame: true, name: assistantName, macroName: bundle.characterName ?? assistantName, userName }, connectHosts: bundle.whitelist, variableStyles: CARD_VARIABLE_STYLES,
                        persistenceLabels: { saving: t('speech.helperSaving'), saved: t('speech.helperSaved'), failed: t('speech.helperSaveFailed'), refresh: t('speech.helperRefresh') },
                        helperLabels: { diagnostics: t('speech.helperMessages'), unsupported: t('speech.helperUnsupported') },
                        variableLabels: cardVariableLabels(t, t('speech.helperDataNote')) });
                    return _jsx("section", { children: _jsx(SpeechHtmlFrame, { srcDoc: srcDoc, title: script.name || script.id, widget: true, compact: true, onScriptError: error => { if (currentRuntime.current === runtimeVersion)
                                setFailures(current => ({ ...current, [script.id]: { version: runtimeVersion, error } })); }, onScriptReady: value => { if (currentRuntime.current === runtimeVersion)
                                setReady(current => current[script.id] === (value ? runtimeVersion : '') ? current : { ...current, [script.id]: value ? runtimeVersion : '' }); }, helperBinding: { sessionId, storyId: snapshot.storyId }, onMessageBranch: props.sessions ? async (branch) => { await openChildSession(props.sessions, branch.childSessionId, branch.title, props.sessionId); } : undefined, onMessageEdit: async (request) => { const result = await remote.editHelperMessages({ ...request, sessionId, messageId }); if (!result.ok)
                                throw new Error(result.error.message); if (result.value.snapshot)
                                notifyHelperStory(sessionId, result.value.snapshot.storyId); return result.value; }, onWorldbookBind: async (request) => { const result = await remote.rebindHelperWorldbooks({ ...request, sessionId, messageId }); if (!result.ok)
                                throw new Error(result.error.message); invalidateSessionBinding(sessionId); window.dispatchEvent(new CustomEvent(BINDING_CHANGED_EVENT, { detail: sessionId })); return result.value; }, onWorldbookRequest: async (request) => { const result = await remote.helperWorldbookOperation({ ...request, sessionId, messageId }); if (!result.ok)
                                throw new Error(result.error.message); return result.value; }, onWorldbookRefresh: async () => { const result = await remote.getHelperWorldbookContext({ sessionId, storyId: snapshot.storyId }); if (!result.ok)
                                throw new Error(result.error.message); return result.value; }, onScriptCommit: async (request) => { const result = await remote.commitSessionHelperScripts({ ...request, sessionId }); if (!result.ok)
                                throw new Error(result.error.message); return result.value; }, onScriptRefresh: async () => { const result = await remote.getSessionHelperScripts({ sessionId, storyId: snapshot.storyId }); if (!result.ok)
                                throw new Error(result.error.message); return result.value; }, onHelperCommit: async (request) => { const result = await remote.commitHelperVariables({ ...request, sessionId, messageId }); if (!result.ok)
                                throw new Error(result.error.message); notifyHelperStory(sessionId, result.value.storyId); return result.value; }, onHelperRefresh: async () => { const result = await remote.getHelperSnapshot({ sessionId, messageId }); if (!result.ok)
                                throw new Error(result.error.message); return result.value; } }) }, runtimeVersion + script.id);
                }) })] });
}
