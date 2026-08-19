import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 设置面板分区：记忆与世界状态（按角色卡查看 / 编辑 / 压缩 / 导出）。
 * 记忆/世界状态切换用 chip 段控；条目为 .dsh-tavern-memo 卡片（meta 行 + 正文 + IconBtn 操作）。
 * 压缩/导出等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useState } from 'react';
import { IconEditOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { Btn, Err, IconBtn, Muted, Section, Select, SettingsRow, Skeleton, downloadJson, errOf, useLoader, useToast } from '../util.js';
function splitList(text) {
    return text
        .split(/[，,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
}
function MemoryEditor(props) {
    const { entry } = props;
    const [body, setBody] = useState(entry.body);
    const [tags, setTags] = useState(entry.tags.join(', '));
    const [keys, setKeys] = useState(entry.keys.join(', '));
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const save = async () => {
        setBusy(true);
        const r = await props.remote.saveMemory({
            cardId: props.cardId,
            id: entry.id,
            body,
            tags: splitList(tags),
            keys: splitList(keys),
        });
        setBusy(false);
        const err = errOf(r);
        if (err)
            setError(err);
        else
            props.onDone();
    };
    return (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }, children: [_jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", value: body, onChange: (e) => setBody(e.target.value) }), _jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u6807\u7B7E" }), _jsx("input", { className: "dsh-tavern-input", value: tags, onChange: (e) => setTags(e.target.value) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u68C0\u7D22\u952E" }), _jsx("input", { className: "dsh-tavern-input", value: keys, onChange: (e) => setKeys(e.target.value) })] })] }), _jsx(Err, { message: error }), _jsxs("div", { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' }, children: [_jsx(Btn, { onClick: props.onDone, children: "\u53D6\u6D88" }), _jsx(Btn, { primary: true, disabled: busy || !body.trim(), onClick: () => void save(), children: "\u4FDD\u5B58" })] })] }));
}
export function MemorySection(props) {
    const { remote } = props;
    const chars = useLoader(() => remote.listCharacters({}), []);
    const [cardId, setCardId] = useState('');
    const [tab, setTab] = useState('memory');
    const [error, setError] = useState(null);
    const [editingId, setEditingId] = useState(null);
    const [newBody, setNewBody] = useState('');
    const toast = useToast();
    const memories = useLoader(() => remote.getMemories({ cardId }), [cardId], cardId !== '');
    const deltas = useLoader(() => remote.getWorldDeltas({ cardId }), [cardId], cardId !== '');
    const charItems = chars.state.status === 'ready' ? chars.state.value.items : [];
    const memoryItems = memories.state.status === 'ready' ? memories.state.value.items : [];
    const deltaItems = deltas.state.status === 'ready' ? deltas.state.value.items : [];
    const addMemory = async () => {
        const r = await remote.saveMemory({ cardId, body: newBody.trim() });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            setNewBody('');
            memories.reload();
        }
    };
    const deleteMemory = async (id) => {
        const r = await remote.deleteMemory({ cardId, id });
        const err = errOf(r);
        if (err)
            setError(err);
        else
            memories.reload();
    };
    const compress = async () => {
        const r = await remote.compressMemories({ cardId });
        if (!r.ok)
            setError(r.error.message);
        else {
            toast.show(r.value.merged > 0 ? `已无损归并最旧 ${r.value.merged} 条记忆（原文仍可恢复）` : '记忆不足两条，无需归并');
            memories.reload();
        }
    };
    const revoke = async (id) => {
        const r = await remote.revokeWorldDelta({ cardId, id });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            toast.show(`已撤销世界状态 #${id}`);
            deltas.reload();
        }
    };
    const exportBook = async () => {
        const r = await remote.exportMergedLorebook({ cardId });
        if (!r.ok)
            setError(r.error.message);
        else {
            downloadJson(`lorebook-merged-${cardId}.json`, r.value.json);
            toast.show('已导出合并后的世界书');
        }
    };
    return (_jsxs(Section, { title: "\u8BB0\u5FC6\u4E0E\u4E16\u754C\u72B6\u6001", description: "\u6309\u89D2\u8272\u67E5\u770B\u548C\u7F16\u8F91\u957F\u671F\u8BB0\u5FC6\u3001\u4E16\u754C\u72B6\u6001\u53D8\u5316\u5C42\u3002", children: [toast.node, _jsx(SettingsRow, { title: "\u89D2\u8272", description: "\u9009\u62E9\u8981\u67E5\u770B\u7684\u89D2\u8272\u5361\u5DE5\u4F5C\u533A\u3002", children: _jsx(Select, { size: "md", value: cardId, onChange: setCardId, options: [{ value: '', label: '（选择角色）' }, ...charItems.map((c) => ({ value: c.cardId, label: c.name }))] }) }), _jsx(Err, { message: error }), cardId && (_jsxs(_Fragment, { children: [_jsxs("div", { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, margin: '8px 0' }, children: [_jsxs("div", { className: "dsh-tavern-filters", children: [_jsxs("button", { type: "button", className: "dsh-tavern-chip", "data-active": tab === 'memory' ? 'true' : 'false', onClick: () => setTab('memory'), children: ["\u8BB0\u5FC6\uFF08", memoryItems.length, "\uFF09"] }), _jsxs("button", { type: "button", className: "dsh-tavern-chip", "data-active": tab === 'delta' ? 'true' : 'false', onClick: () => setTab('delta'), children: ["\u4E16\u754C\u72B6\u6001\uFF08", deltaItems.length, "\uFF09"] })] }), _jsx("span", { style: { flex: 1 } }), tab === 'memory' && _jsx(Btn, { onClick: () => void compress(), children: "\u5F52\u5E76\u6700\u65E7\u4E00\u6279" }), tab === 'delta' && _jsx(Btn, { onClick: () => void exportBook(), children: "\u5BFC\u51FA\u5408\u5E76\u540E\u7684\u4E16\u754C\u4E66" })] }), tab === 'memory' && (_jsxs("div", { className: "dsh-tavern-list", children: [memories.state.status === 'loading' && (_jsxs(_Fragment, { children: [_jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 })] })), memories.state.status === 'error' && _jsx(Err, { message: memories.state.message }), memoryItems.length === 0 && memories.state.status === 'ready' && _jsx(Muted, { children: "\u6682\u65E0\u8BB0\u5FC6\u3002\u8BA9\u6A21\u578B\u7528 tavern_memory_write \u5199\u5165\uFF0C\u6216\u5728\u4E0B\u65B9\u624B\u52A8\u6DFB\u52A0\u3002" }), memoryItems.map((m) => (_jsxs("div", { className: "dsh-tavern-memo", children: [_jsxs("div", { className: "dsh-tavern-memoHead", children: [_jsxs("span", { className: "dsh-tavern-memoMeta", children: [m.id, " \u00B7 ", m.updated, m.archived ? ' · 已归档' : '', m.tags.length > 0 ? ` · 标签 ${m.tags.join('、')}` : ''] }), _jsxs("span", { className: "dsh-tavern-memoActions", children: [_jsx(IconBtn, { label: editingId === m.id ? '收起编辑' : '编辑', onClick: () => setEditingId(editingId === m.id ? null : m.id), children: _jsx(IconEditOutline16, {}) }), _jsx(IconBtn, { label: "\u5220\u9664\u8BB0\u5FC6", danger: true, onClick: () => void deleteMemory(m.id), children: _jsx(IconTrashOutline16, {}) })] })] }), _jsx("pre", { className: "dsh-tavern-memoBody dsh-tavern-scroll", children: m.body }), editingId === m.id && (_jsx(MemoryEditor, { remote: remote, cardId: cardId, entry: m, onDone: () => {
                                            setEditingId(null);
                                            memories.reload();
                                        } }))] }, m.id))), _jsxs("div", { className: "dsh-tavern-memo", children: [_jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 60 }, placeholder: "\u65B0\u589E\u8BB0\u5FC6\u2026", value: newBody, onChange: (e) => setNewBody(e.target.value) }), _jsx("div", { style: { display: 'flex', justifyContent: 'flex-end' }, children: _jsx(Btn, { primary: true, disabled: !newBody.trim(), onClick: () => void addMemory(), children: "\u6DFB\u52A0\u8BB0\u5FC6" }) })] })] })), tab === 'delta' && (_jsxs("div", { className: "dsh-tavern-list", children: [deltas.state.status === 'loading' && (_jsxs(_Fragment, { children: [_jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 })] })), deltas.state.status === 'error' && _jsx(Err, { message: deltas.state.message }), deltaItems.map((d) => (_jsxs("div", { className: "dsh-tavern-memo", children: [_jsxs("div", { className: "dsh-tavern-memoHead", children: [_jsxs("span", { className: "dsh-tavern-memoMeta", children: ["#", d.id, " \u00B7 ", d.type, d.ref ? ` → ${d.ref}` : '', " \u00B7 ", d.ts, d.revoked ? ' · 已撤销' : ''] }), !d.revoked && (_jsx("span", { className: "dsh-tavern-memoActions", children: _jsx(Btn, { size: "sm", onClick: () => void revoke(d.id), children: "\u64A4\u9500" }) }))] }), _jsx("pre", { className: "dsh-tavern-memoBody dsh-tavern-scroll", children: d.content })] }, d.id))), deltaItems.length === 0 && deltas.state.status === 'ready' && _jsx(Muted, { children: "\u6682\u65E0\u4E16\u754C\u72B6\u6001\u53D8\u5316\u3002" })] }))] }))] }));
}
