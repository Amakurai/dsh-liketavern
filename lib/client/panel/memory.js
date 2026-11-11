import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 设置面板分区：记忆与世界状态（按角色卡查看 / 编辑 / 压缩 / 导出）。
 * 记忆/世界状态切换用 chip 段控；条目为 .dsh-tavern-memo 卡片（meta 行 + 正文 + IconBtn 操作）。
 * 压缩/导出等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { cachedSessionBinding } from '../cache.js';
import { useDraftGuard } from '../drafts.js';
import { PersistentEditor, useDraftRestored, useDraftState } from '../draftPersistence.js';
import { useEffect, useMemo, useRef, useState } from 'react';
import { IconEditOutlineMedium, IconTrashOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives';
import { estimateTokens } from '../../core/tokenize.js';
import { JOURNAL_TURN_TOKEN_BUDGET } from '../../core/turnBudget.js';
import { useT } from '../i18n.js';
import { currentTavernSession } from '../sessionViews.js';
import { Badge, Btn, ConfirmDialog, Err, IconBtn, Muted, SearchEmpty, SearchInput, Section, Select, SettingsRow, Skeleton, downloadJson, errOf, joinListText, runAsync, splitListText, useLoader, useToast } from '../util.js';
/** 变化层类型徽标/选项对应的 i18n 键；渲染处经 t() 取文案。 */
const DELTA_TYPE_KEY = { add: 'memory.deltaType.add', update: 'memory.deltaType.update', invalidate: 'memory.deltaType.invalidate' };
function MemoryEditor(props) {
    const { entry } = props;
    const t = useT();
    const draftKey = `memory:entry:${JSON.stringify([props.cardId, props.storyId ?? null, entry.id])}`;
    const [body, setBody] = useDraftState(`${draftKey}:body`, entry.body);
    const [tags, setTags] = useDraftState(`${draftKey}:tags`, joinListText(entry.tags));
    const [keys, setKeys] = useDraftState(`${draftKey}:keys`, joinListText(entry.keys));
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const saving = useRef(false);
    const guard = useDraftGuard(body !== entry.body || tags !== joinListText(entry.tags) || keys !== joinListText(entry.keys), busy);
    const save = async () => {
        if (saving.current || !body.trim())
            return;
        saving.current = true;
        try {
            await runAsync(setBusy, setError, async () => {
                const r = await props.remote.saveMemory({
                    cardId: props.cardId,
                    storyId: props.storyId,
                    id: entry.id,
                    body,
                    tags: splitListText(tags),
                    keys: splitListText(keys),
                });
                const err = errOf(r);
                if (err)
                    setError(err);
                else {
                    setTags(joinListText(splitListText(tags)));
                    setKeys(joinListText(splitListText(keys)));
                    guard.clearDraft();
                    props.onDone();
                }
            });
        }
        finally {
            saving.current = false;
        }
    };
    const cancel = () => {
        if (saving.current)
            return;
        guard.request(() => {
            setBody(entry.body);
            setTags(joinListText(entry.tags));
            setKeys(joinListText(entry.keys));
            props.onDone();
        });
    };
    return (_jsxs("div", { style: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }, children: [guard.confirmation, _jsx("textarea", { "aria-label": t('memory.entryBody'), className: "dsh-tavern-input dsh-tavern-textarea", disabled: busy, value: body, onChange: (e) => setBody(e.target.value) }), _jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.tags') }), _jsx("input", { className: "dsh-tavern-input", disabled: busy, value: tags, onChange: (e) => setTags(e.target.value) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.keys') }), _jsx("input", { className: "dsh-tavern-input", disabled: busy, value: keys, onChange: (e) => setKeys(e.target.value) })] })] }), _jsx(Err, { message: error }), _jsxs("div", { style: { display: 'flex', gap: 8, justifyContent: 'flex-end' }, children: [_jsx(Btn, { disabled: busy, onClick: cancel, children: t('action.cancel') }), _jsx(Btn, { primary: true, disabled: busy || !body.trim(), onClick: () => void save(), children: t('action.save') })] })] }));
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
    const cardRestored = useDraftRestored('memory:cardId');
    const storyRestored = useDraftRestored('memory:storyId');
    const activeSessionId = currentTavernSession();
    const prefilled = useRef(false);
    useEffect(() => {
        if (props.initialContext || cardRestored || storyRestored || prefilled.current || cardId)
            return;
        if (!activeSessionId || typeof props.remote.getSessionBinding !== 'function')
            return;
        prefilled.current = true;
        let alive = true;
        void cachedSessionBinding(props.remote, activeSessionId).then((r) => {
            if (!alive || !r.ok || !r.value.binding?.cardId)
                return;
            setCardId((prev) => prev || r.value.binding.cardId);
            if (r.value.binding.storyId)
                setStoredStoryId((prev) => prev || r.value.binding.storyId);
        }).catch(() => { });
        return () => { alive = false; };
    }, [props.initialContext, props.remote, cardRestored, storyRestored, cardId, activeSessionId, setCardId, setStoredStoryId]);
    const storyId = storedStoryId || undefined;
    // 剧情切换必须重建所有编辑状态：禁止旧 journal 查询或旧字段值进入新剧情。
    return _jsx(MemoryContextSection, { remote: props.remote, cardId: cardId, storyId: storyId, initialTab: props.initialTab, activeSessionId: activeSessionId, setCardId: setCardId, setStoryId: (value) => setStoredStoryId(value ?? '') }, JSON.stringify([cardId, storyId ?? null]));
}
function MemoryContextSection(props) {
    const { remote } = props;
    const { cardId, storyId, activeSessionId, setCardId, setStoryId } = props;
    const t = useT();
    const chars = useLoader(() => remote.listCharacters({}), []);
    const stories = useLoader(() => remote.listStories({ cardId }), [cardId], cardId !== '');
    const draftKey = `memory:context:${JSON.stringify([cardId, storyId ?? null])}`;
    const [tab, setTab] = useDraftState(`${draftKey}:tab`, props.initialTab ?? 'memory');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [deleteId, setDeleteId] = useState(null);
    const [editingId, setStoredEditingId] = useDraftState(`${draftKey}:editingId`, null);
    // 同批事件也要看到刚打开的编辑器；父列表重载会卸载子编辑器并丢掉其正文。
    const editing = useRef(editingId);
    editing.current = editingId;
    const pending = useRef(false);
    const setEditingId = (id) => { editing.current = id; setStoredEditingId(id); };
    const [newBody, setNewBody] = useDraftState(`${draftKey}:newBody`, '');
    const [newTags, setNewTags] = useDraftState(`${draftKey}:newTags`, '');
    const [newKeys, setNewKeys] = useDraftState(`${draftKey}:newKeys`, '');
    const [memoryQuery, setMemoryQuery] = useState('');
    const [memoryFilter, setMemoryFilter] = useState('all');
    const [deltaQuery, setDeltaQuery] = useState('');
    const [deltaFilter, setDeltaFilter] = useState('all');
    const [journalText, setJournalText] = useDraftState(`${draftKey}:journalText`, '');
    const [journalRevision, setJournalRevision] = useDraftState(`${draftKey}:journalRevision`, null);
    const journalRestored = useDraftRestored(`${draftKey}:journalText`);
    // 只保留已保存标记，避免为并发基线再复制整份笔记、挤占自动草稿的体积预算；旧草稿未知则保守保护。
    const [journalUnsaved, setJournalUnsaved] = useDraftState(`${draftKey}:journalUnsaved`, journalRestored ? null : false);
    const firstJournal = useRef(true);
    const [confirmJournalReload, setConfirmJournalReload] = useState(false);
    const [deltaType, setDeltaType] = useDraftState(`${draftKey}:deltaType`, 'add');
    const [deltaContent, setDeltaContent] = useDraftState(`${draftKey}:deltaContent`, '');
    const [deltaRef, setDeltaRef] = useDraftState(`${draftKey}:deltaRef`, '');
    const [deltaKeys, setDeltaKeys] = useDraftState(`${draftKey}:deltaKeys`, '');
    const toast = useToast();
    const memories = useLoader(() => remote.getMemories({ cardId, storyId }), [cardId, storyId], cardId !== '');
    const deltas = useLoader(() => remote.getWorldDeltas({ cardId, storyId }), [cardId, storyId], cardId !== '');
    const journal = useLoader(() => remote.getJournal({ cardId, storyId }), [cardId, storyId], cardId !== '');
    // 回滚恢复未完成时整个剧情拒绝写入；这里给出可见状态与受控重置出口，避免永久卡死。
    const recovery = useLoader(() => remote.getStoryRecovery({ cardId, storyId }), [cardId, storyId], cardId !== '');
    const [confirmReset, setConfirmReset] = useState(false);
    const recoveringFloors = recovery.state.status === 'ready' ? recovery.state.value.floors : [];
    /**
     * 写操作统一外壳：busy 防连击（快速双击重复创建/并发压缩）；
     * 错误信封进 Err（上下文），传输/zod 严格校验的 reject 落 toast，不留未处理 rejection。
     */
    const op = async (fn) => {
        if (pending.current || editing.current !== null)
            return;
        pending.current = true;
        try {
            await runAsync(setBusy, setError, fn, (message) => toast.show(t('memory.opFailed', { message })));
        }
        finally {
            pending.current = false;
        }
    };
    const journalDirty = journal.state.status === 'ready' && journalText !== journal.state.value.text;
    const guard = useDraftGuard(journalDirty || !!newBody.trim() || !!newTags.trim() || !!newKeys.trim() || !!deltaContent.trim() || !!deltaRef.trim() || !!deltaKeys.trim(), busy);
    const charItems = chars.state.status === 'ready' ? chars.state.value.items : [];
    const memoryItems = memories.state.status === 'ready' ? memories.state.value.items : [];
    const deltaItems = deltas.state.status === 'ready' ? deltas.state.value.items : [];
    const { activeMemoryCount, archivedMemoryCount, filteredMemories } = useMemo(() => {
        let active = 0;
        let archived = 0;
        for (const m of memoryItems) {
            if (m.archived)
                archived++;
            else
                active++;
        }
        const q = memoryQuery.trim().toLowerCase();
        const list = memoryItems.filter((m) => {
            if (memoryFilter === 'active' && m.archived)
                return false;
            if (memoryFilter === 'archived' && !m.archived)
                return false;
            if (!q)
                return true;
            return `${m.id}\n${m.body}\n${m.tags.join(' ')}\n${m.keys.join(' ')}`.toLowerCase().includes(q);
        });
        return { activeMemoryCount: active, archivedMemoryCount: archived, filteredMemories: list };
    }, [memoryItems, memoryFilter, memoryQuery]);
    const { activeDeltaCount, revokedDeltaCount, filteredDeltas } = useMemo(() => {
        let active = 0;
        let revoked = 0;
        for (const d of deltaItems) {
            if (d.revoked)
                revoked++;
            else
                active++;
        }
        const q = deltaQuery.trim().toLowerCase();
        const list = deltaItems.filter((d) => {
            if (deltaFilter === 'active' && d.revoked)
                return false;
            if (deltaFilter === 'revoked' && !d.revoked)
                return false;
            if (!q)
                return true;
            return `${d.id}\n${d.content}\n${d.ref ?? ''}\n${d.keys.join(' ')}`.toLowerCase().includes(q);
        });
        return { activeDeltaCount: active, revokedDeltaCount: revoked, filteredDeltas: list };
    }, [deltaItems, deltaFilter, deltaQuery]);
    const journalTokens = useMemo(() => estimateTokens(journalText), [journalText]);
    const journalOverBudget = journalTokens > JOURNAL_TURN_TOKEN_BUDGET;
    // keyed 上下文首挂时字段已从对应剧情恢复；首次查询不能覆盖它，后续保存重拉正常同步。
    useEffect(() => {
        if (journal.state.status !== 'ready')
            return;
        if (!firstJournal.current || !journalRestored || journalUnsaved === false) {
            setJournalText(journal.state.value.text);
            setJournalRevision(journal.state.value.revision);
            setJournalUnsaved(false);
        }
        firstJournal.current = false;
    }, [journal.state]);
    useEffect(() => {
        // 恢复期间条目可能已被其他窗口删除；释放选择器，避免不存在的编辑器永久锁住上下文。
        if (memories.state.status === 'ready' && editingId !== null && !memories.state.value.items.some((entry) => entry.id === editingId)) {
            setEditingId(null);
        }
    }, [memories.state, editingId]);
    const addMemory = () => op(async () => {
        const tags = splitListText(newTags);
        const keys = splitListText(newKeys);
        const r = await remote.saveMemory({
            cardId,
            storyId,
            body: newBody.trim(),
            ...(tags.length > 0 ? { tags } : {}),
            ...(keys.length > 0 ? { keys } : {}),
        });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            setNewBody('');
            setNewTags('');
            setNewKeys('');
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
        if (!journalRevision) {
            setError(t('memory.journalMissingRevision'));
            return;
        }
        const r = await remote.saveJournal({ cardId, storyId, text: journalText, expectedRevision: journalRevision });
        if (!r.ok)
            setError(r.error.message);
        else {
            setJournalRevision(r.value.revision);
            setJournalUnsaved(false);
            toast.show(t('memory.journalSaved'));
            journal.reload();
        }
    });
    // 只放弃笔记，不清除同一剧情中尚未提交的新记忆或世界状态草稿。
    const reloadJournal = () => {
        if (pending.current || editing.current !== null)
            return;
        firstJournal.current = false;
        setError(null);
        journal.reload();
    };
    const addDelta = () => op(async () => {
        const r = await remote.addWorldDelta({
            cardId, storyId,
            type: deltaType,
            content: deltaContent.trim(),
            ref: deltaRef.trim() || null,
            keys: splitListText(deltaKeys),
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
    const resetRecovery = () => op(async () => {
        const r = await remote.resetStoryRecovery({ cardId, storyId });
        const err = errOf(r);
        if (err)
            setError(err);
        else
            toast.show(t('memory.recoveryReset', { count: r.ok ? r.value.reset.length : 0 }));
        recovery.reload();
    });
    return (_jsxs(Section, { title: t('section.memory'), description: t('memory.desc'), children: [toast.node, guard.confirmation, _jsx(ConfirmDialog, { open: deleteId !== null, title: t('memory.deleteEntry'), description: t('memory.deleteConfirm'), confirmLabel: t('action.delete'), danger: true, busy: busy, onCancel: () => { if (!busy)
                    setDeleteId(null); }, onConfirm: () => { if (deleteId)
                    void deleteMemory(deleteId).then(() => setDeleteId(null)); } }), _jsx(ConfirmDialog, { open: confirmReset, title: t('memory.resetRecovery'), description: t('memory.resetRecoveryConfirm'), confirmLabel: t('memory.resetRecovery'), danger: true, busy: busy, onCancel: () => { if (!busy)
                    setConfirmReset(false); }, onConfirm: () => void resetRecovery().then(() => setConfirmReset(false)) }), _jsx(ConfirmDialog, { open: confirmJournalReload, title: t('memory.reloadJournal'), description: t('memory.reloadJournalConfirm'), confirmLabel: t('memory.reloadJournal'), danger: true, busy: busy, onCancel: () => setConfirmJournalReload(false), onConfirm: () => { if (pending.current)
                    return; setConfirmJournalReload(false); reloadJournal(); } }), _jsx(SettingsRow, { title: t('memory.character'), description: t('memory.characterDesc'), children: _jsx(Select, { size: "md", value: cardId, disabled: busy || editingId !== null || chars.state.status !== 'ready', onChange: (value) => guard.request(() => { setStoryId(undefined); setCardId(value); }), options: [{ value: '', label: t('memory.pickCharacter') }, ...charItems.map((c) => ({ value: c.cardId, label: c.name }))] }) }), cardId && _jsx(SettingsRow, { title: t('memory.story'), description: t('memory.storyDesc'), children: _jsx(Select, { value: storyId ?? '', disabled: busy || editingId !== null || stories.state.status !== 'ready', onChange: (value) => guard.request(() => setStoryId(value || undefined)), options: [{ value: '', label: t('memory.initialState') }, ...(stories.state.status === 'ready' ? stories.state.value.items.map((story, index) => ({
                            value: story.id,
                            label: t(activeSessionId && story.sessionId === activeSessionId ? 'memory.storyLabelCurrent' : 'memory.storyLabel', { index: index + 1, date: story.createdAt.slice(0, 10) }),
                        })) : [])] }) }), cardId && _jsxs("div", { className: "dsh-tavern-storyContext", role: "status", children: [_jsxs("div", { className: "dsh-tavern-storyContextTitle", children: [_jsx("strong", { children: charItems.find((c) => c.cardId === cardId)?.name ?? t('memory.character') }), _jsx(Badge, { accent: !!storyId, children: t(storyId ? 'memory.scopeStory' : 'memory.scopeInitial') })] }), _jsx("span", { children: t(storyId ? 'memory.scopeStoryDesc' : 'memory.scopeInitialDesc') }), storyId && _jsx("span", { className: "dsh-tavern-muted", children: stories.state.status === 'ready'
                            ? stories.state.value.items.find((s) => s.id === storyId)?.sessionId ?? storyId : storyId })] }), cardId && recoveringFloors.length > 0 && _jsxs("div", { role: "alert", className: "dsh-tavern-storyContext", children: [_jsx("strong", { children: t('memory.recovering', { floors: recoveringFloors.join(', ') }) }), _jsx(Muted, { children: t('memory.recoveringDesc') }), _jsx(Btn, { disabled: busy, onClick: () => setConfirmReset(true), children: t('memory.resetRecovery') })] }), _jsx(Err, { message: chars.state.status === 'error' ? chars.state.message : stories.state.status === 'error' ? stories.state.message : error }), chars.state.status === 'error' && _jsx(Btn, { disabled: busy, onClick: chars.reload, children: t('action.retry') }), stories.state.status === 'error' && _jsx(Btn, { disabled: busy, onClick: stories.reload, children: t('action.retry') }), cardId && (_jsxs(_Fragment, { children: [_jsxs("div", { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, margin: '10px 0 14px' }, children: [_jsxs("div", { className: "dsh-tavern-filters", role: "group", "aria-label": t('section.memory'), children: [_jsx("button", { type: "button", "aria-pressed": tab === 'memory', className: "dsh-tavern-chip", "data-active": tab === 'memory' ? 'true' : 'false', disabled: busy || editingId !== null, onClick: () => setTab('memory'), children: t('memory.tab.memory', { count: memoryItems.length }) }), _jsx("button", { type: "button", "aria-pressed": tab === 'delta', className: "dsh-tavern-chip", "data-active": tab === 'delta' ? 'true' : 'false', disabled: busy || editingId !== null, onClick: () => setTab('delta'), children: t('memory.tab.delta', { count: deltaItems.length }) }), _jsx("button", { type: "button", "aria-pressed": tab === 'journal', className: "dsh-tavern-chip", "data-active": tab === 'journal' ? 'true' : 'false', disabled: busy || editingId !== null, onClick: () => setTab('journal'), children: t('memory.tab.journal') })] }), _jsx("span", { style: { flex: 1 } }), tab === 'memory' && _jsx(Btn, { disabled: busy || editingId !== null, onClick: () => void compress(), children: t('memory.compressOldest') }), tab === 'delta' && _jsx(Btn, { disabled: busy, onClick: () => void exportBook(), children: t('memory.exportBook') })] }), tab === 'memory' && (_jsxs("div", { className: "dsh-tavern-list", children: [memories.state.status === 'loading' && (_jsxs(_Fragment, { children: [_jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 })] })), memories.state.status === 'error' && _jsxs(_Fragment, { children: [_jsx(Err, { message: memories.state.message }), _jsx(Btn, { disabled: busy, onClick: memories.reload, children: t('action.retry') })] }), (memoryItems.length >= 2 || memoryQuery !== '' || memoryFilter !== 'all') && (_jsxs("div", { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }, children: [_jsx(SearchInput, { label: t('memory.searchPlaceholder'), placeholder: t('memory.searchPlaceholder'), value: memoryQuery, width: 240, onChange: setMemoryQuery }), (archivedMemoryCount > 0 || memoryFilter !== 'all') && (_jsx("div", { className: "dsh-tavern-filters", children: [
                                            ['all', t('memory.filter.all', { count: memoryItems.length })],
                                            ['active', t('memory.filter.active', { count: activeMemoryCount })],
                                            ['archived', t('memory.filter.archived', { count: archivedMemoryCount })],
                                        ].map(([id, label]) => (_jsx("button", { type: "button", className: "dsh-tavern-chip", "data-active": memoryFilter === id ? 'true' : 'false', disabled: busy || editingId !== null, onClick: () => setMemoryFilter(id), children: label }, id))) }))] })), memoryItems.length === 0 && memories.state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty is-compact", children: [_jsx("div", { className: "dsh-tavern-emptyTitle", children: t('memory.emptyMemories') }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: t('memory.emptyMemoriesDesc') })] })), memoryItems.length > 0 && filteredMemories.length === 0 && memories.state.status === 'ready' && (_jsx(SearchEmpty, { what: t('memory.noun'), query: memoryQuery.trim() || memoryFilter, onClear: () => { setMemoryQuery(''); setMemoryFilter('all'); } })), filteredMemories.map((m) => (_jsxs("div", { className: "dsh-tavern-memo", children: [_jsxs("div", { className: "dsh-tavern-memoHead", children: [_jsx(Badge, { children: m.id }), m.archived ? _jsx(Badge, { children: t('memory.archived') }) : null, m.tags.map((tag) => (_jsx(Badge, { children: tag }, tag))), _jsx("span", { className: "dsh-tavern-memoMeta", children: m.updated }), _jsxs("span", { className: "dsh-tavern-memoActions", children: [_jsx(IconBtn, { disabled: editingId !== null || busy, label: t('action.edit'), onClick: () => { if (!pending.current && editing.current === null)
                                                            setEditingId(m.id); }, children: _jsx(IconEditOutlineMedium, {}) }), _jsx(IconBtn, { label: t('memory.deleteEntry'), danger: true, disabled: busy || editingId !== null, onClick: () => setDeleteId(m.id), children: _jsx(IconTrashOutlineMedium, {}) })] })] }), _jsx("pre", { className: "dsh-tavern-memoBody dsh-tavern-scroll", children: m.body }), editingId === m.id && (_jsx(MemoryEditor, { remote: remote, cardId: cardId, storyId: storyId, entry: m, onDone: () => {
                                            setEditingId(null);
                                            memories.reload();
                                        } }))] }, m.id))), _jsxs("div", { className: "dsh-tavern-memo is-compose", children: [_jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", "aria-label": t('memory.entryBody'), style: { minHeight: 60 }, placeholder: t('memory.newPlaceholder'), disabled: busy, value: newBody, onChange: (e) => setNewBody(e.target.value) }), newBody.trim() !== '' || newTags !== '' || newKeys !== '' ? (_jsxs("div", { className: "dsh-tavern-fieldRow", style: { marginTop: 8 }, children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.tags') }), _jsx("input", { className: "dsh-tavern-input", placeholder: t('memory.newTagsPlaceholder'), disabled: busy, value: newTags, onChange: (e) => setNewTags(e.target.value) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.keys') }), _jsx("input", { className: "dsh-tavern-input", placeholder: t('memory.newKeysPlaceholder'), disabled: busy, value: newKeys, onChange: (e) => setNewKeys(e.target.value) })] })] })) : null, _jsx("div", { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 }, children: _jsx(Btn, { primary: true, disabled: busy || editingId !== null || !newBody.trim(), onClick: () => void addMemory(), children: t('memory.addEntry') }) })] })] })), tab === 'delta' && (_jsxs("div", { className: "dsh-tavern-list", children: [deltas.state.status === 'loading' && (_jsxs(_Fragment, { children: [_jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 }), _jsx(Skeleton, { height: 72 })] })), deltas.state.status === 'error' && _jsxs(_Fragment, { children: [_jsx(Err, { message: deltas.state.message }), _jsx(Btn, { disabled: busy, onClick: deltas.reload, children: t('action.retry') })] }), (deltaItems.length >= 2 || deltaQuery !== '' || deltaFilter !== 'all') && (_jsxs("div", { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }, children: [_jsx(SearchInput, { label: t('memory.deltaSearchPlaceholder'), placeholder: t('memory.deltaSearchPlaceholder'), value: deltaQuery, width: 240, onChange: setDeltaQuery }), _jsx("div", { className: "dsh-tavern-filters", children: [
                                            ['all', t('memory.deltaFilter.all', { count: deltaItems.length })],
                                            ['active', t('memory.deltaFilter.active', { count: activeDeltaCount })],
                                            ['revoked', t('memory.deltaFilter.revoked', { count: revokedDeltaCount })],
                                        ].map(([id, label]) => (_jsx("button", { type: "button", className: "dsh-tavern-chip", "data-active": deltaFilter === id ? 'true' : 'false', disabled: busy || editingId !== null, onClick: () => setDeltaFilter(id), children: label }, id))) })] })), deltaItems.length > 0 && filteredDeltas.length === 0 && deltas.state.status === 'ready' && (_jsx(SearchEmpty, { what: t('memory.deltaNoun'), query: deltaQuery.trim() || deltaFilter, onClear: () => { setDeltaQuery(''); setDeltaFilter('all'); } })), filteredDeltas.map((d) => (_jsxs("div", { className: `dsh-tavern-memo${d.revoked ? ' is-revoked' : ''}`, children: [_jsxs("div", { className: "dsh-tavern-memoHead", children: [_jsxs(Badge, { children: ["#", d.id] }), _jsx(Badge, { danger: d.type === 'invalidate', children: t(DELTA_TYPE_KEY[d.type]) }), d.ref ? _jsxs(Badge, { children: ["\u2192 ", d.ref] }) : null, d.revoked ? _jsx(Badge, { danger: true, children: t('memory.revoked') }) : null, _jsx("span", { className: "dsh-tavern-memoMeta", children: d.ts }), !d.revoked && (_jsx("span", { className: "dsh-tavern-memoActions", children: _jsx(Btn, { size: "sm", disabled: busy, onClick: () => void revoke(d.id), children: t('memory.revoke') }) }))] }), _jsx("pre", { className: "dsh-tavern-memoBody dsh-tavern-scroll", children: d.content })] }, d.id))), deltaItems.length === 0 && deltas.state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty is-compact", children: [_jsx("div", { className: "dsh-tavern-emptyTitle", children: t('memory.emptyDeltas') }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: t('memory.emptyDeltasDesc') })] })), _jsxs("div", { className: "dsh-tavern-memo is-compose", children: [_jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.deltaType') }), _jsx(Select, { size: "md", value: deltaType, disabled: busy, onChange: (v) => setDeltaType(v), options: [
                                                            { value: 'add', label: t(DELTA_TYPE_KEY.add) },
                                                            { value: 'update', label: t(DELTA_TYPE_KEY.update) },
                                                            { value: 'invalidate', label: t(DELTA_TYPE_KEY.invalidate) },
                                                        ] })] }), (deltaType === 'update' || deltaType === 'invalidate') && (_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.deltaRef') }), _jsx("input", { className: "dsh-tavern-input", disabled: busy, value: deltaRef, onChange: (e) => setDeltaRef(e.target.value) })] }))] }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", "aria-label": t('memory.deltaBodyPlaceholder'), style: { minHeight: 60, marginTop: 8 }, placeholder: t('memory.deltaBodyPlaceholder'), disabled: busy, value: deltaContent, onChange: (e) => setDeltaContent(e.target.value) }), _jsxs("label", { className: "dsh-tavern-field", style: { marginTop: 8 }, children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('memory.deltaKeys') }), _jsx("input", { className: "dsh-tavern-input", disabled: busy, value: deltaKeys, onChange: (e) => setDeltaKeys(e.target.value) })] }), _jsx("div", { style: { display: 'flex', justifyContent: 'flex-end', marginTop: 8 }, children: _jsx(Btn, { primary: true, disabled: busy || !deltaContent.trim(), onClick: () => void addDelta(), children: t('memory.addDelta') }) })] })] })), tab === 'journal' && (_jsxs("div", { className: "dsh-tavern-list", children: [_jsxs("div", { style: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 }, children: [_jsx(Muted, { children: t('memory.journalHint') }), _jsx(Badge, { accent: !journalOverBudget && journalTokens > 0, danger: journalOverBudget, children: t('memory.journalBudget', { tokens: journalTokens, limit: JOURNAL_TURN_TOKEN_BUDGET }) })] }), journalOverBudget ? (_jsx(Muted, { children: t('memory.journalBudgetExceeded', { limit: JOURNAL_TURN_TOKEN_BUDGET }) })) : null, journal.state.status === 'ready' ? (_jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", "aria-label": t('memory.tab.journal'), style: { minHeight: 180 }, disabled: busy, value: journalText, onChange: (e) => {
                                    setJournalText(e.target.value);
                                    setJournalUnsaved(journal.state.status !== 'ready' || e.target.value !== journal.state.value.text);
                                } })) : journal.state.status === 'error' ? (_jsxs(_Fragment, { children: [_jsx(Err, { message: journal.state.message }), _jsx(Btn, { disabled: busy, onClick: journal.reload, children: t('action.retry') })] })) : (_jsx(Skeleton, { height: 180 })), _jsxs("div", { style: { display: 'flex', justifyContent: 'flex-end', gap: 8 }, children: [_jsx(Btn, { disabled: busy || journal.state.status !== 'ready', onClick: () => {
                                            if (pending.current)
                                                return;
                                            if (journalDirty)
                                                setConfirmJournalReload(true);
                                            else
                                                reloadJournal();
                                        }, children: t('memory.reloadJournal') }), _jsx(Btn, { primary: true, disabled: busy || !journalDirty || journal.state.status !== 'ready' || !cardId, onClick: () => void saveJournal(), children: t('memory.saveJournal') })] })] }))] }))] }));
}
