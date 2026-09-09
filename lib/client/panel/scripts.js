import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/** 设置中的脚本资产管理：无需绑定会话，按全局、角色与预设选择独立脚本库，复用带草稿保护的编辑器。 */
import { useRef, useState, useSyncExternalStore } from 'react';
import { scriptStatusStore, retryScriptMvu } from '../helperScriptStatus.js';
import { HelperScriptEditor } from '../helperScriptEditor.js';
import { useT } from '../i18n.js';
import { Btn, Err, Muted, Section, Select, Skeleton, useLoader } from '../util.js';
export function ScriptSettings({ remote }) {
    const t = useT();
    const runtimes = useSyncExternalStore(scriptStatusStore.subscribe, scriptStatusStore.getSnapshot, scriptStatusStore.getSnapshot);
    const characters = useLoader(() => remote.listCharacters({}), []);
    const presets = useLoader(() => remote.listPresets({}), []);
    const [cardId, setCardId] = useState(''), [presetId, setPresetId] = useState('');
    const [editing, setEditing] = useState(null);
    const [busy, setBusy] = useState(false), [error, setError] = useState(null);
    const opening = useRef(false);
    const [openingType, setOpeningType] = useState(null);
    const open = async (target) => {
        if (opening.current)
            return;
        opening.current = true;
        setOpeningType(target.type);
        setBusy(true);
        setError(null);
        try {
            const result = await remote.getHelperScriptLibrary({ target });
            if (!result.ok)
                throw new Error(result.error.message);
            setEditing(result.value);
        }
        catch (error) {
            setError(error instanceof Error ? error.message : String(error));
        }
        finally {
            opening.current = false;
            setOpeningType(null);
            setBusy(false);
        }
    };
    const target = editing?.target;
    const editorLabel = target?.type === 'character' && characters.state.status === 'ready' ? characters.state.value.items.find(card => card.cardId === target.cardId)?.name : target?.type === 'preset' && presets.state.status === 'ready' ? presets.state.value.items.find(preset => preset.id === target.presetId)?.name : undefined;
    const action = (type) => t(openingType === type ? 'settings.scripts.loading' : 'settings.scripts.open');
    return _jsxs(Section, { title: t('settings.sub.scripts'), description: t('settings.scripts.desc'), children: [_jsxs("section", { className: "dsh-tavern-scriptRuntime", "aria-label": t('settings.scripts.runtime'), children: [_jsx("h4", { children: t('settings.scripts.runtime') }), !runtimes.length && _jsx(Muted, { children: t('settings.scripts.noRuntime') }), runtimes.map(runtime => _jsxs("div", { children: [_jsx("strong", { children: characters.state.status === 'ready' ? characters.state.value.items.find(card => card.cardId === runtime.cardId)?.name ?? t('settings.scripts.current') : t('settings.scripts.current') }), _jsx(Muted, { children: t(`settings.scripts.runtime.${runtime.state}`) }), _jsx(Err, { message: runtime.error ?? null }), runtime.scripts.some(script => script.native) && _jsx(Muted, { children: t(runtime.nativeMvu ? 'settings.scripts.nativeOn' : 'settings.scripts.nativeOff') }), runtime.nativeMvu && _jsx(Muted, { children: t(runtime.mvuError ? 'speech.mvuRetry' : runtime.mvuBusy ? 'speech.mvuRunning' : runtime.scripts.every(script => script.state === 'ready') ? 'speech.mvuReady' : 'speech.mvuWaiting') }), _jsx(Err, { message: runtime.mvuError ?? null }), runtime.mvuError && _jsx(Btn, { onClick: () => retryScriptMvu(runtime.sessionId), children: t('speech.mvuRetry') }), _jsx("ul", { children: runtime.scripts.map(script => _jsxs("li", { children: [_jsx("span", { children: script.name }), _jsx("span", { className: "dsh-tavern-scriptRuntimeStatus", children: t(`settings.scripts.runtime.${script.state}`) }), script.error && _jsx(Err, { message: script.error })] }, script.id)) })] }, runtime.sessionId))] }), _jsxs("div", { className: "dsh-tavern-scriptLibraries", "aria-busy": busy, children: [_jsxs("section", { className: "dsh-tavern-scriptLibrary", children: [_jsxs("div", { className: "dsh-tavern-scriptLibraryIntro", children: [_jsx("h4", { children: t('settings.scripts.global') }), _jsx(Muted, { children: t('settings.scripts.globalDesc') })] }), _jsx("div", { className: "dsh-tavern-scriptLibraryActions", children: _jsx(Btn, { size: "md", disabled: busy, onClick: () => void open({ type: 'global' }), children: action('global') }) })] }), _jsxs("section", { className: "dsh-tavern-scriptLibrary", children: [_jsxs("div", { className: "dsh-tavern-scriptLibraryIntro", children: [_jsx("h4", { children: t('settings.scripts.character') }), _jsx(Muted, { children: t('settings.scripts.characterDesc') })] }), _jsxs("div", { className: "dsh-tavern-scriptLibraryActions", children: [characters.state.status === 'loading' && _jsx(Skeleton, {}), characters.state.status === 'error' && _jsxs(_Fragment, { children: [_jsx(Err, { message: characters.state.message }), _jsx(Btn, { onClick: characters.reload, children: t('action.retry') })] }), characters.state.status === 'ready' && (characters.state.value.items.length ? _jsx(Select, { size: "md", disabled: busy, title: t('speech.scriptEditor'), value: cardId, onChange: value => { setCardId(value); setError(null); }, options: [{ value: '', label: t('settings.scripts.chooseCharacter') }, ...characters.state.value.items.map(card => ({ value: card.cardId, label: card.name }))] }) : _jsx(Muted, { children: t('settings.scripts.noCharacters') })), _jsx(Btn, { size: "md", disabled: busy || !cardId, onClick: () => void open({ type: 'character', cardId }), children: action('character') })] })] }), _jsxs("section", { className: "dsh-tavern-scriptLibrary", children: [_jsxs("div", { className: "dsh-tavern-scriptLibraryIntro", children: [_jsx("h4", { children: t('settings.scripts.preset') }), _jsx(Muted, { children: t('settings.scripts.presetDesc') })] }), _jsxs("div", { className: "dsh-tavern-scriptLibraryActions", children: [presets.state.status === 'loading' && _jsx(Skeleton, {}), presets.state.status === 'error' && _jsxs(_Fragment, { children: [_jsx(Err, { message: presets.state.message }), _jsx(Btn, { onClick: presets.reload, children: t('action.retry') })] }), presets.state.status === 'ready' && (presets.state.value.items.length ? _jsx(Select, { size: "md", disabled: busy, title: t('settings.scripts.preset'), value: presetId, onChange: value => { setPresetId(value); setError(null); }, options: [{ value: '', label: t('settings.scripts.choosePreset') }, ...presets.state.value.items.map(preset => ({ value: preset.id, label: preset.name }))] }) : _jsx(Muted, { children: t('settings.scripts.noPresets') })), _jsx(Btn, { size: "md", disabled: busy || !presetId, onClick: () => void open({ type: 'preset', presetId }), children: action('preset') })] })] })] }), _jsx(Err, { message: error }), editing && _jsx(HelperScriptEditor, { remote: remote, library: editing, label: editorLabel, onClose: () => setEditing(null), onSaved: () => { } })] });
}
