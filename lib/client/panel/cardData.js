import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/** 设置页的剧情变量管理：显式选择角色和剧情，备份已保存快照；恢复经原有楼层 WAL/CAS，草稿及失败留在设置。 */
import { describeError } from '../../core/guards.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseHelperVariableBackup, helperVariableRestoreChanges } from '../../core/helperVariableBackup.js';
import { cachedSessionBinding } from '../cache.js';
import { DraftScope, useDraftGuard } from '../drafts.js';
import { useDraftRestored, useDraftState } from '../draftPersistence.js';
import { HelperScriptEditor } from '../helperScriptEditor.js';
import { notifyHelperStory } from '../helperNotifications.js';
import { notifyHelperScripts } from '../helperScriptNotifications.js';
import { useT } from '../i18n.js';
import { currentTavernSession } from '../sessionViews.js';
import { openChildSession } from '../openChild.js';
import { Btn, ConfirmDialog, Err, FileBtn, Muted, SaveBar, Section, Select, SettingsRow, Skeleton, downloadJson, useLoader, useToast } from '../util.js';
export function CardDataSettings({ remote, sessions }) {
    const t = useT();
    const [cardId, setCardId] = useDraftState('card-data:card', '');
    const [storyId, setStoryId] = useDraftState('card-data:story', '');
    const [prefilledCardName, setPrefilledCardName] = useState('');
    const cardRestored = useDraftRestored('card-data:card');
    const storyRestored = useDraftRestored('card-data:story');
    const activeSessionId = currentTavernSession();
    const prefilled = useRef(false);
    useEffect(() => {
        if (cardRestored || storyRestored || prefilled.current || cardId || !activeSessionId || typeof remote.getSessionBinding !== 'function')
            return;
        let alive = true;
        void cachedSessionBinding(remote, activeSessionId).then(r => {
            if (!alive)
                return;
            prefilled.current = true;
            if (!r.ok || !r.value.binding?.cardId)
                return;
            if (r.value.binding.cardName)
                setPrefilledCardName(r.value.binding.cardName);
            setCardId(prev => prev || r.value.binding.cardId);
            if (r.value.binding.storyId)
                setStoryId(prev => prev || r.value.binding.storyId);
        }).catch(() => { });
        return () => { alive = false; };
    }, [remote, cardRestored, storyRestored, cardId, activeSessionId, setCardId, setStoryId]);
    // 同时加载活跃与已收纳角色，确保已收纳角色仍显示卡名并可检查/导出剧情数据。
    const chars = useLoader(async () => {
        const [active, archived] = await Promise.all([
            remote.listCharacters({}),
            typeof remote.listArchivedCharacters === 'function'
                ? remote.listArchivedCharacters({}).catch(() => null)
                : Promise.resolve(null),
        ]);
        if (!active.ok)
            return active;
        const activeIds = new Set(active.value.items.map(item => item.cardId));
        const archivedItems = archived && archived.ok ? archived.value.items.filter(item => !activeIds.has(item.cardId)) : [];
        return { ok: true, value: { active: active.value.items, archived: archivedItems } };
    }, [remote]);
    const stories = useLoader(() => remote.listStories({ cardId }), [remote, cardId], Boolean(cardId));
    const items = stories.state.status === 'ready' ? stories.state.value.items : [];
    const story = items.find(item => item.id === storyId);
    const characterOptions = [
        { value: '', label: t('settings.cards.variableChoose') },
        ...(chars.state.status === 'ready' ? [
            ...chars.state.value.active.map(item => ({ value: item.cardId, label: item.name })),
            ...chars.state.value.archived.map(item => ({ value: item.cardId, label: t('characters.archivedName', { name: item.name }) })),
        ] : []),
    ];
    if (cardId && !characterOptions.some(option => option.value === cardId)) {
        characterOptions.push({ value: cardId, label: prefilledCardName || t('chip.characterFallback') });
    }
    return _jsx(Section, { title: t('speech.cardDataTitle'), description: t('settings.cards.variablesDesc'), children: _jsx(DraftScope, { children: request => _jsxs(_Fragment, { children: [_jsx(SettingsRow, { title: t('settings.cards.variableCharacter'), children: _jsx(Select, { value: cardId, title: t('settings.cards.variableCharacter'), disabled: chars.state.status !== 'ready', options: characterOptions, onChange: value => request(() => { setPrefilledCardName(''); setCardId(value); setStoryId(''); }) }) }), _jsx(SettingsRow, { title: t('memory.story'), children: _jsx(Select, { value: storyId, title: t('memory.story'), disabled: !cardId || stories.state.status !== 'ready', options: [{ value: '', label: t('settings.cards.variableChoose') }, ...items.map((item, index) => ({ value: item.id, label: t(activeSessionId && item.sessionId === activeSessionId ? 'memory.storyLabelCurrent' : 'memory.storyLabel', { index: index + 1, date: new Date(item.createdAt).toLocaleString() }) }))], onChange: value => request(() => setStoryId(value)) }) }), (chars.state.status === 'loading' || stories.state.status === 'loading') && _jsx(Skeleton, { height: 40 }), _jsx(Err, { message: chars.state.status === 'error' ? chars.state.message : stories.state.status === 'error' ? stories.state.message : null }), (chars.state.status === 'error' || stories.state.status === 'error') && _jsx(Btn, { onClick: () => { chars.reload(); stories.reload(); }, children: t('action.retry') }), story ? _jsx(StoryVariableSettings, { remote: remote, cardId: cardId, storyId: storyId, sessionId: story.sessionId }, JSON.stringify([cardId, storyId, story.sessionId])) : _jsx(Muted, { children: t('settings.cards.variableChooseStory') }), _jsx(SessionTransfer, { remote: remote, sessions: sessions, sessionId: story?.sessionId })] }) }) });
}
/** 导出当前选中剧情；导入必须选择现有工作区并先确认，失败保留文件以便重试。 */
export function SessionTransfer({ remote, sessions, sessionId }) {
    const t = useT(), toast = useToast(), workspaces = useLoader(() => remote.listSessionImportWorkspaces({}), [remote]);
    const active = useRef(true), pending = useRef(false);
    useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    const [workspaceId, setWorkspaceId] = useState(''), [archive, setArchive] = useState(null);
    const [phase, setPhase] = useState(null);
    const [error, setError] = useState(null), [confirm, setConfirm] = useState(false), [restoredSessionId, setRestoredSessionId] = useState(null);
    const busy = phase !== null;
    // 迁移文件可达 192 MiB，只在当前页面内持有；离开前保护输入，明确放弃后立即释放。
    const clearArchive = useCallback(() => { setArchive(null); setConfirm(false); }, []);
    const guard = useDraftGuard(archive !== null, busy, clearArchive);
    const exportSession = async () => {
        if (!sessionId || pending.current)
            return;
        pending.current = true;
        setPhase('exporting');
        setError(null);
        try {
            const result = await remote.exportSessionArchive({ sessionId });
            if (!result.ok)
                throw new Error(result.error.message);
            if (active.current)
                downloadJson('tavern-session.json', result.value.archive, 0);
        }
        catch (e) {
            if (active.current)
                setError(describeError(e));
        }
        finally {
            pending.current = false;
            if (active.current)
                setPhase(null);
        }
    };
    const choose = async (file) => {
        if (pending.current)
            return;
        setError(null);
        if (file.size > 192 * 1024 * 1024) {
            setError(t('sessionArchive.tooLarge'));
            return;
        }
        pending.current = true;
        setPhase('reading');
        // 新文件完整读入后才替换原输入，读取失败仍可用原文件恢复中断的导入。
        try {
            const text = await file.text();
            if (active.current) {
                setArchive({ name: file.name, text });
                setConfirm(false);
                setRestoredSessionId(null);
            }
        }
        catch (e) {
            if (active.current)
                setError(describeError(e));
        }
        finally {
            pending.current = false;
            if (active.current)
                setPhase(null);
        }
    };
    const openRestored = async (id) => {
        if (!sessions)
            return;
        try {
            await openChildSession({ ...sessions, open: target => { if (active.current)
                    sessions.open(target); } }, id);
        }
        catch {
            if (active.current)
                setError(t('sessionArchive.navigationFailed'));
        }
    };
    const reopen = async () => {
        if (!restoredSessionId || !sessions || pending.current)
            return;
        pending.current = true;
        setPhase('opening');
        setError(null);
        try {
            await openRestored(restoredSessionId);
        }
        finally {
            pending.current = false;
            if (active.current)
                setPhase(null);
        }
    };
    const restore = async () => {
        if (!archive || !workspaceId || pending.current)
            return;
        pending.current = true;
        setConfirm(false);
        setPhase('importing');
        setError(null);
        try {
            const result = await remote.importSessionArchive({ workspaceId, archiveJson: archive.text });
            if (!result.ok)
                throw new Error(result.error.message);
            if (active.current) {
                guard.clearDraft();
                setRestoredSessionId(result.value.sessionId);
                toast.show(t('sessionArchive.imported'));
            }
            if (sessions && active.current) {
                setPhase('opening');
                await openRestored(result.value.sessionId);
            }
        }
        catch (e) {
            if (active.current)
                setError(describeError(e));
        }
        finally {
            pending.current = false;
            if (active.current)
                setPhase(null);
        }
    };
    const items = workspaces.state.status === 'ready' ? workspaces.state.value.items : [];
    return _jsxs(Section, { title: t('sessionArchive.title'), description: t('sessionArchive.desc'), children: [toast.node, _jsx(SettingsRow, { title: t('sessionArchive.export'), description: !sessionId ? t('sessionArchive.chooseStory') : undefined, children: _jsx(Btn, { disabled: !sessionId || busy, onClick: () => void exportSession(), children: t('sessionArchive.export') }) }), _jsx(SettingsRow, { title: t('sessionArchive.workspace'), children: _jsx(Select, { value: workspaceId, title: t('sessionArchive.workspace'), disabled: busy || workspaces.state.status !== 'ready', options: [{ value: '', label: t('sessionArchive.chooseWorkspace') }, ...items.map(item => ({ value: item.id, label: item.title }))], onChange: setWorkspaceId }) }), _jsxs(SettingsRow, { title: t('sessionArchive.chooseFile'), description: archive?.name, children: [_jsx(FileBtn, { size: "sm", accept: "application/json,.json", disabled: busy || confirm, onFile: file => void choose(file), children: t('sessionArchive.chooseFile') }), archive && _jsx(Btn, { disabled: busy || confirm, onClick: () => { if (!pending.current) {
                            clearArchive();
                            setError(null);
                        } }, children: t('sessionArchive.clearFile') }), _jsx(Btn, { primary: true, disabled: busy || !archive || !workspaceId, onClick: () => setConfirm(true), children: t('sessionArchive.import') })] }), phase && _jsx("div", { role: "status", children: _jsx(Muted, { children: t(`sessionArchive.${phase}`) }) }), restoredSessionId && _jsx(SettingsRow, { title: t('sessionArchive.imported'), children: sessions && _jsx(Btn, { disabled: busy, onClick: () => void reopen(), children: t('sessionArchive.openImported') }) }), _jsx(Err, { message: error ?? (workspaces.state.status === 'error' ? workspaces.state.message : null) }), workspaces.state.status === 'error' && _jsx(Btn, { onClick: workspaces.reload, children: t('action.retry') }), _jsx(ConfirmDialog, { open: confirm, title: t('sessionArchive.import'), description: t('sessionArchive.confirm'), busy: busy, onCancel: () => setConfirm(false), onConfirm: () => void restore() })] });
}
export function StoryVariableSettings(props) {
    const { remote, sessionId, storyId } = props, t = useT();
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const loaded = useLoader(async () => {
        const events = await remote.getHelperEventState({ sessionId, storyId });
        if (!events.ok)
            return events;
        const message = [...events.value.messages].reverse().find(item => item.role === 'assistant');
        if (!message)
            throw new Error(t('settings.cards.variableNoMessage'));
        const result = await remote.getHelperSnapshot({ sessionId, messageId: message.seq });
        if (!result.ok)
            return result;
        if (result.value.storyId !== storyId)
            throw new Error(t('speech.helperStoryChanged'));
        return { ok: true, value: { snapshot: result.value, messageId: message.seq } };
    }, [remote, sessionId, storyId]);
    const [library, setLibrary] = useState(null);
    const [scriptError, setScriptError] = useState(null), [scriptBusy, setScriptBusy] = useState(false);
    const scriptOpening = useRef(false);
    const scriptGuard = useDraftGuard(false, scriptBusy);
    const editScripts = async () => {
        if (scriptOpening.current)
            return;
        scriptOpening.current = true;
        setScriptBusy(true);
        setScriptError(null);
        try {
            const result = await remote.getHelperScriptLibrary({ target: { type: 'character', cardId: props.cardId } });
            if (!alive.current)
                return;
            if (!result.ok)
                throw new Error(result.error.message);
            setLibrary(result.value);
        }
        catch (error) {
            if (alive.current)
                setScriptError(describeError(error));
        }
        finally {
            scriptOpening.current = false;
            if (alive.current)
                setScriptBusy(false);
        }
    };
    return _jsxs(_Fragment, { children: [scriptGuard.confirmation, _jsx(SettingsRow, { title: t('speech.scriptEditor'), children: _jsx(Btn, { disabled: scriptBusy, onClick: () => void editScripts(), children: t('speech.scriptEditor') }) }), _jsx(Err, { message: scriptError }), library && _jsx(HelperScriptEditor, { remote: remote, library: library, onClose: () => setLibrary(null), onSaved: () => notifyHelperScripts(sessionId, storyId) }), loaded.state.status === 'loading' && _jsx(Skeleton, { height: 100 }), loaded.state.status === 'error' && _jsxs(_Fragment, { children: [_jsx(Err, { message: loaded.state.message }), _jsx(Btn, { onClick: loaded.reload, children: t('action.retry') })] }), loaded.state.status === 'ready' && _jsx(VariableBackupEditor, { remote: remote, sessionId: sessionId, snapshot: loaded.state.value.snapshot, messageId: loaded.state.value.messageId, onRefresh: loaded.reload }, loaded.state.value.snapshot.historyRevision)] });
}
export function VariableBackupEditor(props) {
    const t = useT(), toast = useToast();
    const alive = useRef(true);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const [snapshot, setSnapshot] = useState(props.snapshot);
    useEffect(() => { setSnapshot(props.snapshot); }, [props.snapshot]);
    const [text, setText] = useDraftState(`card-data:backup:${JSON.stringify([props.sessionId, snapshot.storyId])}`, '');
    const [error, setError] = useState(null), [busy, setBusy] = useState(false), [confirm, setConfirm] = useState(false);
    const restoring = useRef(false);
    const guard = useDraftGuard(Boolean(text.trim()), busy);
    const restore = async () => {
        if (restoring.current)
            return;
        restoring.current = true;
        setConfirm(false);
        setBusy(true);
        setError(null);
        try {
            const target = parseHelperVariableBackup(text, snapshot.currentMessageId);
            const changes = helperVariableRestoreChanges(snapshot.scopes, target);
            if (!snapshot.writable)
                throw new Error(t('settings.cards.variableReadOnly'));
            if (changes.length) {
                const result = await props.remote.commitHelperVariables({ sessionId: props.sessionId, messageId: props.messageId, storyId: snapshot.storyId, historyRevision: snapshot.historyRevision, changes });
                if (!result.ok)
                    throw new Error(result.error.message);
                if (result.value.storyId !== snapshot.storyId)
                    throw new Error(t('speech.helperStoryChanged'));
                notifyHelperStory(props.sessionId, snapshot.storyId);
                if (!alive.current)
                    return;
                setSnapshot(result.value);
            }
            else {
                // 旧快照相等不能证明服务器仍相等；只读复核后才提示无需恢复，不清掉冲突草稿。
                const fresh = await props.remote.getHelperSnapshot({ sessionId: props.sessionId, messageId: props.messageId });
                if (!fresh.ok)
                    throw new Error(fresh.error.message);
                if (fresh.value.storyId !== snapshot.storyId || fresh.value.historyRevision !== snapshot.historyRevision)
                    throw new Error(t('speech.helperStoryChanged'));
                if (!fresh.value.writable)
                    throw new Error(t('settings.cards.variableReadOnly'));
                if (helperVariableRestoreChanges(fresh.value.scopes, target).length)
                    throw new Error(t('settings.cards.variableConflict'));
                if (!alive.current)
                    return;
                setSnapshot(fresh.value);
            }
            setText('');
            guard.clearDraft();
            toast.show(t(changes.length ? 'speech.variableSaved' : 'settings.cards.variableUnchanged'));
        }
        catch (error) {
            if (alive.current)
                setError(describeError(error));
        }
        finally {
            restoring.current = false;
            if (alive.current)
                setBusy(false);
        }
    };
    return _jsxs(_Fragment, { children: [toast.node, guard.confirmation, _jsx(Muted, { children: t(snapshot.writable ? 'settings.cards.variableLoaded' : 'settings.cards.variableReadOnly') }), _jsx(SettingsRow, { title: t('speech.helperRefresh'), description: t('settings.cards.variableRefreshDesc'), children: _jsx(Btn, { disabled: busy, onClick: () => guard.request(() => { setText(''); setError(null); props.onRefresh(); }), children: t('speech.helperRefresh') }) }), _jsx(SettingsRow, { title: t('settings.cards.variableExport'), children: _jsx(Btn, { disabled: busy, onClick: () => downloadJson('tavern-variables.json', { version: 1, scopes: snapshot.scopes }, 0), children: t('settings.cards.variableExport') }) }), _jsx(SettingsRow, { stacked: true, title: t('speech.cardDataRestore'), description: t('settings.cards.variableRestoreDesc'), children: _jsx("textarea", { className: "dsh-tavern-input dsh-tavern-textarea dsh-tavern-codeFont", "aria-label": t('speech.cardDataText'), value: text, disabled: busy, onChange: event => setText(event.target.value) }) }), _jsx(Err, { message: error }), _jsxs(SaveBar, { children: [text.trim() ? _jsx(Btn, { disabled: busy, onClick: () => guard.request(() => { setText(''); setError(null); }), children: t('action.cancel') }) : null, _jsx(Btn, { primary: true, disabled: busy || !snapshot.writable || !text.trim(), onClick: () => { try {
                            helperVariableRestoreChanges(snapshot.scopes, parseHelperVariableBackup(text, snapshot.currentMessageId));
                            setError(null);
                            setConfirm(true);
                        }
                        catch (error) {
                            setError(describeError(error));
                        } }, children: t('speech.cardDataRestore') })] }), _jsx(ConfirmDialog, { open: confirm, title: t('speech.cardDataRestore'), description: t('settings.cards.variableRestoreConfirm'), busy: busy, onCancel: () => setConfirm(false), onConfirm: () => void restore() })] });
}
