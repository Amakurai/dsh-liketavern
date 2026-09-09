import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/**
 * 设置面板分区：提示词预设（卡片网格 / 导入 / 导出 / 删除 / 条目表格编辑）。
 * 卡片可键盘触发（clickableProps）；保存/导入/设默认等瞬时反馈走 useToast，上下文错误用 Err。
 */
import { exportHelperScriptTrees } from '../../core/helperScripts.js';
import { useDraftGuard } from '../drafts.js';
import { useDraftState } from '../draftPersistence.js';
import { useState } from 'react';
import { IconDownloadOutline16, IconEditOutline16, IconFolderOpenOutline16, IconListPenOutline16, IconTrashOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { EMPTY_SESSION_DEFAULTS } from '../types.js';
import { t as tBare, useT } from '../i18n.js';
import { Badge, Btn, ConfirmDialog, Err, Field, FileBtn, IconBtn, Muted, NumInput, RegexScriptRow, SaveBar, SearchEmpty, SearchInput, Section, Select, Skeleton, Toggle, clickableProps, downloadJson, errOf, readJsonFile, runAsync, useLoader, useToast } from '../util.js';
function newEntry(order) {
    return {
        identifier: `entry-${Date.now().toString(36)}-${order}`,
        name: tBare('presets.newEntryName'),
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
    const t = useT();
    return (_jsxs("div", { className: "dsh-tavern-field", children: [_jsx("span", { className: "dsh-tavern-fieldLabel", children: t('presets.regexList.label', { count: props.scripts.length }) }), _jsx("div", { className: "dsh-tavern-list", children: props.scripts.map((s, i) => (_jsx(RegexScriptRow, { script: s, index: i, onToggle: (disabled) => props.onChange(props.scripts.map((x, j) => (j === i ? { ...x, disabled } : x))) }, s.id ?? i))) })] }));
}
function EntryEditor(props) {
    const { entry } = props;
    const t = useT();
    const set = (patch) => props.onChange({ ...entry, ...patch });
    return (_jsxs("div", { className: "dsh-tavern-entry", children: [_jsxs("div", { style: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '12px 16px 8px' }, children: [_jsx(Toggle, { checked: entry.enabled, onChange: (enabled) => set({ enabled }), title: entry.enabled ? t('presets.entry.disable') : t('presets.entry.enable') }), _jsx("input", { className: "dsh-tavern-input", style: { width: 160 }, value: entry.name, placeholder: t('presets.name'), onChange: (e) => set({ name: e.target.value }) }), _jsx(Select, { value: entry.role, onChange: (v) => set({ role: v }), options: [
                            { value: 'system', label: 'system' },
                            { value: 'user', label: 'user' },
                            { value: 'assistant', label: 'assistant' },
                        ] }), _jsx(Select, { value: entry.position, onChange: (v) => set({ position: v }), options: [
                            { value: 'relative', label: 'relative' },
                            { value: 'in-chat', label: 'in-chat' },
                        ] }), entry.position === 'in-chat' && (_jsxs("label", { style: { fontSize: 12 }, children: [t('presets.entry.depth'), " ", _jsx(NumInput, { value: entry.depth, width: 64, onChange: (v) => set({ depth: Math.max(0, Math.round(v)) }) })] })), _jsxs("label", { style: { fontSize: 12 }, children: [t('presets.entry.order'), " ", _jsx(NumInput, { value: entry.order, width: 64, onChange: (v) => set({ order: Math.round(v) }) })] }), _jsxs("label", { style: { fontSize: 12 }, children: [_jsx("input", { type: "checkbox", checked: entry.marker, onChange: (e) => set({ marker: e.target.checked }) }), " ", t('presets.entry.marker')] }), entry.marker && (_jsx("input", { className: "dsh-tavern-input", style: { width: 140 }, value: entry.markerId ?? '', placeholder: "markerId", onChange: (e) => set({ markerId: e.target.value }) })), _jsx("span", { style: { flex: 1 } }), _jsx(IconBtn, { label: t('presets.entry.delete'), danger: true, onClick: props.onDelete, children: _jsx(IconTrashOutline16, {}) })] }), !entry.marker && (_jsx("div", { style: { padding: '2px 16px 14px' }, children: _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea", style: { minHeight: 60 }, value: entry.content, placeholder: t('presets.entry.content'), onChange: (e) => set({ content: e.target.value }) }) }))] }));
}
export function PresetsSection(props) {
    const { remote } = props;
    const { state, reload } = useLoader(() => remote.listPresets({}), []);
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [baseline, setBaseline] = useDraftState('presets:baseline', null);
    const [editing, setEditing] = useDraftState('presets:editing', null);
    const [toDelete, setToDelete] = useState(null);
    const [query, setQuery] = useState('');
    const toast = useToast();
    const t = useT();
    const guard = useDraftGuard(editing !== null && JSON.stringify(editing) !== baseline, busy);
    const items = state.status === 'ready' ? state.value.items : [];
    const q = query.trim().toLowerCase();
    const filtered = q === '' ? items : items.filter((p) => p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
    const open = async (id) => {
        await runAsync(setBusy, setError, async () => {
            const r = await remote.getPreset({ id });
            if (r.ok) {
                setEditing(structuredClone(r.value.preset));
                setBaseline(JSON.stringify(r.value.preset));
            }
            else
                setError(r.error.message);
        });
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
                setBaseline(JSON.stringify(editing));
                toast.show(t('presets.saved', { name: editing.name }));
                reload();
            }
        });
    };
    const remove = async () => {
        if (!toDelete)
            return;
        await runAsync(setBusy, setError, async () => {
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
        });
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
                toast.show(r.value.warnings.length > 0
                    ? t('presets.importedWarnings', { warnings: r.value.warnings.map(String).join(t('presets.warningSep')) })
                    : t('presets.imported'));
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
        await runAsync(setBusy, setError, async () => {
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
                toast.show(t('presets.setDefaultDone'));
        });
    };
    const exportPreset = async (id, name) => {
        await runAsync(setBusy, setError, async () => {
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
            if (preset.helperSettings)
                json.extensions = { ...(json.extensions ?? {}), tavern_helper: { ...preset.helperSettings, scripts: exportHelperScriptTrees(preset.helperSettings.scripts ?? []) } };
            downloadJson(`${name || id}.json`, json);
        });
    };
    const createNew = () => {
        const id = `preset-${Date.now().toString(36)}`;
        setEditing({ name: t('presets.newPresetName'), identifier: id, entries: [newEntry(100)] });
    };
    const setEntry = (index, entry) => {
        if (!editing)
            return;
        const entries = editing.entries.slice();
        entries[index] = entry;
        setEditing({ ...editing, entries });
    };
    return (_jsxs(Section, { title: t('section.presets'), description: t('presets.section.desc'), children: [toast.node, guard.confirmation, _jsxs("div", { className: "dsh-tavern-toolbar", children: [_jsx(FileBtn, { accept: ".json", disabled: busy, onFile: (file) => void onImportFile(file), children: t('presets.importFile') }), _jsx(Btn, { size: "md", onClick: () => guard.request(createNew), children: t('presets.new') }), _jsx(Btn, { size: "md", onClick: reload, disabled: busy, children: t('action.refresh') }), items.length >= 5 && (_jsx(SearchInput, { label: t('presets.searchLabel'), value: query, onChange: setQuery, placeholder: t('presets.searchPlaceholder'), width: 220 }))] }), state.status === 'loading' && (_jsxs("div", { className: "dsh-tavern-list", children: [_jsx(Skeleton, { height: 70, radius: 16 }), _jsx(Skeleton, { height: 70, radius: 16 }), _jsx(Skeleton, { height: 70, radius: 16 })] })), state.status === 'error' && _jsx(Err, { message: state.message }), _jsx(Err, { message: error }), items.length === 0 && state.status === 'ready' && (_jsxs("div", { className: "dsh-tavern-empty", children: [_jsx("div", { className: "dsh-tavern-emptyIcon", children: _jsx(IconFolderOpenOutline16, { size: 32 }) }), _jsx("div", { className: "dsh-tavern-emptyTitle", children: t('presets.empty') }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: t('presets.emptyDesc') })] })), q !== '' && filtered.length === 0 && state.status === 'ready' && (_jsx(SearchEmpty, { what: t('presets.noun'), query: query.trim(), onClear: () => setQuery('') })), _jsx("div", { className: "dsh-tavern-list", style: { marginBottom: 12 }, children: filtered.map((item) => (_jsxs("div", { className: "dsh-tavern-tile", ...clickableProps(() => guard.request(() => void open(item.id))), children: [_jsx("span", { className: "dsh-tavern-tileIcon", children: _jsx(IconListPenOutline16, { size: 18 }) }), _jsxs("div", { className: "dsh-tavern-tileMain", children: [_jsxs("div", { className: "dsh-tavern-tileTitleRow", children: [_jsx("span", { className: "dsh-tavern-tileName", children: item.name }), item.regexCount > 0 ? _jsx(Badge, { children: t('presets.regexCount', { count: item.regexCount }) }) : null] }), _jsx("span", { className: "dsh-tavern-tileSub", children: item.id })] }), _jsxs("div", { className: "dsh-tavern-tileActions", children: [_jsx(IconBtn, { label: t('action.edit'), onClick: () => guard.request(() => void open(item.id)), children: _jsx(IconEditOutline16, {}) }), _jsx(IconBtn, { label: t('presets.export'), disabled: busy, onClick: () => void exportPreset(item.id, item.name), children: _jsx(IconDownloadOutline16, {}) }), _jsx(Btn, { size: "sm", disabled: busy, onClick: () => void setAsDefault(item.id), children: t('presets.setAsDefault') }), _jsx(IconBtn, { label: t('presets.delete'), danger: true, onClick: () => setToDelete(item.id), children: _jsx(IconTrashOutline16, {}) })] })] }, item.id))) }), _jsx(ConfirmDialog, { open: toDelete !== null, title: t('presets.deleteTitle'), description: toDelete ? t('presets.deleteDesc', { id: toDelete }) : '', confirmLabel: t('action.delete'), danger: true, busy: busy, onCancel: () => setToDelete(null), onConfirm: () => void remove() }), editing && (_jsxs("fieldset", { disabled: busy, className: "dsh-tavern-editorFields dsh-tavern-card", style: { marginBottom: 12 }, children: [_jsx(Field, { label: t('presets.name'), children: _jsx("input", { className: "dsh-tavern-input", style: { flex: 1 }, value: editing.name, onChange: (e) => setEditing({ ...editing, name: e.target.value }) }) }), _jsx(Field, { label: t('presets.identifier'), children: _jsx(Muted, { children: editing.identifier }) }), (editing.regexScripts?.length ?? 0) > 0 && (_jsx(PresetRegexList, { scripts: editing.regexScripts, onChange: (scripts) => setEditing({ ...editing, regexScripts: scripts }) })), _jsx("div", { className: "dsh-tavern-list", style: { margin: '8px 0' }, children: editing.entries.map((entry, i) => (_jsx(EntryEditor, { entry: entry, onChange: (e2) => setEntry(i, e2), onDelete: () => setEditing({ ...editing, entries: editing.entries.filter((_, j) => j !== i) }) }, entry.identifier))) }), _jsxs(SaveBar, { children: [_jsx("span", { className: "dsh-tavern-muted", children: JSON.stringify(editing) !== baseline ? t('draft.unsaved') : '' }), _jsx(Btn, { onClick: () => setEditing({ ...editing, entries: [...editing.entries, newEntry(editing.entries.length * 100 + 100)] }), children: t('presets.addEntry') }), _jsx(Btn, { disabled: busy, onClick: () => void save(), primary: true, children: t('presets.save') }), _jsx(Btn, { onClick: () => guard.request(() => setEditing(null)), children: t('action.close') })] })] }))] }));
}
