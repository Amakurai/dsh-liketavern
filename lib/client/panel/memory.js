import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 设置面板分区：记忆与世界状态（按角色卡查看 / 编辑 / 压缩 / 导出）。
 * 记忆/世界状态切换用 chip 段控；条目为 .dsh-tavern-memo 卡片（meta 行 + 正文 + IconBtn 操作）。
 * 压缩/导出等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useEffect, useState } from 'react';
import { IconEditOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { useT } from '../i18n.js';
import { Badge, Btn, Err, IconBtn, Muted, Section, Select, SettingsRow, Skeleton, downloadJson, errOf, runAsync, useLoader, useToast } from '../util.js';
/** 变化层类型徽标/选项对应的 i18n 键；渲染处经 t() 取文案。 */
const DELTA_TYPE_KEY = { add: 'memory.deltaType.add', update: 'memory.deltaType.update', invalidate: 'memory.deltaType.invalidate' };
function splitList(text) {
    return text
        .split(/[，,\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
}
function MemoryEditor(props) {
    const { entry } = props;
    const t = useT();
    const [body, setBody] = useState(entry.body);
    const [tags, setTags] = useState(entry.tags.join(', '));
    const [keys, setKeys] = useState(entry.keys.join(', '));
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const save = () => runAsync(setBusy, setError, async () => {
        const r = await props.remote.saveMemory({
            cardId: props.cardId,
            id: entry.id,
            body,
            tags: splitList(tags),
            keys: splitList(keys),
        });
        const err = errOf(r);
        if (err)
            setError(err);
        else
            props.onDone();
    });
    return (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }, children: [_jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", value: body, onChange: (e) => setBody(e.target.value) }), _jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.tags') }), _jsx("input", { className: "dsh-tavern-input", value: tags, onChange: (e) => setTags(e.target.value) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.keys') }), _jsx("input", { className: "dsh-tavern-input", value: keys, onChange: (e) => setKeys(e.target.value) })] })] }), _jsx(Err, { message: error }), _jsxs("div", { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' }, children: [_jsx(Btn, { onClick: props.onDone, children: t('action.cancel') }), _jsx(Btn, { primary: true, disabled: busy || !body.trim(), onClick: () => void save(), children: t('action.save') })] })] }));
}
export function MemorySection(props) {
    const { remote } = props;
    const t = useT();
    const chars = useLoader(() => remote.listCharacters({}), []);
    const [cardId, setCardId] = useState('');
    const [tab, setTab] = useState('memory');
    const [error, setError] = useState(null);
    const [editingId, setEditingId] = useState(null);
    const [newBody, setNewBody] = useState('');
    const [journalText, setJournalText] = useState('');
    const [deltaType, setDeltaType] = useState('add');
    const [deltaContent, setDeltaContent] = useState('');
    const [deltaRef, setDeltaRef] = useState('');
    const [deltaKeys, setDeltaKeys] = useState('');
    const toast = useToast();
    const memories = useLoader(() => remote.getMemories({ cardId }), [cardId], cardId !== '');
    const deltas = useLoader(() => remote.getWorldDeltas({ cardId }), [cardId], cardId !== '');
    const journal = useLoader(() => remote.getJournal({ cardId }), [cardId], cardId !== '');
    const charItems = chars.state.status === 'ready' ? chars.state.value.items : [];
    const memoryItems = memories.state.status === 'ready' ? memories.state.value.items : [];
    const deltaItems = deltas.state.status === 'ready' ? deltas.state.value.items : [];
    // journalText 只在查询 ready 时回填，切卡瞬间它还是上一张卡的正文；
    // 此时 cardId 已指向新卡，不清空就会被「保存笔记」原样写进新卡的 journal.md（覆盖丢数据）。
    useEffect(() => {
        setJournalText('');
    }, [cardId]);
    useEffect(() => {
        if (journal.state.status === 'ready')
            setJournalText(journal.state.value.text);
    }, [journal.state]);
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
            toast.show(r.value.merged > 0 ? t('memory.compressed', { count: r.value.merged }) : t('memory.compressNoop'));
            memories.reload();
        }
    };
    const revoke = async (id) => {
        const r = await remote.revokeWorldDelta({ cardId, id });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            toast.show(t('memory.revokeDone', { id }));
            deltas.reload();
        }
    };
    const exportBook = async () => {
        const r = await remote.exportMergedLorebook({ cardId });
        if (!r.ok)
            setError(r.error.message);
        else {
            downloadJson(`lorebook-merged-${cardId}.json`, r.value.json);
            toast.show(t('memory.bookExported'));
        }
    };
    const saveJournal = async () => {
        const r = await remote.saveJournal({ cardId, text: journalText });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            toast.show(t('memory.journalSaved'));
            journal.reload();
        }
    };
    const addDelta = async () => {
        const r = await remote.addWorldDelta({
            cardId,
            type: deltaType,
            content: deltaContent.trim(),
            ref: deltaRef.trim() || null,
            keys: splitList(deltaKeys),
        });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            toast.show(t('memory.deltaAdded', { id: r.ok ? r.value.id : '' }));
            setDeltaContent('');
            setDeltaRef('');
            setDeltaKeys('');
            deltas.reload();
        }
    };
    return (_jsxs(Section, { title: t('section.memory'), description: t('memory.desc'), children: [toast.node, _jsx(SettingsRow, { title: t('memory.character'), description: t('memory.characterDesc'), children: _jsx(Select, { size: "md", value: cardId, onChange: setCardId, options: [{ value: '', label: t('memory.pickCharacter') }, ...charItems.map((c) => ({ value: c.cardId, label: c.name }))] }) }), _jsx(Err, { message: error }), cardId && (_jsxs(_Fragment, { children: [_jsxs("div", { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, margin: '10px 0 14px' }, children: [_jsxs("div", { className: "dsh-tavern-filters", children: [_jsx("button", { type: "button", className: "dsh-tavern-chip", "data-active": tab === 'memory' ? 'true' : 'false', onClick: () => setTab('memory'), children: t('memory.tab.memory', { count: memoryItems.length }) }), _jsx("button", { type: "button", className: "dsh-tavern-chip", "data-active": tab === 'delta' ? 'true' : 'false', onClick: () => setTab('delta'), children: t('memory.tab.delta', { count: deltaItems.length }) }), _jsx("button", { type: "button", className: "dsh-tavern-chip", "data-active": tab === 'journal' ? 'true' : 'false', onClick: () => setTab('journal'), children: t('memory.tab.journal') })] }), _jsx("span", { style: { flex: 1 } }), tab === 'memory' && _jsx(Btn, { onClick: () => void compress(), children: t('memory.compressOldest') }), tab === 'delta' && _jsx(Btn, { onClick: () => void exportBook(), children: t('memory.exportBook') })] }), tab === 'memory' && (_jsxs("div", { className: "dsh-tavern-list", children: [memories.state.status === 'loading' && (_jsxs(_Fragment, { children: [_jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 })] })), memories.state.status === 'error' && _jsx(Err, { message: memories.state.message }), memoryItems.length === 0 && memories.state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty is-compact", children: [_jsx("div", { className: "dsh-tavern-emptyTitle", children: t('memory.emptyMemories') }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: t('memory.emptyMemoriesDesc') })] })), memoryItems.map((m) => (_jsxs("div", { className: "dsh-tavern-memo", children: [_jsxs("div", { className: "dsh-tavern-memoHead", children: [_jsx(Badge, { children: m.id }), m.archived ? _jsx(Badge, { children: t('memory.archived') }) : null, m.tags.map((tag) => (_jsx(Badge, { children: tag }, tag))), _jsx("span", { className: "dsh-tavern-memoMeta", children: m.updated }), _jsxs("span", { className: "dsh-tavern-memoActions", children: [_jsx(IconBtn, { label: editingId === m.id ? t('memory.collapseEdit') : t('action.edit'), onClick: () => setEditingId(editingId === m.id ? null : m.id), children: _jsx(IconEditOutline16, {}) }), _jsx(IconBtn, { label: t('memory.deleteEntry'), danger: true, onClick: () => void deleteMemory(m.id), children: _jsx(IconTrashOutline16, {}) })] })] }), _jsx("pre", { className: "dsh-tavern-memoBody dsh-tavern-scroll", children: m.body }), editingId === m.id && (_jsx(MemoryEditor, { remote: remote, cardId: cardId, entry: m, onDone: () => {
                                            setEditingId(null);
                                            memories.reload();
                                        } }))] }, m.id))), _jsxs("div", { className: "dsh-tavern-memo is-compose", children: [_jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 60 }, placeholder: t('memory.newPlaceholder'), value: newBody, onChange: (e) => setNewBody(e.target.value) }), _jsx("div", { style: { display: 'flex', justifyContent: 'flex-end' }, children: _jsx(Btn, { primary: true, disabled: !newBody.trim(), onClick: () => void addMemory(), children: t('memory.addEntry') }) })] })] })), tab === 'delta' && (_jsxs("div", { className: "dsh-tavern-list", children: [deltas.state.status === 'loading' && (_jsxs(_Fragment, { children: [_jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 })] })), deltas.state.status === 'error' && _jsx(Err, { message: deltas.state.message }), deltaItems.map((d) => (_jsxs("div", { className: `dsh-tavern-memo${d.revoked ? ' is-revoked' : ''}`, children: [_jsxs("div", { className: "dsh-tavern-memoHead", children: [_jsxs(Badge, { children: ["#", d.id] }), _jsx(Badge, { danger: d.type === 'invalidate', children: t(DELTA_TYPE_KEY[d.type]) }), d.ref ? _jsxs(Badge, { children: ["\u2192 ", d.ref] }) : null, d.revoked ? _jsx(Badge, { danger: true, children: t('memory.revoked') }) : null, _jsx("span", { className: "dsh-tavern-memoMeta", children: d.ts }), !d.revoked && (_jsx("span", { className: "dsh-tavern-memoActions", children: _jsx(Btn, { size: "sm", onClick: () => void revoke(d.id), children: t('memory.revoke') }) }))] }), _jsx("pre", { className: "dsh-tavern-memoBody dsh-tavern-scroll", children: d.content })] }, d.id))), deltaItems.length === 0 && deltas.state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty is-compact", children: [_jsx("div", { className: "dsh-tavern-emptyTitle", children: t('memory.emptyDeltas') }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: t('memory.emptyDeltasDesc') })] })), _jsxs("div", { className: "dsh-tavern-memo is-compose", children: [_jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.deltaType') }), _jsx(Select, { size: "md", value: deltaType, onChange: (v) => setDeltaType(v), options: [
                                                            { value: 'add', label: t(DELTA_TYPE_KEY.add) },
                                                            { value: 'update', label: t(DELTA_TYPE_KEY.update) },
                                                            { value: 'invalidate', label: t(DELTA_TYPE_KEY.invalidate) },
                                                        ] })] }), (deltaType === 'update' || deltaType === 'invalidate') && (_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.deltaRef') }), _jsx("input", { className: "dsh-tavern-input", value: deltaRef, onChange: (e) => setDeltaRef(e.target.value) })] }))] }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 60, marginTop: 8 }, placeholder: t('memory.deltaBodyPlaceholder'), value: deltaContent, onChange: (e) => setDeltaContent(e.target.value) }), _jsxs("label", { className: "dsh-tavern-field", style: { marginTop: 8 }, children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.deltaKeys') }), _jsx("input", { className: "dsh-tavern-input", value: deltaKeys, onChange: (e) => setDeltaKeys(e.target.value) })] }), _jsx("div", { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 }, children: _jsx(Btn, { primary: true, disabled: !deltaContent.trim(), onClick: () => void addDelta(), children: t('memory.addDelta') }) })] })] })), tab === 'journal' && (_jsxs("div", { className: "dsh-tavern-list", children: [_jsx(Muted, { children: t('memory.journalHint') }), journal.state.status === 'ready' ? (_jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 180 }, value: journalText, onChange: (e) => setJournalText(e.target.value) })) : journal.state.status === 'error' ? (_jsx(Err, { message: journal.state.message })) : (_jsx(Skeleton, { height: 180 })), _jsx("div", { style: { display: 'flex', justifyContent: 'flex-end' }, children: _jsx(Btn, { primary: true, disabled: journal.state.status !== 'ready' || !cardId, onClick: () => void saveJournal(), children: t('memory.saveJournal') }) })] }))] }))] }));
}
