import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * assistant 消息操作条（slot conversation.chat.assistant-actions，session 作用域）。
 *
 * 视觉对齐 dsh 原生 IconActions（28px 图标钮 + Tooltip）。
 * 整组用 margin-left:auto 靠右，开场白 swipe（‹ n/m ›）在这一侧。
 * 行为：
 * - 仅在 Tavern 模式且已绑定角色卡时渲染（普通 dsh 会话不出现任何 Tavern 按钮）；
 * - 开场白楼层只给 swipe（对话开始后连 swipe 也收起），不提供重新生成/编辑；
 * - 三个楼层操作均按「这一层」生效（slot owner 提供 messageId，host 端据此定位楼层）；
 * - 成功后自动 sessions.open(分支子会话)，续跑的流式过程在分支里原生可见。
 */
import { useEffect, useState } from 'react';
import { IconBranchOutline16, IconChevronLeftOutline14, IconChevronRightOutline14, IconEditOutline16, IconLoadingOutline16, IconRefreshOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives';
import { isTavernSession } from './mode.js';
import { openChildSession } from './openChild.js';
import { Btn, Dialog, Err, textarea, useLoader } from './util.js';
import './styles.js';
function IconAction(props) {
    return (_jsx(Tooltip, { label: props.label, side: "bottom", children: _jsx("button", { type: "button", "aria-label": props.label, className: "dsh-tavern-action", disabled: props.disabled, onClick: props.onClick, children: props.busy ? (_jsx("span", { className: "dsh-tavern-spin", children: _jsx(IconLoadingOutline16, {}) })) : (props.children) }) }));
}
/** 绑定变更广播（chip 保存绑定后 dispatch，操作条据此显隐）。 */
export const BINDING_CHANGED_EVENT = 'dsh-tavern:binding-changed';
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
    const swipeLoader = useLoader(() => remote.getGreetingSwipe({ sessionId, messageId: messageId }), [sessionId, messageId], bound === true && Boolean(messageId));
    useEffect(() => {
        if (bound !== true || !messageId)
            return;
        const onChanged = (event) => {
            if (event.detail === sessionId)
                swipeLoader.reload();
        };
        window.addEventListener(BINDING_CHANGED_EVENT, onChanged);
        return () => window.removeEventListener(BINDING_CHANGED_EVENT, onChanged);
        // reload 随 loader render 更新；事件回调只需跟会话、消息和启用状态重挂。
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [bound, messageId, sessionId]);
    const greetState = swipeLoader.state.status === 'ready' ? swipeLoader.state.value : null;
    const swipe = greetState?.swipe ?? null;
    const isGreeting = greetState?.isGreeting === true;
    const started = greetState?.started === true;
    /** 跑一个产生分支会话的操作；成功后直接跳转到分支（续跑过程在分支里原生流式可见）。 */
    const run = async (kind, op) => {
        setOperation(kind);
        setFailure(null);
        try {
            const r = await op();
            if (r.ok)
                await openChildSession(sessions, r.value.childSessionId);
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
                await openChildSession(sessions, r.value.childSessionId);
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
    return (_jsxs("span", { className: "dsh-tavern-actionGroup", children: [swipe && (_jsxs(_Fragment, { children: [_jsx(IconAction, { label: "\u4E0A\u4E00\u6761\u5F00\u573A\u767D", disabled: busy, busy: operation === 'swipe-prev', onClick: () => onSwipe(-1), children: _jsx(IconChevronLeftOutline14, {}) }), _jsxs("span", { className: "dsh-tavern-swipeIdx", children: [swipe.index + 1, "/", swipe.total] }), _jsx(IconAction, { label: "\u4E0B\u4E00\u6761\u5F00\u573A\u767D", disabled: busy, busy: operation === 'swipe-next', onClick: () => onSwipe(1), children: _jsx(IconChevronRightOutline14, {}) })] })), !isGreeting && (_jsx(IconAction, { label: "\u91CD\u65B0\u751F\u6210\u8FD9\u4E00\u5C42", disabled: busy, busy: operation === 'regenerate', onClick: onRegenerate, children: _jsx(IconRefreshOutline16, {}) })), !isGreeting && (_jsx(IconAction, { label: "\u7F16\u8F91\u8FD9\u4E00\u5C42\u7684\u7528\u6237\u6D88\u606F", disabled: busy, busy: operation === 'load-edit', onClick: () => void onEdit(), children: _jsx(IconEditOutline16, {}) })), (!isGreeting || started) && (_jsx(IconAction, { label: "\u56DE\u9000\u5230\u8FD9\u4E00\u5C42\uFF08\u4E22\u5F03\u5176\u540E\u697C\u5C42\uFF09", disabled: busy, busy: operation === 'rollback', onClick: onRollback, children: _jsx(IconBranchOutline16, {}) })), failure !== null && (_jsx("span", { role: "status", style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #ec1313)', paddingLeft: 4 }, children: failure })), edit !== null && (_jsxs(Dialog, { open: true, title: `编辑第 ${edit.turn} 层的用户消息`, onClose: () => { if (!busy)
                    setEdit(null); }, children: [_jsx("textarea", { style: { ...textarea, minHeight: 120 }, value: edit.text, onChange: (e) => setEdit({ ...edit, text: e.target.value }) }), _jsx(Err, { message: editFailure }), _jsxs("div", { style: { display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }, children: [_jsx(Btn, { disabled: busy, onClick: () => setEdit(null), children: "\u53D6\u6D88" }), _jsx(Btn, { disabled: busy || !edit.text.trim(), onClick: () => void submitEdit(), children: operation === 'submit-edit' ? '保存中…' : '保存并重跑' })] })] }))] }));
}
