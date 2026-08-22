import { jsxs as _jsxs, jsx as _jsx } from "react/jsx-runtime";
/**
 * 设置面板分区：提示词预设（卡片网格 / 导入 / 导出 / 删除 / 条目表格编辑）。
 * 卡片可键盘触发（clickableProps）；保存/导入/设默认等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { useState } from 'react';
import { IconDownloadOutline16, IconEditOutline16, IconFolderOpenOutline16, IconListPenOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { EMPTY_SESSION_DEFAULTS } from '../types.js';
import { Badge, Btn, ConfirmDialog, Err, Field, FileBtn, IconBtn, Muted, NumInput, RegexScriptRow, SearchEmpty, SearchInput, Section, Select, Skeleton, Toggle, clickableProps, downloadJson, errOf, readJsonFile, runAsync, useLoader, useToast } from '../util.js';
function newEntry(order) {
    return {
        identifier: `entry-${Date.now().toString(36)}-${order}`,
        name: '新条目',
        enabled: true,
        role: 'system',
        position: 'relative',
        depth: 4,
        order,
        content: '',
        marker: false,
    };
}
/** 预设内嵌正则列表（开关写进草稿，随「保存预设」落盘；重新导入以文件为准）。 */
function PresetRegexList(props) {
    return (_jsxs("div", { className: "dsh-tavern-field", children: [_jsxs("span", { className: "dsh-tavern-fieldLabel", children: ["\u968F\u9884\u8BBE\u5BFC\u5165\u7684\u6B63\u5219\uFF08", props.scripts.length, " \u6761\uFF1B\u5F00\u5173\u968F\u300C\u4FDD\u5B58\u9884\u8BBE\u300D\u751F\u6548\uFF0C\u91CD\u65B0\u5BFC\u5165\u4EE5\u6587\u4EF6\u4E3A\u51C6\uFF09"] }), _jsx("div", { className: "dsh-tavern-list", children: props.scripts.map((s, i) => (_jsx(RegexScriptRow, { script: s, index: i, onToggle: (disabled) => props.onChange(props.scripts.map((x, j) => (j === i ? { ...x, disabled } : x))) }, s.id ?? i))) })] }));
}
function EntryEditor(props) {
    const { entry } = props;
    const set = (patch) => props.onChange({ ...entry, ...patch });
    return (_jsxs("div", { className: "dsh-tavern-entry", children: [_jsxs("div", { style: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '10px 12px 6px' }, children: [_jsx(Toggle, { checked: entry.enabled, onChange: (enabled) => set({ enabled }), title: entry.enabled ? '关闭此条目' : '启用此条目' }), _jsx("input", { className: "dsh-tavern-input", style: { width: 160 }, value: entry.name, placeholder: "\u540D\u79F0", onChange: (e) => set({ name: e.target.value }) }), _jsx(Select, { value: entry.role, onChange: (v) => set({ role: v }), options: [
                            { value: 'system', label: 'system' },
                            { value: 'user', label: 'user' },
                            { value: 'assistant', label: 'assistant' },
                        ] }), _jsx(Select, { value: entry.position, onChange: (v) => set({ position: v }), options: [
                            { value: 'relative', label: 'relative' },
                            { value: 'in-chat', label: 'in-chat' },
                        ] }), entry.position === 'in-chat' && (_jsxs("label", { style: { fontSize: 12 }, children: ["\u6DF1\u5EA6 ", _jsx(NumInput, { value: entry.depth, width: 64, onChange: (v) => set({ depth: Math.max(0, Math.round(v)) }) })] })), _jsxs("label", { style: { fontSize: 12 }, children: ["\u987A\u5E8F ", _jsx(NumInput, { value: entry.order, width: 64, onChange: (v) => set({ order: Math.round(v) }) })] }), _jsxs("label", { style: { fontSize: 12 }, children: [_jsx("input", { type: "checkbox", checked: entry.marker, onChange: (e) => set({ marker: e.target.checked }) }), " \u5360\u4F4D\u7B26"] }), entry.marker && (_jsx("input", { className: "dsh-tavern-input", style: { width: 140 }, value: entry.markerId ?? '', placeholder: "markerId", onChange: (e) => set({ markerId: e.target.value }) })), _jsx("span", { style: { flex: 1 } }), _jsx(IconBtn, { label: "\u5220\u9664\u6761\u76EE", danger: true, onClick: props.onDelete, children: _jsx(IconTrashOutline16, {}) })] }), !entry.marker && (_jsx("div", { style: { padding: '0 12px 12px' }, children: _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 60 }, value: entry.content, placeholder: "\u5185\u5BB9", onChange: (e) => set({ content: e.target.value }) }) }))] }));
}
export function PresetsSection(props) {
    const { remote } = props;
    const { state, reload } = useLoader(() => remote.listPresets({}), []);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState(null);
    const [toDelete, setToDelete] = useState(null);
    const [query, setQuery] = useState('');
    const toast = useToast();
    const items = state.status === 'ready' ? state.value.items : [];
    const q = query.trim().toLowerCase();
    const filtered = q === '' ? items : items.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    const open = async (id) => {
        setError(null);
        const r = await remote.getPreset({ id });
        if (r.ok)
            setEditing(structuredClone(r.value.preset));
        else
            setError(r.error.message);
    };
    const save = async () => {
        if (!editing)
            return;
        await runAsync(setBusy, setError, async () => {
            const r = await remote.savePreset({ preset: editing });
            const err = errOf(r);
            if (err)
                setError(err);
            else {
                toast.show(`已保存预设 ${editing.name}`);
                reload();
            }
        });
    };
    const remove = async () => {
        if (!toDelete)
            return;
        const r = await remote.deletePreset({ id: toDelete });
        const err = errOf(r);
        if (err)
            setError(err);
        else {
            if (editing?.identifier === toDelete)
                setEditing(null);
            setToDelete(null);
            reload();
        }
    };
    const onImportFile = async (file) => {
        setBusy(true);
        setError(null);
        try {
            const json = await readJsonFile(file);
            const name = file.name.replace(/\.json$/i, '');
            const r = await remote.importPreset({ name, json });
            if (!r.ok)
                setError(r.error.message);
            else {
                toast.show(r.value.warnings.length > 0 ? `已导入，警告：${r.value.warnings.map(String).join('；')}` : '已导入预设');
                reload();
            }
        }
        catch (err2) {
            setError(err2 instanceof Error ? err2.message : String(err2));
        }
        finally {
            setBusy(false);
        }
    };
    const setAsDefault = async (id) => {
        const current = await remote.getSettings({});
        if (!current.ok) {
            setError(current.error.message);
            return;
        }
        const defaults = { ...EMPTY_SESSION_DEFAULTS, ...current.value.settings.defaults, presetId: id };
        const r = await remote.updateSettings({ patch: { defaults } });
        const err = errOf(r);
        if (err)
            setError(err);
        else
            toast.show('已设为新会话默认预设（当前打开的对话请用角色芯片切换）');
    };
    const exportPreset = async (id, name) => {
        const r = await remote.getPreset({ id });
        if (!r.ok) {
            setError(r.error.message);
            return;
        }
        const preset = r.value.preset;
        const prompts = preset.entries.map((e) => ({
            identifier: e.identifier,
            name: e.name,
            role: e.role,
            content: e.content,
            marker: e.marker,
            system_prompt: e.role === 'system',
            injection_position: e.position === 'in-chat' ? 1 : 0,
            injection_depth: e.depth,
            injection_order: e.order,
        }));
        const order = preset.entries.map((e) => ({ identifier: e.identifier, enabled: e.enabled }));
        const json = {
            name: preset.name,
            identifier: preset.identifier,
            prompts,
            prompt_order: [{ character_id: 100001, order }],
        };
        if (preset.regexScripts && preset.regexScripts.length > 0) {
            json.extensions = { regex_scripts: preset.regexScripts };
        }
        downloadJson(`${name || id}.json`, json);
    };
    const createNew = () => {
        const id = `preset-${Date.now().toString(36)}`;
        setEditing({ name: '新预设', identifier: id, entries: [newEntry(100)] });
    };
    const setEntry = (index, entry) => {
        if (!editing)
            return;
        const entries = editing.entries.slice();
        entries[index] = entry;
        setEditing({ ...editing, entries });
    };
    return (_jsxs(Section, { title: "\u63D0\u793A\u8BCD\u9884\u8BBE", description: "\u5BFC\u5165 SillyTavern \u9884\u8BBE JSON\uFF08\u542B extensions.regex_scripts\uFF09\u3002\u65B0\u4F1A\u8BDD\u9ED8\u8BA4\u5728\u300C\u8BBE\u7F6E\u300D\u9875\u6216\u5361\u811A\u300C\u8BBE\u4E3A\u9ED8\u8BA4\u300D\uFF1B\u5F53\u524D\u5BF9\u8BDD\u7528\u89D2\u8272\u82AF\u7247\u5207\u6362\u3002\u5DF2\u5728\u5E93\u4E2D\u7684\u9884\u8BBE\u9700\u91CD\u65B0\u5BFC\u5165\u624D\u4F1A\u5E26\u4E0A\u6B63\u5219\u3002", children: [toast.node, _jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(FileBtn, { accept: ".json", disabled: busy, onFile: (file) => void onImportFile(file), children: "\u5BFC\u5165 SillyTavern \u9884\u8BBE JSON" }), _jsx(Btn, { size: "md", onClick: createNew, children: "\u65B0\u5EFA\u9884\u8BBE" }), _jsx(Btn, { size: "md", onClick: reload, disabled: busy, children: "\u5237\u65B0" }), items.length >= 5 && (_jsx(SearchInput, { label: "\u641C\u7D22\u9884\u8BBE", value: query, onChange: setQuery, placeholder: "\u641C\u7D22\u9884\u8BBE\u540D / \u6807\u8BC6", width: 220 }))] }), state.status === 'loading' && (_jsxs("div", { className: "dsh-tavern-list", children: [_jsx(Skeleton, { height: 62, radius: 14 }), _jsx(Skeleton, { height: 62, radius: 14 }), _jsx(Skeleton, { height: 62, radius: 14 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), _jsx(Err, { message: error }), items.length === 0 && state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty", children: [_jsx("div", { className: "dsh-tavern-emptyIcon", children: _jsx(IconFolderOpenOutline16, { size: 32 }) }), _jsx("div", { className: "dsh-tavern-emptyTitle", children: "\u6682\u65E0\u9884\u8BBE" }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: "\u672A\u7ED1\u5B9A\u65F6\u4F7F\u7528\u5185\u5EFA\u9ED8\u8BA4\u9884\u8BBE\uFF1B\u4E5F\u53EF\u4EE5\u5BFC\u5165 SillyTavern \u9884\u8BBE JSON\u3002" })] })), q !== '' && filtered.length === 0 && state.status === 'ready' && (_jsx(SearchEmpty, { what: "\u9884\u8BBE", query: query.trim(), onClear: () => setQuery('') })), _jsx("div", { className: "dsh-tavern-list", style: { marginBottom: 12 }, children: filtered.map((item) => (_jsxs("div", { className: "dsh-tavern-tile", ...clickableProps(() => void open(item.id)), children: [_jsx("span", { className: "dsh-tavern-tileIcon", children: _jsx(IconListPenOutline16, { size: 18 }) }), _jsxs("div", { className: "dsh-tavern-tileMain", children: [_jsxs("div", { className: "dsh-tavern-tileTitleRow", children: [_jsx("span", { className: "dsh-tavern-tileName", children: item.name }), item.regexCount > 0 ? _jsxs(Badge, { children: [item.regexCount, " \u6761\u6B63\u5219"] }) : null] }), _jsx("span", { className: "dsh-tavern-tileSub", children: item.id })] }), _jsxs("div", { className: "dsh-tavern-tileActions", children: [_jsx(IconBtn, { label: "\u7F16\u8F91", onClick: () => void open(item.id), children: _jsx(IconEditOutline16, {}) }), _jsx(IconBtn, { label: "\u5BFC\u51FA JSON", onClick: () => void exportPreset(item.id, item.name), children: _jsx(IconDownloadOutline16, {}) }), _jsx(Btn, { size: "sm", onClick: () => void setAsDefault(item.id), children: "\u8BBE\u4E3A\u9ED8\u8BA4" }), _jsx(IconBtn, { label: "\u5220\u9664\u9884\u8BBE", danger: true, onClick: () => setToDelete(item.id), children: _jsx(IconTrashOutline16, {}) })] })] }, item.id))) }), _jsx(ConfirmDialog, { open: toDelete !== null, title: "\u5220\u9664\u9884\u8BBE\uFF1F", description: toDelete ? `确定删除预设 ${toDelete}？` : '', confirmLabel: "\u5220\u9664", danger: true, onCancel: () => setToDelete(null), onConfirm: () => void remove() }), editing && (_jsxs("div", { className: "dsh-tavern-card", style: { marginBottom: 12 }, children: [_jsx(Field, { label: "\u540D\u79F0", children: _jsx("input", { className: "dsh-tavern-input", style: { flex: 1 }, value: editing.name, onChange: (e) => setEditing({ ...editing, name: e.target.value }) }) }), _jsx(Field, { label: "\u6807\u8BC6", children: _jsx(Muted, { children: editing.identifier }) }), (editing.regexScripts?.length ?? 0) > 0 && (_jsx(PresetRegexList, { scripts: editing.regexScripts, onChange: (scripts) => setEditing({ ...editing, regexScripts: scripts }) })), _jsx("div", { className: "dsh-tavern-list", style: { margin: '8px 0' }, children: editing.entries.map((entry, i) => (_jsx(EntryEditor, { entry: entry, onChange: (e2) => setEntry(i, e2), onDelete: () => setEditing({ ...editing, entries: editing.entries.filter((_, j) => j !== i) }) }, entry.identifier))) }), _jsxs("div", { style: { display: 'flex', gap: 8 }, children: [_jsx(Btn, { onClick: () => setEditing({ ...editing, entries: [...editing.entries, newEntry(editing.entries.length * 100 + 100)] }), children: "\u6DFB\u52A0\u6761\u76EE" }), _jsx(Btn, { disabled: busy, onClick: () => void save(), primary: true, children: "\u4FDD\u5B58\u9884\u8BBE" }), _jsx(Btn, { onClick: () => setEditing(null), children: "\u5173\u95ED" })] })] }))] }));
}
