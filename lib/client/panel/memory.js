import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 设置面板分区：记忆与世界状态（按角色卡查看 / 编辑 / 压缩 / 导出）。
 * 记忆/世界状态切换用 chip 段控；条目为 .dsh-tavern-memo 卡片（meta 行 + 正文 + IconBtn 操作）。
 * 压缩/导出等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useDraftGuard } from '../drafts.js';
import { PersistentEditor, useDraftRestored, useDraftState } from '../draftPersistence.js';
import { useEffect, useRef, useState } from 'react';
import { IconEditOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { useT } from '../i18n.js';
import { Badge, Btn, ConfirmDialog, Err, IconBtn, Muted, Section, Select, SettingsRow, Skeleton, downloadJson, errOf, runAsync, useLoader, useToast } from '../util.js';
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
    const draftKey = `memory:entry:${JSON.stringify([props.cardId, props.storyId ?? null, entry.id])}`;
    const [body, setBody] = useDraftState(`${draftKey}:body`, entry.body);
    const [tags, setTags] = useDraftState(`${draftKey}:tags`, entry.tags.join(', '));
    const [keys, setKeys] = useDraftState(`${draftKey}:keys`, entry.keys.join(', '));
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const guard = useDraftGuard(body !== entry.body || tags !== entry.tags.join(', ') || keys !== entry.keys.join(', '), busy);
    const save = () => runAsync(setBusy, setError, async () => {
        const r = await props.remote.saveMemory({
            cardId: props.cardId,
            storyId: props.storyId,
            id: entry.id,
            body,
            tags: splitList(tags),
            keys: splitList(keys),
        });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            setTags(splitList(tags).join(', '));
            setKeys(splitList(keys).join(', '));
            props.onDone();
        }
    });
    const cancel = () => guard.request(() => {
        setBody(entry.body);
        setTags(entry.tags.join(', '));
        setKeys(entry.keys.join(', '));
        props.onDone();
    });
    return (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }, children: [guard.confirmation, _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", disabled: busy, value: body, onChange: (e) => setBody(e.target.value) }), _jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.tags') }), _jsx("input", { className: "dsh-tavern-input", disabled: busy, value: tags, onChange: (e) => setTags(e.target.value) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.keys') }), _jsx("input", { className: "dsh-tavern-input", disabled: busy, value: keys, onChange: (e) => setKeys(e.target.value) })] })] }), _jsx(Err, { message: error }), _jsxs("div", { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' }, children: [_jsx(Btn, { disabled: busy, onClick: cancel, children: t('action.cancel') }), _jsx(Btn, { primary: true, disabled: busy || !body.trim(), onClick: () => void save(), children: t('action.save') })] })] }));
}
/** 聊天入口独立使用剧情草稿范围；设置面板已有范围时复用父级存储与恢复提示。 */
export function MemorySection(props) {
    const scope = `memory:${props.initialContext ? JSON.stringify([props.initialContext.cardId, props.initialContext.storyId]) : 'panel'}`;
    return _jsx(PersistentEditor, { remote: props.remote, scope: scope, children: _jsx(MemorySelection, { ...props }) });
}
function MemorySelection(props) {
    const [cardId, setCardId] = useDraftState('memory:cardId', props.initialContext?.cardId ?? '');
    // 空字符串可在 JSON 中保留“初始状态”选择；undefined 会丢键，恢复时误回落聊天入口原剧情。
    const [storedStoryId, setStoredStoryId] = useDraftState('memory:storyId', props.initialContext?.storyId ?? '');
    const storyId = storedStoryId || undefined;
    // 剧情切换必须重建所有编辑状态：禁止旧 journal 查询或旧字段值进入新剧情。
    return _jsx(MemoryContextSection, { remote: props.remote, cardId: cardId, storyId: storyId, setCardId: setCardId, setStoryId: (value) => setStoredStoryId(value ?? '') }, JSON.stringify([cardId, storyId ?? null]));
}
function MemoryContextSection(props) {
    const { remote } = props;
    const { cardId, storyId, setCardId, setStoryId } = props;
    const t = useT();
    const chars = useLoader(() => remote.listCharacters({}), []);
    const stories = useLoader(() => remote.listStories({ cardId }), [cardId], cardId !== '');
    const draftKey = `memory:context:${JSON.stringify([cardId, storyId ?? null])}`;
    const [tab, setTab] = useDraftState(`${draftKey}:tab`, 'memory');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [deleteId, setDeleteId] = useState(null);
    const [editingId, setEditingId] = useDraftState(`${draftKey}:editingId`, null);
    const [newBody, setNewBody] = useDraftState(`${draftKey}:newBody`, '');
    const [journalText, setJournalText] = useDraftState(`${draftKey}:journalText`, '');
    const journalRestored = useDraftRestored(`${draftKey}:journalText`);
    const firstJournal = useRef(true);
    const [deltaType, setDeltaType] = useDraftState(`${draftKey}:deltaType`, 'add');
    const [deltaContent, setDeltaContent] = useDraftState(`${draftKey}:deltaContent`, '');
    const [deltaRef, setDeltaRef] = useDraftState(`${draftKey}:deltaRef`, '');
    const [deltaKeys, setDeltaKeys] = useDraftState(`${draftKey}:deltaKeys`, '');
    const toast = useToast();
    const memories = useLoader(() => remote.getMemories({ cardId, storyId }), [cardId, storyId], cardId !== '');
    const deltas = useLoader(() => remote.getWorldDeltas({ cardId, storyId }), [cardId, storyId], cardId !== '');
    const journal = useLoader(() => remote.getJournal({ cardId, storyId }), [cardId, storyId], cardId !== '');
    /**
     * 写操作统一外壳：busy 防连击（快速双击重复创建/并发压缩）；
     * 错误信封进 Err（上下文），传输/zod 严格校验的 reject 落 toast，不留未处理 rejection。
     */
    const op = (fn) => runAsync(setBusy, setError, fn, (message) => toast.show(t('memory.opFailed', { message })));
    const journalDirty = journal.state.status === 'ready' && journalText !== journal.state.value.text;
    const guard = useDraftGuard(journalDirty || !!newBody.trim() || !!deltaContent.trim() || !!deltaRef.trim() || !!deltaKeys.trim(), busy);
    const charItems = chars.state.status === 'ready' ? chars.state.value.items : [];
    const memoryItems = memories.state.status === 'ready' ? memories.state.value.items : [];
    const deltaItems = deltas.state.status === 'ready' ? deltas.state.value.items : [];
    // keyed 上下文首挂时字段已从对应剧情恢复；首次查询不能覆盖它，后续保存重拉正常同步。
    useEffect(() => {
        if (journal.state.status !== 'ready')
            return;
        if (!firstJournal.current || !journalRestored)
            setJournalText(journal.state.value.text);
        firstJournal.current = false;
    }, [journal.state]);
    useEffect(() => {
        // 恢复期间条目可能已被其他窗口删除；释放选择器，避免不存在的编辑器永久锁住上下文。
        if (memories.state.status === 'ready' && editingId !== null && !memories.state.value.items.some((entry) => entry.id === editingId)) {
            setEditingId(null);
        }
    }, [memories.state, editingId]);
    const addMemory = () => op(async () => {
        const r = await remote.saveMemory({ cardId, storyId, body: newBody.trim() });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            setNewBody('');
            memories.reload();
        }
    });
    const deleteMemory = (id) => op(async () => {
        const r = await remote.deleteMemory({ cardId, storyId, id });
        const err = errOf(r);
        if (err)
            setError(err);
        else
            memories.reload();
    });
    const compress = () => op(async () => {
        const r = await remote.compressMemories({ cardId, storyId });
        if (!r.ok)
            setError(r.error.message);
        else {
            toast.show(r.value.merged > 0 ? t('memory.compressed', { count: r.value.merged }) : t('memory.compressNoop'));
            memories.reload();
        }
    });
    const revoke = (id) => op(async () => {
        const r = await remote.revokeWorldDelta({ cardId, storyId, id });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            toast.show(t('memory.revokeDone', { id }));
            deltas.reload();
        }
    });
    const exportBook = () => op(async () => {
        const r = await remote.exportMergedLorebook({ cardId, storyId });
        if (!r.ok)
            setError(r.error.message);
        else {
            downloadJson(`lorebook-merged-${cardId}.json`, r.value.json);
            toast.show(t('memory.bookExported'));
        }
    });
    const saveJournal = () => op(async () => {
        const r = await remote.saveJournal({ cardId, storyId, text: journalText });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            toast.show(t('memory.journalSaved'));
            journal.reload();
        }
    });
    const addDelta = () => op(async () => {
        const r = await remote.addWorldDelta({
            cardId, storyId,
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
    });
    return (_jsxs(Section, { title: t('section.memory'), description: t('memory.desc'), children: [toast.node, guard.confirmation, _jsx(ConfirmDialog, { open: deleteId !== null, title: t('memory.deleteEntry'), description: t('memory.deleteConfirm'), confirmLabel: t('action.delete'), danger: true, busy: busy, onCancel: () => { if (!busy)
                    setDeleteId(null); }, onConfirm: () => { if (deleteId)
                    void deleteMemory(deleteId).then(() => setDeleteId(null)); } }), _jsx(SettingsRow, { title: t('memory.character'), description: t('memory.characterDesc'), children: _jsx(Select, { size: "md", value: cardId, disabled: busy || editingId !== null, onChange: (value) => guard.request(() => { setStoryId(undefined); setCardId(value); }), options: [{ value: '', label: t('memory.pickCharacter') }, ...charItems.map((c) => ({ value: c.cardId, label: c.name }))] }) }), cardId && _jsx(SettingsRow, { title: t('memory.story'), description: t('memory.storyDesc'), children: _jsx(Select, { value: storyId ?? '', disabled: busy || editingId !== null, onChange: (value) => guard.request(() => setStoryId(value || undefined)), options: [{ value: '', label: t('memory.initialState') }, ...(stories.state.status === 'ready' ? stories.state.value.items.map((story, index) => ({ value: story.id, label: t('memory.storyLabel', { index: index + 1, date: story.createdAt.slice(0, 10) }) })) : [])] }) }), cardId && _jsxs("div", { className: "dsh-tavern-storyContext", role: "status", children: [_jsxs("div", { className: "dsh-tavern-storyContextTitle", children: [_jsx("strong", { children: charItems.find((c) => c.cardId === cardId)?.name ?? t('memory.character') }), _jsx(Badge, { accent: !!storyId, children: t(storyId ? 'memory.scopeStory' : 'memory.scopeInitial') })] }), _jsx("span", { children: t(storyId ? 'memory.scopeStoryDesc' : 'memory.scopeInitialDesc') }), storyId && _jsx("span", { className: "dsh-tavern-muted", children: stories.state.status === 'ready'
                            ? stories.state.value.items.find((s) => s.id === storyId)?.sessionId ?? storyId : storyId })] }), _jsx(Err, { message: stories.state.status === 'error' ? stories.state.message : error }), cardId && (_jsxs(_Fragment, { children: [_jsxs("div", { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, margin: '10px 0 14px' }, children: [_jsxs("div", { className: "dsh-tavern-filters", children: [_jsx("button", { type: "button", className: "dsh-tavern-chip", "data-active": tab === 'memory' ? 'true' : 'false', disabled: busy || editingId !== null, onClick: () => setTab('memory'), children: t('memory.tab.memory', { count: memoryItems.length }) }), _jsx("button", { type: "button", className: "dsh-tavern-chip", "data-active": tab === 'delta' ? 'true' : 'false', disabled: busy || editingId !== null, onClick: () => setTab('delta'), children: t('memory.tab.delta', { count: deltaItems.length }) }), _jsx("button", { type: "button", className: "dsh-tavern-chip", "data-active": tab === 'journal' ? 'true' : 'false', disabled: busy || editingId !== null, onClick: () => setTab('journal'), children: t('memory.tab.journal') })] }), _jsx("span", { style: { flex: 1 } }), tab === 'memory' && _jsx(Btn, { disabled: busy, onClick: () => void compress(), children: t('memory.compressOldest') }), tab === 'delta' && _jsx(Btn, { disabled: busy, onClick: () => void exportBook(), children: t('memory.exportBook') })] }), tab === 'memory' && (_jsxs("div", { className: "dsh-tavern-list", children: [memories.state.status === 'loading' && (_jsxs(_Fragment, { children: [_jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 })] })), memories.state.status === 'error' && _jsx(Err, { message: memories.state.message }), memoryItems.length === 0 && memories.state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty is-compact", children: [_jsx("div", { className: "dsh-tavern-emptyTitle", children: t('memory.emptyMemories') }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: t('memory.emptyMemoriesDesc') })] })), memoryItems.map((m) => (_jsxs("div", { className: "dsh-tavern-memo", children: [_jsxs("div", { className: "dsh-tavern-memoHead", children: [_jsx(Badge, { children: m.id }), m.archived ? _jsx(Badge, { children: t('memory.archived') }) : null, m.tags.map((tag) => (_jsx(Badge, { children: tag }, tag))), _jsx("span", { className: "dsh-tavern-memoMeta", children: m.updated }), _jsxs("span", { className: "dsh-tavern-memoActions", children: [_jsx(IconBtn, { disabled: editingId !== null || busy, label: t('action.edit'), onClick: () => setEditingId(editingId === m.id ? null : m.id), children: _jsx(IconEditOutline16, {}) }), _jsx(IconBtn, { label: t('memory.deleteEntry'), danger: true, disabled: busy || editingId !== null, onClick: () => setDeleteId(m.id), children: _jsx(IconTrashOutline16, {}) })] })] }), _jsx("pre", { className: "dsh-tavern-memoBody dsh-tavern-scroll", children: m.body }), editingId === m.id && (_jsx(MemoryEditor, { remote: remote, cardId: cardId, storyId: storyId, entry: m, onDone: () => {
                                            setEditingId(null);
                                            memories.reload();
                                        } }))] }, m.id))), _jsxs("div", { className: "dsh-tavern-memo is-compose", children: [_jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 60 }, placeholder: t('memory.newPlaceholder'), disabled: busy, value: newBody, onChange: (e) => setNewBody(e.target.value) }), _jsx("div", { style: { display: 'flex', justifyContent: 'flex-end' }, children: _jsx(Btn, { primary: true, disabled: busy || !newBody.trim(), onClick: () => void addMemory(), children: t('memory.addEntry') }) })] })] })), tab === 'delta' && (_jsxs("div", { className: "dsh-tavern-list", children: [deltas.state.status === 'loading' && (_jsxs(_Fragment, { children: [_jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 })] })), deltas.state.status === 'error' && _jsx(Err, { message: deltas.state.message }), deltaItems.map((d) => (_jsxs("div", { className: `dsh-tavern-memo${d.revoked ? ' is-revoked' : ''}`, children: [_jsxs("div", { className: "dsh-tavern-memoHead", children: [_jsxs(Badge, { children: ["#", d.id] }), _jsx(Badge, { danger: d.type === 'invalidate', children: t(DELTA_TYPE_KEY[d.type]) }), d.ref ? _jsxs(Badge, { children: ["\u2192 ", d.ref] }) : null, d.revoked ? _jsx(Badge, { danger: true, children: t('memory.revoked') }) : null, _jsx("span", { className: "dsh-tavern-memoMeta", children: d.ts }), !d.revoked && (_jsx("span", { className: "dsh-tavern-memoActions", children: _jsx(Btn, { size: "sm", disabled: busy, onClick: () => void revoke(d.id), children: t('memory.revoke') }) }))] }), _jsx("pre", { className: "dsh-tavern-memoBody dsh-tavern-scroll", children: d.content })] }, d.id))), deltaItems.length === 0 && deltas.state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty is-compact", children: [_jsx("div", { className: "dsh-tavern-emptyTitle", children: t('memory.emptyDeltas') }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: t('memory.emptyDeltasDesc') })] })), _jsxs("div", { className: "dsh-tavern-memo is-compose", children: [_jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.deltaType') }), _jsx(Select, { size: "md", value: deltaType, onChange: (v) => setDeltaType(v), options: [
                                                            { value: 'add', label: t(DELTA_TYPE_KEY.add) },
                                                            { value: 'update', label: t(DELTA_TYPE_KEY.update) },
                                                            { value: 'invalidate', label: t(DELTA_TYPE_KEY.invalidate) },
                                                        ] })] }), (deltaType === 'update' || deltaType === 'invalidate') && (_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.deltaRef') }), _jsx("input", { className: "dsh-tavern-input", value: deltaRef, onChange: (e) => setDeltaRef(e.target.value) })] }))] }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 60, marginTop: 8 }, placeholder: t('memory.deltaBodyPlaceholder'), disabled: busy, value: deltaContent, onChange: (e) => setDeltaContent(e.target.value) }), _jsxs("label", { className: "dsh-tavern-field", style: { marginTop: 8 }, children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.deltaKeys') }), _jsx("input", { className: "dsh-tavern-input", value: deltaKeys, onChange: (e) => setDeltaKeys(e.target.value) })] }), _jsx("div", { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 }, children: _jsx(Btn, { primary: true, disabled: busy || !deltaContent.trim(), onClick: () => void addDelta(), children: t('memory.addDelta') }) })] })] })), tab === 'journal' && (_jsxs("div", { className: "dsh-tavern-list", children: [_jsx(Muted, { children: t('memory.journalHint') }), journal.state.status === 'ready' ? (_jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 180 }, disabled: busy, value: journalText, onChange: (e) => setJournalText(e.target.value) })) : journal.state.status === 'error' ? (_jsx(Err, { message: journal.state.message })) : (_jsx(Skeleton, { height: 180 })), _jsx("div", { style: { display: 'flex', justifyContent: 'flex-end' }, children: _jsx(Btn, { primary: true, disabled: busy || !journalDirty || journal.state.status !== 'ready' || !cardId, onClick: () => void saveJournal(), children: t('memory.saveJournal') }) })] }))] }))] }));
}
