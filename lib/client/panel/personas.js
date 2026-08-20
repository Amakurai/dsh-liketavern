import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 设置面板分区：人设（卡片网格 / 新建编辑 / 删除 / 设为默认）。
 * 卡片可键盘触发（clickableProps）；保存/设默认等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useState } from 'react';
import { IconEditOutline16, IconTrashOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { EMPTY_SESSION_DEFAULTS } from '../types.js';
import { Btn, ConfirmDialog, Err, Field, IconBtn, Muted, Section, Select, Skeleton, clickableProps, errOf, useLoader, useToast } from '../util.js';
export function PersonasSection(props) {
    const { remote } = props;
    const { state, reload } = useLoader(() => remote.listPersonas({}), []);
    const lore = useLoader(() => remote.listLorebooks({}), []);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(null);
    const [toDelete, setToDelete] = useState(null);
    const toast = useToast();
    const items = state.status === 'ready' ? state.value.items : [];
    const save = async () => {
        if (!editing)
            return;
        if (!editing.name.trim()) {
            setError('人设名称不能为空');
            return;
        }
        setBusy(true);
        const r = await remote.savePersona({ persona: editing });
        setBusy(false);
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            toast.show(`已保存人设 ${editing.name}`);
            reload();
        }
    };
    const remove = async () => {
        if (!toDelete)
            return;
        const r = await remote.deletePersona({ id: toDelete.id });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            if (editing?.id === toDelete.id)
                setEditing(null);
            setToDelete(null);
            reload();
        }
    };
    const createNew = () => {
        setEditing({ id: `persona-${Date.now().toString(36)}`, name: '', description: '', avatar: null, lorebookId: null });
    };
    const setAsDefault = async (id) => {
        const current = await remote.getSettings({});
        if (!current.ok) {
            setError(current.error.message);
            return;
        }
        const defaults = { ...EMPTY_SESSION_DEFAULTS, ...current.value.settings.defaults, personaId: id };
        const r = await remote.updateSettings({ patch: { defaults } });
        const err = errOf(r);
        if (err)
            setError(err);
        else
            toast.show('已设为新会话默认人设（当前打开的对话请用角色芯片切换）');
    };
    return (_jsxs(Section, { title: "\u4EBA\u8BBE", description: "\u7528\u6237\u4FA7\u4EBA\u8BBE\uFF0C\u540D\u5B57\u4F1A\u66FF\u6362 {{user}}\u3002\u5E93\u91CC\u53EA\u6709\u4E00\u6761\u65F6\uFF0C\u672A\u7ED1\u4EBA\u8BBE\u7684\u4F1A\u8BDD\u4E5F\u4F1A\u81EA\u52A8\u7528\u5B83\uFF1B\u591A\u6761\u65F6\u8BF7\u5728\u300C\u8BBE\u7F6E\u300D\u9875\u6216\u5BF9\u8BDD\u82AF\u7247\u91CC\u9009\u62E9\u3002", children: [toast.node, _jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(Btn, { size: "md", onClick: createNew, children: "\u65B0\u5EFA\u4EBA\u8BBE" }), _jsx(Btn, { size: "md", onClick: reload, disabled: busy, children: "\u5237\u65B0" })] }), state.status === 'loading' && (_jsxs("div", { className: "dsh-tavern-cards", children: [_jsx(Skeleton, { height: 96 }), _jsx(Skeleton, { height: 96 }), _jsx(Skeleton, { height: 96 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), _jsx(Err, { message: error }), items.length === 0 && state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty", children: [_jsx("div", { className: "dsh-tavern-emptyIcon", children: _jsx(IconUserOutline16, { size: 32 }) }), _jsx("div", { className: "dsh-tavern-emptyTitle", children: "\u6682\u65E0\u4EBA\u8BBE" }), _jsxs("div", { className: "dsh-tavern-emptyDesc", children: ["\u65B0\u5EFA\u4E00\u6761\u4EBA\u8BBE\uFF0C\u5BF9\u8BDD\u91CC\u7684 ", '{{user}}', " \u5C31\u4F1A\u6362\u6210\u5B83\u3002"] })] })), _jsx("div", { className: "dsh-tavern-cards", style: { marginBottom: 12 }, children: items.map((p) => (_jsxs("article", { className: "dsh-tavern-card is-clickable", ...clickableProps(() => setEditing({ ...p })), children: [_jsx("div", { className: "dsh-tavern-cardHead", children: _jsx("div", { className: "dsh-tavern-cardName", children: p.name }) }), _jsx("p", { className: "dsh-tavern-cardDesc", children: p.description.trim() || '还没有填写人设描述。' }), p.lorebookId ? _jsxs(Muted, { children: ["\u4EBA\u8BBE\u4E16\u754C\u4E66 ", p.lorebookId] }) : null, _jsxs("div", { className: "dsh-tavern-cardFoot", children: [_jsx(IconBtn, { label: "\u7F16\u8F91", onClick: () => setEditing({ ...p }), children: _jsx(IconEditOutline16, {}) }), _jsx(Btn, { size: "sm", onClick: () => void setAsDefault(p.id), children: "\u8BBE\u4E3A\u9ED8\u8BA4" }), _jsx(IconBtn, { label: "\u5220\u9664\u4EBA\u8BBE", danger: true, onClick: () => setToDelete(p), children: _jsx(IconTrashOutline16, {}) })] })] }, p.id))) }), _jsx(ConfirmDialog, { open: toDelete !== null, title: "\u5220\u9664\u4EBA\u8BBE\uFF1F", description: toDelete ? `确定删除人设「${toDelete.name}」？` : '', confirmLabel: "\u5220\u9664", danger: true, onCancel: () => setToDelete(null), onConfirm: () => void remove() }), editing && (_jsxs("div", { className: "dsh-tavern-card", style: { marginBottom: 12 }, children: [_jsx(Field, { label: "\u540D\u79F0", children: _jsx("input", { className: "dsh-tavern-input", style: { flex: 1 }, value: editing.name, onChange: (e) => setEditing({ ...editing, name: e.target.value }) }) }), _jsxs("div", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u63CF\u8FF0" }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", value: editing.description, onChange: (e) => setEditing({ ...editing, description: e.target.value }) })] }), _jsx(Field, { label: "\u4EBA\u8BBE\u4E16\u754C\u4E66", children: _jsx(Select, { width: "100%", value: editing.lorebookId ?? '', onChange: (v) => setEditing({ ...editing, lorebookId: v || null }), options: [
                                { value: '', label: '（无）' },
                                ...(lore.state.status === 'ready' ? lore.state.value.items.map((n) => ({ value: n, label: n })) : []),
                            ] }) }), _jsxs("div", { style: { display: 'flex', gap: 8, marginTop: 8 }, children: [_jsx(Btn, { disabled: busy, onClick: () => void save(), primary: true, children: "\u4FDD\u5B58" }), _jsx(Btn, { onClick: () => setEditing(null), children: "\u5173\u95ED" })] })] }))] }));
}
