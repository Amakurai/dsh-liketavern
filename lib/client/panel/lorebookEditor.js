import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 世界书条目编辑器：按 SillyTavern World Info 语义列出条目，
 * 折叠行上可开关，展开后编辑关键词/正文/插入位置等。不展示原始 JSON。
 * 展开/收起走 .dsh-tavern-collapse 动画容器（grid-rows 过渡，表单始终渲染）。
 */
import { useDraftGuard } from '../drafts.js';
import { PersistentEditor, useDraftState } from '../draftPersistence.js';
import { useId, useMemo, useRef, useState } from 'react';
import { IconChevronDownOutline14, IconPlusOutline16, IconSearchOutline16, IconTrashOutline16, } from '@deepseek-ai/dsh-client-ui-primitives';
import { exportLorebook } from '../../state/lorebook.js';
import { useT } from '../i18n.js';
import { Badge, Btn, ConfirmDialog, Err, IconBtn, ListInput, Muted, NumInput, NullableNumInput, Select, Toggle, errOf, runAsync } from '../util.js';
const PAGE_SIZE = 40;
const positionOptions = (t) => [
    { value: '0', label: t('lorebookEditor.position.0') },
    { value: '1', label: t('lorebookEditor.position.1') },
    { value: '2', label: t('lorebookEditor.position.2') },
    { value: '3', label: t('lorebookEditor.position.3') },
    { value: '4', label: t('lorebookEditor.position.4') },
    { value: '5', label: t('lorebookEditor.position.5') },
    { value: '6', label: t('lorebookEditor.position.6') },
    { value: '7', label: t('lorebookEditor.position.7') },
];
const logicOptions = (t) => [
    { value: '0', label: t('lorebookEditor.logic.0') },
    { value: '1', label: t('lorebookEditor.logic.1') },
    { value: '2', label: t('lorebookEditor.logic.2') },
    { value: '3', label: t('lorebookEditor.logic.3') },
];
const ROLE_OPTIONS = [
    { value: '0', label: 'system' },
    { value: '1', label: 'user' },
    { value: '2', label: 'assistant' },
];
/** 条目级布尔覆盖（boolean | null）的三态选项：null = 跟随全局设置。 */
const triStateOptions = (t) => [
    { value: '', label: t('lorebookEditor.tri.follow') },
    { value: 'true', label: t('lorebookEditor.tri.on') },
    { value: 'false', label: t('lorebookEditor.tri.off') },
];
const triValue = (v) => (v === null ? '' : String(v));
const triFrom = (v) => (v === '' ? null : v === 'true');
function entryTitle(t, entry) {
    const comment = entry.comment.trim();
    if (comment)
        return comment;
    if (entry.keys.length > 0)
        return entry.keys.slice(0, 3).join(', ');
    return t('lorebookEditor.entry.untitled');
}
function entrySub(t, entry) {
    const bits = [];
    if (entry.keys.length > 0)
        bits.push(entry.keys.slice(0, 4).join(', '));
    bits.push(t('lorebookEditor.entry.order', { order: entry.order }));
    if (entry.constant)
        bits.push(t('lorebookEditor.constant'));
    if (entry.group.trim())
        bits.push(t('lorebookEditor.entry.group', { group: entry.group.trim() }));
    return bits.join('  ·  ');
}
function newUid() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
function newEntry(source, sourceRef) {
    const uid = newUid();
    return {
        key: `${source}:${sourceRef}:${uid}`,
        uid,
        source,
        sourceRef,
        keys: [],
        secondaryKeys: [],
        selective: false,
        selectiveLogic: 0,
        comment: '',
        content: '',
        constant: false,
        enabled: true,
        order: 100,
        position: 0,
        depth: 4,
        role: 0,
        outletName: '',
        probability: 100,
        useProbability: true,
        caseSensitive: null,
        matchWholeWords: null,
        scanDepth: null,
        excludeRecursion: false,
        preventRecursion: false,
        delayUntilRecursion: 0,
        sticky: null,
        cooldown: null,
        delay: null,
        ignoreBudget: false,
        group: '',
        groupWeight: 100,
        groupOverride: false,
        automationId: '',
    };
}
function sourceOf(target) {
    if (target.kind === 'library')
        return { source: 'global', sourceRef: target.name };
    if (target.kind === 'chat')
        return { source: 'chat', sourceRef: 'chat-lorebook' };
    return { source: 'character', sourceRef: target.cardId };
}
function targetKindLabel(t, kind) {
    if (kind === 'character')
        return t('lorebookEditor.kind.character');
    if (kind === 'chat')
        return t('lorebookEditor.kind.chat');
    return t('lorebookEditor.kind.library');
}
/** 共享库按名字、内嵌书按角色、聊天书按角色和剧情隔离；无剧情的旧入口不跨挂载恢复。 */
function targetDraftKey(target, fallback) {
    if (target.kind === 'library')
        return `lorebook.library:${JSON.stringify(target.name)}`;
    if (target.kind === 'character')
        return `lorebook.character:${target.cardId}`;
    return `lorebook.chat:${JSON.stringify([target.cardId, target.storyId ?? fallback])}`;
}
export function LorebookEditor(props) {
    const fallback = useId();
    const draftKey = targetDraftKey(props.target, fallback);
    const editor = _jsx(LorebookEditorContent, { ...props, draftKey: draftKey }, draftKey);
    if (!props.remote || (props.target.kind === 'chat' && !props.target.storyId))
        return editor;
    return _jsx(PersistentEditor, { remote: props.remote, scope: draftKey, children: editor });
}
function LorebookEditorContent(props) {
    const t = useT();
    const { target, draftKey } = props;
    const { source, sourceRef } = sourceOf(target);
    const [entries, setEntries] = useDraftState(`${draftKey}.entries`, () => props.entries.map((e) => ({ ...e })));
    const [dirty, setDirty] = useDraftState(`${draftKey}.dirty`, false);
    const [query, setQuery] = useDraftState(`${draftKey}.query`, '');
    const [filter, setFilter] = useDraftState(`${draftKey}.filter`, 'all');
    const [page, setPage] = useDraftState(`${draftKey}.page`, 0);
    const [openUid, setOpenUid] = useDraftState(`${draftKey}.openUid`, null);
    const [advanced, setAdvanced] = useDraftState(`${draftKey}.advanced`, false);
    const savedEntries = useRef(props.entries);
    const [busy, setBusy] = useState(false);
    const guard = useDraftGuard(dirty, busy);
    const [error, setError] = useState(null);
    const [toDelete, setToDelete] = useState(null);
    const [leaveConfirm, setLeaveConfirm] = useState(false);
    const mark = (next) => {
        setEntries(next);
        setDirty(true);
    };
    const patch = (uid, partial) => {
        mark(entries.map((e) => (e.uid === uid ? { ...e, ...partial } : e)));
    };
    const filtered = useMemo(() => {
        const q = query.trim().toLowerCase();
        return entries.filter((e) => {
            if (filter === 'on' && !e.enabled)
                return false;
            if (filter === 'off' && e.enabled)
                return false;
            if (filter === 'constant' && !e.constant)
                return false;
            if (!q)
                return true;
            const hay = `${e.comment}\n${e.keys.join(' ')}\n${e.secondaryKeys.join(' ')}\n${e.content.slice(0, 400)}`.toLowerCase();
            return hay.includes(q);
        });
    }, [entries, filter, query]);
    const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const safePage = Math.min(page, pageCount - 1);
    const pageItems = filtered.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);
    const enabledCount = entries.filter((e) => e.enabled).length;
    const constantCount = entries.filter((e) => e.constant).length;
    // 整段包进 runAsync：typert 传输失败或入参严格校验不过时是 reject 而非错误信封，
    // 传输层 reject 也必须解锁按钮——否则 busy 卡死，两个「保存」都点不动，
    // 编辑器里这一批未写回的条目全部作废。
    const save = () => runAsync(setBusy, setError, async () => {
        const json = target.kind === 'character'
            ? { name: target.name, ...exportLorebook(entries, target.name) }
            : exportLorebook(entries, target.name);
        const r = await props.save(json);
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            savedEntries.current = entries;
            setDirty(false);
            guard.clearDraft();
            props.onSaved();
        }
    });
    const addEntry = () => {
        const created = newEntry(source, sourceRef);
        mark([created, ...entries]);
        setFilter('all');
        setQuery('');
        setPage(0);
        setOpenUid(created.uid);
        setAdvanced(false);
    };
    const applyFilterEnabled = (enabled) => {
        const ids = new Set(filtered.map((e) => e.uid));
        mark(entries.map((e) => (ids.has(e.uid) ? { ...e, enabled } : e)));
    };
    const removeEntry = () => {
        if (!toDelete)
            return;
        mark(entries.filter((e) => e.uid !== toDelete));
        if (openUid === toDelete)
            setOpenUid(null);
        setToDelete(null);
    };
    const askClose = () => {
        if (busy)
            return;
        if (dirty)
            setLeaveConfirm(true);
        else
            props.onClose();
    };
    return (_jsxs("div", { children: [_jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(Btn, { size: "md", onClick: askClose, children: target.kind === 'chat' ? t('action.close') : t('lorebookEditor.backToList') }), _jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [_jsx("div", { className: "dsh-tavern-cardName", style: { fontSize: 15 }, children: target.name }), _jsxs("div", { className: "dsh-tavern-editorMeta", children: [_jsxs(Muted, { children: [t('lorebookEditor.meta', { kind: targetKindLabel(t, target.kind), total: entries.length, enabled: enabledCount }), constantCount > 0 ? t('lorebookEditor.metaConstant', { count: constantCount }) : ''] }), dirty ? _jsx(Badge, { accent: true, children: t('lorebookEditor.unsaved') }) : null] })] }), _jsx(Btn, { size: "md", onClick: addEntry, children: t('lorebookEditor.newEntry') }), _jsx(Btn, { primary: true, size: "md", disabled: busy || !dirty, onClick: () => void save(), children: t('action.save') })] }), _jsx(Err, { message: error }), _jsxs("div", { className: "dsh-tavern-search", style: { margin: '10px 0 12px' }, children: [_jsx("span", { className: "dsh-tavern-searchIcon", children: _jsx(IconSearchOutline16, {}) }), _jsx("input", { value: query, placeholder: t('lorebookEditor.searchPlaceholder'), onChange: (e) => {
                            setQuery(e.target.value);
                            setPage(0);
                        } })] }), _jsxs("div", { className: "dsh-tavern-filters", children: [[
                        ['all', t('lorebookEditor.filter.all', { count: entries.length })],
                        ['on', t('lorebookEditor.filter.on', { count: enabledCount })],
                        ['off', t('lorebookEditor.filter.off', { count: entries.length - enabledCount })],
                        ['constant', t('lorebookEditor.filter.constant', { count: constantCount })],
                    ].map(([id, label]) => (_jsx("button", { type: "button", className: "dsh-tavern-chip", "data-active": filter === id ? 'true' : 'false', onClick: () => {
                            setFilter(id);
                            setPage(0);
                        }, children: label }, id))), _jsx("span", { style: { flex: 1 } }), _jsx(Btn, { size: "sm", onClick: () => applyFilterEnabled(true), disabled: filtered.length === 0, children: t('lorebookEditor.enableFiltered') }), _jsx(Btn, { size: "sm", onClick: () => applyFilterEnabled(false), disabled: filtered.length === 0, children: t('lorebookEditor.disableFiltered') })] }), filtered.length === 0 ? (_jsx(Muted, { children: entries.length === 0 ? t('lorebookEditor.empty') : t('common.noMatch', { what: t('lorebookEditor.entryNoun') }) })) : (_jsx("div", { className: "dsh-tavern-list dsh-tavern-scroll", children: pageItems.map((entry) => {
                    const open = openUid === entry.uid;
                    return (_jsxs("div", { className: `dsh-tavern-entry${open ? ' is-open' : ''}${entry.enabled ? '' : ' is-off'}`, children: [_jsxs("div", { className: "dsh-tavern-entryHead", onClick: () => setOpenUid(open ? null : entry.uid), children: [_jsx(Toggle, { checked: entry.enabled, title: entry.enabled ? t('lorebookEditor.entry.disable') : t('lorebookEditor.entry.enable'), onChange: (enabled) => patch(entry.uid, { enabled }) }), _jsxs("div", { className: "dsh-tavern-entryMain", children: [_jsx("div", { className: "dsh-tavern-entryTitle", children: entryTitle(t, entry) }), _jsx("div", { className: "dsh-tavern-entrySub", children: entrySub(t, entry) })] }), _jsxs("div", { className: "dsh-tavern-entryBadges", children: [entry.constant ? _jsx(Badge, { children: t('lorebookEditor.constant') }) : null, entry.keys.length > 0 ? _jsx(Badge, { children: t('lorebookEditor.entry.keys', { count: entry.keys.length }) }) : _jsx(Badge, { children: t('lorebookEditor.entry.noKeys') })] }), _jsx("span", { className: `dsh-tavern-chevron${open ? ' is-open' : ''}`, children: _jsx(IconChevronDownOutline14, {}) })] }), _jsx("div", { className: `dsh-tavern-collapse${open ? ' is-open' : ''}`, children: _jsx("div", { className: "dsh-tavern-collapseInner", children: _jsx(EntryForm, { entry: entry, advanced: advanced, onAdvanced: setAdvanced, onChange: (partial) => patch(entry.uid, partial), onDelete: () => setToDelete(entry.uid) }) }) })] }, entry.uid));
                }) })), pageCount > 1 && (_jsxs("div", { className: "dsh-tavern-pager", children: [_jsx(Btn, { size: "sm", disabled: safePage <= 0, onClick: () => setPage(safePage - 1), children: t('lorebookEditor.pager.prev') }), _jsx(Muted, { children: t('lorebookEditor.pager.status', { page: safePage + 1, pageCount, count: pageItems.length }) }), _jsx(Btn, { size: "sm", disabled: safePage >= pageCount - 1, onClick: () => setPage(safePage + 1), children: t('lorebookEditor.pager.next') })] })), _jsxs("div", { className: "dsh-tavern-stickyBar", children: [_jsx(Btn, { size: "md", onClick: addEntry, children: _jsxs("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 6 }, children: [_jsx(IconPlusOutline16, {}), " ", t('lorebookEditor.newEntry')] }) }), _jsx(Btn, { primary: true, size: "md", disabled: busy || !dirty, onClick: () => void save(), children: t('action.save') }), _jsx(Btn, { size: "md", onClick: askClose, children: dirty ? t('lorebookEditor.discardAndBack') : t('lorebookEditor.back') })] }), _jsx(ConfirmDialog, { open: toDelete !== null, title: t('lorebookEditor.delete.title'), description: t('lorebookEditor.delete.desc'), confirmLabel: t('lorebookEditor.deleteEntry'), danger: true, onCancel: () => setToDelete(null), onConfirm: removeEntry }), _jsx(ConfirmDialog, { open: leaveConfirm, title: t('lorebookEditor.discard.title'), description: t('lorebookEditor.discard.desc'), confirmLabel: t('lorebookEditor.discard.confirm'), danger: true, onCancel: () => setLeaveConfirm(false), onConfirm: () => {
                    if (busy)
                        return;
                    setLeaveConfirm(false);
                    setEntries(savedEntries.current);
                    setDirty(false);
                    guard.clearDraft();
                    props.onClose();
                } })] }));
}
function EntryForm(props) {
    const t = useT();
    const { entry } = props;
    const set = props.onChange;
    return (_jsxs("div", { className: "dsh-tavern-entryBody", onClick: (e) => e.stopPropagation(), children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.comment') }), _jsx("input", { className: "dsh-tavern-input", style: { width: '100%', height: 36, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }, value: entry.comment, placeholder: t('lorebookEditor.form.commentPlaceholder'), onChange: (e) => set({ comment: e.target.value }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.keys') }), _jsx(ListInput, { className: "dsh-tavern-input dsh-tavern-codeFont", style: { width: '100%', height: 36, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }, value: entry.keys, placeholder: t('lorebookEditor.form.keysPlaceholder'), onChange: (keys) => set({ keys }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.content') }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 120 }, value: entry.content, placeholder: t('lorebookEditor.form.contentPlaceholder'), onChange: (e) => set({ content: e.target.value }) })] }), _jsxs("div", { className: "dsh-tavern-inlineChecks", children: [_jsxs("label", { children: [_jsx(Toggle, { checked: entry.constant, onChange: (constant) => set({ constant }) }), t('lorebookEditor.form.constant')] }), _jsxs("label", { children: [_jsx(Toggle, { checked: entry.selective, onChange: (selective) => set({ selective }) }), t('lorebookEditor.form.selective')] }), _jsxs("label", { children: [_jsx(Toggle, { checked: entry.ignoreBudget, onChange: (ignoreBudget) => set({ ignoreBudget }) }), t('lorebookEditor.form.ignoreBudget')] })] }), _jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.position') }), _jsx(Select, { size: "md", value: String(entry.position), onChange: (v) => set({ position: Number(v) }), options: positionOptions(t) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.order') }), _jsx(NumInput, { value: entry.order, onChange: (order) => set({ order: Math.round(order) }) })] }), entry.position === 4 || entry.position === 7 ? (_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: entry.position === 7 ? t('lorebookEditor.form.outletName') : t('lorebookEditor.form.depth') }), entry.position === 7 ? (_jsx("input", { className: "dsh-tavern-input", style: { width: '100%', height: 36, padding: '0 10px', boxSizing: 'border-box' }, value: entry.outletName, onChange: (e) => set({ outletName: e.target.value }) })) : (_jsx(NumInput, { value: entry.depth, onChange: (depth) => set({ depth: Math.max(0, Math.round(depth)) }) }))] })) : null] }), entry.selective ? (_jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.secondaryKeys') }), _jsx(ListInput, { className: "dsh-tavern-input dsh-tavern-codeFont", style: { width: '100%', height: 36, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }, value: entry.secondaryKeys, placeholder: t('lorebookEditor.form.secondaryKeysPlaceholder'), onChange: (secondaryKeys) => set({ secondaryKeys }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.selectiveLogic') }), _jsx(Select, { size: "md", value: String(entry.selectiveLogic), onChange: (v) => set({ selectiveLogic: Number(v) }), options: logicOptions(t) })] })] })) : null, _jsx(Btn, { size: "sm", onClick: () => props.onAdvanced(!props.advanced), children: props.advanced ? t('lorebookEditor.form.advanced.hide') : t('lorebookEditor.form.advanced.show') }), props.advanced ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.probability') }), _jsx(NumInput, { value: entry.probability, onChange: (probability) => set({ probability }) })] }), _jsx("label", { className: "dsh-tavern-inlineChecks", style: { paddingTop: 22 }, children: _jsxs("span", { children: [_jsx(Toggle, { checked: entry.useProbability, onChange: (useProbability) => set({ useProbability }) }), " ", t('lorebookEditor.form.useProbability')] }) }), entry.position === 4 ? (_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.role') }), _jsx(Select, { size: "md", value: String(entry.role), onChange: (v) => set({ role: Number(v) }), options: ROLE_OPTIONS })] })) : null] }), _jsxs("div", { className: "dsh-tavern-inlineChecks", children: [_jsxs("label", { children: [_jsx(Toggle, { checked: entry.excludeRecursion, onChange: (excludeRecursion) => set({ excludeRecursion }) }), t('lorebookEditor.form.excludeRecursion')] }), _jsxs("label", { children: [_jsx(Toggle, { checked: entry.preventRecursion, onChange: (preventRecursion) => set({ preventRecursion }) }), t('lorebookEditor.form.preventRecursion')] })] }), _jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.delayUntilRecursion') }), _jsx(NumInput, { value: entry.delayUntilRecursion, onChange: (delayUntilRecursion) => set({ delayUntilRecursion: Math.max(0, Math.round(delayUntilRecursion)) }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "sticky" }), _jsx(NullableNumInput, { value: entry.sticky, onChange: (sticky) => set({ sticky }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "cooldown" }), _jsx(NullableNumInput, { value: entry.cooldown, onChange: (cooldown) => set({ cooldown }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "delay" }), _jsx(NullableNumInput, { value: entry.delay, onChange: (delay) => set({ delay }) })] })] }), _jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.scanDepth') }), _jsx(NullableNumInput, { value: entry.scanDepth, onChange: (scanDepth) => set({ scanDepth }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.caseSensitive') }), _jsx(Select, { size: "md", value: triValue(entry.caseSensitive), onChange: (v) => set({ caseSensitive: triFrom(v) }), options: triStateOptions(t) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.matchWholeWords') }), _jsx(Select, { size: "md", value: triValue(entry.matchWholeWords), onChange: (v) => set({ matchWholeWords: triFrom(v) }), options: triStateOptions(t) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.group') }), _jsx("input", { className: "dsh-tavern-input", style: { width: '100%', height: 36, padding: '0 10px', boxSizing: 'border-box' }, value: entry.group, onChange: (e) => set({ group: e.target.value }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('lorebookEditor.form.groupWeight') }), _jsx(NumInput, { value: entry.groupWeight, onChange: (groupWeight) => set({ groupWeight: Math.max(0, Math.round(groupWeight)) }) })] })] }), _jsx("div", { className: "dsh-tavern-inlineChecks", children: _jsxs("label", { children: [_jsx(Toggle, { checked: entry.groupOverride, onChange: (groupOverride) => set({ groupOverride }) }), t('lorebookEditor.form.groupOverride')] }) })] })) : null, _jsx("div", { style: { display: 'flex', justifyContent: 'flex-end' }, children: _jsx(IconBtn, { label: t('lorebookEditor.deleteEntry'), danger: true, onClick: props.onDelete, children: _jsx(IconTrashOutline16, {}) }) })] }));
}
