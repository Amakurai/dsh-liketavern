import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 设置面板分区：人设（卡片网格 / 新建编辑 / 删除 / 设为默认）。
 * 卡片可键盘触发（clickableProps）；保存/设默认等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useState } from 'react';
import { IconEditOutline16, IconTrashOutline16, IconUserOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { useT } from '../i18n.js';
import { EMPTY_SESSION_DEFAULTS } from '../types.js';
import { Avatar, Badge, Btn, ConfirmDialog, Err, Field, IconBtn, SaveBar, SearchEmpty, SearchInput, Section, Select, Skeleton, clickableProps, errOf, runAsync, useLoader, useToast } from '../util.js';
export function PersonasSection(props) {
    const { remote } = props;
    const t = useT();
    const { state, reload } = useLoader(() => remote.listPersonas({}), []);
    const lore = useLoader(() => remote.listLorebooks({}), []);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(null);
    const [toDelete, setToDelete] = useState(null);
    const [query, setQuery] = useState('');
    const toast = useToast();
    const items = state.status === 'ready' ? state.value.items : [];
    const q = query.trim().toLowerCase();
    const filtered = q === '' ? items : items.filter((p) => p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
    const save = async () => {
        if (!editing)
            return;
        if (!editing.name.trim()) {
            setError(t('personas.nameRequired'));
            return;
        }
        await runAsync(setBusy, setError, async () => {
            const r = await remote.savePersona({ persona: editing });
            const err = errOf(r);
            if (err)
                setError(err);
            else {
                toast.show(t('personas.saved', { name: editing.name }));
                reload();
            }
        });
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
            toast.show(t('personas.defaultSet'));
    };
    return (_jsxs(Section, { title: t('section.personas'), description: t('personas.sectionDesc'), children: [toast.node, _jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(Btn, { size: "md", onClick: createNew, children: t('personas.new') }), _jsx(Btn, { size: "md", onClick: reload, disabled: busy, children: t('action.refresh') }), items.length >= 5 && (_jsx(SearchInput, { label: t('personas.searchLabel'), value: query, onChange: setQuery, placeholder: t('personas.searchPlaceholder'), width: 220 }))] }), state.status === 'loading' && (_jsxs("div", { className: "dsh-tavern-list", children: [_jsx(Skeleton, { height: 70, radius: 16 }), _jsx(Skeleton, { height: 70, radius: 16 }), _jsx(Skeleton, { height: 70, radius: 16 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), _jsx(Err, { message: error }), items.length === 0 && state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty", children: [_jsx("div", { className: "dsh-tavern-emptyIcon", children: _jsx(IconUserOutline16, { size: 32 }) }), _jsx("div", { className: "dsh-tavern-emptyTitle", children: t('personas.emptyTitle') }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: t('personas.emptyDesc') })] })), q !== '' && filtered.length === 0 && state.status === 'ready' && (_jsx(SearchEmpty, { what: t('personas.entity'), query: query.trim(), onClear: () => setQuery('') })), _jsx("div", { className: "dsh-tavern-list", style: { marginBottom: 12 }, children: filtered.map((p) => (_jsxs("div", { className: "dsh-tavern-tile", ...clickableProps(() => setEditing({ ...p })), children: [_jsx(Avatar, { url: p.avatar, name: p.name, size: 38 }), _jsxs("div", { className: "dsh-tavern-tileMain", children: [_jsxs("div", { className: "dsh-tavern-tileTitleRow", children: [_jsx("span", { className: "dsh-tavern-tileName", children: p.name }), p.lorebookId ? _jsx(Badge, { children: p.lorebookId }) : null] }), _jsx("span", { className: "dsh-tavern-tileSub", children: p.description.trim() || t('personas.noDescription') })] }), _jsxs("div", { className: "dsh-tavern-tileActions", children: [_jsx(IconBtn, { label: t('action.edit'), onClick: () => setEditing({ ...p }), children: _jsx(IconEditOutline16, {}) }), _jsx(Btn, { size: "sm", onClick: () => void setAsDefault(p.id), children: t('personas.setDefault') }), _jsx(IconBtn, { label: t('personas.delete'), danger: true, onClick: () => setToDelete(p), children: _jsx(IconTrashOutline16, {}) })] })] }, p.id))) }), _jsx(ConfirmDialog, { open: toDelete !== null, title: t('personas.deleteTitle'), description: toDelete ? t('personas.deleteDesc', { name: toDelete.name }) : '', confirmLabel: t('action.delete'), danger: true, onCancel: () => setToDelete(null), onConfirm: () => void remove() }), editing && (_jsxs("div", { className: "dsh-tavern-card", style: { marginBottom: 12 }, children: [_jsx(Field, { label: t('personas.field.name'), children: _jsx("input", { className: "dsh-tavern-input", style: { flex: 1 }, value: editing.name, onChange: (e) => setEditing({ ...editing, name: e.target.value }) }) }), _jsxs("div", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('personas.field.description') }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", value: editing.description, onChange: (e) => setEditing({ ...editing, description: e.target.value }) })] }), _jsx(Field, { label: t('personas.field.lorebook'), children: _jsx(Select, { width: "100%", value: editing.lorebookId ?? '', onChange: (v) => setEditing({ ...editing, lorebookId: v || null }), options: [
                                { value: '', label: t('personas.lorebookNone') },
                                ...(lore.state.status === 'ready' ? lore.state.value.items.map((n) => ({ value: n, label: n })) : []),
                            ] }) }), _jsxs(SaveBar, { children: [_jsx(Btn, { disabled: busy, onClick: () => void save(), primary: true, children: t('action.save') }), _jsx(Btn, { onClick: () => setEditing(null), children: t('action.close') })] })] }))] }));
}
