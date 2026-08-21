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
 * - 代答（impersonate）生成用户台词，dsh 输入区没有插件可写 API，结果复制到剪贴板。
 */
import { useEffect, useState } from 'react';
import { IconBranchOutline16, IconChevronLeftOutline14, IconChevronRightOutline14, IconEditOutline16, IconListPenOutline16, IconLoadingOutline16, IconPlayOutline16, IconRefreshOutline16, IconUserOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { isTavernSession } from './mode.js';
import { openChildSession } from './openChild.js';
import { Btn, Dialog, Err, textarea, useLoader, useToast } from './util.js';
import './styles.js';
function IconAction(props) {
    return (_jsx(Tooltip, { label: props.label, side: "bottom", children: _jsx("button", { type: "button", "aria-label": props.label, className: "dsh-tavern-action", disabled: props.disabled, onClick: props.onClick, children: props.busy ? (_jsx("span", { className: "dsh-tavern-spin", children: _jsx(IconLoadingOutline16, {}) })) : (props.children) }) }));
}
/** 绑定变更广播（chip 保存绑定后 dispatch，操作条据此显隐）。 */
export const BINDING_CHANGED_EVENT = 'dsh-tavern:binding-changed';
/** 分支变更广播（fork 操作成功后以源会话 id dispatch，兄弟导航据此重拉）。 */
export const BRANCH_CHANGED_EVENT = 'dsh-tavern:branch-changed';
/** 查询会话是否已绑定角色卡；null = 尚未加载完成（先不渲染，避免闪烁）。非 Tavern 不打 remote。 */
function useTavernBound(remote, sessionId, enabled) {
    const [bound, setBound] = useState(null);
    useEffect(() => {
        if (!enabled) {
            setBound(false);
            return;
        }
        let alive = true;
        const load = () => remote
            .getSessionBinding({ sessionId })
            .then((r) => {
            if (alive)
                setBound(r.ok ? r.value.binding !== null : null);
        })
            .catch(() => {
            if (alive)
                setBound(null);
        });
        void load();
        const onChanged = (e) => {
            if (e.detail === sessionId)
                void load();
        };
        window.addEventListener(BINDING_CHANGED_EVENT, onChanged);
        return () => {
            alive = false;
            window.removeEventListener(BINDING_CHANGED_EVENT, onChanged);
        };
    }, [remote, sessionId, enabled]);
    return bound;
}
export function TavernFloorActions(props) {
    const { remote, sessionId, sessions, messageId } = props;
    const tavern = isTavernSession(props.useSessions, sessionId);
    const bound = useTavernBound(remote, sessionId, tavern);
    const [operation, setOperation] = useState(null);
    const [failure, setFailure] = useState(null);
    const [editFailure, setEditFailure] = useState(null);
    const [edit, setEdit] = useState(null);
    const [editAiFailure, setEditAiFailure] = useState(null);
    const [editAi, setEditAi] = useState(null);
    /** 剪贴板不可用时展示的代答结果（用户手动复制）。 */
    const [impersonated, setImpersonated] = useState(null);
    const toast = useToast();
    const swipeLoader = useLoader(() => remote.getGreetingSwipe({ sessionId, messageId: messageId }), [sessionId, messageId], bound === true && Boolean(messageId));
    const siblingLoader = useLoader(() => remote.getFloorSiblings({ sessionId, messageId: messageId }), [sessionId, messageId], bound === true && Boolean(messageId));
    useEffect(() => {
        if (bound !== true || !messageId)
            return;
        const onChanged = (event) => {
            if (event.detail === sessionId)
                swipeLoader.reload();
        };
        const onBranchChanged = (event) => {
            if (event.detail === sessionId)
                siblingLoader.reload();
        };
        window.addEventListener(BINDING_CHANGED_EVENT, onChanged);
        window.addEventListener(BRANCH_CHANGED_EVENT, onBranchChanged);
        return () => {
            window.removeEventListener(BINDING_CHANGED_EVENT, onChanged);
            window.removeEventListener(BRANCH_CHANGED_EVENT, onBranchChanged);
        };
        // reload 随 loader render 更新；事件回调只需跟会话、消息和启用状态重挂。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bound, messageId, sessionId]);
    const greetState = swipeLoader.state.status === 'ready' ? swipeLoader.state.value : null;
    const swipe = greetState?.swipe ?? null;
    const isGreeting = greetState?.isGreeting === true;
    const started = greetState?.started === true;
    const siblingSwipe = siblingLoader.state.status === 'ready' ? siblingLoader.state.value.swipe : null;
    /** 跑一个产生分支会话的操作；成功后直接跳转到分支（续跑过程在分支里原生流式可见），并写入分支标题。 */
    const run = async (kind, op) => {
        setOperation(kind);
        setFailure(null);
        try {
            const r = await op();
            if (r.ok) {
                // 源会话的兄弟导航（若仍挂载）据此重拉索引
                window.dispatchEvent(new CustomEvent(BRANCH_CHANGED_EVENT, { detail: sessionId }));
                await openChildSession(sessions, r.value.childSessionId, r.value.title);
            }
            else
                setFailure(r.error.message);
        }
        catch (e) {
            setFailure(e instanceof Error ? e.message : String(e));
        }
        finally {
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
        if (!nav || nav.total < 2 || busy)
            return;
        const target = nav.siblings[(nav.index + delta + nav.total) % nav.total];
        if (!target || target === sessionId)
            return;
        setOperation(delta < 0 ? 'branch-prev' : 'branch-next');
        void openChildSession(sessions, target)
            .catch(() => {
            toast.show('这个分支会话不存在或已被删除');
            siblingLoader.reload();
        })
            .finally(() => setOperation(null));
    };
    const onEdit = async () => {
        setOperation('load-edit');
        setFailure(null);
        setEditFailure(null);
        try {
            const r = await remote.getFloorUserMessage({ sessionId, messageId });
            if (r.ok)
                setEdit({ turn: r.value.turn, text: r.value.text });
            else
                setFailure(r.error.message);
        }
        catch (e) {
            setFailure(e instanceof Error ? e.message : String(e));
        }
        finally {
            setOperation(null);
        }
    };
    const submitEdit = async () => {
        const draft = edit;
        if (!draft)
            return;
        setOperation('submit-edit');
        setEditFailure(null);
        try {
            const r = await remote.editUserMessage({ sessionId, messageId, text: draft.text });
            if (r.ok) {
                setEdit(null);
                window.dispatchEvent(new CustomEvent(BRANCH_CHANGED_EVENT, { detail: sessionId }));
                await openChildSession(sessions, r.value.childSessionId, r.value.title);
            }
            else {
                setEditFailure(r.error.message);
            }
        }
        catch (e) {
            setEditFailure(e instanceof Error ? e.message : String(e));
        }
        finally {
            setOperation(null);
        }
    };
    /** 续写最后一层：不 fork，host 驱动画前会话，流式在当前会话出现。 */
    const onContinue = async () => {
        setOperation('continue');
        setFailure(null);
        try {
            const r = await remote.continueFloor({ sessionId, messageId });
            if (!r.ok)
                setFailure(r.error.message);
        }
        catch (e) {
            setFailure(e instanceof Error ? e.message : String(e));
        }
        finally {
            setOperation(null);
        }
    };
    const onEditAi = async () => {
        setOperation('load-edit-ai');
        setFailure(null);
        setEditAiFailure(null);
        try {
            const r = await remote.getFloorAssistantMessage({ sessionId, messageId });
            if (r.ok)
                setEditAi({ turn: r.value.turn, text: r.value.text });
            else
                setFailure(r.error.message);
        }
        catch (e) {
            setFailure(e instanceof Error ? e.message : String(e));
        }
        finally {
            setOperation(null);
        }
    };
    const submitEditAi = async () => {
        const draft = editAi;
        if (!draft)
            return;
        setOperation('submit-edit-ai');
        setEditAiFailure(null);
        try {
            const r = await remote.editAssistantMessage({ sessionId, messageId, text: draft.text });
            if (r.ok) {
                setEditAi(null);
                window.dispatchEvent(new CustomEvent(BRANCH_CHANGED_EVENT, { detail: sessionId }));
                await openChildSession(sessions, r.value.childSessionId, r.value.title);
            }
            else {
                setEditAiFailure(r.error.message);
            }
        }
        catch (e) {
            setEditAiFailure(e instanceof Error ? e.message : String(e));
        }
        finally {
            setOperation(null);
        }
    };
    /** AI 代答用户：结果复制进剪贴板（dsh 输入区没有插件可写 API）；剪贴板不可用时弹窗展示。 */
    const onImpersonate = async () => {
        setOperation('impersonate');
        setFailure(null);
        try {
            const r = await remote.impersonate({ sessionId });
            if (!r.ok) {
                setFailure(r.error.message);
                return;
            }
            try {
                await navigator.clipboard.writeText(r.value.text);
                toast.show('用户台词已生成并复制到剪贴板，粘贴到输入框后发送');
            }
            catch {
                setImpersonated(r.value.text);
            }
        }
        catch (e) {
            setFailure(e instanceof Error ? e.message : String(e));
        }
        finally {
            setOperation(null);
        }
    };
    return (_jsxs("span", { className: "dsh-tavern-actionGroup", children: [!isGreeting && siblingSwipe && siblingSwipe.total > 1 && (_jsxs(_Fragment, { children: [_jsx(IconAction, { label: "\u4E0A\u4E00\u4E2A\u5206\u652F\uFF08\u540C\u4E00\u697C\u5C42\u7684\u53E6\u4E00\u7248\u56DE\u590D\uFF09", disabled: busy, busy: operation === 'branch-prev', onClick: () => onBranch(-1), children: _jsx(IconChevronLeftOutline14, {}) }), _jsxs("span", { className: "dsh-tavern-swipeIdx", title: `第 ${siblingSwipe.turn} 层有 ${siblingSwipe.total} 个分支`, children: [siblingSwipe.index + 1, "/", siblingSwipe.total] }), _jsx(IconAction, { label: "\u4E0B\u4E00\u4E2A\u5206\u652F\uFF08\u540C\u4E00\u697C\u5C42\u7684\u53E6\u4E00\u7248\u56DE\u590D\uFF09", disabled: busy, busy: operation === 'branch-next', onClick: () => onBranch(1), children: _jsx(IconChevronRightOutline14, {}) })] })), swipe && (_jsxs(_Fragment, { children: [_jsx(IconAction, { label: "\u4E0A\u4E00\u6761\u5F00\u573A\u767D", disabled: busy, busy: operation === 'swipe-prev', onClick: () => onSwipe(-1), children: _jsx(IconChevronLeftOutline14, {}) }), _jsxs("span", { className: "dsh-tavern-swipeIdx", children: [swipe.index + 1, "/", swipe.total] }), _jsx(IconAction, { label: "\u4E0B\u4E00\u6761\u5F00\u573A\u767D", disabled: busy, busy: operation === 'swipe-next', onClick: () => onSwipe(1), children: _jsx(IconChevronRightOutline14, {}) })] })), !isGreeting && (_jsx(IconAction, { label: "\u91CD\u65B0\u751F\u6210\u8FD9\u4E00\u5C42", disabled: busy, busy: operation === 'regenerate', onClick: onRegenerate, children: _jsx(IconRefreshOutline16, {}) })), !isGreeting && (_jsx(IconAction, { label: "\u7EED\u5199\u8FD9\u4E00\u5C42\uFF08\u63A5\u7740\u88AB\u622A\u65AD\u7684\u56DE\u590D\u5199\uFF09", disabled: busy, busy: operation === 'continue', onClick: () => void onContinue(), children: _jsx(IconPlayOutline16, {}) })), !isGreeting && (_jsx(IconAction, { label: "\u7F16\u8F91\u8FD9\u4E00\u5C42\u7684\u7528\u6237\u6D88\u606F", disabled: busy, busy: operation === 'load-edit', onClick: () => void onEdit(), children: _jsx(IconEditOutline16, {}) })), !isGreeting && (_jsx(IconAction, { label: "\u7F16\u8F91\u8FD9\u4E00\u5C42\u7684\u56DE\u590D\uFF08\u4E0D\u91CD\u8DD1\uFF09", disabled: busy, busy: operation === 'load-edit-ai', onClick: () => void onEditAi(), children: _jsx(IconListPenOutline16, {}) })), _jsx(IconAction, { label: "AI \u4EE3\u7B54\u7528\u6237\uFF08\u751F\u6210\u6211\u7684\u53F0\u8BCD\uFF0C\u590D\u5236\u5230\u526A\u8D34\u677F\uFF09", disabled: busy, busy: operation === 'impersonate', onClick: () => void onImpersonate(), children: _jsx(IconUserOutline16, {}) }), (!isGreeting || started) && (_jsx(IconAction, { label: "\u56DE\u9000\u5230\u8FD9\u4E00\u5C42\uFF08\u4E22\u5F03\u5176\u540E\u697C\u5C42\uFF09", disabled: busy, busy: operation === 'rollback', onClick: onRollback, children: _jsx(IconBranchOutline16, {}) })), failure !== null && (_jsx("span", { role: "status", style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #ec1313)', paddingLeft: 4 }, children: failure })), edit !== null && (_jsxs(Dialog, { open: true, title: `编辑第 ${edit.turn} 层的用户消息`, onClose: () => { if (!busy)
                    setEdit(null); }, children: [_jsx("textarea", { style: { ...textarea, minHeight: 120 }, value: edit.text, onChange: (e) => setEdit({ ...edit, text: e.target.value }) }), _jsx(Err, { message: editFailure }), _jsxs("div", { style: { display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }, children: [_jsx(Btn, { disabled: busy, onClick: () => setEdit(null), children: "\u53D6\u6D88" }), _jsx(Btn, { disabled: busy || !edit.text.trim(), onClick: () => void submitEdit(), children: operation === 'submit-edit' ? '保存中…' : '保存并重跑' })] })] })), editAi !== null && (_jsxs(Dialog, { open: true, title: `编辑第 ${editAi.turn} 层的回复`, onClose: () => { if (!busy)
                    setEditAi(null); }, children: [_jsx("textarea", { style: { ...textarea, minHeight: 160 }, value: editAi.text, onChange: (e) => setEditAi({ ...editAi, text: e.target.value }) }), _jsx(Err, { message: editAiFailure }), _jsxs("div", { style: { display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }, children: [_jsx(Btn, { disabled: busy, onClick: () => setEditAi(null), children: "\u53D6\u6D88" }), _jsx(Btn, { disabled: busy || !editAi.text.trim(), onClick: () => void submitEditAi(), children: operation === 'submit-edit-ai' ? '保存中…' : '保存（不重跑）' })] })] })), impersonated !== null && (_jsxs(Dialog, { open: true, title: "AI \u4EE3\u7B54\u7684\u7528\u6237\u53F0\u8BCD", onClose: () => setImpersonated(null), children: [_jsx("textarea", { readOnly: true, style: { ...textarea, minHeight: 120 }, value: impersonated }), _jsx("div", { style: { marginTop: 8, fontSize: 12, opacity: 0.8 }, children: "\u526A\u8D34\u677F\u4E0D\u53EF\u7528\uFF0C\u8BF7\u624B\u52A8\u590D\u5236\u540E\u7C98\u8D34\u5230\u8F93\u5165\u6846\u3002" })] })), toast.node] }));
}
