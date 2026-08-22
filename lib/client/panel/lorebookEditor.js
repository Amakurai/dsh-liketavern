import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * 世界书条目编辑器：按 SillyTavern World Info 语义列出条目，
 * 折叠行上可开关，展开后编辑关键词/正文/插入位置等。不展示原始 JSON。
 * 展开/收起走 .dsh-tavern-collapse 动画容器（grid-rows 过渡，表单始终渲染）。
 */
import { useMemo, useState } from 'react';
import { IconChevronDownOutline14, IconPlusOutline16, IconSearchOutline16, IconTrashOutline16, } from '@deepseek-ai/dsh-client-ui-primitives';
import { exportLorebook } from '../../state/lorebook.js';
import { Badge, Btn, ConfirmDialog, Err, IconBtn, Muted, NumInput, NullableNumInput, Select, Toggle, errOf, runAsync } from '../util.js';
const PAGE_SIZE = 40;
const POSITION_OPTIONS = [
    { value: '0', label: '角色定义之前' },
    { value: '1', label: '角色定义之后' },
    { value: '2', label: '作者注释顶部' },
    { value: '3', label: '作者注释底部' },
    { value: '4', label: '@D 指定深度' },
    { value: '5', label: '示例对话之前' },
    { value: '6', label: '示例对话之后' },
    { value: '7', label: 'Outlet' },
];
const LOGIC_OPTIONS = [
    { value: '0', label: 'AND ANY（任一）' },
    { value: '1', label: 'NOT ALL' },
    { value: '2', label: 'NOT ANY' },
    { value: '3', label: 'AND ALL（全部）' },
];
const ROLE_OPTIONS = [
    { value: '0', label: 'system' },
    { value: '1', label: 'user' },
    { value: '2', label: 'assistant' },
];
/** 条目级布尔覆盖（boolean | null）的三态选项：null = 跟随全局设置。 */
const TRI_STATE_OPTIONS = [
    { value: '', label: '跟随全局' },
    { value: 'true', label: '开' },
    { value: 'false', label: '关' },
];
const triValue = (v) => (v === null ? '' : String(v));
const triFrom = (v) => (v === '' ? null : v === 'true');
function splitKeys(text) {
    return text
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
}
function joinKeys(keys) {
    return keys.join(', ');
}
function entryTitle(entry) {
    const comment = entry.comment.trim();
    if (comment)
        return comment;
    if (entry.keys.length > 0)
        return entry.keys.slice(0, 3).join(', ');
    return '未命名条目';
}
function entrySub(entry) {
    const bits = [];
    if (entry.keys.length > 0)
        bits.push(entry.keys.slice(0, 4).join(', '));
    bits.push(`顺序 ${entry.order}`);
    if (entry.constant)
        bits.push('常驻');
    if (entry.group.trim())
        bits.push(`组 ${entry.group.trim()}`);
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
function targetKindLabel(kind) {
    if (kind === 'character')
        return '角色卡内嵌';
    if (kind === 'chat')
        return '本会话世界书';
    return '世界书库';
}
export function LorebookEditor(props) {
    const { target } = props;
    const { source, sourceRef } = sourceOf(target);
    const [entries, setEntries] = useState(() => props.entries.map((e) => ({ ...e })));
    const [dirty, setDirty] = useState(false);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState('all');
    const [page, setPage] = useState(0);
    const [openUid, setOpenUid] = useState(null);
    const [advanced, setAdvanced] = useState(false);
    const [busy, setBusy] = useState(false);
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
            setDirty(false);
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
        if (dirty)
            setLeaveConfirm(true);
        else
            props.onClose();
    };
    return (_jsxs("div", { children: [_jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(Btn, { size: "md", onClick: askClose, children: target.kind === 'chat' ? '关闭' : '返回列表' }), _jsxs("div", { style: { flex: 1, minWidth: 0 }, children: [_jsx("div", { className: "dsh-tavern-cardName", style: { fontSize: 15 }, children: target.name }), _jsxs(Muted, { children: [targetKindLabel(target.kind), " \u00B7 ", entries.length, " \u6761 \u00B7 \u542F\u7528 ", enabledCount, constantCount > 0 ? ` · 常驻 ${constantCount}` : '', dirty ? ' · 未保存' : ''] })] }), _jsx(Btn, { size: "md", onClick: addEntry, children: "\u65B0\u5EFA\u6761\u76EE" }), _jsx(Btn, { primary: true, size: "md", disabled: busy || !dirty, onClick: () => void save(), children: "\u4FDD\u5B58" })] }), _jsx(Err, { message: error }), _jsxs("div", { className: "dsh-tavern-search", style: { margin: '8px 0' }, children: [_jsx("span", { className: "dsh-tavern-searchIcon", children: _jsx(IconSearchOutline16, {}) }), _jsx("input", { value: query, placeholder: "\u641C\u7D22\u6761\u76EE\u540D\u3001\u5173\u952E\u8BCD\u6216\u6B63\u6587\u2026", onChange: (e) => {
                            setQuery(e.target.value);
                            setPage(0);
                        } })] }), _jsxs("div", { className: "dsh-tavern-filters", children: [[
                        ['all', `全部 ${entries.length}`],
                        ['on', `启用 ${enabledCount}`],
                        ['off', `关闭 ${entries.length - enabledCount}`],
                        ['constant', `常驻 ${constantCount}`],
                    ].map(([id, label]) => (_jsx("button", { type: "button", className: "dsh-tavern-chip", "data-active": filter === id ? 'true' : 'false', onClick: () => {
                            setFilter(id);
                            setPage(0);
                        }, children: label }, id))), _jsx("span", { style: { flex: 1 } }), _jsx(Btn, { size: "sm", onClick: () => applyFilterEnabled(true), disabled: filtered.length === 0, children: "\u542F\u7528\u7B5B\u9009\u7ED3\u679C" }), _jsx(Btn, { size: "sm", onClick: () => applyFilterEnabled(false), disabled: filtered.length === 0, children: "\u5173\u95ED\u7B5B\u9009\u7ED3\u679C" })] }), filtered.length === 0 ? (_jsx(Muted, { children: entries.length === 0 ? '还没有条目，点「新建条目」开始。' : '没有匹配的条目。' })) : (_jsx("div", { className: "dsh-tavern-list dsh-tavern-scroll", children: pageItems.map((entry) => {
                    const open = openUid === entry.uid;
                    return (_jsxs("div", { className: `dsh-tavern-entry${open ? ' is-open' : ''}${entry.enabled ? '' : ' is-off'}`, children: [_jsxs("div", { className: "dsh-tavern-entryHead", onClick: () => setOpenUid(open ? null : entry.uid), children: [_jsx(Toggle, { checked: entry.enabled, title: entry.enabled ? '关闭此条目' : '启用此条目', onChange: (enabled) => patch(entry.uid, { enabled }) }), _jsxs("div", { className: "dsh-tavern-entryMain", children: [_jsx("div", { className: "dsh-tavern-entryTitle", children: entryTitle(entry) }), _jsx("div", { className: "dsh-tavern-entrySub", children: entrySub(entry) })] }), _jsxs("div", { className: "dsh-tavern-entryBadges", children: [entry.constant ? _jsx(Badge, { children: "\u5E38\u9A7B" }) : null, entry.keys.length > 0 ? _jsxs(Badge, { children: [entry.keys.length, " \u952E"] }) : _jsx(Badge, { children: "\u65E0\u5173\u952E\u8BCD" })] }), _jsx("span", { className: `dsh-tavern-chevron${open ? ' is-open' : ''}`, children: _jsx(IconChevronDownOutline14, {}) })] }), _jsx("div", { className: `dsh-tavern-collapse${open ? ' is-open' : ''}`, children: _jsx("div", { className: "dsh-tavern-collapseInner", children: _jsx(EntryForm, { entry: entry, advanced: advanced, onAdvanced: setAdvanced, onChange: (partial) => patch(entry.uid, partial), onDelete: () => setToDelete(entry.uid) }) }) })] }, entry.uid));
                }) })), pageCount > 1 && (_jsxs("div", { className: "dsh-tavern-pager", children: [_jsx(Btn, { size: "sm", disabled: safePage <= 0, onClick: () => setPage(safePage - 1), children: "\u4E0A\u4E00\u9875" }), _jsxs(Muted, { children: [safePage + 1, " / ", pageCount, " \u9875\uFF08\u672C\u9875 ", pageItems.length, " \u6761\uFF09"] }), _jsx(Btn, { size: "sm", disabled: safePage >= pageCount - 1, onClick: () => setPage(safePage + 1), children: "\u4E0B\u4E00\u9875" })] })), _jsxs("div", { className: "dsh-tavern-stickyBar", children: [_jsx(Btn, { size: "md", onClick: addEntry, children: _jsxs("span", { style: { display: 'inline-flex', alignItems: 'center', gap: 6 }, children: [_jsx(IconPlusOutline16, {}), " \u65B0\u5EFA\u6761\u76EE"] }) }), _jsx(Btn, { primary: true, size: "md", disabled: busy || !dirty, onClick: () => void save(), children: "\u4FDD\u5B58" }), _jsx(Btn, { size: "md", onClick: askClose, children: dirty ? '放弃并返回' : '返回' })] }), _jsx(ConfirmDialog, { open: toDelete !== null, title: "\u5220\u9664\u8FD9\u6761\u4E16\u754C\u4E66\uFF1F", description: "\u5220\u9664\u540E\u9700\u70B9\u300C\u4FDD\u5B58\u300D\u624D\u4F1A\u5199\u56DE\u6587\u4EF6\u3002\u53EF\u5148\u8FD4\u56DE\u5217\u8868\u653E\u5F03\u66F4\u6539\u3002", confirmLabel: "\u5220\u9664\u6761\u76EE", danger: true, onCancel: () => setToDelete(null), onConfirm: removeEntry }), _jsx(ConfirmDialog, { open: leaveConfirm, title: "\u653E\u5F03\u672A\u4FDD\u5B58\u7684\u66F4\u6539\uFF1F", description: "\u5F00\u5173\u548C\u7F16\u8F91\u8FD8\u6CA1\u6709\u5199\u56DE\u4E16\u754C\u4E66\u6587\u4EF6\u3002", confirmLabel: "\u653E\u5F03\u66F4\u6539", danger: true, onCancel: () => setLeaveConfirm(false), onConfirm: () => {
                    setLeaveConfirm(false);
                    props.onClose();
                } })] }));
}
function EntryForm(props) {
    const { entry } = props;
    const set = props.onChange;
    return (_jsxs("div", { className: "dsh-tavern-entryBody", onClick: (e) => e.stopPropagation(), children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u6761\u76EE\u6807\u9898\uFF08comment\uFF09" }), _jsx("input", { className: "dsh-tavern-input", style: { width: '100%', height: 36, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }, value: entry.comment, placeholder: "\u7ED9\u81EA\u5DF1\u770B\u7684\u540D\u5B57\uFF0C\u4F8B\u5982\u300C\u4E3B\u89D2\u8EAB\u4E16\u300D", onChange: (e) => set({ comment: e.target.value }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u5173\u952E\u8BCD\uFF08\u9017\u53F7\u5206\u9694\uFF09" }), _jsx("input", { className: "dsh-tavern-input dsh-tavern-codeFont", style: { width: '100%', height: 36, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }, value: joinKeys(entry.keys), placeholder: "\u547D\u4E2D\u8FD9\u4E9B\u8BCD\u65F6\u6CE8\u5165", onChange: (e) => set({ keys: splitKeys(e.target.value) }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u5185\u5BB9" }), _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 120 }, value: entry.content, placeholder: "\u5199\u5165\u63D0\u793A\u8BCD\u7684\u6B63\u6587", onChange: (e) => set({ content: e.target.value }) })] }), _jsxs("div", { className: "dsh-tavern-inlineChecks", children: [_jsxs("label", { children: [_jsx(Toggle, { checked: entry.constant, onChange: (constant) => set({ constant }) }), "\u5E38\u9A7B\uFF08\u4E0D\u9700\u5173\u952E\u8BCD\uFF09"] }), _jsxs("label", { children: [_jsx(Toggle, { checked: entry.selective, onChange: (selective) => set({ selective }) }), "\u542F\u7528\u6B21\u7EA7\u952E"] }), _jsxs("label", { children: [_jsx(Toggle, { checked: entry.ignoreBudget, onChange: (ignoreBudget) => set({ ignoreBudget }) }), "\u5FFD\u7565\u9884\u7B97"] })] }), _jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u63D2\u5165\u4F4D\u7F6E" }), _jsx(Select, { size: "md", value: String(entry.position), onChange: (v) => set({ position: Number(v) }), options: POSITION_OPTIONS })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u987A\u5E8F order" }), _jsx(NumInput, { value: entry.order, onChange: (order) => set({ order: Math.round(order) }) })] }), entry.position === 4 || entry.position === 7 ? (_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: entry.position === 7 ? 'Outlet 名' : '深度 depth' }), entry.position === 7 ? (_jsx("input", { className: "dsh-tavern-input", style: { width: '100%', height: 36, padding: '0 10px', boxSizing: 'border-box' }, value: entry.outletName, onChange: (e) => set({ outletName: e.target.value }) })) : (_jsx(NumInput, { value: entry.depth, onChange: (depth) => set({ depth: Math.max(0, Math.round(depth)) }) }))] })) : null] }), entry.selective ? (_jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u6B21\u7EA7\u5173\u952E\u8BCD" }), _jsx("input", { className: "dsh-tavern-input dsh-tavern-codeFont", style: { width: '100%', height: 36, padding: '0 10px', fontSize: 13, boxSizing: 'border-box' }, value: joinKeys(entry.secondaryKeys), placeholder: "\u4E0E\u4E3B\u5173\u952E\u8BCD\u7EC4\u5408\u5224\u5B9A", onChange: (e) => set({ secondaryKeys: splitKeys(e.target.value) }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u6B21\u7EA7\u952E\u903B\u8F91" }), _jsx(Select, { size: "md", value: String(entry.selectiveLogic), onChange: (v) => set({ selectiveLogic: Number(v) }), options: LOGIC_OPTIONS })] })] })) : null, _jsx(Btn, { size: "sm", onClick: () => props.onAdvanced(!props.advanced), children: props.advanced ? '收起更多选项' : '更多选项（匹配 / 概率 / 递归 / 定时 / 分组）' }), props.advanced ? (_jsxs(_Fragment, { children: [_jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u6982\u7387" }), _jsx(NumInput, { value: entry.probability, onChange: (probability) => set({ probability }) })] }), _jsx("label", { className: "dsh-tavern-inlineChecks", style: { paddingTop: 22 }, children: _jsxs("span", { children: [_jsx(Toggle, { checked: entry.useProbability, onChange: (useProbability) => set({ useProbability }) }), " \u542F\u7528\u6982\u7387"] }) }), entry.position === 4 ? (_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "@D \u89D2\u8272" }), _jsx(Select, { size: "md", value: String(entry.role), onChange: (v) => set({ role: Number(v) }), options: ROLE_OPTIONS })] })) : null] }), _jsxs("div", { className: "dsh-tavern-inlineChecks", children: [_jsxs("label", { children: [_jsx(Toggle, { checked: entry.excludeRecursion, onChange: (excludeRecursion) => set({ excludeRecursion }) }), "\u4E0D\u53EF\u88AB\u9012\u5F52\u6FC0\u6D3B"] }), _jsxs("label", { children: [_jsx(Toggle, { checked: entry.preventRecursion, onChange: (preventRecursion) => set({ preventRecursion }) }), "\u6FC0\u6D3B\u540E\u505C\u6B62\u9012\u5F52"] })] }), _jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u5EF6\u8FDF\u5230\u9012\u5F52\u5C42" }), _jsx(NumInput, { value: entry.delayUntilRecursion, onChange: (delayUntilRecursion) => set({ delayUntilRecursion: Math.max(0, Math.round(delayUntilRecursion)) }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "sticky" }), _jsx(NullableNumInput, { value: entry.sticky, onChange: (sticky) => set({ sticky }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "cooldown" }), _jsx(NullableNumInput, { value: entry.cooldown, onChange: (cooldown) => set({ cooldown }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "delay" }), _jsx(NullableNumInput, { value: entry.delay, onChange: (delay) => set({ delay }) })] })] }), _jsxs("div", { className: "dsh-tavern-fieldRow", children: [_jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u626B\u63CF\u6DF1\u5EA6\uFF08\u7A7A=\u8DDF\u968F\u5168\u5C40\uFF09" }), _jsx(NullableNumInput, { value: entry.scanDepth, onChange: (scanDepth) => set({ scanDepth }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u533A\u5206\u5927\u5C0F\u5199" }), _jsx(Select, { size: "md", value: triValue(entry.caseSensitive), onChange: (v) => set({ caseSensitive: triFrom(v) }), options: TRI_STATE_OPTIONS })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u6574\u8BCD\u5339\u914D" }), _jsx(Select, { size: "md", value: triValue(entry.matchWholeWords), onChange: (v) => set({ matchWholeWords: triFrom(v) }), options: TRI_STATE_OPTIONS })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u5206\u7EC4" }), _jsx("input", { className: "dsh-tavern-input", style: { width: '100%', height: 36, padding: '0 10px', boxSizing: 'border-box' }, value: entry.group, onChange: (e) => set({ group: e.target.value }) })] }), _jsxs("label", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: "\u7EC4\u6743\u91CD" }), _jsx(NumInput, { value: entry.groupWeight, onChange: (groupWeight) => set({ groupWeight: Math.max(0, Math.round(groupWeight)) }) })] })] }), _jsx("div", { className: "dsh-tavern-inlineChecks", children: _jsxs("label", { children: [_jsx(Toggle, { checked: entry.groupOverride, onChange: (groupOverride) => set({ groupOverride }) }), "\u7EC4\u5185\u4F18\u5148\uFF08\u8986\u76D6\u540C\u7EC4\u5176\u5B83\u6761\u76EE\uFF09"] }) })] })) : null, _jsx("div", { style: { display: 'flex', justifyContent: 'flex-end' }, children: _jsx(IconBtn, { label: "\u5220\u9664\u6761\u76EE", danger: true, onClick: props.onDelete, children: _jsx(IconTrashOutline16, {}) }) })] }));
}
