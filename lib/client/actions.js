import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * assistant 消息操作条（slot conversation.chat.assistant-actions，session 作用域）。
 *
 * 视觉对齐 dsh 原生 IconActions（28px 图标钮 + Tooltip）。
 * 整组用 margin-left:auto 靠右，开场白 swipe 与分支兄弟导航（‹ n/m ›）在这一侧。
 * 行为：
 * - 仅在 Tavern 模式且已绑定角色卡时渲染（普通 dsh 会话不出现任何 Tavern 按钮）；
 * - 开场白楼层只给 swipe（对话开始后连 swipe 也收起），不提供重新生成/编辑；
 * - 非开场白楼层若同层有分支（regenerate/编辑/回退 fork 出的兄弟会话），
 *   显示 ‹ n/m › 兄弟导航，点击经 openChildSession 跳转对应分支会话；
 * - 重新生成/回退/编辑均按「这一层」生效（slot owner 提供 messageId，host 端据此定位楼层）；
 *   成功后自动 sessions.open(分支子会话) 并把 host 给的分支标题 rename 进会话列表；
 * - 续写（continue）不 fork：host 校验只能续最后一层，续跑流式在当前会话原生可见；
 * - 代答（impersonate）生成用户台词并复制到剪贴板；剪贴板不可用时展示文本供手动复制；
 * - 被中断楼层若尚未进入宿主 turn-tail 的持久消息操作栏，才由 chat.node 补挂
 *   TavernInterruptedFloorActions（重新生成/回退/兄弟导航，按 turn 号定位）。
 */
import { describeError } from '../core/guards.js';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { IconBranchOutlineMedium, IconChevronLeftOutlineMedium, IconChevronRightOutlineMedium, IconEditOutlineMedium, IconListPenOutlineMedium, IconLoadingOutlineMedium, IconPlayOutlineMedium, IconRefreshOutlineMedium, IconUserOutlineMedium, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { cachedSessionBinding } from './cache.js';
import { useDraftGuard } from './drafts.js';
import { floorActionStateBatched } from './floorActionBatch.js';
import { resolveSessionInput } from './helperChoices.js';
import { useT } from './i18n.js';
import { isTavernSession } from './mode.js';
import { openChildSession } from './openChild.js';
import { remoteIdentity } from './remoteIdentity.js';
import { subscribeKeyedWindowEvent } from './windowEvents.js';
import { Badge, Btn, Dialog, Err, SaveBar, useLoader, useToast } from './util.js';
import './styles.js';
function IconAction(props) {
    return (_jsx(Tooltip, { label: props.label, side: "bottom", children: _jsx("button", { type: "button", "aria-label": props.label, className: "dsh-tavern-action", disabled: props.disabled, onClick: props.onClick, children: props.busy ? (_jsx("span", { className: "dsh-tavern-spin", children: _jsx(IconLoadingOutlineMedium, {}) })) : (props.children) }) }));
}
/** 即使分支列表刷新早已开始，上下文卸载后也不能再执行迟到导航；宿主方法保持原接收者。 */
function guardedSessions(sessions, active) {
    return {
        open: id => { if (active.current)
            sessions.open(id); },
        refresh: sessions.refresh ? () => sessions.refresh() : undefined,
        scope: sessions.scope ? id => sessions.scope(id) : undefined,
        sessionOf: sessions.sessionOf ? scope => sessions.sessionOf(scope) : undefined,
    };
}
function useActionLifetime() {
    const active = useRef(true);
    // 在提交阶段撤销；不能让回包微任务抢在被延迟的普通 effect 清理前执行导航或剪贴板写入。
    useLayoutEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    return active;
}
/** 绑定变更广播（chip 保存绑定后 dispatch，操作条据此显隐）。 */
export const BINDING_CHANGED_EVENT = 'dsh-tavern:binding-changed';
/** 分支变更广播（fork 操作成功后以源会话 id dispatch，兄弟导航据此重拉）。 */
export const BRANCH_CHANGED_EVENT = 'dsh-tavern:branch-changed';
/** 最新可续写楼层变更广播（同一会话挂载新楼层并拿到服务端 canContinue=true 时通知旧楼层收起续写钮）。 */
const CONTINUABLE_CHANGED_EVENT = 'dsh-tavern:continuable-changed';
const latestContinuableByRemote = new WeakMap();
function recordContinuableFloor(remote, sessionId, messageId) {
    let bySession = latestContinuableByRemote.get(remote);
    if (!bySession) {
        bySession = new Map();
        latestContinuableByRemote.set(remote, bySession);
    }
    if (bySession.get(sessionId) === messageId)
        return;
    bySession.set(sessionId, messageId);
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent(CONTINUABLE_CHANGED_EVENT, { detail: sessionId }));
    }
}
function getRecordedContinuableFloor(remote, sessionId) {
    return latestContinuableByRemote.get(remote)?.get(sessionId);
}
const subscribeSessionWindowEvent = subscribeKeyedWindowEvent;
/** 查询会话是否已绑定角色卡；null = 尚未加载完成（先不渲染，避免闪烁）。非 Tavern 不打 remote。绑定读进程内缓存：每条 assistant 消息的操作条共享一次 RPC。 */
function useTavernBound(remote, sessionId, enabled) {
    const [bound, setBound] = useState(null);
    useEffect(() => {
        if (!enabled) {
            setBound({ remote, sessionId, enabled, value: false });
            return;
        }
        let alive = true;
        let request = 0;
        const load = () => {
            // 失效缓存只保护缓存回填；仍持有旧 Promise 的组件也必须拒绝过时回包。
            const current = ++request;
            return cachedSessionBinding(remote, sessionId)
                .then((r) => {
                if (alive && current === request)
                    setBound({ remote, sessionId, enabled, value: r.ok ? r.value.binding !== null : null });
            })
                .catch(() => {
                if (alive && current === request)
                    setBound({ remote, sessionId, enabled, value: null });
            });
        };
        void load();
        const unsubscribe = subscribeSessionWindowEvent(BINDING_CHANGED_EVENT, sessionId, true, () => { void load(); });
        return () => {
            alive = false;
            unsubscribe();
        };
    }, [remote, sessionId, enabled]);
    // 会话/remote 切换的本次渲染就关掉旧权限，不能等 effect 或新读取完成才收起操作条。
    return !enabled ? false : bound?.remote === remote && bound.sessionId === sessionId && bound.enabled === enabled ? bound.value : null;
}
export function TavernFloorActions(props) {
    return _jsx(FloorActions, { ...props }, JSON.stringify([remoteIdentity(props.remote), props.sessionId, props.messageId]));
}
function FloorActions(props) {
    const { remote, sessionId, sessions, messageId } = props;
    const active = useActionLifetime();
    const navigation = guardedSessions(sessions, active);
    const t = useT();
    const tavern = isTavernSession(props.useSessions, sessionId);
    const bound = useTavernBound(remote, sessionId, tavern);
    const [operation, setOperation] = useState(null);
    const [failure, setFailure] = useState(null);
    const [editFailure, setEditFailure] = useState(null);
    const [edit, setEdit] = useState(null);
    const [editAiFailure, setEditAiFailure] = useState(null);
    const [editAi, setEditAi] = useState(null);
    // 同一次 React 提交前的连续点击也必须互斥，不能仅依赖按钮 disabled 的下一次渲染。
    const submitting = useRef(false);
    const editDirty = edit !== null && edit.text !== edit.original;
    const editAiDirty = editAi !== null && editAi.text !== editAi.original;
    const editGuard = useDraftGuard(editDirty, operation === 'submit-edit');
    const editAiGuard = useDraftGuard(editAiDirty, operation === 'submit-edit-ai');
    const closeEdit = () => { if (!submitting.current)
        editGuard.request(() => setEdit(null)); };
    const closeEditAi = () => { if (!submitting.current)
        editAiGuard.request(() => setEditAi(null)); };
    /** 剪贴板不可用时展示的代答结果（用户手动复制）。 */
    const [impersonated, setImpersonated] = useState(null);
    /** 记录本操作栏上一次写入宿主输入框的代答版本，连续点击代答时将上次结果当作换一版重抽而非扩写提示。 */
    const lastImpersonated = useRef(null);
    const [, setContinuableTick] = useState(0);
    const toast = useToast();
    const hasBatchStates = typeof remote.getFloorActionStates === 'function';
    const floorStateLoader = useLoader(() => floorActionStateBatched(remote, { sessionId, messageId: messageId }), [sessionId, messageId], bound === true && Boolean(messageId));
    useEffect(() => {
        if (bound !== true || !messageId)
            return;
        const offBinding = subscribeSessionWindowEvent(BINDING_CHANGED_EVENT, sessionId, false, () => floorStateLoader.reload());
        const offBranch = subscribeSessionWindowEvent(BRANCH_CHANGED_EVENT, sessionId, false, () => floorStateLoader.reload());
        const offContinuable = subscribeSessionWindowEvent(CONTINUABLE_CHANGED_EVENT, sessionId, false, () => setContinuableTick((n) => n + 1));
        return () => {
            offBinding();
            offBranch();
            offContinuable();
        };
        // reload 随 loader render 更新；事件回调只需跟会话、消息和启用状态重挂。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bound, messageId, sessionId]);
    const floorState = floorStateLoader.state.status === 'ready' ? floorStateLoader.state.value : null;
    useEffect(() => {
        if (hasBatchStates && messageId && floorState?.canContinue) {
            recordContinuableFloor(remote, sessionId, messageId);
        }
    }, [hasBatchStates, remote, sessionId, messageId, floorState?.canContinue]);
    const greetState = floorState?.greeting ?? null;
    const swipe = greetState?.swipe ?? null;
    const isGreeting = greetState?.isGreeting === true;
    const started = greetState?.started === true;
    const siblingSwipe = floorState?.siblings.swipe ?? null;
    const recordedContinuable = hasBatchStates ? getRecordedContinuableFloor(remote, sessionId) : undefined;
    const canContinue = floorState === null
        ? true
        : floorState.canContinue && (!recordedContinuable || recordedContinuable === messageId);
    /** 跑一个产生分支会话的操作；成功后直接跳转到分支（续跑过程在分支里原生流式可见），并写入分支标题。 */
    const run = async (kind, op) => {
        if (!active.current || submitting.current)
            return;
        submitting.current = true;
        setOperation(kind);
        setFailure(null);
        try {
            const r = await op();
            if (!active.current)
                return;
            if (r.ok) {
                // 源会话的兄弟导航（若仍挂载）据此重拉索引
                window.dispatchEvent(new CustomEvent(BRANCH_CHANGED_EVENT, { detail: sessionId }));
                await openChildSession(navigation, r.value.childSessionId, r.value.title, sessionId);
            }
            else
                setFailure(r.error.message);
        }
        catch (e) {
            setFailure(describeError(e));
        }
        finally {
            submitting.current = false;
            setOperation(null);
        }
    };
    if (!tavern || bound !== true || !messageId)
        return null;
    const busy = operation !== null;
    const onRegenerate = () => void run('regenerate', () => remote.regenerate({ sessionId, messageId }));
    const onRollback = () => void run('rollback', () => remote.rollbackToFloor({ sessionId, messageId }));
    const onSwipe = (delta) => {
        if (!swipe || busy)
            return;
        const next = ((swipe.index + delta) % swipe.total + swipe.total) % swipe.total;
        void run(delta < 0 ? 'swipe-prev' : 'swipe-next', () => remote.swipeGreeting({ sessionId, index: next }));
    };
    /** 兄弟分支切换：跳转打开同一楼层另一版回复所在的会话（复用 fork 的 refresh+open 路径）。 */
    const onBranch = (delta) => {
        const nav = siblingSwipe;
        if (!active.current || !nav || nav.total < 2 || busy || submitting.current)
            return;
        const target = nav.siblings[(nav.index + delta + nav.total) % nav.total];
        if (!target || target === sessionId)
            return;
        submitting.current = true;
        setOperation(delta < 0 ? 'branch-prev' : 'branch-next');
        void openChildSession(navigation, target, undefined, sessionId)
            .catch(() => {
            toast.show(t('actions.branchGone'));
            floorStateLoader.reload();
        })
            .finally(() => { submitting.current = false; setOperation(null); });
    };
    const onEdit = async () => {
        if (!active.current || submitting.current)
            return;
        submitting.current = true;
        setOperation('load-edit');
        setFailure(null);
        setEditFailure(null);
        try {
            const r = await remote.getFloorUserMessage({ sessionId, messageId });
            if (!active.current)
                return;
            if (r.ok)
                setEdit({ turn: r.value.turn, text: r.value.text, original: r.value.text });
            else
                setFailure(r.error.message);
        }
        catch (e) {
            setFailure(describeError(e));
        }
        finally {
            submitting.current = false;
            setOperation(null);
        }
    };
    const submitEdit = async () => {
        const draft = edit;
        if (!active.current || !draft || !editDirty || !draft.text.trim() || submitting.current)
            return;
        submitting.current = true;
        setOperation('submit-edit');
        setEditFailure(null);
        try {
            const r = await remote.editUserMessage({ sessionId, messageId, text: draft.text });
            if (!active.current)
                return;
            if (r.ok) {
                setEdit(null);
                window.dispatchEvent(new CustomEvent(BRANCH_CHANGED_EVENT, { detail: sessionId }));
                await openChildSession(navigation, r.value.childSessionId, r.value.title, sessionId);
            }
            else {
                setEditFailure(r.error.message);
            }
        }
        catch (e) {
            setEditFailure(describeError(e));
        }
        finally {
            submitting.current = false;
            setOperation(null);
        }
    };
    /** 续写最后一层：不 fork，host 驱动画前会话，流式在当前会话出现。 */
    const onContinue = async () => {
        if (!active.current || submitting.current)
            return;
        submitting.current = true;
        setOperation('continue');
        setFailure(null);
        try {
            const r = await remote.continueFloor({ sessionId, messageId });
            if (!active.current)
                return;
            if (!r.ok)
                setFailure(r.error.message);
        }
        catch (e) {
            setFailure(describeError(e));
        }
        finally {
            submitting.current = false;
            setOperation(null);
        }
    };
    const onEditAi = async () => {
        if (!active.current || submitting.current)
            return;
        submitting.current = true;
        setOperation('load-edit-ai');
        setFailure(null);
        setEditAiFailure(null);
        try {
            const r = await remote.getFloorAssistantMessage({ sessionId, messageId });
            if (!active.current)
                return;
            if (r.ok)
                setEditAi({ turn: r.value.turn, text: r.value.text, original: r.value.text });
            else
                setFailure(r.error.message);
        }
        catch (e) {
            setFailure(describeError(e));
        }
        finally {
            submitting.current = false;
            setOperation(null);
        }
    };
    const submitEditAi = async () => {
        const draft = editAi;
        if (!active.current || !draft || !editAiDirty || !draft.text.trim() || submitting.current)
            return;
        submitting.current = true;
        setOperation('submit-edit-ai');
        setEditAiFailure(null);
        try {
            const r = await remote.editAssistantMessage({ sessionId, messageId, text: draft.text });
            if (!active.current)
                return;
            if (r.ok) {
                setEditAi(null);
                window.dispatchEvent(new CustomEvent(BRANCH_CHANGED_EVENT, { detail: sessionId }));
                await openChildSession(navigation, r.value.childSessionId, r.value.title, sessionId);
            }
            else {
                setEditAiFailure(r.error.message);
            }
        }
        catch (e) {
            setEditAiFailure(describeError(e));
        }
        finally {
            submitting.current = false;
            setOperation(null);
        }
    };
    /** AI 代答用户：优先填入宿主输入框（已有用户手写草稿时作为扩写提示）；等待期间若用户编辑了草稿或输入框不可用则回退剪贴板/弹窗。 */
    const onImpersonate = async () => {
        if (!active.current || submitting.current)
            return;
        submitting.current = true;
        setOperation('impersonate');
        setFailure(null);
        try {
            const initialInput = resolveSessionInput(sessionId);
            let before;
            try {
                before = initialInput?.state.getSnapshot();
            }
            catch {
                before = undefined;
            }
            const canUseInitialDraft = before !== undefined && before.phase === 'plain' && before.occurrences.length === 0;
            const isPreviousImpersonation = Boolean(before
                && lastImpersonated.current
                && lastImpersonated.current.draft === before.draft
                && lastImpersonated.current.revision === before.draftRev);
            const hint = before && canUseInitialDraft && !isPreviousImpersonation && before.draft.trim()
                ? before.draft.trim().slice(0, 2000)
                : undefined;
            const r = await remote.impersonate(hint ? { sessionId, hint } : { sessionId });
            if (!active.current)
                return;
            if (!r.ok) {
                setFailure(r.error.message);
                return;
            }
            let filled = false;
            const currentInput = resolveSessionInput(sessionId);
            if (currentInput) {
                try {
                    const after = currentInput.state.getSnapshot();
                    const untouchedDuringWait = !before
                        ? after.draft.trim() === ''
                        : (after.draft === before.draft && after.draftRev === before.draftRev) || after.draft.trim() === '';
                    if (after.phase === 'plain' && after.occurrences.length === 0 && untouchedDuringWait) {
                        currentInput.setDraft(r.value.text);
                        currentInput.focus?.();
                        const written = currentInput.state.getSnapshot();
                        lastImpersonated.current = { draft: written.draft, revision: written.draftRev };
                        filled = true;
                        if (active.current)
                            toast.show(t('actions.impersonateFilled'));
                    }
                }
                catch {
                    filled = false;
                }
            }
            if (!filled) {
                try {
                    await navigator.clipboard.writeText(r.value.text);
                    if (active.current)
                        toast.show(t('actions.impersonateCopied'));
                }
                catch {
                    if (active.current)
                        setImpersonated(r.value.text);
                }
            }
        }
        catch (e) {
            setFailure(describeError(e));
        }
        finally {
            submitting.current = false;
            setOperation(null);
        }
    };
    return (_jsxs("span", { className: "dsh-tavern-actionGroup", children: [!isGreeting && siblingSwipe && siblingSwipe.total > 1 && (_jsxs(_Fragment, { children: [_jsx(IconAction, { label: t('actions.branchPrev'), disabled: busy, busy: operation === 'branch-prev', onClick: () => onBranch(-1), children: _jsx(IconChevronLeftOutlineMedium, {}) }), _jsxs("span", { className: "dsh-tavern-swipeIdx", title: t('actions.branchCount', { turn: siblingSwipe.turn, total: siblingSwipe.total }), children: [siblingSwipe.index + 1, "/", siblingSwipe.total] }), _jsx(IconAction, { label: t('actions.branchNext'), disabled: busy, busy: operation === 'branch-next', onClick: () => onBranch(1), children: _jsx(IconChevronRightOutlineMedium, {}) }), _jsx("span", { className: "dsh-tavern-actionDivider" })] })), swipe && (_jsxs(_Fragment, { children: [_jsx(IconAction, { label: t('actions.swipePrev'), disabled: busy, busy: operation === 'swipe-prev', onClick: () => onSwipe(-1), children: _jsx(IconChevronLeftOutlineMedium, {}) }), _jsxs("span", { className: "dsh-tavern-swipeIdx", children: [swipe.index + 1, "/", swipe.total] }), _jsx(IconAction, { label: t('actions.swipeNext'), disabled: busy, busy: operation === 'swipe-next', onClick: () => onSwipe(1), children: _jsx(IconChevronRightOutlineMedium, {}) }), _jsx("span", { className: "dsh-tavern-actionDivider" })] })), !isGreeting && (_jsx(IconAction, { label: t('actions.regenerate'), disabled: busy, busy: operation === 'regenerate', onClick: onRegenerate, children: _jsx(IconRefreshOutlineMedium, {}) })), !isGreeting && canContinue && (_jsx(IconAction, { label: t('actions.continue'), disabled: busy, busy: operation === 'continue', onClick: () => void onContinue(), children: _jsx(IconPlayOutlineMedium, {}) })), !isGreeting && (_jsx(IconAction, { label: t('actions.editUser'), disabled: busy, busy: operation === 'load-edit', onClick: () => void onEdit(), children: _jsx(IconEditOutlineMedium, {}) })), !isGreeting && (_jsx(IconAction, { label: t('actions.editAi'), disabled: busy, busy: operation === 'load-edit-ai', onClick: () => void onEditAi(), children: _jsx(IconListPenOutlineMedium, {}) })), _jsx(IconAction, { label: t('actions.impersonate'), disabled: busy, busy: operation === 'impersonate', onClick: () => void onImpersonate(), children: _jsx(IconUserOutlineMedium, {}) }), (!isGreeting || started) && (_jsx(IconAction, { label: t('actions.rollback'), disabled: busy, busy: operation === 'rollback', onClick: onRollback, children: _jsx(IconBranchOutlineMedium, {}) })), failure !== null && (_jsx("span", { role: "status", style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #ec1313)', paddingLeft: 4 }, children: failure })), edit !== null && (_jsxs(Dialog, { open: true, width: "lg", title: t('actions.editUserTitle', { turn: edit.turn }), description: t('actions.editUserHint'), onClose: closeEdit, children: [_jsx("textarea", { "aria-label": t('actions.editUserTitle', { turn: edit.turn }), className: "dsh-tavern-input dsh-tavern-textarea dsh-tavern-floorEditor", disabled: busy, value: edit.text, onChange: (e) => { if (!submitting.current)
                            setEdit({ ...edit, text: e.target.value }); }, onKeyDown: (e) => {
                            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent?.isComposing) {
                                e.preventDefault();
                                void submitEdit();
                            }
                        } }), _jsx(Err, { message: editFailure }), _jsxs(SaveBar, { children: [editDirty && _jsx(Badge, { children: t('draft.unsaved') }), _jsx(Btn, { disabled: busy, onClick: closeEdit, children: t('action.cancel') }), _jsx(Btn, { primary: true, disabled: busy || !editDirty || !edit.text.trim(), onClick: () => void submitEdit(), children: operation === 'submit-edit' ? t('actions.saving') : t('actions.saveRerun') })] })] })), editAi !== null && (_jsxs(Dialog, { open: true, width: "lg", title: t('actions.editAiTitle', { turn: editAi.turn }), description: t('actions.editAiHint'), onClose: closeEditAi, children: [_jsx("textarea", { "aria-label": t('actions.editAiTitle', { turn: editAi.turn }), className: "dsh-tavern-input dsh-tavern-textarea dsh-tavern-floorEditor", disabled: busy, value: editAi.text, onChange: (e) => { if (!submitting.current)
                            setEditAi({ ...editAi, text: e.target.value }); }, onKeyDown: (e) => {
                            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !e.nativeEvent?.isComposing) {
                                e.preventDefault();
                                void submitEditAi();
                            }
                        } }), _jsx(Err, { message: editAiFailure }), _jsxs(SaveBar, { children: [editAiDirty && _jsx(Badge, { children: t('draft.unsaved') }), _jsx(Btn, { disabled: busy, onClick: closeEditAi, children: t('action.cancel') }), _jsx(Btn, { primary: true, disabled: busy || !editAiDirty || !editAi.text.trim(), onClick: () => void submitEditAi(), children: operation === 'submit-edit-ai' ? t('actions.saving') : t('actions.saveNoRerun') })] })] })), editGuard.confirmation, editAiGuard.confirmation, impersonated !== null && (_jsxs(Dialog, { open: true, title: t('actions.impersonateTitle'), onClose: () => setImpersonated(null), children: [_jsx("textarea", { readOnly: true, className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 120 }, value: impersonated }), _jsx("div", { style: { marginTop: 8, fontSize: 12, opacity: 0.8 }, children: t('actions.clipboardUnavailable') })] })), toast.node] }));
}
export function TavernInterruptedFloorActions(props) {
    return _jsx(InterruptedFloorActions, { ...props }, JSON.stringify([remoteIdentity(props.remote), props.sessionId, props.turn]));
}
function InterruptedFloorActions(props) {
    const { remote, sessionId, sessions, turn } = props;
    const active = useActionLifetime();
    const navigation = guardedSessions(sessions, active);
    const t = useT();
    const toast = useToast();
    const [operation, setOperation] = useState(null);
    const [failure, setFailure] = useState(null);
    const submitting = useRef(false);
    const siblingLoader = useLoader(() => remote.getFloorSiblings({ sessionId, turn }), [sessionId, turn]);
    useEffect(() => {
        return subscribeSessionWindowEvent(BRANCH_CHANGED_EVENT, sessionId, false, () => siblingLoader.reload());
        // reload 随 loader render 更新；事件回调只需跟会话重挂。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionId]);
    const siblingSwipe = siblingLoader.state.status === 'ready' ? siblingLoader.state.value.swipe : null;
    const busy = operation !== null;
    /** 与楼上 run 同一路径：fork 成功后广播分支变更并打开子会话。 */
    const run = async (kind, op) => {
        if (!active.current || submitting.current)
            return;
        submitting.current = true;
        setOperation(kind);
        setFailure(null);
        try {
            const r = await op();
            if (!active.current)
                return;
            if (r.ok) {
                window.dispatchEvent(new CustomEvent(BRANCH_CHANGED_EVENT, { detail: sessionId }));
                await openChildSession(navigation, r.value.childSessionId, r.value.title, sessionId);
            }
            else
                setFailure(r.error.message);
        }
        catch (e) {
            setFailure(describeError(e));
        }
        finally {
            submitting.current = false;
            setOperation(null);
        }
    };
    const onBranch = (delta) => {
        const nav = siblingSwipe;
        if (!active.current || !nav || nav.total < 2 || busy || submitting.current)
            return;
        const target = nav.siblings[(nav.index + delta + nav.total) % nav.total];
        if (!target || target === sessionId)
            return;
        submitting.current = true;
        setOperation(delta < 0 ? 'branch-prev' : 'branch-next');
        void openChildSession(navigation, target, undefined, sessionId)
            .catch(() => {
            toast.show(t('actions.branchGone'));
            siblingLoader.reload();
        })
            .finally(() => { submitting.current = false; setOperation(null); });
    };
    return (_jsxs("span", { className: "dsh-tavern-actionGroup dsh-tavern-actionGroup-interrupted", children: [siblingSwipe && siblingSwipe.total > 1 && (_jsxs(_Fragment, { children: [_jsx(IconAction, { label: t('actions.branchPrev'), disabled: busy, busy: operation === 'branch-prev', onClick: () => onBranch(-1), children: _jsx(IconChevronLeftOutlineMedium, {}) }), _jsxs("span", { className: "dsh-tavern-swipeIdx", title: t('actions.branchCount', { turn: siblingSwipe.turn, total: siblingSwipe.total }), children: [siblingSwipe.index + 1, "/", siblingSwipe.total] }), _jsx(IconAction, { label: t('actions.branchNext'), disabled: busy, busy: operation === 'branch-next', onClick: () => onBranch(1), children: _jsx(IconChevronRightOutlineMedium, {}) }), _jsx("span", { className: "dsh-tavern-actionDivider" })] })), _jsx(IconAction, { label: t('actions.regenerate'), disabled: busy, busy: operation === 'regenerate', onClick: () => void run('regenerate', () => remote.regenerate({ sessionId, turn })), children: _jsx(IconRefreshOutlineMedium, {}) }), _jsx(IconAction, { label: t('actions.rollback'), disabled: busy, busy: operation === 'rollback', onClick: () => void run('rollback', () => remote.rollbackToFloor({ sessionId, turn })), children: _jsx(IconBranchOutlineMedium, {}) }), failure !== null && (_jsx("span", { role: "status", style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #ec1313)', paddingLeft: 4 }, children: failure })), toast.node] }));
}
