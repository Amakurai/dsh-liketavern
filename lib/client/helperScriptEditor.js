import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/** 共享脚本库编辑器：草稿、导入导出、文件夹及持久开关；保存走资产修订校验，运行变量不写回共享资产。 */
import { useEffect, useId, useRef, useState } from 'react';
import { notifyHelperScriptAssets } from './helperScriptNotifications.js';
import { parseHelperScriptTrees, importHelperScriptFile, exportHelperScriptTrees } from '../core/helperScripts.js';
import { useDraftGuard } from './drafts.js';
import { PersistentEditor, useDraftState } from './draftPersistence.js';
import { useT } from './i18n.js';
import { Btn, ConfirmDialog, Dialog, Err, FileBtn, Muted, SaveBar, SearchInput, Select, SettingsRow, Tabs, Toggle, downloadJson, useToast } from './util.js';
const libraryTarget = (library) => 'target' in library ? library.target : { type: 'character', cardId: library.cardId };
export function HelperScriptEditor(props) {
    const target = libraryTarget(props.library);
    return _jsx(PersistentEditor, { remote: props.remote, scope: `helper-scripts:${target.type === 'character' ? target.cardId : JSON.stringify(target)}`, children: _jsx(HelperScriptEditorBody, { ...props }) });
}
export function HelperScriptEditorBody(props) {
    const target = libraryTarget(props.library);
    const t = useT(), toast = useToast(), tabsId = useId();
    const saving = useRef(false);
    const [query, setQuery] = useState(''), [section, setSection] = useState('code');
    const [trees, setTrees] = useDraftState('trees', props.library.trees);
    const [revision, setRevision] = useDraftState('revision', props.library.revision);
    const [baseline, setBaseline] = useDraftState('baseline', JSON.stringify(props.library.trees));
    const [dataTexts, setDataTexts] = useDraftState('data', {});
    const [selected, setSelected] = useState(props.library.trees[0]?.id ?? null), [error, setError] = useState(null), [busy, setBusy] = useState(false), [removing, setRemoving] = useState(false);
    const flat = trees.flatMap(tree => tree.type === 'folder' ? [tree, ...tree.scripts] : [tree]);
    useEffect(() => { if (!flat.some(item => item.id === selected))
        setSelected(flat[0]?.id ?? null); }, [trees, selected]);
    const current = flat.find(tree => tree.id === selected);
    const siblings = current ? trees.find(tree => tree.type === 'folder' && tree.scripts.some(script => script.id === current.id)) : undefined;
    const peers = siblings?.type === 'folder' ? siblings.scripts : trees;
    const position = peers.findIndex(item => item.id === selected);
    const matches = (item) => item.name.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
    const visible = trees.filter(tree => matches(tree) || tree.type === 'folder' && tree.scripts.some(matches));
    const scriptCount = flat.filter(tree => tree.type === 'script').length;
    const dirty = JSON.stringify(trees) !== baseline || Object.keys(dataTexts).length > 0;
    const guard = useDraftGuard(dirty, busy);
    const update = (id, change) => setTrees(items => items.map(tree => tree.id === id ? change(tree) : tree.type === 'folder' ? { ...tree, scripts: tree.scripts.map(script => script.id === id ? change(script) : script) } : tree));
    const materialize = () => parseHelperScriptTrees(trees.map(tree => tree.type === 'script' ? scriptData(tree) : { ...tree, scripts: tree.scripts.map(scriptData) }));
    const scriptData = (script) => {
        if (!Object.hasOwn(dataTexts, script.id))
            return script;
        try {
            const data = JSON.parse(dataTexts[script.id]);
            if (data === null || typeof data !== 'object' || Array.isArray(data))
                throw new Error('object required');
            return { ...script, data: data };
        }
        catch {
            setQuery('');
            setSelected(script.id);
            setSection('data');
            throw new Error(t('speech.scriptInvalidData', { name: script.name || script.id }));
        }
    };
    const add = (folder) => {
        const id = crypto.randomUUID();
        const next = parseHelperScriptTrees([{ id, type: folder ? 'folder' : 'script', name: t(folder ? 'speech.scriptNewFolder' : 'speech.scriptNew'), enabled: false }])[0];
        if (!folder && current?.type === 'folder')
            update(current.id, tree => tree.type === 'folder' ? { ...tree, scripts: [...tree.scripts, next] } : tree);
        else
            setTrees(items => [...items, next]);
        setQuery('');
        setSection('code');
        setSelected(id);
    };
    const remove = () => {
        setTrees(items => items.filter(tree => tree.id !== selected).map(tree => tree.type === 'folder' ? { ...tree, scripts: tree.scripts.filter(script => script.id !== selected) } : tree));
        setDataTexts(values => Object.fromEntries(Object.entries(values).filter(([id]) => id !== selected && !(current?.type === 'folder' && current.scripts.some(script => script.id === id)))));
        setSelected(peers[position + 1]?.id ?? peers[position - 1]?.id ?? null);
        setRemoving(false);
    };
    const move = (direction) => {
        const reorder = (items) => { const at = items.findIndex(item => item.id === selected), to = at + direction; if (at < 0 || to < 0 || to >= items.length)
            return items; const copy = [...items]; copy.splice(to, 0, copy.splice(at, 1)[0]); return copy; };
        setTrees(items => reorder(items).map(tree => tree.type === 'folder' ? { ...tree, scripts: reorder(tree.scripts) } : tree));
    };
    const moveToFolder = (folderId) => {
        if (current?.type !== 'script')
            return;
        setTrees(items => {
            if (folderId && !items.some(tree => tree.type === 'folder' && tree.id === folderId))
                return items;
            const rest = items.filter(tree => tree.id !== current.id).map(tree => tree.type === 'folder' ? { ...tree, scripts: tree.scripts.filter(script => script.id !== current.id) } : tree);
            return folderId ? rest.map(tree => tree.type === 'folder' && tree.id === folderId ? { ...tree, scripts: [...tree.scripts, current] } : tree) : [...rest, current];
        });
    };
    const save = async () => {
        if (saving.current)
            return;
        saving.current = true;
        setBusy(true);
        setError(null);
        try {
            const trees = materialize();
            const result = target.type === 'character' ? await props.remote.saveCharacterHelperScripts({ cardId: target.cardId, revision, trees }) : await props.remote.saveHelperScriptLibrary({ target, revision, trees });
            if (!result.ok)
                throw new Error(result.error.message);
            setTrees(result.value.trees);
            setRevision(result.value.revision);
            setBaseline(JSON.stringify(result.value.trees));
            setDataTexts({});
            notifyHelperScriptAssets(target);
            guard.clearDraft();
            toast.show(t('speech.scriptSaved'));
            props.onSaved();
        }
        catch (error) {
            setError(error instanceof Error ? error.message : String(error));
        }
        finally {
            saving.current = false;
            setBusy(false);
        }
    };
    const reload = () => guard.request(() => {
        setBusy(true);
        setError(null);
        void (target.type === 'character' ? props.remote.getCharacterHelperScripts({ cardId: target.cardId }) : props.remote.getHelperScriptLibrary({ target })).then(result => {
            if (!result.ok)
                throw new Error(result.error.message);
            setTrees(result.value.trees);
            setRevision(result.value.revision);
            setBaseline(JSON.stringify(result.value.trees));
            setDataTexts({});
            setQuery('');
            setSelected(result.value.trees[0]?.id ?? null);
        }).catch(error => setError(String(error instanceof Error ? error.message : error))).finally(() => setBusy(false));
    });
    const importFile = async (file) => {
        setBusy(true);
        setError(null);
        try {
            if (file.size > 4 * 1024 * 1024)
                throw new Error(t('speech.scriptFileLarge'));
            const input = JSON.parse(await file.text());
            const parsed = importHelperScriptFile(input);
            guard.request(() => { setTrees(parsed); setDataTexts({}); setQuery(''); setSelected(parsed[0]?.id ?? null); });
        }
        catch (error) {
            setError(error instanceof Error ? error.message : String(error));
        }
        finally {
            setBusy(false);
        }
    };
    return _jsxs(_Fragment, { children: [guard.confirmation, toast.node, _jsxs(Dialog, { open: true, title: t(target.type === 'global' ? 'speech.scriptGlobalEditor' : target.type === 'preset' ? 'speech.scriptPresetEditor' : 'speech.scriptEditor'), description: props.label, width: "xl", onClose: () => guard.request(props.onClose), footer: _jsxs(SaveBar, { children: [_jsx("span", { className: "dsh-tavern-scriptSaveStatus", role: "status", children: t(busy ? 'speech.scriptSaving' : dirty ? 'speech.scriptUnsaved' : 'speech.scriptClean') }), _jsx(Btn, { size: "md", disabled: busy, onClick: () => guard.request(props.onClose), children: t('action.close') }), _jsx(Btn, { size: "md", primary: true, disabled: busy || !dirty, onClick: () => void save(), children: t('speech.scriptSaveReload') })] }), children: [_jsx(Muted, { children: t(target.type === 'character' ? 'speech.scriptAssetNote' : 'speech.scriptLibraryNote') }), _jsx(Err, { message: error }), _jsxs("div", { className: "dsh-tavern-scriptToolbar", children: [_jsxs("div", { className: "dsh-tavern-scriptTools", children: [_jsx(Btn, { size: "md", primary: true, disabled: busy, onClick: () => add(false), children: t('speech.scriptAdd') }), _jsx(Btn, { size: "md", disabled: busy, onClick: () => add(true), children: t('speech.scriptAddFolder') })] }), _jsxs("div", { className: "dsh-tavern-scriptTools", children: [_jsx(FileBtn, { accept: ".json,application/json", disabled: busy, onFile: file => void importFile(file), children: t('speech.scriptImport') }), _jsx(Btn, { size: "md", disabled: busy || !trees.length, onClick: () => { try {
                                            downloadJson('tavern-helper-scripts.json', exportHelperScriptTrees(materialize()));
                                        }
                                        catch (error) {
                                            setError(String(error));
                                        } }, children: t('speech.scriptExport') }), _jsx(Btn, { size: "md", disabled: busy, onClick: reload, children: t('speech.scriptReadSaved') })] })] }), _jsxs("div", { className: "dsh-tavern-scriptEditor", "data-empty": !trees.length, "aria-busy": busy, children: [_jsxs("aside", { className: "dsh-tavern-scriptSidebar", children: [_jsxs("div", { className: "dsh-tavern-scriptListHead", children: [_jsx("strong", { children: t('speech.scriptList') }), _jsx("span", { className: "dsh-tavern-badge", children: scriptCount })] }), _jsx(SearchInput, { label: t('speech.scriptSearch'), placeholder: t('speech.scriptSearch'), value: query, onChange: setQuery, width: "100%" }), _jsx("nav", { "aria-label": t('speech.scriptList'), className: "dsh-tavern-scriptTree dsh-tavern-scroll", children: visible.map(tree => _jsxs("div", { children: [_jsxs("div", { className: "dsh-tavern-scriptItem", "data-selected": current?.id === tree.id, "data-folder": tree.type === 'folder', children: [_jsx(Btn, { disabled: busy, title: tree.name || tree.id, pressed: current?.id === tree.id, onClick: () => setSelected(tree.id), children: tree.name || tree.id }), _jsx("span", { className: "dsh-tavern-scriptState", children: tree.type === 'folder' ? t('speech.scriptFolderKind') : t(tree.enabled ? 'speech.scriptOn' : 'speech.scriptOff') })] }), tree.type === 'folder' && tree.scripts.filter(script => matches(tree) || matches(script)).map(script => _jsxs("div", { className: "dsh-tavern-scriptItem dsh-tavern-scriptChild", "data-selected": current?.id === script.id, children: [_jsx(Btn, { disabled: busy, title: script.name || script.id, pressed: current?.id === script.id, onClick: () => setSelected(script.id), children: script.name || script.id }), _jsx("span", { className: "dsh-tavern-scriptState", children: t(script.enabled && tree.enabled ? 'speech.scriptOn' : 'speech.scriptOff') })] }, script.id))] }, tree.id)) }), !visible.length && _jsxs(_Fragment, { children: [_jsx(Muted, { children: t(query ? 'speech.scriptNoResults' : 'speech.scriptEmptyList') }), query && _jsx(Btn, { onClick: () => setQuery(''), children: t('action.clearSearch') })] })] }), _jsxs("div", { className: "dsh-tavern-scriptDetail", children: [!current && _jsxs("div", { className: "dsh-tavern-empty", children: [_jsx("div", { className: "dsh-tavern-emptyTitle", children: t('speech.scriptEmptyTitle') }), _jsx("div", { className: "dsh-tavern-emptyDesc", children: t('speech.scriptEmptyDesc') }), _jsx(Btn, { primary: true, disabled: busy, onClick: () => add(false), children: t('speech.scriptAdd') })] }), current && _jsxs(_Fragment, { children: [_jsx(SettingsRow, { title: t('speech.scriptName'), children: _jsx("input", { className: "dsh-tavern-input", "aria-label": t('speech.scriptName'), value: current.name, disabled: busy, onChange: event => update(current.id, item => ({ ...item, name: event.target.value })) }) }), _jsx(SettingsRow, { title: t('speech.scriptEnabled'), children: _jsx(Toggle, { title: t('speech.scriptEnabled'), checked: current.enabled, disabled: busy, onChange: enabled => update(current.id, item => ({ ...item, enabled })) }) }), _jsxs("div", { className: "dsh-tavern-scriptTools", children: [_jsx(Btn, { disabled: busy || position <= 0, onClick: () => move(-1), children: t('speech.scriptUp') }), _jsx(Btn, { disabled: busy || position < 0 || position >= peers.length - 1, onClick: () => move(1), children: t('speech.scriptDown') }), _jsx(Btn, { danger: true, disabled: busy, onClick: () => setRemoving(true), children: t('speech.scriptRemove') })] }), current.type === 'folder' && _jsxs("div", { className: "dsh-tavern-scriptFolderNote", children: [_jsx(Muted, { children: t('speech.scriptFolderDesc') }), _jsx(Btn, { disabled: busy, onClick: () => add(false), children: t('speech.scriptAdd') })] }), current.type === 'script' && _jsxs(_Fragment, { children: [siblings?.type === 'folder' && !siblings.enabled && _jsx(Muted, { children: t('speech.scriptParentDisabled') }), _jsx(SettingsRow, { title: t('speech.scriptFolder'), children: _jsx(Select, { title: t('speech.scriptFolder'), disabled: busy, value: trees.find(tree => tree.type === 'folder' && tree.scripts.some(script => script.id === current.id))?.id ?? '', options: [{ value: '', label: t('speech.scriptRoot') }, ...trees.filter(tree => tree.type === 'folder').map(tree => ({ value: tree.id, label: tree.name || tree.id }))], onChange: moveToFolder }) }), _jsx(Tabs, { id: tabsId, panelId: tabsId + '-panel', label: t('speech.scriptSections'), value: section, onChange: setSection, items: [{ id: 'code', label: t('speech.scriptTabCode') }, { id: 'data', label: t('speech.scriptTabData') }, { id: 'buttons', label: t('speech.scriptTabButtons') }] }), _jsxs("div", { id: tabsId + '-panel', role: "tabpanel", "aria-labelledby": tabsId + '-' + section, tabIndex: 0, children: [_jsxs("div", { hidden: section !== 'code', children: [_jsx(SettingsRow, { stacked: true, title: t('speech.scriptCode'), children: _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-scriptCode", "aria-label": t('speech.scriptCode'), value: current.content, disabled: busy, spellCheck: false, onChange: event => update(current.id, item => ({ ...item, content: event.target.value })) }) }), _jsxs("details", { children: [_jsx("summary", { children: t('speech.scriptInfo') }), _jsx(SettingsRow, { stacked: true, title: t('speech.scriptInfo'), children: _jsx("textarea", { className: "dsh-tavern-input", "aria-label": t('speech.scriptInfo'), value: current.info, disabled: busy, onChange: event => update(current.id, item => ({ ...item, info: event.target.value })) }) })] })] }), _jsxs("div", { hidden: section !== 'data', children: [_jsx(SettingsRow, { stacked: true, title: t('speech.scriptData'), children: _jsx("textarea", { className: "dsh-tavern-input", "aria-label": t('speech.scriptData'), value: dataTexts[current.id] ?? JSON.stringify(current.data, null, 2), disabled: busy, spellCheck: false, onChange: event => setDataTexts(values => ({ ...values, [current.id]: event.target.value })) }) }), _jsx(Btn, { disabled: busy, onClick: () => { try {
                                                                            const data = scriptData(current).data;
                                                                            setDataTexts(values => ({ ...values, [current.id]: JSON.stringify(data, null, 2) }));
                                                                            setError(null);
                                                                        }
                                                                        catch (error) {
                                                                            setError(error instanceof Error ? error.message : String(error));
                                                                        } }, children: t('speech.scriptFormatData') }), _jsx(SettingsRow, { title: t('speech.scriptExportData'), children: _jsx(Toggle, { title: t('speech.scriptExportData'), checked: current.export_with.data, disabled: busy, onChange: data => update(current.id, item => ({ ...item, export_with: { ...current.export_with, data } })) }) })] }), _jsxs("div", { hidden: section !== 'buttons', children: [_jsx(SettingsRow, { title: t('speech.scriptExportButtons'), children: _jsx(Toggle, { title: t('speech.scriptExportButtons'), checked: current.export_with.button, disabled: busy, onChange: button => update(current.id, item => ({ ...item, export_with: { ...current.export_with, button } })) }) }), _jsx(SettingsRow, { title: t('speech.scriptButtons'), children: _jsx(Toggle, { title: t('speech.scriptButtons'), checked: current.button.enabled, disabled: busy, onChange: enabled => update(current.id, item => ({ ...item, button: { ...current.button, enabled } })) }) }), current.button.buttons.map((button, index) => _jsxs("div", { className: "dsh-tavern-scriptTools", children: [_jsx("input", { className: "dsh-tavern-input", "aria-label": t('speech.scriptButtonName'), value: button.name, disabled: busy, onChange: event => update(current.id, item => ({ ...item, button: { ...current.button, buttons: current.button.buttons.map((old, i) => i === index ? { ...old, name: event.target.value } : old) } })) }), _jsx(Toggle, { title: `${t('speech.scriptButtonVisible')}: ${button.name}`, checked: button.visible, disabled: busy, onChange: visible => update(current.id, item => ({ ...item, button: { ...current.button, buttons: current.button.buttons.map((old, i) => i === index ? { ...old, visible } : old) } })) }), _jsx(Btn, { disabled: busy, onClick: () => update(current.id, item => ({ ...item, button: { ...current.button, buttons: current.button.buttons.filter((_, i) => i !== index) } })), children: t('speech.scriptRemove') })] }, index)), _jsx(Btn, { disabled: busy, onClick: () => update(current.id, item => ({ ...item, button: { ...current.button, buttons: [...current.button.buttons, { name: '', visible: true }] } })), children: t('speech.scriptAddButton') })] })] })] })] })] })] })] }), _jsx(ConfirmDialog, { open: removing, title: t('speech.scriptRemove'), description: t('speech.scriptRemoveNote'), danger: true, busy: busy, onCancel: () => setRemoving(false), onConfirm: remove })] });
}
